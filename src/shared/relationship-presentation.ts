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

/** 关系备注与结构化边拆分后的结果。 */
export interface RelationshipEditorSplit {
  edges: RelationshipEdge[]
  /** 无法结构化的原文行：作为「关系备注」原样保留，一个字都不丢。 */
  notes: string
}

function normalizeNameForMatch(value: string): string {
  return value
    .replace(/[（(][^（()）]*[)）]/gu, '')
    .replace(/[\s\u3000]/gu, '')
    .toLocaleLowerCase('en-US')
}

function matchKnownName(candidate: string, names: Set<string> | null): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return null
  if (!names) return trimmed
  const normalized = normalizeNameForMatch(trimmed)
  if (!normalized) return null
  for (const name of names) {
    if (normalizeNameForMatch(name) === normalized) return name
  }
  return null
}

function splitRelationshipTargets(text: string): string[] {
  return text
    .split(/[、,，]|\s+[与和及]\s+/gu)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * 单行关系的宽容解析：识别「目标：关系」「目标 - 关系」、多目标
 * 「甲、乙：师徒」、反序写法「师父：林岚」，以及正文式「她与林岚有旧恩」。
 * 返回 null 表示这一行无法结构化，调用方应把它留作关系备注。
 */
function parseRelationshipLine(
  line: string,
  names: Set<string> | null,
  selfName?: string,
): RelationshipEdge[] | null {
  const keep = (edges: RelationshipEdge[]): RelationshipEdge[] => (
    edges.filter(edge => edge.target !== selfName)
  )
  const explicit = line.match(/^(.{1,60}?)\s*[：:]\s*(.+)$/u)
    ?? line.match(/^(.{1,60}?)\s*[-—–]{1,2}\s*(.+)$/u)

  if (explicit) {
    const left = explicit[1].trim()
    const right = explicit[2].trim()
    if (!left || !right) return null
    const targets = splitRelationshipTargets(left)
      .map(part => matchKnownName(part, names))
      .filter((name): name is string => Boolean(name))
    if (targets.length > 0) {
      const edges = keep(targets.map(target => ({ target, relation: right })))
      return edges.length > 0 ? edges : null
    }
    // 反序写法：「师父：林岚」——右侧才是角色，左侧是关系说明。
    const reversed = matchKnownName(right, names)
    if (reversed) {
      const edges = keep([{ target: reversed, relation: left }])
      return edges.length > 0 ? edges : null
    }
    if (!names) {
      // 没有名单可参照时，只能按「角色：关系」的书写惯例取左侧。
      const target = targets.length > 0 ? left : splitRelationshipTargets(left)[0]
      return target ? [{ target, relation: right }] : null
    }
    return null
  }

  // 无分隔符：行内出现的每个已知角色名都算目标，整行作为关系说明。
  if (names) {
    const normalizedLine = normalizeNameForMatch(line)
    const hits = [...names].filter(name => (
      name !== selfName && normalizeNameForMatch(name) && normalizedLine.includes(normalizeNameForMatch(name))
    ))
    if (hits.length > 0) return hits.map(target => ({ target, relation: line }))
  }
  return null
}

/**
 * 把编辑框里的关系文本拆成「结构化边」与「无法结构化的原文」两部分。
 *
 * 这是「任意角色卡都能被拆解」的关键：能确定目标的行走结构化边（供关系图谱
 * 与写稿注入使用），其余原文原样留作关系备注 —— 不再因为一行无法解析就把
 * 整块关系降级成自由文本，也不会把作者的原话丢掉。
 */
export function splitRelationshipEditorValue(
  value: string,
  options: RelationshipTextOptions = {},
): RelationshipEditorSplit {
  const structured = parseStructuredRelationships(value)
  const names = knownNameSet(options)
  if (structured !== null) {
    return {
      edges: deduplicateEdges(structured.filter(edge => isAllowedEdge(edge, options))),
      notes: '',
    }
  }

  const edges: RelationshipEdge[] = []
  const notes: string[] = []
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseRelationshipLine(line, names, options.selfName)
    if (parsed) edges.push(...parsed)
    else notes.push(line)
  }
  return { edges: deduplicateEdges(edges), notes: notes.join('\n') }
}

/** 关系名归一化后的取值，供上层做「关系文本是否引用了名单里没有的角色」判断。 */
export function relationshipTargetHint(line: string): string | null {
  const explicit = line.match(/^(.{1,60}?)\s*[：:]\s*(.+)$/u)
  const candidate = explicit ? explicit[1] : line
  const cleaned = candidate.replace(/[（(][^（()）]*[)）]/gu, '').trim()
  return cleaned || null
}

const UNREGISTERED_TARGET_MAX_LENGTH = 20

/**
 * 从关系文本里找出「写了关系、但那个角色还没进名单」的目标名。
 *
 * 只认 `名字：关系` 这种明确写法：散文式的行无法可靠切出人名，宁可漏报也不
 * 误建一张名字错误的角色卡。返回的名字可直接用于一键建立角色卡 —— 建完之后
 * 这些行就会自动升级成结构化关系边。
 */
export function unregisteredRelationshipTargets(
  value: string,
  options: RelationshipTextOptions = {},
): string[] {
  const names = knownNameSet(options)
  if (!names) return []
  const found: string[] = []
  const seen = new Set<string>()
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    if (parseRelationshipLine(line, names, options.selfName)) continue
    const hint = relationshipTargetHint(line)
    if (!hint || hint === options.selfName) continue
    if (hint.length > UNREGISTERED_TARGET_MAX_LENGTH) continue
    if (names.has(hint)) continue
    const key = normalizeNameForMatch(hint)
    if (!key || seen.has(key)) continue
    seen.add(key)
    found.push(hint)
  }
  return found
}
