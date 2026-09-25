import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { m05CharacterAssetMigrationAdapter } from '../migrations/m05-character-assets'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../migrations/desktop-registry'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY, createCanonicalProjectManifest, parseCanonicalProjectManifest } from '../../src/shared/project-format'
import { assertProjectStoragePathSupported, type ProjectStoragePreflightOptions } from './project-storage-preflight'
import { CANONICAL_RAW_PROJECT_ASSETS, characterAssetSnapshot } from './project-format-migration'
import { sanitizePortableDatabase } from './project-archive-service'
import { readPortableRuntimeFreeze, type PortableRuntimeFreezeTable } from './portable-runtime-freeze'
import { readPortableCurrentAuthority } from './portable-current-authority'
import { createLegacyCopyTransferAuthority, mapPortableTransferAuthority, serializePortableTransferAuthority } from './portable-transfer-authority'
import { backupProjectSqlite, probeProjectSqlite, verifyProjectSqlite } from './sqlite-project-migration'
import { exportVectorStoreForMigration, importVectorStoreForMigration, verifyVectorStoreForMigration } from './vector-migration-snapshot'

const VECTOR_ASSETS = ['lancedb', 'embedding-spaces.json', 'vectors.json', 'vectors.json.migrated', 'vectors.json.migration-journal.json'] as const
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const RUNTIME_AUTHORITY_TABLES = [
  'recovery_candidates', 'finalization_outbox', 'import_runs', 'chapter_deletion_operations', 'generation_roots',
  'generation_runs', 'generation_attempts', 'generation_artifacts', 'review_cycles',
  'review_findings', 'llm_calls',
] as const
const FROZEN_IDS: readonly [PortableRuntimeFreezeTable, string][] = [
  ['recovery_candidates', 'candidate_id'], ['finalization_outbox', 'finalization_id'], ['import_runs', 'id'],
  ['chapter_deletion_operations', 'operation_id'],
  ['generation_roots', 'root_action_id'], ['generation_runs', 'run_id'], ['generation_attempts', 'attempt_id'],
]
const DATABASE_FILES = ['vela.db', 'vela.db-wal', 'vela.db-shm', 'vela.db-journal'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = (code: string): never => { throw new Error(code) }
const exists = (file: string) => { try { fs.lstatSync(file); return true } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
  throw error
} }
const key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLocaleLowerCase('en-US') : path.resolve(file)
function within(root: string, candidate: string): boolean {
  const relative = path.relative(key(root), key(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function physicalDirectory(directory: string): void {
  let cursor = path.parse(path.resolve(directory)).root
  for (const part of path.resolve(directory).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const info = fs.lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink() || key(fs.realpathSync.native(cursor)) !== key(cursor)) fail('LEGACY_IMPORT_UNSAFE_PATH')
  }
}
function treeHash(root: string): string {
  const digest = createHash('sha256')
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), info = fs.lstatSync(file)
      digest.update(JSON.stringify(path.relative(root, file).split(path.sep).join('/')))
      if (info.isSymbolicLink()) fail('LEGACY_IMPORT_UNSAFE_PATH')
      if (info.isDirectory()) { digest.update('directory'); walk(file) }
      else if (info.isFile() && info.nlink === 1) {
        digest.update('file')
        const fd = fs.openSync(file, 'r')
        try {
          const block = Buffer.allocUnsafe(1024 * 1024)
          let count: number
          while ((count = fs.readSync(fd, block, 0, block.length, null)) > 0) digest.update(block.subarray(0, count))
        } finally { fs.closeSync(fd) }
      } else fail('LEGACY_IMPORT_UNSAFE_PATH')
    }
  }
  physicalDirectory(root); walk(root)
  return digest.digest('hex')
}
function copyTree(source: string, target: string): void {
  const info = fs.lstatSync(source)
  if (info.isSymbolicLink()) fail('LEGACY_IMPORT_UNSAFE_PATH')
  if (info.isDirectory()) {
    fs.mkdirSync(target)
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name))
  } else if (info.isFile() && info.nlink === 1) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  else fail('LEGACY_IMPORT_UNSAFE_PATH')
}
function sameTree(source: string, target: string): void {
  if (fs.lstatSync(source).isFile() && fs.lstatSync(target).isFile()) {
    if (createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== createHash('sha256').update(fs.readFileSync(target)).digest('hex')) fail('LEGACY_IMPORT_COPY_CHANGED')
    return
  }
  if (treeHash(source) !== treeHash(target)) fail('LEGACY_IMPORT_COPY_CHANGED')
}
function hasTransferredRuntimeAuthority(databasePath: string): boolean {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    for (const name of RUNTIME_AUTHORITY_TABLES) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) continue
      if (db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) return true
    }
    return false
  } finally { db.close() }
}

