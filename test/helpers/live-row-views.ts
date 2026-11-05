import type BetterSqlite3 from 'better-sqlite3'

import { LIVE_ROW_VIEWS } from '../../electron/migrations/m07-chapter-recycle'

/** 不走迁移、手写表结构的夹具，补上 M07 的 live_ 视图；只给已存在的原表建，已建过的跳过。 */
export function createLiveRowViews(db: BetterSqlite3.Database): void {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?')
  for (const { table, view, sql } of LIVE_ROW_VIEWS) if (exists.get(table) && !exists.get(view)) db.exec(sql)
}
