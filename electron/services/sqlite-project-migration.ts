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

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
export interface ProjectSqliteEvidence {
  schemaVersion: number
  fingerprint: string
  domain: { tableCounts: Record<string, number>; authorContentHash: string }
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
function domain(db: BetterSqlite3.Database): ProjectSqliteEvidence['domain'] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  const tableCounts: Record<string, number> = {}, digest = createHash('sha256')
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    const rows = db.prepare(`SELECT * FROM ${quoted}`).safeIntegers().raw().all()
    const encoded = rows.map(row => JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? { integer: value.toString() } : value)).sort()
    // Adding an empty baseline table is structural, not a change to domain rows.
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
  return { schemaVersion: result.version, fingerprint: result.fingerprint, domain: domain(db) }
}
export function probeProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
    try {
      const result = inspect(db, options.registry ?? getDesktopMigrationRegistry()); snapshot.unchanged(); return result
    } finally { db.close() }
  } finally { snapshot.close() }
}
export function verifyProjectSqlite(options: { databasePath: string; registry?: MigrationRegistry; targetVersion?: number }): ProjectSqliteEvidence {
  const snapshot = physicalSnapshot(options.databasePath)
  try {
    const db = new Database(snapshot.file, { readonly: true, fileMustExist: true })
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
    const before = inspect(source, registry)
    // Reserve a new inode before the backup API can open it.
    const fd = fs.openSync(targetPath, 'wx', 0o600); fs.closeSync(fd)
    await source.backup(targetPath)
    regular(targetPath)
    const staging = new Database(targetPath, { fileMustExist: true })
    try {
      staging.pragma('foreign_keys = ON')
      migrateSchema(new SqliteSchemaAdapter(staging), registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      const after = inspect(staging, registry, options.targetVersion ?? CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before.domain) !== JSON.stringify(after.domain)) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
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
  if (before.schemaVersion !== 1) throw new Error('CANONICAL_SCHEMA_UPGRADE_UNSUPPORTED')
  sourceFile(options.databasePath)
  const database = new Database(options.databasePath, { fileMustExist: true })
  try {
    database.pragma('foreign_keys = ON')
    // Revalidate the source identity after acquiring the writable connection.
    const current = inspect(database, registry, 1)
    if (current.fingerprint !== before.fingerprint || JSON.stringify(current.domain) !== JSON.stringify(before.domain)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
    return database.transaction(() => {
      migrateSchema(new SqliteSchemaAdapter(database), registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      const after = inspect(database, registry, CURRENT_DESKTOP_SCHEMA_VERSION)
      if (JSON.stringify(before.domain) !== JSON.stringify(after.domain)) throw new Error('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      return after
    }).immediate()
  } finally { database.close() }
}
