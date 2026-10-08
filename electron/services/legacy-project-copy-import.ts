import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import * as lancedb from '@lancedb/lancedb'
import { KNOWLEDGE_COPY_MARKER, readKnowledgeCopy, writeKnowledgeCopy } from '../vector-store'
import { m05CharacterAssetMigrationAdapter } from '../migrations/m05-character-assets'
import { CharacterRosterRepository } from '../repositories/character-roster-repository'
import { adoptLegacyCards, readLegacyRosterSource } from './legacy-roster-source'
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
    if (db.prepare("SELECT 1 FROM drafts WHERE status='finalized' LIMIT 1").get()) return true
    for (const name of RUNTIME_AUTHORITY_TABLES) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) continue
      if (db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) return true
    }
    return false
  } finally { db.close() }
}

/** A11 keeps readable call history without transferring model configuration or raw errors. */
function captureLegacyCalls(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`SELECT id,prompt_tokens,completion_tokens,total_tokens,duration_ms,success,created_at
      FROM llm_calls ORDER BY id`).all() as Array<{
      id: number; prompt_tokens: number | null; completion_tokens: number | null
      total_tokens: number | null; duration_ms: number; success: number; created_at: string
    }>
  } finally { db.close() }
}

function restoreSafeLegacyDiagnostics(databasePath: string, calls: ReturnType<typeof captureLegacyCalls>): void {
  const db = new Database(databasePath, { fileMustExist: true })
  try {
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO llm_calls
        (id,model_id,model_name,purpose,prompt_tokens,completion_tokens,total_tokens,duration_ms,success,error_message,created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const call of calls) {
        const count = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
        if (!Number.isSafeInteger(call.id) || call.id < 1 || !count(call.prompt_tokens)
          || !count(call.completion_tokens) || !count(call.total_tokens) || !count(call.duration_ms)
          || ![0, 1].includes(call.success)) fail('LEGACY_IMPORT_HISTORY_INVALID')
        insert.run(call.id, '', '旧版模型身份不可用', 'legacy',
          call.prompt_tokens, call.completion_tokens, call.total_tokens, call.duration_ms, call.success,
          call.success ? '' : '旧版错误详情不可用',
          typeof call.created_at === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(call.created_at) ? call.created_at : '')
      }
      db.prepare(`UPDATE post_process_steps SET error_msg='旧版错误详情不可用'
        WHERE error_msg IS NULL AND ok=0 AND attempt_count>0`).run()
    })()
  } finally { db.close() }
}

/** Adopt only complete originals already inside the copied legacy project. */
async function adoptLegacyKnowledgeOriginals(sourceRoot: string, copiedRoot: string, builtRoot: string, storage: string): Promise<void> {
  const directory = path.join(storage, 'lancedb')
  if (!exists(directory)) return
  const connection = await lancedb.connect(directory)
  try {
    if (!(await connection.tableNames()).includes('documents')) return
    const table = await connection.openTable('documents')
    try {
      const rows = await table.query().select(['id', 'filePath']).toArray() as Array<{ id: string; filePath: string }>
      const expected = new Map<string, string>()
      for (const { id, filePath } of rows) {
        let targetPath = ''
        if (filePath !== '') {
          if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !within(sourceRoot, filePath)
            || !/\.(?:txt|md|markdown)$/iu.test(filePath)) fail('LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_UNAVAILABLE')
          const relative = path.relative(sourceRoot, filePath)
          const copiedFile = path.join(copiedRoot, relative)
          if (!exists(copiedFile)) fail('LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_UNAVAILABLE')
          const parts = relative.split(path.sep)
          const targetFile = parts[0]?.toLowerCase() === '.vela'
            ? path.join(storage, ...parts.slice(1)) : path.join(builtRoot, relative)
          const info = fs.lstatSync(copiedFile)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_INVALID')
          sameTree(copiedFile, targetFile)
          const content = fs.readFileSync(copiedFile, 'utf8')
          writeKnowledgeCopy(storage, id, { content,
            indexedHash: createHash('sha256').update(content, 'utf8').digest('hex'), edited: false,
            indexDirty: true })
          targetPath = `${KNOWLEDGE_COPY_MARKER}${id}`
          const copy = readKnowledgeCopy(storage, id)
          if (!copy || copy.content !== content || !copy.indexDirty) fail('LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_INVALID')
        }
        expected.set(id, targetPath)
        if (filePath !== targetPath) await table.update({ where: `id = '${id.replaceAll("'", "''")}'`, values: { filePath: targetPath } })
      }
      const actual = await table.query().select(['id', 'filePath']).toArray() as Array<{ id: string; filePath: string }>
      if (actual.length !== expected.size || actual.some(row => expected.get(row.id) !== row.filePath)) {
        fail('LEGACY_IMPORT_KNOWLEDGE_ORIGINAL_INVALID')
      }
    } finally { table.close() }
  } finally { connection.close() }
}

