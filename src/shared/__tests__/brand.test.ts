import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_BRAND } from '../brand'

const visibleBrandSurfaces = [
  'index.html',
  'src/components/panels/agent/AgentHeader.tsx',
  'src/services/agent/context-builder.ts',
  'src/services/agent/tools/open-editor.tool.ts',
  'src/services/agent/tools/start-workflow.tool.ts',
  'src/stores/agent-store.ts',
  'src/services/safe-call-diagnostic.ts',
  'src/i18n/messages/zh-CN.ts',
  'src/i18n/messages/en-US.ts',
]

const legacyNamePattern = new RegExp('\\bVe' + 'la\\b')
const legacyHiddenDirPattern = new RegExp('\\.' + 've' + 'la(?!API)', 'i')
const legacyPrefixPattern = new RegExp('ve' + 'la-', 'i')
const formerNamePattern = /AI ?小说作家|AI Novel Writer/

describe('APP_BRAND', () => {
  it('uses 书童 / Pagekin visible product language', () => {
    expect(APP_BRAND.zhName).toBe('书童')
    expect(APP_BRAND.enName).toBe('Pagekin')
    expect(APP_BRAND.shortName).toBe('书童')
    expect(Object.values(APP_BRAND).join(' ')).not.toMatch(legacyNamePattern)
  })

  it('原名与旧版实际发布的产品名逐字一致', () => {
    // v1.3.0 正式安装包里 exe 的 VersionInfo ProductName（ADR-0022 取证）；1.3.0 之后 productName 改为书童。
    const lastReleasedProductName = 'AI小说作家'
    const legacyNames = readFileSync(resolve(process.cwd(), 'scripts/product-identity.mjs'), 'utf8')

    expect(APP_BRAND.formerZhName).toBe(lastReleasedProductName)
    expect(legacyNames).toContain(`const LEGACY_PRODUCT_NAME = '${lastReleasedProductName}'`)
  })

  it('does not expose legacy product naming in visible brand surfaces', () => {
    for (const file of visibleBrandSurfaces) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')

      expect(source, file).not.toMatch(legacyNamePattern)
      expect(source, file).not.toMatch(legacyHiddenDirPattern)
      expect(source, file).not.toMatch(legacyPrefixPattern)
      expect(source, file).not.toMatch(formerNamePattern)
    }
  })
})
