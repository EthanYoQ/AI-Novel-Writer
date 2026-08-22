import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.8.4 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.8.4')
  })

  it('resolves the release tag and exact seven-asset contract from the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const profile = JSON.parse(readFileSync('.release/release-profile.json', 'utf8')) as {
      releaseAssets: Array<{ name: string }>
    }

    expect(`v${pkg.version}`).toBe('v0.8.4')
    expect(profile.releaseAssets.map(({ name }) => name.replaceAll('{version}', pkg.version))).toEqual([
      'ai-novel-writer-setup-0.8.4.exe',
      'ai-novel-writer-setup-0.8.4.exe.blockmap',
      'latest.yml',
      'ai-novel-writer-mac-arm64-0.8.4-installer.dmg',
      'ai-novel-writer-mac-arm64-0.8.4-installer.dmg.sha256',
      'ai-novel-writer-mac-x64-0.8.4-installer.dmg',
      'ai-novel-writer-mac-x64-0.8.4-installer.dmg.sha256',
    ])
  })

  it('documents the bilingual v0.8.4 reliability release and keeps v0.8.3 history', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.8.4')
    expect(chineseReadme).toContain('#92')
    expect(chineseReadme).toContain('#99')
    expect(chineseReadme).toContain('#101')
    expect(chineseReadme).toContain('流式')
    expect(chineseReadme).toContain('推理')
    expect(chineseReadme).toContain('v0.8.3')
    expect(chineseReadme).toContain('v0.8.2')

    expect(englishReadme).toContain('v0.8.4')
    expect(englishReadme).toContain('#92')
    expect(englishReadme).toContain('#99')
    expect(englishReadme).toContain('#101')
    expect(englishReadme).toContain('streaming')
    expect(englishReadme).toContain('reasoning')
    expect(englishReadme).toContain('v0.8.3')
    expect(englishReadme).toContain('v0.8.2')
  })

  it('keeps the bilingual v0.8.2 systemic release scope, evidence, five-asset contract, and platform limitations in the READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    expect(chineseReadme).toContain('v0.8.2')
    expect(chineseReadme).toContain('重大更新')
    expect(chineseReadme).toContain('#87')
    expect(chineseReadme).toContain('输出预算')
    expect(chineseReadme).toContain('低增量')
    expect(chineseReadme).toContain('不完整')
    expect(chineseReadme).toContain('不落盘')
    expect(chineseReadme).toContain('#88')
    expect(chineseReadme).toContain('PromptCatalog')
    expect(chineseReadme).toContain('全局提示词')
    expect(chineseReadme).toContain('#90')
    expect(chineseReadme).toContain('真实 Agent 工作流')
    expect(chineseReadme).toContain('普通 Markdown')
    expect(chineseReadme).toContain('项目事实')
    expect(chineseReadme).toContain('DeepSeek V4 Flash')
    expect(chineseReadme).toContain('20 章')
    expect(chineseReadme).toContain('40,279')
    expect(chineseReadme).toContain('五项资产')
    expect(chineseReadme).toContain('ai-novel-writer-setup-0.8.2.exe')
    expect(chineseReadme).toContain('ai-novel-writer-setup-0.8.2.exe.blockmap')
    expect(chineseReadme).toContain('latest.yml')
    expect(chineseReadme).toContain('ai-novel-writer-mac-arm64-0.8.2-installer.dmg')
    expect(chineseReadme).toContain('ai-novel-writer-mac-arm64-0.8.2-installer.dmg.sha256')
    expect(chineseReadme).toContain('Windows x64')
    expect(chineseReadme).toContain('Windows 安装包未签名')
    expect(chineseReadme).toContain('应用内更新')
    expect(chineseReadme).toContain('ad-hoc 或未签名')
    expect(chineseReadme).toContain('未公证')
    expect(chineseReadme).toContain('macOS ARM64')
    expect(chineseReadme).toContain('手动更新')
    expect(chineseReadme).not.toContain('Gemini 已验证')
    expect(chineseReadme).not.toContain('第三方代理已验证')

    expect(englishReadme).toContain('v0.8.2')
    expect(englishReadme).toContain('major update')
    expect(englishReadme).toContain('#87')
    expect(englishReadme).toContain('output budget')
    expect(englishReadme).toContain('low-progress')
    expect(englishReadme).toContain('incomplete')
    expect(englishReadme).toContain('not persisted')
    expect(englishReadme).toContain('#88')
    expect(englishReadme).toContain('PromptCatalog')
    expect(englishReadme).toContain('global prompts')
    expect(englishReadme).toContain('#90')
    expect(englishReadme).toContain('real Agent workflow')
    expect(englishReadme).toContain('ordinary Markdown')
    expect(englishReadme).toContain('project fact')
    expect(englishReadme).toContain('DeepSeek V4 Flash')
    expect(englishReadme).toContain('20 chapters')
    expect(englishReadme).toContain('40,279')
    expect(englishReadme).toContain('five assets')
    expect(englishReadme).toContain('ai-novel-writer-setup-0.8.2.exe')
    expect(englishReadme).toContain('ai-novel-writer-setup-0.8.2.exe.blockmap')
    expect(englishReadme).toContain('latest.yml')
    expect(englishReadme).toContain('ai-novel-writer-mac-arm64-0.8.2-installer.dmg')
    expect(englishReadme).toContain('ai-novel-writer-mac-arm64-0.8.2-installer.dmg.sha256')
    expect(englishReadme).toContain('Windows x64')
    expect(englishReadme).toContain('Windows installer is not code-signed')
    expect(englishReadme).toContain('in-app update')
    expect(englishReadme).toContain('ad-hoc or unsigned')
    expect(englishReadme).toContain('not notarized')
    expect(englishReadme).toContain('macOS ARM64')
    expect(englishReadme).toContain('manual update')
    expect(englishReadme).not.toContain('Gemini verified')
    expect(englishReadme).not.toContain('third-party proxy verified')
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
