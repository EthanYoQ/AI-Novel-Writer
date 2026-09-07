import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import {
  composePromptSystemRole,
  renderPromptTaskGuidance,
  resolvePromptTemplate,
} from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { characterArchitecturePrompts, promptLanguageText } from '../../prompt-language'
import { stripThinkingTags } from '../workflow-utils'
import type { WorkflowContext } from '../../../stores/workflow-store'
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { WritingLanguage } from '../../../shared/writing-language'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_ROSTER_ROLES,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
  GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
  isGeneratedGlobalGuidanceValid,
  mergeExpandedNovelConfig,
} from '../novel-config-expansion'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
  /** 情节大纲在上一次生成中被输出长度中断；synopsis_result 为已完成部分。 */
  synopsis_incomplete?: boolean
}

/**
 * 情节大纲生成被输出长度中断、且已完成部分已自动保存时抛出的错误。
 * errorCode 供前端识别并展示「继续生成情节大纲」断点续写按钮。
 */
export const PLOT_OUTLINE_RESUME_ERROR_CODE = 'architecture-synopsis-resume-available'

export class PlotOutlineResumeAvailableError extends Error {
  readonly code = PLOT_OUTLINE_RESUME_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'PlotOutlineResumeAvailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 少于该字符数视为无保存价值的零碎输出，不落盘、不提供续写。 */
const MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS = 120

/** 落库时追加在未完成大纲末尾的可见标记（帮助用户识别与编辑器提示）。 */
const SYNOPSIS_INCOMPLETE_MARKER_ZH = [
  '',
  '> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。',
  '> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐剩余章节。',
  '',
].join('\n')

const SYNOPSIS_INCOMPLETE_MARKER_EN = [
  '',
  '> ⚠ **This outline is incomplete**: generation stopped at the output length limit; the completed part above was saved automatically.',
  '> Click “Continue plot outline” in the AI output notice to resume from this break point.',
  '',
].join('\n')

/**
 * 「本次只详写前 N 章」的分块指令：结构节点仍标全书区间，但具体展开
 * 只到第 N 章；第 N+1 章起以一行占位句概览，避免单次输出超长。
 */
function synopsisScopeInstruction(
  writingLanguage: WritingLanguage,
  totalChapters: number,
  scope: number,
): string {
  const next = scope + 1
  return promptLanguageText(
    writingLanguage,
    `【本次生成范围（重要）】
全书规划 ${totalChapters} 章。本次只对第 1–${scope} 章输出完整详细的情节大纲：
1. 结构节点仍需标注全书章节区间，但“具体发生什么”只写到第 ${scope} 章为止。
2. 第 ${next} 章及以后不展开细写：仅以一行占位句概览整段走向（不超过 300 字）。
3. 大纲末尾单独一行注明：本批大纲仅细化至第 ${scope} 章，后续章节可继续分块生成。`,
    `[Generation scope for this batch (important)]
The book spans ${totalChapters} chapters, but this batch must detail only chapters 1–${scope}:
1. Structure nodes may still cite full-book chapter ranges, but concrete "what happens" detail stops at chapter ${scope}.
2. Chapters ${next}–${totalChapters} must not be expanded: collapse them into one short placeholder line (300 characters or fewer).
3. End with a line noting that this batch details only up to chapter ${scope} and later chapters can be generated in further batches.`,
  )
}

const PLOT_STRUCTURES = new Set<NovelConfig['plotStructure']>([
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
])
const NARRATIVE_POVS = new Set<NovelConfig['narrativePOV']>([
  'third_limited',
  'first_person',
  'third_omniscient',
  'multi_pov',
])
const REQUIRED_CONFIG_TEXT_FIELDS = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const

type UiText = (zhCNText: string, enUSText: string) => string

function buildNovelConfigJSONContract(
  totalChapters: number,
  wordsPerChapter: number,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(writingLanguage, `【不可变小说配置 JSON 合同】
- 必填且必须为非空字符串的 9 个字段：genre、targetAudience、subGenre、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance、writingStyle。
- plotStructure 必填，且值必须严格为以下英文枚举之一：three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform。
- narrativePOV 必填，且值必须严格为以下英文枚举之一：third_limited | first_person | third_omniscient | multi_pov。
- totalChapters 与 wordsPerChapter 是作者权威设置，可以省略；totalChapters 若输出必须严格等于 ${totalChapters}；wordsPerChapter 若输出必须严格等于 ${wordsPerChapter}。
- globalGuidance 必须是 4–8 条跨章节长期有效的简短规则，总计不得超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符；禁止逐章列大纲或分配章节区间。
- referenceWorks 可省略；若输出必须是字符串。
- 只输出一个完整 JSON 对象。枚举只允许上述英文值，不得输出中文枚举、近义词、说明文字、Markdown、代码围栏或思考过程。`, `[Immutable novel-configuration JSON contract]
- The following nine fields are required non-empty strings: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure is required and must be exactly one of: three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform.
- narrativePOV is required and must be exactly one of: third_limited | first_person | third_omniscient | multi_pov.
- totalChapters and wordsPerChapter are authoritative author settings and may be omitted. If present, they must equal ${totalChapters} and ${wordsPerChapter} respectively.
- globalGuidance must contain 4–8 short, stable cross-chapter rules within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters. Do not enumerate chapters or allocate chapter ranges.
- referenceWorks may be omitted; if present, it must be a string.
- Output one complete JSON object only. Do not emit aliases, explanatory prose, Markdown, code fences, or reasoning.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeCompleteNovelConfig(
  content: string,
  expectedTotalChapters: number,
  expectedWordsPerChapter: number,
): NovelConfig {
  let value: unknown
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    value = JSON.parse(fenced?.[1].trim() ?? trimmed)
  } catch {
    throw new Error('AI 返回的小说配置不是完整 JSON 对象')
  }
  if (!isRecord(value)) throw new Error('AI 返回的小说配置必须是 JSON 对象')

  const textFields: Record<(typeof REQUIRED_CONFIG_TEXT_FIELDS)[number], string> = {} as never
  for (const field of REQUIRED_CONFIG_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`AI 返回的小说配置缺少非空字段：${field}`)
    }
    textFields[field] = value[field].trim()
  }
  if (typeof value.plotStructure !== 'string' || !PLOT_STRUCTURES.has(value.plotStructure as NovelConfig['plotStructure'])) {
    throw new Error('AI 返回的小说配置包含非法 plotStructure')
  }
  if (typeof value.narrativePOV !== 'string' || !NARRATIVE_POVS.has(value.narrativePOV as NovelConfig['narrativePOV'])) {
    throw new Error('AI 返回的小说配置包含非法 narrativePOV')
  }
  for (const [field, expected] of [
    ['totalChapters', expectedTotalChapters],
    ['wordsPerChapter', expectedWordsPerChapter],
  ] as const) {
    const candidate = value[field]
    if (candidate !== undefined && (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
      || candidate !== expected
    )) {
      throw new Error(`AI 返回的小说配置包含无效 ${field}，不得回退或覆盖作者设置`)
    }
  }
  if (value.referenceWorks !== undefined && typeof value.referenceWorks !== 'string') {
    throw new Error('AI 返回的小说配置包含无效 referenceWorks')
  }

  return {
    genre: textFields.genre,
    targetAudience: textFields.targetAudience,
    subGenre: textFields.subGenre,
    totalChapters: expectedTotalChapters,
    wordsPerChapter: expectedWordsPerChapter,
    plotStructure: value.plotStructure as NovelConfig['plotStructure'],
    narrativePOV: value.narrativePOV as NovelConfig['narrativePOV'],
    coreOutline: textFields.coreOutline,
    worldSetting: textFields.worldSetting,
    goldenFinger: textFields.goldenFinger,
    protagonistProfile: textFields.protagonistProfile,
    globalGuidance: textFields.globalGuidance,
    writingStyle: textFields.writingStyle,
    ...(typeof value.referenceWorks === 'string' ? { referenceWorks: value.referenceWorks.trim() } : {}),
  }
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
interface CharacterIdentitySlot {
  slotId: string
  name: string
  role: CharacterRosterEntry['role']
  narrativeDuty: string
  relations: Array<{ targetSlotId: string; relation: string }>
}

interface CharacterDetailOutput extends Omit<CharacterRosterEntry, 'relationships'> {
  slotId: string
  relationships?: unknown
}

const MIN_CHARACTER_SLOTS = 3
const MAX_CHARACTER_SLOTS = 8
const CHARACTER_DETAIL_BATCH_SIZE = 3
const CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS = 120
const CHARACTER_STATE_TEXT_MAX_CHARS = 80
const CHARACTER_DETAIL_DESCRIPTION_FIELDS = [
  'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const
const CHARACTER_STATE_TEXT_FIELDS = [
  'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents',
] as const
const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 32_768

function promptUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function findCompleteJsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return undefined
    }
  }
  return undefined
}

function extractSingleCompleteJsonObject(content: string): string {
  const source = stripThinkingTags(content).trim()
  const candidates: string[] = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const start = source.indexOf('{', searchFrom)
    if (start === -1) break
    const end = findCompleteJsonObjectEnd(source, start)
    if (end === undefined) throw new Error('AI 返回包含截断 JSON 对象片段')

    const candidate = source.slice(start, end + 1)
    try {
      if (isRecord(JSON.parse(candidate))) candidates.push(candidate)
    } catch {
      // Keep scanning for the one complete JSON object; malformed candidates
      // are not repaired or accepted.
    }
    searchFrom = end + 1
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) throw new Error('AI 返回包含多个完整 JSON 对象，无法确定唯一结构化结果')
  throw new Error('AI 返回未包含一个完整 JSON 对象')
}

function decodeCharacterIdentityManifest(content: string): CharacterIdentitySlot[] {
  const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { slots?: unknown }
  if (!Array.isArray(parsed.slots)) throw new Error('角色身份清单缺少 slots')
  if (parsed.slots.length < MIN_CHARACTER_SLOTS || parsed.slots.length > MAX_CHARACTER_SLOTS) {
    throw new Error(`角色身份清单必须包含 ${MIN_CHARACTER_SLOTS}–${MAX_CHARACTER_SLOTS} 个角色`)
  }
  const slots = parsed.slots.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`角色身份清单第 ${index + 1} 项无效`)
    const relations = candidate.relations
    if (!Array.isArray(relations)) throw new Error(`角色身份清单第 ${index + 1} 项缺少关系列表`)
    const slotId = normalizeCharacterSlotId(candidate.slotId)
    if (
      slotId === undefined
      || typeof candidate.name !== 'string' || !candidate.name.trim()
      || typeof candidate.role !== 'string' || !CHARACTER_ROSTER_ROLES.includes(candidate.role as CharacterRosterEntry['role'])
      || typeof candidate.narrativeDuty !== 'string' || !candidate.narrativeDuty.trim()
    ) throw new Error(`角色身份清单第 ${index + 1} 项字段不完整`)
    return {
      slotId,
      name: candidate.name.trim(),
      role: candidate.role as CharacterRosterEntry['role'],
      narrativeDuty: candidate.narrativeDuty.trim(),
      relations: relations.map((relation, relationIndex) => {
        const targetSlotId = isRecord(relation)
          ? normalizeCharacterSlotId(relation.targetSlotId)
          : undefined
        if (!isRecord(relation)
          || targetSlotId === undefined
          || typeof relation.relation !== 'string' || !relation.relation.trim()) {
          throw new Error(`角色身份清单第 ${index + 1} 项关系 ${relationIndex + 1} 无效`)
        }
        return { targetSlotId, relation: relation.relation.trim() }
      }),
    }
  })
  const slotIds = new Set(slots.map(slot => slot.slotId))
  const names = new Set(slots.map(slot => slot.name))
  if (slotIds.size !== slots.length || names.size !== slots.length) throw new Error('角色身份清单包含重复 slotId 或姓名')
  if (!slots.some(slot => slot.role === 'protagonist')) throw new Error('角色身份清单必须至少包含一个主角')
  for (const slot of slots) {
    for (const relation of slot.relations) {
      if (!slotIds.has(relation.targetSlotId) || relation.targetSlotId === slot.slotId) {
        throw new Error('角色身份清单关系端点不闭合或存在自指')
      }
    }
  }
  return slots
}

function normalizeCharacterSlotId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined
}

function validateCharacterDetail(output: CharacterDetailOutput): string | undefined {
  const slotId = typeof output.slotId === 'string' && output.slotId.trim() ? output.slotId.trim() : 'unknown'
  const invalid = (field: string, reason: string) => `角色详情 slotId=${slotId} 字段 ${field} ${reason}`
  for (const field of [
    'slotId', 'name', 'gender', 'age', 'appearance', 'personality', 'background',
    'abilities', 'motivation', 'arc', 'notes',
  ] as const) {
    const value = output[field]
    if (typeof value !== 'string' || !value.trim()) return invalid(field, '必须是非空文本')
  }
  for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
    if (Array.from(output[field].trim()).length > CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS) {
      return invalid(field, `不得超过 ${CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS} 字符`)
    }
  }
  if (!CHARACTER_ROSTER_ROLES.includes(output.role)) return invalid('role', '不是允许的定位')
  if (output.relationships !== undefined) return invalid('relationships', '不得出现')
  if (output.currentState === undefined) return invalid('currentState', '必填')
  {
    if (!isRecord(output.currentState)) return invalid('currentState', '必须是对象')
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      const value = output.currentState[field]
      if (typeof value !== 'string' || !value.trim()) return invalid(`currentState.${field}`, '必须是非空文本')
      if (Array.from(value.trim()).length > CHARACTER_STATE_TEXT_MAX_CHARS) {
        return invalid(`currentState.${field}`, `不得超过 ${CHARACTER_STATE_TEXT_MAX_CHARS} 字符`)
      }
    }
    if (!Number.isSafeInteger(output.currentState.updatedAtChapter) || output.currentState.updatedAtChapter < 0) {
      return invalid('currentState.updatedAtChapter', '必须是非负整数')
    }
  }
  return undefined
}

function normalizeDetailStringList(value: unknown, separator: string): unknown {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value) || value.length === 0) return value
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return value
    normalized.push(item.trim())
  }
  return normalized.join(separator)
}

function normalizeBoundedDetailText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value
  return Array.from(value.trim()).slice(0, maxChars).join('')
}

export interface ArchitectureProjectSnapshot {
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
}

function assertArchitectureProjectSessionCurrent(
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error(workflowUiText(
      context,
      '当前项目已切换，架构生成已停止以避免写入错误项目',
      'The current project changed, so architecture generation stopped to avoid writing to the wrong project.',
    ))
  }
}

async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/.vela/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
  operationLabel: string,
  fallbackMessage?: string,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/.vela/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, operationLabel, fallbackMessage)
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
  fallbackError: string,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-core-update',
    { [key]: cleanContent },
    expectedProjectPath,
  )
  if (!result.success) {
    throw new Error(result.error || fallbackError)
  }

  // 通知 UI 层实时刷新架构完成状态
  const { globalEventBus } = await import('../../../shared/event-bus')
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName: `${key}.md`,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const existingConfig = { ...(useProjectStore.getState().currentProject?.novelConfig ?? {}) }
    callbacks.log(text(
      '正在调度配置专家 AI，准备解析您的脑洞...',
      'Preparing the configuration model to structure your story idea...',
    ))

    const template = await resolvePromptTemplate('generate_global_config', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 generate_global_config 模板',
      'The generate_global_config template was not found.',
    ))

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)
    const configJSONContract = buildNovelConfigJSONContract(
      this.totalChapters,
      this.wordsPerChapter,
      writingLanguage,
    )
    const authorConfigContext = Object.keys(existingConfig).length > 0
      ? promptLanguageText(
          writingLanguage,
          `【作者已有配置】\n以下非空内容和选择是作者权威输入：长文本只能在保留原文的基础上补充，类型、受众、结构与视角选择不得改写。\n${JSON.stringify(existingConfig, null, 2)}`,
          `[Existing author configuration]\nThe following non-empty content and choices are authoritative. Preserve long-form text and only add useful details; do not change the author's genre, audience, structure, or point-of-view choices.\n${JSON.stringify(existingConfig, null, 2)}`,
        )
      : ''
    const originalTask = [promptBuilder.build(), authorConfigContext, configJSONContract]
      .filter(Boolean)
      .join('\n\n')

    const initial = await this.callLLMResult(
      originalTask,
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'generate-global-config',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    let resultRaw: string
    if (initial.finishReason === 'stop') {
      resultRaw = initial.content
    } else if (initial.finishReason === 'length') {
      callbacks.log(text(
        '首轮配置 JSON 达到输出上限，已丢弃不可信截断内容，正在请求一次完整替代 JSON...',
        'The first configuration JSON reached the output limit. The untrusted truncated response was discarded; requesting one complete replacement JSON...',
      ))
      const replacement = await this.callLLMResult(
        promptLanguageText(
          writingLanguage,
          `上一轮输出因长度限制而中断。上一轮截断内容是不可信数据，已被丢弃，不得引用或续接。\n\n`
            + `【原始任务合同】\n${originalTask}\n\n`
            + '【硬性要求】\n从头完成原始任务，只输出一个完整替代 JSON。不要只补后缀，不要解释、Markdown 或思考过程。',
          `The previous response stopped at the length limit. Its truncated content is untrusted and discarded; do not quote or continue it.\n\n`
            + `[Original task contract]\n${originalTask}\n\n`
            + '[Hard requirement]\nRestart the original task and output one complete replacement JSON object only. Do not emit a suffix, explanation, Markdown, or reasoning.',
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: 'generate-global-config-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      if (replacement.finishReason !== 'stop') {
        throw this.createIncompleteCompletionError(replacement.finishReason)
      }
      resultRaw = replacement.content
    } else {
      throw this.createIncompleteCompletionError(initial.finishReason)
    }
    this.assertNotCancelled(context)

    callbacks.log(text(
      '解析完成，正在应用到项目配置...',
      'Parsing is complete; applying the result to the project configuration...',
    ))
    let parsed: NovelConfig
    try {
      parsed = decodeCompleteNovelConfig(resultRaw, this.totalChapters, this.wordsPerChapter)
    } catch (e) {
      throw new Error(text(
        'AI 返回的小说配置不完整或无效，结果未应用。详细信息: ' + String(e),
        'The AI novel configuration was incomplete or invalid, so the result was not applied.',
      ))
    }
    if (!isGeneratedGlobalGuidanceValid(parsed.globalGuidance)) {
      callbacks.log(text(
        '生成的全局写作要求不符合 4–8 条简短规则合同，正在执行唯一一次字段级完整替代。',
        'The generated global guidance did not satisfy the 4–8 short-rule contract; requesting the single field-level replacement.',
      ))
      const replacement = await this.callLLM(
        promptLanguageText(
          writingLanguage,
          `只纠正小说配置中的 globalGuidance 字段。写 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条跨章节长期有效的简短规则，每条独占一行，总计不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符。不得逐章列大纲、分配章节区间或复述核心大纲。只输出规则正文，不要标题、解释、Markdown 或 JSON。\n\n【已验证的其余小说配置，仅作上下文】\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
          `Correct only the globalGuidance field in the novel configuration. Write ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} short, stable cross-chapter rules, one per line, within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters total. Do not enumerate chapters, allocate chapter ranges, or restate the core outline. Output only the rules, with no title, explanation, Markdown, or JSON.\n\n[Validated remaining novel configuration — context only]\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          purpose: 'generate-global-guidance-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      const replacementGuidance = this.stripThinkingTags(replacement).trim()
      if (!isGeneratedGlobalGuidanceValid(replacementGuidance)) {
        throw new Error(text(
          `全局写作要求仍不符合 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条且不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符的合同，配置未应用。`,
          `The global guidance still does not satisfy the ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES}-rule, ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS}-character contract, so the configuration was not applied.`,
        ))
      }
      parsed = { ...parsed, globalGuidance: replacementGuidance }
    }

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未应用',
        'The current project changed, so the generated configuration was not applied.',
      ))
    }
    this.onGenerated(mergeExpandedNovelConfig(existingConfig, parsed))
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未保存',
        'The current project changed, so the generated configuration was not saved.',
      ))
    }
    const saved = await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log(text(
        'AI 配置生成并保存成功，请检查各字段后点击「生成架构」',
        'The AI configuration was generated and saved. Review the fields, then select Generate architecture.',
      ))
    } else {
      callbacks.log(text(
        'AI 配置生成成功，请检查各字段后点击「立即保存」',
        'The AI configuration was generated. Review the fields, then select Save now.',
      ))
    }
    callbacks.setProgress(100)
    return text('生成的配置已成功应用！', 'The generated configuration was applied successfully.')
  }
}

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)
    callbacks.log(text('生成故事前提...', 'Generating story premise...'))

    const template = await resolvePromptTemplate('premise', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 premise 模板',
      'The story-premise template was not found.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withGenre(modelFacts.genre)
      .withSubGenre(config.subGenre || modelFacts.genre)
      .withTopic(config.coreOutline || missingValue)
      .withTargetAudience(modelFacts.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-core-seed', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (!result.trim()) throw new Error(text(
      '故事前提生成失败，AI 返回空内容',
      'Story premise generation failed because the AI returned empty content.',
    ))
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    const heading = promptLanguageText(writingLanguage, '故事前提', 'Story Premise')
    const content = `# ${heading}\n\n${result}\n`
    this.assertNotCancelled(context)
    await writeArchToDb(
      'premise',
      content,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.premise_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '故事前提已生成并写入数据库',
      'Story premise generated and saved to the database.',
    ))
    return result
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  private assertCommittedRosterReadable(
    receipt: { snapshot?: { entries?: Array<{ name?: unknown }>; renderedMarkdown?: unknown } } | undefined,
    candidateEntries: unknown,
    text: UiText,
  ): asserts receipt is { snapshot: { entries: Array<{ name: string }>; renderedMarkdown: string } } {
    const snapshot = receipt?.snapshot
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0 || typeof snapshot.renderedMarkdown !== 'string' || !snapshot.renderedMarkdown.trim()) {
      throw new Error(text(
        '角色名单提交后未能回读角色卡和角色图谱，未将本步骤标记为成功',
        'Character cards and the character graph could not be read back after commit, so this step was not marked complete.',
      ))
    }

    if (!Array.isArray(candidateEntries)) return
    const candidateNames = candidateEntries
      .map(entry => (
        entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name.trim()
          : ''
      ))
      .filter(Boolean)
    const committedNames = new Set(snapshot.entries
      .map(entry => typeof entry.name === 'string' ? entry.name.trim() : '')
      .filter(Boolean))
    if (candidateNames.length === 0 || candidateNames.some(name => !committedNames.has(name))) {
      throw new Error(text(
        '角色名单提交回读不完整，未将本步骤标记为成功',
        'The committed character roster readback was incomplete, so this step was not marked complete.',
      ))
    }
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('character-architecture', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const promptCopy = characterArchitecturePrompts(writingLanguage)
    const creativeTemplate = await resolvePromptTemplate('character_dynamics', projectSession, writingLanguage)
    if (!creativeTemplate) throw new Error(text(
      '角色规划模板丢失',
      'The character-planning template is missing.',
    ))
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error(text(
        '故事前提尚未生成或内容不完整，请返回勾选生成',
        'The story premise is missing or incomplete. Go back and include it for generation.',
      ))
    }

    callbacks.log(text('生成角色图谱...', 'Generating character graph...'))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const manifestContext = {
      premise: premise_result,
      genre: modelFacts.genre,
      protagonistProfile: config.protagonistProfile || missingValue,
      globalGuidance: config.globalGuidance || missingValue,
      stepGuidance: ((context.data.stepGuidance as Record<string, string>) || {}).characters || missingValue,
      referenceWorks: config.referenceWorks || missingValue,
    }
    const manifestContextJson = JSON.stringify(manifestContext)
    const templateVariables = {
      premise: manifestContext.premise,
      genre: manifestContext.genre,
      protagonist_profile: manifestContext.protagonistProfile,
      global_guidance: manifestContext.globalGuidance,
      step_guidance: manifestContext.stepGuidance,
      reference_works: manifestContext.referenceWorks,
      number_of_chapters: String(config.totalChapters),
      golden_finger: config.goldenFinger || missingValue,
      world_building: config.worldSetting || missingValue,
    }
    const creativeSystem = composePromptSystemRole(creativeTemplate, writingLanguage)
    const creativeGuidance = renderPromptTaskGuidance(creativeTemplate, templateVariables, writingLanguage)
    const manifestSystem = `${creativeSystem}\n\n${promptCopy.manifestSystem}`
    const manifestTask = promptCopy.manifestTask(
      manifestContextJson,
      MIN_CHARACTER_SLOTS,
      MAX_CHARACTER_SLOTS,
    )
    const manifestPrompt = creativeGuidance
      ? `${creativeGuidance}\n\n${manifestTask}`
      : manifestTask
    const manifestSection = (sectionName: string, key: keyof typeof manifestContext) => ({
      sectionName,
      messageIndex: 1,
      finalText: JSON.stringify({ [key]: manifestContext[key] }).slice(1, -1),
    })
    const manifestRaw = await this.callLLMWithBoundedCompletion(
      manifestPrompt,
      manifestSystem,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'character-architecture-manifest',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
        promptBudget: {
          limitUtf8Bytes: MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
          sections: [
            {
              sectionName: 'system-instructions',
              messageIndex: 0,
              finalText: manifestSystem,
            },
            manifestSection('story-premise', 'premise'),
            manifestSection('genre', 'genre'),
            manifestSection('protagonist-profile', 'protagonistProfile'),
            manifestSection('global-guidance', 'globalGuidance'),
            manifestSection('step-guidance', 'stepGuidance'),
            manifestSection('reference-works', 'referenceWorks'),
          ],
        },
      },
      context,
    )
    let manifest: CharacterIdentitySlot[]
    try {
      manifest = decodeCharacterIdentityManifest(manifestRaw)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(text(
        detail,
        'The character identity manifest was invalid, so no character data was saved.',
      ))
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const manifestById = new Map(manifest.map(slot => [slot.slotId, slot]))
    const detailContract: StructuredBatchContract<CharacterIdentitySlot, CharacterDetailOutput> = {
      buildTask: ({ items, validatedPrefix }) => {
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        const prefix = JSON.stringify(validatedPrefix.map(entry => ({
          slotId: entry.slotId,
          name: entry.name,
          role: entry.role,
          relationships: entry.relationships,
        })))
        const frozenManifest = JSON.stringify({ slots: manifest })
        const slotIds = items.map(slot => slot.slotId).join(', ')
        const detailTask = promptCopy.detailTask({
          context: manifestContextJson,
          manifest: frozenManifest,
          slotIds,
          validatedPrefix: prefix,
        })
        const detailPrompt = creativeGuidance
          ? `${creativeGuidance}\n\n${detailTask}`
          : detailTask
        const detailSystem = `${creativeSystem}\n\n${promptCopy.detailSystem}`
        const detailRequestBytes = promptUtf8Bytes(detailSystem) + promptUtf8Bytes(detailPrompt)
        const fixedDetailRequestBytes = detailRequestBytes - promptUtf8Bytes(prefix)
        return {
          purpose: 'character-architecture-details',
          output: 'structured-data',
          messages: [
            { role: 'system', content: detailSystem },
            {
              role: 'user',
              content: detailPrompt,
            },
          ],
          promptBudget: {
            limitUtf8Bytes: fixedDetailRequestBytes + MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
            sections: [
              {
                sectionName: 'system-instructions',
                messageIndex: 0,
                finalText: detailSystem,
              },
              manifestSection('story-premise', 'premise'),
              manifestSection('genre', 'genre'),
              manifestSection('protagonist-profile', 'protagonistProfile'),
              manifestSection('global-guidance', 'globalGuidance'),
              manifestSection('step-guidance', 'stepGuidance'),
              manifestSection('reference-works', 'referenceWorks'),
              {
                sectionName: 'identity-manifest',
                messageIndex: 1,
                finalText: frozenManifest,
              },
              {
                sectionName: 'batch-slot-ids',
                messageIndex: 1,
                finalText: slotIds,
              },
              {
                sectionName: 'validated-prefix',
                messageIndex: 1,
                finalText: prefix,
              },
            ],
          },
        }
      },
      inputKey: slot => slot.slotId,
      outputKey: entry => entry.slotId,
      decode: (content) => {
        const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { entries?: unknown }
        if (!Array.isArray(parsed.entries)) throw new Error(text(
          '角色详情响应缺少 entries',
          'The character-detail response is missing entries.',
        ))
        return parsed.entries.map((candidate) => {
          if (!isRecord(candidate)) return candidate as unknown as CharacterDetailOutput
          const age = candidate.age
          const normalizedCandidate = { ...candidate }
          for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
            normalizedCandidate[field] = normalizeBoundedDetailText(
              candidate[field],
              CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS,
            )
          }
          let currentState: unknown = candidate.currentState
          if (isRecord(candidate.currentState)) {
            const normalizedState: Record<string, unknown> = {
              ...candidate.currentState,
              keyItems: normalizeDetailStringList(candidate.currentState.keyItems, '、'),
              recentEvents: normalizeDetailStringList(candidate.currentState.recentEvents, '；'),
              // Architecture generation describes the pre-chapter baseline. A
              // model-supplied future chapter must never become persisted fact.
              updatedAtChapter: 0,
            }
            for (const field of CHARACTER_STATE_TEXT_FIELDS) {
              normalizedState[field] = normalizeBoundedDetailText(
                normalizedState[field],
                CHARACTER_STATE_TEXT_MAX_CHARS,
              )
            }
            currentState = normalizedState
          }
          return {
            ...normalizedCandidate,
            ...(typeof age === 'number' && Number.isFinite(age) ? { age: String(age) } : {}),
            currentState,
          } as unknown as CharacterDetailOutput
        })
      },
      validateItem: (entry) => {
        const basicError = validateCharacterDetail(entry)
        if (basicError) return basicError
        const slot = manifestById.get(entry.slotId)
        if (!slot || slot.name !== entry.name || slot.role !== entry.role) return '角色详情身份与冻结清单不一致'
        return undefined
      },
    }
    const generationExecution = this.requireGenerationExecution()
    const detailExecution = await createStructuredBatchExecutor({
      contract: detailContract,
      session: injectWritingSkillIntoSession(generationExecution.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: manifest,
      limits: { maxBatchItems: CHARACTER_DETAIL_BATCH_SIZE },
      signal: generationExecution.signal,
    })
    if (!detailExecution.ok) {
      const diagnostic = detailExecution.failure.diagnostic
      const attempts = detailExecution.receipt.attempts.length > 0
        ? detailExecution.receipt.attempts
            .map(attempt => `purpose=${attempt.purpose ?? 'unknown'} finishReason=${attempt.finishReason}`)
            .join('; ')
        : 'none'
      const failureReceipt = [
        `code=${detailExecution.failure.code}`,
        `reason=${detailExecution.failure.reason ?? 'unknown'}`,
        ...(diagnostic
          ? [`diagnosticCode=${diagnostic.code} diagnosticPath=${diagnostic.path} diagnosticField=${diagnostic.field}`]
          : []),
        `attempts=${attempts}`,
      ].join(' ')
      throw new Error(text(
        `${detailExecution.failure.message}；角色详情失败收据：${failureReceipt}`,
        `Character details failed structural validation and were not saved. Receipt: ${failureReceipt}`,
      ))
    }
    if (detailExecution.items.length !== manifest.length) {
      throw new Error(text(
        '角色详情未完整覆盖冻结身份清单',
        'Character details did not fully cover the frozen identity manifest.',
      ))
    }
    const entries = detailExecution.items.map((detail) => {
      const entry: Record<string, unknown> = { ...detail }
      delete entry.slotId
      entry.relationships = manifestById.get(detail.slotId)!.relations.map(relation => ({
        target: manifestById.get(relation.targetSlotId)!.name,
        relation: relation.relation,
      }))
      return entry as unknown as CharacterRosterEntry
    })
    const candidate = { schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION, entries }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const currentRoster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentRoster.revision,
        schemaVersion: candidate.schemaVersion as typeof CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: candidate.entries as CharacterRosterEntry[],
        intent: 'architecture_generation',
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || text(
        '角色名单提交失败，未保存角色图谱或角色卡',
        'The character-roster commit failed, so the character graph and cards were not saved.',
      ))
    }
    this.assertCommittedRosterReadable(commitResult.receipt, candidate.entries, text)
    const renderedMarkdown = commitResult.receipt.snapshot.renderedMarkdown
    const characterCount = commitResult.receipt.snapshot.entries.length

    // 事务 receipt 是取消边界：提交成功后不再把已保存的角色事实误报为零写入取消。
    if (context.cancelled) {
      this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }

    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (context.cancelled) {
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }
    partial.character_dynamics_result = renderedMarkdown
    context.data.partial = partial
    try {
      await savePartialData(
        expectedProjectPath,
        partial,
        projectSession,
        text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
        text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      callbacks.log(
        text(
          `[警告] 角色图谱与 ${characterCount} 张角色卡已保存，但检查点保存失败：${detail}。当前流程可继续；若中断，将无法从此步骤恢复。`,
          `[Warning] The character graph and ${characterCount} character cards were saved, but the checkpoint failed: ${detail}. The workflow can continue, but it cannot resume from this step after an interruption.`,
        ),
      )
    }

    callbacks.log(text(
      `角色图谱与 ${characterCount} 张角色卡已生成`,
      `The character graph and ${characterCount} character cards were generated.`,
    ))
    return renderedMarkdown
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error(text(
        '故事前提尚未生成或内容不完整，请返回勾选生成',
        'The story premise is missing or incomplete. Go back and include it for generation.',
      ))
    }

    callbacks.log(text('生成世界观...', 'Generating worldbuilding...'))
    const template = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The worldbuilding template is missing.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise_result)
      .withGenre(modelFacts.genre)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-world-building', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    this.assertNotCancelled(context)
    const heading = promptLanguageText(writingLanguage, '世界观', 'Worldbuilding')
    await writeArchToDb(
      'worldbuilding',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.world_building_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '世界观已生成并写入数据库',
      'Worldbuilding generated and saved to the database.',
    ))
    return result
  }
}

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(
    private selectedSteps: string[],
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: {
      /** 从上次中断点续写情节大纲（需检查点 synopsis_incomplete=true）。 */
      resumeSynopsis?: boolean
      /** 本次只详写前 N 章（0/空 = 全书）。 */
      synopsisChapters?: number | null
    } = {},
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw new Error(text(
      '故事前提未生成',
      'The story premise has not been generated.',
    ))
    if (!char_dyn || char_dyn.includes('待生成')) throw new Error(text(
      '角色图谱未生成',
      'The character graph has not been generated.',
    ))
    if (!world_b || world_b.includes('待生成')) throw new Error(text(
      '世界观未生成',
      'Worldbuilding has not been generated.',
    ))

    // 进度日志保持先于模板解析/检查点读取，失败时用户也能看到步骤已启动
    const resumeRequested = this.options.resumeSynopsis === true
    callbacks.log(text(
      resumeRequested
        ? '正在读取情节大纲中断检查点...'
        : '生成情节大纲...',
      resumeRequested
        ? 'Reading the interrupted plot-outline checkpoint...'
        : 'Generating plot outline...',
    ))

    const template = await resolvePromptTemplate('synopsis', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The plot-outline template is missing.',
    ))

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(
      config.plotStructure || 'three_act',
      config.totalChapters,
      writingLanguage,
    )
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited', writingLanguage)

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(modelFacts.genre)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || promptLanguageText(writingLanguage, '（未填写）', '(not provided)'))
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).synopsis || '')

    // ===== 断点续写：仅续写请求需要在生成前确认种子（普通生成保持原时序，
    // 成功/中断落盘时才读取合并检查点文件，避免额外的启动 IPC） =====
    const seedPartial = resumeRequested
      ? (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
      : (context.data.partial as PartialArchData | undefined)
    if (seedPartial) context.data.partial = seedPartial
    const existingSeed = ((seedPartial?.synopsis_result) || '').trim()
    const resuming = resumeRequested
      && seedPartial?.synopsis_incomplete === true
      && existingSeed.length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS

    // ===== 分块指令：本次只详写前 N 章（仅全新生成时生效） =====
    const scope = resuming
      ? 0
      : Number.isSafeInteger(this.options.synopsisChapters) && (this.options.synopsisChapters as number) > 0
        ? this.options.synopsisChapters as number
        : 0
    const scoped = !resuming && scope > 0 && scope < config.totalChapters
    const taskPrompt = [
      promptBuilder.build(),
      scoped ? synopsisScopeInstruction(writingLanguage, config.totalChapters, scope) : '',
    ].filter(Boolean).join('\n\n')

    if (resuming) {
      callbacks.log(text(
        '检测到上次中断的情节大纲检查点，正在从断点续写...',
        'An interrupted plot-outline checkpoint was found; resuming from the break point...',
      ))
    } else if (scoped) {
      callbacks.log(text(
        `本次仅详细生成前 ${scope} 章（全书 ${config.totalChapters} 章），其余章节以占位概览；后续可继续分块生成`,
        `This batch details only the first ${scope} of ${config.totalChapters} chapters; the rest is a placeholder overview for later batches`,
      ))
    } else if (resumeRequested) {
      callbacks.log(text(
        '未找到可续写的中断检查点，将从头生成情节大纲',
        'No resumable interrupted checkpoint was found; generating the plot outline from scratch.',
      ))
    }

    // ===== 有界生成：自动续写至 stop；失败时把已完成部分交给 onPartialAvailable =====
    let interruptedContent = ''
    let merged = ''
    try {
      merged = await this.callLLMWithAppendContinuation({
        taskPrompt,
        systemPrompt: promptBuilder.getSystemRole(),
        callbacks,
        context,
        llmOptions: {
          purpose: resuming ? 'generate-plot-architecture-resume' : 'generate-plot-architecture',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        seedText: resuming ? existingSeed : '',
        maxContinuations: 3,
        onPartialAvailable: content => { interruptedContent = content },
      })
    } catch (error) {
      // 只有「确实新增了内容后才中断」的失败才值得落盘并允许断点续写；
      // 无净增（no-progress）、取消与网络错误保持原样失败。
      const partialText = stripThinkingTags(interruptedContent).trim()
      const seedTrimmed = stripThinkingTags(resuming ? existingSeed : '').trim()
      const madeProgress = partialText !== seedTrimmed
      if (
        !context.cancelled
        && madeProgress
        && partialText.length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
      ) {
        callbacks.log(text(
          '情节大纲输出被模型长度上限中断，正在自动保存已完成部分...',
          'Plot-outline output stopped at the model length limit; saving the completed part automatically...',
        ))
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        try {
          await this.persistInterruptedSynopsis(
            projectSession,
            expectedProjectPath,
            context,
            partialText,
          )
          callbacks.log(text(
            `已完成部分（约 ${partialText.length} 字）已保存为不完整大纲，可点击「继续生成情节大纲」从断点续写`,
            `The completed part (about ${partialText.length} characters) was saved as an incomplete outline. Click “Continue plot outline” to resume from the break point.`,
          ))
        } catch (persistError) {
          // 检查点落盘失败时不得提供「继续生成」入口，避免续写时覆盖全文。
          throw persistError
        }
        throw new PlotOutlineResumeAvailableError(text(
          `情节大纲生成在完成前中断，AI 输出达到模型最大长度。已完成部分（约 ${partialText.length} 字）已自动保存为不完整大纲，没有白费。\n点击「继续生成情节大纲」可从断点续写；若整体内容仍偏长，也可在「AI 生成架构」中填写本次生成的章节数，分块生成。`,
          `Plot-outline generation stopped before completion because the AI output reached the model maximum length. The finished part (about ${partialText.length} characters) was saved automatically as an incomplete outline.\nClick “Continue plot outline” to resume from the break point, or set a smaller per-batch chapter count in “Generate story architecture” to generate it in blocks.`,
        ))
      }
      throw error
    }

    if (!merged.trim()) throw new Error(text(
      '情节大纲生成失败，AI 返回空内容',
      'Plot outline generation failed because the AI returned empty content.',
    ))
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    const heading = promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')
    await writeArchToDb(
      'synopsis',
      `# ${heading}\n\n${merged.trim()}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    // 合并既有检查点文件：只更新 synopsis 字段，保留 premise 等其它步骤检查点
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    partial.synopsis_result = merged.trim()
    partial.synopsis_incomplete = false
    try {
      await savePartialData(
        expectedProjectPath,
        partial,
        projectSession,
        text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
        text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      callbacks.log(
        text(
          `[警告] 情节大纲已写入数据库，但检查点保存失败：${detail}。中断后将无法从此检查点续写。`,
          `[Warning] The plot outline was saved to the database, but the checkpoint failed: ${detail}. It cannot resume from this checkpoint after an interruption.`,
        ),
      )
    }

    if (this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters') &&
      this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      this.assertNotCancelled(context)
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          `${expectedProjectPath}/.vela/partial_arch.json`,
          '{}',
          expectedProjectPath,
        ),
        text('清理架构生成检查点', 'Clear architecture-generation checkpoint'),
        text('清理架构生成检查点失败', 'Failed to clear the architecture-generation checkpoint.'),
      )
    }

    callbacks.log(text(
      resuming ? '情节大纲续写完成并写入数据库' : '情节大纲已生成并写入数据库',
      resuming ? 'Plot outline continuation completed and saved to the database.' : 'Plot outline generated and saved to the database.',
    ))
    return merged.trim()
  }

  /** 中断时落盘：DB 存带「未完成」标记的全文，partial 检查点保存纯内容供续写。 */
  private async persistInterruptedSynopsis(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    partialText: string,
  ): Promise<void> {
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const heading = promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')
    const marker = promptLanguageText(
      writingLanguage,
      SYNOPSIS_INCOMPLETE_MARKER_ZH,
      SYNOPSIS_INCOMPLETE_MARKER_EN,
    )
    await writeArchToDb(
      'synopsis',
      `# ${heading}\n\n${partialText}\n${marker}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.synopsis_result = partialText
    partial.synopsis_incomplete = true
    context.data.partial = partial
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存中断的情节大纲检查点', 'Save the interrupted plot-outline checkpoint'),
      text('保存中断的情节大纲检查点失败', 'Failed to save the interrupted plot-outline checkpoint.'),
    )
  }
}
