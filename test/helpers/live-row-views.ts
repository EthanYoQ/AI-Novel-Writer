import type BetterSqlite3 from 'better-sqlite3'

import { LIVE_ROW_VIEWS, M07_CHAPTER_RECYCLE_SQL, M07_DRAFT_COLUMNS } from '../../electron/migrations/m07-chapter-recycle'

/** M07 改名之前的部分：三列、索引与删除形状触发器。 */
const renameAt = M07_CHAPTER_RECYCLE_SQL.indexOf('ALTER TABLE drafts RENAME TO')
if (renameAt < 0) throw new Error('M07_DRAFT_SHAPE_SQL_NOT_FOUND')
const M07_DRAFT_SHAPE_SQL = M07_CHAPTER_RECYCLE_SQL.slice(0, renameAt)

/** 不走迁移、手写表结构的夹具，补上 M07 的回收站三列（连同删除形状触发器）、改名与 live 视图；只处理还是原表的，处理过的跳过。 */
export function createLiveRowViews(db: BetterSqlite3.Database): void {
  const type = db.prepare('SELECT type FROM sqlite_master WHERE name=?').pluck()
  if (type.get('drafts') === 'table') {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('drafts')").pluck().all() as string[])
    if (M07_DRAFT_COLUMNS.every(column => !columns.has(column))) db.exec(M07_DRAFT_SHAPE_SQL)
    else for (const column of M07_DRAFT_COLUMNS) {
      if (!columns.has(column)) db.exec(`ALTER TABLE drafts ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
    }
  }
  for (const { view, table, sql } of LIVE_ROW_VIEWS) {
    if (type.get(view) !== 'table') continue
    db.exec(`ALTER TABLE ${view} RENAME TO ${table}`)
    db.exec(sql)
  }
}

/** 把迁到 schema 8 的库退回 M07 之前的表名，给「把当前库改成旧库再跑基线规范化」的夹具用。 */
export function dropLiveRowViews(db: BetterSqlite3.Database): void {
  for (const { view } of LIVE_ROW_VIEWS) db.exec(`DROP VIEW ${view}`)
  for (const { view, table } of LIVE_ROW_VIEWS) db.exec(`ALTER TABLE ${table} RENAME TO ${view}`)
}
