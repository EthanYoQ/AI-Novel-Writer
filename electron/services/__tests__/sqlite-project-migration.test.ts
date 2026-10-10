import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
import { sqliteSchemaFingerprint } from '../../migrations/sqlite-schema-adapter'
import { backupProjectSqlite, probeProjectSqlite, verifyProjectSqlite, upgradeProjectSqlite } from '../sqlite-project-migration'
import { CharacterRosterRepository } from '../../repositories/character-roster-repository'
import { ProjectCoreRepository } from '../../repositories/project-core-repository'

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
function earlyV110Fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'early-v110-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(new URL('./legacy-v110-schema0-early.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
  expect(sqliteSchemaFingerprint(db)).toBe('2504dde08865f758f654d38ae3d972420c28fa60d1f747e92898390455272de6')
  db.prepare('INSERT INTO project_core(rowid,id,project_name,genre,global_guidance,characters_arch) VALUES (?,?,?,?,?,?)')
    .run(7, 'main', '早期 1.1 项目', '悬疑', '只用作者设定', '# 角色原文')
  db.prepare('INSERT INTO characters(rowid,name,role,background) VALUES (?,?,?,?)').run(44, '乙', 'protagonist', '旧角色资料')
  db.prepare('INSERT INTO blueprints(chapter_number,title,notes) VALUES (?,?,?)').run(7, '旧蓝图', '作者蓝图备注')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, '正文\r\n原样')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(12, '审稿原文')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(13, '修稿原文')
  db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id) VALUES (?,?,?,?)').run(19, 7, 1, 11)
  db.prepare('INSERT INTO reviews(id,base_draft_id,review_index,content_id) VALUES (?,?,?,?)').run(21, 19, 1, 12)
  db.prepare('INSERT INTO revisions(id,base_draft_id,revision_index,revision_type,content_id) VALUES (?,?,?,?,?)').run(23, 19, 1, 'refine', 13)
  db.prepare('INSERT INTO summary_snapshots(id,chapter_number,character_states) VALUES (?,?,?)').run(25, 7, '{"乙":"旧状态"}')
  db.prepare('INSERT INTO llm_calls(id,model_id,purpose) VALUES (?,?,?)').run(27, 'old-model', 'draft')
  db.prepare('INSERT INTO post_process_runs(id,trigger_source_type,trigger_source_id) VALUES (?,?,?)').run('old-run', 'draft', '19')
  db.prepare('INSERT INTO post_process_steps(id,run_id,step_key,ok) VALUES (?,?,?,?)').run(29, 'old-run', 'review', 1)
  db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='contents'").run()
  fs.writeFileSync(path.join(root, 'avatar.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  return { db, root, source, target }
}
function legacyV100Fixture(official = false) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'legacy-v100-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(new URL(official ? './legacy-v100-official-schema.sql' : './legacy-v100-schema.sql', import.meta.url), 'utf8'))
  expect(sqliteSchemaFingerprint(db)).toBe(official
    ? 'c536a35e30f51f681843a2a07a48592cc80e9840abeb7898fcd463297128ccf8'
    : '5e1ee5e03fa79bbf49694a680316ee74047f45901cd3f8affeaa0a7fda3ea414')
  db.prepare('INSERT INTO project_core(rowid,id,project_name,characters_arch) VALUES (?,?,?,?)')
    .run(7, 'main', 'v1.0 合成项目', '旧版角色原文')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(44, '乙', 'protagonist')
  db.prepare('INSERT INTO characters(rowid,name,role) VALUES (?,?,?)').run(99, '甲', 'supporting')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, 'v1.0 正文\r\n原字节')
  db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id,word_count) VALUES (?,?,?,?,?)').run(19, 7, 1, 11, 876)
  if (official) {
    db.prepare('UPDATE project_core SET core_outline=NULL, world_setting=NULL, protagonist_profile=NULL WHERE id=?').run('main')
    db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(12, '官方审稿原文')
    db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(13, '官方修稿原文')
    db.prepare('INSERT INTO reviews(id,base_draft_id,review_index,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(21, 19, 1, 7, 1, 'draft', '冻结审稿源文', 12)
    db.prepare('INSERT INTO revisions(id,base_draft_id,revision_index,revision_type,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(22, 19, 1, 'refine', 7, 1, 'draft', '冻结修稿源文', 13)
  }
  db.prepare('INSERT INTO summary_snapshots(id,draft_id,chapter_number,character_states) VALUES (?,?,?,?)').run(23, 19, 7, '{"乙":"作者旧状态"}')
  db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='contents'").run()
  db.prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='drafts'").run()
  return { db, root, source, target }
}
function legacyV092Fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-sqlite')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'legacy-v092-')); roots.push(root)
  const source = path.join(root, 'source.db'), target = path.join(root, 'target.db')
  const db = new Database(source); handles.push(db)
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(new URL('./legacy-v092-lazy-schema.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
  db.prepare('INSERT INTO project_core(rowid,id,project_name,characters_arch) VALUES (?,?,?,?)')
    .run(7, 'main', '0.9.2 合成项目', '旧角色原文')
  db.prepare('INSERT INTO contents(id,body) VALUES (?,?)').run(11, '旧正文\r\n保留')
  db.prepare('INSERT INTO drafts(id,chapter_number,version,content_id) VALUES (?,?,?,?)').run(19, 7, 1, 11)
  db.prepare('INSERT INTO reviews(id,base_draft_id,review_index,content_id) VALUES (?,?,?,?)').run(21, 19, 1, 11)
  db.prepare('INSERT INTO revisions(id,base_draft_id,revision_index,revision_type,content_id) VALUES (?,?,?,?,?)').run(22, 19, 1, 'refine', 11)
  db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='contents'").run()
  return { db, root, source, target }
}
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('real SQLite schema probe and WAL staging backup', () => {
  it.each([
    ['empty', 'empty', 'empty'],
    ['markdown', 'legacy_markdown_pending', 'legacy_repair_required'],
    ['cards', 'legacy_cards_preserved', 'inconsistent'],
    ['existing', 'legacy_markdown_pending', 'legacy_repair_required'],
  ])('preserves author data and exposes the imported %s roster without read-time writes', async (kind, migrationState, status) => {
    const f = legacyV110Fixture()
    if (kind !== 'cards') f.db.exec('DELETE FROM characters')
    if (kind === 'empty') f.db.exec("UPDATE project_core SET characters_arch='' WHERE id='main'")
    const raw = f.db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get()
    if (kind === 'existing') f.db.prepare(`INSERT INTO character_roster_meta
      (id,schema_version,revision,migration_state,legacy_markdown,projection_hash,fact_hash,updated_at)
      VALUES ('main',1,7,'legacy_markdown_pending',?,'old-projection','old-facts','2026-01-01 00:00:00')`).run(raw)
    const originalMeta = f.db.prepare('SELECT rowid,* FROM character_roster_meta').get()
    const originalCore = f.db.prepare('SELECT rowid,* FROM project_core').get()
    const sequences = f.db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()
    const before = bytes(f.root)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Migration must not invoke a model'))
    try {
      const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
      expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
      const target = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(target)
      expect(CharacterRosterRepository.read(target)).toMatchObject({ migrationState, status,
        revision: kind === 'existing' ? 7 : 0,
        ...(kind === 'empty' ? {} : { legacyMarkdown: raw }),
      })
      expect(target.prepare('SELECT rowid,* FROM project_core').get()).toEqual(originalCore)
      expect(target.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()).toEqual(sequences)
      expect(target.prepare('SELECT COUNT(*) FROM llm_calls').pluck().get()).toBe(0)
      if (originalMeta) expect(target.prepare('SELECT rowid,* FROM character_roster_meta').get()).toEqual(originalMeta)
      expect(bytes(f.root)).toMatchObject(before)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })

  it('does not repair missing M02 roster metadata during a read', async () => {
    const f = fixture()
    await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    const target = new Database(f.target, { fileMustExist: true }); handles.push(target)
    target.exec('DELETE FROM character_roster_meta')
    expect(() => CharacterRosterRepository.read(target)).toThrow('角色名单元数据未初始化')
    expect(target.prepare('SELECT COUNT(*) FROM character_roster_meta').pluck().get()).toBe(0)
  })

  it('imports the exact early v1.1.0 schema0 rows through schema7 without touching the source', async () => {
    const f = earlyV110Fixture(), before = bytes(f.root)
    expect(probeProjectSqlite({ databasePath: f.source })).toMatchObject({
      schemaVersion: 0, fingerprint: '2504dde08865f758f654d38ae3d972420c28fa60d1f747e92898390455272de6',
    })
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    expect(result.schemaVersion).toBe(7)
    expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
    const target = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(target)
    expect(target.prepare('SELECT rowid,project_name,genre,global_guidance,characters_arch FROM project_core').get())
      .toEqual({ rowid: 7, project_name: '早期 1.1 项目', genre: '悬疑', global_guidance: '只用作者设定', characters_arch: '# 角色原文' })
    expect(target.prepare('SELECT name,background FROM characters').get()).toEqual({ name: '乙', background: '旧角色资料' })
    expect(target.prepare('SELECT title,notes FROM blueprints').get()).toEqual({ title: '旧蓝图', notes: '作者蓝图备注' })
    expect(target.prepare('SELECT id,body FROM contents ORDER BY id').all()).toEqual([
      { id: 11, body: '正文\r\n原样' }, { id: 12, body: '审稿原文' }, { id: 13, body: '修稿原文' },
    ])
    for (const [table, id] of [['drafts', 19], ['reviews', 21], ['revisions', 23], ['summary_snapshots', 25], ['llm_calls', 27], ['post_process_steps', 29]] as const) {
      expect(target.prepare(`SELECT id FROM ${table}`).pluck().get(), table).toBe(id)
    }
    expect(target.prepare('SELECT id,generation,stale_from_chapter FROM continuity_projection_meta').all()).toEqual([{ id: 'main', generation: 0, stale_from_chapter: null }])
    expect(target.prepare('SELECT id FROM post_process_runs').pluck().get()).toBe('old-run')
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='contents'").pluck().get()).toBe(900)
    expect(bytes(f.root)).toMatchObject(before)
  })
  it('rejects an early v1.1.0 DDL fork before creating staging', async () => {
    const f = earlyV110Fixture()
    f.db.exec('ALTER TABLE contents ADD COLUMN unknown_old_fork TEXT')
    const before = bytes(f.root)
    expect(() => probeProjectSqlite({ databasePath: f.source })).toThrow('UNRECOGNIZED_SCHEMA')
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target }))
      .rejects.toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(bytes(f.root)).toEqual(before)
  })
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
    expect(target.prepare('SELECT id,generation,stale_from_chapter FROM continuity_projection_meta').all()).toEqual([{ id: 'main', generation: 0, stale_from_chapter: null }])
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
  it('imports the exact official v1.0.0 schema0 with NULL author fields and reordered review data intact', async () => {
    const f = legacyV100Fixture(true), before = bytes(f.root)
    expect(probeProjectSqlite({ databasePath: f.source })).toMatchObject({
      schemaVersion: 0, fingerprint: 'c536a35e30f51f681843a2a07a48592cc80e9840abeb7898fcd463297128ccf8',
    })
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    expect(result.schemaVersion).toBe(7)
    expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
    const target = new Database(f.target, { fileMustExist: true }); handles.push(target)
    expect(target.prepare('SELECT rowid,core_outline,world_setting,protagonist_profile FROM project_core').get())
      .toEqual({ rowid: 7, core_outline: null, world_setting: null, protagonist_profile: null })
    expect(target.prepare('SELECT id,generation,stale_from_chapter FROM continuity_projection_meta').all()).toEqual([{ id: 'main', generation: 0, stale_from_chapter: null }])
    expect(ProjectCoreRepository.get(target)).toMatchObject({ coreOutline: null, worldSetting: null, protagonistProfile: null })
    ProjectCoreRepository.update({ projectName: '导入后编辑' }, target)
    expect(target.prepare('SELECT project_name,core_outline,world_setting,protagonist_profile FROM project_core').get())
      .toEqual({ project_name: '导入后编辑', core_outline: null, world_setting: null, protagonist_profile: null })
    expect(target.prepare('SELECT rowid AS source_rowid,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id FROM reviews').get())
      .toEqual({ source_rowid: 21, source_draft_chapter_number: 7, source_draft_version: 1, source_draft_status: 'draft', source_content: '冻结审稿源文', content_id: 12 })
    expect(target.prepare('SELECT rowid AS source_rowid,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id FROM revisions').get())
      .toEqual({ source_rowid: 22, source_draft_chapter_number: 7, source_draft_version: 1, source_draft_status: 'draft', source_content: '冻结修稿源文', content_id: 13 })
    expect(target.prepare('SELECT rowid AS source_rowid,draft_id,chapter_number,character_states FROM summary_snapshots').get())
      .toEqual({ source_rowid: 23, draft_id: 19, chapter_number: 7, character_states: '{"乙":"作者旧状态"}' })
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='contents'").pluck().get()).toBe(900)
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='drafts'").pluck().get()).toBe(500)
    expect(bytes(f.root)).toMatchObject(before)
  })
  it('rejects a one-property DDL fork of the exact official v1.0.0 schema', async () => {
    const f = legacyV100Fixture(true)
    f.db.exec('ALTER TABLE project_core ADD COLUMN unknown_old_fork TEXT')
    const before = bytes(f.root)
    expect(() => probeProjectSqlite({ databasePath: f.source })).toThrow('UNRECOGNIZED_SCHEMA')
    await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target }))
      .rejects.toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(bytes(f.root)).toEqual(before)
  })
  it.each(['0.9.2', '1.0.0'] as const)('imports the official %s lazy blueprint schema without dropping old records', async version => {
    const f = version === '0.9.2' ? legacyV092Fixture() : legacyV100Fixture(true)
    ensureBaselineBlueprintTables(f.db)
    const fingerprint = version === '0.9.2'
      ? '7a34ee78ddace39804d64ce8a42c054f11d9d27a559ff99cbd345921088ba050'
      : '29838d67b3b0338b717c7488a7a2841c40fdacbb58598a83358bd73b6bda4673'
    expect(sqliteSchemaFingerprint(f.db)).toBe(fingerprint)
    f.db.prepare('INSERT INTO blueprint_commit_operations(rowid,operation_id,payload_hash,mode,start_chapter,end_chapter,character_sync_input) VALUES (?,?,?,?,?,?,?)')
      .run(41, 'old-commit', 'old-hash', 'full', 7, 7, '{"characters":["旧角色"]}')
    f.db.prepare('INSERT INTO blueprint_character_sync_operations(rowid,operation_id,blueprint_commit_operation_id,blueprint_commit_payload_hash,start_chapter,end_chapter,character_sync_input) VALUES (?,?,?,?,?,?,?)')
      .run(53, 'old-sync', 'old-commit', 'old-hash', 7, 7, '{"characters":["旧角色"]}')
    const preservedTables = ['blueprint_commit_operations', 'blueprint_character_sync_operations', 'contents', 'reviews', 'revisions']
    const originals = preservedTables.map(table => f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())
    const before = bytes(f.root)
    expect(probeProjectSqlite({ databasePath: f.source })).toMatchObject({ schemaVersion: 0, fingerprint })
    const result = await backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })
    expect(result.schemaVersion).toBe(7)
    expect(verifyProjectSqlite({ databasePath: f.target })).toEqual(result)
    const target = new Database(f.target, { readonly: true, fileMustExist: true }); handles.push(target)
    for (const [index, table] of preservedTables.entries()) {
      const rows = target.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()
      expect(rows, table).toHaveLength(originals[index].length)
      expect(rows, table).toMatchObject(originals[index])
    }
    expect(target.prepare("SELECT seq FROM sqlite_sequence WHERE name='contents'").pluck().get()).toBe(900)
    if (version === '0.9.2') {
      expect(target.prepare('SELECT source_draft_chapter_number,source_draft_version,source_draft_status,source_content FROM reviews').get())
        .toEqual({ source_draft_chapter_number: null, source_draft_version: null, source_draft_status: null, source_content: null })
      expect(target.prepare('SELECT COUNT(*) FROM recovery_candidates').pluck().get()).toBe(0)
    }
    expect(bytes(f.root)).toMatchObject(before)
  })
  it.each(['0.9.2', '1.0.0'] as const)('rejects unknown DDL and broken references in official %s lazy schemas before creating staging', async version => {
    for (const fault of ['unknown-ddl', 'foreign-key']) {
      const f = version === '0.9.2' ? legacyV092Fixture() : legacyV100Fixture(true)
      ensureBaselineBlueprintTables(f.db)
      if (fault === 'unknown-ddl') f.db.exec('ALTER TABLE blueprint_commit_operations ADD COLUMN unknown_fork TEXT')
      else {
        f.db.pragma('foreign_keys = OFF')
        f.db.prepare('INSERT INTO blueprint_character_sync_operations(operation_id,blueprint_commit_operation_id,blueprint_commit_payload_hash,start_chapter,end_chapter,character_sync_input) VALUES (?,?,?,?,?,?)')
          .run('orphan-sync', 'missing-commit', 'old-hash', 1, 1, '{}')
      }
      const before = bytes(f.root), code = fault === 'foreign-key' ? 'CORRUPT_SCHEMA' : 'UNRECOGNIZED_SCHEMA'
      expect(() => probeProjectSqlite({ databasePath: f.source })).toThrow(code)
      await expect(backupProjectSqlite({ sourceDatabasePath: f.source, targetDatabasePath: f.target })).rejects.toThrow(code)
      expect(fs.existsSync(f.target)).toBe(false)
      expect(bytes(f.root)).toEqual(before)
    }
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
    expect(target.prepare('SELECT id,generation,stale_from_chapter FROM continuity_projection_meta').all()).toEqual([{ id: 'main', generation: 0, stale_from_chapter: null }])
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

it('upgrades a qualified schema 6 file to schema 7 without changing author content', async () => {
 const f=fixture()
 const before=await backupProjectSqlite({sourceDatabasePath:f.source,targetDatabasePath:f.target,targetVersion:6})
 expect(before.schemaVersion).toBe(6)
 const upgraded=upgradeProjectSqlite({databasePath:f.target})
 expect(upgraded.schemaVersion).toBe(7)
 expect(upgraded.domain).toEqual(before.domain)
 expect(verifyProjectSqlite({databasePath:f.target})).toEqual(upgraded)
})
it('resolves a trusted system scratch junction before validating its private snapshot', () => {
 const f=fixture(), physical=path.join(f.root,'scratch'), link=path.join(f.root,'scratch-link')
 fs.mkdirSync(physical);fs.symlinkSync(physical,link,'junction')
 const previous=process.env.LOCALAPPDATA
 process.env.LOCALAPPDATA=link
 try { expect(probeProjectSqlite({databasePath:f.source}).schemaVersion).toBe(0) }
 finally { if(previous===undefined) delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous }
})
