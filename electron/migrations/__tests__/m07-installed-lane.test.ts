import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { LIVE_ROW_VIEWS } from '../m07-chapter-recycle'
import { createMigrationRegistry, type MigrationImplementation } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database

function finalize(db: Db, chapter: number, body: string): number {
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(?,1,'finalized',?)")
    .run(chapter, contentId).lastInsertRowid)
  db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name)
    VALUES(?,?,?,?,1,?,?)`).run(`final-${chapter}`, draftId, chapter, 'h'.repeat(64), body, `第${chapter}章.txt`)
  db.prepare('INSERT INTO summary_snapshots(draft_id,chapter_number,chapter_notes) VALUES(?,?,?)').run(draftId, chapter, `第${chapter}章要点`)
  return draftId
}

/** v7 作品：第 1、3 章已定稿，第 2 章已被旧版硬删（只剩删除收据）。 */
function v7WithHardDeletedMiddleChapter(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  finalize(db, 1, '第一章正文')
  const deleted = finalize(db, 2, '第二章正文')
  finalize(db, 3, '第三章正文')
  db.prepare(`INSERT INTO chapter_deletion_operations(operation_id,draft_id,chapter_number,finalization_id,status)
    VALUES('delete-2',?,2,'final-2','completed')`).run(deleted)
  db.prepare('DELETE FROM drafts WHERE id=?').run(deleted)
  return db
}

const rows = (db: Db, sql: string) => db.prepare(sql).all()

describe('installed M07 lane', () => {
  it('migrates a v7 project with a hard-deleted middle chapter to the recognized v8 schema without changing data', () => {
    const db = v7WithHardDeletedMiddleChapter()
    try {
      const before = {
        drafts: rows(db, 'SELECT id,chapter_number,version,status,content_id FROM drafts ORDER BY id'),
        outbox: rows(db, 'SELECT * FROM finalization_outbox ORDER BY finalization_id'),
        receipts: rows(db, 'SELECT * FROM chapter_deletion_operations'),
      }
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(8)
      expect(result.completedSteps).toEqual(['M07'])
      const v8 = getDesktopMigrationRegistry().recognizedSchemas.filter(schema => schema.version === 8).map(schema => schema.fingerprint)
      expect(v8).toContain(sqliteSchemaFingerprint(db))
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).version).toBe(8)
      expect(rows(db, 'SELECT id,chapter_number,version,status,content_id FROM drafts ORDER BY id')).toEqual(before.drafts)
      expect(rows(db, 'SELECT * FROM finalization_outbox ORDER BY finalization_id')).toEqual(before.outbox)
      expect(rows(db, 'SELECT * FROM chapter_deletion_operations')).toEqual(before.receipts)
      expect(rows(db, "SELECT 1 FROM drafts WHERE deletion_id<>'' OR deleted_from_status<>'' OR deleted_at<>''")).toEqual([])
      for (const { table, view } of LIVE_ROW_VIEWS) {
        expect(rows(db, `SELECT * FROM ${view} ORDER BY 1`), view).toEqual(rows(db, `SELECT * FROM ${table} ORDER BY 1`))
      }
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual([])
    } finally { db.close() }
  })

  const sabotages: Array<[string, (step: MigrationImplementation) => MigrationImplementation, string]> = [
    ['verification fails', step => ({ ...step, verify: () => false }), 'MIGRATION_VERIFICATION_FAILED'],
    ['migration throws after its DDL ran', step => ({ ...step,
      migrate: db => { step.migrate(db); throw new Error('M07_INJECTED_FAILURE') } }), 'M07_INJECTED_FAILURE'],
  ]
  it.each(sabotages)('rolls back v7 schema and data when %s', (_label, sabotage, error) => {
    const db = v7WithHardDeletedMiddleChapter()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const broken = createMigrationRegistry(registry.implementations.map(step => step.id === 'M07' ? sabotage(step) : step),
        registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), broken, 8)).toThrow(error)
      expect(db.pragma('user_version', { simple: true })).toBe(7)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(rows(db, "SELECT name FROM sqlite_master WHERE name LIKE 'live_%'")).toEqual([])
      expect(rows(db, 'SELECT chapter_number FROM drafts ORDER BY chapter_number')).toEqual([{ chapter_number: 1 }, { chapter_number: 3 }])
    } finally { db.close() }
  })
})

describe('M07 deletion columns and live views', () => {
  function v8(): Db {
    const db = v7WithHardDeletedMiddleChapter()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
    return db
  }

  it('rejects a deleted row without its deletion facts and live rows carrying them', () => {
    const db = v8()
    try {
      const id = db.prepare('SELECT id FROM drafts WHERE chapter_number=1').pluck().get()
      for (const patch of [
        "status='deleted'",
        "status='deleted', deletion_id='op', deleted_from_status='draft', deleted_at='2026-11-05'",
        "status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at=''",
        "deletion_id='op'",
      ]) expect(() => db.prepare(`UPDATE drafts SET ${patch} WHERE id=?`).run(id), patch).toThrow('DRAFT_DELETION_SHAPE_INVALID')
      expect(() => db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(9,1,'deleted',1)").run())
        .toThrow('DRAFT_DELETION_SHAPE_INVALID')
      db.prepare(`UPDATE drafts SET status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at='2026-11-05'
        WHERE id=?`).run(id)
      expect(db.prepare('SELECT status FROM drafts WHERE id=?').pluck().get(id)).toBe('deleted')
    } finally { db.close() }
  })

  it('hides only deleted rows and keeps rows with a null status or a missing draft', () => {
    const db = v8()
    try {
      db.pragma('foreign_keys=OFF')
      const nullStatus = Number(db.prepare('INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(4,1,NULL,1)').run().lastInsertRowid)
      db.prepare('INSERT INTO summary_snapshots(draft_id,chapter_number) VALUES(9999,9)').run()
      db.prepare('INSERT INTO summary_snapshots(draft_id,chapter_number) VALUES(NULL,8)').run()
      const deleted = db.prepare('SELECT id FROM drafts WHERE chapter_number=3').pluck().get()
      db.prepare(`UPDATE drafts SET status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at='2026-11-05'
        WHERE id=?`).run(deleted)
      expect(db.prepare('SELECT id FROM live_drafts ORDER BY id').pluck().all())
        .toEqual(db.prepare('SELECT id FROM drafts WHERE id<>? ORDER BY id').pluck().all(deleted))
      expect(db.prepare('SELECT 1 FROM live_drafts WHERE id=?').get(nullStatus)).toBeTruthy()
      expect(db.prepare('SELECT chapter_number FROM live_finalization_outbox ORDER BY chapter_number').pluck().all()).toEqual([1])
      expect(db.prepare('SELECT chapter_number FROM live_summary_snapshots ORDER BY chapter_number').pluck().all()).toEqual([1, 8, 9])
    } finally { db.close() }
  })

  it('keeps SELECT * views working after a later migration adds a drafts column', () => {
    const db = v8()
    try {
      db.exec("ALTER TABLE drafts ADD COLUMN future_column TEXT NOT NULL DEFAULT 'later'")
      expect(db.prepare('SELECT future_column FROM live_drafts WHERE chapter_number=1').pluck().get()).toBe('later')
      db.exec("ALTER TABLE finalization_outbox ADD COLUMN future_outbox TEXT NOT NULL DEFAULT 'x'")
      expect(db.prepare('SELECT future_outbox FROM live_finalization_outbox WHERE chapter_number=1').pluck().get()).toBe('x')
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { db.close() }
  })
})
