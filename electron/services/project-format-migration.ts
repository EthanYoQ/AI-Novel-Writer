import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertProjectMigrationPathsSupported, type ProjectStoragePreflightOptions } from './project-storage-preflight'
import { CANONICAL_PROJECT_DATABASE, parseCanonicalProjectManifest } from '../../src/shared/project-format'

export interface ProjectSqliteEvidence {
  schemaVersion: number; fingerprint: string
  domain: { tableCounts: Record<string, number>; authorContentHash: string }
}
export interface ProjectMigrationDependencies<VectorSnapshot = unknown> {
  probeSqlite(databasePath: string): ProjectSqliteEvidence
  backupSqlite(sourceDatabasePath: string, targetDatabasePath: string): Promise<ProjectSqliteEvidence>
  verifySqlite(databasePath: string): ProjectSqliteEvidence
  closeHandles(): Promise<void>
  exportVectors(storageRoot: string, originalSourceRoot: string): Promise<VectorSnapshot>
  importVectors(storageRoot: string, snapshot: VectorSnapshot): Promise<void>
  verifyVectors(storageRoot: string, snapshot: VectorSnapshot): Promise<boolean>
  writeManifest(storageRoot: string, projectId: string, createdAt: string): void
  /** Validated canonical manifest/DB locator, supplied by the single central owner. */
  databaseName: string
}
export type ProjectMigrationPhase = 'prepared' | 'verified' | 'legacy-isolated' | 'target-installed' | 'switched' | 'restored'
interface Journal {
  version: 1; migrationId: string; projectId: string; sourceRoot: string; phase: ProjectMigrationPhase
  sourceFingerprint: string; targetFingerprint?: string; sourceSchema: ProjectSqliteEvidence
  targetSchema?: ProjectSqliteEvidence; backupOnlyCount: number
  createdAt: string
}
export type ProjectMigrationResult =
  | { state: 'ready'; projectId: string; migrationId: string; storageRoot: string; backupOnlyCount: number }
  | { state: 'blocked'; code: string }
  | { state: 'restored'; projectId: string }