/** Only the qualified offline copy has the old primary-key rows as target authority. */
async function adoptCopiedLegacyCards(db: import('better-sqlite3').Database, oldDatabase: string): Promise<void> {
  const initial = readLegacyRosterSource(db)
  const readySource = initial.snapshot.migrationState === 'ready'
  if ((!readySource && initial.snapshot.migrationState !== 'legacy_cards_preserved') || initial.rawLegacy.trim()
    || (readySource && initial.snapshot.status === 'ready')) return
  const old = new Database(oldDatabase, { readonly: true, fileMustExist: true })
  let rosterCheck: import('better-sqlite3').Database | undefined
  let rosterCheckPath: string | undefined
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const serialize = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { integer: item.toString() } : item)
  const reject = () => fail('LEGACY_IMPORT_ROSTER_UNAVAILABLE')
  try {
    if (readySource && !(old.prepare('PRAGMA table_info(characters)').all() as { name: string }[])
      .some(column => column.name === 'cs_provenance')) {
      // Qualified v1.0 lacks this later column. Reuse the full roster validator
      // on a disposable snapshot so its legacy DDL cannot write the old copy.
      rosterCheckPath = path.join(path.dirname(oldDatabase), `.roster-check-${randomUUID()}.db`)
      await old.backup(rosterCheckPath)
      rosterCheck = new Database(rosterCheckPath, { fileMustExist: true })
    }
    db.transaction(() => {
      if (readySource && CharacterRosterRepository.read(rosterCheck ?? old).status !== 'ready') reject()
      const rows = old.prepare('SELECT * FROM characters ORDER BY rowid').safeIntegers().all() as Record<string, unknown>[]
      const origins = db.prepare('SELECT * FROM character_identity_origins').all() as {
        character_id: string; source_key: string; original_row_json: string; original_hash: string
      }[]
      if (!rows.length || rows.length !== origins.length || rows.length !== initial.activeIds.length
        || initial.identityRevision !== 0 || db.prepare('SELECT 1 FROM character_relationships LIMIT 1').get()) reject()
      const mapped = rows.map((row, index) => {
        const origin = origins.find(item => item.source_key === `legacy:characters:${index}`)
        // The qualified v1.0 adapter adds this empty provenance column before M02.
        const original = JSON.parse(serialize({ ...row, cs_provenance: 'cs_provenance' in row ? row.cs_provenance : '{}' })) as unknown
        if (!origin || !isDeepStrictEqual(JSON.parse(origin.original_row_json), original) || origin.original_hash !== hash(origin.original_row_json)
          || typeof row.name !== 'string' || !row.name.trim()) return reject()
        const current = db.prepare('SELECT * FROM characters WHERE character_id=?').safeIntegers().get(origin.character_id) as Record<string, unknown>
        if (!current || current.legacy_key !== row.name || current.retired !== 0n
          || Object.keys(row).some(column => current[column] !== row[column])) reject()
        return { ...origin, name: row.name, relationships: row.relationships }
      })
      const byName = new Map(mapped.map(row => [row.name, row]))
      if (byName.size !== rows.length) reject()
      const proposals = db.prepare('SELECT * FROM character_identity_proposals').all() as {
        proposal_id: string; owner_character_id: string | null; source_key: string; source_hash: string;
        raw_value: string; candidate_ids_json: string; resolved_character_id: string | null; approval_id: string | null
      }[]
      const bindings: { proposalId: string; sourceKey: string; sourceHash: string; targetId: string;
        ownerId: string | null; relation?: string; sourceName?: string; targetName: string }[] = []
      const checked = new Set<string>()
      const checkProposal = (sourceKey: string, sourceHash: string, raw: string, ownerId: string | null, targetName: string | undefined) => {
        const matches = proposals.filter(item => item.source_key === sourceKey)
        const target = targetName === undefined ? undefined : byName.get(targetName)
        const proposal = matches[0]
        if (matches.length !== 1 || !proposal || proposal.owner_character_id !== ownerId || proposal.source_hash !== sourceHash
          || proposal.raw_value !== raw || proposal.resolved_character_id !== null || proposal.approval_id !== null
          || proposal.candidate_ids_json !== JSON.stringify(target ? [target.character_id] : [])) return reject()
        checked.add(proposal.proposal_id)
        return target ? { proposalId: proposal.proposal_id, sourceKey, sourceHash, targetId: target.character_id,
          ownerId, targetName: target.name } : undefined
      }
      for (const row of mapped) {
        let edges: unknown
        try { edges = row.relationships === '' ? [] : JSON.parse(row.relationships as string) } catch { return reject() }
        if (!Array.isArray(edges)) return reject()
        const targets = new Set<string>()
        for (const [index, edge] of edges.entries()) {
          if (!edge || typeof edge !== 'object' || Array.isArray(edge)
            || Object.keys(edge).sort().join(',') !== 'relation,target'
            || typeof edge.target !== 'string' || !edge.target.trim() || !byName.has(edge.target)
            || edge.target === row.name || targets.has(edge.target)
            || typeof edge.relation !== 'string' || !edge.relation.trim()) return reject()
          targets.add(edge.target)
          const binding = checkProposal(`${row.source_key}:relationships:${index}`, hash(row.relationships as string),
            JSON.stringify(edge), row.character_id, edge.target)!
          bindings.push({ ...binding, relation: edge.relation, sourceName: row.name })
        }
      }
      // Chapter planning names are preserved verbatim; only exact old roster keys bind.
      const blueprints = old.prepare('SELECT chapter_number,characters FROM blueprints').all() as { chapter_number: number; characters: string }[]
      for (const blueprint of blueprints) {
        if (!blueprint.characters) continue
        let names: unknown[]
        try { const parsed: unknown = JSON.parse(blueprint.characters); names = Array.isArray(parsed) ? parsed : [blueprint.characters] }
        catch { names = [blueprint.characters] }
        for (const [index, name] of names.entries()) {
          const binding = checkProposal(`legacy:blueprints:${blueprint.chapter_number}:characters:${index}`, hash(blueprint.characters),
            typeof name === 'string' ? name : JSON.stringify(name), null, typeof name === 'string' ? name : undefined)
          if (binding) bindings.push(binding)
        }
      }
      if (checked.size !== proposals.length) reject()
      const operationId = 'legacy-offline-identity-binding'
      const receipt = JSON.stringify({ version: 1, kind: 'legacy-offline-identity-binding',
        origins: mapped.map(row => ({ characterId: row.character_id, sourceKey: row.source_key, originalHash: row.original_hash })), bindings })
      db.prepare('INSERT INTO character_identity_approvals VALUES(?,?,?)').run(operationId, hash(receipt), receipt)
      for (const binding of bindings) {
        db.prepare('UPDATE character_identity_proposals SET resolved_character_id=?,approval_id=? WHERE proposal_id=?')
          .run(binding.targetId, operationId, binding.proposalId)
        if (binding.ownerId) db.prepare('INSERT INTO character_relationships VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),
          binding.ownerId, binding.targetId, binding.relation, binding.sourceName, binding.targetName,
          JSON.stringify({ kind: 'legacy', sourceKey: binding.sourceKey, sourceHash: binding.sourceHash, migration: 'offline-project-copy' }), operationId)
      }
      const source = readLegacyRosterSource(db)
      if (readySource) {
        if (source.snapshot.migrationState !== 'ready' || source.snapshot.status !== 'ready') reject()
      } else adoptLegacyCards(db, { operationId: 'offline-project-copy', expectedRevision: source.snapshot.revision,
        expectedLegacyHash: source.legacyHash, expectedIdentityRevision: source.identityRevision, expectedFactsHash: source.factsHash })
    }).immediate()
  } finally {
    rosterCheck?.close()
    old.close()
    if (rosterCheckPath) for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(rosterCheckPath + suffix, { force: true })
  }
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
  let preserveAttempt = false
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
    await adoptLegacyKnowledgeOriginals(sourceRoot, copiedRoot, builtRoot, storage)
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
      const legacyCalls = captureLegacyCalls(newDatabase)
      const { history } = sanitizePortableDatabase(newDatabase)
      restoreSafeLegacyDiagnostics(newDatabase, legacyCalls)
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
    const rosterDb = new Database(newDatabase, { fileMustExist: true })
    try {
      rosterDb.pragma('foreign_keys = ON')
      try { await adoptCopiedLegacyCards(rosterDb, oldDatabase) } catch (error) {
        if (error instanceof Error && error.message === 'LEGACY_IMPORT_ROSTER_UNAVAILABLE') preserveAttempt = true
        throw error
      }
      const roster = CharacterRosterRepository.read(rosterDb)
      if (!(
        roster.migrationState === 'empty' && roster.status === 'empty' && roster.entries.length === 0 && !roster.legacyMarkdown?.trim()
        || roster.migrationState === 'ready' && roster.status === 'ready' && roster.entries.length > 0
      )) { preserveAttempt = true; fail('LEGACY_IMPORT_ROSTER_UNAVAILABLE') }
    } finally { rosterDb.close() }
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
    if (attempt && attemptIdentity && !preserveAttempt) { try {
      const current = fs.lstatSync(attempt, { bigint: true })
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === attemptIdentity.dev && current.ino === attemptIdentity.ino
        && key(fs.realpathSync.native(attempt)) === key(attempt)) fs.rmSync(attempt, { recursive: true, force: true })
    } catch { /* Keep a changed or in-use attempt isolated. */ } }
  }
}
