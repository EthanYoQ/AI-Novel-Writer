import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const workflow = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'windows-runtime-artifact-promotion.yml'),
  'utf8',
)
const verifier = readFileSync(path.join(repositoryRoot, 'scripts', 'promote-windows-runtime-artifact.mjs'), 'utf8')

function jobBlock(name: string, next?: string) {
  const start = workflow.indexOf(`  ${name}:`)
  const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return workflow.slice(start, end)
}

describe('Windows runtime artifact promotion workflow contract', () => {
  it('is manual-only, globally serialized, and requires all four explicit inputs', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
    for (const input of ['qualification_run_id', 'expected_sha', 'tag', 'confirmation']) {
      expect(workflow).toContain(`      ${input}:`)
    }
    expect(workflow).toContain('PROMOTE_RUNTIME_VERIFIED_WINDOWS_RELEASE')
    expect(workflow).toContain('group: windows-runtime-artifact-release-promotion')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('pins every third-party action to a full commit SHA', () => {
    const actionLines = workflow.split(/\r?\n/).filter(line => line.includes('uses:'))
    expect(actionLines.length).toBeGreaterThan(0)
    for (const line of actionLines) expect(line).toMatch(/uses:\s+[\w.-]+\/[\w.-]+@[a-f0-9]{40}\s*$/)
  })

  it('keeps verification and publication permissions separated and minimal', () => {
    expect(workflow).toContain('permissions: {}')
    const verify = jobBlock('verify-runtime-artifact', 'publish-final-release')
    expect(verify).toContain('actions: read')
    expect(verify).toContain('contents: read')
    expect(verify).not.toContain('contents: write')
    const publish = jobBlock('publish-final-release')
    expect(publish).toContain('actions: read')
    expect(publish).toContain('contents: write')
    expect(workflow).not.toMatch(/id-token:|packages:|workflows:/)
  })

  it('downloads exactly the selected cross-run artifact and republishes only a same-run verified package', () => {
    expect(workflow).toContain('artifact-ids: ${{ steps.plan.outputs.artifact_id }}')
    expect(workflow).toContain('run-id: ${{ inputs.qualification_run_id }}')
    expect(workflow).toContain('name: windows-release-promotion-ready-${{ github.run_id }}')
    expect(workflow).toContain('retention-days: 1')
    expect(workflow).toContain('promote-windows-runtime-artifact.mjs verify')
    expect(workflow).toContain('promote-windows-runtime-artifact.mjs publish')
  })

  it('does not claim a post-publication updater E2E gate without a pre-promotion qualification contract', () => {
    expect(workflow).not.toContain('verify-official-updater-after-publish')
    expect(workflow).not.toContain('smoke-win-updater.ps1')
  })

  it('implements draft-first, remote-byte verification, and final publication without rollback', () => {
    expect(verifier).toContain("draft: true")
    expect(verifier).toContain('verifyRemoteReleaseAssets')
    expect(verifier).toContain('claimLightweightTag')
    expect(verifier).toContain('resolveTagCommitSha')
    expect(verifier).toContain("verifyTag('before-publish')")
    expect(verifier).toContain("verifyTag('after-publish')")
    expect(verifier).toContain("method: 'PATCH'")
    expect(verifier).toContain('draft: false, prerelease: false')
    expect(verifier).toContain('draft: true, prerelease: false')
    expect(verifier).toContain('was intentionally retained')
    expect(verifier).not.toContain("method: 'DELETE'")
    expect(verifier).not.toContain('deleteRelease')
  })

  it('verifies remote assets before atomically claiming the tag and formally publishing', () => {
    const publishStart = verifier.indexOf('export async function publishPromotion')
    const publishEnd = verifier.indexOf('\nfunction argumentsMap', publishStart)
    const publish = verifier.slice(publishStart, publishEnd)
    expect(publish.lastIndexOf('verifyRemoteReleaseAssets')).toBeGreaterThan(-1)
    expect(publish.indexOf('claimLightweightTag')).toBeGreaterThan(publish.lastIndexOf('verifyRemoteReleaseAssets'))
    expect(publish.lastIndexOf('finalizePromotionDraft')).toBeGreaterThan(publish.indexOf('claimLightweightTag'))
  })
})
