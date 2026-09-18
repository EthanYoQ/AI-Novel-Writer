import { CHARACTER_ROSTER_ROLES, type CharacterRosterEntry } from './character-roster'
import { stripDraftThinkingTags as stripThinkingTags } from './draft-visible-text'
import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
import { CHARACTER_ROLES } from './character-role'
import type { CharacterProposalItem } from './character-proposal'

export interface CharacterProposalArtifact { artifactId: string; text: string }
type ParsedProposal = Omit<CharacterProposalItem, 'resolution'>

function uniqueKeys(keys: readonly string[]): void {
  if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length) throw new Error('CHARACTER_PROPOSAL_KEYS_INVALID')
}

/** The caller proves ledger ownership/currentness. This parser proves source-local coverage only. */
export function parseArchitectureCharacterProposal(input: {
  manifest: CharacterProposalArtifact; details: readonly CharacterProposalArtifact[]
}): ParsedProposal[] {
  uniqueKeys([input.manifest.artifactId, ...input.details.map(item => item.artifactId)])
  const slots = decodeCharacterIdentityManifest(input.manifest.text)
  const byId = new Map(slots.map(slot => [slot.slotId, slot]))
  const records = input.details.flatMap(artifact => {
    const root = JSON.parse(extractSingleCompleteJsonObject(artifact.text)) as Record<string, unknown>
    if (Object.keys(root).some(key => key !== 'entries')) throw new Error('CHARACTER_PROPOSAL_ENVELOPE_INVALID')
    const decoded = decodeCharacterDetails(artifact.text)
    if (!decoded.length) throw new Error('CHARACTER_PROPOSAL_EMPTY_DETAILS')
    return decoded.map((entry, index) => {
      const invalid = validateCharacterDetail(entry)
      if (invalid) throw new Error(invalid)
      const slot = byId.get(entry.slotId)
      if (!slot || slot.name !== entry.name || slot.role !== entry.role) throw new Error('CHARACTER_PROPOSAL_SLOT_MISMATCH')
      const raw = (root.entries as unknown[])[index]
      if (!isRecord(raw) || Object.keys(raw).some(key => ![
        'slotId', 'name', 'role', 'gender', 'age', ...CHARACTER_DETAIL_DESCRIPTION_FIELDS, 'currentState',
      ].includes(key))) throw new Error('CHARACTER_PROPOSAL_DETAIL_FIELD_INVALID')
      const fields = { ...entry }; delete fields.relationships
      const { slotId, currentState: _state, ...staticFields } = fields
      void _state
      return { selectionKey: slotId, sourceId: `${artifact.artifactId}:${slotId}`, fields: staticFields,
        relationships: slot.relations.map(relation => ({ targetSelectionKey: relation.targetSlotId, relation: relation.relation })),
        rawValue: { manifest: structuredClone(slot), detail: structuredClone(raw) } }
    })
  })
  uniqueKeys(records.map(record => record.selectionKey))
  if (records.length !== slots.length) throw new Error('CHARACTER_PROPOSAL_COVERAGE_INCOMPLETE')
  return slots.map(slot => records.find(record => record.selectionKey === slot.slotId)!)
}

