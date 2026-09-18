import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getCurrentProjectPath, getProjectDb, initProjectDatabase, onProjectDatabaseBeforeClose } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { createMigrationRegistry } from '../../migrations/registry'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { getProjectDataRoot } from '../project-data-locator'
import { backupProjectSqlite, probeProjectSqlite, upgradeProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const unsubscribers: Array<() => void> = []
function fixture(version: 1 | 'current' = 1) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s05-m01')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '项目-')); roots.push(root)
  const data = path.join(root, '.ai-novel'); fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() })))
  const file = path.join(data, 'project.db')
  if (version === 'current') createProjectDatabase(root)
  else {
    const db = new Database(file)
    try { initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 1) } finally { db.close() }
  }
  const db = new Database(file)
  try { db.prepare('INSERT INTO contents(body) VALUES (?)').run('铜钥匙\r\n作者原文'); db.exec('INSERT INTO drafts(chapter_number,version,content_id,word_count) VALUES(1,1,1,777)') } finally { db.close() }
  return { root, data, file }
}
afterEach(() => {
  for (const unsub of unsubscribers.splice(0)) unsub()
  closeProjectDatabase(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
it('真实version1文件经唯一M01升级，关闭重开不重跑且正文不变', () => {
  const f = fixture(); const before = probeProjectSqlite({ databasePath: f.file })
  expect(before.schemaVersion).toBe(1)
  expect(() => getProjectDataRoot(f.root)).toThrow('NOT_READY')
  initProjectDatabase(f.root)
  expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  expect(getProjectDb()!.prepare('SELECT body FROM contents').pluck().get()).toBe('铜钥匙\r\n作者原文')
  expect(getProjectDb()!.prepare('SELECT count(*) FROM generation_runs').pluck().get()).toBe(0)
  closeProjectDatabase()
  const upgraded = probeProjectSqlite({ databasePath: f.file }); expect(upgraded.preIdentityDomain).toEqual(before.domain)
  initProjectDatabase(f.root); closeProjectDatabase()
  expect(probeProjectSqlite({ databasePath: f.file })).toEqual(upgraded)
})
it('新建项目与S04备份默认均到当前schema，M00可显式停在1', async () => {
  const f = fixture('current'); expect(probeProjectSqlite({ databasePath: f.file }).schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  const old = fixture(); const bytes = fs.readFileSync(old.file)
  const result = await backupProjectSqlite({ sourceDatabasePath: old.file, targetDatabasePath: path.join(old.root, '副本.db') })
  expect(result.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION); expect(fs.readFileSync(old.file)).toEqual(bytes)
})
it.each(['unknown', 'higher', 'missing-manifest'] as const)('%s在任何迁移写入前拒绝，源字节不变', mode => {
  const f = fixture()
  if (mode === 'missing-manifest') fs.unlinkSync(path.join(f.data, 'project.json'))
  else { const db = new Database(f.file); try { if (mode === 'higher') db.pragma('user_version = 999'); else db.exec('ALTER TABLE contents ADD COLUMN unknown_fork TEXT') } finally { db.close() } }
  const bytes = fs.readFileSync(f.file)
  expect(() => initProjectDatabase(f.root)).toThrow()
  expect(fs.readFileSync(f.file)).toEqual(bytes); expect(getProjectDb()).toBeNull()
  expect(() => getProjectDataRoot(f.root)).toThrow('NOT_READY')
})
it('M01途中失败整步回滚，真实文件版本与schema/正文均未污染', () => {
  const f = fixture(); const registry = getDesktopMigrationRegistry(); const before = fs.readFileSync(f.file)
  const failed = createMigrationRegistry(registry.implementations.map(step => step.id === 'M01' ? { ...step, migrate(db) { step.migrate(db); throw new Error('合成磁盘失败') } } : step), registry.recognizedSchemas)
  expect(() => upgradeProjectSqlite({ databasePath: f.file, registry: failed })).toThrow('合成磁盘失败')
  expect(fs.readFileSync(f.file)).toEqual(before)
  expect(probeProjectSqlite({ databasePath: f.file }).schemaVersion).toBe(1)
  initProjectDatabase(f.root); expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
})
it('beforeClose同步持久动作先于句柄关闭与locator撤销', () => {
  const f = fixture('current'); initProjectDatabase(f.root)
  const called = vi.fn(({ database, projectPath }) => {
    expect(projectPath).toBe(f.root); expect(getCurrentProjectPath()).toBe(f.root); expect(database.open).toBe(true)
    database.prepare('UPDATE drafts SET word_count=778').run()
  })
  unsubscribers.push(onProjectDatabaseBeforeClose(called)); closeProjectDatabase()
  expect(called).toHaveBeenCalledTimes(1); expect(getProjectDb()).toBeNull()
  const db = new Database(f.file, { readonly: true }); try { expect(db.prepare('SELECT word_count FROM drafts').pluck().get()).toBe(778) } finally { db.close() }
})
it('异步beforeClose或同步失败不能冒认flush完成/关闭成功', () => {
  const f = fixture('current'); initProjectDatabase(f.root)
  const remove = onProjectDatabaseBeforeClose(() => Promise.resolve()); unsubscribers.push(remove)
  expect(() => closeProjectDatabase()).toThrow('MUST_BE_SYNCHRONOUS'); expect(getProjectDb()!.open).toBe(true)
  remove()
  const fail = onProjectDatabaseBeforeClose(() => { throw new Error('持久化失败') }); unsubscribers.push(fail)
  expect(() => closeProjectDatabase()).toThrow('持久化失败'); expect(getProjectDb()!.open).toBe(true)
})
