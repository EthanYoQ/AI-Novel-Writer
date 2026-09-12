import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { createRequire } from 'node:module'
import * as lance from '@lancedb/lancedb'
import { Field, Schema, Utf8, Int32 } from 'apache-arrow'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { probeProjectSqlite, backupProjectSqlite, verifyProjectSqlite } from '../sqlite-project-migration'
import { exportVectorStoreForMigration, importVectorStoreForMigration, verifyVectorStoreForMigration, type VectorMigrationSnapshot } from '../vector-migration-snapshot'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeSyntheticProjectMigration, isAdmittedProjectMigration, migrateProjectFormat, type ProjectMigrationDependencies, type ProjectSqliteEvidence } from '../project-format-migration'

const roots: string[] = []
function put(file: string, data: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-fixtures'); fs.mkdirSync(base, { recursive: true })
  const fixtureRoot = fs.mkdtempSync(path.join(base, 'p-')); roots.push(fixtureRoot)
  const projectRoot = path.join(fixtureRoot, 'project'), projectId = randomUUID(), legacy = path.join(projectRoot, '.vela')
  put(path.join(legacy, 'vela.db'), 'synthetic author text\r\n原文')
  put(path.join(legacy, 'project.json'), JSON.stringify({ schemaVersion: 1, kind: 'ai-novel-project', projectId, createdAt: '2026-09-13T00:00:00.000Z' }))
  put(path.join(legacy, 'prompts/author.txt'), '作者模板')
  put(path.join(legacy, 'partial_arch/candidate.txt'), '未采用候选')
  put(path.join(legacy, 'partial_arch.json'), '{"draft":"未采用原始候选"}')
  put(path.join(legacy, 'chapter_creation_log.json'), '{"chapterNumber":3,"userGuidance":"作者上次参数"}')
  put(path.join(legacy, 'unknown.txt'), 'preserved only')
  const evidence = (database: string, schemaVersion: number): ProjectSqliteEvidence => ({ schemaVersion, fingerprint: `fixture-schema-${schemaVersion}`,
    domain: { tableCounts: { contents: 1 }, authorContentHash: createHash('sha256').update(fs.readFileSync(database)).digest('hex') },
    ...(schemaVersion === 3 ? { preIdentityDomain: { tableCounts: { contents: 1 }, authorContentHash: createHash('sha256').update(fs.readFileSync(database)).digest('hex') } } : {}) })
  // This suite validates coordination with deterministic adapters; real SQLite/WAL/Lance tests are separate.
  const dependencies: ProjectMigrationDependencies<{ empty: true }> = {
    databaseName: 'project.db', closeHandles: async () => {},
    probeSqlite: file => evidence(file, 0),
    backupSqlite: async (source, target) => { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); return evidence(target, CURRENT_DESKTOP_SCHEMA_VERSION) },
    verifySqlite: file => evidence(file, CURRENT_DESKTOP_SCHEMA_VERSION),
    exportVectors: async () => ({ empty: true }), importVectors: async () => {}, verifyVectors: async () => true,
    writeManifest: (storageRoot, id) => put(path.join(storageRoot, 'project.json'), JSON.stringify({ schemaVersion: 1, kind: 'ai-novel-project', projectId: id,
      createdAt: '2026-09-13T00:00:00.000Z', storageFormat: 'ai-novel', storageVersion: 1 })),
  }
  return { fixtureRoot, legacy, projectRoot, projectId, dependencies, permit: authorizeSyntheticProjectMigration(fixtureRoot),
    exclusiveWriterCheck: () => true, preflightOptions: { maxNativePathCharacters: 4096 } }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('fixture-only project physical cutover', () => {
  it('requires a real process-local synthetic permit and writer exclusion', async () => {
    const options = fixture()
    expect(await migrateProjectFormat({ ...options, permit: undefined })).toMatchObject({ code: 'PROJECT_MIGRATION_NOT_QUALIFIED' })
    expect(await migrateProjectFormat({ ...options, exclusiveWriterCheck: () => false })).toMatchObject({ code: 'PROJECT_MIGRATION_WRITER_NOT_EXCLUDED' })
    expect(fs.existsSync(path.join(options.projectRoot, '.ai-novel'))).toBe(false)
  })
  it('preserves identity and raw content, isolates the entire old root and retains unknown assets', async () => {
    const options = fixture(), raw = fs.readFileSync(path.join(options.legacy, 'vela.db'))
    const result = await migrateProjectFormat(options)
    expect(result).toMatchObject({ state: 'ready', projectId: options.projectId, backupOnlyCount: 1 })
    if (result.state !== 'ready') throw new Error('fixture failed')
    expect(isAdmittedProjectMigration(result)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(isAdmittedProjectMigration({ ...result })).toBe(false)
    expect(fs.existsSync(options.legacy)).toBe(false)
    expect(fs.readFileSync(path.join(result.storageRoot, 'project.db'))).toEqual(raw)
    expect(fs.readFileSync(path.join(result.storageRoot, 'prompts/author.txt'), 'utf8')).toBe('作者模板')
    expect(fs.existsSync(path.join(result.storageRoot, 'unknown.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(result.storageRoot, 'partial_arch.json'), 'utf8')).toBe('{"draft":"未采用原始候选"}')
    expect(fs.readFileSync(path.join(result.storageRoot, 'chapter_creation_log.json'), 'utf8')).toBe('{"chapterNumber":3,"userGuidance":"作者上次参数"}')
    expect(fs.readFileSync(path.join(options.projectRoot, '.ai-novel-migration', `${result.migrationId}.legacy`, 'unknown.txt'), 'utf8')).toBe('preserved only')
  })
  it('retains completed legacy vector archive as backup-only without replaying or copying it into canonical storage', async () => {
    const options = fixture()
    put(path.join(options.legacy, 'vectors.json.migrated'), '{"historicalReceipt":"preserve exact bytes"}')
    const original = fs.readFileSync(path.join(options.legacy, 'vectors.json.migrated'))
    const result = await migrateProjectFormat(options)
    expect(result).toMatchObject({ state: 'ready', backupOnlyCount: 2 })
    if (result.state !== 'ready') throw new Error('fixture failed')
    expect(fs.existsSync(path.join(result.storageRoot, 'vectors.json.migrated'))).toBe(false)
    expect(fs.readFileSync(path.join(options.projectRoot, '.ai-novel-migration', `${result.migrationId}.legacy`, 'vectors.json.migrated'))).toEqual(original)
  })
  it.each(['prepared', 'sqlite-backed-up', 'asset:prompts', 'verified', 'legacy-renamed', 'legacy-isolated', 'target-renamed', 'target-installed', 'switched'])('recovers after %s using physical facts', async stage => {
    const options = fixture()
    expect(await migrateProjectFormat({ ...options, checkpoint: current => { if (current === stage) throw new Error('fixture interruption') } })).toMatchObject({ state: 'blocked' })
    const recovered = await migrateProjectFormat(options)
    expect(recovered, recovered.state === 'blocked' ? recovered.code : 'ready').toMatchObject({ state: 'ready' })
    expect(fs.existsSync(options.legacy)).toBe(false)
  })
  it('rejects unknown dual roots and changed source after verification', async () => {
    const options = fixture()
    fs.mkdirSync(path.join(options.projectRoot, '.ai-novel'))
    expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_UNKNOWN_TARGET' })
    const next = fixture()
    await migrateProjectFormat({ ...next, checkpoint: stage => { if (stage === 'verified') throw new Error('fixture interruption') } })
    put(path.join(next.legacy, 'vela.db'), 'new author write')
    expect(await migrateProjectFormat(next)).toMatchObject({ code: 'PROJECT_MIGRATION_SOURCE_CHANGED' })
    expect(fs.readFileSync(path.join(next.legacy, 'vela.db'), 'utf8')).toBe('new author write')
  })
  it('restores a verified isolated backup only when no target or staging remains', async () => {
    const options = fixture()
    await migrateProjectFormat({ ...options, checkpoint: stage => { if (stage === 'legacy-isolated') throw new Error('fixture interruption') } })
    const control = path.join(options.projectRoot, '.ai-novel-migration')
    const journal = JSON.parse(fs.readFileSync(path.join(control, 'journal.json'), 'utf8'))
    fs.rmSync(path.join(control, `${journal.migrationId}.staging`), { recursive: true })
    expect(await migrateProjectFormat(options)).toMatchObject({ state: 'restored' })
    expect(fs.existsSync(path.join(options.legacy, 'vela.db'))).toBe(true)
  })
  it('never restores the backup or reimports it after canonical author writes', async () => {
    const options = fixture(), result = await migrateProjectFormat(options)
    if (result.state !== 'ready') throw new Error('fixture failed')
    put(path.join(result.storageRoot, 'project.db'), 'new canonical author text')
    expect(await migrateProjectFormat(options)).toMatchObject({ state: 'ready' })
    expect(fs.readFileSync(path.join(result.storageRoot, 'project.db'), 'utf8')).toBe('new canonical author text')
    fs.mkdirSync(options.legacy)
    expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_SWITCH_CONFLICT' })
  })
  it('blocks required hardlinks without altering the outside inode', async () => {
    const options = fixture(), sentinel = path.join(options.fixtureRoot, 'sentinel')
    put(sentinel, 'outside author')
    fs.linkSync(sentinel, path.join(options.legacy, 'prompts/link.txt'))
    expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_UNSAFE_FILE' })
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside author')
    expect(fs.existsSync(options.legacy)).toBe(true)
  })
  it('recognizes a verified installed target with the old discovery root still present, then isolates first', async () => {
    const options = fixture()
    await migrateProjectFormat({ ...options, checkpoint: stage => { if (stage === 'verified') throw new Error('fixture interruption') } })
    const control = path.join(options.projectRoot, '.ai-novel-migration')
    const journal = JSON.parse(fs.readFileSync(path.join(control, 'journal.json'), 'utf8'))
    fs.cpSync(path.join(control, `${journal.migrationId}.staging`), path.join(options.projectRoot, '.ai-novel'), { recursive: true, errorOnExist: true, force: false })
    expect(await migrateProjectFormat(options)).toMatchObject({ state: 'ready' })
    expect(fs.existsSync(options.legacy)).toBe(false)
  })
  it('refuses a changed target and revoked writer exclusion before the first physical rename', async () => {
    const options = fixture()
    await migrateProjectFormat({ ...options, checkpoint: stage => { if (stage === 'verified') throw new Error('fixture interruption') } })
    const control = path.join(options.projectRoot, '.ai-novel-migration')
    const journal = JSON.parse(fs.readFileSync(path.join(control, 'journal.json'), 'utf8'))
    put(path.join(control, `${journal.migrationId}.staging`, 'project.db'), 'tampered staging')
    expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_TARGET_CHANGED' })
    expect(fs.existsSync(options.legacy)).toBe(true)
    const next = fixture(); let checks = 0
    expect(await migrateProjectFormat({ ...next, exclusiveWriterCheck: () => ++checks === 1 })).toMatchObject({ code: 'PROJECT_MIGRATION_WRITER_NOT_EXCLUDED' })
    expect(fs.existsSync(next.legacy)).toBe(true)
  })
  it('blocks unknown schema and content mismatch without creating a canonical discovery root', async () => {
    const options = fixture()
    options.dependencies.probeSqlite = () => { throw new Error('UNKNOWN_SCHEMA') }
    expect(await migrateProjectFormat(options)).toMatchObject({ state: 'blocked' })
    expect(fs.existsSync(path.join(options.projectRoot, '.ai-novel-migration'))).toBe(false)
    const next = fixture(), backup = next.dependencies.backupSqlite
    next.dependencies.backupSqlite = async (...args) => { const result = await backup(...args); return { ...result, preIdentityDomain: { ...result.domain, authorContentHash: 'wrong' } } }
    expect(await migrateProjectFormat(next)).toMatchObject({ code: 'PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED' })
    expect(fs.existsSync(next.legacy)).toBe(true)
  })
  it('rejects required directory junctions before importing their external contents', async () => {
    const options = fixture(), outside = path.join(options.fixtureRoot, 'outside'); fs.mkdirSync(outside)
    put(path.join(outside, 'sentinel'), 'untouched')
    fs.symlinkSync(outside, path.join(options.legacy, 'skills'), 'junction')
    expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_REQUIRED_ASSET_LINK' })
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('untouched')
  })
})

it('integrates real WAL SQLite and Lance text while preserving every source byte through cutover', async () => {
  const options = fixture()
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
  const seedFile = path.join(options.fixtureRoot, 'seed.db')
  const seed = new Database(seedFile)
  try {
    seed.pragma('journal_mode = WAL'); seed.pragma('wal_autocheckpoint = 0')
    initializeLegacyBaselineSchema(seed)
    seed.prepare('INSERT INTO contents(body) VALUES (?)').run('作者原文\r\n保留段落。')
    seed.prepare('INSERT INTO drafts(chapter_number,version,content_id,word_count) VALUES (1,1,1,777)').run()
    // Freeze a physical synthetic WAL set, then release the seed writer. No original-source SQLite handle is opened.
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(seedFile + suffix, path.join(options.legacy, 'vela.db') + suffix)
  } finally { seed.close() }
  const connection = await lance.connect(path.join(options.legacy, 'lancedb'))
  const tables: lance.Table[] = []
  try {
    const fields = [new Field('id', new Utf8()), new Field('docId', new Utf8()), new Field('fileName', new Utf8()), new Field('text', new Utf8()), new Field('chunkIndex', new Int32()), new Field('totalChunks', new Int32()), new Field('importedAt', new Utf8()), new Field('corpusKind', new Utf8())]
    tables.push(await connection.createTable('chunks', [{ id: 'chunk', docId: 'doc', fileName: '已删除.pdf', text: '铜钥匙藏在旧钟后面。', chunkIndex: 0, totalChunks: 1, importedAt: '2026-09-13', corpusKind: 'reference' }], { schema: new Schema(fields) }))
    tables.push(await connection.createTable('documents', [{ id: 'doc', fileName: '已删除.pdf', filePath: 'missing-fixture.pdf', importedAt: '2026-09-13', chunkCount: 1, corpusKind: 'reference' }]))
  } finally { for (const table of tables) table.close(); connection.close() }
  put(path.join(options.legacy, 'vectors.json.migrated'), 'old archive; never replay')
  const fingerprints = (root: string): Record<string, string> => {
    const result: Record<string, string> = {}
    const walk = (dir: string) => { for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    } }
    walk(root); return result
  }
  const before = fingerprints(options.legacy)
  expect(fs.statSync(path.join(options.legacy, 'vela.db-wal')).size).toBeGreaterThan(0)
  const dependencies: ProjectMigrationDependencies<VectorMigrationSnapshot> = {
    databaseName: 'project.db', closeHandles: async () => {}, // All fixture-native handles were explicitly closed above.
    probeSqlite: databasePath => probeProjectSqlite({ databasePath }),
    backupSqlite: (sourceDatabasePath, targetDatabasePath) => backupProjectSqlite({ sourceDatabasePath, targetDatabasePath }),
    verifySqlite: databasePath => verifyProjectSqlite({ databasePath }),
    exportVectors: (storageRoot, originalSourceRoot) => exportVectorStoreForMigration({ storageRoot, originalSourceRoot }),
    importVectors: async (targetStorageRoot, snapshot) => { await importVectorStoreForMigration({ targetStorageRoot, snapshot }) },
    verifyVectors: async (storageRoot, snapshot) => { expect(await verifyVectorStoreForMigration({ storageRoot, snapshot })).toEqual(snapshot.summary); return true },
    writeManifest: (storageRoot, projectId, createdAt) => put(path.join(storageRoot, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId, createdAt }))),
  }
  const result = await migrateProjectFormat({ ...options, dependencies })
  expect(result).toMatchObject({ state: 'ready', backupOnlyCount: 2 })
  if (result.state !== 'ready') throw new Error('real fixture did not migrate')
  expect(fingerprints(path.join(options.projectRoot, '.ai-novel-migration', `${result.migrationId}.legacy`))).toEqual(before)
  const db = new Database(path.join(result.storageRoot, 'project.db'), { readonly: true })
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('作者原文\r\n保留段落。')
    expect(db.prepare('SELECT word_count FROM drafts').pluck().get()).toBe(777)
  } finally { db.close() }
  const targetConnection = await lance.connect(path.join(result.storageRoot, 'lancedb'))
  const targetTable = await targetConnection.openTable('chunks')
  try { expect(await targetTable.query().where("text LIKE '%铜钥匙%'").toArray()).toHaveLength(1) }
  finally { targetTable.close(); targetConnection.close() }
})
it.each(['manifest-id', 'manifest-createdAt', 'manifest-schema', 'journal-root'])('refuses changed switched identity: %s', async mode => {
  const options = fixture()
  expect(await migrateProjectFormat(options)).toMatchObject({ state: 'ready' })
  const file = mode === 'journal-root' ? path.join(options.projectRoot, '.ai-novel-migration/journal.json') : path.join(options.projectRoot, '.ai-novel/project.json')
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (mode === 'manifest-id') value.projectId = randomUUID()
  if (mode === 'manifest-createdAt') value.createdAt = '2020-01-01T00:00:00.000Z'
  if (mode === 'manifest-schema') value.storageVersion = 999
  if (mode === 'journal-root') value.sourceRoot = path.join(options.fixtureRoot, 'other-project')
  fs.writeFileSync(file, JSON.stringify(value))
  expect(await migrateProjectFormat(options)).toMatchObject({ state: 'blocked' })
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(value)
})
it('rechecks restored physical state without overwriting later author edits', async () => {
  const options = fixture()
  await migrateProjectFormat({ ...options, checkpoint: stage => { if (stage === 'legacy-isolated') throw new Error('interruption') } })
  const control = path.join(options.projectRoot, '.ai-novel-migration')
  const journal = JSON.parse(fs.readFileSync(path.join(control, 'journal.json'), 'utf8'))
  fs.rmSync(path.join(control, `${journal.migrationId}.staging`), { recursive: true })
  expect(await migrateProjectFormat(options)).toMatchObject({ state: 'restored' })
  put(path.join(options.legacy, 'vela.db'), 'later author edit')
  expect(await migrateProjectFormat(options)).toMatchObject({ state: 'restored' })
  expect(fs.readFileSync(path.join(options.legacy, 'vela.db'), 'utf8')).toBe('later author edit')
  fs.renameSync(options.legacy, path.join(options.projectRoot, 'moved-source'))
  expect(await migrateProjectFormat(options)).toMatchObject({ code: 'PROJECT_MIGRATION_RESTORE_CONFLICT' })
})

it.each(['missing-old-projection', 'changed-current-domain'] as const)('refuses %s in a schema3 conversion receipt', async mode => {
  const options = fixture(), backup = options.dependencies.backupSqlite
  options.dependencies.backupSqlite = async (...args) => {
    const result = await backup(...args)
    if (mode === 'missing-old-projection') { const copy = { ...result }; delete copy.preIdentityDomain; return copy }
    return { ...result, domain: { ...result.domain, authorContentHash: 'wrong-current-domain' } }
  }
  const result = await migrateProjectFormat(options)
  expect(result).toMatchObject({ state: 'blocked', code: mode === 'missing-old-projection' ? 'PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED' : 'PROJECT_MIGRATION_SQLITE_VERIFICATION_FAILED' })
  expect(fs.existsSync(options.legacy)).toBe(true)
  expect(fs.existsSync(path.join(options.projectRoot, '.ai-novel'))).toBe(false)
})
