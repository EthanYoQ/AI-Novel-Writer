/**
 * 数据库时间戳的本地化显示。
 *
 * 守的是一个很隐蔽、后果却不小的问题：
 * SQLite 的 `datetime('now')` 返回的是 **UTC**，格式为 `YYYY-MM-DD HH:MM:SS`
 * （没有 T、没有 Z）。这种字符串直接 `new Date()` 会被**按本地时区**解析，
 * 于是界面显示的时间会整整差一个时区。
 *
 * 对作者的实际影响不是"看着别扭"，而是**误判功能没生效**：
 * 明明刚落袋了一条剧情进展，条目的「最后更新」却还停在几小时前。
 */
import { describe, expect, it } from 'vitest'

import { formatDbTimestamp } from '../time'

/** 拼出某个 UTC 时刻在**运行环境本地时区**下应有的显示字符串。 */
function localExpected(isoUtc: string, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  return new Date(isoUtc).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

describe('formatDbTimestamp', () => {
  it('reads a SQLite UTC timestamp as UTC instead of local time', () => {
    // 关键断言：结果必须等于「同一时刻」的本地显示。
    // 若实现误按本地解析，在 UTC+8 下会差 8 小时，本断言即失败。
    expect(formatDbTimestamp('2026-09-14 11:13:35', 'zh-CN'))
      .toBe(localExpected('2026-09-14T11:13:35Z', 'zh-CN'))
  })

  it('accepts a timestamp without seconds', () => {
    expect(formatDbTimestamp('2026-09-14 11:13', 'zh-CN'))
      .toBe(localExpected('2026-09-14T11:13:00Z', 'zh-CN'))
  })

  it('leaves an already-zoned ISO string alone (no double conversion)', () => {
    // 已经带时区标记的输入不能被再补一个 Z —— 否则会重复偏移
    expect(formatDbTimestamp('2026-09-14T11:13:35Z', 'zh-CN'))
      .toBe(localExpected('2026-09-14T11:13:35Z', 'zh-CN'))
  })

  it('honours an explicit offset in the input', () => {
    // +08:00 的 11:13:35 与 UTC 的 03:13:35 是同一时刻
    expect(formatDbTimestamp('2026-09-14T11:13:35+08:00', 'zh-CN'))
      .toBe(localExpected('2026-09-14T03:13:35Z', 'zh-CN'))
  })

  it('returns an empty string for empty input', () => {
    expect(formatDbTimestamp('', 'zh-CN')).toBe('')
    expect(formatDbTimestamp(null, 'zh-CN')).toBe('')
    expect(formatDbTimestamp(undefined, 'zh-CN')).toBe('')
    expect(formatDbTimestamp('   ', 'zh-CN')).toBe('')
  })

  it('falls back to the raw value when it cannot be parsed', () => {
    // 宁可原样显示，也不要显示 "Invalid Date"
    expect(formatDbTimestamp('不是时间', 'zh-CN')).toBe('不是时间')
  })

  it('uses the requested locale for the format shell', () => {
    const en = formatDbTimestamp('2026-09-14 11:13:35', 'en-US')
    expect(en.length).toBeGreaterThan(0)
    expect(en).not.toContain('Invalid')
    // 两种语言的格式化结果都应指向同一时刻
    expect(en).toBe(localExpected('2026-09-14T11:13:35Z', 'en-US'))
  })
})
