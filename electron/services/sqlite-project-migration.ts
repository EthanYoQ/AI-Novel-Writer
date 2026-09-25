import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { migrateSchema, probeSchema, verifySchema } from '../migrations/runner'
import type { MigrationRegistry } from '../migrations/registry'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'
import { M02_ADDED_CHARACTER_COLUMNS, M02_AUXILIARY_TABLES } from '../migrations/m02-character-identity'
import { M03_REVIEW_CYCLE_TABLES } from '../migrations/m03-review-cycle'
import { initializeLegacyBaselineSchema } from '../migrations/baseline-schema'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const QUALIFIED_V100_SCHEMA = '5e1ee5e03fa79bbf49694a680316ee74047f45901cd3f8affeaa0a7fda3ea414'
const QUALIFIED_V110_SCHEMA = '1207fd8203e31503e3cd09ba5b60a959c606ded34a8c8c7774a9e15edc8271ba'
const QUALIFIED_EARLY_V110_SCHEMA = '2504dde08865f758f654d38ae3d972420c28fa60d1f747e92898390455272de6'
const EARLY_V110_TABLES = [
  'blueprints', 'characters', 'contents', 'drafts', 'llm_calls', 'post_process_runs',
  'post_process_steps', 'project_core', 'reviews', 'revisions', 'summary_snapshots',
]
const V100_MISSING_COLUMNS: Record<string, string[]> = {
  characters: ['cs_provenance'], drafts: ['source_dependencies'], summary_snapshots: [
    'character_state_candidates', 'source_finalization_id', 'source_content_hash', 'projection_generation',
  ],
}
export interface ProjectSqliteEvidence {
  schemaVersion: number
  fingerprint: string
  domain: { tableCounts: Record<string, number>; authorContentHash: string }
  preIdentityDomain?: { tableCounts: Record<string, number>; authorContentHash: string }
  preAssetDomain?: { tableCounts: Record<string, number>; authorContentHash: string }
}

function regular(file: string): void {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('PROJECT_MIGRATION_UNSAFE_FILE')
}
function safeDirectory(directory: string, allowMissing = false): void {
  let parent = path.resolve(directory)
  while (parent !== path.dirname(parent)) {
    let info: fs.Stats
    try { info = fs.lstatSync(parent) } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') { parent = path.dirname(parent); continue }
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PROJECT_MIGRATION_UNSAFE_DIRECTORY')
    parent = path.dirname(parent)
  }
}
function sourceFile(file: string): void {
  safeDirectory(path.dirname(file))
  regular(file)
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(file + suffix)) regular(file + suffix)
}
const sqliteSuffixes = ['', '-wal', '-shm', '-journal'] as const
function sourceIdentity(file: string): Record<string, string> {
  sourceFile(file)
  return Object.fromEntries(sqliteSuffixes.filter(suffix => fs.existsSync(file + suffix)).map(suffix =>
    [suffix, createHash('sha256').update(fs.readFileSync(file + suffix)).digest('hex')]))
}
/** SQLite readonly handles may still write original -shm reader marks. Copy the
 * physical DB/WAL/SHM set using filesystem reads, then connect only this copy.
 * The coordinator owns source writer exclusion; double hashes detect drift.
 */
