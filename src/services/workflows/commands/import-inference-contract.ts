import type { CharacterRosterEntry } from '../../../shared/character-roster'
import { CHARACTER_ROSTER_ROLES } from '../../../shared/character-roster'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import type { NovelConfig } from '../../../shared/ipc-channels'

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
    "name": "唯一非空角色名", "role": "protagonist | antagonist | supporting | minor",
    "gender": "非空文本", "age": "非空文本或有限数字", "appearance": "非空文本",
    "personality": "非空文本", "background": "非空文本", "abilities": "非空文本",
    "motivation": "非空文本", "relationships": [{"target":"同一 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],
    "arc": "非空文本", "notes": "非空文本",
    "currentState": {"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}
  }]
}
characterCards 必须有 3–8 项，name 唯一，至少一个 protagonist；关系不得自指，target 必须在本次 name 集合中。不得省略字段、使用中文枚举或以近义字段替代。`

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
  if (value.length < 3 || value.length > 8) throw new StructuredContractDiagnostic('invalid_value', 'characterCards')
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
  if (names.size !== cards.length) throw new StructuredContractDiagnostic('duplicate_item', 'characterCards')
  if (!cards.some(card => card.role === 'protagonist')) {
    throw new StructuredContractDiagnostic('missing_item', 'characterCards.protagonist')
  }
  for (const [index, card] of cards.entries()) {
    for (const [relationshipIndex, relationship] of card.relationships.entries()) {
      const path = `characterCards[${index}].relationships[${relationshipIndex}].target`
      if (relationship.target === card.name) throw new StructuredContractDiagnostic('relationship_self_reference', path)
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
