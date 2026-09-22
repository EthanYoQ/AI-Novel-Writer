import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { createMigrationRegistry } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 4)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('M04 前的作者正文\r\n')
  db.prepare(`INSERT INTO import_runs(
    id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,
    stage,status,completed_batches_json,total_chapters,manifest_chapter_count
  ) VALUES('run','reference','run','import:reference:run',?,?,'zh-CN','global','running',?,1,1)`)
    .run(hash('source'), hash('manifest'), JSON.stringify({ global: ['done'] }))
  const payload = JSON.stringify({ writingStyle: '简洁' })
  db.prepare(`INSERT INTO import_run_receipts(
    run_id,effect_namespace,effect_key,stage,batch_id,kind,payload_json,payload_hash,state,effect_receipt_json
  ) VALUES('run','import:reference:run','global-facts','global','done','project-global-facts',?,?,'committed',?)`)
    .run(payload, hash(payload), payload)
  return db
}

describe('installed M04 lane', () => {
  it('installs only M04, preserves existing rows, and reopens version 5', () => {
    const db = fixture()
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>).map(row => row.name)
      const before = tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 5)

      expect(result.completedSteps).toEqual(['M04'])
      expect(result.sessionFenced).toBe(false)
      expect(result.repositoriesOpened).toBe(false)
      expect(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])).toEqual(before)
      expect(db.prepare(`SELECT state,evidence_kind FROM import_effect_ledger
        WHERE run_id='run' AND stage='global' AND batch_id='done'`).get())
        .toEqual({ state: 'complete', evidence_kind: 'receipt' })
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 5).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('rejects an unrecognized version-4 source without blessing it as version 5', () => {
    const db = fixture()
    try {
      db.exec('ALTER TABLE contents ADD COLUMN unknown_field TEXT')
      const before = sqliteSchemaFingerprint(db)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 5))
        .toThrow('UNRECOGNIZED_SCHEMA')
      expect(db.pragma('user_version', { simple: true })).toBe(4)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
    } finally { db.close() }
  })

  it('rolls back a failed M04 and verifies receipt/ledger consistency on same-version reopen', () => {
    const db = fixture()
    try {
      const registry = getDesktopMigrationRegistry()
      const before = sqliteSchemaFingerprint(db)
      const rejected = createMigrationRegistry(
        registry.implementations.map(step => step.id === 'M04' ? { ...step, verify: () => false } : step),
        registry.recognizedSchemas,
      )
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), rejected, 5))
        .toThrow('MIGRATION_VERIFICATION_FAILED')
      expect(db.pragma('user_version', { simple: true })).toBe(4)
      expect(sqliteSchemaFingerprint(db)).toBe(before)

      migrateSchema(new SqliteSchemaAdapter(db), registry, 5)
      db.prepare("UPDATE import_run_receipts SET state='prepared' WHERE run_id='run'").run()
      expect(() => verifySchema(new SqliteSchemaAdapter(db), registry, 5))
        .toThrow('MIGRATION_VERIFICATION_FAILED')
    } finally { db.close() }
  })
})
