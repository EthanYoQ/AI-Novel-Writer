import { localize as localeText } from '../i18n/core'
/**
 * 格式化相对时间（如：刚刚 / 5分钟前 / 2小时前 / 3天前）
 */
export function formatRelativeTime(timestamp: number, locale: 'zh-CN' | 'zh-TW' | 'en-US' = 'zh-CN'): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return localeText(locale, '刚刚', 'just now')
  if (minutes < 60) return localeText(locale, "{value0}分钟前", "{value0}m ago", { value0: String(minutes) })
  if (hours < 24) return localeText(locale, "{value0}小时前", "{value0}h ago", { value0: String(hours) })
  if (days < 7) return localeText(locale, "{value0}天前", "{value0}d ago", { value0: String(days) })
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
