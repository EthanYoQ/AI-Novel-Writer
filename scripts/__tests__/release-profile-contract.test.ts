import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const profilePath = path.join(repositoryRoot, '.release', 'release-profile.json')
const validatorPath = path.join(repositoryRoot, '.release', 'scripts', 'validate-release-profile.mjs')
const promotionScriptPath = path.join(repositoryRoot, '.release', 'scripts', 'github-desktop-promotion.mjs')
const promotionWorkflowPath = path.join(repositoryRoot, '.github', 'workflows', 'cross-platform-runtime-artifact-promotion.yml')

describe('desktop release profile contract', () => {
  it('keeps the validator and promotion consumer architecture-aware', () => {
    expect(existsSync(validatorPath)).toBe(true)
    expect(existsSync(promotionScriptPath)).toBe(true)
    const validator = readFileSync(validatorPath, 'utf8')
    const promotion = readFileSync(promotionScriptPath, 'utf8')
    expect(validator).toContain("'macos-arm64'")
    expect(validator).toContain("'macos-x64'")
    expect(promotion).toContain('qualification manifest entity mismatch')
    expect(promotion).toContain('run ledger entity mismatch')
    expect(promotion).toContain('release contract does not declare the qualification entity')
    expect(existsSync(promotionWorkflowPath)).toBe(true)
  })

  it('pins release source and tests to LF in every Git checkout', () => {
    const attributes = spawnSync('git', [
      '-c', 'core.attributesfile=',
      'check-attr', 'eol', '--',
      '.release/scripts/validate-release-profile.mjs',
      '.release/scripts/github-desktop-promotion.mjs',
      '.github/workflows/cross-platform-runtime-artifact-promotion.yml',
      'scripts/__tests__/release-qualification-adapter.test.ts',
    ], { cwd: repositoryRoot, encoding: 'utf8' })

    expect(attributes.status, attributes.stderr).toBe(0)
    expect(attributes.stdout.trim().split(/\r?\n/u)).toEqual([
      '.release/scripts/validate-release-profile.mjs: eol: lf',
      '.release/scripts/github-desktop-promotion.mjs: eol: lf',
      '.github/workflows/cross-platform-runtime-artifact-promotion.yml: eol: lf',
      'scripts/__tests__/release-qualification-adapter.test.ts: eol: lf',
    ])
  })

  it('declares the exact project release facts and passes the shared validator', () => {
    expect(existsSync(profilePath)).toBe(true)
    const validation = spawnSync(process.execPath, [validatorPath, '--profile', profilePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    expect(validation.status, validation.stderr).toBe(0)

    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(profile.platforms.windows).toMatchObject({
      qualificationWorkflow: '.github/workflows/windows-cloud-build-test.yml',
      artifactName: 'qualified-windows',
      architectures: ['x64'],
      retentionDays: 14,
      acceptanceReceipts: [
        'acceptance/install.json',
        'acceptance/launch.json',
        'acceptance/quiet-window.json',
        'acceptance/error-dialogs.json',
        'acceptance/uninstall.json',
        'acceptance/upgrade-data.json',
        'acceptance/native-abi.json',
        'acceptance/packaged-smoke.json',
        'acceptance/signing.json',
      ],
    })
    expect(profile.platforms['macos-arm64']).toMatchObject({
      qualificationWorkflow: '.github/workflows/macos-arm64-cloud-build.yml',
      artifactName: 'qualified-macos-arm64',
      architectures: ['arm64'],
      retentionDays: 14,
      acceptanceReceipts: [
        'acceptance/dmg-mount.json',
        'acceptance/packaged-smoke.json',
        'acceptance/signing.json',
      ],
    })
    expect(profile.platforms['macos-x64']).toMatchObject({
      qualificationWorkflow: '.github/workflows/macos-x64-cloud-build.yml',
      artifactName: 'qualified-macos-x64',
      architectures: ['x64'],
      retentionDays: 14,
      acceptanceReceipts: [
        'acceptance/dmg-mount.json',
        'acceptance/packaged-smoke.json',
        'acceptance/signing.json',
      ],
    })
    expect(profile.releaseAssets).toEqual([
      { name: 'ai-novel-writer-setup-{version}.exe', platform: 'windows', role: 'installer' },
      { name: 'ai-novel-writer-setup-{version}.exe.blockmap', platform: 'windows', role: 'update-metadata' },
      { name: 'latest.yml', platform: 'windows', role: 'update-metadata' },
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg', platform: 'macos-arm64', role: 'installer' },
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg.sha256', platform: 'macos-arm64', role: 'checksum' },
      { name: 'ai-novel-writer-mac-x64-{version}-installer.dmg', platform: 'macos-x64', role: 'installer' },
      { name: 'ai-novel-writer-mac-x64-{version}-installer.dmg.sha256', platform: 'macos-x64', role: 'checksum' },
    ])
    expect(profile.promotion).toEqual({
      workflow: '.github/workflows/cross-platform-runtime-artifact-promotion.yml',
      finalState: 'published',
    })
  })
})
