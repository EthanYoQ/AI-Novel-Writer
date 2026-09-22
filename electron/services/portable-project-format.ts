import type Database from 'better-sqlite3'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { verifySchema } from '../migrations/runner'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'
import fieldPolicyDocument from './portable-project-field-policy.json'

export const PORTABLE_PROJECT_FORMAT_VERSION = 1 as const
export const PORTABLE_SOURCE_SCHEMA_VERSION = 6 as const

export type PortableFieldDisposition = 'preserve-domain' | 'historical-nonreplayable'
  | 'redacted-projection' | 'exclude-machine-authority' | 'rebuild-stale'
  | 'validated-relative' | 'avatar-asset'

export interface PortableFieldPolicy {
  disposition: PortableFieldDisposition
  validator: string
  consumer: string
  origin: 'signed-s01' | 'm01-m05-delta'
  signedDisposition: string | null
}

const PORTABLE_FIELD_DISPOSITIONS = new Set<PortableFieldDisposition>([
  'preserve-domain', 'historical-nonreplayable', 'redacted-projection', 'exclude-machine-authority',
  'rebuild-stale', 'validated-relative', 'avatar-asset',
])
type PolicyCode = keyof typeof fieldPolicyDocument.rules
const rules = fieldPolicyDocument.rules as unknown as Record<PolicyCode, readonly [PortableFieldDisposition, string, string]>
const tables = fieldPolicyDocument.tables as Record<string, Record<string, PolicyCode>>
const deltaTables = new Set<string>(fieldPolicyDocument.deltaTables)
const deltaCharacterFields = new Set<string>(fieldPolicyDocument.deltaCharacterFields)
const signedOverrides = fieldPolicyDocument.signedOverrides as Record<string, string>
const signedDefaults: Partial<Record<PolicyCode, string>> = {
  D: 'preserve-domain-value', H: 'historical-read-only-projection', R: 'allowlist-rebuild-or-block',
  X: 'exclude-machine-authority', B: 'rebuildable-metric-version', P: 'validate-relative-projection',
}

function formatError(code: string): never { throw new Error(code) }

function loadFieldPolicy(): ReadonlyMap<string, PortableFieldPolicy> {
  if (fieldPolicyDocument.schemaVersion !== PORTABLE_SOURCE_SCHEMA_VERSION) formatError('PORTABLE_POLICY_INVALID')
  const result = new Map<string, PortableFieldPolicy>()
  for (const [table, fields] of Object.entries(tables)) {
    if (!table || !fields || typeof fields !== 'object') formatError('PORTABLE_POLICY_INVALID')
    for (const [field, code] of Object.entries(fields)) {
      const rule = rules[code]
      const key = `${table}.${field}`
      const delta = deltaTables.has(table) || table === 'characters' && deltaCharacterFields.has(field)
      const signedDisposition = delta ? null : signedOverrides[key] ?? signedDefaults[code]
      if (!field || !rule || rule.length !== 3 || !PORTABLE_FIELD_DISPOSITIONS.has(rule[0])
        || typeof rule[1] !== 'string' || !rule[1] || typeof rule[2] !== 'string' || !rule[2]
        || (!delta && !signedDisposition) || (delta && key in signedOverrides) || result.has(key)) {
        formatError('PORTABLE_POLICY_INVALID')
      }
      result.set(key, Object.freeze({ disposition: rule[0], validator: rule[1], consumer: rule[2],
        origin: delta ? 'm01-m05-delta' : 'signed-s01', signedDisposition }))
    }
  }
  if (Object.keys(signedOverrides).some(key => result.get(key)?.origin !== 'signed-s01')) {
    formatError('PORTABLE_POLICY_INVALID')
  }
  return result
}

const fieldPolicy = loadFieldPolicy()
export const PORTABLE_FIELD_POLICY_COUNTS = Object.freeze({ tables: Object.keys(tables).length, fields: fieldPolicy.size })

/** Unknown fields fail closed. Callers must obey the returned validator/consumer instead of copying opaque JSON. */
export function getPortableFieldPolicy(table: string, field: string): PortableFieldPolicy {
  return fieldPolicy.get(`${table}.${field}`) ?? formatError('PORTABLE_SCHEMA_UNSUPPORTED')
}

