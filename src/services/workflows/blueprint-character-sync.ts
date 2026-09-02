import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type {
  CharacterRosterCommitReceipt,
  CharacterRosterEntry,
} from '../../shared/character-roster'
import { ipc } from '../ipc-client'
import {
  normalizeCharacterRelationshipEdges,
  type CharacterRelationshipEdge,
} from './character-card-normalizer'
import { randomUUID } from '../../utils/id'

export interface BlueprintCharacterCandidateSource {
  chapterNumber: number
  characters: readonly string[]
  relationshipHints?: unknown
}

function characterKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasRelationshipHints(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : isRecord(value) && Object.keys(value).length > 0
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

function assertIpcSuccess(result: { success: boolean; error?: string }): void {
  if (!result.success) throw new Error(result.error || '同步蓝图角色候选失败')
}

/**
 * Enriches relationships only for characters that already exist in the
 * authoritative roster. Blueprint references are planning data, not permission
 * to create character cards; unknown names remain in the blueprint until the
 * author explicitly creates or imports them.
 */
export async function syncBlueprintCharacterCandidates(
  blueprints: readonly BlueprintCharacterCandidateSource[],
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
  operationId = `blueprint-sync-${randomUUID()}`,
): Promise<CharacterRosterCommitReceipt | null> {
  if (!blueprints.some(blueprint => hasRelationshipHints(blueprint.relationshipHints))) return null

  const roster = await ipc.invokeWithProjectSession(
    projectSession,
    'db:character-roster-read',
    expectedProjectPath,
  )
  if (roster.status !== 'ready' && roster.status !== 'empty') {
    throw new Error('角色名单当前不可安全同步；请先完成旧项目修复或处理数据不一致状态')
  }
  const existingByKey = new Map(roster.entries.map(character => [characterKey(character.name), character]))
  const canonicalNameByKey = new Map(
    [...existingByKey].map(([key, character]) => [key, character.name] as const),
  )
  const allNames = new Set(canonicalNameByKey.values())
  const resolveName = (name: string): string | undefined => canonicalNameByKey.get(characterKey(name))

  const relationshipGraph = new Map<string, CharacterRelationshipEdge[]>()
  for (const blueprint of blueprints) {
    collectRelationshipHints(blueprint.relationshipHints, allNames, resolveName, relationshipGraph)
  }

  const changedExisting: CharacterRosterEntry[] = []
  for (const [key, existing] of existingByKey) {
    // 旧自由文本关系没有可靠字段级迁移；蓝图同步只能附加到已结构化的
    // 关系列表，绝不为了“补关系”覆盖作者原文。
    if (existing.legacyRelationshipNotes) continue
    const additions = (
      relationshipGraph.get(existing.name)
      ?? relationshipGraph.get(canonicalNameByKey.get(key) ?? '')
      ?? []
    ).filter(edge => !existingByKey.get(characterKey(edge.target))?.legacyRelationshipNotes)
    if (additions.length === 0) continue
    const mergedEdges = mergeRelationshipEdges(existing.relationships, additions)
    if (mergedEdges.length === existing.relationships.length) continue
    changedExisting.push({ ...existing, relationships: mergedEdges })
  }

  if (changedExisting.length === 0) return null
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:character-roster-commit',
    {
      operationId,
      expectedRevision: roster.revision,
      schemaVersion: 1,
      intent: 'blueprint_sync',
      // incremental intents never echo untouched cards back through IPC. This
      // keeps legacy free-text relationship evidence read-only and lets the
      // deep module merge only the changed/new structured entries.
      entries: changedExisting,
    },
    expectedProjectPath,
  )
  assertIpcSuccess(result)
  if (!result.receipt) {
    throw new Error('同步蓝图角色候选未返回已验证的角色名单回执')
  }
  return result.receipt
}
