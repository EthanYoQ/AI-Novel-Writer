import { describe, expect, it } from 'vitest'

import {
  getOfficialHomepageOpenError,
  OFFICIAL_HOMEPAGE_URL,
} from '../../shared/official-homepage'

describe('official homepage renderer contract', () => {
  it('keeps the only trusted destination fixed and exposes localized failure copy', () => {
    expect(OFFICIAL_HOMEPAGE_URL).toBe('https://github.com/EthanYoQ/AI-Novel-Writer')
    expect(getOfficialHomepageOpenError('zh-CN')).toBe('无法打开官方主页，请稍后重试。')
    expect(getOfficialHomepageOpenError('en-US')).toBe('Unable to open the official homepage. Please try again later.')
  })
})
