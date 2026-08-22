import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseQualificationRuns,
  validatePromotionProfile,
} from '../../.release/scripts/github-desktop-promotion.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const profile = JSON.parse(readFileSync(path.join(repositoryRoot, '.release', 'release-profile.json'), 'utf8'))

describe('desktop promotion qualification entities', () => {
  it('requires independent Windows, Apple Silicon, and Intel qualification run identities', () => {
    const validated = validatePromotionProfile(profile)
    const entities = Object.keys(validated.platforms).sort()
    expect(entities).toEqual(['macos-arm64', 'macos-x64', 'windows'])

    const runs = parseQualificationRuns(JSON.stringify({
      windows: { runId: 101, attempt: 1, artifactId: 201 },
      'macos-arm64': { runId: 102, attempt: 1, artifactId: 202 },
      'macos-x64': { runId: 103, attempt: 1, artifactId: 203 },
    }), entities)

    expect(runs).toEqual({
      'macos-arm64': { runId: 102, attempt: 1, artifactId: 202 },
      'macos-x64': { runId: 103, attempt: 1, artifactId: 203 },
      windows: { runId: 101, attempt: 1, artifactId: 201 },
    })
    expect(validated.releaseAssets.filter(asset => asset.platform === 'macos-arm64').map(asset => asset.name))
      .toEqual([
        'ai-novel-writer-mac-arm64-{version}-installer.dmg',
        'ai-novel-writer-mac-arm64-{version}-installer.dmg.sha256',
      ])
    expect(validated.releaseAssets.filter(asset => asset.platform === 'macos-x64').map(asset => asset.name))
      .toEqual([
        'ai-novel-writer-mac-x64-{version}-installer.dmg',
        'ai-novel-writer-mac-x64-{version}-installer.dmg.sha256',
      ])
  })

  it('rejects a generic macOS alias or a run mapping that merges the two architectures', () => {
    const genericMacos = structuredClone(profile)
    genericMacos.platforms.macos = genericMacos.platforms['macos-arm64']
    delete genericMacos.platforms['macos-arm64']
    genericMacos.releaseAssets = genericMacos.releaseAssets.map((asset: { platform: string }) => (
      asset.platform === 'macos-arm64' ? { ...asset, platform: 'macos' } : asset
    ))
    expect(() => validatePromotionProfile(genericMacos)).toThrow('Unsupported platform: macos')

    expect(() => parseQualificationRuns(JSON.stringify({
      windows: { runId: 101, attempt: 1, artifactId: 201 },
      macos: { runId: 102, attempt: 1, artifactId: 202 },
    }), ['windows', 'macos-arm64', 'macos-x64'])).toThrow('qualification run mapping keys must be exactly')
  })
})
