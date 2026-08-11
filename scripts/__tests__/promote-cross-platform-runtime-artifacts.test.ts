import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  PROMOTION_CONFIRMATION,
  planPromotion,
  publishPromotion,
  releaseNotes,
  resolvePromotionArtifactRoot,
  verifyPromotion,
  verifyRemoteReleaseAssets,
} from '../promote-cross-platform-runtime-artifacts.mjs'
import { COMMAND_PROFILES, finalizeReleaseEvidence, initializeReleaseEvidence, recordReleaseCommand } from '../release-evidence-v2.mjs'
import { macosAcceptanceReceipt, windowsAcceptanceReceipt } from './release-evidence-v2-fixtures'

const repository = 'EthanYoQ/AI-Novel-Writer'
const expectedSha = 'a'.repeat(40)
const futureExpiry = new Date(Date.now() + 60_000).toISOString()
const QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS = 15_000
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

type WindowsPackagedJsonFixture =
  | 'utf8'
  | 'powershell-5.1-utf8-bom'
  | 'double-bom'
  | 'whitespace-before-bom'
  | 'partial-bom'
  | 'utf16le-bom'
  | 'invalid-utf8-in-string'
  | 'malformed-after-bom'

function successfulRun(id: number, workflowId: number, name: string, path: string) {
  return {
    id,
    run_attempt: 2,
    workflow_id: workflowId,
    name,
    path: `${path}@refs/heads/master`,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    actor: { login: 'release-operator' },
    head_sha: expectedSha,
    head_branch: 'master',
    head_repository: { full_name: repository },
  }
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function readyQualification() {
  return {
    windows: {
      runId: 101,
      runAttempt: 1,
      artifactId: 1001,
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      contractSha256: '2'.repeat(64),
      ledgerSha256: '3'.repeat(64),
      manifestSha256: '4'.repeat(64),
    },
    macos: {
      runId: 202,
      runAttempt: 1,
      artifactId: 2002,
      artifactDigest: `sha256:${'5'.repeat(64)}`,
      contractSha256: '6'.repeat(64),
      ledgerSha256: '7'.repeat(64),
      manifestSha256: '8'.repeat(64),
    },
  }
}

function qualificationEvidenceBytes(evidence: unknown, fixture: WindowsPackagedJsonFixture): Buffer {
  if (fixture === 'utf8') return Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8')
  if (fixture === 'malformed-after-bom') {
    return Buffer.concat([UTF8_BOM, Buffer.from('{"schemaVersion":1', 'utf8')])
  }
  if (fixture === 'invalid-utf8-in-string') {
    const json = JSON.stringify(evidence)
    expect(json.endsWith('}')).toBe(true)
    return Buffer.concat([
      Buffer.from(`${json.slice(0, -1)},"invalidUtf8Probe":"`, 'utf8'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\r\n', 'utf8'),
    ])
  }

  // Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes a UTF-8 BOM
  // and Windows newlines. Keep this byte fixture independent from the reader.
  const powershellJson = Buffer.from(`${JSON.stringify(evidence, null, 2).replace(/\n/g, '\r\n')}\r\n`, 'utf8')
  if (fixture === 'powershell-5.1-utf8-bom') return Buffer.concat([UTF8_BOM, powershellJson])
  if (fixture === 'double-bom') return Buffer.concat([UTF8_BOM, UTF8_BOM, powershellJson])
  if (fixture === 'whitespace-before-bom') return Buffer.concat([Buffer.from(' ', 'utf8'), UTF8_BOM, powershellJson])
  if (fixture === 'partial-bom') return Buffer.concat([UTF8_BOM.subarray(0, 2), powershellJson])
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(powershellJson.toString('utf8'), 'utf16le')])
}

function writeQualificationEvidence(
  root: string,
  relativePath: string,
  evidence: unknown,
  fixture: WindowsPackagedJsonFixture = 'utf8',
): void {
  const file = path.join(root, ...relativePath.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, qualificationEvidenceBytes(evidence, fixture))
}

