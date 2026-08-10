import type { CharacterData, CharacterStateData } from '../../../electron/repositories/character-repository'
import {
  parseArchitectureCharacterRoster,
  parseModelCharacterCards,
  type RawCharacterCard,
} from './character-roster-parser'
import {
  CHARACTER_FIELD_ALIASES,
  RELATIONSHIP_LABEL_ALIASES,
  RELATIONSHIP_TARGET_ALIASES,
} from './character-card-fields'
import {
  normalizeCharacterRole,
  type CharacterRole,
} from '../../shared/character-role'

type RawCard = RawCharacterCard
export type CharacterRelationshipEdge = { target: string; relation: string }

const RELATIONSHIP_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  ...RELATIONSHIP_TARGET_ALIASES,
  ...RELATIONSHIP_LABEL_ALIASES,
])

function readField(card: RawCard, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (card[key] !== undefined && card[key] !== null) return card[key]
  }
  return undefined
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyValue(item))
      .filter(Boolean)
      .join('；')
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => `${key}: ${stringifyValue(entryValue)}`)
      .filter((line) => !line.endsWith(': '))
      .join('；')
  }
  return ''
}

function parseStructuredJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeRole(value: unknown): CharacterRole {
  return normalizeCharacterRole(stringifyValue(value))
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeCurrentState(value: unknown): CharacterStateData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const state = value as RawCard
  return {
    location: stringifyValue(readField(state, ['location', '当前位置', '初始位置', '位置'])),
    powerLevel: stringifyValue(readField(state, ['powerLevel', 'power_level', '能力等级', '境界', '初始境界'])),
    physicalState: stringifyValue(readField(state, ['physicalState', 'physical_state', '身体状态', '初始身体状态'])),
    mentalState: stringifyValue(readField(state, ['mentalState', 'mental_state', '心理状态', '初始心理状态'])),
    keyItems: stringifyValue(readField(state, ['keyItems', 'key_items', '关键道具', '持有道具', '初始持有道具'])),
    recentEvents: stringifyValue(readField(state, ['recentEvents', 'recent_events', '最近事件', '背景事件', '故事开始前的背景事件'])),
    updatedAtChapter: toNumber(readField(state, ['updatedAtChapter', 'updated_at_chapter', '更新章节', '最后更新章节']), 0),
  }
}

function normalizeRelationshipObject(value: RawCard, names: ReadonlySet<string>): CharacterRelationshipEdge | null {
  const target = stringifyValue(readField(value, RELATIONSHIP_TARGET_ALIASES))
  if (!target || !names.has(target)) return null
  const relation = stringifyValue(readField(value, RELATIONSHIP_LABEL_ALIASES)) || '相关'
  return { target, relation }
}

function parseRelationshipJsonText(text: string, names: ReadonlySet<string>): CharacterRelationshipEdge[] | null {
  try {
    const parsed = JSON.parse(text)
    return normalizeCharacterRelationshipEdges(parsed, names)
  } catch {
    return null
  }
}

export function normalizeCharacterRelationshipEdges(
  value: unknown,
  names: ReadonlySet<string>,
  selfName?: string,
): CharacterRelationshipEdge[] {
  const edges: CharacterRelationshipEdge[] = []
  const seen = new Set<string>()

  const addEdge = (edge: CharacterRelationshipEdge | null) => {
    if (!edge || edge.target === selfName) return
    const key = `${edge.target}\u0000${edge.relation}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push(edge)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        for (const edge of normalizeRelationshipText(item, names, selfName)) addEdge(edge)
      } else if (item && typeof item === 'object') {
        addEdge(normalizeRelationshipObject(item as RawCard, names))
      }
    }
    return edges
  }

  if (value && typeof value === 'object') {
    for (const [target, relation] of Object.entries(value as RawCard)) {
      if (names.has(target)) addEdge({ target, relation: stringifyValue(relation) || '相关' })
    }
    return edges
  }

  if (typeof value === 'string') {
    const fromJson = parseRelationshipJsonText(value, names)
    if (fromJson) return fromJson
    return normalizeRelationshipText(value, names, selfName)
  }

  return edges
}

function normalizeRelationshipText(text: string, names: ReadonlySet<string>, selfName?: string): CharacterRelationshipEdge[] {
  const edges: CharacterRelationshipEdge[] = []
  const seen = new Set<string>()
  const lines = text.split(/[,;，；\n]/).map((line) => line.trim()).filter(Boolean)

  for (const line of lines) {
    const explicit = line.match(/^(.+?)[：:—-]\s*(.+)$/)
    if (explicit) {
      const target = explicit[1].trim()
      const relation = explicit[2].trim()
      if (target !== selfName && names.has(target)) {
        const key = `${target}\u0000${relation}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push({ target, relation })
        }
      }
      continue
    }

    for (const target of names) {
      if (target === selfName || !line.includes(target)) continue
      const key = `${target}\u0000${line}`
      if (!seen.has(key)) {
        seen.add(key)
        edges.push({ target, relation: line })
      }
    }
  }

  return edges
}