export function parsePlanningMaterialCharacterProposal(input: {
  artifacts: readonly CharacterProposalArtifact[]; expectedSourceIds: readonly string[]
}): ParsedProposal[] {
  uniqueKeys(input.artifacts.map(artifact => artifact.artifactId))
  uniqueKeys(input.expectedSourceIds)
  const results = input.artifacts.flatMap(artifact => parseMaterialExtraction(artifact.text).map(result => ({ artifact, result })))
  uniqueKeys(results.map(({ result }) => result.sourceId))
  if (results.length !== input.expectedSourceIds.length || results.some(({ result }) => !input.expectedSourceIds.includes(result.sourceId))) {
    throw new Error('CHARACTER_PROPOSAL_COVERAGE_INCOMPLETE')
  }
  return input.expectedSourceIds.flatMap(sourceId => {
    const { result } = results.find(item => item.result.sourceId === sourceId)!
    return result.characterCards.map((card, index) => {
      if (!CHARACTER_ROLES.some(role => role === card.role)) throw new Error('CHARACTER_PROPOSAL_ROLE_INVALID')
      const { relationships, ...fields } = card
      return { selectionKey: `${sourceId}:character:${index + 1}`, sourceId,
        fields: fields as unknown as CharacterProposalItem['fields'], rawValue: structuredClone(card),
        relationships: ((relationships ?? []) as { target: string; relation: string }[])
          .map(relation => ({ targetName: relation.target, relation: relation.relation, raw: structuredClone(relation) })) }
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

export interface CharacterIdentitySlot {
  slotId: string
  name: string
  role: CharacterRosterEntry['role']
  narrativeDuty: string
  relations: Array<{ targetSlotId: string; relation: string }>
}

export interface CharacterDetailOutput extends Omit<CharacterRosterEntry, 'relationships'> {
  slotId: string
  relationships?: unknown
}

const MIN_CHARACTER_SLOTS = 3
const MAX_CHARACTER_SLOTS = 8
export const CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS = 120
export const CHARACTER_STATE_TEXT_MAX_CHARS = 80
export const CHARACTER_DETAIL_DESCRIPTION_FIELDS = [
  'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const
export const CHARACTER_STATE_TEXT_FIELDS = [
  'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents',
] as const

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

export function extractSingleCompleteJsonObject(content: string): string {
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

export function decodeCharacterIdentityManifest(content: string): CharacterIdentitySlot[] {
  const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { slots?: unknown }
  if (!Array.isArray(parsed.slots)) throw new Error('角色身份清单缺少 slots')
  if (Object.keys(parsed).some(key => key !== 'slots')) throw new Error('角色身份清单包含未知字段')
  if (parsed.slots.length < MIN_CHARACTER_SLOTS || parsed.slots.length > MAX_CHARACTER_SLOTS) {
    throw new Error(`角色身份清单必须包含 ${MIN_CHARACTER_SLOTS}–${MAX_CHARACTER_SLOTS} 个角色`)
  }
  const slots = parsed.slots.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`角色身份清单第 ${index + 1} 项无效`)
    if (Object.keys(candidate).some(key => !['slotId', 'name', 'role', 'narrativeDuty', 'relations'].includes(key))) {
      throw new Error(`角色身份清单第 ${index + 1} 项包含未知字段`)
    }
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
          || Object.keys(relation).some(key => key !== 'targetSlotId' && key !== 'relation')
          || targetSlotId === undefined
          || typeof relation.relation !== 'string' || !relation.relation.trim()) {
          throw new Error(`角色身份清单第 ${index + 1} 项关系 ${relationIndex + 1} 无效`)
        }
        return { targetSlotId, relation: relation.relation.trim() }
      }),
    }
  })
  const slotIds = new Set(slots.map(slot => slot.slotId))
  if (slotIds.size !== slots.length) throw new Error('角色身份清单包含重复 slotId')
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

export function normalizeCharacterSlotId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined
}

export function validateCharacterDetail(output: CharacterDetailOutput): string | undefined {
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

export function normalizeDetailStringList(value: unknown, separator: string): unknown {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value) || value.length === 0) return value
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return value
    normalized.push(item.trim())
  }
  return normalized.join(separator)
}

export function normalizeBoundedDetailText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value
  return Array.from(value.trim()).slice(0, maxChars).join('')
}

export interface MaterialExtraction {
  sourceId: string
  characterCards: Array<Record<string, unknown>>
}

const MATERIAL_CHARACTER_TEXT_FIELDS = [
  'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const

export function parseMaterialExtraction(content: string): MaterialExtraction[] {
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


export function decodeCharacterDetails(content: string): CharacterDetailOutput[] {
  const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { entries?: unknown }
  if (!Array.isArray(parsed.entries)) throw new Error('角色详情响应缺少 entries')
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
}

const MATERIAL_CHUNK_CHARACTERS = 12_000
const MATERIAL_CHUNK_BOUNDARY_START = Math.floor(MATERIAL_CHUNK_CHARACTERS * 0.8)
export interface MaterialChunk {
  sourceId: string
  fileName: string
  text: string
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

export function characterProposalMaterialChunks(materials: readonly { fileName: string; text: string }[]): MaterialChunk[] {
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
