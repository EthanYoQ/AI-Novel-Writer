import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('v7 作者正文')
  db.prepare(`INSERT INTO blueprints (chapter_number, title, role, purpose, key_events, characters)
    VALUES(1, '旧站来信', '建置', '引出主角', '发现异常', '[]')`).run()
  return db
}

describe('installed M07 lane', () => {
  it('migrates recognized v7 by adding chapter_outline without changing author data', () => {
    const db = fixture()
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const beforeBlueprint = db.prepare('SELECT * FROM blueprints WHERE chapter_number = 1').get() as Record<string, unknown>
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(8)
      expect(result.completedSteps).toEqual(['M07'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(db.prepare('SELECT * FROM blueprints WHERE chapter_number = 1').get()).toEqual({ ...beforeBlueprint, chapter_outline: '' })
      expect(db.prepare("SELECT chapter_outline FROM blueprints WHERE chapter_number = 1").pluck().get()).toBe('')
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).version).toBe(8)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rejects an unknown version-7 fork without blessing it as version 8', () => {
    const db = fixture()
    try {
      db.exec('ALTER TABLE contents ADD COLUMN unknown_m07_fork TEXT')
      const before = sqliteSchemaFingerprint(db)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)).toThrow('UNRECOGNIZED_SCHEMA')
      expect(db.pragma('user_version', { simple: true })).toBe(7)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
    } finally { db.close() }
  })

  it('rolls back a failed M07 without changing v7 data or schema', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M07'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 8)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(7)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('v7 作者正文')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blueprints'").get()).toBeDefined()
      expect((db.prepare("PRAGMA table_info(blueprints)").all() as { name: string }[]).some(column => column.name === 'chapter_outline')).toBe(false)
    } finally { db.close() }
  })
})
