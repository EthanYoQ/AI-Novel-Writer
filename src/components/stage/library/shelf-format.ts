import { pluralEn } from '../../../shared/plural-en'
type Text = (zh: string, en: string) => string

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 书架上的时间：今天写时刻，昨天、一周内写相对天数，更早写月日，跨年加年份。无效时间返回空串。 */
export function shelfTime(iso: string, now: Date, text: Text): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (days <= 0) return text(`今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`, `Today ${pad(date.getHours())}:${pad(date.getMinutes())}`)
  if (days === 1) return text('昨天', 'Yesterday')
  if (days < 7) return text(`${days} 天前`, `${days} ${pluralEn(days, 'day')} ago`)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const monthEn = date.toLocaleString('en-US', { month: 'short' })
  if (date.getFullYear() === now.getFullYear()) return text(`${month} 月 ${day} 日`, `${monthEn} ${day}`)
  return text(`${date.getFullYear()} 年 ${month} 月 ${day} 日`, `${monthEn} ${day}, ${date.getFullYear()}`)
}

/** 封面色调：按书名稳定地取一种，同一本书每次都是同一种颜色。 */
export const COVER_TONES = ['navy', 'sand', 'sage', 'umber', 'paper'] as const
export type CoverTone = typeof COVER_TONES[number]

export function coverTone(name: string): CoverTone {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return COVER_TONES[hash % COVER_TONES.length]
}
