import type { CharacterRosterEntry } from '../../../shared/character-roster'
import { CHARACTER_ROSTER_ROLES } from '../../../shared/character-roster'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import type { NovelConfig } from '../../../shared/ipc-channels'
import type { WritingLanguage } from '../../../shared/writing-language'
import { promptLanguageText } from '../../prompt-language'

type InferredNovelConfig = Omit<NovelConfig, 'totalChapters' | 'wordsPerChapter'>

export interface ImportInferenceResult {
  novelConfig: InferredNovelConfig
  architectureFiles: {
    premise: string
    worldbuilding: string
    synopsis: string
  }
  characterCards: CharacterRosterEntry[]
}

export const MAX_IMPORT_INFERENCE_CHARACTER_CARDS = 8
const PLOT_STRUCTURES = ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'] as const
const NARRATIVE_POVS = ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'] as const
const EDGE_INVISIBLE_WRAPPER_RESIDUE = new Set(['\uFEFF', '\u200B', '\u200C', '\u200D', '\u2060'])

export const IMPORT_INFERENCE_JSON_CONTRACT = `
【不可变导入推演 JSON 合同】
只输出一个直接 JSON 对象（禁止 Markdown 围栏和解释），完整包含：
{
  "novelConfig": {
    "genre": "非空文本", "subGenre": "非空文本", "targetAudience": "非空文本",
    "plotStructure": "three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform",
    "narrativePOV": "third_limited | first_person | third_omniscient | multi_pov",
    "coreOutline": "非空文本", "worldSetting": "非空文本", "goldenFinger": "非空文本",
    "protagonistProfile": "非空文本", "globalGuidance": "非空文本"
  },
  "architectureFiles": {
    "premise": "非空文本", "worldbuilding": "非空文本", "synopsis": "非空文本"
  },
  "characterCards": [{
    "name": "非空角色显示名", "role": "protagonist | antagonist | supporting | minor",
    "gender": "非空文本", "age": "非空文本或有限数字", "appearance": "非空文本",
    "personality": "非空文本", "background": "非空文本", "abilities": "非空文本",
    "motivation": "非空文本", "relationships": [{"target":"同一 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],
    "arc": "非空文本", "notes": "非空文本",
    "currentState": {"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}
  }]
}
characterCards 必须有 3–8 项，至少一个 protagonist；不同人物可以同名，不得按名字合并。name 和关系 target 只是待作者确认的原始称呼，不是角色身份；同名关系保留为待确认提议。唯一名称不得自指，target 必须在本次 name 集合中。不得省略字段、使用中文枚举或以近义字段替代。`

const EN_US_IMPORT_INFERENCE_JSON_CONTRACT = `
[Immutable import-inference JSON contract]
Output one direct JSON object only, with no Markdown fence or explanation. It must contain:
{
  "novelConfig": {
    "genre": "non-empty text", "subGenre": "non-empty text", "targetAudience": "non-empty text",
    "plotStructure": "three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform",
    "narrativePOV": "third_limited | first_person | third_omniscient | multi_pov",
    "coreOutline": "non-empty text", "worldSetting": "non-empty text", "goldenFinger": "non-empty text",
    "protagonistProfile": "non-empty text", "globalGuidance": "non-empty text"
  },
  "architectureFiles": {
    "premise": "non-empty text", "worldbuilding": "non-empty text", "synopsis": "non-empty text"
  },
  "characterCards": [{
    "name": "non-empty character display name", "role": "protagonist | antagonist | supporting | minor",
    "gender": "non-empty text", "age": "non-empty text or finite number", "appearance": "non-empty text",
    "personality": "non-empty text", "background": "non-empty text", "abilities": "non-empty text",
    "motivation": "non-empty text", "relationships": [{"target":"exact name of another character in characterCards","relation":"non-empty relationship text"}],
    "arc": "non-empty text", "notes": "non-empty text",
    "currentState": {"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}
  }]
}
characterCards must contain 3–8 items and at least one protagonist. Different people may share a name; never merge them by name. Names and relationship targets are original labels awaiting author confirmation, not character identities. Preserve ambiguous same-name relationships as proposals. A unique name may not self-reference, and every target must occur in the same name set. Do not omit fields, translate enum values, or substitute synonym field names.`

