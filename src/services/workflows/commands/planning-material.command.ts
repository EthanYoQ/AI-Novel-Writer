import type { PlanningMaterial } from '../../knowledge-service'
import { characterRosterEntriesFromCards } from '../../character-roster-client'
import type { CharacterRosterEntry } from '../../../shared/character-roster'
import { CHARACTER_ROLES, CHARACTER_ROLE_LABELS, normalizeCharacterRole } from '../../../shared/character-role'
import { CHARACTER_ARRAY_KEYS, CHARACTER_FIELD_ALIASES } from '../character-card-fields'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { promptLanguageText } from '../../prompt-language'
import { parseCharacterCardsFromModelOrSource } from '../character-card-normalizer'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  WORKFLOW_GENERATION_BUDGETS,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'

const MATERIAL_CHUNK_CHARACTERS = 12_000
const MATERIAL_EXTRACTION_BATCH_SIZE = 2
const MATERIAL_CHUNK_BOUNDARY_START = Math.floor(MATERIAL_CHUNK_CHARACTERS * 0.8)
const PLANNING_MATERIAL_CHARACTER_CANDIDATES = 'planningMaterialCharacterCandidates'

interface MaterialChunk {
  sourceId: string
  fileName: string
  text: string
}

interface MaterialExtraction {
  sourceId: string
  characterCards: Array<Record<string, unknown>>
}

const MATERIAL_CHARACTER_TEXT_FIELDS = [
  'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const

function mergeMaterialCharacterFacts(
  cards: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>()

  for (const card of cards) {
    const name = typeof card.name === 'string' ? card.name.trim() : ''
    if (!name) continue
    const key = name.toLocaleLowerCase('en-US')
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, { ...card, name })
      continue
    }

    const merged = { ...existing }
    for (const field of MATERIAL_CHARACTER_TEXT_FIELDS) {
      const facts = [existing[field], card[field]].flatMap(value => (
        typeof value === 'string' && value.trim() ? [value.trim()] : []
      ))
      if (facts.length > 0) merged[field] = [...new Set(facts)].join('；')
    }
    // 关系原样并集交给归一化层拆分：能确定目标的成结构化边，其余（目标尚未
    // 成卡、名字写法不一致、散文式描述）原样留作关系备注。这里不做过滤，
    // 否则同名角色跨块出现时会把作者/模型给的关系原文整段丢掉。
    merged.relationships = [
      ...(Array.isArray(existing.relationships) ? existing.relationships : []),
      ...(Array.isArray(card.relationships) ? card.relationships : []),
    ]
    byName.set(key, merged)
  }

  return [...byName.values()]
}

function materialChunkEnd(text: string, offset: number): number {
  const hardEnd = Math.min(offset + MATERIAL_CHUNK_CHARACTERS, text.length)
  if (hardEnd === text.length) return hardEnd

  const candidate = text.slice(offset, hardEnd)
  const boundaryPattern = /(?:\r?\n[ \t]*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]】」』]*(?=\s|$))/gu
  let boundaryEnd = 0
  for (const match of candidate.slice(MATERIAL_CHUNK_BOUNDARY_START).matchAll(boundaryPattern)) {
    boundaryEnd = MATERIAL_CHUNK_BOUNDARY_START + match.index + match[0].length
  }
  if (boundaryEnd) return offset + boundaryEnd
  const previousCodeUnit = text.charCodeAt(hardEnd - 1)
  const nextCodeUnit = text.charCodeAt(hardEnd)
  return previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF
    ? hardEnd - 1
    : hardEnd
}

function materialChunks(materials: readonly PlanningMaterial[]): MaterialChunk[] {
  return materials.flatMap((material, materialIndex) => {
    const text = material.text.trim()
    if (!text) return []
    const chunks: MaterialChunk[] = []
    for (let offset = 0, chunkIndex = 0; offset < text.length; chunkIndex += 1) {
      const end = materialChunkEnd(text, offset)
      chunks.push({
        sourceId: `${materialIndex + 1}:${chunkIndex + 1}`,
        fileName: material.fileName,
        text: text.slice(offset, end),
      })
      offset = end
    }
    return chunks
  })
}

/** 字段别名索引：中文字段名与常见变体都指向规范键。 */
const MATERIAL_FIELD_ALIAS_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>()
  for (const [canonical, aliases] of Object.entries(CHARACTER_FIELD_ALIASES)) {
    index.set(canonical.trim().toLocaleLowerCase('en-US'), canonical)
    for (const alias of aliases) {
      index.set(alias.trim().toLocaleLowerCase('en-US'), canonical)
    }
  }
  return index
})()

