import type { CharacterData } from '../../../electron/repositories/character-repository'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { ipc } from '../ipc-client'
import {
  normalizeCharacterCardsForPersistence,
  normalizeCharacterRelationshipEdges,
  type CharacterRelationshipEdge,
} from './character-card-normalizer'

export interface BlueprintCharacterCandidateSource {
  chapterNumber: number
  characters: readonly string[]
  relationshipHints?: unknown
}

type CharacterSource = {
  name: string
  chapters: Set<number>
}

function characterKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function addEdge(
  graph: Map<string, CharacterRelationshipEdge[]>,
  source: string,
  target: string,
  relation: string,
): void {
  if (source === target) return
  const edges = graph.get(source) ?? []
  if (!edges.some(edge => edge.target === target && edge.relation === relation)) {
    edges.push({ target, relation })
    graph.set(source, edges)
  }
}

function addBidirectionalEdge(
  graph: Map<string, CharacterRelationshipEdge[]>,
  source: string,
  target: string,
  relation: string,
): void {
  addEdge(graph, source, target, relation)
  addEdge(graph, target, source, relation)
}

function normalizeHintEdge(
  sourceName: string,
  targetValue: unknown,
  relationValue: unknown,
  names: ReadonlySet<string>,
  resolveName: (name: string) => string | undefined,
): CharacterRelationshipEdge | null {
  if (typeof targetValue !== 'string') return null
  const target = resolveName(targetValue)
  if (!target) return null
  const relation = typeof relationValue === 'string' && relationValue.trim()
    ? relationValue.trim()
    : '相关'
  return normalizeCharacterRelationshipEdges([{ target, relation }], names, sourceName)[0] ?? null
}

function collectSourceHints(
  value: unknown,
  sourceName: string,
  names: ReadonlySet<string>,
  resolveName: (name: string) => string | undefined,
  graph: Map<string, CharacterRelationshipEdge[]>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceHints(item, sourceName, names, resolveName, graph)
    return
  }
  if (!isRecord(value)) return

  const target = readString(value, ['target', 'to'])
  if (target) {
    const edge = normalizeHintEdge(sourceName, target, value.relation, names, resolveName)
    if (edge) addBidirectionalEdge(graph, sourceName, edge.target, edge.relation)
    return
  }

  for (const [targetName, relation] of Object.entries(value)) {
    const edge = normalizeHintEdge(sourceName, targetName, relation, names, resolveName)
    if (edge) addBidirectionalEdge(graph, sourceName, edge.target, edge.relation)
  }
}

function collectRelationshipHints(
  hints: unknown,
  names: ReadonlySet<string>,
  resolveName: (name: string) => string | undefined,
  graph: Map<string, CharacterRelationshipEdge[]>,
): void {
  if (Array.isArray(hints)) {
    for (const hint of hints) {
      if (!isRecord(hint)) continue
      const source = resolveName(readString(hint, ['from', 'source']))
      if (!source) continue
      const target = readString(hint, ['target', 'to'])
      const edge = normalizeHintEdge(source, target, hint.relation, names, resolveName)
      if (edge) addBidirectionalEdge(graph, source, edge.target, edge.relation)
    }
    return
  }
  if (!isRecord(hints)) return

  const directSource = resolveName(readString(hints, ['from', 'source']))
  if (directSource) {
    collectSourceHints(hints, directSource, names, resolveName, graph)
    return
  }

  for (const [rawSource, value] of Object.entries(hints)) {
    const source = resolveName(rawSource)
    if (source) collectSourceHints(value, source, names, resolveName, graph)
  }
}

function parseStoredRelationshipEdges(value: string): CharacterRelationshipEdge[] | null {
  const text = value.trim()
  if (!text) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) {
    const edges: CharacterRelationshipEdge[] = []
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.target !== 'string' || !item.target.trim()) return null
      const relation = typeof item.relation === 'string' && item.relation.trim() ? item.relation.trim() : '相关'
      edges.push({ target: item.target.trim(), relation })
    }
    return edges
  }

  if (!isRecord(parsed) || 'target' in parsed || 'relation' in parsed) return null
  return Object.entries(parsed).flatMap(([target, relation]) => {
    if (!target.trim()) return []
    const label = typeof relation === 'string' && relation.trim() ? relation.trim() : '相关'
    return [{ target: target.trim(), relation: label }]
  })
}