export function importInferenceJsonContract(writingLanguage: WritingLanguage): string {
  return promptLanguageText(
    writingLanguage,
    IMPORT_INFERENCE_JSON_CONTRACT,
    EN_US_IMPORT_INFERENCE_JSON_CONTRACT,
  )
}

function trimEdgeWrapperResidue(content: string): string {
  let start = 0
  let end = content.length
  while (start < end && (/\s/u.test(content[start]!) || EDGE_INVISIBLE_WRAPPER_RESIDUE.has(content[start]!))) {
    start += 1
  }
  while (end > start && (/\s/u.test(content[end - 1]!) || EDGE_INVISIBLE_WRAPPER_RESIDUE.has(content[end - 1]!))) {
    end -= 1
  }
  return content.slice(start, end)
}

function normalizeImportInferenceJsonContent(content: string): string {
  return extractSingleCompleteJsonObject(trimEdgeWrapperResidue(content))
}

function findCompleteJsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return undefined
    }
  }
  return undefined
}

function extractSingleCompleteJsonObject(source: string): string {
  const candidates: string[] = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const start = source.indexOf('{', searchFrom)
    if (start === -1) break
    const end = findCompleteJsonObjectEnd(source, start)
    if (end === undefined) throw new StructuredContractDiagnostic('invalid_json', '$')

    const candidate = source.slice(start, end + 1)
    try {
      record(JSON.parse(candidate), '$')
    } catch {
      throw new StructuredContractDiagnostic('invalid_json', '$')
    }
    candidates.push(candidate)
    searchFrom = end + 1
  }
  if (candidates.length !== 1) throw new StructuredContractDiagnostic('invalid_json', '$')
  return candidates[0]
}

export function parseImportInferenceJsonObject(content: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(normalizeImportInferenceJsonContent(content))
  } catch {
    throw new StructuredContractDiagnostic('invalid_json', '$')
  }
  return record(parsed, '$')
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StructuredContractDiagnostic('invalid_type', path)
  }
  return value as Record<string, unknown>
}

function required(value: Record<string, unknown>, field: string, path: string): unknown {
  if (!Object.hasOwn(value, field)) throw new StructuredContractDiagnostic('missing_field', `${path}.${field}`)
  return value[field]
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
  const normalized = value.trim()
  if (!normalized) throw new StructuredContractDiagnostic('invalid_value', path)
  return normalized
}

function age(value: unknown, path: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return text(value, path)
}

function currentState(value: unknown, path: string): NonNullable<CharacterRosterEntry['currentState']> {
  const state = record(value, path)
  const updatedAtChapter = required(state, 'updatedAtChapter', path)
  if (!Number.isSafeInteger(updatedAtChapter) || (updatedAtChapter as number) < 0) {
    throw new StructuredContractDiagnostic('invalid_value', `${path}.updatedAtChapter`)
  }
  return {
    location: text(required(state, 'location', path), `${path}.location`),
    powerLevel: text(required(state, 'powerLevel', path), `${path}.powerLevel`),
    physicalState: text(required(state, 'physicalState', path), `${path}.physicalState`),
    mentalState: text(required(state, 'mentalState', path), `${path}.mentalState`),
    keyItems: text(required(state, 'keyItems', path), `${path}.keyItems`),
    recentEvents: text(required(state, 'recentEvents', path), `${path}.recentEvents`),
    updatedAtChapter: updatedAtChapter as number,
  }
}

