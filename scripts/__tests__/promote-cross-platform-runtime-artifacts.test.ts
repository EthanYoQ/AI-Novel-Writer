import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PROMOTION_CONFIRMATION,
  planPromotion,
  publishPromotion,
  releaseNotes,
  resolvePromotionArtifactRoot,
  verifyRemoteReleaseAssets,
} from '../promote-cross-platform-runtime-artifacts.mjs'

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

  it('generates bilingual v0.5.2 release notes for the chapter-target and embedding-response fixes', () => {
    const body = releaseNotes('0.5.2')

    expect(body).toContain('## 中文')
    expect(body).toContain('## English')
    expect(body).toContain('#73')
    expect(body).toContain('单章目标字数')
    expect(body).toContain('3000')
    expect(body).toContain('natural completion boundaries')
    expect(body).toContain('#74')
    expect(body).toContain('HTML')
    expect(body).toContain('Unexpected token')
    expect(body).toContain('合法 JSON')
    expect(body).toContain('configuration, gateway, or authentication')
    expect(body).not.toContain('#70')
    expect(body).not.toContain('#71')
    expect(body).not.toContain('#72')
    expect(body).toContain('ai-novel-writer-setup-0.5.2.exe')
    expect(body).toContain('ai-novel-writer-mac-arm64-0.5.2-installer.dmg')
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
