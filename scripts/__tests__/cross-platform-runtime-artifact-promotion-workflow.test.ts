import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'cross-platform-runtime-artifact-promotion.yml')
const promotionScriptPath = path.join(repositoryRoot, 'scripts', 'promote-cross-platform-runtime-artifacts.mjs')
const legacyWindowsPromotionWorkflowPath = path.join(repositoryRoot, '.github', 'workflows', 'windows-runtime-artifact-promotion.yml')

function readRequired(file: string) {
  expect(existsSync(file), `Missing cross-platform promotion contract file: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

function jobBlock(workflow: string, name: string, next?: string) {
  const start = workflow.indexOf(`  ${name}:`)
  const end = next ? workflow.indexOf(`  ${next}:`, start + 1) : workflow.length
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return workflow.slice(start, end)
}

describe('cross-platform runtime artifact promotion workflow contract', () => {
  it('removes the legacy Windows-only promotion path so every future formal Release has both platforms', () => {
    expect(existsSync(legacyWindowsPromotionWorkflowPath)).toBe(false)
  })

  it('is manual-only and publishes exactly one verified formal Release from both cloud artifacts', () => {
    const workflow = readRequired(workflowPath)
    const promotion = readRequired(promotionScriptPath)

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
    for (const input of ['windows_qualification_run_id', 'macos_qualification_run_id', 'expected_sha', 'tag', 'confirmation']) {
      expect(workflow).toContain(`      ${input}:`)
    }
    expect(workflow).toContain('PROMOTE_RUNTIME_VERIFIED_CROSS_PLATFORM_RELEASE')
    expect(workflow).toContain('group: cross-platform-runtime-artifact-release-promotion')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('artifact-ids: ${{ steps.plan.outputs.windows_artifact_id }}')
    expect(workflow).toContain('artifact-ids: ${{ steps.plan.outputs.macos_artifact_id }}')
    expect(workflow).toContain('run-id: ${{ inputs.windows_qualification_run_id }}')
    expect(workflow).toContain('run-id: ${{ inputs.macos_qualification_run_id }}')
    expect(workflow).toContain('promote-cross-platform-runtime-artifacts.mjs plan')
    expect(workflow).toContain('promote-cross-platform-runtime-artifacts.mjs verify')
    expect(workflow).toContain('promote-cross-platform-runtime-artifacts.mjs publish')

    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}$/)

    expect(workflow).toContain('permissions: {}')
    const verify = jobBlock(workflow, 'verify-runtime-artifacts', 'publish-final-release')
    expect(verify).toContain('actions: read')
    expect(verify).toContain('contents: read')
    expect(verify).not.toContain('contents: write')
    const publish = jobBlock(workflow, 'publish-final-release')
    expect(publish).toContain('actions: read')
    expect(publish).toContain('contents: write')

    expect(promotion).toContain("const WINDOWS_WORKFLOW_PATH = '.github/workflows/windows-cloud-build-test.yml'")
    expect(promotion).toContain("const MACOS_WORKFLOW_PATH = '.github/workflows/macos-arm64-cloud-build.yml'")
    expect(promotion).toContain("const WINDOWS_ARTIFACT_NAME = 'windows-cloud-build-runtime-verified'")
    expect(promotion).toContain("const MACOS_ARTIFACT_NAME = 'macos-arm64-cloud-build-runtime-verified'")
    expect(promotion).toContain("draft: true")
    expect(promotion).toContain("draft: false, prerelease: false")
    expect(promotion).toContain('verifyRemoteReleaseAssets')
    expect(promotion).toContain('createVerifiedTag')
    expect(promotion).toContain("run?.event === 'workflow_dispatch'")
    expect(promotion).toContain('qualification commit is not an ancestor of the default branch')
    expect(promotion).toContain('qualification artifact is not bound to the verified run')
    expect(promotion).toContain('qualification/packaged-skin-smoke.json')
    expect(promotion).toContain('validateSkinEvidence')
    expect(promotion).toContain('skinSmoke === true')
    expect(promotion).toContain('Creating a draft unexpectedly created a Git tag')
    expect(promotion).toContain("assertTagCommit(fetcher, api, headers, ready, 'before publication')")
    expect(promotion).toContain("assertTagCommit(fetcher, api, headers, ready, 'after publication')")
    expect(promotion).toContain('restoreDraftRelease')
    expect(promotion).toContain('Release publication failed and draft restoration also failed')
    expect(promotion).not.toMatch(/(?:deleteRelease|method:\s*['"]DELETE['"])/)
  })
})
