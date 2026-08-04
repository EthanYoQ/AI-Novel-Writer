import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.6.0 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.6.0')
  })

  it('keeps the bilingual v0.6.0 major-update scope and platform limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.6.0')
    expect(chineseReadme).toContain('重大更新')
    expect(chineseReadme).toContain('更新检查')
    expect(chineseReadme).toContain('Grok')
    expect(chineseReadme).toContain('base_url')
    expect(chineseReadme).toContain('BAAI/bge-m3')
    expect(chineseReadme).toContain('每批最多 5 章')
    expect(chineseReadme).toContain('有界续写')
    expect(chineseReadme).toContain('推理')
    expect(chineseReadme).toContain('上下文')
    expect(chineseReadme).toContain('角色与关系')
    expect(chineseReadme).toContain('无需向量模型')
    expect(chineseReadme).toContain('调用统计')
    expect(chineseReadme).toContain('#71')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('未签名、未公证')
    expect(chineseReadme).toContain('手动下载更新')

    expect(englishReadme).toContain('v0.6.0')
    expect(englishReadme).toContain('major update')
    expect(englishReadme).toContain('Update checks')
    expect(englishReadme).toContain('Grok')
    expect(englishReadme).toContain('base_url')
    expect(englishReadme).toContain('BAAI/bge-m3')
    expect(englishReadme).toContain('up to five chapters per batch')
    expect(englishReadme).toContain('bounded continuation')
    expect(englishReadme).toContain('reasoning')
    expect(englishReadme).toContain('context')
    expect(englishReadme).toContain('characters and relationships')
    expect(englishReadme).toContain('without a vector model')
    expect(englishReadme).toContain('usage statistics')
    expect(englishReadme).toContain('#71')
    expect(englishReadme).toContain('Windows x64')
    expect(englishReadme).toContain('unsigned and not notarized')
    expect(englishReadme).toContain('manually from the Release page')
  })

  it('keeps stale Mythpen branding out of release metadata', () => {
    const releaseConfig = readFileSync('package.json', 'utf8')
    expect(releaseConfig.toLowerCase()).not.toContain('mythpen')
  })

  it('lets the Windows smoke command discover the current release executable', () => {
    const smokeScript = readFileSync('scripts/smoke-win-app.ps1', 'utf8')
    expect(smokeScript).toContain('package.json')
    expect(smokeScript).toContain('AI小说作家.exe')
  })
})
