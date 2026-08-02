import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.5.2 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.5.2')
  })

  it('keeps the bilingual v0.5.2 patch scope and updater limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.5.2')
    expect(chineseReadme).toContain('#73')
    expect(chineseReadme).toContain('3000')
    expect(chineseReadme).toContain('#74')
    expect(chineseReadme).toContain('HTML')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('未签名、未公证')
    expect(chineseReadme).toContain('手动下载更新')

    expect(englishReadme).toContain('v0.5.2')
    expect(englishReadme).toContain('#73')
    expect(englishReadme).toContain('3,000')
    expect(englishReadme).toContain('#74')
    expect(englishReadme).toContain('non-JSON')
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
