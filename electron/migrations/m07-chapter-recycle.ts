import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

/**
 * 回收站的存储形态（#564）。被删章的行原地留在原表，
 * drafts.status 置为 'deleted'；读取路径一律走 live_ 视图，看不见被删行。
 * 本迁移只建结构，不产生任何 deleted 行。
 */
export const M07_DRAFT_COLUMNS = Object.freeze(['deletion_id', 'deleted_from_status', 'deleted_at'] as const)

export const LIVE_ROW_VIEWS = Object.freeze([
  Object.freeze({ table: 'drafts', view: 'live_drafts',
    sql: "CREATE VIEW live_drafts AS SELECT * FROM drafts WHERE status IS NOT 'deleted'" }),
  Object.freeze({ table: 'finalization_outbox', view: 'live_finalization_outbox',
    sql: "CREATE VIEW live_finalization_outbox AS SELECT * FROM finalization_outbox o WHERE NOT EXISTS (SELECT 1 FROM drafts d WHERE d.id = o.draft_id AND d.status = 'deleted')" }),
  Object.freeze({ table: 'summary_snapshots', view: 'live_summary_snapshots',
    sql: "CREATE VIEW live_summary_snapshots AS SELECT * FROM summary_snapshots s WHERE NOT EXISTS (SELECT 1 FROM drafts d WHERE d.id = s.draft_id AND d.status = 'deleted')" }),
  Object.freeze({ table: 'narrative_thread_confirmations', view: 'live_narrative_thread_confirmations',
    sql: "CREATE VIEW live_narrative_thread_confirmations AS SELECT * FROM narrative_thread_confirmations c WHERE NOT EXISTS (SELECT 1 FROM drafts d WHERE d.id = c.draft_id AND d.status = 'deleted')" }),
] as const)

// 删除三列与 status='deleted' 同进退：被删行三列都有值，其余行三列都为空。
const deletionShape = (row: 'NEW.' | '') => `CASE WHEN ${row}status IS 'deleted'
  THEN ${row}deletion_id <> '' AND ${row}deleted_from_status IN ('finalized','superseded') AND ${row}deleted_at <> ''
  ELSE ${row}deletion_id = '' AND ${row}deleted_from_status = '' AND ${row}deleted_at = '' END`

export const M07_CHAPTER_RECYCLE_SQL = `
ALTER TABLE drafts ADD COLUMN deletion_id TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN deleted_from_status TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN deleted_at TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_drafts_deletion ON drafts(deletion_id) WHERE deletion_id <> '';
CREATE TRIGGER drafts_deletion_shape_insert BEFORE INSERT ON drafts
WHEN NOT (${deletionShape('NEW.')})
BEGIN SELECT RAISE(ABORT, 'DRAFT_DELETION_SHAPE_INVALID'); END;
CREATE TRIGGER drafts_deletion_shape_update BEFORE UPDATE OF status, deletion_id, deleted_from_status, deleted_at ON drafts
WHEN NOT (${deletionShape('NEW.')})
BEGIN SELECT RAISE(ABORT, 'DRAFT_DELETION_SHAPE_INVALID'); END;
${LIVE_ROW_VIEWS.map(item => `${item.sql};`).join('\n')}
`

/** The central schema runner owns this transaction and PRAGMA user_version. */
export function applyM07ChapterRecycle(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHAPTER_RECYCLE_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M07_CHAPTER_RECYCLE_SQL)
}

export function verifyM07ChapterRecycle(db: Database.Database): boolean {
  try {
    return !db.prepare(`SELECT 1 FROM drafts WHERE NOT (${deletionShape('')}) LIMIT 1`).get()
  } catch { return false }
}

export function createM07Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M07', from: 7, to: 8, owner: 'chapter-recycle',
    migrate: reader => applyM07ChapterRecycle(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM07ChapterRecycle(deps.database(reader)) }
}
