import type BetterSqlite3 from 'better-sqlite3'

/** 本章下一版本号。回收站里的行仍占着版本号（idx_drafts_chapter_version 唯一），所以这里读原表。 */
export function nextDraftVersion(db: BetterSqlite3.Database, chapterNumber: number): number {
  const max = db.prepare('SELECT MAX(version) FROM drafts_all WHERE chapter_number = ?').pluck().get(chapterNumber) as number | null
  return (max ?? 0) + 1
}
