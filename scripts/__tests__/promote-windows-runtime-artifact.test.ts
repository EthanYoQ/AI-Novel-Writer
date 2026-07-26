import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROMOTION_CONFIRMATION,
  claimLightweightTag,
  createSourcePlan,
  finalizeVerifiedDraft,
  publishPromotion,
  resolveTagCommitSha,
  validateQualificationSource,
  verifyDownloadedQualification,
  verifyRemoteReleaseAssets,
  verifyStagedPromotion,
} from '../promote-windows-runtime-artifact.mjs'
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const TAG_OBJECT_SHA = 'c'.repeat(40)
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

function recoveryDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 360126743,
    draft: true,
    prerelease: false,
    tag_name: 'v0.4.0',
    target_commitish: SHA,
    name: 'v0.4.0',
    body: 'Windows runtime-verified release promoted from qualification run 123.',
    html_url: 'https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.4.0',
    assets: [],
    ...overrides,
  }
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
    remoteTagCommitSha: null,
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

interface MockRequest {
  method: string
  url: string
  body?: string
}

function queuedFetcher(
  expected: Array<{ method: string; path: string; status: number; data?: unknown }>,
  requests: MockRequest[] = [],
) {
  return Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const next = expected.shift()
    expect(next, `Unexpected request: ${String(input)}`).toBeDefined()
    const method = init?.method ?? 'GET'
    const url = String(input)
    requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    expect(method).toBe(next?.method)
    expect(url).toContain(next?.path)
    return new Response(next?.data === undefined ? '' : JSON.stringify(next.data), {
      status: next?.status,
      headers: next?.data === undefined ? undefined : { 'Content-Type': 'application/json' },
    })
  }, { assertDrained: () => expect(expected).toHaveLength(0), requests })
}