const permits = new WeakMap<object, string>()
const admitted = new WeakSet<object>()
export function isAdmittedProjectMigration(result: unknown): result is Extract<ProjectMigrationResult, { state: 'ready' }> {
  return typeof result === 'object' && result !== null && admitted.has(result)
}
function admit(result: Extract<ProjectMigrationResult, { state: 'ready' }>): Extract<ProjectMigrationResult, { state: 'ready' }> {
  Object.freeze(result); admitted.add(result); return result
}
export interface SyntheticProjectMigrationPermit { readonly fixtureOnly: true }
function fail(code: string): never { throw new Error(code) }
function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function safeDirectory(location: string): void {
  const absolute = path.resolve(location)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    let info: fs.Stats
    try { info = fs.lstatSync(cursor) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_MIGRATION_UNSAFE_DIRECTORY')
  }
}
/** No production permit exists until old-binary and writer-exclusion qualification. */
export function authorizeSyntheticProjectMigration(fixtureRoot: string): SyntheticProjectMigrationPermit {
  const root = path.resolve(fixtureRoot), allowed = path.resolve('.runtime/.cache/novel-quality-modernization')
  if (!contained(allowed, root) || root === allowed) fail('PROJECT_MIGRATION_FIXTURE_ROOT_REQUIRED')
  safeDirectory(root)
  if (!fs.existsSync(root)) fail('PROJECT_MIGRATION_FIXTURE_ROOT_REQUIRED')
  const permit = Object.freeze({ fixtureOnly: true as const }); permits.set(permit, root); return permit
}
function regular(file: string): void {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('PROJECT_MIGRATION_UNSAFE_FILE')
}
function entryExists(file: string): boolean {
  try { fs.lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return // File fsync + rename; power-loss qualification is separate.
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function writeJson(file: string, value: unknown): void {
  safeDirectory(path.dirname(file)); fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) regular(file)
  const temporary = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file))
}
/** Private local journal fingerprint, never a portable/public receipt digest. Unknown links are not traversed. */
function treeFingerprint(root: string): string {
  const digest = createHash('sha256')
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), info = fs.lstatSync(file)
      digest.update(JSON.stringify(path.relative(root, file)))
      if (info.isSymbolicLink()) digest.update(`link:${fs.readlinkSync(file)}`)
      else if (info.isDirectory()) { digest.update('directory'); walk(file) }
      else if (info.isFile()) digest.update(fs.readFileSync(file))
      else fail('PROJECT_MIGRATION_UNSUPPORTED_ASSET')
    }
  }
  walk(root); return digest.digest('hex')
}
function copyAsset(source: string, target: string): void {
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) fail('PROJECT_MIGRATION_REQUIRED_ASSET_LINK')
  if (info.isDirectory()) {
    safeDirectory(target); fs.mkdirSync(target, { recursive: false })
    for (const name of fs.readdirSync(source)) copyAsset(path.join(source, name), path.join(target, name))
  } else {
    regular(source); safeDirectory(path.dirname(target))
    const fd = fs.openSync(target, 'wx', 0o600)
    try { fs.writeFileSync(fd, fs.readFileSync(source)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
}
const ASSETS = ['prompts', 'skills', 'writing-skills.json', 'partial_arch', 'partial_arch.json', 'chapter_creation_log.json', 'avatars'] as const
const VECTOR_ASSETS = ['lancedb', 'embedding-spaces.json', 'vectors.json', 'vectors.json.migrated', 'vectors.json.migration-journal.json'] as const
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function readJournal(file: string): Journal {
  regular(file)
  let value: Journal
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fail('PROJECT_MIGRATION_JOURNAL_INVALID') }
  if (value.version !== 1 || !UUID.test(value.migrationId) || !UUID.test(value.projectId)
    || !['prepared', 'verified', 'legacy-isolated', 'target-installed', 'switched', 'restored'].includes(value.phase)
    || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) || !value.sourceSchema?.domain
    || typeof value.sourceRoot !== 'string' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isSafeInteger(value.backupOnlyCount) || value.backupOnlyCount < 0
    || Object.keys(value).some(key => !['version', 'migrationId', 'projectId', 'sourceRoot', 'phase', 'sourceFingerprint', 'targetFingerprint', 'sourceSchema', 'targetSchema', 'backupOnlyCount', 'createdAt'].includes(key))) fail('PROJECT_MIGRATION_JOURNAL_INVALID')
  return value
}
export async function migrateProjectFormat<V>(options: {
  projectRoot: string; projectId: string; permit?: SyntheticProjectMigrationPermit
  /** Explicit adoption supplies identity creation time only for a manifest-less recognized source. */
  createdAt?: string
  preflightOptions?: ProjectStoragePreflightOptions
  exclusiveWriterCheck: () => boolean
  dependencies: ProjectMigrationDependencies<V>
  checkpoint?: (phase: string) => void
}): Promise<ProjectMigrationResult> {
  const deps = options.dependencies
  try {
    const authorized = options.permit && permits.get(options.permit), root = path.resolve(options.projectRoot)
    if (!authorized || !contained(authorized, root) || root === authorized) fail('PROJECT_MIGRATION_NOT_QUALIFIED')
    if (!options.exclusiveWriterCheck()) fail('PROJECT_MIGRATION_WRITER_NOT_EXCLUDED')
    if (!UUID.test(options.projectId) || deps.databaseName !== CANONICAL_PROJECT_DATABASE) fail('PROJECT_MIGRATION_IDENTITY_INVALID')
    safeDirectory(root); assertProjectMigrationPathsSupported(root, options.preflightOptions)
    const source = path.join(root, '.vela'), target = path.join(root, '.ai-novel'), control = path.join(root, '.ai-novel-migration')
    safeDirectory(source); safeDirectory(target); safeDirectory(control)
    const journalFile = path.join(control, 'journal.json'), checkpoint = options.checkpoint ?? (() => {})
    await deps.closeHandles()
    let journal: Journal
    if (fs.existsSync(journalFile)) {
      journal = readJournal(journalFile)
      if (journal.projectId !== options.projectId || journal.sourceRoot !== root) fail('PROJECT_MIGRATION_IDENTITY_MISMATCH')
      if (journal.phase === 'restored') {
        if (!fs.existsSync(source) || fs.existsSync(target) || fs.existsSync(path.join(control, journal.migrationId + '.legacy'))) fail('PROJECT_MIGRATION_RESTORE_CONFLICT')
        regular(path.join(source, 'vela.db'))
        return { state: 'restored', projectId: journal.projectId }
      }
    } else {
      if (fs.existsSync(target) || fs.existsSync(control)) fail('PROJECT_MIGRATION_UNKNOWN_TARGET')
      if (!fs.existsSync(source)) fail('PROJECT_MIGRATION_SOURCE_MISSING')
      regular(path.join(source, 'vela.db'))
      for (const name of ['vela.db-wal', 'vela.db-shm']) if (entryExists(path.join(source, name))) regular(path.join(source, name))
      let createdAt = options.createdAt
      const sourceManifest = path.join(source, 'project.json')
      if (entryExists(sourceManifest)) {
        regular(sourceManifest)
        const manifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'))
        if (manifest.schemaVersion !== 1 || manifest.kind !== 'ai-novel-project' || manifest.projectId !== options.projectId) fail('PROJECT_MIGRATION_IDENTITY_MISMATCH')
        createdAt = manifest.createdAt
      }
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) fail('PROJECT_MIGRATION_IDENTITY_INVALID')
      const sourceSchema = deps.probeSqlite(path.join(source, 'vela.db'))
      journal = { version: 1, migrationId: randomUUID(), projectId: options.projectId, sourceRoot: root,
        phase: 'prepared', sourceFingerprint: treeFingerprint(source), sourceSchema, createdAt,
        backupOnlyCount: fs.readdirSync(source).filter(name => name === 'vectors.json.migrated' || !['vela.db', 'vela.db-wal', 'vela.db-shm', 'project.json', ...ASSETS, ...VECTOR_ASSETS].includes(name)).length }
      writeJson(journalFile, journal); checkpoint('prepared')
    }
    const staging = path.join(control, `${journal.migrationId}.staging`), backup = path.join(control, `${journal.migrationId}.legacy`)
    const vectorCopy = path.join(control, `${journal.migrationId}.vector-snapshot`)
    safeDirectory(staging); safeDirectory(backup); safeDirectory(vectorCopy)
    if (journal.phase === 'switched') {
      if (fs.existsSync(source) || !fs.existsSync(target)) fail('PROJECT_MIGRATION_SWITCH_CONFLICT')
      const manifestFile = path.join(target, 'project.json')
      regular(manifestFile)
      const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
      if (manifest.projectId !== journal.projectId || manifest.createdAt !== journal.createdAt) fail('PROJECT_MIGRATION_IDENTITY_MISMATCH')
      deps.verifySqlite(path.join(target, deps.databaseName))
      return admit({ state: 'ready', projectId: journal.projectId, migrationId: journal.migrationId, storageRoot: target, backupOnlyCount: journal.backupOnlyCount })
    }
    if (!fs.existsSync(source) && fs.existsSync(backup) && !fs.existsSync(target) && !fs.existsSync(staging)) {
      if (treeFingerprint(backup) !== journal.sourceFingerprint) fail('PROJECT_MIGRATION_BACKUP_CHANGED')
      fs.renameSync(backup, source); syncDirectory(root)
      journal.phase = 'restored'; writeJson(journalFile, journal)
      return { state: 'restored', projectId: journal.projectId }
    }
    if (journal.phase === 'prepared') {
      if (!fs.existsSync(source) || fs.existsSync(backup) || fs.existsSync(target) || treeFingerprint(source) !== journal.sourceFingerprint) fail('PROJECT_MIGRATION_SOURCE_CHANGED')
      // Quarantine only this journal's unverified output; never truncate/reuse its inodes.
      for (const partial of [staging, vectorCopy]) if (fs.existsSync(partial)) {
        fs.renameSync(partial, `${partial}.abandoned-${randomUUID()}`); syncDirectory(control)
      }
      fs.mkdirSync(staging); fs.mkdirSync(vectorCopy)
      const targetSchema = await deps.backupSqlite(path.join(source, 'vela.db'), path.join(staging, deps.databaseName))
      if (targetSchema.schemaVersion !== 1 || !isDeepStrictEqual(targetSchema.domain, journal.sourceSchema.domain)) fail('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
      checkpoint('sqlite-backed-up')
      for (const name of ASSETS) if (entryExists(path.join(source, name))) { copyAsset(path.join(source, name), path.join(staging, name)); checkpoint(`asset:${name}`) }
      for (const name of VECTOR_ASSETS) if (entryExists(path.join(source, name))) copyAsset(path.join(source, name), path.join(vectorCopy, name))
      const snapshot = await deps.exportVectors(vectorCopy, source)
      await deps.importVectors(staging, snapshot)
      if (!await deps.verifyVectors(staging, snapshot)) fail('PROJECT_MIGRATION_VECTOR_CONTENT_CHANGED')
      deps.writeManifest(staging, journal.projectId, journal.createdAt)
      const manifest = parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(path.join(staging, 'project.json'), 'utf8')))
      if (manifest.projectId !== journal.projectId || manifest.createdAt !== journal.createdAt
        || manifest.schemaVersion !== 1 || manifest.kind !== 'ai-novel-project' || manifest.storageFormat !== 'ai-novel' || manifest.storageVersion !== 1) fail('PROJECT_MIGRATION_IDENTITY_MISMATCH')
      if (!isDeepStrictEqual(deps.verifySqlite(path.join(staging, deps.databaseName)), targetSchema)) fail('PROJECT_MIGRATION_SQLITE_VERIFICATION_FAILED')
      await deps.closeHandles()
      if (treeFingerprint(source) !== journal.sourceFingerprint) fail('PROJECT_MIGRATION_SOURCE_CHANGED')
      journal.targetSchema = targetSchema; journal.targetFingerprint = treeFingerprint(staging)
      journal.phase = 'verified'; writeJson(journalFile, journal); checkpoint('verified')
    }
    await deps.closeHandles()
    if (!options.exclusiveWriterCheck()) fail('PROJECT_MIGRATION_WRITER_NOT_EXCLUDED')
    if (!journal.targetFingerprint) fail('PROJECT_MIGRATION_TARGET_UNVERIFIED')
    if (fs.existsSync(source)) {
      if (fs.existsSync(backup) || treeFingerprint(source) !== journal.sourceFingerprint) fail('PROJECT_MIGRATION_SOURCE_CHANGED')
      const candidate = fs.existsSync(target) ? target : staging
      if (!fs.existsSync(candidate) || treeFingerprint(candidate) !== journal.targetFingerprint) fail('PROJECT_MIGRATION_TARGET_CHANGED')
      fs.renameSync(source, backup); syncDirectory(root); syncDirectory(control); checkpoint('legacy-renamed')
    }
    if (!fs.existsSync(backup) || treeFingerprint(backup) !== journal.sourceFingerprint) fail('PROJECT_MIGRATION_BACKUP_CHANGED')
    journal.phase = 'legacy-isolated'; writeJson(journalFile, journal); checkpoint('legacy-isolated')
    if (!fs.existsSync(target)) {
      if (!fs.existsSync(staging) || treeFingerprint(staging) !== journal.targetFingerprint) fail('PROJECT_MIGRATION_TARGET_CHANGED')
      fs.renameSync(staging, target); syncDirectory(root); checkpoint('target-renamed')
    }
    if (treeFingerprint(target) !== journal.targetFingerprint || fs.existsSync(source)) fail('PROJECT_MIGRATION_TARGET_CHANGED')
    journal.phase = 'target-installed'; writeJson(journalFile, journal); checkpoint('target-installed')
    deps.verifySqlite(path.join(target, deps.databaseName)); await deps.closeHandles()
    journal.phase = 'switched'; writeJson(journalFile, journal); checkpoint('switched')
    return admit({ state: 'ready', projectId: journal.projectId, migrationId: journal.migrationId, storageRoot: target, backupOnlyCount: journal.backupOnlyCount })
  } catch (error) {
    try { await deps.closeHandles() } catch { /* Fail closed; no root is opened for business. */ }
    const code = error instanceof Error && /^PROJECT_MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'PROJECT_MIGRATION_IO_FAILED'
    return { state: 'blocked', code }
  }
}
