import type { PlanningMaterial } from '../../knowledge-service'
import { ipc } from '../../ipc-client'
import { characterRosterEntriesFromCards } from '../../character-roster-client'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { CHARACTER_ROLES, CHARACTER_ROLE_LABELS } from '../../../shared/character-role'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { promptLanguageText } from '../../prompt-language'
import {
  normalizeCharacterRelationshipEdges,
  parseCharacterCardsFromModelOrSource,
} from '../character-card-normalizer'
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
  const names = new Set(cards.flatMap(card => (
    typeof card.name === 'string' && card.name.trim() ? [card.name.trim()] : []
  )))
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
    merged.relationships = normalizeCharacterRelationshipEdges([
      ...(Array.isArray(existing.relationships) ? existing.relationships : []),
      ...(Array.isArray(card.relationships) ? card.relationships : []),
    ], names, name)
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

function parseExtraction(content: string): MaterialExtraction[] {
  const trimmed = content.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  const root = JSON.parse(fenced?.[1]?.trim() ?? trimmed) as unknown
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  const rootRecord = root as Record<string, unknown>
  if (Object.keys(rootRecord).some(key => key !== 'results')) {
    throw new StructuredContractDiagnostic('unexpected_item', '$')
  }
  if (!Array.isArray(rootRecord.results)) {
    throw new StructuredContractDiagnostic(
      Object.hasOwn(rootRecord, 'results') ? 'invalid_type' : 'missing_field',
      '$.results',
    )
  }
  const resultKeys = new Set(['sourceId', 'characterCards'])
  const cardKeys = new Set([
    'name', 'role', ...MATERIAL_CHARACTER_TEXT_FIELDS, 'relationships',
  ])
  const requireNonEmptyText = (value: unknown, path: string): string => {
    if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
    if (!value.trim()) throw new StructuredContractDiagnostic('empty_value', path)
    return value
  }
  return rootRecord.results.map((candidate, resultIndex) => {
    const resultPath = `$.results[${resultIndex}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new StructuredContractDiagnostic('invalid_type', resultPath)
    }
    const value = candidate as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (!resultKeys.has(key)) throw new StructuredContractDiagnostic('unexpected_item', `${resultPath}.${key}`)
    }
    const sourceId = requireNonEmptyText(value.sourceId, `${resultPath}.sourceId`)
    if (!Array.isArray(value.characterCards)) {
      throw new StructuredContractDiagnostic(
        Object.hasOwn(value, 'characterCards') ? 'invalid_type' : 'missing_field',
        `${resultPath}.characterCards`,
      )
    }
    const characterCards = value.characterCards.map((card, cardIndex) => {
      const cardPath = `${resultPath}.characterCards[${cardIndex}]`
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new StructuredContractDiagnostic('invalid_type', cardPath)
      }
      const cardValue = card as Record<string, unknown>
      for (const key of Object.keys(cardValue)) {
        if (!cardKeys.has(key)) throw new StructuredContractDiagnostic('unexpected_item', `${cardPath}.${key}`)
      }
      requireNonEmptyText(cardValue.name, `${cardPath}.name`)
      requireNonEmptyText(cardValue.role, `${cardPath}.role`)
      for (const field of MATERIAL_CHARACTER_TEXT_FIELDS) {
        if (Object.hasOwn(cardValue, field)) requireNonEmptyText(cardValue[field], `${cardPath}.${field}`)
      }
      if (Object.hasOwn(cardValue, 'relationships')) {
        if (!Array.isArray(cardValue.relationships)) {
          throw new StructuredContractDiagnostic('invalid_type', `${cardPath}.relationships`)
        }
        for (const [relationshipIndex, relationship] of cardValue.relationships.entries()) {
          const relationshipPath = `${cardPath}.relationships[${relationshipIndex}]`
          if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) {
            throw new StructuredContractDiagnostic('invalid_type', relationshipPath)
          }
          const relationshipValue = relationship as Record<string, unknown>
          if (Object.keys(relationshipValue).some(key => key !== 'target' && key !== 'relation')) {
            throw new StructuredContractDiagnostic('unexpected_item', relationshipPath)
          }
          requireNonEmptyText(relationshipValue.target, `${relationshipPath}.target`)
          requireNonEmptyText(relationshipValue.relation, `${relationshipPath}.relation`)
        }
      }
      return cardValue
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
    ]
    return `### ${index + 1}. ${entry.name}\n${rows.join('\n')}`
  })
  return [
    text(
      `## 待确认角色卡候选（${entries.length}）`,
      `## Character-card candidates awaiting confirmation (${entries.length})`,
    ),
    text(
      '以下候选尚未写入角色名单。请核对后再确认导入；已有作者手工字段会保留。',
      'These candidates have not been saved. Review them before confirming import; existing author-edited fields will be preserved.',
    ),
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
    const cards = parseCharacterCardsFromModelOrSource(JSON.stringify({ characterCards: rawCards }), '')
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

export class CommitPlanningMaterialCharactersCommand extends BaseWorkflowCommand<void> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，角色导入已停止', 'The project changed, so character import stopped.'))

    this.assertNotCancelled(context)
    const entries = context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] as CharacterRosterEntry[] | undefined
    if (!entries) throw new Error(text(
      '缺少已预览的角色卡候选，未写入角色名单',
      'No reviewed character-card candidates are available; the character roster was not changed.',
    ))
    if (entries.length === 0) {
      callbacks.setProgress(100)
      callbacks.log(text('没有待导入的角色卡', 'There are no character cards to import.'))
      return
    }

    const roster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      projectSession.projectPath,
    )
    if (roster.status !== 'ready' && roster.status !== 'empty') {
      throw new Error(text(
        '角色名单当前不可安全导入，请先修复旧角色数据',
        'The character roster cannot be imported safely until legacy character data is repaired.',
      ))
    }
    this.assertNotCancelled(context)
    const commit = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: `planning-material-${context.runId}`,
        expectedRevision: roster.revision,
        schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
        entries,
        intent: 'novel_import',
      } satisfies CharacterRosterCommitRequest,
      projectSession.projectPath,
    )
    if (!commit.success) throw new Error(commit.error || text(
      '角色卡未能保存',
      'The extracted character cards could not be saved.',
    ))

    callbacks.setProgress(100)
    callbacks.log(text(
      `已确认并合并 ${entries.length} 张角色卡，作者手工字段保持不变`,
      `Confirmed and merged ${entries.length} character cards; author-edited fields were preserved.`,
    ))
    this.notifyRefresh(['characterCards'], projectSession.projectPath, projectSession)
  }
}
