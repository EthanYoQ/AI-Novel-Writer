import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'
import { recordQualificationCommands, windowsAcceptanceReceipt } from './release-evidence-v2-fixtures'

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

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

  it('finalizes the runtime-qualified package from its pre-build evidence contract', () => {
    const releaseDir = fixture()
    const evidenceRoot = fixture()
    const installerName = `ai-novel-writer-setup-${packageMetadata.version}.exe`
    const installer = Buffer.from('verified-nsis-installer')
    const blockmap = Buffer.from('{"version":"2","files":[]}')
    const latest = Buffer.from(`version: ${packageMetadata.version}\n`)
    writeFileSync(path.join(releaseDir, installerName), installer)
    writeFileSync(path.join(releaseDir, `${installerName}.blockmap`), blockmap)
    writeFileSync(path.join(releaseDir, 'latest.yml'), latest)

    for (const smoke of [
      ['packaged-vector-smoke.json', 'packaged-vector-smoke'],
      ['packaged-official-homepage-smoke.json', 'packaged-official-homepage-smoke'],
      ['packaged-skin-smoke.json', 'packaged-skin-smoke'],
    ] as const) {
      writeJson(path.join(releaseDir, 'qualification', smoke[0]), {
        schemaVersion: 1,
        kind: smoke[1],
        direct: { packaged: true },
      })
    }
    const commit = 'a'.repeat(40)
    const initialized = spawnSync(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'release-evidence-v2.mjs'),
      'init',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', commit,
      '--run-id', '101',
      '--run-attempt', '1',
      '--runner-label', 'windows-2022',
      '--image-os', 'win22',
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/windows-cloud-build-test.yml',
      '--workflow-name', 'Windows cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    expect(initialized.status, initialized.stderr).toBe(0)
    recordQualificationCommands(evidenceRoot, 'windows', repositoryRoot)
    for (const receipt of [
      'install', 'launch', 'quiet-window', 'error-dialogs', 'uninstall', 'upgrade-data', 'native-abi', 'packaged-smoke', 'signing',
    ]) {
      writeJson(path.join(evidenceRoot, 'acceptance', `${receipt}.json`), windowsAcceptanceReceipt(releaseDir, packageMetadata.version, receipt))
    }
    const result = spawnSync(process.execPath, [manifestScript, '--release-dir', releaseDir], {
      cwd: repositoryRoot,
      env: environmentWithOverrides(process.env, {
        GITHUB_SHA: commit,
        AI_NOVEL_CLOUD_BUILD_PNPM_VERSION: '11.11.0',
        ImageOS: 'win22',
        ImageVersion: '20260726.1',
        AI_NOVEL_RELEASE_EVIDENCE_ROOT: evidenceRoot,
      }),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)

    const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      platform: 'windows',
      commit,
      version: packageMetadata.version,
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
    expect(manifest.contractSha256).toBe(sha256(readFileSync(path.join(releaseDir, 'qualification', 'release-contract.json'))))
    expect(manifest.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'qualification/release-contract.json' }),
      expect.objectContaining({ file: 'qualification/run-ledger.json' }),
      expect.objectContaining({ file: 'qualification/acceptance/signing.json' }),
    ]))

    const sums = readFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8')
    expect(sums).toContain(`${sha256(installer)} *${installerName}`)
    expect(sums).toContain(`${sha256(blockmap)} *${installerName}.blockmap`)
    expect(sums).toContain(`${sha256(latest)} *latest.yml`)
    expect(sums).toContain(`${sha256(readFileSync(path.join(releaseDir, 'manifest.json')))} *manifest.json`)
    expect(sums).toContain(`${sha256(readFileSync(path.join(releaseDir, 'qualification', 'acceptance', 'signing.json')))} *qualification/acceptance/signing.json`)
  })
})
