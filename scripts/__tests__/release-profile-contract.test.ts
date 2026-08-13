import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const profilePath = path.join(repositoryRoot, '.release', 'release-profile.json')
const validatorPath = path.join(repositoryRoot, '.release', 'scripts', 'validate-release-profile.mjs')
const promotionScriptPath = path.join(repositoryRoot, '.release', 'scripts', 'github-desktop-promotion.mjs')
const promotionWorkflowPath = path.join(repositoryRoot, '.github', 'workflows', 'cross-platform-runtime-artifact-promotion.yml')

const rawSha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('desktop release profile contract', () => {
  it('vendors the shared validator and promotion consumer byte-for-byte', () => {
    expect(existsSync(validatorPath)).toBe(true)
    expect(existsSync(promotionScriptPath)).toBe(true)
    expect(rawSha256(validatorPath)).toBe('d3f1997bdbd980a6fe58b053dc4f4a1491e4269d75a069fe7e9b6b4d2e4fa7eb')
    expect(rawSha256(promotionScriptPath)).toBe('cb4b6a08c78dfb514af25da4cddc5c08c40811e487c1a6dee04ba8ca8953fef2')
    expect(rawSha256(promotionWorkflowPath)).toBe('6929a232d08e33c5af43c0e9b07759b0122dc884e9c1f8cc227d7bddfc109631')
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
    expect(profile.platforms.macos).toMatchObject({
      qualificationWorkflow: '.github/workflows/macos-arm64-cloud-build.yml',
      artifactName: 'qualified-macos',
      architectures: ['arm64'],
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
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg', platform: 'macos', role: 'installer' },
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg.sha256', platform: 'macos', role: 'checksum' },
    ])
    expect(profile.promotion).toEqual({
      workflow: '.github/workflows/cross-platform-runtime-artifact-promotion.yml',
      finalState: 'published',
    })
  })
})
