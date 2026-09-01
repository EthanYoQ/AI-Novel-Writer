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
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { WritingLanguage } from '../../../shared/writing-language'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_ROSTER_ROLES,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
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
- referenceWorks 可省略；若输出必须是字符串。
- 只输出一个完整 JSON 对象。枚举只允许上述英文值，不得输出中文枚举、近义词、说明文字、Markdown、代码围栏或思考过程。`, `[Immutable novel-configuration JSON contract]
- The following nine fields are required non-empty strings: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure is required and must be exactly one of: three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform.
- narrativePOV is required and must be exactly one of: third_limited | first_person | third_omniscient | multi_pov.
- totalChapters and wordsPerChapter are authoritative author settings and may be omitted. If present, they must equal ${totalChapters} and ${wordsPerChapter} respectively.
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
    value = JSON.parse(content.trim())
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
const CHARACTER_DETAIL_BATCH_SIZE = 1
const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 24_000

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
    if (
      typeof candidate.slotId !== 'string' || !candidate.slotId.trim()
      || typeof candidate.name !== 'string' || !candidate.name.trim()
      || typeof candidate.role !== 'string' || !CHARACTER_ROSTER_ROLES.includes(candidate.role as CharacterRosterEntry['role'])
      || typeof candidate.narrativeDuty !== 'string' || !candidate.narrativeDuty.trim()
    ) throw new Error(`角色身份清单第 ${index + 1} 项字段不完整`)
    return {
      slotId: candidate.slotId.trim(),
      name: candidate.name.trim(),
      role: candidate.role as CharacterRosterEntry['role'],
      narrativeDuty: candidate.narrativeDuty.trim(),
      relations: relations.map((relation, relationIndex) => {
        if (!isRecord(relation)
          || typeof relation.targetSlotId !== 'string' || !relation.targetSlotId.trim()
          || typeof relation.relation !== 'string' || !relation.relation.trim()) {
          throw new Error(`角色身份清单第 ${index + 1} 项关系 ${relationIndex + 1} 无效`)
        }
        return { targetSlotId: relation.targetSlotId.trim(), relation: relation.relation.trim() }
      }),
    }
  })
  const slotIds = new Set(slots.map(slot => slot.slotId))
  const names = new Set(slots.map(slot => slot.name))
  if (slotIds.size !== slots.length || names.size !== slots.length) throw new Error('角色身份清单包含重复 slotId 或姓名')
  if (slots.filter(slot => slot.role === 'protagonist').length !== 1) throw new Error('角色身份清单必须恰好包含一个主角')
  for (const slot of slots) {
    for (const relation of slot.relations) {
      if (!slotIds.has(relation.targetSlotId) || relation.targetSlotId === slot.slotId) {
        throw new Error('角色身份清单关系端点不闭合或存在自指')
      }
    }
  }
  return slots
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
  if (!CHARACTER_ROSTER_ROLES.includes(output.role)) return invalid('role', '不是允许的定位')
  if (output.relationships !== undefined) return invalid('relationships', '不得出现')
  if (output.currentState === undefined) return invalid('currentState', '必填')
  {
    if (!isRecord(output.currentState)) return invalid('currentState', '必须是对象')
    for (const field of ['location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents'] as const) {
      const value = output.currentState[field]
      if (typeof value !== 'string' || !value.trim()) return invalid(`currentState.${field}`, '必须是非空文本')
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
    const originalTask = `${promptBuilder.build()}\n\n${configJSONContract}`

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
    this.onGenerated(parsed)
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
    callbacks.log(text('生成故事前提...', 'Generating story premise...'))

    const template = await resolvePromptTemplate('premise', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 premise 模板',
      'The story-premise template was not found.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withGenre(config.genre)
      .withSubGenre(config.subGenre || config.genre)
      .withTopic(config.coreOutline || missingValue)
      .withTargetAudience(config.targetAudience)
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
      genre: config.genre,
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
          const currentState = isRecord(candidate.currentState)
            ? {
                ...candidate.currentState,
                keyItems: normalizeDetailStringList(candidate.currentState.keyItems, '、'),
                recentEvents: normalizeDetailStringList(candidate.currentState.recentEvents, '；'),
              }
            : candidate.currentState
          return {
            ...candidate,
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
    if (!detailExecution.ok) throw new Error(text(
      detailExecution.failure.message,
      'Character details failed structural validation and were not saved.',
    ))
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
      .withGenre(config.genre)
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

    callbacks.log(text('生成情节大纲...', 'Generating plot outline...'))
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
      .withGenre(config.genre)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || promptLanguageText(writingLanguage, '（未填写）', '(not provided)'))
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).synopsis || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-plot-architecture', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    this.assertNotCancelled(context)
    const heading = promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')
    await writeArchToDb(
      'synopsis',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.synopsis_result = result
    context.data.partial = partial

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
      '情节大纲已生成并写入数据库',
      'Plot outline generated and saved to the database.',
    ))
    return result
  }
}
