import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { ensureBaselineBlueprintTables } from '../../migrations/baseline-blueprint-schema'
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
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('real SQLite schema probe and WAL staging backup', () => {
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
