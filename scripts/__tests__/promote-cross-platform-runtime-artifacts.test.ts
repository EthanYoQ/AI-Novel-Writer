import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROMOTION_CONFIRMATION,
  planPromotion,
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
    const bundleRoot = path.join(root, 'windows-cloud-build-runtime-verified', '0.5.0')
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
      if (parsed.pathname.endsWith(`/git/ref/tags/v0.5.0`)) return { ok: false, status: 404, json: async () => ({}) }
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
        tag: 'v0.5.0',
        confirmation: PROMOTION_CONFIRMATION,
      },
      fetcher,
      token: 'test-token',
    })

    expect(plan.windows.artifact.id).toBe(1001)
    expect(plan.macos.artifact.id).toBe(2002)
    expect(plan.expectedSha).toBe(expectedSha)
    expect(plan.version).toBe('0.5.0')
  })

  it('requires the complete, byte-verified remote asset inventory before publication', () => {
    const assets = [
      { file: 'ai-novel-writer-setup-0.5.0.exe', sizeBytes: 3, sha256: 'a'.repeat(64) },
      { file: 'ai-novel-writer-mac-arm64-0.5.0-installer.dmg', sizeBytes: 4, sha256: 'b'.repeat(64) },
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
})
