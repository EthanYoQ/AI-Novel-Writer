import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const manifestScript = path.join(repositoryRoot, 'scripts', 'generate-cloud-build-manifest.mjs')
const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }
const fixtures: string[] = []

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function environmentWithOverrides(
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const overriddenNames = new Set(Object.keys(overrides).map(name => name.toLowerCase()))
  return Object.fromEntries([
    ...Object.entries(inherited).filter(([name]) => !overriddenNames.has(name.toLowerCase())),
    ...Object.entries(overrides),
  ])
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-cloud-build-manifest-'))
  fixtures.push(root)
  return root
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cloud Windows build manifest', () => {
  it('removes inherited environment keys before overriding them case-insensitively', () => {
    expect(environmentWithOverrides(
      {
        ImageVersion: 'runner-image-version',
        IMAGEOS: 'runner-image-os',
        github_sha: 'runner-commit',
        KEEP_ME: 'unrelated',
      },
      {
        ImageVersion: 'fixture-image-version',
        ImageOS: 'fixture-image-os',
        GITHUB_SHA: 'fixture-commit',
      },
    )).toEqual({
      ImageVersion: 'fixture-image-version',
      ImageOS: 'fixture-image-os',
      GITHUB_SHA: 'fixture-commit',
      KEEP_ME: 'unrelated',
    })
  })

  it('records the runtime-qualified package files and reproducibility inputs with SHA-256 sums', () => {
    const releaseDir = fixture()
    const installerName = `ai-novel-writer-setup-${packageMetadata.version}.exe`
    const installer = Buffer.from('verified-nsis-installer')
    const blockmap = Buffer.from('{"version":"2","files":[]}')
    const latest = Buffer.from(`version: ${packageMetadata.version}\n`)
    writeFileSync(path.join(releaseDir, installerName), installer)
    writeFileSync(path.join(releaseDir, `${installerName}.blockmap`), blockmap)
    writeFileSync(path.join(releaseDir, 'latest.yml'), latest)

    const commit = 'a'.repeat(40)
    const result = spawnSync(process.execPath, [manifestScript, '--release-dir', releaseDir], {
      cwd: repositoryRoot,
      env: environmentWithOverrides(process.env, {
        GITHUB_SHA: commit,
        AI_NOVEL_CLOUD_BUILD_PNPM_VERSION: '11.11.0',
        ImageOS: 'win22',
        ImageVersion: '20260726.1',
      }),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)

    const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      commit,
      lockfileSha256: canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      nodeVersion: process.versions.node,
      pnpmVersion: '11.11.0',
      runnerImage: {
        os: 'win22',
        version: '20260726.1',
      },
      gateLevel: 'RUNTIME_VERIFIED',
      releaseCreated: false,
      artifacts: [
        { file: installerName, sizeBytes: installer.length, sha256: sha256(installer) },
        { file: `${installerName}.blockmap`, sizeBytes: blockmap.length, sha256: sha256(blockmap) },
        { file: 'latest.yml', sizeBytes: latest.length, sha256: sha256(latest) },
      ],
    })

    const sums = readFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8')
    expect(sums).toContain(`${sha256(installer)} *${installerName}`)
    expect(sums).toContain(`${sha256(blockmap)} *${installerName}.blockmap`)
    expect(sums).toContain(`${sha256(latest)} *latest.yml`)
    expect(sums).toContain(`${sha256(readFileSync(path.join(releaseDir, 'manifest.json')))} *manifest.json`)
  })
})
