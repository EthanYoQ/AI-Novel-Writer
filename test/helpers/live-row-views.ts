import type BetterSqlite3 from 'better-sqlite3'

import { LIVE_ROW_VIEWS } from '../../electron/migrations/m07-chapter-recycle'

/** 不走迁移、手写表结构的夹具，补上 M07 的改名与 live 视图；只处理还是原表的，处理过的跳过。 */
export function createLiveRowViews(db: BetterSqlite3.Database): void {
  const type = db.prepare('SELECT type FROM sqlite_master WHERE name=?').pluck()
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
