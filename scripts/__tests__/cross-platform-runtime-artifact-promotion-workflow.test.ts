import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'cross-platform-runtime-artifact-promotion.yml')
const promotionScriptPath = path.join(repositoryRoot, '.release', 'scripts', 'github-desktop-promotion.mjs')
const validatorPath = path.join(repositoryRoot, '.release', 'scripts', 'validate-release-profile.mjs')
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

  it('is manual-only and delegates exact artifact identity and publication to the shared consumer', () => {
    const workflow = readRequired(workflowPath)
    const promotion = readRequired(promotionScriptPath)
    const validator = readRequired(validatorPath)

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
    for (const input of ['expected_sha', 'release_tag', 'release_version', 'profile_path', 'qualification_runs_json', 'confirmation']) {
      expect(workflow).toContain(`      ${input}:`)
    }
    expect(workflow).toContain('PROMOTE_QUALIFIED_DESKTOP_RELEASE')
    expect(workflow).toContain('group: promote-qualified-desktop-${{ inputs.release_tag }}')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('--qualification-runs-json "$QUALIFICATION_RUNS_JSON"')
    expect(workflow).toContain('node .release/scripts/github-desktop-promotion.mjs verify')
    expect(workflow).toContain('node .release/scripts/github-desktop-promotion.mjs publish')
    expect(workflow).toContain('artifact-ids: ${{ needs.plan-and-verify.outputs.verified_artifact_id }}')

    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}$/)

    expect(workflow).toContain('permissions: {}')
    const verify = jobBlock(workflow, 'plan-and-verify', 'publish')
    expect(verify).toContain('actions: read')
    expect(verify).toContain('contents: read')
    expect(verify).not.toContain('contents: write')
    const publish = jobBlock(workflow, 'publish')
    expect(publish).toContain('actions: read')
    expect(publish).toContain('contents: write')

    expect(promotion).toContain('workflow-run-attempt-artifact-id')
    expect(promotion).toContain('profileRawBytesSha256')
    expect(promotion).toContain('contractRawBytesSha256')
    expect(promotion).toContain('required platforms do not share identical contract/profile raw-byte hashes')
    expect(promotion).toContain('existing tag points to a different commit')
    expect(promotion).toContain('authoritative tag target mismatch')
    expect(promotion).toContain('authoritative latest-release policy mismatch')
    expect(promotion).not.toMatch(/(?:deleteRelease|method:\s*['"]DELETE['"])/)
    expect(validator).toContain('validateReleaseProfile')
  })
})