function normalizeRelationships(value: unknown, names: Set<string>, selfName: string): string {
  const edges = normalizeCharacterRelationshipEdges(value, names, selfName)
  if (edges.length > 0) return JSON.stringify(edges)
  return stringifyValue(value)
}

export function normalizeCharacterCardsForPersistence(rawCards: RawCard[]): CharacterData[] {
  const rawWithNames = rawCards
    .map((card) => ({
      card,
      name: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.name)),
    }))
    .filter((item) => item.name)

  const names = new Set(rawWithNames.map((item) => item.name))

  return rawWithNames.map(({ card, name }) => ({
    name,
    role: normalizeRole(readField(card, CHARACTER_FIELD_ALIASES.role)),
    gender: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.gender)),
    age: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.age)),
    appearance: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.appearance)),
    personality: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.personality)),
    background: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.background)),
    abilities: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.abilities)),
    motivation: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.motivation)),
    relationships: normalizeRelationships(readField(card, CHARACTER_FIELD_ALIASES.relationships), names, name),
    arc: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.arc)),
    notes: stringifyValue(readField(card, CHARACTER_FIELD_ALIASES.notes)),
    currentState: normalizeCurrentState(readField(card, CHARACTER_FIELD_ALIASES.currentState)),
  }))
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function readMeaningfulField(card: RawCard, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (hasMeaningfulValue(card[key])) return card[key]
  }
  return undefined
}

function canonicalizeRawCard(card: RawCard): RawCard {
  const canonical: RawCard = {}
  for (const [field, keys] of Object.entries(CHARACTER_FIELD_ALIASES)) {
    const value = readMeaningfulField(card, keys)
    if (value !== undefined) canonical[field] = value
  }
  return canonical
}

function characterName(card: RawCard): string {
  return stringifyValue(readMeaningfulField(card, CHARACTER_FIELD_ALIASES.name))
}

function characterKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

/**
 * The architecture is the identity source of truth. A model card may enrich
 * it, but must not replace an explicit architecture role or remove a source
 * character because the local model stopped early.
 */
function mergeRawCharacterCards(source: RawCard, model: RawCard): RawCard {
  const merged = { ...canonicalizeRawCard(source) }
  const modelCard = canonicalizeRawCard(model)

  for (const field of Object.keys(CHARACTER_FIELD_ALIASES)) {
    if (field === 'name') continue
    if (field === 'role' && hasMeaningfulValue(merged.role)) continue
    if (hasMeaningfulValue(modelCard[field])) merged[field] = modelCard[field]
  }

  merged.name = characterName(source) || characterName(model)
  return merged
}

function deduplicateRawCards(cards: readonly RawCard[]): RawCard[] {
  const cardsByName = new Map<string, RawCard>()
  for (const card of cards) {
    const normalized = canonicalizeRawCard(card)
    const name = characterName(normalized)
    if (!name) continue
    const key = characterKey(name)
    const existing = cardsByName.get(key)
    cardsByName.set(key, existing ? mergeRawCharacterCards(existing, normalized) : normalized)
  }
  return [...cardsByName.values()]
}

