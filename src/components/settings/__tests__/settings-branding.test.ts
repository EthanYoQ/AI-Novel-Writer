import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const checkedSources = [
  'src/components/settings/SettingsModal.tsx',
  'electron/main.ts',
]

const visibleBrandingSource = checkedSources
  .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
  .join('\n')

const forbiddenVisibleLegacy = [
  'Vela IDE',
  'heider',
  '/buyme/',
  'wepay',
  'alipay',
  'wechat.jpg',
  '微信打赏',
  '支付宝打赏',
  '扫码赞助',
  '赞助与支持',
  '商业合作与技术交流',
  'Crafted with',
  'Vela —',
]

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '\\uFE0F',
].join('|'), 'u')

describe('settings visible branding', () => {
  it('does not expose legacy support, payment QR, or pseudo-icon branding', () => {
    for (const value of forbiddenVisibleLegacy) {
      expect(visibleBrandingSource).not.toContain(value)
    }

    expect(visibleBrandingSource).not.toMatch(pseudoIconPattern)
    expect(visibleBrandingSource).not.toMatch(/<svg\b|<path\b/)
  })
})