export function listPortableFieldPolicyKeys(): readonly string[] {
  return Object.freeze([...fieldPolicy.keys()].sort())
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"` }

/** Read-only bidirectional schema gate. sqlite_* implementation objects are deliberately outside the portable contract. */
export function assertPortableSourceSchema(database: Database.Database): void {
  try {
    database.pragma('foreign_keys = ON')
    verifySchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  } catch { formatError('PORTABLE_SCHEMA_UNSUPPORTED') }
  const actual = new Set<string>()
  const objects = database.prepare("SELECT name,type FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; type: string }>
  for (const object of objects) {
    if (object.type !== 'table' || !(object.name in tables)) formatError('PORTABLE_SCHEMA_UNSUPPORTED')
    for (const row of database.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all() as Array<{ name: string }>) {
      const key = `${object.name}.${row.name}`
      if (!fieldPolicy.has(key)) formatError('PORTABLE_SCHEMA_UNSUPPORTED')
      actual.add(key)
    }
  }
  if (actual.size !== fieldPolicy.size || [...fieldPolicy.keys()].some(key => !actual.has(key))) {
    formatError('PORTABLE_SCHEMA_UNSUPPORTED')
  }
}

export const PORTABLE_ENTRY_DISPOSITIONS = Object.freeze([
  'portable-database', 'author-content', 'knowledge-source', 'prompt', 'skill',
  'avatar-asset', 'transfer-receipt', 'history-projection',
] as const)
export type PortableEntryDisposition = typeof PORTABLE_ENTRY_DISPOSITIONS[number]

export const PORTABLE_OMISSION_REASONS = Object.freeze([
  'exclude-machine-authority', 'rebuild-stale', 'historical-nonreplayable', 'unsupported-safe-projection',
] as const)
export type PortableOmissionReason = typeof PORTABLE_OMISSION_REASONS[number]

export interface PortableProjectManifestEntry {
  path: string
  byteSize: number
  sha256: string
  disposition: PortableEntryDisposition
}

export interface PortableProjectManifest {
  formatVersion: 1
  sourceSchemaVersion: 6
  originProjectId: string
  snapshotGeneration: string
  createdAt: string
  declaredUncompressedBytes: number
  declaredCompressedBytes: number
  entries: PortableProjectManifestEntry[]
  semanticCounts: Record<string, number>
  omittedItems: Array<{ id: string; reason: PortableOmissionReason }>
  transferReceiptIds: string[]
  historyProjectionIds: string[]
}

export interface PortableArchiveLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxDeclaredCompressedBytes: number
  maxCompressionRatio: number
  maxPathBytes: number
  maxSemanticCounts: number
  maxSemanticCountValue: number
  maxOmittedItems: number
  maxReferenceIds: number
}

const GiB = 1024 ** 3
export const DEFAULT_PORTABLE_ARCHIVE_LIMITS: Readonly<PortableArchiveLimits> = Object.freeze({
  maxEntries: 100_000,
  maxEntryBytes: 2 * GiB,
  maxTotalBytes: 16 * GiB,
  maxDeclaredCompressedBytes: 16 * GiB,
  maxCompressionRatio: 200,
  maxPathBytes: 1024,
  maxSemanticCounts: 256,
  maxSemanticCountValue: 1_000_000_000,
  maxOmittedItems: 100_000,
  maxReferenceIds: 100_000,
})

const HASH = /^[a-f0-9]{64}$/u
const COUNT_KEY = /^[a-z][a-z0-9_.-]{0,63}$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const INVALID_WINDOWS_SEGMENT = /[<>:"|?*]/u

function containsSurrogateCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) return true
  }
  return false
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) formatError('PORTABLE_MANIFEST_INVALID')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    formatError('PORTABLE_MANIFEST_INVALID')
  }
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  }
  return value as number
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    formatError('PORTABLE_MANIFEST_INVALID')
  }
  return value
}

export function portablePathKey(value: unknown, maxPathBytes = DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxPathBytes): string {
  if (typeof value !== 'string' || value.length === 0 || containsSurrogateCodeUnit(value)
    || Buffer.byteLength(value, 'utf8') > maxPathBytes) {
    formatError('PORTABLE_PATH_UNSAFE')
  }
  const normalized = value.normalize('NFKC')
  if (normalized.startsWith('/') || normalized.includes('\\') || /^[a-z]:/iu.test(normalized)) {
    formatError('PORTABLE_PATH_UNSAFE')
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || segment.endsWith('.') || segment.endsWith(' ') || INVALID_WINDOWS_SEGMENT.test(segment)
    || [...segment].some(character => character.charCodeAt(0) <= 31)
    || WINDOWS_RESERVED.test(segment))) formatError('PORTABLE_PATH_UNSAFE')
  return segments.map(segment => segment.toLowerCase()).join('/')
}

function limits(input?: Partial<PortableArchiveLimits>): PortableArchiveLimits {
  const resolved = { ...DEFAULT_PORTABLE_ARCHIVE_LIMITS, ...input }
  if (Object.values(resolved).some(value => !Number.isSafeInteger(value) || value <= 0)) {
    formatError('PORTABLE_ARCHIVE_LIMIT_INVALID')
  }
  return resolved
}

