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
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 6)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('v6 作者正文')
  return db
}

describe('installed M06 lane', () => {
  it('migrates recognized v6 without changing author content and verifies v7 reopen', () => {
    const db = fixture()
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(7)
      expect(result.completedSteps).toEqual(['M06'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(db.prepare('SELECT COUNT(*) FROM review_cycle_merges').pluck().get()).toBe(0)
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7).version).toBe(7)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rolls back a failed M06 verification without changing v6 data or schema', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(registry.implementations.map(step => step.id === 'M06'
        ? { ...step, verify: () => false } : step), registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 7)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(6)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe('v6 作者正文')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='review_cycle_merges'").get()).toBeUndefined()
    } finally { db.close() }
  })
})