function writePromotionFixture(
  root: string,
  sourceRoot: string,
  includeWindowsSkinEvidence: boolean,
  windowsPackagedJsonFixture: WindowsPackagedJsonFixture = 'utf8',
): { sourcePlan: Record<string, unknown> } {
  const packageMetadata = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as { version: string }
  const version = packageMetadata.version
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim().toLowerCase()
  const windowsRoot = path.join(root, 'windows')
  const macosRoot = path.join(root, 'macos')
  const windowsEvidenceRoot = path.join(root, 'windows-evidence')
  const macosEvidenceRoot = path.join(root, 'macos-evidence')
  mkdirSync(windowsRoot, { recursive: true })
  mkdirSync(macosRoot, { recursive: true })

  const windowsFiles = new Map([
    [`ai-novel-writer-setup-${version}.exe`, Buffer.from('installer')],
    [`ai-novel-writer-setup-${version}.exe.blockmap`, Buffer.from('blockmap')],
    ['latest.yml', Buffer.from(`version: ${version}\n`)],
  ])
  for (const [file, content] of windowsFiles) writeFileSync(path.join(windowsRoot, file), content)

  const vectorEvidence = {
    schemaVersion: 1, kind: 'packaged-vector-smoke',
    projectA: { vectorDimension: 768, importChunkCount: 1, ftsResultCount: 0, semanticResultCount: 1 },
    projectB: { initialVectorDimension: 768, vectorDimension: 1536, initialImportChunkCount: 1, backfilledChunkCount: 1, sameFingerprintRebuilt: true, ftsResultCount: 0, semanticResultCount: 1 },
  }
  const homepageEvidence = {
    schemaVersion: 1, kind: 'packaged-official-homepage-smoke',
    trustedIntent: { channel: 'official-homepage:open', requestArgumentCount: 0, success: true, shellOpenExternalCalls: 1 },
    failedOpenExternal: { success: false, controllerError: 'offline', shellOpenExternalCalls: 1 },
  }
  const skinEvidence = {
    schemaVersion: 1, kind: 'packaged-skin-smoke',
    builtInAnime: { asset: 'skins/anime-night.webp', present: true, format: 'webp' },
    customSkin: { importSucceeded: true, readSucceeded: true, stateRestored: true, activeSkin: 'custom', mime: 'image/png', width: 1, height: 1 },
  }
  writeQualificationEvidence(windowsRoot, 'qualification/packaged-vector-smoke.json', vectorEvidence, windowsPackagedJsonFixture)
  writeQualificationEvidence(windowsRoot, 'qualification/packaged-official-homepage-smoke.json', homepageEvidence, windowsPackagedJsonFixture)
  writeQualificationEvidence(windowsRoot, 'qualification/packaged-skin-smoke.json', skinEvidence, windowsPackagedJsonFixture)
  initializeReleaseEvidence({
    platform: 'windows',
    evidenceRoot: windowsEvidenceRoot,
    repository,
    commit,
    runId: '101',
    runAttempt: '1',
    runnerLabel: 'windows-2022',
    imageOS: 'win22',
    imageVersion: '20260726.1',
    expectedNodeVersion: process.versions.node,
    expectedPnpmVersion: '11.11.0',
    workflowPath: '.github/workflows/windows-cloud-build-test.yml',
    workflowName: 'Windows cloud package qualification',
    actor: 'release-operator',
    event: 'workflow_dispatch',
    dispatchInputs: {},
    root: sourceRoot,
  })
  for (const step of COMMAND_PROFILES.windows) {
    recordReleaseCommand({ evidenceRoot: windowsEvidenceRoot, step, command: [process.execPath, '-e', ''], cwd: sourceRoot })
  }
  for (const receipt of ['install', 'launch', 'quiet-window', 'error-dialogs', 'uninstall', 'upgrade-data', 'native-abi', 'packaged-smoke', 'signing']) {
    writeQualificationEvidence(windowsEvidenceRoot, `acceptance/${receipt}.json`, windowsAcceptanceReceipt(windowsRoot, version, receipt))
  }
  finalizeReleaseEvidence({ platform: 'windows', evidenceRoot: windowsEvidenceRoot, releaseRoot: windowsRoot })
  if (!includeWindowsSkinEvidence) rmSync(path.join(windowsRoot, 'qualification', 'packaged-skin-smoke.json'))

  const dmg = `ai-novel-writer-mac-arm64-${version}-installer.dmg`
  const dmgBytes = Buffer.from('dmg')
  writeFileSync(path.join(macosRoot, dmg), dmgBytes)
  writeQualificationEvidence(macosRoot, 'qualification/packaged-vector-smoke.json', vectorEvidence)
  writeQualificationEvidence(macosRoot, 'qualification/packaged-official-homepage-smoke.json', homepageEvidence)
  writeQualificationEvidence(macosRoot, 'qualification/packaged-skin-smoke.json', skinEvidence)
  writeQualificationEvidence(macosRoot, 'qualification/macos-dmg-smoke.json', {
    schemaVersion: 1,
    kind: 'macos-dmg-smoke',
    platform: 'darwin',
    arch: 'arm64',
    dmgSha256: sha256(dmgBytes),
    secureFileSystemSmoke: true,
    secureFileSystemHelper: 'security/darwin-safe-file-system',
    skinSmoke: true,
  })
  initializeReleaseEvidence({
    platform: 'macos',
    evidenceRoot: macosEvidenceRoot,
    repository,
    commit,
    runId: '202',
    runAttempt: '1',
    runnerLabel: 'macos-14',
    imageOS: 'macos14',
    imageVersion: '20260726.1',
    expectedNodeVersion: process.versions.node,
    expectedPnpmVersion: '11.11.0',
    workflowPath: '.github/workflows/macos-arm64-cloud-build.yml',
    workflowName: 'macOS ARM64 cloud package qualification',
    actor: 'release-operator',
    event: 'workflow_dispatch',
    dispatchInputs: {},
    root: sourceRoot,
  })
  for (const step of COMMAND_PROFILES.macos) {
    recordReleaseCommand({ evidenceRoot: macosEvidenceRoot, step, command: [process.execPath, '-e', ''], cwd: sourceRoot })
  }
  for (const receipt of ['dmg-mount', 'packaged-smoke', 'signing']) {
    writeQualificationEvidence(macosEvidenceRoot, `acceptance/${receipt}.json`, macosAcceptanceReceipt(macosRoot, version, receipt))
  }
  finalizeReleaseEvidence({ platform: 'macos', evidenceRoot: macosEvidenceRoot, releaseRoot: macosRoot })

  return {
    sourcePlan: {
      schemaVersion: 1,
      state: 'SOURCE_VERIFIED',
      repository,
      expectedSha: commit,
      tag: `v${version}`,
      version,
      windows: { runId: 101, runAttempt: 1, actor: 'release-operator', event: 'workflow_dispatch', workflow: { name: 'Windows cloud package qualification', path: '.github/workflows/windows-cloud-build-test.yml' }, artifact: { id: 1001, digest: `sha256:${'a'.repeat(64)}` } },
      macos: { runId: 202, runAttempt: 1, actor: 'release-operator', event: 'workflow_dispatch', workflow: { name: 'macOS ARM64 cloud package qualification', path: '.github/workflows/macos-arm64-cloud-build.yml' }, artifact: { id: 2002, digest: `sha256:${'b'.repeat(64)}` } },
    },
  }
}

