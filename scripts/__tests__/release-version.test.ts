import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.8.5 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.8.5')
  })

  it('resolves the release tag and exact seven-asset contract from the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const profile = JSON.parse(readFileSync('.release/release-profile.json', 'utf8')) as {
      releaseAssets: Array<{ name: string }>
    }

    expect(`v${pkg.version}`).toBe('v0.8.5')
    expect(profile.releaseAssets.map(({ name }) => name.replaceAll('{version}', pkg.version))).toEqual([
      'ai-novel-writer-setup-0.8.5.exe',
      'ai-novel-writer-setup-0.8.5.exe.blockmap',
      'latest.yml',
      'ai-novel-writer-mac-arm64-0.8.5-installer.dmg',
      'ai-novel-writer-mac-arm64-0.8.5-installer.dmg.sha256',
      'ai-novel-writer-mac-x64-0.8.5-installer.dmg',
      'ai-novel-writer-mac-x64-0.8.5-installer.dmg.sha256',
    ])
  })

  it('documents the bilingual v0.8.5 authoring loop, platform coverage, and security disclosure', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    for (const expected of [
      'v0.8.5',
      '可控创作模型',
      '人工审稿到修稿',
      'macOS Apple Silicon',
      'macOS Intel',
      '七项资产',
      '未代码签名',
      '未公证',
      '`classic`',
      '`anime`',
      '`custom`',
    ]) {
      expect(chineseReadme).toContain(expected)
    }

    for (const expected of [
      'v0.8.5',
      'Controlled authoring models',
      'Human review to revision',
      'macOS Apple Silicon',
      'macOS Intel',
      'seven-asset',
      'not code-signed',
      'not notarized',
      '`classic`',
      '`anime`',
      '`custom`',
    ]) {
      expect(englishReadme).toContain(expected)
    }
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