/**
 * 把模型给出的字段名归一到规范键。
 *
 * 「格式乱飞的角色卡也能被整理进正确的结构」就靠这一步：此前一个中文字段名
 * （「姓名」「关系网」）就会让整批提取以 invalid_item 失败，作者只拿到一句报错。
 * 认不出来的键直接丢弃，不牵连同一张卡里其余已经认出来的字段。
 */
function canonicalizeMaterialCard(card: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(card)) {
    const key = MATERIAL_FIELD_ALIAS_INDEX.get(rawKey.trim().toLocaleLowerCase('en-US'))
    if (!key || canonical[key] !== undefined) continue
    canonical[key] = value
  }
  return canonical
}

/** 文本字段容错：字符串直接用，数组（如能力列表）用「；」拼起来。 */
function materialTextValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .join('；')
  }
  return ''
}

/** 关系字段原样交给归一化层：数组、对象映射、纯文本三种形态它都认。 */
function materialRelationshipValue(value: unknown): unknown {
  if (Array.isArray(value) || typeof value === 'string') return value
  if (value && typeof value === 'object') return value
  return undefined
}

function parseExtraction(content: string): MaterialExtraction[] {
  const trimmed = content.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  const root = JSON.parse(fenced?.[1]?.trim() ?? trimmed) as unknown
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  const rootRecord = root as Record<string, unknown>
  const requireNonEmptyText = (value: unknown, path: string): string => {
    if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
    if (!value.trim()) throw new StructuredContractDiagnostic('empty_value', path)
    return value
  }
  // 结果信封之外的顶层键直接忽略：真正不可省的是 results 数组本身。
  const rawResults = rootRecord.results
  if (!Array.isArray(rawResults)) {
    throw new StructuredContractDiagnostic(
      Object.hasOwn(rootRecord, 'results') ? 'invalid_type' : 'missing_field',
      '$.results',
    )
  }
  return rawResults.map((candidate, resultIndex) => {
    const resultPath = `$.results[${resultIndex}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new StructuredContractDiagnostic('invalid_type', resultPath)
    }
    const value = candidate as Record<string, unknown>
    const sourceId = requireNonEmptyText(value.sourceId, `${resultPath}.sourceId`)
    // 卡片数组的键名也容错：characterCards / characters / 角色卡 / 人物 …… 都认。
    const cardsKey = Object.keys(value).find(key => (
      (CHARACTER_ARRAY_KEYS as readonly string[]).includes(key)
    ))
    const rawCards = cardsKey ? value[cardsKey] : undefined
    if (!Array.isArray(rawCards)) {
      throw new StructuredContractDiagnostic(
        cardsKey ? 'invalid_type' : 'missing_field',
        `${resultPath}.characterCards`,
      )
    }
    const characterCards = rawCards.flatMap((card) => {
      if (!card || typeof card !== 'object' || Array.isArray(card)) return []
      const cardValue = canonicalizeMaterialCard(card as Record<string, unknown>)
      const name = materialTextValue(cardValue.name)
      // 没有姓名的「卡」不是角色：丢掉它，但不牵连同一批里的其他角色。
      if (!name) return []
      const cleaned: Record<string, unknown> = {
        name,
        role: normalizeCharacterRole(materialTextValue(cardValue.role)),
      }
      for (const field of MATERIAL_CHARACTER_TEXT_FIELDS) {
        const text = materialTextValue(cardValue[field])
        if (text) cleaned[field] = text
      }
      const relationships = materialRelationshipValue(cardValue.relationships)
      if (relationships !== undefined) cleaned.relationships = relationships
      return [cleaned]
    })
    return {
      sourceId,
      characterCards,
    }
  })
}

function formatCandidatePreview(
  entries: readonly CharacterRosterEntry[],
  context: CommandExecuteParams['context'],
): string {
  const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
  if (entries.length === 0) return text(
    '## 待确认角色卡候选\n\n资料中未发现明确角色；确认后不会写入角色名单。',
    '## Character-card candidates awaiting confirmation\n\nNo explicit characters were found; confirmation will not change the character roster.',
  )

  const fieldLabels = {
    gender: text('性别', 'Gender'),
    age: text('年龄', 'Age'),
    appearance: text('外貌', 'Appearance'),
    personality: text('性格', 'Personality'),
    background: text('背景', 'Background'),
    abilities: text('能力', 'Abilities'),
    motivation: text('动机', 'Motivation'),
    arc: text('角色弧光', 'Character arc'),
    notes: text('其他事实', 'Other facts'),
  } as const
  const sections = entries.map((entry, index) => {
    const roleLabels = CHARACTER_ROLE_LABELS[entry.role]
    const rows = [
      `- ${text('角色定位', 'Role')}: ${context.uiLocale === 'en-US' ? roleLabels.enUS : roleLabels.zhCN}`,
      ...MATERIAL_CHARACTER_TEXT_FIELDS.flatMap(field => (
        entry[field] ? [`- ${fieldLabels[field]}: ${entry[field]}`] : []
      )),
      ...(entry.relationships.length > 0
        ? [`- ${text('关系', 'Relationships')}: ${entry.relationships
            .map(relationship => `${relationship.target}: ${relationship.relation}`)
            .join(text('；', '; '))}`]
        : []),
      ...(entry.relationshipNotes?.trim()
        ? [`- ${text('关系备注', 'Relationship notes')}: ${entry.relationshipNotes}`]
        : []),
    ]
    return `### ${index + 1}. ${entry.name}\n${rows.join('\n')}`
  })
  const hasAnyRelationship = entries.some(entry => (
    entry.relationships.length > 0 || entry.relationshipNotes?.trim()
  ))
  return [
    text(
      `## 待确认角色卡候选（${entries.length}）`,
      `## Character-card candidates awaiting confirmation (${entries.length})`,
    ),
    text(
      '以下候选尚未写入角色名单。请核对后再确认导入；已有作者手工字段会保留。',
      'These candidates have not been saved. Review them before confirming import; existing author-edited fields will be preserved.',
    ),
    ...(hasAnyRelationship ? [] : [text(
      '⚠ 这批候选里没有出现任何角色关系。若资料中确实写了关系，可以导入后到角色档案里补充，或把关系写进资料再提取一次。',
      '⚠ No relationships were found in these candidates. If the material did describe them, add them from the character profile after import, or include them in the material and extract again.',
    )]),
    ...sections,
  ].join('\n\n')
}

export class ExtractPlanningMaterialCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly materials: readonly PlanningMaterial[],
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，角色提取已停止', 'The project changed, so character extraction stopped.'))

    const chunks = materialChunks(this.materials)
    if (chunks.length === 0) {
      context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] = []
      return formatCandidatePreview([], context)
    }
    const minimumCalls = Math.ceil(chunks.length / MATERIAL_EXTRACTION_BATCH_SIZE)
    const callCap = WORKFLOW_GENERATION_BUDGETS.structured.maxAttempts
    if (minimumCalls > callCap) {
      throw new Error(text(
        `所选资料会生成 ${chunks.length} 个分块，按每批 ${MATERIAL_EXTRACTION_BATCH_SIZE} 块至少需要 ${minimumCalls} 次模型调用，超过本次上限 ${callCap} 次。尚未发送任何资料；请减少本次选择后分批提取。`,
        `The selected material produces ${chunks.length} chunks and needs at least ${minimumCalls} model calls at ${MATERIAL_EXTRACTION_BATCH_SIZE} chunks per batch, exceeding this run's ${callCap}-call limit. No material was sent; reduce the selection and extract it in separate runs.`,
      ))
    }
    callbacks.log(text('正在从创作资料中提取角色卡...', 'Extracting character cards from the planning material...'))

    const contract: StructuredBatchContract<MaterialChunk, MaterialExtraction> = {
      buildTask: ({ items }) => {
        const sources = items.map(item => promptLanguageText(
          writingLanguage,
          `【资料 ${item.sourceId}｜${item.fileName}】\n${item.text}`,
          `[Material ${item.sourceId} | ${item.fileName}]\n${item.text}`,
        )).join('\n\n')
        const requestedIds = items.map(item => item.sourceId)
        return {
          purpose: 'planning-material-character-extraction',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: promptLanguageText(
                writingLanguage,
                '你从作者资料中提取明确出现的小说角色。不得虚构新角色或改写作者事实。只输出严格 JSON。',
                'Extract only fiction characters explicitly present in the author material. Do not invent characters or rewrite author facts. Output strict JSON only.',
              ),
            },
            {
              role: 'user',
              content: promptLanguageText(
                writingLanguage,
                `为每个资料块返回且只返回一个结果，sourceId 必须完整覆盖 ${JSON.stringify(requestedIds)}。只写入资料明确陈述的事实；资料中明确陈述的每条角色事实都必须写入对应支持字段。每张角色卡必须有 name 和 role。资料未明确给出的可选字段必须省略，不得猜测、补齐或用空值占位。relationships 使用 {"target":"姓名","relation":"关系"} 数组；role 只能是 protagonist、antagonist、supporting、minor。\n输出合同（删除资料未明确给出的可选字段）：{"results":[{"sourceId":"精确资料块 ID","characterCards":[{"name":"姓名","role":"supporting","gender":"明确性别","age":"明确年龄","appearance":"明确外貌","personality":"明确性格","background":"明确经历、职业、背景或秘密","abilities":"明确能力","motivation":"明确动机","relationships":[{"target":"姓名","relation":"明确关系"}],"arc":"明确角色弧光","notes":"其他明确事实"}]}]}\n\n${sources}`,
                `Return exactly one result for every material chunk and cover these sourceId values exactly: ${JSON.stringify(requestedIds)}. Include only facts explicitly stated in the material. Every explicit character fact in the material must be included in the corresponding supported field. Every character card must have name and role. Omit optional fields that are not explicitly stated; do not guess, fill gaps, or emit empty placeholders. relationships is an array of {"target":"name","relation":"relationship"}; role must be protagonist, antagonist, supporting, or minor.\nOutput contract (remove optional fields not explicitly stated in the material): {"results":[{"sourceId":"exact material chunk ID","characterCards":[{"name":"name","role":"supporting","gender":"explicit gender","age":"explicit age","appearance":"explicit appearance","personality":"explicit personality","background":"explicit history, occupation, background, or secret","abilities":"explicit abilities","motivation":"explicit motivation","relationships":[{"target":"name","relation":"explicit relationship"}],"arc":"explicit character arc","notes":"other explicit facts"}]}]}\n\n${sources}`,
              ),
            },
          ],
        }
      },
      inputKey: item => item.sourceId,
      outputKey: result => result.sourceId,
      decode: parseExtraction,
      validateItem: (result) => {
        for (const card of result.characterCards) {
          if (typeof card.name !== 'string' || !card.name.trim()) return '角色卡必须包含姓名'
          if (typeof card.role !== 'string' || !CHARACTER_ROLES.some(role => role === card.role)) {
            return '角色卡必须包含合法角色定位'
          }
        }
        return undefined
      },
    }
    const generation = this.requireGenerationExecution()
    const extraction = await createStructuredBatchExecutor({
      contract,
      session: injectWritingSkillIntoSession(generation.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: chunks,
      limits: { maxBatchItems: MATERIAL_EXTRACTION_BATCH_SIZE },
      signal: generation.signal,
    })
    if (!extraction.ok) {
      const reason = extraction.failure.reason ?? 'unknown'
      throw new Error(text(
        `角色卡提取失败（code=${extraction.failure.code}；reason=${reason}）。`,
        `Character-card extraction failed (code=${extraction.failure.code}; reason=${reason}).`,
      ))
    }

    const rawCards = mergeMaterialCharacterFacts(extraction.items.flatMap(result => result.characterCards))
    // 关系能不能成边要看**完整名单**：只认本批候选，会把「与项目里已有角色之间
    // 的关系」误判成无主文本、白白留成关系备注（已验证的真实缺口）。名单直接
    // 取内存里的角色 store —— 提取阶段不为一次只读再发 IPC，也不碰持久层。
    const existingCharacterNames = useCharacterStore.getState().characters.map(card => card.name)
    const cards = parseCharacterCardsFromModelOrSource(
      JSON.stringify({ characterCards: rawCards }),
      '',
      existingCharacterNames,
    )
    const entries = characterRosterEntriesFromCards(cards)
    this.assertNotCancelled(context)
    context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] = entries
    if (cards.length === 0) {
      callbacks.log(text('未发现明确角色，角色名单尚未更改', 'No explicit characters were found; the character roster is unchanged.'))
      callbacks.setProgress(100)
      return formatCandidatePreview(entries, context)
    }

    callbacks.setProgress(100)
    callbacks.log(text(
      `已生成 ${cards.length} 张待确认角色卡，角色名单尚未更改`,
      `Generated ${cards.length} character-card candidates; the character roster is unchanged.`,
    ))
    return formatCandidatePreview(entries, context)
  }
}

/**
 * 提取命令产出的候选读回口。
 *
 * 方案 A：工作流只做提取，候选必须交给 CharacterCardCandidateDialog 让作者
 * 逐条过目；工作流的完成回调通过本函数取到它们，再交付给界面。
 *
 * 返回**深拷贝**：候选随后会经过勾选、改分类等界面操作，不该回头污染
 * 工作流上下文里的那一份（工作流可能在重试或恢复时再次读到它）。
 */
export function readExtractedCharacterCandidates(
  context: { data: Record<string, unknown> },
): CharacterRosterEntry[] {
  const value = context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES]
  if (!Array.isArray(value)) return []
  return (value as CharacterRosterEntry[]).map(entry => ({
    ...entry,
    relationships: Array.isArray(entry.relationships)
      ? entry.relationships.map(relationship => ({ ...relationship }))
      : [],
  }))
}