/** Explicit offline import. Caller prompts the user to close the old editor/sync
 * processes, owns the new target choice, and registers the result only on ready.
 * All SQLite/Lance writes occur inside an attempt-owned copy.
 */
export async function importLegacyProjectCopy(options: {
  sourceRoot: string
  targetRoot: string
  /** Native path-limit override for isolated tests. Production leaves this unset. */
  preflightOptions?: ProjectStoragePreflightOptions
  checkpoint?: (phase: string) => void
}): Promise<{ state: 'ready'; projectId: string; targetRoot: string } | { state: 'blocked'; code: string }> {
  let attempt: string | undefined
  let attemptIdentity: fs.BigIntStats | undefined
  try {
    const sourceRoot = path.resolve(options.sourceRoot), targetRoot = path.resolve(options.targetRoot)
    const parent = path.dirname(targetRoot), checkpoint = options.checkpoint ?? (() => {})
    physicalDirectory(sourceRoot); physicalDirectory(parent)
    if (within(sourceRoot, targetRoot) || within(targetRoot, sourceRoot)) fail('LEGACY_IMPORT_PATH_OVERLAP')
    if (exists(targetRoot)) fail('LEGACY_IMPORT_TARGET_EXISTS')
    assertProjectStoragePathSupported(targetRoot, options.preflightOptions)
    const legacyRoot = path.join(sourceRoot, '.vela')
    physicalDirectory(legacyRoot)
    if (exists(path.join(sourceRoot, CANONICAL_PROJECT_DIRECTORY)) || exists(path.join(sourceRoot, '.ai-novel-migration'))) fail('LEGACY_IMPORT_UNSUPPORTED_SOURCE')
    const sourceNames = fs.readdirSync(legacyRoot)
    const allowed = new Set<string>([...DATABASE_FILES, 'project.json', 'avatars', ...CANONICAL_RAW_PROJECT_ASSETS, ...VECTOR_ASSETS])
    if (!sourceNames.includes('vela.db') || sourceNames.some(name => !allowed.has(name))) fail('LEGACY_IMPORT_UNMAPPED_ASSET')
    let sourceProjectId: string | undefined
    const oldManifest = path.join(legacyRoot, 'project.json')
    if (exists(oldManifest)) {
      let parsed: unknown
      try { parsed = JSON.parse(fs.readFileSync(oldManifest, 'utf8')) }
      catch { fail('LEGACY_IMPORT_INVALID_MANIFEST') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('LEGACY_IMPORT_INVALID_MANIFEST')
      const value = parsed as Record<string, unknown>
      if (Object.keys(value).sort().join(',') !== 'createdAt,kind,projectId,schemaVersion'
        || value.schemaVersion !== 1 || value.kind !== 'ai-novel-project'
        || typeof value.projectId !== 'string' || !UUID.test(value.projectId)
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('LEGACY_IMPORT_INVALID_MANIFEST')
      sourceProjectId = value.projectId as string
    }
    const before = treeHash(sourceRoot)
    attempt = fs.mkdtempSync(path.join(parent, `.${path.basename(targetRoot)}.legacy-import-`))
    attemptIdentity = fs.lstatSync(attempt, { bigint: true })
    fs.writeFileSync(path.join(attempt, '.vibe-owner.json'), JSON.stringify({
      owner: 'AI Novel A11 offline import', sourceProject: sourceRoot, createdAt: new Date().toISOString(), ttlHours: 24,
      reason: 'Unpublished target-side copy and conversion attempt',
      cleanupCommand: `Remove-Item -LiteralPath '${attempt.replaceAll("'", "''")}' -Recurse -Force`,
    }), { flag: 'wx' })
    const copiedRoot = path.join(attempt, 'source'), builtRoot = path.join(attempt, 'target')
    copyTree(sourceRoot, copiedRoot)
    sameTree(sourceRoot, copiedRoot)
    if (treeHash(sourceRoot) !== before) fail('LEGACY_IMPORT_SOURCE_CHANGED')
    checkpoint('copied')
    if (treeHash(sourceRoot) !== before) fail('LEGACY_IMPORT_SOURCE_CHANGED')
    fs.mkdirSync(builtRoot)
    for (const name of fs.readdirSync(copiedRoot)) if (name !== '.vela') copyTree(path.join(copiedRoot, name), path.join(builtRoot, name))
    const copiedLegacy = path.join(copiedRoot, '.vela'), storage = path.join(builtRoot, CANONICAL_PROJECT_DIRECTORY)
    fs.mkdirSync(storage)
    const oldDatabase = path.join(copiedLegacy, 'vela.db'), newDatabase = path.join(storage, CANONICAL_PROJECT_DATABASE)
    const originalSchema = probeProjectSqlite({ databasePath: oldDatabase })
    if (originalSchema.schemaVersion !== 0) fail('LEGACY_IMPORT_UNSUPPORTED_SOURCE')
    const migratedSchema = await backupProjectSqlite({ sourceDatabasePath: oldDatabase, targetDatabasePath: newDatabase })
    // The qualified v1.0/v1.1 adapter verifies every old table and column inside backupProjectSqlite.
    if (migratedSchema.schemaVersion !== CURRENT_DESKTOP_SCHEMA_VERSION) fail('LEGACY_IMPORT_SQLITE_CONTENT_CHANGED')
    const hasHistory = hasTransferredRuntimeAuthority(newDatabase)
    checkpoint('sqlite-converted')
    const avatars = characterAssetSnapshot(copiedLegacy)
    const avatarReceipt = await m05CharacterAssetMigrationAdapter.migrate({ sourceSnapshot: avatars, stagingTargetRoot: storage,
      stagingDatabasePath: newDatabase, checkpoint })
    if (avatarReceipt.files.some(file => file.disposition === 'reference-only' || file.disposition === 'ambiguous' || file.disposition === 'unknown-fork')) {
      fail('LEGACY_IMPORT_AVATAR_UNRESOLVED')
    }
    if (!await m05CharacterAssetMigrationAdapter.verify({ sourceSnapshot: avatars, stagingTargetRoot: storage,
      stagingDatabasePath: newDatabase, receipt: avatarReceipt })) fail('LEGACY_IMPORT_AVATAR_INVALID')
    for (const name of CANONICAL_RAW_PROJECT_ASSETS) if (exists(path.join(copiedLegacy, name))) {
      copyTree(path.join(copiedLegacy, name), path.join(storage, name))
      sameTree(path.join(copiedLegacy, name), path.join(storage, name))
    }
    const vectorCopy = path.join(attempt, 'vectors'); fs.mkdirSync(vectorCopy)
    for (const name of VECTOR_ASSETS) if (exists(path.join(copiedLegacy, name))) copyTree(path.join(copiedLegacy, name), path.join(vectorCopy, name))
    const vectors = await exportVectorStoreForMigration({ storageRoot: vectorCopy, originalSourceRoot: copiedLegacy })
    await importVectorStoreForMigration({ targetStorageRoot: storage, snapshot: vectors })
    const verifiedVectors = await verifyVectorStoreForMigration({ storageRoot: storage, snapshot: vectors })
    if (!isDeepStrictEqual(verifiedVectors, vectors.summary)) fail('LEGACY_IMPORT_VECTOR_INVALID')
    checkpoint('assets-converted')
    const projectId = randomUUID()
    if (projectId === sourceProjectId) fail('LEGACY_IMPORT_IDENTITY_INVALID')
    fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt: new Date().toISOString() })), { flag: 'wx' })
    if (parseCanonicalProjectManifest(JSON.parse(fs.readFileSync(path.join(storage, 'project.json'), 'utf8'))).projectId !== projectId) fail('LEGACY_IMPORT_IDENTITY_INVALID')
    if (hasHistory) {
      const snapshotGeneration = randomUUID()
      // Manifest-less legacy projects have no project UUID. Start a new lineage at this
      // target identity rather than attributing historical rows to an inferred source.
      const lineageRootId = sourceProjectId ?? projectId
      const { history } = sanitizePortableDatabase(newDatabase)
      const freeze = { version: 1, originProjectId: lineageRootId, snapshotGeneration,
        nonReplayable: true, requiresRuntimeFreezeGuard: true, records: history, avatarReferenceProjections: [] }
      fs.writeFileSync(path.join(storage, 'portable-runtime-freeze.json'), JSON.stringify(freeze), { flag: 'wx' })
      const db = new Database(newDatabase, { readonly: true, fileMustExist: true })
      try {
        const authority = createLegacyCopyTransferAuthority({ database: db, originProjectId: lineageRootId, snapshotGeneration,
          portableDatabaseSha256: createHash('sha256').update(fs.readFileSync(newDatabase)).digest('hex') })
        fs.writeFileSync(path.join(storage, 'portable-transfer-authority.json'),
          serializePortableTransferAuthority(mapPortableTransferAuthority(authority, projectId)), { flag: 'wx' })
        const guard = readPortableRuntimeFreeze(builtRoot)
        if (!guard.active) fail('LEGACY_IMPORT_HISTORY_FREEZE_INVALID')
        for (const [table, idColumn] of FROZEN_IDS) {
          const ids = db.prepare(`SELECT "${idColumn}" AS id FROM "${table}"`).all() as { id: string }[]
          if (ids.some(({ id }) => !guard.isFrozen(table, id))) fail('LEGACY_IMPORT_HISTORY_FREEZE_INVALID')
        }
        if (!readPortableCurrentAuthority({ database: db, projectStorageRoot: storage, projectId })) fail('LEGACY_IMPORT_HISTORY_AUTHORITY_INVALID')
      } finally { db.close() }
      checkpoint('history-frozen')
    }
    const verifiedSchema = verifyProjectSqlite({ databasePath: newDatabase })
    if (verifiedSchema.fingerprint !== migratedSchema.fingerprint || !hasHistory && !isDeepStrictEqual(
      verifiedSchema.preAssetDomain ?? verifiedSchema.domain, migratedSchema.preAssetDomain ?? migratedSchema.domain,
    )) fail('LEGACY_IMPORT_SQLITE_VERIFICATION_FAILED')
    if (!hasHistory && !await m05CharacterAssetMigrationAdapter.verify({ sourceSnapshot: avatars, stagingTargetRoot: storage,
      stagingDatabasePath: newDatabase, receipt: avatarReceipt })) fail('LEGACY_IMPORT_AVATAR_INVALID')
    for (const name of fs.readdirSync(copiedRoot)) if (name !== '.vela') sameTree(path.join(copiedRoot, name), path.join(builtRoot, name))
    if (treeHash(sourceRoot) !== before) fail('LEGACY_IMPORT_SOURCE_CHANGED')
    if (exists(targetRoot)) fail('LEGACY_IMPORT_TARGET_EXISTS')
    checkpoint('verified')
    fs.renameSync(builtRoot, targetRoot)
    return { state: 'ready', projectId, targetRoot }
  } catch (error) {
    const reported = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    const code = reported === 'PROJECT_STORAGE_PATH_UNSUPPORTED' ? reported
      : error instanceof Error && /^(LEGACY_IMPORT|PROJECT_MIGRATION|VECTOR_MIGRATION|CHARACTER_ASSET|PORTABLE_|MIGRATION_|UNRECOGNIZED_SCHEMA|NEWER_SCHEMA)/.test(error.message)
        ? error.message : 'LEGACY_IMPORT_IO_FAILED'
    return { state: 'blocked', code }
  } finally {
    if (attempt && attemptIdentity) { try {
      const current = fs.lstatSync(attempt, { bigint: true })
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === attemptIdentity.dev && current.ino === attemptIdentity.ino
        && key(fs.realpathSync.native(attempt)) === key(attempt)) fs.rmSync(attempt, { recursive: true, force: true })
    } catch { /* Keep a changed or in-use attempt isolated. */ } }
  }
}
