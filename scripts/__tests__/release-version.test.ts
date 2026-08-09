import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.7.1 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.7.1')
  })

  it('keeps the bilingual v0.7.1 patch scope, five-asset contract, and platform limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.7.1')
    expect(chineseReadme).toContain('补丁更新')
    expect(chineseReadme).toContain('皮肤可见性')
    expect(chineseReadme).toContain('经典主题')
    expect(chineseReadme).toContain('主题一致性')
    expect(chineseReadme).toContain('向量模型入口')
    expect(chineseReadme).toContain('硅基流动')
    expect(chineseReadme).toContain('BAAI/bge-m3')
    expect(chineseReadme).toContain('免费模型注册链接')
    expect(chineseReadme).toContain('五项资产')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('Windows 安装包未签名')
    expect(chineseReadme).toContain('未签名、未公证')

    expect(englishReadme).toContain('v0.7.1')
    expect(englishReadme).toContain('patch update')
    expect(englishReadme).toContain('skin visibility')
    expect(englishReadme).toContain('classic theme')
    expect(englishReadme).toContain('theme consistency')
    expect(englishReadme).toContain('embedding-model entry')
    expect(englishReadme).toContain('SiliconFlow')
    expect(englishReadme).toContain('BAAI/bge-m3')
    expect(englishReadme).toContain('Free model registration')
    expect(englishReadme).toContain('five assets')
    expect(englishReadme).toContain('Windows x64')
    expect(englishReadme).toContain('Windows installer is not code-signed')
    expect(englishReadme).toContain('unsigned and not notarized')
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
