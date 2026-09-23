import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function installKnownDonorAvatarColumn(db: import('better-sqlite3').Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
  const marker = "      cs_location TEXT DEFAULT '',"
  db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
  db.exec(row.sql.replace(marker, "      avatar TEXT NOT NULL DEFAULT '',\n" + marker))
  db.exec('DROP TABLE characters_without_avatar')
}

function fixture(donor = false) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  if (donor) installKnownDonorAvatarColumn(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 5)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('M05 前的作者正文')
  return db
}

describe('installed M05 lane', () => {
  it.each([false, true])('installs M05 from the exact canonical/donor version-5 family (donor=%s)', donor => {
    const db = fixture(donor)
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 6)

      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(7)
      expect(result.completedSteps).toEqual(['M05'])
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'character_avatar_%' ORDER BY name").pluck().all())
        .toEqual(['character_avatar_assets', 'character_avatar_unresolved'])
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 6).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rejects an unknown version-5 fork without blessing it as version 6', () => {
    const db = fixture()
    try {
      db.exec('ALTER TABLE contents ADD COLUMN unknown_m05_fork TEXT')
      const before = sqliteSchemaFingerprint(db)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 6)).toThrow('UNRECOGNIZED_SCHEMA')
      expect(db.pragma('user_version', { simple: true })).toBe(5)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
    } finally { db.close() }
  })

  it('rolls back a failed M05 and re-runs its verifier on same-version reopen', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(
        registry.implementations.map(step => step.id === 'M05' ? { ...step, verify: () => false } : step),
        registry.recognizedSchemas,
      )
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 6)).toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(5)
      expect(sqliteSchemaFingerprint(db)).toBe(before)

      migrateSchema(new SqliteSchemaAdapter(db), registry, 6)
      db.exec('DROP TABLE character_avatar_unresolved')
      expect(() => verifySchema(new SqliteSchemaAdapter(db), registry, 6)).toThrow('UNRECOGNIZED_SCHEMA')
    } finally { db.close() }
  })
})
