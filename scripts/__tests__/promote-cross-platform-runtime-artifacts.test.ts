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
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'

const repository = 'EthanYoQ/AI-Novel-Writer'
const expectedSha = 'a'.repeat(40)
const futureExpiry = new Date(Date.now() + 60_000).toISOString()

function successfulRun(id: number, workflowId: number, name: string, path: string) {
  return {
    id,
    workflow_id: workflowId,
    name,
    path: `${path}@refs/heads/master`,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
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

function writeQualificationEvidence(root: string, relativePath: string, evidence: unknown): void {
  const file = path.join(root, ...relativePath.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(evidence)}\n`, 'utf8')
}

function writePromotionFixture(root: string, sourceRoot: string, includeWindowsSkinEvidence: boolean): { sourcePlan: Record<string, unknown> } {
  const packageMetadata = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as { version: string }
  const version = packageMetadata.version
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim().toLowerCase()
  const lockfileSha256 = canonicalPnpmLockfileSha256(path.join(sourceRoot, 'pnpm-lock.yaml'))
  const windowsRoot = path.join(root, 'windows')
  const macosRoot = path.join(root, 'macos')
  mkdirSync(windowsRoot, { recursive: true })
  mkdirSync(macosRoot, { recursive: true })

  const windowsFiles = new Map([
    [`ai-novel-writer-setup-${version}.exe`, Buffer.from('installer')],
    [`ai-novel-writer-setup-${version}.exe.blockmap`, Buffer.from('blockmap')],
    ['latest.yml', Buffer.from(`version: ${version}\n`)],
  ])
  for (const [file, content] of windowsFiles) writeFileSync(path.join(windowsRoot, file), content)
  const windowsArtifacts = [...windowsFiles].map(([file, content]) => ({ file, sizeBytes: content.length, sha256: sha256(content) }))
  const windowsManifest = {
    schemaVersion: 1,
    commit,
    lockfileSha256,
    gateLevel: 'RUNTIME_VERIFIED',
    releaseCreated: false,
    artifacts: windowsArtifacts,
  }
  writeFileSync(path.join(windowsRoot, 'manifest.json'), `${JSON.stringify(windowsManifest)}\n`, 'utf8')
  const windowsSums = [...windowsArtifacts, {
    file: 'manifest.json',
    sha256: sha256(readFileSync(path.join(windowsRoot, 'manifest.json'))),
  }]
  writeFileSync(path.join(windowsRoot, 'SHA256SUMS.txt'), windowsSums.map(record => `${record.sha256} *${record.file}`).join('\n') + '\n', 'utf8')

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
  writeQualificationEvidence(windowsRoot, 'qualification/packaged-vector-smoke.json', vectorEvidence)
  writeQualificationEvidence(windowsRoot, 'qualification/packaged-official-homepage-smoke.json', homepageEvidence)
  if (includeWindowsSkinEvidence) writeQualificationEvidence(windowsRoot, 'qualification/packaged-skin-smoke.json', skinEvidence)

  const dmg = `ai-novel-writer-mac-arm64-${version}-installer.dmg`
  const dmgBytes = Buffer.from('dmg')
  writeFileSync(path.join(macosRoot, dmg), dmgBytes)
  const macosManifest = {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    commit,
    lockfileSha256,
    gateLevel: 'RUNTIME_VERIFIED',
    releaseCreated: false,
    dmgChecksum: `${dmg}.sha256`,
    artifacts: [{ file: dmg, sizeBytes: dmgBytes.length, sha256: sha256(dmgBytes) }],
  }
  writeFileSync(path.join(macosRoot, 'manifest.json'), `${JSON.stringify(macosManifest)}\n`, 'utf8')
  writeFileSync(path.join(macosRoot, `${dmg}.sha256`), `${sha256(dmgBytes)}  ${dmg}\n`, 'utf8')
  writeFileSync(path.join(macosRoot, 'SHA256SUMS.txt'), [
    `${sha256(dmgBytes)} *${dmg}`,
    `${sha256(readFileSync(path.join(macosRoot, 'manifest.json')))} *manifest.json`,
  ].join('\n') + '\n', 'utf8')
  writeQualificationEvidence(macosRoot, 'qualification/packaged-vector-smoke.json', vectorEvidence)
  writeQualificationEvidence(macosRoot, 'qualification/packaged-official-homepage-smoke.json', homepageEvidence)
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

  return {
    sourcePlan: {
      schemaVersion: 1,
      state: 'SOURCE_VERIFIED',
      repository,
      expectedSha: commit,
      tag: `v${version}`,
      version,
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
      })).toThrow('Windows qualification file set is not exact')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects exactly one immutable Windows and macOS artifact from matching default-branch runs', async () => {
    const responses = new Map<string, unknown>([
      ['', { full_name: repository, default_branch: 'master' }],
      [`/actions/runs/101`, successfulRun(101, 11, 'Windows cloud package qualification', '.github/workflows/windows-cloud-build-test.yml')],
      [`/actions/runs/202`, successfulRun(202, 22, 'macOS ARM64 cloud package qualification', '.github/workflows/macos-arm64-cloud-build.yml')],
      [`/compare/${expectedSha}...master`, { status: 'identical', merge_base_commit: { sha: expectedSha }, base_commit: { sha: expectedSha } }],
      [`/actions/workflows/11`, { id: 11, name: 'Windows cloud package qualification', path: '.github/workflows/windows-cloud-build-test.yml' }],
      [`/actions/workflows/22`, { id: 22, name: 'macOS ARM64 cloud package qualification', path: '.github/workflows/macos-arm64-cloud-build.yml' }],
      [`/actions/runs/101/artifacts?per_page=100`, { total_count: 1, artifacts: [{ id: 1001, name: 'windows-cloud-build-runtime-verified', expired: false, size_in_bytes: 1, expires_at: futureExpiry, workflow_run: { id: 101, head_sha: expectedSha } }] }],
      [`/actions/runs/202/artifacts?per_page=100`, { total_count: 1, artifacts: [{ id: 2002, name: 'macos-arm64-cloud-build-runtime-verified', expired: false, size_in_bytes: 1, expires_at: futureExpiry, workflow_run: { id: 202, head_sha: expectedSha } }] }],
    ])
    const fetcher = async (url: string) => {
      const parsed = new URL(url)
      const key = parsed.pathname.replace(`/repos/${repository}`, '') + parsed.search
      if (parsed.pathname.endsWith(`/git/ref/tags/v0.5.1`)) return { ok: false, status: 404, json: async () => ({}) }
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
    expect(plan.expectedSha).toBe(expectedSha)
    expect(plan.version).toBe('0.5.1')
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

  it('generates bilingual v0.8.0 major-release notes for the structured-character-roster root-cause fix', () => {
    const body = releaseNotes('0.8.0')

    expect(body).toContain('## 中文')
    expect(body).toContain('## English')
    expect(body).toContain('AI 小说作家 0.8.0')
    expect(body).toContain('AI Novel Writer 0.8.0')
    expect(body).toContain('重大更新')
    expect(body).toContain('major update')
    expect(body).toContain('结构化角色名单')
    expect(body).toContain('structured character roster')
    expect(body).toContain('角色卡的唯一事实源')
    expect(body).toContain('single source of truth for character cards')
    expect(body).toContain('一次结构化输出')
    expect(body).toContain('one structured output')
    expect(body).toContain('SQLite 原子提交')
    expect(body).toContain('SQLite atomic commit')
    expect(body).toContain('回读成功后')
    expect(body).toContain('read-back succeeds')
    expect(body).toContain('旧项目必须显式安全迁移')
    expect(body).toContain('legacy projects require an explicit safe migration')
    expect(body).toContain('导入、手工编辑、蓝图同步、定稿和清除')
    expect(body).toContain('Imports, manual edits, blueprint synchronization, finalization, and clearing')
    expect(body).toContain('统一的角色名单 seam')
    expect(body).toContain('one roster seam')
    expect(body).toContain('从根源修复 #76')
    expect(body).toContain('fixing #76 at the source')
    expect(body).toContain('五项资产')
    expect(body).toContain('five assets')
    expect(body).toContain('ai-novel-writer-setup-0.8.0.exe')
    expect(body).toContain('ai-novel-writer-setup-0.8.0.exe.blockmap')
    expect(body).toContain('latest.yml')
    expect(body).toContain('ai-novel-writer-mac-arm64-0.8.0-installer.dmg')
    expect(body).toContain('ai-novel-writer-mac-arm64-0.8.0-installer.dmg.sha256')
    expect(body).toContain('Windows x64')
    expect(body).toContain('Windows 安装包未签名')
    expect(body).toContain('Windows installer is not code-signed')
    expect(body).toContain('应用内更新')
    expect(body).toContain('in-app update')
    expect(body).toContain('unsigned and not notarized')
    expect(body).toContain('未签名、未公证')
    expect(body).toContain('macOS ARM64')
    expect(body).toContain('手动更新')
    expect(body).toContain('manual update')
  })

  it('publishes after a newly created tag becomes readable without creating the tag twice', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-publish-'))
    const ready = {
      schemaVersion: 1,
      state: 'READY_TO_PUBLISH',
      repository,
      expectedSha,
      tag: 'v0.5.1',
      version: '0.5.1',
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

    try {
      writeFileSync(path.join(root, 'promotion-ready.json'), `${JSON.stringify(ready)}\n`, 'utf8')
      const fetcher = async (url: string, options: { method?: string } = {}) => {
        const parsed = new URL(url)
        const method = options.method ?? 'GET'
        if (parsed.pathname.endsWith('/releases/tags/v0.5.1')) return jsonResponse(draft)
        if (parsed.pathname.endsWith('/git/refs') && method === 'POST') {
          tagCreateRequests += 1
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/git/ref/tags/v0.5.1')) {
          if (tagCreateRequests === 0) return { ok: false, status: 404, json: async () => ({}) }
          tagReadsAfterCreate += 1
          if (tagReadsAfterCreate < 3) return { ok: false, status: 404, json: async () => ({}) }
          return jsonResponse({ ref: `refs/tags/${ready.tag}`, object: { type: 'commit', sha: expectedSha } })
        }
        if (parsed.pathname.endsWith('/releases/123') && method === 'PATCH') {
          return jsonResponse({ ...draft, draft: false })
        }
        throw new Error(`Unexpected request: ${method} ${parsed.pathname}`)
      }

      const publication = publishPromotion({ readyRoot: root, token: 'test-token', fetcher })
      const result = expect(publication).resolves.toMatchObject({ id: 123, draft: false })
      await vi.runAllTimersAsync()
      await result
      expect(tagCreateRequests).toBe(1)
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers the unique matching draft from the complete release list when the tag endpoint returns 404', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-promotion-draft-fallback-'))
    const ready = {
      schemaVersion: 1,
      state: 'READY_TO_PUBLISH',
      repository,
      expectedSha,
      tag: 'v0.5.1',
      version: '0.5.1',
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
})
