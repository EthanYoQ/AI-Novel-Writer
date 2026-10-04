import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { createMigrationRegistry } from '../registry'
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 2)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('原稿\r\n')
  db.prepare('INSERT INTO characters(name,notes) VALUES(?,?)').run('旧角色', '原值')
  return db
}
describe('installed M02 lane', () => {
  it('upgrades only through M02 and preserves all non-character table rows', () => {
    const db = fixture(); try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='characters'").all() as { name: string }[]).map(row => row.name)
      const before = tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 3)
      expect(result.completedSteps).toEqual(['M02']); expect(result.sessionFenced).toBe(false); expect(result.repositoriesOpened).toBe(false)
      expect(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])).toEqual(before)
      const id = db.prepare('SELECT character_id FROM characters').pluck().get()
      db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('作者新名字', id)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 3).completedSteps).toEqual([])
      expect(db.prepare('SELECT character_id FROM characters').pluck().get()).toBe(id)
    } finally { db.close() }
  })
  it('rejects unrecognized source/target fingerprints without blessing their version', () => {
    const db = fixture(); try {
      db.exec('ALTER TABLE contents ADD COLUMN unknown_field TEXT')
      const before = sqliteSchemaFingerprint(db)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 3)).toThrow('UNRECOGNIZED_SCHEMA')
      expect(db.pragma('user_version', { simple: true })).toBe(2); expect(sqliteSchemaFingerprint(db)).toBe(before)
    } finally { db.close() }
  })
  it('rolls back failed M02 and verifies persisted domain data on same-version reopen', () => {
    const db = fixture(); try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M02' ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 3)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(2); expect(sqliteSchemaFingerprint(db)).toBe(before)
      migrateSchema(new SqliteSchemaAdapter(db), registry, 3)
      db.exec('UPDATE character_aliases SET valid_from=0.5')
      expect(() => verifySchema(new SqliteSchemaAdapter(db), registry, 3)).toThrow('MIGRATION_VERIFICATION_FAILED')
    } finally { db.close() }
  })
})
