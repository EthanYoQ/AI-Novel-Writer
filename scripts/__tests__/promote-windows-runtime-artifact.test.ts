import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROMOTION_CONFIRMATION,
  validateQualificationSource,
  verifyDownloadedQualification,
  verifyRemoteReleaseAssets,
  verifyStagedPromotion,
} from '../promote-windows-runtime-artifact.mjs'

const SHA = 'a'.repeat(40)
const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-novel-promotion-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function hash(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function metadata(overrides: Record<string, unknown> = {}) {
  const run = {
    id: 123,
    workflow_id: 77,
    name: 'Windows cloud package qualification',
    path: '.github/workflows/windows-cloud-build-test.yml@main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: SHA,
    head_branch: 'master',
    head_repository: { full_name: 'EthanYoQ/AI-Novel-Writer' },
  }
  return {
    inputs: {
      repository: 'EthanYoQ/AI-Novel-Writer',
      qualificationRunId: '123',
      expectedSha: SHA,
      tag: 'v0.4.0',
      confirmation: PROMOTION_CONFIRMATION,
    },
    repository: { full_name: 'EthanYoQ/AI-Novel-Writer', default_branch: 'master' },
    workflow: { id: 77, name: 'Windows cloud package qualification', path: '.github/workflows/windows-cloud-build-test.yml@master' },
    run,
    comparison: { status: 'ahead', merge_base_commit: { sha: SHA }, base_commit: { sha: SHA } },
    artifactsResponse: {
      total_count: 1,
      artifacts: [{
        id: 456,
        name: 'windows-cloud-build-runtime-verified',
        expired: false,
        expires_at: '2030-01-01T00:00:00Z',
        size_in_bytes: 999,
        workflow_run: { id: 123, head_sha: SHA },
      }],
    },
    tagRefStatus: 404,
    releaseStatus: 404,
    now: new Date('2029-01-01T00:00:00Z'),
    ...overrides,
  }
}

function sourcePlan() {
  return validateQualificationSource(metadata())
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function qualificationFixture() {
  const root = temporaryDirectory()
  const source = path.join(root, 'source')
  const artifact = path.join(root, 'artifact', '0.4.0')
  mkdirSync(path.join(artifact, 'qualification'), { recursive: true })
  mkdirSync(source, { recursive: true })
  writeJson(path.join(source, 'package.json'), { version: '0.4.0' })
  writeFileSync(path.join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')

  const installer = 'ai-novel-writer-setup-0.4.0.exe'
  writeFileSync(path.join(artifact, installer), 'installer bytes')
  writeFileSync(path.join(artifact, `${installer}.blockmap`), 'blockmap bytes')
  writeFileSync(path.join(artifact, 'latest.yml'), [
    'version: 0.4.0',
    'files:',
    `  - url: ${installer}`,
    '    sha512: abc',
    '    size: 15',
    `path: ${installer}`,
    'sha512: abc',
    '',
  ].join('\n'))
  writeJson(path.join(artifact, 'qualification', 'packaged-vector-smoke.json'), {
    schemaVersion: 1,
    kind: 'packaged-vector-smoke',
    projectA: { vectorDimension: 768, importChunkCount: 2, ftsResultCount: 0, semanticResultCount: 1 },
    projectB: {
      initialVectorDimension: 768,
      vectorDimension: 1536,
      initialImportChunkCount: 2,
      backfilledChunkCount: 2,
      sameFingerprintRebuilt: true,
      ftsResultCount: 0,
      semanticResultCount: 1,
    },
  })
  writeJson(path.join(artifact, 'qualification', 'packaged-official-homepage-smoke.json'), {
    schemaVersion: 1,
    kind: 'packaged-official-homepage-smoke',
    trustedIntent: {
      channel: 'official-homepage:open',
      requestArgumentCount: 0,
      url: 'https://github.com/EthanYoQ/AI-Novel-Writer',
      success: true,
      shellOpenExternalCalls: 1,
    },
    failedOpenExternal: {
      success: false,
      shellOpenExternalCalls: 1,
      controllerError: 'controlled failure',
      rendererError: { zhCN: '打开失败', enUS: 'Open failed' },
    },
  })
  const artifacts = [installer, `${installer}.blockmap`, 'latest.yml'].map(file => ({
    file,
    sizeBytes: statSync(path.join(artifact, file)).size,
    sha256: hash(path.join(artifact, file)),
  }))
  writeJson(path.join(artifact, 'manifest.json'), {
    schemaVersion: 1,
    commit: SHA,
    lockfileSha256: hash(path.join(source, 'pnpm-lock.yaml')),
    gateLevel: 'RUNTIME_VERIFIED',
    releaseCreated: false,
    artifacts,
  })
  writeFileSync(path.join(artifact, 'SHA256SUMS.txt'), [
    ...artifacts.map(record => `${record.sha256} *${record.file}`),
    `${hash(path.join(artifact, 'manifest.json'))} *manifest.json`,
    '',
  ].join('\n'))
  return { root, source, artifactRoot: path.dirname(artifact), bundle: artifact }
}

describe('runtime artifact promotion source validation', () => {
  it('accepts one successful artifact from the expected default-branch workflow', () => {
    expect(sourcePlan()).toMatchObject({
      state: 'SOURCE_VERIFIED',
      expectedSha: SHA,
      tag: 'v0.4.0',
      artifact: { id: 456, name: 'windows-cloud-build-runtime-verified' },
    })
  })

  it.each([
    ['wrong run', () => metadata({ run: { ...metadata().run, id: 999 } }), 'run ID'],
    ['wrong workflow', () => metadata({ workflow: { ...metadata().workflow, name: 'Other workflow' } }), 'workflow name'],
    ['wrong SHA', () => metadata({ run: { ...metadata().run, head_sha: 'b'.repeat(40) } }), 'head SHA'],
    ['invalid tag', () => metadata({ inputs: { ...metadata().inputs, tag: 'v0.4.0-beta.1' } }), 'final v-prefixed'],
    ['duplicate Release', () => metadata({ releaseStatus: 200 }), 'already exists'],
  ])('rejects %s', (_label, makeInput, message) => {
    expect(() => validateQualificationSource(makeInput())).toThrow(message)
  })

  it('rejects duplicate matching qualification artifacts', () => {
    const base = metadata()
    const artifact = base.artifactsResponse.artifacts[0]
    expect(() => validateQualificationSource({
      ...base,
      artifactsResponse: { total_count: 2, artifacts: [artifact, { ...artifact, id: 457 }] },
    })).toThrow('Expected exactly one')
  })
})

describe('downloaded qualification verification', () => {
  it('verifies and stages the exact runtime-qualified file set', () => {
    const fixture = qualificationFixture()
    const output = path.join(fixture.root, 'ready')
    const plan = verifyDownloadedQualification({
      artifactRoot: fixture.artifactRoot,
      qualifiedSource: fixture.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
      outputDirectory: output,
    })
    expect(plan.state).toBe('RUNTIME_ARTIFACT_VERIFIED')
    expect(plan.verifiedFiles).toHaveLength(7)
    expect(plan.releaseAssets.map((asset: { file: string }) => asset.file)).toEqual([
      'ai-novel-writer-setup-0.4.0.exe',
      'ai-novel-writer-setup-0.4.0.exe.blockmap',
      'latest.yml',
    ])
    expect(verifyStagedPromotion(output).expectedSha).toBe(SHA)
  })

  it('rejects a manifest without the RUNTIME_VERIFIED gate', () => {
    const fixture = qualificationFixture()
    const manifestPath = path.join(fixture.bundle, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeJson(manifestPath, { ...manifest, gateLevel: 'BUILD_ONLY' })
    expect(() => verifyDownloadedQualification({
      artifactRoot: fixture.artifactRoot,
      qualifiedSource: fixture.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
    })).toThrow('gateLevel')
  })

  it('rejects an artifact whose bytes no longer match the manifest', () => {
    const fixture = qualificationFixture()
    writeFileSync(path.join(fixture.bundle, 'ai-novel-writer-setup-0.4.0.exe'), 'tampered bytes')
    expect(() => verifyDownloadedQualification({
      artifactRoot: fixture.artifactRoot,
      qualifiedSource: fixture.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
    })).toThrow(/size mismatch|SHA-256 mismatch/)
  })

  it('rejects every portable ZIP even when the required files are present', () => {
    const fixture = qualificationFixture()
    writeFileSync(path.join(fixture.bundle, 'portable.zip'), 'zip')
    expect(() => verifyDownloadedQualification({
      artifactRoot: fixture.artifactRoot,
      qualifiedSource: fixture.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
    })).toThrow('Portable ZIP')
  })

  it('rejects a valid but different requested tag from the qualified package version', () => {
    const fixture = qualificationFixture()
    const plan = validateQualificationSource(metadata({ inputs: { ...metadata().inputs, tag: 'v0.5.0' } }))
    expect(() => verifyDownloadedQualification({
      artifactRoot: fixture.artifactRoot,
      qualifiedSource: fixture.source,
      sourceCommit: SHA,
      sourcePlan: plan,
    })).toThrow('does not match v0.5.0')
  })
})

describe('remote Release asset verification', () => {
  const local = [
    { file: 'latest.yml', sizeBytes: 5, sha256: '1'.repeat(64) },
    { file: 'setup.exe', sizeBytes: 9, sha256: '2'.repeat(64) },
  ]

  it('accepts an exact uploaded name, size, and digest set while still draft', () => {
    expect(verifyRemoteReleaseAssets({
      draft: true,
      prerelease: false,
      assets: local.map(asset => ({ name: asset.file, size: asset.sizeBytes, digest: `sha256:${asset.sha256}`, state: 'uploaded' })),
    }, local)).toBe(true)
  })

  it('rejects changed or extra remote assets before formal publication', () => {
    expect(() => verifyRemoteReleaseAssets({
      draft: true,
      prerelease: false,
      assets: [
        { name: 'latest.yml', size: 6, digest: `sha256:${'1'.repeat(64)}`, state: 'uploaded' },
        { name: 'portable.zip', size: 9, digest: `sha256:${'2'.repeat(64)}`, state: 'uploaded' },
      ],
    }, local)).toThrow(/size mismatch|Unexpected remote/)
  })
})
