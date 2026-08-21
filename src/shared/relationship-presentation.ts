import type { Locale } from '../i18n/types'

export interface RelationshipEdge {
  target: string
  relation: string
}

export interface RelationshipTextOptions {
  knownNames?: readonly string[]
  selfName?: string
  previousStorage?: string
}

export interface RelationshipEditorPresentationOptions {
  locale?: Locale
}

type UnknownRecord = Record<string, unknown>

const UNKNOWN_JSON_RELATIONSHIP_GUIDANCE: Record<Locale, string> = {
  'zh-CN': '关系数据格式无法识别。请按“角色：关系”逐行重写。',
  'en-US': 'Relationship data format is unrecognized. Rewrite one relationship per line as “Character: relationship”.',
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function relationshipEdgeFromRecord(value: UnknownRecord): RelationshipEdge | null {
  const target = textValue(value.target) ?? textValue(value.name)
  const relation = textValue(value.relation) ?? textValue(value.label)
  return target && relation ? { target, relation } : null
}

/**
 * Accepts the structured relationship shapes already persisted by legacy
 * projects. Returning null distinguishes unstructured user notes from an
 * intentionally empty structured relationship list.
 */
function parseStructuredRelationships(value: string): RelationshipEdge[] | null {
  const text = value.trim()
  if (!text) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) {
    const relationships = parsed.map((item) => (
      isRecord(item) ? relationshipEdgeFromRecord(item) : null
    ))
    return relationships.every((relationship): relationship is RelationshipEdge => relationship !== null)
      ? relationships
      : null
  }

  if (!isRecord(parsed)) return null

  const singleRelationship = relationshipEdgeFromRecord(parsed)
  if (singleRelationship) return [singleRelationship]

  return null
}

function isJsonValue(value: string): boolean {
  try {
    JSON.parse(value.trim())
    return true
  } catch {
    return false
  }
}

function formatRelationForEditor(relation: string): string {
  const fields = relation
    .split(/[；;]/)
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => {
      const match = field.match(/^([^：:]+)[：:]\s*(.+)$/)
      return match
        ? { key: match[1].trim(), value: match[2].trim() }
        : null
    })

  const relationTypeIndex = fields.findIndex((field) => (
    field?.key === '关系类型' || field?.key === '关系'
  ))
  if (relationTypeIndex < 0) return relation

  const relationType = fields[relationTypeIndex]
  if (!relationType) return relation

  const details = fields
    .filter((field, index) => field && index !== relationTypeIndex)
    .map((field) => (
      field?.key === '矛盾张力'
        ? field.value
        : `${field?.key}：${field?.value}`
    ))

  return details.length > 0
    ? `${relationType.value}（${details.join('；')}）`
    : relationType.value
}

function formatRelationshipEdgeForEditor(edge: RelationshipEdge): string {
  return `${edge.target}：${formatRelationForEditor(edge.relation)}`
}

function knownNameSet(options: RelationshipTextOptions): Set<string> | null {
  if (!options.knownNames || options.knownNames.length === 0) return null
  return new Set(options.knownNames.map((name) => name.trim()).filter(Boolean))
}

function isAllowedEdge(edge: RelationshipEdge, options: RelationshipTextOptions): boolean {
  if (options.selfName && edge.target === options.selfName) return false
  const names = knownNameSet(options)
  return !names || names.has(edge.target)
}

function deduplicateEdges(edges: readonly RelationshipEdge[]): RelationshipEdge[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.target}\u0000${edge.relation}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseTextRelationships(value: string): RelationshipEdge[] {
  const edges: RelationshipEdge[] = []
  const lines = value.split(/[\n,，;；]/)

  for (const line of lines) {
    const match = line.trim().match(/^(.+?)[：:—-]\s*(.+)$/)
    if (!match) continue
    const target = match[1].trim()
    const relation = match[2].trim()
    if (target && relation) edges.push({ target, relation })
  }

  return edges
}

function parseEditorLines(value: string, options: RelationshipTextOptions): RelationshipEdge[] | null {
  const names = knownNameSet(options)
  if (!names) return null

  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return []

  const edges = lines.map((line) => {
    const match = line.match(/^(.+?)[：:]\s*(.+)$/)
    if (!match) return null
    const target = match[1].trim()
    const relation = match[2].trim()
    if (!target || !relation || target === options.selfName || !names.has(target)) return null
    return { target, relation }
  })

  return edges.every((edge): edge is RelationshipEdge => edge !== null)
    ? edges
    : null
}

function preserveUnchangedLegacyRelations(
  edges: readonly RelationshipEdge[],
  previousStorage: string | undefined,
): RelationshipEdge[] {
  if (!previousStorage) return [...edges]
  const previousEdges = parseStructuredRelationships(previousStorage)
  if (!previousEdges) return [...edges]

  return edges.map((edge) => {
    const unchanged = previousEdges.find((previous) => (
      previous.target === edge.target
      && formatRelationForEditor(previous.relation) === edge.relation
    ))
    return unchanged ?? edge
  })
}

/**
 * Formats structured persistence data for the character editor. Free-form
 * notes deliberately stay untouched; syntactically valid but unrecognized JSON
 * receives repair guidance instead of exposing storage syntax to the user.
 */
export function formatRelationshipsForEditor(
  value: string,
  options: RelationshipEditorPresentationOptions = {},
): string {
  const relationships = parseStructuredRelationships(value)
  if (relationships === null) {
    return isJsonValue(value)
      ? UNKNOWN_JSON_RELATIONSHIP_GUIDANCE[options.locale ?? 'zh-CN']
      : value
  }
  return relationships.map(formatRelationshipEdgeForEditor).join('\n')
}

/**
 * Converts an editor value to the canonical graph-readable JSON only when every
 * non-empty line is an unambiguous relation to a known character. Otherwise it
 * retains the original text, which the roster seam preserves as legacy notes.
 */
export function relationshipStorageFromEditor(
  value: string,
  options: RelationshipTextOptions,
): string {
  if (!value.trim()) return ''
  if (parseStructuredRelationships(value) !== null) return value

  const edges = parseEditorLines(value, options)
  if (edges === null) return value
  return JSON.stringify(preserveUnchangedLegacyRelations(edges, options.previousStorage))
}

/**
 * Shared graph/parser seam for persisted JSON and existing plain-text notes.
 * Callers may supply the visible roster to prevent dangling graph edges.
 */
export function parseRelationshipEdges(
  value: string,
  options: RelationshipTextOptions = {},
): RelationshipEdge[] {
  const structured = parseStructuredRelationships(value)
  const edges = structured ?? (isJsonValue(value) ? [] : parseTextRelationships(value))
  return deduplicateEdges(edges.filter((edge) => isAllowedEdge(edge, options)))
}
