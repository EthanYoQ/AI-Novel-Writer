import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('v0.9.0 release metadata', () => {
  it('uses the release version in package metadata', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.9.0')
  })

  it('resolves the release tag and exact seven-asset contract from the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const profile = JSON.parse(readFileSync('.release/release-profile.json', 'utf8')) as {
      releaseAssets: Array<{ name: string }>
    }

    expect(`v${pkg.version}`).toBe('v0.9.0')
    expect(profile.releaseAssets.map(({ name }) => name.replaceAll('{version}', pkg.version))).toEqual([
      'ai-novel-writer-setup-0.9.0.exe',
      'ai-novel-writer-setup-0.9.0.exe.blockmap',
      'latest.yml',
      'ai-novel-writer-mac-arm64-0.9.0-installer.dmg',
      'ai-novel-writer-mac-arm64-0.9.0-installer.dmg.sha256',
      'ai-novel-writer-mac-x64-0.9.0-installer.dmg',
      'ai-novel-writer-mac-x64-0.9.0-installer.dmg.sha256',
    ])
  })

  it('documents the bilingual v0.9.0 feature set, platform coverage, and security disclosure', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    for (const expected of [
      'v0.9.0',
      '长篇一致性上下文继承',
      '伏笔与叙事线索系统',
      'EPUB 导入',
      '缩放、平移和一键清空',
      '章节模型与字数控制',
      '人工审稿闭环',
      '差异对比',
      '模型高级设置',
      '获取模型列表',
      '重复任务',
      '更准确的失败提示',
      'macOS Apple Silicon',
      'macOS Intel',
      '七项资产',
      '未代码签名',
      '未公证',
    ]) {
      expect(chineseReadme).toContain(expected)
    }

    for (const expected of [
      'v0.9.0',
      'Long-form continuity context',
      'Foreshadowing and narrative threads',
      'EPUB import',
      'zoom, pan, or clear',
      'Per-chapter model and length control',
      'Human-confirmed review loop',
      'inspect the diff',
      'Advanced model settings',
      'fetch the model list',
      'Duplicate jobs',
      'More precise failure messages',
      'macOS Apple Silicon',
      'macOS Intel',
      'seven-asset',
      'not code-signed',
      'not notarized',
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