function qualificationFixture({
  sourceLockfileText = 'lockfileVersion: 9.0\n',
  manifestLockfileText = sourceLockfileText,
}: {
  sourceLockfileText?: string
  manifestLockfileText?: string
} = {}) {
  const root = temporaryDirectory()
  const source = path.join(root, 'source')
  const artifact = path.join(root, 'artifact', '0.4.0')
  mkdirSync(path.join(artifact, 'qualification'), { recursive: true })
  mkdirSync(source, { recursive: true })
  writeJson(path.join(source, 'package.json'), { version: '0.4.0' })
  const sourceLockfile = path.join(source, 'pnpm-lock.yaml')
  const manifestLockfile = path.join(root, 'manifest-pnpm-lock.yaml')
  writeFileSync(sourceLockfile, sourceLockfileText, 'utf8')
  writeFileSync(manifestLockfile, manifestLockfileText, 'utf8')

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
    lockfileSha256: canonicalPnpmLockfileSha256(manifestLockfile),
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

function stagedPromotionFixture(sourceVerificationPlan = sourcePlan()) {
  const fixture = qualificationFixture()
  const readyRoot = path.join(fixture.root, 'ready')
  verifyDownloadedQualification({
    artifactRoot: fixture.artifactRoot,
    qualifiedSource: fixture.source,
    sourceCommit: SHA,
    sourcePlan: sourceVerificationPlan,
    outputDirectory: readyRoot,
  })
  return { ...fixture, readyRoot, plan: verifyStagedPromotion(readyRoot) }
}

describe('runtime artifact promotion source validation', () => {
  it('accepts one successful artifact from the expected default-branch workflow', () => {
    expect(sourcePlan()).toMatchObject({
      state: 'SOURCE_VERIFIED',
      expectedSha: SHA,
      tag: 'v0.4.0',
      promotionRecovery: { mode: 'CREATE' },
      artifact: { id: 456, name: 'windows-cloud-build-runtime-verified' },
    })
  })

  it('records a visible expected tag as a draft-recovery intent', () => {
    expect(validateQualificationSource(metadata({
      remoteTagCommitSha: SHA,
    }))).toMatchObject({
      promotionRecovery: { mode: 'RESUME_DRAFT' },
    })
  })

  it('plans from the visible tag without querying a draft hidden from the read-only token', async () => {
    const input = metadata()
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/repos/EthanYoQ/AI-Novel-Writer', status: 200, data: input.repository },
      { method: 'GET', path: '/actions/workflows/windows-cloud-build-test.yml', status: 200, data: input.workflow },
      { method: 'GET', path: '/actions/runs/123', status: 200, data: input.run },
      { method: 'GET', path: `/compare/${SHA}...master`, status: 200, data: input.comparison },
      { method: 'GET', path: '/actions/runs/123/artifacts?per_page=100', status: 200, data: input.artifactsResponse },
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
    ])
    await expect(createSourcePlan({ token: 'token', inputs: input.inputs, fetcher })).resolves.toMatchObject({
      state: 'SOURCE_VERIFIED',
      promotionRecovery: { mode: 'RESUME_DRAFT' },
    })
    fetcher.assertDrained()
  })

  it.each([
    ['wrong run', () => metadata({ run: { ...metadata().run, id: 999 } }), 'run ID'],
    ['wrong workflow', () => metadata({ workflow: { ...metadata().workflow, name: 'Other workflow' } }), 'workflow name'],
    ['wrong SHA', () => metadata({ run: { ...metadata().run, head_sha: 'b'.repeat(40) } }), 'head SHA'],
    ['invalid tag', () => metadata({ inputs: { ...metadata().inputs, tag: 'v0.4.0-beta.1' } }), 'final v-prefixed'],
    ['wrong existing tag target', () => metadata({ remoteTagCommitSha: OTHER_SHA }), 'does not resolve to expected_sha'],
    ['invalid existing tag target', () => metadata({ remoteTagCommitSha: 'not-a-sha' }), 'SHA is invalid'],
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

  it('accepts Windows lockfile line endings but rejects a changed lockfile', () => {
    const sourceLockfileText = 'lockfileVersion: 9.0\nsettings:\n  autoInstallPeers: false\n'
    const windowsQualification = qualificationFixture({
      sourceLockfileText,
      manifestLockfileText: sourceLockfileText.replaceAll('\n', '\r\n'),
    })
    expect(() => verifyDownloadedQualification({
      artifactRoot: windowsQualification.artifactRoot,
      qualifiedSource: windowsQualification.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
    })).not.toThrow()

    const changedLockfile = qualificationFixture({
      sourceLockfileText,
      manifestLockfileText: 'lockfileVersion: 9.0\nsettings:\n  autoInstallPeers: true\n',
    })
    expect(() => verifyDownloadedQualification({
      artifactRoot: changedLockfile.artifactRoot,
      qualifiedSource: changedLockfile.source,
      sourceCommit: SHA,
      sourcePlan: sourcePlan(),
    })).toThrow('lockfile hash')
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

describe('idempotent draft recovery', () => {
  function recoverySourcePlan() {
    return validateQualificationSource(metadata({
      remoteTagCommitSha: SHA,
    }))
  }

  function uploadedAssets(plan: { releaseAssets: Array<{ file: string; sizeBytes: number; sha256: string }> }) {
    return plan.releaseAssets.map(asset => ({
      name: asset.file,
      size: asset.sizeBytes,
      digest: `sha256:${asset.sha256}`,
      state: 'uploaded',
    }))
  }

  it('re-verifies an exact retained draft and publishes it without re-uploading assets', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const draft = recoveryDraft({ assets: uploadedAssets(fixture.plan) })
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: draft },
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'PATCH', path: '/releases/360126743', status: 200, data: { ...draft, draft: false, prerelease: false } },
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).resolves.toMatchObject({ releaseId: 360126743, tag: 'v0.4.0' })
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'GET', 'PATCH', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed without publishing when retained draft assets are not exact', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: recoveryDraft() },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('Remote Release has 0 assets')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed when a visible retained tag has no matching draft for the write-capable job', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 404 },
      { method: 'GET', path: '/releases?per_page=100&page=1', status: 200, data: [] },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('partially occupied')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed when a visible draft has no matching tag for the write-capable job', async () => {
    const fixture = stagedPromotionFixture()
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 404 },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: recoveryDraft({ assets: uploadedAssets(fixture.plan) }) },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('partially occupied')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed when the write-capable job sees a non-draft Release', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: recoveryDraft({ draft: false, assets: uploadedAssets(fixture.plan) }) },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('not an unpublished')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed when the write-capable job sees a draft for another commit', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: recoveryDraft({ target_commitish: OTHER_SHA, assets: uploadedAssets(fixture.plan) }) },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('target_commitish')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
    fetcher.assertDrained()
  })

  it('fails closed when the retained tag changes after source planning', async () => {
    const fixture = stagedPromotionFixture(recoverySourcePlan())
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 200, data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: OTHER_SHA } } },
      { method: 'GET', path: '/releases/tags/v0.4.0', status: 200, data: recoveryDraft({ assets: uploadedAssets(fixture.plan) }) },
    ], requests)

    await expect(publishPromotion({
      token: 'token',
      readyRoot: fixture.readyRoot,
      expectedRepository: 'EthanYoQ/AI-Novel-Writer',
      expectedTag: 'v0.4.0',
      fetcher,
    })).rejects.toThrow('does not resolve to expected_sha')
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET'])
    fetcher.assertDrained()
  })
})