function decodeCards(value: unknown): CharacterRosterEntry[] {
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', 'characterCards')
  if (value.length < 3 || value.length > MAX_IMPORT_INFERENCE_CHARACTER_CARDS) throw new StructuredContractDiagnostic('invalid_value', 'characterCards')
  const cards = value.map((raw, index): CharacterRosterEntry => {
    const path = `characterCards[${index}]`
    const card = record(raw, path)
    const name = text(required(card, 'name', path), `${path}.name`)
    const role = required(card, 'role', path)
    if (typeof role !== 'string' || !(CHARACTER_ROSTER_ROLES as readonly string[]).includes(role)) {
      throw new StructuredContractDiagnostic('invalid_value', `${path}.role`)
    }
    const rawRelationships = required(card, 'relationships', path)
    if (!Array.isArray(rawRelationships)) throw new StructuredContractDiagnostic('invalid_type', `${path}.relationships`)
    const relationships = rawRelationships.map((rawRelationship, relationshipIndex) => {
      const relationshipPath = `${path}.relationships[${relationshipIndex}]`
      const relationship = record(rawRelationship, relationshipPath)
      return {
        target: text(required(relationship, 'target', relationshipPath), `${relationshipPath}.target`),
        relation: text(required(relationship, 'relation', relationshipPath), `${relationshipPath}.relation`),
      }
    })
    return {
      name,
      role: role as CharacterRosterEntry['role'],
      gender: text(required(card, 'gender', path), `${path}.gender`),
      age: age(required(card, 'age', path), `${path}.age`),
      appearance: text(required(card, 'appearance', path), `${path}.appearance`),
      personality: text(required(card, 'personality', path), `${path}.personality`),
      background: text(required(card, 'background', path), `${path}.background`),
      abilities: text(required(card, 'abilities', path), `${path}.abilities`),
      motivation: text(required(card, 'motivation', path), `${path}.motivation`),
      relationships,
      arc: text(required(card, 'arc', path), `${path}.arc`),
      notes: text(required(card, 'notes', path), `${path}.notes`),
      currentState: currentState(required(card, 'currentState', path), `${path}.currentState`),
    }
  })
  const names = new Set(cards.map(card => card.name))
  if (!cards.some(card => card.role === 'protagonist')) {
    throw new StructuredContractDiagnostic('missing_item', 'characterCards.protagonist')
  }
  for (const [index, card] of cards.entries()) {
    for (const [relationshipIndex, relationship] of card.relationships.entries()) {
      const path = `characterCards[${index}].relationships[${relationshipIndex}].target`
      // An occurrence is a candidate, not a name-keyed identity. A shared label
      // may refer to another occurrence and must reach the approval boundary intact.
      if (relationship.target === card.name && cards.filter(candidate => candidate.name === card.name).length === 1) {
        throw new StructuredContractDiagnostic('relationship_self_reference', path)
      }
      if (!names.has(relationship.target)) {
        throw new StructuredContractDiagnostic('relationship_endpoint_not_in_characters', path)
      }
    }
  }
  return cards
}

export function decodeImportInferenceJson(content: string): ImportInferenceResult {
  const root = parseImportInferenceJsonObject(content)
  const config = record(required(root, 'novelConfig', '$'), 'novelConfig')
  const architecture = record(required(root, 'architectureFiles', '$'), 'architectureFiles')
  const plotStructure = required(config, 'plotStructure', 'novelConfig')
  if (typeof plotStructure !== 'string' || !(PLOT_STRUCTURES as readonly string[]).includes(plotStructure)) {
    throw new StructuredContractDiagnostic('invalid_value', 'novelConfig.plotStructure')
  }
  const narrativePOV = required(config, 'narrativePOV', 'novelConfig')
  if (typeof narrativePOV !== 'string' || !(NARRATIVE_POVS as readonly string[]).includes(narrativePOV)) {
    throw new StructuredContractDiagnostic('invalid_value', 'novelConfig.narrativePOV')
  }
  return {
    novelConfig: {
      genre: text(required(config, 'genre', 'novelConfig'), 'novelConfig.genre'),
      subGenre: text(required(config, 'subGenre', 'novelConfig'), 'novelConfig.subGenre'),
      targetAudience: text(required(config, 'targetAudience', 'novelConfig'), 'novelConfig.targetAudience'),
      plotStructure: plotStructure as InferredNovelConfig['plotStructure'],
      narrativePOV: narrativePOV as InferredNovelConfig['narrativePOV'],
      coreOutline: text(required(config, 'coreOutline', 'novelConfig'), 'novelConfig.coreOutline'),
      worldSetting: text(required(config, 'worldSetting', 'novelConfig'), 'novelConfig.worldSetting'),
      goldenFinger: text(required(config, 'goldenFinger', 'novelConfig'), 'novelConfig.goldenFinger'),
      protagonistProfile: text(required(config, 'protagonistProfile', 'novelConfig'), 'novelConfig.protagonistProfile'),
      globalGuidance: text(required(config, 'globalGuidance', 'novelConfig'), 'novelConfig.globalGuidance'),
    },
    architectureFiles: {
      premise: text(required(architecture, 'premise', 'architectureFiles'), 'architectureFiles.premise'),
      worldbuilding: text(required(architecture, 'worldbuilding', 'architectureFiles'), 'architectureFiles.worldbuilding'),
      synopsis: text(required(architecture, 'synopsis', 'architectureFiles'), 'architectureFiles.synopsis'),
    },
    characterCards: decodeCards(required(root, 'characterCards', '$')),
  }
}

