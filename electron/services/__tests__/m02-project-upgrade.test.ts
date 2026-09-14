import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMigrationRegistry } from '../../migrations/registry'
import { backupProjectSqlite, probeProjectSqlite, upgradeProjectSqlite, verifyProjectSqlite } from '../sqlite-project-migration'
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s08-lane'); fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'project-')); roots.push(root)
  const file = path.join(root, 'project.db'), db = new Database(file)
  db.pragma('foreign_keys=ON'); db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 2)
  const raw = ' 作者原文\r\n“保留标点”。', provenance = '{ "location" : { "kind" : "legacy" } }'
  db.prepare('INSERT INTO contents(body) VALUES(?)').run(raw)
  db.prepare('INSERT INTO characters(name,relationships,cs_provenance) VALUES(?,?,?)').run('角色', '自由文本，尚未确定身份。', provenance)
  db.prepare('INSERT INTO blueprints(chapter_number,characters) VALUES(1,?)').run('[ "角色" ]')
  db.close()
  return { root, file, raw, provenance }
}
describe('M02 real SQLite source projection and admission', () => {
  it('upgrades schema2 preserving all prior fields while retaining the full new domain and stable IDs', () => {
    const f = fixture(), before = probeProjectSqlite({ databasePath: f.file })
    const after = upgradeProjectSqlite({ databasePath: f.file })
    expect(before.schemaVersion).toBe(2); expect(after.schemaVersion).toBe(3)
    expect(after.preIdentityDomain).toEqual(before.domain)
    expect(after.domain).not.toEqual(before.domain)
    expect(verifyProjectSqlite({ databasePath: f.file })).toEqual(after)
    const db = new Database(f.file)
    const id = db.prepare('SELECT character_id FROM characters').pluck().get()
    expect(db.prepare('SELECT cs_provenance FROM characters').pluck().get()).toBe(f.provenance)
    expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(f.raw); db.close()
    expect(upgradeProjectSqlite({ databasePath: f.file })).toEqual(after)
    const reopened = new Database(f.file); expect(reopened.prepare('SELECT character_id FROM characters').pluck().get()).toBe(id); reopened.close()
  })
  it('backs up active WAL without changing DB/WAL/SHM source bytes and verifies the exact old-column projection', async () => {
    const f = fixture(), db = new Database(f.file); db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0')
    db.prepare('INSERT INTO contents(body) VALUES(?)').run('仅在WAL的作者正文')
    const bytes = ['','-wal','-shm'].map(suffix => fs.readFileSync(f.file + suffix))
    try {
      const before = probeProjectSqlite({ databasePath: f.file }), target = path.join(f.root, 'copy.db')
      const result = await backupProjectSqlite({ sourceDatabasePath: f.file, targetDatabasePath: target })
      expect(result.schemaVersion).toBe(3); expect(result.preIdentityDomain).toEqual(before.domain)
      expect(verifyProjectSqlite({ databasePath: target })).toEqual(result)
      expect(['','-wal','-shm'].map(suffix => fs.readFileSync(f.file + suffix))).toEqual(bytes)
    } finally { db.close() }
  })
  it('rolls back a structurally valid migration that changes non-character author facts', () => {
    const f = fixture(), registry = getDesktopMigrationRegistry(), bytes = fs.readFileSync(f.file)
    const bad = createMigrationRegistry(registry.implementations.map(step => step.id === 'M02' ? { ...step, migrate(adapter) { step.migrate(adapter); (adapter as SqliteSchemaAdapter).database.exec("UPDATE contents SET body='changed'") } } : step), registry.recognizedSchemas)
    expect(() => upgradeProjectSqlite({ databasePath: f.file, registry: bad })).toThrow('PROJECT_MIGRATION_SQLITE_CONTENT_CHANGED')
    expect(fs.readFileSync(f.file)).toEqual(bytes); expect(probeProjectSqlite({ databasePath: f.file }).schemaVersion).toBe(2)
  })
  it('refuses unknown schema2 columns and invalid schema3 domain evidence before admission', () => {
    const f = fixture(), db = new Database(f.file); db.exec('ALTER TABLE contents ADD COLUMN foreign_variant TEXT'); db.close()
    const bytes = fs.readFileSync(f.file)
    expect(() => upgradeProjectSqlite({ databasePath: f.file })).toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.readFileSync(f.file)).toEqual(bytes)
    const other = fixture(); upgradeProjectSqlite({ databasePath: other.file })
    const bad = new Database(other.file); bad.exec('UPDATE character_aliases SET valid_from=0.5'); bad.close()
    expect(() => verifyProjectSqlite({ databasePath: other.file })).toThrow('MIGRATION_VERIFICATION_FAILED')
  })
})