describe('atomic tag claim and commit peeling', () => {
  it('atomically creates a lightweight tag and confirms its commit', async () => {
    const fetcher = queuedFetcher([
      {
        method: 'POST',
        path: '/git/refs',
        status: 201,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } },
      },
      {
        method: 'GET',
        path: '/git/ref/tags/v0.4.0',
        status: 200,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } },
      },
    ])
    await expect(claimLightweightTag({
      token: 'token',
      repository: 'EthanYoQ/AI-Novel-Writer',
      tag: 'v0.4.0',
      expectedSha: SHA,
      fetcher,
    })).resolves.toBe(SHA)
    fetcher.assertDrained()
  })

  it('retries a short read-after-create 404 before accepting the new tag', async () => {
    const pauses: number[] = []
    const fetcher = queuedFetcher([
      {
        method: 'POST',
        path: '/git/refs',
        status: 201,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } },
      },
      { method: 'GET', path: '/git/ref/tags/v0.4.0', status: 404 },
      {
        method: 'GET',
        path: '/git/ref/tags/v0.4.0',
        status: 200,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } },
      },
    ])
    await expect(claimLightweightTag({
      token: 'token',
      repository: 'EthanYoQ/AI-Novel-Writer',
      tag: 'v0.4.0',
      expectedSha: SHA,
      visibilityAttempts: 2,
      waitForVisibility: async (milliseconds: number) => { pauses.push(milliseconds) },
      fetcher,
    })).resolves.toBe(SHA)
    expect(pauses).toHaveLength(1)
    fetcher.assertDrained()
  })

  it('rejects a concurrently occupied tag after HTTP 422 without updating or deleting it', async () => {
    const requests: MockRequest[] = []
    const fetcher = queuedFetcher([
      { method: 'POST', path: '/git/refs', status: 422, data: { message: 'Reference already exists' } },
      {
        method: 'GET',
        path: '/git/ref/tags/v0.4.0',
        status: 200,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: OTHER_SHA } },
      },
    ], requests)
    await expect(claimLightweightTag({
      token: 'token',
      repository: 'EthanYoQ/AI-Novel-Writer',
      tag: 'v0.4.0',
      expectedSha: SHA,
      fetcher,
    })).rejects.toThrow(`tag now resolves to ${OTHER_SHA}`)
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
    expect(requests).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/git/refs') })]))
    expect(requests).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: 'DELETE' })]))
    fetcher.assertDrained()
  })

  it('recursively peels an annotated tag to its final commit', async () => {
    const fetcher = queuedFetcher([
      {
        method: 'GET',
        path: '/git/ref/tags/v0.4.0',
        status: 200,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'tag', sha: TAG_OBJECT_SHA } },
      },
      {
        method: 'GET',
        path: `/git/tags/${TAG_OBJECT_SHA}`,
        status: 200,
        data: { sha: TAG_OBJECT_SHA, object: { type: 'commit', sha: SHA } },
      },
    ])
    await expect(resolveTagCommitSha({
      token: 'token',
      repository: 'EthanYoQ/AI-Novel-Writer',
      tag: 'v0.4.0',
      fetcher,
    })).resolves.toBe(SHA)
    fetcher.assertDrained()
  })

  it('rejects when a newly claimed tag resolves to the wrong commit', async () => {
    const fetcher = queuedFetcher([
      {
        method: 'POST',
        path: '/git/refs',
        status: 201,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'commit', sha: SHA } },
      },
      {
        method: 'GET',
        path: '/git/ref/tags/v0.4.0',
        status: 200,
        data: { ref: 'refs/tags/v0.4.0', object: { type: 'tag', sha: TAG_OBJECT_SHA } },
      },
      {
        method: 'GET',
        path: `/git/tags/${TAG_OBJECT_SHA}`,
        status: 200,
        data: { sha: TAG_OBJECT_SHA, object: { type: 'commit', sha: OTHER_SHA } },
      },
    ])
    await expect(claimLightweightTag({
      token: 'token',
      repository: 'EthanYoQ/AI-Novel-Writer',
      tag: 'v0.4.0',
      expectedSha: SHA,
      fetcher,
    })).rejects.toThrow(`resolves to ${OTHER_SHA}, expected ${SHA}`)
    fetcher.assertDrained()
  })
})