type UiText = (zhCNText: string, enUSText: string) => string

const IMPORT_ENDPOINT_DELTA_CARD_KEYS = [
  'abilities',
  'age',
  'appearance',
  'arc',
  'background',
  'currentState',
  'gender',
  'motivation',
  'name',
  'notes',
  'personality',
  'relationships',
  'role',
] as const
const IMPORT_ENDPOINT_DELTA_CURRENT_STATE_KEYS = [
  'keyItems',
  'location',
  'mentalState',
  'physicalState',
  'powerLevel',
  'recentEvents',
  'updatedAtChapter',
] as const
const IMPORT_ENDPOINT_DELTA_RELATIONSHIP_KEYS = ['relation', 'target'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function importInferenceCards(root: Record<string, unknown>, text: UiText): Array<Record<string, unknown>> {
  const cards = root.characterCards
  if (!Array.isArray(cards) || !cards.every(isRecord)) {
    throw new Error(text(
      '导入推演受限补卡校正缺少可比较的原始角色卡',
      'The bounded import correction is missing comparable original character cards.',
    ))
  }
  return cards
}

function assertExactImportEndpointDeltaKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
  text: UiText,
): void {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  if (actualKeys.length !== sortedExpectedKeys.length || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error(text(
      `导入推演受限补卡校正 delta ${path} 包含缺失或额外字段`,
      `The bounded import correction delta at ${path} has missing or extra fields.`,
    ))
  }
}

/** 与解码器一致：名字和关系对象按去掉首尾空白后的文本比较。 */
function decodedLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function unresolvedImportRelationshipTargets(root: Record<string, unknown>, text: UiText): string[] {
  const cards = importInferenceCards(root, text)
  const names = new Set(cards.map(card => decodedLabel(card.name)))
  const references = new Map<string, number>()
  for (const card of cards) {
    const relationships = card.relationships
    if (!Array.isArray(relationships)) continue
    for (const relationship of relationships) {
      const target = isRecord(relationship) ? decodedLabel(relationship.target) : undefined
      if (target !== undefined && !names.has(target)) references.set(target, (references.get(target) ?? 0) + 1)
    }
  }
  return [...references.keys()].sort((a, b) => references.get(b)! - references.get(a)!)
}

/** 补卡只请求能放进角色卡上限的端点，被引用多的优先；其余端点的关系在解码时丢弃。 */
export function importEndpointRecoveryTargets(original: string, text: UiText): string[] {
  const root = parseImportInferenceJsonObject(original)
  const room = MAX_IMPORT_INFERENCE_CHARACTER_CARDS - importInferenceCards(root, text).length
  return unresolvedImportRelationshipTargets(root, text).slice(0, Math.max(0, room))
}

