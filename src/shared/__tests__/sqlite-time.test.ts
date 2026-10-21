import { afterAll, describe, expect, it } from 'vitest'

const previousTimeZone = process.env.TZ
process.env.TZ = 'Asia/Shanghai'
afterAll(() => {
  if (previousTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimeZone
})

import { sqliteTime } from '../sqlite-time'

describe('数据库时刻（固定在东八区）', () => {
  it('SQLite 不带时区的写法按 UTC 解析，本地显示早 8 小时的那个钟点', () => {
    const time = sqliteTime('2026-10-13 21:05:00')
    expect(time.toISOString()).toBe('2026-10-13T21:05:00.000Z')
    expect(`${time.getDate()} ${time.getHours()}:${time.getMinutes()}`).toBe('14 5:5')
  })

  it('带时区的 ISO 写法照常解析', () => {
    expect(sqliteTime('2026-10-13T21:05:00.000Z').toISOString()).toBe('2026-10-13T21:05:00.000Z')
  })

  it('认不出的写法是无效时刻', () => {
    expect(Number.isNaN(sqliteTime('昨天').getTime())).toBe(true)
  })
})
