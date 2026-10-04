import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 3)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('M03 前的作者正文\r\n')
  return db
}

describe('installed M03 lane', () => {
  it('installs only M03, preserves existing rows, and reopens version 4', () => {
    const db = fixture()
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map(row => row.name)
      const before = tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 4)

      expect(result.completedSteps).toEqual(['M03'])
      expect(result.sessionFenced).toBe(false)
      expect(result.repositoriesOpened).toBe(false)
      expect(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])).toEqual(before)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('review_cycles','review_findings') ORDER BY name").pluck().all())
        .toEqual(['review_cycles', 'review_findings'])
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 4).completedSteps).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects an unrecognized version-3 source without blessing it as version 4', () => {
    const db = fixture()
    try {
      db.exec('ALTER TABLE contents ADD COLUMN unknown_field TEXT')
      const before = sqliteSchemaFingerprint(db)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 4)).toThrow('UNRECOGNIZED_SCHEMA')
      expect(db.pragma('user_version', { simple: true })).toBe(3)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
    } finally {
      db.close()
    }
  })

  it('rolls back a failed M03 and invokes its domain verifier on same-version reopen', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry()
      const before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(
        registry.implementations.map(step => step.id === 'M03' ? { ...step, verify: () => false } : step),
        registry.recognizedSchemas,
      )

      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 4)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(3)
      expect(sqliteSchemaFingerprint(db)).toBe(before)

      migrateSchema(new SqliteSchemaAdapter(db), registry, 4)
      expect(() => verifySchema(new SqliteSchemaAdapter(db), rejected, 4)).toThrow('MIGRATION_VERIFICATION_FAILED')
    } finally {
      db.close()
    }
  })
})
