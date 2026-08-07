import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.7.0 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.7.0')
  })

  it('keeps the bilingual v0.7.0 skin and qualification scope plus platform limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.7.0')
    expect(chineseReadme).toContain('重大更新')
    expect(chineseReadme).toContain('经典、原创二次元与自定义图片皮肤')
    expect(chineseReadme).toContain('PNG 或 JPEG')
    expect(chineseReadme).toContain('主进程')
    expect(chineseReadme).toContain('安全回退')
    expect(chineseReadme).toContain('正式 Release 应用内更新端到端验收能力')
    expect(chineseReadme).toContain('静默完成安装并自动拉起新版本')
    expect(chineseReadme).toContain('双平台打包皮肤 smoke')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('未签名、未公证')
    expect(chineseReadme).toContain('手动下载更新')

    expect(englishReadme).toContain('v0.7.0')
    expect(englishReadme).toContain('major update')
    expect(englishReadme).toContain('classic, original anime, and custom image skins')
    expect(englishReadme).toContain('PNG or JPEG')
    expect(englishReadme).toContain('main process')
    expect(englishReadme).toContain('safe fallback')
    expect(englishReadme).toContain('formal-Release in-app-update end-to-end qualification')
    expect(englishReadme).toContain('installs silently and relaunches the new version automatically')
    expect(englishReadme).toContain('cross-platform packaged-skin smoke')
    expect(englishReadme).toContain('Windows x64')
    expect(englishReadme).toContain('unsigned and not notarized')
    expect(englishReadme).toContain('manual download from the Release page')
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
