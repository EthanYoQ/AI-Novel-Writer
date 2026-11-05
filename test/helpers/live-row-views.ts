import type BetterSqlite3 from 'better-sqlite3'

import { LIVE_ROW_VIEWS, M07_DRAFT_COLUMNS, M07_DRAFT_SHAPE_SQL } from '../../electron/migrations/m07-chapter-recycle'

/** 不走迁移、手写表结构的夹具，补上 M07 的回收站三列（连同删除形状触发器）、改名与 live 视图；只处理还是原表的，处理过的跳过。 */
export function createLiveRowViews(db: BetterSqlite3.Database): void {
  const type = db.prepare('SELECT type FROM sqlite_master WHERE name=?').pluck()
  if (type.get('drafts') === 'table') {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('drafts')").pluck().all() as string[])
    const present = M07_DRAFT_COLUMNS.filter(column => columns.has(column)).length
    // 三列全无就照迁移补上（连同触发器）；全有说明已迁移过（如 dropLiveRowViews 之后），触发器随表保留；只有一部分是夹具写错了。
    if (present === 0) db.exec(M07_DRAFT_SHAPE_SQL)
    else if (present !== M07_DRAFT_COLUMNS.length) throw new Error('LIVE_ROW_VIEWS_PARTIAL_DELETION_COLUMNS')
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