describe('cross-platform artifact promotion planner', () => {
  it('accepts GitHub artifact-name wrappers but rejects files outside the verified bundle', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-artifact-'))
    const bundleRoot = path.join(root, 'windows-cloud-build-runtime-verified', '0.5.1')
    try {
      mkdirSync(bundleRoot, { recursive: true })
      writeFileSync(path.join(bundleRoot, 'manifest.json'), '{}\n', 'utf8')

      expect(resolvePromotionArtifactRoot(root, 'Windows qualification')).toBe(bundleRoot)

      writeFileSync(path.join(root, 'unexpected.txt'), 'unexpected\n', 'utf8')
      expect(() => resolvePromotionArtifactRoot(root, 'Windows qualification'))
        .toThrow('Windows qualification artifact contains files outside its verified bundle')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a promotion artifact that omits the packaged skin qualification evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-skin-evidence-'))
    const sourceRoot = path.resolve(import.meta.dirname, '..', '..')
    try {
      const fixture = writePromotionFixture(root, sourceRoot, false)

      expect(() => verifyPromotion({
        windowsArtifactRoot: path.join(root, 'windows'),
        macosArtifactRoot: path.join(root, 'macos'),
        qualifiedSource: sourceRoot,
        sourcePlan: fixture.sourcePlan,
        outputDirectory: path.join(root, 'output'),
      })).toThrow('Qualification bundle file set is not exact')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS)

  it('finalizes and verifies PowerShell 5.1 BOM evidence while binding its original bytes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-evidence-binding-'))
    const sourceRoot = path.resolve(import.meta.dirname, '..', '..')
    try {
      const fixture = writePromotionFixture(root, sourceRoot, true, 'powershell-5.1-utf8-bom')

      const ready = verifyPromotion({
        windowsArtifactRoot: path.join(root, 'windows'),
        macosArtifactRoot: path.join(root, 'macos'),
        qualifiedSource: sourceRoot,
        sourcePlan: fixture.sourcePlan,
        outputDirectory: path.join(root, 'output'),
      })

      expect(ready).toMatchObject({
        schemaVersion: 2,
        state: 'READY_TO_PUBLISH',
        qualification: {
          windows: {
            contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            ledgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          macos: {
            contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            ledgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      })
      expect(ready.assets.map(asset => asset.file)).toEqual([
        `ai-novel-writer-mac-arm64-${fixture.sourcePlan.version}-installer.dmg`,
        `ai-novel-writer-mac-arm64-${fixture.sourcePlan.version}-installer.dmg.sha256`,
        `ai-novel-writer-setup-${fixture.sourcePlan.version}.exe`,
        `ai-novel-writer-setup-${fixture.sourcePlan.version}.exe.blockmap`,
        'latest.yml',
      ].sort())

      const vectorPath = path.join(root, 'windows', 'qualification', 'packaged-vector-smoke.json')
      const vectorBytes = readFileSync(vectorPath)
      const vectorRawSha256 = sha256(vectorBytes)
      const vectorWithoutBomSha256 = sha256(vectorBytes.subarray(UTF8_BOM.length))
      expect(vectorBytes.subarray(0, UTF8_BOM.length)).toEqual(UTF8_BOM)
      expect(vectorRawSha256).not.toBe(vectorWithoutBomSha256)

      const windowsManifest = JSON.parse(readFileSync(path.join(root, 'windows', 'manifest.json'), 'utf8'))
      const vectorManifestRecord = windowsManifest.evidence.find(
        (record: { file?: string }) => record.file === 'qualification/packaged-vector-smoke.json',
      )
      expect(vectorManifestRecord.sha256).toBe(vectorRawSha256)

      const packagedSmokeReceipt = JSON.parse(readFileSync(
        path.join(root, 'windows', 'qualification', 'acceptance', 'packaged-smoke.json'),
        'utf8',
      ))
      const vectorReference = packagedSmokeReceipt.evidence.find(
        (record: { kind?: string }) => record.kind === 'packaged-vector-smoke',
      )
      expect(vectorReference.sha256).toBe(vectorRawSha256)
      expect(readFileSync(path.join(root, 'windows', 'SHA256SUMS.txt'), 'utf8')).toContain(
        `${vectorRawSha256} *qualification/packaged-vector-smoke.json`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS)

  it.each([
    'double-bom',
    'whitespace-before-bom',
    'partial-bom',
    'utf16le-bom',
    'invalid-utf8-in-string',
    'malformed-after-bom',
  ] satisfies WindowsPackagedJsonFixture[])('rejects non-canonical evidence JSON bytes: %s', fixture => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-invalid-json-'))
    const sourceRoot = path.resolve(import.meta.dirname, '..', '..')
    try {
      expect(() => writePromotionFixture(root, sourceRoot, true, fixture)).toThrow(
        'Packaged smoke evidence qualification/packaged-vector-smoke.json is not valid JSON',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS)

  it('rejects workflow evidence whose actor differs from the GitHub qualification run', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-workflow-identity-'))
    const sourceRoot = path.resolve(import.meta.dirname, '..', '..')
    try {
      const fixture = writePromotionFixture(root, sourceRoot, true)
      const windows = fixture.sourcePlan.windows as { actor: string }
      windows.actor = 'different-operator'

      expect(() => verifyPromotion({
        windowsArtifactRoot: path.join(root, 'windows'),
        macosArtifactRoot: path.join(root, 'macos'),
        qualifiedSource: sourceRoot,
        sourcePlan: fixture.sourcePlan,
        outputDirectory: path.join(root, 'output'),
      })).toThrow('Release evidence contract actor does not match the qualification run')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS)

  it('rejects internally consistent evidence from a different GitHub run attempt', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-run-attempt-'))
    const sourceRoot = path.resolve(import.meta.dirname, '..', '..')
    try {
      const fixture = writePromotionFixture(root, sourceRoot, true)
      const windows = fixture.sourcePlan.windows as { runAttempt: number }
      windows.runAttempt = 2

      expect(() => verifyPromotion({
        windowsArtifactRoot: path.join(root, 'windows'),
        macosArtifactRoot: path.join(root, 'macos'),
        qualifiedSource: sourceRoot,
        sourcePlan: fixture.sourcePlan,
        outputDirectory: path.join(root, 'output'),
      })).toThrow('Release evidence contract run attempt does not match the qualification run')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, QUALIFICATION_BUNDLE_TEST_TIMEOUT_MS)

  it('selects exactly one immutable Windows and macOS artifact from matching default-branch runs', async () => {
    const responses = new Map<string, unknown>([
      ['', { full_name: repository, default_branch: 'master' }],
      [`/actions/runs/101`, successfulRun(101, 11, 'Windows cloud package qualification', '.github/workflows/windows-cloud-build-test.yml')],
      [`/actions/runs/202`, successfulRun(202, 22, 'macOS ARM64 cloud package qualification', '.github/workflows/macos-arm64-cloud-build.yml')],
      [`/compare/${expectedSha}...master`, { status: 'identical', merge_base_commit: { sha: expectedSha }, base_commit: { sha: expectedSha } }],
      [`/actions/workflows/11`, { id: 11, name: 'Windows cloud package qualification', path: '.github/workflows/windows-cloud-build-test.yml' }],
      [`/actions/workflows/22`, { id: 22, name: 'macOS ARM64 cloud package qualification', path: '.github/workflows/macos-arm64-cloud-build.yml' }],
      [`/actions/runs/101/artifacts?per_page=100`, { total_count: 1, artifacts: [{ id: 1001, name: 'windows-cloud-build-runtime-verified', digest: `sha256:${'a'.repeat(64)}`, expired: false, size_in_bytes: 1, expires_at: futureExpiry, workflow_run: { id: 101, head_sha: expectedSha } }] }],
      [`/actions/runs/202/artifacts?per_page=100`, { total_count: 1, artifacts: [{ id: 2002, name: 'macos-arm64-cloud-build-runtime-verified', digest: `sha256:${'b'.repeat(64)}`, expired: false, size_in_bytes: 1, expires_at: futureExpiry, workflow_run: { id: 202, head_sha: expectedSha } }] }],
    ])
    const fetcher = async (url: string) => {
      const parsed = new URL(url)
      const key = parsed.pathname.replace(`/repos/${repository}`, '') + parsed.search
      if (parsed.pathname.endsWith(`/git/ref/tags/v0.5.1`)) return { ok: false, status: 404, json: async () => ({}) }
      if (parsed.pathname.endsWith(`/releases/tags/v0.5.1`)) return { ok: false, status: 404, json: async () => ({}) }
      const response = responses.get(key)
      if (!response) throw new Error(`Unexpected request: ${key}`)
      return jsonResponse(response)
    }

    const plan = await planPromotion({
      inputs: {
        repository,
        windowsQualificationRunId: '101',
        macosQualificationRunId: '202',
        expectedSha,
        tag: 'v0.5.1',
        confirmation: PROMOTION_CONFIRMATION,
      },
      fetcher,
      token: 'test-token',
    })

    expect(plan.windows.artifact.id).toBe(1001)
    expect(plan.macos.artifact.id).toBe(2002)
    expect(plan.windows).toMatchObject({
      runAttempt: 2,
      actor: 'release-operator',
      event: 'workflow_dispatch',
      workflow: { name: 'Windows cloud package qualification', path: '.github/workflows/windows-cloud-build-test.yml' },
    })
    expect(plan.macos).toMatchObject({
      runAttempt: 2,
      actor: 'release-operator',
      event: 'workflow_dispatch',
      workflow: { name: 'macOS ARM64 cloud package qualification', path: '.github/workflows/macos-arm64-cloud-build.yml' },
    })
    expect(plan.expectedSha).toBe(expectedSha)
    expect(plan.version).toBe('0.5.1')
    expect(plan.draftState).toBe('unknown')

    const windowsRun = responses.get('/actions/runs/101') as { run_attempt?: number }
    delete windowsRun.run_attempt
    await expect(planPromotion({
      inputs: {
        repository,
        windowsQualificationRunId: '101',
        macosQualificationRunId: '202',
        expectedSha,
        tag: 'v0.5.1',
        confirmation: PROMOTION_CONFIRMATION,
      },
      fetcher,
      token: 'test-token',
    })).rejects.toThrow('Windows qualification run attempt is missing or invalid')
  })

  it('requires the complete, byte-verified remote asset inventory before publication', () => {
    const assets = [
      { file: 'ai-novel-writer-setup-0.5.1.exe', sizeBytes: 3, sha256: 'a'.repeat(64) },
      { file: 'ai-novel-writer-mac-arm64-0.5.1-installer.dmg', sizeBytes: 4, sha256: 'b'.repeat(64) },
    ]
    expect(() => verifyRemoteReleaseAssets({
      draft: true,
      prerelease: false,
      assets: [
        { name: assets[0].file, size: 3, digest: `sha256:${assets[0].sha256}` },
        { name: assets[1].file, size: 4, digest: `sha256:${assets[1].sha256}` },
      ],
    }, assets)).not.toThrow()
    expect(() => verifyRemoteReleaseAssets({ draft: true, prerelease: false, assets: [] }, assets))
      .toThrow('Remote release asset file set is not exact')
  })

  it('generates bilingual v0.8.1 major-release notes for the three issue fixes', () => {
    const body = releaseNotes('0.8.1')

    expect(body).toContain('## 中文')
    expect(body).toContain('## English')
    expect(body).toContain('AI 小说作家 0.8.1')
    expect(body).toContain('AI Novel Writer 0.8.1')
    expect(body).toContain('重大更新')
    expect(body).toContain('major update')
    expect(body).toContain('#78')
    expect(body).toContain('用户配置温度')
    expect(body).toContain('user-configured temperature')
    expect(body).toContain('Kimi')
    expect(body).toContain('#84')
    expect(body).toContain('旧角色')
    expect(body).toContain('legacy character')
    expect(body).toContain('侧边栏')
    expect(body).toContain('sidebar')
    expect(body).toContain('#85')
    expect(body).toContain('有界续写')
    expect(body).toContain('bounded continuation')
    expect(body).toContain('不完整')
    expect(body).toContain('incomplete')
    expect(body).toContain('不落盘')
    expect(body).toContain('not persisted')
    expect(body).toContain('五项资产')
    expect(body).toContain('five assets')
    expect(body).toContain('ai-novel-writer-setup-0.8.1.exe')
    expect(body).toContain('ai-novel-writer-setup-0.8.1.exe.blockmap')
    expect(body).toContain('latest.yml')
    expect(body).toContain('ai-novel-writer-mac-arm64-0.8.1-installer.dmg')
    expect(body).toContain('ai-novel-writer-mac-arm64-0.8.1-installer.dmg.sha256')
    expect(body).toContain('Windows x64')
    expect(body).toContain('Windows 安装包未签名')
    expect(body).toContain('Windows installer is not code-signed')
    expect(body).toContain('应用内更新')
    expect(body).toContain('in-app update')
    expect(body).toContain('未签名（未使用 Developer ID 正式代码签名')
    expect(body).toContain('临时 ad-hoc 签名')
    expect(body).toContain('Apple 公证：未公证')
    expect(body).toContain('Unsigned for public distribution')
    expect(body).toContain('no Developer ID code signing')
    expect(body).toContain('temporary ad-hoc signature')
    expect(body).toContain('Apple notarization: not notarized')
    expect(body).toContain('macOS ARM64')
    expect(body).toContain('手动更新')
    expect(body).toContain('manual update')
  })

  it('creates and verifies the tag before creating a release draft', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-publish-'))
    const ready = {
      schemaVersion: 2,
      state: 'READY_TO_PUBLISH',
      repository,
      expectedSha,
      tag: 'v0.5.1',
      version: '0.5.1',
      qualification: readyQualification(),
      assets: [],
    }
    const draft = {
      id: 123,
      upload_url: 'https://uploads.github.com/repos/test/releases/123/assets{?name,label}',
      draft: true,
      prerelease: false,
      tag_name: ready.tag,
      target_commitish: expectedSha,
      name: ready.tag,
      body: releaseNotes(ready.version),
      assets: [],
    }
    let tagCreateRequests = 0
    let tagReadsAfterCreate = 0
    let published = false
    const mutationOrder: string[] = []

    try {
      writeFileSync(path.join(root, 'promotion-ready.json'), `${JSON.stringify(ready)}\n`, 'utf8')
      const fetcher = async (url: string, options: { method?: string } = {}) => {
        const parsed = new URL(url)
        const method = options.method ?? 'GET'
        if (parsed.pathname.endsWith('/releases/tags/v0.5.1')) {
          return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
        }
        if (parsed.pathname.endsWith('/releases') && parsed.search === '?per_page=100') {
          return { ok: true, status: 200, headers: new Headers(), json: async () => [] }
        }
        if (parsed.pathname.endsWith('/git/refs') && method === 'POST') {
          mutationOrder.push('tag')
          tagCreateRequests += 1
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/git/ref/tags/v0.5.1')) {
          if (tagCreateRequests === 0) return { ok: false, status: 404, json: async () => ({}) }
          tagReadsAfterCreate += 1
          if (tagReadsAfterCreate < 3) return { ok: false, status: 404, json: async () => ({}) }
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/releases') && method === 'POST') {
          mutationOrder.push('draft')
          return jsonResponse(draft)
        }
        if (parsed.pathname.endsWith('/releases/123') && method === 'GET') return jsonResponse(published ? { ...draft, draft: false } : draft)
        if (parsed.pathname.endsWith('/releases/123') && method === 'PATCH') {
          published = true
          return jsonResponse({ ...draft, draft: false })
        }
        throw new Error(`Unexpected request: ${method} ${parsed.pathname}`)
      }

      const publication = publishPromotion({ readyRoot: root, token: 'test-token', fetcher })
      const result = expect(publication).resolves.toMatchObject({ id: 123, draft: false })
      await vi.runAllTimersAsync()
      await result
      expect(tagCreateRequests).toBe(1)
      expect(mutationOrder).toEqual(['tag', 'draft'])
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers the unique matching draft from the complete release list when the tag endpoint returns 404', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-draft-fallback-'))
    const ready = {
      schemaVersion: 2,
      state: 'READY_TO_PUBLISH',
      repository,
      expectedSha,
      tag: 'v0.5.1',
      version: '0.5.1',
      qualification: readyQualification(),
      assets: [],
    }
    const draft = {
      id: 363065264,
      upload_url: 'https://uploads.github.com/repos/test/releases/363065264/assets{?name,label}',
      draft: true,
      prerelease: false,
      tag_name: ready.tag,
      target_commitish: expectedSha,
      name: ready.tag,
      body: releaseNotes(ready.version),
      assets: [],
    }
    const mutationMethods: string[] = []
    let published = false

    try {
      writeFileSync(path.join(root, 'promotion-ready.json'), `${JSON.stringify(ready)}\n`, 'utf8')
      const fetcher = async (url: string, options: { method?: string } = {}) => {
        const parsed = new URL(url)
        const method = options.method ?? 'GET'
        if (method !== 'GET') mutationMethods.push(method)
        if (parsed.pathname.endsWith('/releases/tags/v0.5.1')) {
          return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) }
        }
        if (parsed.pathname.endsWith('/releases') && parsed.search === '?per_page=100') {
          return { ok: true, status: 200, headers: new Headers(), json: async () => [draft] }
        }
        if (parsed.pathname.endsWith('/git/ref/tags/v0.5.1')) {
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/releases/363065264') && method === 'PATCH') {
          published = true
          return jsonResponse({ ...draft, draft: false })
        }
        if (parsed.pathname.endsWith('/releases/363065264') && method === 'GET' && published) {
          return jsonResponse({ ...draft, draft: false })
        }
        throw new Error(`Unexpected request: ${method} ${parsed.pathname}${parsed.search}`)
      }

      await expect(publishPromotion({ readyRoot: root, token: 'test-token', fetcher }))
        .resolves.toMatchObject({ id: 363065264, draft: false })
      expect(mutationMethods).toEqual(['PATCH'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the authoritative post-publish Release read-back drifts', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-final-readback-'))
    const asset = { file: 'latest.yml', sizeBytes: 3, sha256: 'a'.repeat(64) }
    const ready = {
      schemaVersion: 2,
      state: 'READY_TO_PUBLISH',
      repository,
      expectedSha,
      tag: 'v0.5.1',
      version: '0.5.1',
      qualification: readyQualification(),
      assets: [asset],
    }
    const draft = {
      id: 456,
      upload_url: 'https://uploads.github.com/repos/test/releases/456/assets{?name,label}',
      draft: true,
      prerelease: false,
      tag_name: ready.tag,
      target_commitish: expectedSha,
      name: ready.tag,
      body: releaseNotes(ready.version),
      assets: [{ name: asset.file, state: 'uploaded', size: asset.sizeBytes, digest: `sha256:${asset.sha256}` }],
    }
    let publishPatchSeen = false
    let finalReadSeen = false

    try {
      writeFileSync(path.join(root, 'promotion-ready.json'), `${JSON.stringify(ready)}\n`, 'utf8')
      const fetcher = async (url: string, options: { method?: string, body?: string } = {}) => {
        const parsed = new URL(url)
        const method = options.method ?? 'GET'
        if (parsed.pathname.endsWith('/git/ref/tags/v0.5.1')) {
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/releases/tags/v0.5.1')) return jsonResponse(draft)
        if (parsed.pathname.endsWith('/releases/456') && method === 'PATCH') {
          const body = JSON.parse(options.body ?? '{}')
          if (body.draft === true) return jsonResponse(draft)
          publishPatchSeen = true
          return jsonResponse({ ...draft, draft: false })
        }
        if (parsed.pathname.endsWith('/releases/456') && method === 'GET') {
          finalReadSeen = true
          return jsonResponse({ ...draft, draft: false, name: 'drifted-release-name' })
        }
        throw new Error(`Unexpected request: ${method} ${parsed.pathname}`)
      }

      await expect(publishPromotion({ readyRoot: root, token: 'test-token', fetcher }))
        .rejects.toThrow('Published release provenance is inconsistent')
      expect(publishPatchSeen).toBe(true)
      expect(finalReadSeen).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
