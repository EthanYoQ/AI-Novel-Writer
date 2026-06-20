import { describe, expect, it } from 'vitest'
import { APP_BRAND } from '../brand'

describe('APP_BRAND', () => {
  it('uses AI小说作家 visible product language', () => {
    expect(APP_BRAND.zhName).toBe('AI小说作家')
    expect(APP_BRAND.enName).toBe('AI Novel Writer')
    expect(APP_BRAND.shortName).toBe('AI小说作家')
    expect(Object.values(APP_BRAND).join(' ')).not.toMatch(/\bVela\b/i)
  })
})
