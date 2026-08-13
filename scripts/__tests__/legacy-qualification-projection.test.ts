import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectLegacyQualificationBundle } from '../../.release/scripts/project-legacy-qualification.mjs'

const roots: string[] = []
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const version = (JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version
const dmg = `ai-novel-writer-mac-arm64-${version}-installer.dmg`
const checksum = `${dmg}.sha256`
const acceptance = [
  'qualification/acceptance/dmg-mount.json',
  'qualification/acceptance/packaged-smoke.json',
  'qualification/acceptance/signing.json',
]
const evidence = [
  'qualification/release-contract.json',
  'qualification/run-ledger.json',
  ...acceptance,
  'qualification/packaged-vector-smoke.json',
  'qualification/packaged-official-homepage-smoke.json',
  'qualification/packaged-skin-smoke.json',
  'qualification/macos-dmg-smoke.json',
]

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-qualification-projection-'))
  roots.push(root)
  const sourceRoot = path.join(root, 'electron-builder-output')
  const outputRoot = path.join(root, 'projected-legacy-release')
  const profilePath = path.join(root, 'release-profile.json')
  fs.mkdirSync(sourceRoot, { recursive: true })
  write(path.join(sourceRoot, dmg), 'electron-builder-dmg-bytes')
  write(path.join(sourceRoot, checksum), 'electron-builder-checksum-bytes')
  for (const relativePath of evidence) write(path.join(sourceRoot, ...relativePath.split('/')), JSON.stringify({ relativePath }))
  write(path.join(sourceRoot, 'latest-mac.yml'), 'not a release asset')
  write(path.join(sourceRoot, `${dmg}.blockmap`), 'not a release asset')
  write(path.join(sourceRoot, 'builder-debug.yml'), 'not release evidence')
  write(path.join(sourceRoot, 'mac-arm64', 'AI Novel Writer.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'), 'unpacked intermediary')
  write(profilePath, JSON.stringify({
    platforms: {
      macos: {
        acceptanceReceipts: acceptance.map(relativePath => relativePath.replace(/^qualification\//, '')),
      },
    },
    releaseAssets: [
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg', platform: 'macos', role: 'installer' },
      { name: 'ai-novel-writer-mac-arm64-{version}-installer.dmg.sha256', platform: 'macos', role: 'checksum' },
    ],
  }))
  const manifest = {
    schemaVersion: 2,
    platform: 'macos',
    version,
    acceptanceProfile: acceptance,
    artifacts: [dmg, checksum].map(file => ({ file })),
    evidence: evidence.map(file => ({ file })),
  }
  write(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest))
  const records = [...manifest.artifacts, ...manifest.evidence, { file: 'manifest.json' }]
  write(path.join(sourceRoot, 'SHA256SUMS.txt'), `${records.map(record => `${sha256(path.join(sourceRoot, ...record.file.split('/')))} *${record.file}`).join('\n')}\n`)
  return { sourceRoot, outputRoot, profilePath }
}

function relativeFiles(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(relativePath => fs.statSync(path.join(root, relativePath)).isFile())
    .map(relativePath => relativePath.replaceAll('\\', '/'))
    .sort()
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('legacy qualification bundle projection', () => {
  it('copies only the profile assets and hash-bound legacy evidence without changing Electron Builder bytes', () => {
    const fixturePaths = fixture()
    projectLegacyQualificationBundle({ platform: 'macos', version, ...fixturePaths })

    expect(relativeFiles(fixturePaths.outputRoot)).toEqual([
      'SHA256SUMS.txt',
      dmg,
      checksum,
      ...evidence,
      'manifest.json',
    ].sort())
    expect(sha256(path.join(fixturePaths.outputRoot, dmg))).toBe(sha256(path.join(fixturePaths.sourceRoot, dmg)))
    expect(fs.existsSync(path.join(fixturePaths.outputRoot, 'latest-mac.yml'))).toBe(false)
    expect(fs.existsSync(path.join(fixturePaths.outputRoot, 'mac-arm64'))).toBe(false)
    expect(fs.existsSync(path.join(fixturePaths.sourceRoot, 'latest-mac.yml'))).toBe(true)
    expect(fs.existsSync(path.join(fixturePaths.sourceRoot, 'mac-arm64'))).toBe(true)
  })

  it('fails closed when a profile release asset is missing instead of projecting partial evidence', () => {
    const fixturePaths = fixture()
    fs.rmSync(path.join(fixturePaths.sourceRoot, dmg))

    expect(() => projectLegacyQualificationBundle({ platform: 'macos', version, ...fixturePaths }))
      .toThrow('Projection source must be a non-empty regular file')
    expect(fs.existsSync(fixturePaths.outputRoot)).toBe(false)
  })
})
