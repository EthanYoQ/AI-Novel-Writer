import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
import { sqliteSchemaFingerprint } from '../../migrations/sqlite-schema-adapter'
import { backupProjectSqlite, probeProjectSqlite, verifyProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = [], handles: BetterSqlite3.Database[] = []
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'db-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.pragma('foreign_keys = ON')
  initializeLegacyBaselineSchema(db)
  db.prepare('INSERT INTO project_core(id, project_name, characters_arch) VALUES (?, ?, ?)').run('main', '合成项目', '# 作者原文\r\n勿改')
  db.prepare('INSERT INTO contents(body) VALUES (?)').run('窗外下着雨。\r\nLiteral C:\\author\\notes is prose.')
  db.prepare('INSERT INTO drafts(chapter_number,version,content_id,word_count) VALUES (1,1,1,777)').run()
  return { db, root, source, target }
}
function bytes(root: string) {
  return Object.fromEntries(fs.readdirSync(root).sort().map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]))
}
function legacyV110Fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'legacy-v110-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(new URL('./legacy-v110-schema.sql', import.meta.url), 'utf8'))
  expect(sqliteSchemaFingerprint(db)).toBe('1207fd8203e31503e3cd09ba5b60a959c606ded34a8c8c7774a9e15edc8271ba')
  db.prepare('INSERT INTO project_core(rowid,id,project_name,characters_arch) VALUES (?,?,?,?)')
    .run(7, 'main', '旧版合成项目', '原始角色群像')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(44, '乙', 'protagonist')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(99, '甲', 'supporting')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, '原始正文\r\n字节不变')
  db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id,word_count) VALUES (?,?,?,?,?)').run(19, 7, 1, 11, 876)
  db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='contents'").run()
  db.prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='drafts'").run()
  fs.writeFileSync(path.join(root, 'avatar.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  return { db, root, source, target }
}
function legacyV100Fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'legacy-v100-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(new URL('./legacy-v100-schema.sql', import.meta.url), 'utf8'))
  expect(sqliteSchemaFingerprint(db)).toBe('5e1ee5e03fa79bbf49694a680316ee74047f45901cd3f8affeaa0a7fda3ea414')
  db.prepare('INSERT INTO project_core(rowid,id,project_name,characters_arch) VALUES (?,?,?,?)')
    .run(7, 'main', 'v1.0 合成项目', '旧版角色原文')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(44, '乙', 'protagonist')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(99, '甲', 'supporting')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, 'v1.0 正文\r\n原字节')
  db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id,word_count) VALUES (?,?,?,?,?)').run(19, 7, 1, 11, 876)
  db.prepare('INSERT INTO summary_snapshots(id,draft_id,chapter_number,character_states) VALUES (?,?,?,?)').run(23, 19, 7, '{"乙":"作者旧状态"}')
  db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='contents'").run()
  db.prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='drafts'").run()
  return { db, root, source, target }
}
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('real SQLite schema probe and WAL staging backup', () => {
  it('recognizes the real v1.0.0 old writer schema0 without changing the source', () => {
    const f = legacyV100Fixture(), before = bytes(f.root)
    expect(probeProjectSqlite({ databasePath: f.source })).toMatchObject({
      schemaVersion: 0, fingerprint: '5e1ee5e03fa79bbf49694a680316ee74047f45901cd3f8affeaa0a7fda3ea414',
    })
    expect(bytes(f.root)).toEqual(before)
  })
  it('copies qualified v1.0.0 old columns, rowids, and sequence into schema7 staging', async () => {
    const f = legacyV100Fixture(), before = bytes(f.root)
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    expect(result.schemaVersion).toBe(7)
    expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
    const target = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(target)
    expect(target.prepare('SELECT rowid FROM project_core WHERE id=?').pluck().get('main')).toBe(7)
    expect(target.prepare('SELECT id,body FROM contents').get()).toEqual({ id: 11, body: 'v1.0 正文\r\n原字节' })
    expect(target.prepare('SELECT id,content_id,word_count,source_dependencies FROM drafts').get()).toEqual({
      id: 19, content_id: 11, word_count: 876, source_dependencies: '[]',
    })
    expect(target.prepare('SELECT id,character_states,character_state_candidates FROM summary_snapshots').get()).toEqual({
      id: 23, character_states: '{"乙":"作者旧状态"}', character_state_candidates: '[]',
    })
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='contents'").pluck().get()).toBe(900)
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='drafts'").pluck().get()).toBe(500)
    const identities = target.prepare('SELECT source_key,original_row_json,character_id FROM character_identity_origins ORDER BY source_key').all() as Array<{ source_key: string; original_row_json: string; character_id: string }>
    expect(identities.map(row => [row.source_key, JSON.parse(row.original_row_json).name])).toEqual([
      ['legacy:characters:0', '乙'], ['legacy:characters:1', '甲'],
    ])
    expect(new Set(identities.map(row => row.character_id)).size).toBe(2)
    expect(bytes(f.root)).toMatchObject(before)
  })
  it('rejects a v1.0.0 DDL fork before creating staging', async () => {
    const f = legacyV100Fixture()
    f.db.exec('ALTER TABLE contents ADD COLUMN unknown_old_fork TEXT')
    const before = bytes(f.root)
    expect(() => probeProjectSqlite({ databasePath: f.source })).toThrow('UNRECOGNIZED_SCHEMA')
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target }))
      .rejects.toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(bytes(f.root)).toEqual(before)
  })
  it('recognizes the qualified v1.1.0 old writer schema0 source', () => {
    const f = legacyV110Fixture(), before = bytes(f.root)
    expect(probeProjectSqlite({ databasePath: f.source })).toMatchObject({
      schemaVersion: 0, fingerprint: '1207fd8203e31503e3cd09ba5b60a959c606ded34a8c8c7774a9e15edc8271ba',
    })
    expect(bytes(f.root)).toEqual(before)
  })
  it('copies qualified v1.1.0 rows and sequence through canonical staging to schema7 without writing the source', async () => {
    const f = legacyV110Fixture(), before = bytes(f.root)
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    expect(result.schemaVersion).toBe(7)
    expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
    const target = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(target)
    expect(target.prepare('SELECT rowid FROM project_core WHERE id=?').pluck().get('main')).toBe(7)
    expect(target.prepare('SELECT id,body FROM contents').get()).toEqual({ id: 11, body: '原始正文\r\n字节不变' })
    expect(target.prepare('SELECT id,content_id,word_count FROM drafts').get()).toEqual({ id: 19, content_id: 11, word_count: 876 })
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='contents'").pluck().get()).toBe(900)
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='drafts'").pluck().get()).toBe(500)
    const identities = target.prepare('SELECT source_key,original_row_json,character_id FROM character_identity_origins ORDER BY source_key').all() as Array<{ source_key: string; original_row_json: string; character_id: string }>
    expect(identities.map(row => [row.source_key, JSON.parse(row.original_row_json).name])).toEqual([
      ['legacy:characters:0', '乙'], ['legacy:characters:1', '甲'],
    ])
    expect(new Set(identities.map(row => row.character_id)).size).toBe(2)
    expect(bytes(f.root)).toMatchObject(before)
  })
  it('rejects a fork of the v1.1.0 DDL before creating staging', async () => {
    const f = legacyV110Fixture()
    f.db.exec('ALTER TABLE contents ADD COLUMN unknown_old_fork TEXT')
    const before = bytes(f.root)
    expect(() => probeProjectSqlite({ databasePath: f.source })).toThrow('UNRECOGNIZED_SCHEMA')
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target }))
      .rejects.toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(bytes(f.root)).toEqual(before)
  })
  it('probes a live WAL fixture without changing any source file or user_version', () => {
    const f = fixture(), before = bytes(f.root)
    expect(fs.statSync(f.source + '-wal').size).toBeGreaterThan(0)
    const result = probeProjectSqlite({ databasePath: f.source })
    expect(result.schemaVersion).toBe(0)
    expect(result.domain.tableCounts.contents).toBe(1)
    expect(bytes(f.root)).toEqual(before)
  })
  it.each([false, true])('backs up WAL and applies M00 with all domain bytes unchanged (lazy=%s)', async lazy => {
    const f = fixture()
    if (lazy) ensureBaselineBlueprintTables(f.db)
    const before = probeProjectSqlite({ databasePath: f.source })
    const sourceBytes = bytes(f.root)
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target, targetVersion: 1 })
    expect(result.schemaVersion).toBe(1)
    expect(result.domain).toEqual(before.domain)
    expect(verifyProjectSqlite({ databasePath: f.target, targetVersion: 1 })).toEqual(result)
    expect(probeProjectSqlite({ databasePath: f.source })).toEqual(before)
    for (const [name, hash] of Object.entries(sourceBytes)) expect(bytes(f.root)[name], name).toBe(hash)
    const check = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(check)
    expect(check.prepare('SELECT word_count FROM drafts').pluck().get()).toBe(777)
    expect(check.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().get()).toBe(35)
  })
  it.each(['unknown-column', 'unknown-trigger', 'future-version'])('refuses %s before staging writes', async mode => {
    const f = fixture()
    if (mode === 'unknown-column') f.db.exec('ALTER TABLE contents ADD COLUMN fork_secret TEXT')
    if (mode === 'unknown-trigger') f.db.exec('CREATE TRIGGER fork_trigger AFTER INSERT ON contents BEGIN SELECT 1; END')
    if (mode === 'future-version') f.db.pragma('user_version = 999')
    const before = bytes(f.root)
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })).rejects.toThrow(mode === 'future-version' ? 'NEWER_SCHEMA_READ_ONLY' : 'UNRECOGNIZED_SCHEMA')
    expect(bytes(f.root)).toEqual(before)
  })
  it('does not create a missing source or truncate an existing target', async () => {
    const f = fixture()
    expect(() => probeProjectSqlite({ databasePath: path.join(f.root, 'missing.db') })).toThrow()
    fs.writeFileSync(f.target, 'preserve target')
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })).rejects.toThrow('PROJECT_MIGRATION_TARGET_EXISTS')
    expect(fs.readFileSync(f.target, 'utf8')).toBe('preserve target')
  })
})