function mergeModelAndSourceCards(
  modelCards: readonly RawCard[],
  sourceCards: readonly RawCard[],
  includeModelOnly = true,
): RawCard[] {
  const modelByName = new Map(
    deduplicateRawCards(modelCards).map(card => [characterKey(characterName(card)), card]),
  )
  const merged: RawCard[] = []
  const sourceKeys = new Set<string>()

  for (const source of deduplicateRawCards(sourceCards)) {
    const key = characterKey(characterName(source))
    sourceKeys.add(key)
    const model = modelByName.get(key)
    merged.push(model ? mergeRawCharacterCards(source, model) : source)
  }

  if (includeModelOnly) {
    for (const model of deduplicateRawCards(modelCards)) {
      if (!sourceKeys.has(characterKey(characterName(model)))) merged.push(model)
    }
  }
  return deduplicateRawCards(merged)
}

function assertModelCardsMatchSource(modelCards: readonly RawCard[], sourceCards: readonly RawCard[]): void {
  const sourceKeys = new Set(deduplicateRawCards(sourceCards).map(card => characterKey(characterName(card))))
  for (const model of deduplicateRawCards(modelCards)) {
    const name = characterName(model)
    if (name && !sourceKeys.has(characterKey(name))) {
      throw new Error(`模型角色「${name}」不在角色图谱完整清单中，未写入角色列表`)
    }
  }
}

function explicitRelationshipTargets(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => explicitRelationshipTargets(item))
  if (typeof value === 'string') {
    const parsed = parseStructuredJson(value)
    return parsed === null ? [] : explicitRelationshipTargets(parsed)
  }
  if (!value || typeof value !== 'object') return []

  const relationship = value as RawCard
  const target = stringifyValue(readMeaningfulField(relationship, RELATIONSHIP_TARGET_ALIASES))
  if (target) return [target]

  return Object.keys(relationship).filter(key => !RELATIONSHIP_DESCRIPTOR_KEYS.has(key))
}

function structuredRelationshipTargets(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const targets = value.flatMap(item => structuredRelationshipTargets(item) ?? [])
    return targets.length > 0 ? targets : null
  }
  if (!value || typeof value !== 'object') return null

  const relationship = value as RawCard
  const target = stringifyValue(readMeaningfulField(relationship, RELATIONSHIP_TARGET_ALIASES))
  if (target) return [target]

  const targets = Object.keys(relationship).filter(key => !RELATIONSHIP_DESCRIPTOR_KEYS.has(key))
  return targets.length > 0 ? targets : null
}

function assertCompleteCharacterCards(
  cards: readonly CharacterData[],
  sourceCards: readonly RawCard[],
  mergedRawCards: readonly RawCard[],
): void {
  const names = new Set(cards.map(card => characterKey(card.name)))
  if (names.size !== cards.length) {
    throw new Error('角色卡包含重复角色名，未写入角色列表')
  }

  for (const source of sourceCards) {
    const sourceName = characterName(source)
    if (!sourceName || !names.has(characterKey(sourceName))) {
      throw new Error(`角色图谱中的「${sourceName || '未命名角色'}」未被补齐，未写入角色列表`)
    }
    const sourceRole = readMeaningfulField(source, CHARACTER_FIELD_ALIASES.role)
    if (sourceRole === undefined) continue
    const persisted = cards.find(card => characterKey(card.name) === characterKey(sourceName))
    if (!persisted || persisted.role !== normalizeRole(sourceRole)) {
      throw new Error(`角色图谱中的「${sourceName}」角色定位未被保留，未写入角色列表`)
    }
  }

  for (const card of mergedRawCards) {
    const relationships = readMeaningfulField(card, CHARACTER_FIELD_ALIASES.relationships)
    for (const target of explicitRelationshipTargets(relationships)) {
      if (!names.has(characterKey(target))) {
        throw new Error(`角色关系目标「${target}」不在完整角色清单中，未写入角色列表`)
      }
    }
  }

  for (const card of cards) {
    const parsed = parseStructuredJson(card.relationships)
    const targets = parsed === null ? null : structuredRelationshipTargets(parsed)
    if (!targets) continue
    if (targets.some(target => !names.has(characterKey(target)))) {
      throw new Error(`角色「${card.name}」包含无效关系目标，未写入角色列表`)
    }
  }
}

