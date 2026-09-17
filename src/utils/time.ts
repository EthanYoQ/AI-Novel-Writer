/**
 * 格式化相对时间（如：刚刚 / 5分钟前 / 2小时前 / 3天前）
 */
export function formatRelativeTime(timestamp: number, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return locale === 'en-US' ? 'just now' : '刚刚'
  if (minutes < 60) return locale === 'en-US' ? `${minutes}m ago` : `${minutes}分钟前`
  if (hours < 24) return locale === 'en-US' ? `${hours}h ago` : `${hours}小时前`
  if (days < 7) return locale === 'en-US' ? `${days}d ago` : `${days}天前`
  return new Date(timestamp).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/**
 * 格式化日期为本地化字符串
 */
export function formatDate(timestamp: number, options?: Intl.DateTimeFormatOptions): string {
  return new Date(timestamp).toLocaleString('zh-CN', options ?? {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * SQLite `datetime()` 的固定输出形状：`YYYY-MM-DD HH:MM[:SS]`（**UTC**，无时区标记）。
 *
 * 秒是可选的：`datetime('now')` 一定带秒，但 `datetime('now','start of day')`
 * 这类表达式、以及人工改库的数据都可能省略它。少识别一种就少漏一个时区 bug。
 */
const SQLITE_UTC_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/

/**
 * 把数据库时间搓成 **本地时区** 的可读字符串。
 *
 * 为什么必须有这个函数：SQLite 的 `datetime('now')` 固定返回 **UTC**，
 * 且格式是 `YYYY-MM-DD HH:MM:SS` —— 没有 `T`、没有 `Z`、也没有偏移量。
 * 这种字符串直接交给 `new Date()` 会被**按本地时区**解析（ES 规范对
 * date-time 形式的特殊照顾），于是显示出来的时间比真实时间**早 8 小时**（UTC+8）。
 *
 * 后果不只是"看着别扭"：作者会以为条目**没有被更新** —— 明明刚落袋了一条进展，
 * 时间却还停在几小时前，很容易被当成功能没生效。
 *
 * 容错：已经是 ISO（带 `T`/`Z`/偏移量）或数字时间戳的输入按原样交给 `Date` 处理，
 * 不会被重复补 `Z` —— 只有「长得像 date-time 形式」的字符串才按 UTC 解释。
 */
export function formatDbTimestamp(
  value: string | null | undefined,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return ''
  const raw = value.trim()
  if (!raw) return ''
  const normalized = SQLITE_UTC_PATTERN.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString(locale, options ?? {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