describe('final Release PATCH compensation', () => {
  it('publishes only between successful pre- and post-PATCH tag checks', async () => {
    const calls: string[] = []
    await expect(finalizeVerifiedDraft({
      verifyTag: async (phase: string) => { calls.push(phase) },
      publishRelease: async () => { calls.push('PATCH-final'); return { draft: false } },
      restoreDraft: async () => { calls.push('PATCH-draft') },
    })).resolves.toEqual({ draft: false })
    expect(calls).toEqual(['before-publish', 'PATCH-final', 'after-publish'])
  })

  it('restores draft and fails when the post-PATCH tag resolves to another SHA', async () => {
    const calls: string[] = []
    await expect(finalizeVerifiedDraft({
      verifyTag: async (phase: string) => {
        calls.push(phase)
        if (phase === 'after-publish') throw new Error(`tag resolves to ${OTHER_SHA}`)
      },
      publishRelease: async () => { calls.push('PATCH-final'); return { draft: false } },
      restoreDraft: async () => { calls.push('PATCH-draft') },
    })).rejects.toThrow('Post-publication tag verification failed; the Release was restored to draft state')
    expect(calls).toEqual(['before-publish', 'PATCH-final', 'after-publish', 'PATCH-draft'])
  })

  it('restores draft and fails when the formal PATCH API outcome is uncertain', async () => {
    const calls: string[] = []
    await expect(finalizeVerifiedDraft({
      verifyTag: async (phase: string) => { calls.push(phase) },
      publishRelease: async () => { calls.push('PATCH-final'); throw new Error('GitHub API 502') },
      restoreDraft: async () => { calls.push('PATCH-draft') },
    })).rejects.toThrow('Formal Release PATCH failed; the Release was restored to draft state')
    expect(calls).toEqual(['before-publish', 'PATCH-final', 'PATCH-draft'])
  })

  it('stays failed and reports manual intervention when draft restoration also fails', async () => {
    const calls: string[] = []
    await expect(finalizeVerifiedDraft({
      verifyTag: async (phase: string) => {
        calls.push(phase)
        if (phase === 'after-publish') throw new Error('tag verification API unavailable')
      },
      publishRelease: async () => { calls.push('PATCH-final'); return { draft: false } },
      restoreDraft: async () => { calls.push('PATCH-draft'); throw new Error('draft PATCH failed') },
    })).rejects.toThrow('draft restoration also failed; manual intervention is required')
    expect(calls).toEqual(['before-publish', 'PATCH-final', 'after-publish', 'PATCH-draft'])
  })
})