function physicalSnapshot(source: string) {
  const identity = sourceIdentity(source)
  // Installed apps may have a read-only working directory. Every external
  // snapshot owns its scratch directory and removes it after all handles close.
  const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'VibeCodingScratch', 'ai-novel-writer')
  safeDirectory(base, true)
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'sqlite-read-')), file = path.join(root, 'snapshot.db')
  const unchanged = () => {
    if (JSON.stringify(sourceIdentity(source)) !== JSON.stringify(identity)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
  }
  try {
    fs.writeFileSync(path.join(root, '.vibe-owner.json'), JSON.stringify({
      owner: 'AI-Novel-Writer SQLite snapshot', sourceProject: path.resolve('.'), createdAt: new Date().toISOString(), ttlHours: 24,
      reason: 'Private physical SQLite read snapshot; rebuilt from source, never a recovery authority.',
      cleanupCommand: `Remove-Item -LiteralPath '${root.replaceAll("'", "''")}' -Recurse -Force`,
    }), { flag: 'wx' })
    for (const suffix of Object.keys(identity)) fs.copyFileSync(source + suffix, file + suffix, fs.constants.COPYFILE_EXCL)
    if (JSON.stringify(sourceIdentity(file)) !== JSON.stringify(identity)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
    unchanged()
    return { file, unchanged, close: () => fs.rmSync(root, { recursive: true, force: true }) }
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error }
}
type DomainColumns = { name: string; columns: string[] }[]
const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const M05_ASSET_TABLES = ['character_avatar_assets', 'character_avatar_unresolved'] as const
function domainColumns(db: BetterSqlite3.Database, preIdentity = false, preAsset = false): DomainColumns {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  const postLegacyTables = [...M02_AUXILIARY_TABLES, ...M03_REVIEW_CYCLE_TABLES, ...M05_ASSET_TABLES] as readonly string[]
  return tables.filter(({ name }) => (!preIdentity || !postLegacyTables.includes(name))
    && (!preAsset || !(M05_ASSET_TABLES as readonly string[]).includes(name))).map(({ name }) => ({ name,
    columns: (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string }[]).map(column => column.name)
      .filter(column => !preIdentity || name !== 'characters' || !(M02_ADDED_CHARACTER_COLUMNS as readonly string[]).includes(column)),
  }))
}
function domain(db: BetterSqlite3.Database, selection = domainColumns(db)): ProjectSqliteEvidence['domain'] {
  const tableCounts: Record<string, number> = {}, digest = createHash('sha256')
  for (const { name, columns } of selection) {
    const rows = db.prepare(`SELECT ${columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(name)}`).safeIntegers().raw().all()
    const encoded = rows.map(row => JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? { integer: value.toString() } : value)).sort()
    if (encoded.length) {
      tableCounts[name] = encoded.length
      digest.update(JSON.stringify([name, encoded]))
    }
  }
  return { tableCounts, authorContentHash: digest.digest('hex') }
}
function inspect(db: BetterSqlite3.Database, registry: MigrationRegistry, targetVersion?: number): ProjectSqliteEvidence {
  const adapter = new SqliteSchemaAdapter(db)
  const result = targetVersion === undefined ? probeSchema(adapter, registry) : verifySchema(adapter, registry, targetVersion)
  return { schemaVersion: result.version, fingerprint: result.fingerprint, domain: domain(db),
    ...(result.version >= 3 ? { preIdentityDomain: domain(db, domainColumns(db, true)) } : {}),
    ...(result.version >= 6 ? { preAssetDomain: domain(db, domainColumns(db, false, true)) } : {}) }
}
function qualifiedLegacySource(db: BetterSqlite3.Database): string | null {
  const adapter = new SqliteSchemaAdapter(db)
  const fingerprint = adapter.readSchemaFingerprint()
  return adapter.readUserVersion() === 0 && [QUALIFIED_V100_SCHEMA, QUALIFIED_V110_SCHEMA, QUALIFIED_EARLY_V110_SCHEMA].includes(fingerprint)
    && adapter.integrityCheck() && adapter.foreignKeyCheck() ? fingerprint : null
}
function inspectSource(db: BetterSqlite3.Database, registry: MigrationRegistry, allowLegacy: boolean): ProjectSqliteEvidence {
  const fingerprint = allowLegacy && qualifiedLegacySource(db)
  return fingerprint
    ? { schemaVersion: 0, fingerprint, domain: domain(db) }
    : inspect(db, registry)
}
function copyQualifiedLegacy(source: BetterSqlite3.Database, staging: BetterSqlite3.Database, sourceColumns: DomainColumns, fingerprint: string): void {
  initializeLegacyBaselineSchema(staging)
  const targetColumns = domainColumns(staging)
  const columnSets = (tables: DomainColumns) => tables.map(({ name, columns }) => [name, [...columns].sort()])
  const expectedColumns = fingerprint === QUALIFIED_V100_SCHEMA ? targetColumns
    .filter(({ name }) => name !== 'continuity_projection_meta')
    .map(({ name, columns }) => ({ name, columns: columns.filter(column => !V100_MISSING_COLUMNS[name]?.includes(column)) })) : targetColumns
  const earlyV110 = fingerprint === QUALIFIED_EARLY_V110_SCHEMA
  const expectedEarlyTables = [...EARLY_V110_TABLES].sort()
  const actualEarlyTables = sourceColumns.map(({ name }) => name)
  const targetByName = new Map(targetColumns.map(({ name, columns }) => [name, new Set(columns)]))
  if (earlyV110
    ? (JSON.stringify(actualEarlyTables) !== JSON.stringify(expectedEarlyTables)
      || sourceColumns.some(({ name, columns }) => columns.some(column => !targetByName.get(name)?.has(column))))
    : JSON.stringify(columnSets(sourceColumns)) !== JSON.stringify(columnSets(expectedColumns))) {
    throw new Error('PROJECT_MIGRATION_LEGACY_SCHEMA_MISMATCH')
  }
  staging.transaction(() => {
    staging.pragma('defer_foreign_keys = ON')
    staging.exec('DELETE FROM character_roster_meta; DELETE FROM continuity_projection_meta; DELETE FROM text_metric_versions')
    for (const { name, columns } of sourceColumns) {
      const table = quoteIdentifier(name), names = columns.map(quoteIdentifier)
      const read = source.prepare(`SELECT rowid,${names.join(',')} FROM ${table} ORDER BY rowid`).safeIntegers().raw()
      const write = staging.prepare(`INSERT INTO ${table}(rowid,${names.join(',')}) VALUES(${Array(columns.length + 1).fill('?').join(',')})`)
      for (const row of read.iterate() as IterableIterator<unknown[]>) write.run(...row)
      const rowids = (db: BetterSqlite3.Database) => {
        const digest = createHash('sha256')
        for (const id of db.prepare(`SELECT rowid FROM ${table} ORDER BY rowid`).safeIntegers().pluck().iterate()) {
          digest.update(`${id}\n`)
        }
        return digest.digest('hex')
      }
      if (rowids(source) !== rowids(staging)) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
    }
    staging.exec('DELETE FROM sqlite_sequence')
    const insertSequence = staging.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)')
    for (const row of source.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers().iterate() as IterableIterator<{ name: string; seq: bigint }>) {
      insertSequence.run(row.name, row.seq)
    }
    if ((staging.pragma('foreign_key_check') as unknown[]).length) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
  })()
}
export function probeProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    db.pragma('foreign_keys = ON')
    try {
      const result = inspectSource(db, options.registry ?? getDesktopMigrationRegistry(), !options.registry); snapshot.unchanged(); return result
    } finally { db.close() }
  } finally { snapshot.close() }
}
export function verifyProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry; targetVersion?: number }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    db.pragma('foreign_keys = ON')
    try {
      const result = inspect(db, options.registry ?? getDesktopMigrationRegistry(), options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION); snapshot.unchanged(); return result
    } finally { db.close() }
  } finally { snapshot.close() }
}
/** Caller has already proved exclusive access and owns an empty staging root.
 * SQLite backup captures committed WAL pages. No business DB/session is exposed.
 */