function parseImportEndpointCorrectionDelta(
  content: string,
  unresolvedTargets: readonly string[],
  text: UiText,
): Array<Record<string, unknown>> {
  const deltaRoot = parseImportInferenceJsonObject(content)
  assertExactImportEndpointDeltaKeys(deltaRoot, ['characterCards'], '$', text)
  const deltaCards = importInferenceCards(deltaRoot, text)
  if (deltaCards.length !== unresolvedTargets.length) {
    throw new Error(text(
      '导入推演受限补卡校正只能新增缺失关系端点角色',
      'The bounded import correction may add only characters required by missing relationship endpoints.',
    ))
  }
  for (const [index, deltaCard] of deltaCards.entries()) {
    const path = `characterCards[${index}]`
    assertExactImportEndpointDeltaKeys(deltaCard, IMPORT_ENDPOINT_DELTA_CARD_KEYS, path, text)
    if (isRecord(deltaCard.currentState)) {
      assertExactImportEndpointDeltaKeys(
        deltaCard.currentState,
        IMPORT_ENDPOINT_DELTA_CURRENT_STATE_KEYS,
        `${path}.currentState`,
        text,
      )
    }
    const relationships = deltaCard.relationships
    if (Array.isArray(relationships)) {
      relationships.forEach((relationship, relationshipIndex) => {
        if (isRecord(relationship)) {
          assertExactImportEndpointDeltaKeys(
            relationship,
            IMPORT_ENDPOINT_DELTA_RELATIONSHIP_KEYS,
            `${path}.relationships[${relationshipIndex}]`,
            text,
          )
        }
      })
    }
  }
  const expectedAddedNames = new Set(unresolvedTargets)
  const addedNames = deltaCards.map(card => decodedLabel(card.name))
  if (addedNames.some(name => name === undefined || !expectedAddedNames.has(name))) {
    throw new Error(text(
      '导入推演受限补卡校正新增角色必须精确匹配原始未闭合关系端点',
      'Characters added by the bounded import correction must exactly match the original unresolved endpoints.',
    ))
  }
  if (new Set(addedNames).size !== addedNames.length) {
    throw new Error(text(
      '导入推演受限补卡校正 delta 包含重复缺失关系端点角色',
      'The bounded import correction delta contains duplicate missing-endpoint characters.',
    ))
  }
  if (addedNames.length !== expectedAddedNames.size) {
    throw new Error(text(
      '导入推演受限补卡校正 delta 缺失关系端点角色',
      'The bounded import correction delta omits a missing-endpoint character.',
    ))
  }
  return deltaCards
}

export interface DroppedImportRelationship {
  source: string
  target: string
  relation: string
}

export interface RecoveredImportInference {
  result: ImportInferenceResult
  droppedRelationships: DroppedImportRelationship[]
}

function decodeWithoutDanglingRelationships(
  root: Record<string, unknown>,
  cards: Array<Record<string, unknown>>,
): RecoveredImportInference {
  const names = new Set(cards.map(card => decodedLabel(card.name)))
  const droppedRelationships: DroppedImportRelationship[] = []
  const characterCards = cards.map((card) => {
    if (!Array.isArray(card.relationships)) return card
    const relationships = card.relationships.filter((relationship) => {
      if (!isRecord(relationship)) return true
      const target = decodedLabel(relationship.target)
      const relation = decodedLabel(relationship.relation)
      // 字段不合格的关系留给解码器拒绝，不能借丢弃把坏补卡洗成合格。
      if (target === undefined || relation === undefined || names.has(target)) return true
      droppedRelationships.push({
        source: String(card.name).trim(),
        target,
        relation,
      })
      return false
    })
    return { ...card, relationships }
  })
  return {
    result: decodeImportInferenceJson(JSON.stringify({ ...root, characterCards })),
    droppedRelationships,
  }
}

/**
 * 渲染端提交与主进程从产物重算角色卡都走这里，两边结果必须一致，作者审批才拿得到来源。
 * delta 是补卡请求的输出；没发补卡请求时为 null。补卡输出不合格时不采用任何补卡。
 */
export function decodeRecoveredImportInference(original: string, delta: string | null, text: UiText): RecoveredImportInference {
  try {
    return { result: decodeImportInferenceJson(original), droppedRelationships: [] }
  } catch (error) {
    if (!(error instanceof StructuredContractDiagnostic) || error.code !== 'relationship_endpoint_not_in_characters') throw error
  }
  const root = parseImportInferenceJsonObject(original)
  const cards = importInferenceCards(root, text)
  if (delta !== null) {
    try {
      const added = parseImportEndpointCorrectionDelta(delta, importEndpointRecoveryTargets(original, text), text)
      return decodeWithoutDanglingRelationships(root, [...cards, ...added])
    } catch {
      // 不合格的补卡整份不用，下面只丢悬空关系。
    }
  }
  return decodeWithoutDanglingRelationships(root, cards)
}