function references(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  const result = value.map(identifier)
  if (new Set(result).size !== result.length) formatError('PORTABLE_MANIFEST_INVALID')
  return result
}

export function parsePortableProjectManifest(value: unknown, configuredLimits?: Partial<PortableArchiveLimits>): PortableProjectManifest {
  const max = limits(configuredLimits)
  const source = record(value)
  exactKeys(source, ['formatVersion', 'sourceSchemaVersion', 'originProjectId', 'snapshotGeneration', 'createdAt',
    'declaredUncompressedBytes', 'declaredCompressedBytes', 'entries', 'semanticCounts', 'omittedItems',
    'transferReceiptIds', 'historyProjectionIds'])
  if (source.formatVersion !== PORTABLE_PROJECT_FORMAT_VERSION || source.sourceSchemaVersion !== PORTABLE_SOURCE_SCHEMA_VERSION) {
    formatError('PORTABLE_SCHEMA_UNSUPPORTED')
  }
  const originProjectId = identifier(source.originProjectId)
  const snapshotGeneration = identifier(source.snapshotGeneration)
  const createdAtMillis = typeof source.createdAt === 'string' ? Date.parse(source.createdAt) : Number.NaN
  if (!Number.isFinite(createdAtMillis) || new Date(createdAtMillis).toISOString() !== source.createdAt) {
    formatError('PORTABLE_MANIFEST_INVALID')
  }
  const declaredUncompressedBytes = boundedInteger(source.declaredUncompressedBytes, max.maxTotalBytes)
  const declaredCompressedBytes = boundedInteger(source.declaredCompressedBytes, max.maxDeclaredCompressedBytes)
  if ((declaredUncompressedBytes > 0 && declaredCompressedBytes === 0)
    || declaredUncompressedBytes / Math.max(1, declaredCompressedBytes) > max.maxCompressionRatio) {
    formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  }
  if (!Array.isArray(source.entries) || source.entries.length > max.maxEntries) formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  const paths = new Set<string>()
  const directories = new Set<string>()
  const entries = source.entries.map(item => {
    const entry = record(item)
    exactKeys(entry, ['path', 'byteSize', 'sha256', 'disposition'])
    const path = typeof entry.path === 'string' ? entry.path : formatError('PORTABLE_PATH_UNSAFE')
    const key = portablePathKey(path, max.maxPathBytes)
    if (paths.has(key) || directories.has(key)) formatError('PORTABLE_PATH_CONFLICT')
    const segments = key.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/')
      if (paths.has(directory)) formatError('PORTABLE_PATH_CONFLICT')
      directories.add(directory)
    }
    paths.add(key)
    const byteSize = boundedInteger(entry.byteSize, max.maxEntryBytes)
    if (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)
      || !PORTABLE_ENTRY_DISPOSITIONS.includes(entry.disposition as PortableEntryDisposition)) {
      formatError('PORTABLE_MANIFEST_INVALID')
    }
    return { path, byteSize, sha256: entry.sha256, disposition: entry.disposition as PortableEntryDisposition }
  })
  const total = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
  if (!Number.isSafeInteger(total) || total > max.maxTotalBytes || total !== declaredUncompressedBytes) {
    formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  }
  const counts = record(source.semanticCounts)
  if (Object.keys(counts).length > max.maxSemanticCounts) formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  const semanticCounts: Record<string, number> = {}
  for (const [key, count] of Object.entries(counts)) {
    if (!COUNT_KEY.test(key)) formatError('PORTABLE_MANIFEST_INVALID')
    semanticCounts[key] = boundedInteger(count, max.maxSemanticCountValue)
  }
  if (!Array.isArray(source.omittedItems) || source.omittedItems.length > max.maxOmittedItems) {
    formatError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  }
  const omittedItems = source.omittedItems.map(item => {
    const omitted = record(item)
    exactKeys(omitted, ['id', 'reason'])
    if (!PORTABLE_OMISSION_REASONS.includes(omitted.reason as PortableOmissionReason)) {
      formatError('PORTABLE_MANIFEST_INVALID')
    }
    return { id: identifier(omitted.id), reason: omitted.reason as PortableOmissionReason }
  })
  if (new Set(omittedItems.map(item => item.id)).size !== omittedItems.length) formatError('PORTABLE_MANIFEST_INVALID')
  return {
    formatVersion: PORTABLE_PROJECT_FORMAT_VERSION,
    sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
    originProjectId,
    snapshotGeneration,
    createdAt: source.createdAt,
    declaredUncompressedBytes,
    declaredCompressedBytes,
    entries,
    semanticCounts,
    omittedItems,
    transferReceiptIds: references(source.transferReceiptIds, max.maxReferenceIds),
    historyProjectionIds: references(source.historyProjectionIds, max.maxReferenceIds),
  }
}
