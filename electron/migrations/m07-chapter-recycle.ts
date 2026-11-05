import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

/**
 * 回收站的存储形态（#564）。被删章的行原地留在原表，drafts.status 置为 'deleted'。
 * 四张受管原表改名为 <原名>_all，原名留给只含未删行的视图：读取写原名就看不见被删行，
 * 写入与少数必须看见被删行的读取写 _all（视图不可写，写错会被 SQLite 拒绝）。
 * 本迁移只改结构，不产生任何 deleted 行。
 */
export const M07_DRAFT_COLUMNS = Object.freeze(['deletion_id', 'deleted_from_status', 'deleted_at'] as const)

const childView = (view: string, alias: string) =>
  `CREATE VIEW ${view} AS SELECT * FROM ${view}_all ${alias} WHERE NOT EXISTS (SELECT 1 FROM drafts_all d WHERE d.id = ${alias}.draft_id AND d.status = 'deleted')`

export const LIVE_ROW_VIEWS = Object.freeze([
  Object.freeze({ view: 'drafts', table: 'drafts_all',
    sql: "CREATE VIEW drafts AS SELECT * FROM drafts_all WHERE status IS NOT 'deleted'" }),
  Object.freeze({ view: 'finalization_outbox', table: 'finalization_outbox_all', sql: childView('finalization_outbox', 'o') }),
  Object.freeze({ view: 'summary_snapshots', table: 'summary_snapshots_all', sql: childView('summary_snapshots', 's') }),
  Object.freeze({ view: 'narrative_thread_confirmations', table: 'narrative_thread_confirmations_all',
    sql: childView('narrative_thread_confirmations', 'c') }),
] as const)

const logicalNames = new Map<string, string>(LIVE_ROW_VIEWS.map(item => [item.table, item.view]))
/** 按表名登记的东西（便携字段策略、行数证据、历史投影）沿用改名前的名字，schema 7 与 8 之间保持一致。 */
export function logicalTableName(table: string): string { return logicalNames.get(table) ?? table }

// 删除三列与 status='deleted' 同进退：被删行三列都有值，其余行三列都为空。
const deletionShape = (row: 'NEW.' | '') => `CASE WHEN ${row}status IS 'deleted'
  THEN ${row}deletion_id <> '' AND ${row}deleted_from_status IN ('finalized','superseded') AND ${row}deleted_at <> ''
  ELSE ${row}deletion_id = '' AND ${row}deleted_from_status = '' AND ${row}deleted_at = '' END`

// RENAME 会把其他表的外键与本迁移刚建的索引、触发器一并改指新名（legacy_alter_table 关闭时）。
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
${LIVE_ROW_VIEWS.map(item => `ALTER TABLE ${item.view} RENAME TO ${item.table};`).join('\n')}
${LIVE_ROW_VIEWS.map(item => `${item.sql};`).join('\n')}
`

/** The central schema runner owns this transaction and PRAGMA user_version. */
export function applyM07ChapterRecycle(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHAPTER_RECYCLE_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M07_CHAPTER_RECYCLE_SQL)
}

export function verifyM07ChapterRecycle(db: Database.Database): boolean {
  try {
    return !db.prepare(`SELECT 1 FROM drafts_all WHERE NOT (${deletionShape('')}) LIMIT 1`).get()
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