export async function backupProjectSqlite(options: {
  sourceDatabasePath: string; targetDatabasePath: string; registry?: MigrationRegistry; targetVersion?: number
}): Promise<ProjectSqliteEvidence> {
  const sourcePath = path.resolve(options.sourceDatabasePath), targetPath = path.resolve(options.targetDatabasePath)
  if (sourcePath === targetPath || fs.existsSync(targetPath)) throw new Error('PROJECT_MIGRATION_TARGET_EXISTS')
  safeDirectory(path.dirname(targetPath))
  sourceFile(sourcePath)
  const registry = options.registry ?? getDesktopMigrationRegistry()
  const snapshot = physicalSnapshot(sourcePath)
  let source: BetterSqlite3.Database | undefined
  try {
    source = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    source.pragma('foreign_keys = ON')
    const columnsBefore = domainColumns(source)
    const before = inspectSource(source, registry, !options.registry)
    const legacySchema = !options.registry && [QUALIFIED_V100_SCHEMA, QUALIFIED_V110_SCHEMA, QUALIFIED_EARLY_V110_SCHEMA].includes(before.fingerprint)
    // Reserve a new inode before the backup API can open it.
    const fd = fs.openSync(targetPath, 'wx', 0o600); fs.closeSync(fd)
    if (!legacySchema) await source.backup(targetPath)
    regular(targetPath)
    const staging = new Database(targetPath, { fileMustExist: true })
    try {
      staging.pragma('foreign_keys = ON')
      if (legacySchema) {
        copyQualifiedLegacy(source, staging, columnsBefore, before.fingerprint)
        inspect(staging, registry, 0)
      }
      migrateSchema(new SqliteSchemaAdapter(staging), registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      const after = inspect(staging, registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before.domain) !== JSON.stringify(domain(staging, columnsBefore))) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      snapshot.unchanged()
      staging.pragma('wal_checkpoint(TRUNCATE)')
      const fd = fs.openSync(targetPath, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return after
    } finally { staging.close() }
  } finally { source?.close(); snapshot.close() }
}


/** Canonical-only upgrade seam. Caller validates its manifest and excludes business
 * writers first. Probe never opens the source; the single lane owns the transaction.
 */
export function upgradeProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry }): ProjectSqliteEvidence {
  const registry = options.registry ?? getDesktopMigrationRegistry()
  const before = probeProjectSqlite({ databasePath: options.databasePath, registry })
  if (before.schemaVersion === CURRENT_DESKTOP_SCHEMA_VERSION) return verifyProjectSqlite({ ...options, registry })
  if (![1, 2, 3, 4, 5].includes(before.schemaVersion)) throw new Error('CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED')
  sourceFile(options.databasePath)
  const database = new Database(options.databasePath, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    // Revalidate the source identity after acquiring the writable connection.
    const current = inspect(database, registry, before.schemaVersion)
    if (current.fingerprint !== before.fingerprint || JSON.stringify(current.domain) !== JSON.stringify(before.domain)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
    return database.transaction(() => {
      const columnsBefore = domainColumns(database)
      migrateSchema(new SqliteSchemaAdapter(database), registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      const after = inspect(database, registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before.domain) !== JSON.stringify(domain(database, columnsBefore))) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      return after
    }).immediate()
  } finally { database.close() }
}
