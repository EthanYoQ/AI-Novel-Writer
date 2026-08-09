import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.8.0 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.8.0')
  })

  it('keeps the bilingual v0.8.0 structured-roster release scope, five-asset contract, and platform limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.8.0')
    expect(chineseReadme).toContain('重大更新')
    expect(chineseReadme).toContain('结构化角色名单')
    expect(chineseReadme).toContain('角色卡的唯一事实源')
    expect(chineseReadme).toContain('一次结构化输出')
    expect(chineseReadme).toContain('SQLite 原子提交')
    expect(chineseReadme).toContain('回读成功后')
    expect(chineseReadme).toContain('旧项目必须显式安全迁移')
    expect(chineseReadme).toContain('导入、手工编辑、蓝图同步、定稿和清除')
    expect(chineseReadme).toContain('统一的角色名单 seam')
    expect(chineseReadme).toContain('#76')
    expect(chineseReadme).toContain('从根源修复')
    expect(chineseReadme).toContain('五项资产')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('Windows 安装包未签名')
    expect(chineseReadme).toContain('应用内更新')
    expect(chineseReadme).toContain('未签名、未公证')
    expect(chineseReadme).toContain('macOS ARM64')
    expect(chineseReadme).toContain('手动更新')

    expect(englishReadme).toContain('v0.8.0')
    expect(englishReadme).toContain('major update')
    expect(englishReadme).toContain('structured character roster')
    expect(englishReadme).toContain('single source of truth for character cards')
    expect(englishReadme).toContain('one structured output')
    expect(englishReadme).toContain('SQLite atomic commit')
    expect(englishReadme).toContain('read-back succeeds')
    expect(englishReadme).toContain('legacy projects require an explicit safe migration')
    expect(englishReadme).toContain('Imports, manual edits, blueprint synchronization, finalization, and clearing')
    expect(englishReadme).toContain('one roster seam')
    expect(englishReadme).toContain('#76')
    expect(englishReadme).toContain('fixing #76 at the source')
    expect(englishReadme).toContain('five assets')
    expect(englishReadme).toContain('Windows x64')
    expect(englishReadme).toContain('Windows installer is not code-signed')
    expect(englishReadme).toContain('in-app update')
    expect(englishReadme).toContain('unsigned and not notarized')
    expect(englishReadme).toContain('macOS ARM64')
    expect(englishReadme).toContain('manual update')
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