const PERSISTED_TEXT_FIELDS: Array<Exclude<keyof CharacterData, 'name' | 'currentState'>> = [
  'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities',
  'motivation', 'relationships', 'arc', 'notes',
]

function hasManualValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  return Boolean(value)
}

function assertSafeCharacterIdentities(cards: readonly CharacterData[]): void {
  const names = new Set<string>()
  for (const card of cards) {
    const name = typeof card?.name === 'string' ? card.name.trim() : ''
    if (!name || names.has(characterKey(name))) {
      throw new Error('无法安全合并已有角色卡，未写入角色列表')
    }
    names.add(characterKey(name))
  }
}

function mergeCurrentStateManualWins(
  existing: CharacterStateData | undefined,
  generated: CharacterStateData | undefined,
): CharacterStateData | undefined {
  if (!existing && !generated) return undefined
  const merged = { ...(generated ?? {}), ...(existing ?? {}) } as CharacterStateData
  const stateFields: Array<keyof CharacterStateData> = [
    'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents', 'updatedAtChapter',
  ]

  for (const field of stateFields) {
    if (!hasManualValue(existing?.[field]) && generated?.[field] !== undefined) {
      Object.assign(merged, { [field]: generated[field] })
    }
  }
  return merged
}

function mergeExistingCharacterManualWins(existing: CharacterData, generated: CharacterData): CharacterData {
  const merged = { ...existing, name: existing.name.trim() }
  for (const field of PERSISTED_TEXT_FIELDS) {
    if (!hasManualValue(existing[field]) && hasManualValue(generated[field])) {
      Object.assign(merged, { [field]: generated[field] })
    }
  }
  merged.currentState = mergeCurrentStateManualWins(existing.currentState, generated.currentState)
  return merged
}

/**
 * Automatic extraction may enrich a manual card, but never replaces an
 * existing non-empty field or removes a card omitted from the architecture.
 */
export function mergeExtractedCharacterCardsWithExisting(
  generatedCards: readonly CharacterData[],
  existingCards: readonly CharacterData[],
): CharacterData[] {
  assertSafeCharacterIdentities(generatedCards)
  assertSafeCharacterIdentities(existingCards)

  const generatedByName = new Map(
    generatedCards.map(card => [characterKey(card.name), card]),
  )
  const mergedExisting = existingCards.map((existing) => {
    const generated = generatedByName.get(characterKey(existing.name))
    return generated ? mergeExistingCharacterManualWins(existing, generated) : { ...existing }
  })
  const existingNames = new Set(existingCards.map(card => characterKey(card.name)))
  const additions = generatedCards.filter(card => !existingNames.has(characterKey(card.name)))
  return [...mergedExisting, ...additions]
}

/**
 * This is the persistence boundary for automatic extraction. If the source
 * architecture cannot tell us who must exist, a partial model response is not
 * safe to save because `character-save-all` may overwrite matching manual
 * cards.
 */
export function extractCompleteCharacterCards(modelText: string, sourceText: string): CharacterData[] {
  const modelCards = parseModelCharacterCards(modelText)
  const sourceRoster = parseArchitectureCharacterRoster(sourceText)
  if (!sourceRoster.complete) {
    throw new Error('无法从角色图谱中安全识别完整角色清单，未写入角色列表')
  }
  const sourceCards = sourceRoster.cards

  assertModelCardsMatchSource(modelCards, sourceCards)
  const mergedRawCards = mergeModelAndSourceCards(modelCards, sourceCards, false)
  const cards = normalizeCharacterCardsForPersistence(mergedRawCards)
  if (cards.length === 0) {
    throw new Error('未能从 AI 输出或角色图谱中提取到有效角色卡，未写入角色列表')
  }
  assertCompleteCharacterCards(cards, sourceCards, mergedRawCards)
  return cards
}

export function parseCharacterCardsFromModelOrSource(modelText: string, sourceText: string): CharacterData[] {
  const modelCards = parseModelCharacterCards(modelText)
  const sourceCards = parseArchitectureCharacterRoster(sourceText).cards
  return normalizeCharacterCardsForPersistence(mergeModelAndSourceCards(modelCards, sourceCards))
}
