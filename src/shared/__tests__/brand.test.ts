import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_BRAND } from '../brand'

const visibleBrandSurfaces = [
  'index.html',
  'src/components/panels/agent/AgentHeader.tsx',
]

const legacyNamePattern = new RegExp('ve' + 'la', 'i')
const legacyHiddenDirPattern = new RegExp('\\.' + 've' + 'la', 'i')
const legacyPrefixPattern = new RegExp('ve' + 'la-', 'i')

describe('APP_BRAND', () => {
  it('uses AI小说作家 visible product language', () => {
    expect(APP_BRAND.zhName).toBe('AI小说作家')
    expect(APP_BRAND.enName).toBe('AI Novel Writer')
    expect(APP_BRAND.shortName).toBe('AI小说作家')
    expect(Object.values(APP_BRAND).join(' ')).not.toMatch(legacyNamePattern)
  })

  it('does not expose legacy product naming in visible brand surfaces', () => {
    for (const file of visibleBrandSurfaces) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')

      expect(source, file).not.toMatch(legacyNamePattern)
      expect(source, file).not.toMatch(legacyHiddenDirPattern)
      expect(source, file).not.toMatch(legacyPrefixPattern)
    }
  })
})
