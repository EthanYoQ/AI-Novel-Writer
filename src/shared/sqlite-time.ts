/** SQLite 的 CURRENT_TIMESTAMP 与 datetime('now') 的写法：不带时区的 UTC，精确到秒。 */
export const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u

/** 数据库记下的时刻。SQLite 写的是不带时区的 UTC，直接交给 Date 会被当成本地时间；其余写法（ISO 等）照常解析。 */
export function sqliteTime(value: string): Date {
  const match = SQLITE_TIMESTAMP.exec(value)
  return new Date(match ? `${match[1]}T${match[2]}Z` : value)
}