function mergeRelationshipEdges(
  existing: readonly CharacterRelationshipEdge[],
  additions: readonly CharacterRelationshipEdge[],
): CharacterRelationshipEdge[] {
  const merged = [...existing]
  for (const addition of additions) {
    if (!merged.some(edge => edge.target === addition.target && edge.relation === addition.relation)) {
      merged.push(addition)
    }
  }
  return merged
}

function formatCandidateSource(chapters: ReadonlySet<number>): string {
  const ordered = [...chapters].sort((left, right) => left - right)
  return `自动候选来源：章节蓝图（第${ordered.join('、')}章）`
}

function assertIpcSuccess(result: { success: boolean; error?: string }): void {
  if (!result.success) throw new Error(result.error || '同步蓝图角色候选失败')
}

/**
 * Syncs only the character names explicitly named in a successfully persisted
 * blueprint batch. It deliberately does not consult the knowledge base or an
 * embedding model: those services improve retrieval, not character identity.
 */
export async function syncBlueprintCharacterCandidates(
  blueprints: readonly BlueprintCharacterCandidateSource[],
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const sourcesByKey = new Map<string, CharacterSource>()
  for (const blueprint of blueprints) {
    for (const rawName of blueprint.characters) {
      if (typeof rawName !== 'string' || !rawName.trim()) continue
      const name = rawName.trim()
      const key = characterKey(name)
      const source = sourcesByKey.get(key) ?? { name, chapters: new Set<number>() }
      source.chapters.add(blueprint.chapterNumber)
      sourcesByKey.set(key, source)
    }
  }
  if (sourcesByKey.size === 0) return

  const existingCharacters = await ipc.invokeWithProjectSession(
    projectSession,
    'db:character-get-all',
    expectedProjectPath,
  )
  const existingByKey = new Map(existingCharacters.map(character => [characterKey(character.name), character]))
  const canonicalNameByKey = new Map([...sourcesByKey].map(([key, source]) => [key, source.name]))
  for (const [key, character] of existingByKey) canonicalNameByKey.set(key, character.name)
  const allNames = new Set(canonicalNameByKey.values())
  const resolveName = (name: string): string | undefined => canonicalNameByKey.get(characterKey(name))

  const relationshipGraph = new Map<string, CharacterRelationshipEdge[]>()
  for (const blueprint of blueprints) {
    collectRelationshipHints(blueprint.relationshipHints, allNames, resolveName, relationshipGraph)
  }

  const rawCandidates = [...sourcesByKey]
    .filter(([key]) => !existingByKey.has(key))
    .map(([, source]) => ({
      name: source.name,
      role: 'supporting',
      notes: formatCandidateSource(source.chapters),
    }))
  const candidates = normalizeCharacterCardsForPersistence(rawCandidates).map(candidate => ({
    ...candidate,
    relationships: JSON.stringify(relationshipGraph.get(candidate.name) ?? []),
  }))

  const changedExisting: CharacterData[] = []
  for (const [key, existing] of existingByKey) {
    const additions = relationshipGraph.get(existing.name) ?? relationshipGraph.get(canonicalNameByKey.get(key) ?? '') ?? []
    if (additions.length === 0) continue
    const currentEdges = parseStoredRelationshipEdges(existing.relationships)
    if (currentEdges === null) continue
    const mergedEdges = mergeRelationshipEdges(currentEdges, additions)
    if (mergedEdges.length === currentEdges.length) continue
    changedExisting.push({ ...existing, relationships: JSON.stringify(mergedEdges) })
  }

  for (const character of [...changedExisting, ...candidates]) {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-upsert',
      character,
      expectedProjectPath,
    )
    assertIpcSuccess(result)
  }
}
