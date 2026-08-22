import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'macos-arm64-cloud-build.yml')
const x64WorkflowPath = path.join(repositoryRoot, '.github', 'workflows', 'macos-x64-cloud-build.yml')
const packageMetadataPath = path.join(repositoryRoot, 'package.json')
const macSmokeScriptPath = path.join(repositoryRoot, 'scripts', 'smoke-macos-dmg.sh')
const manifestScriptPath = path.join(repositoryRoot, 'scripts', 'generate-macos-cloud-build-manifest.mjs')
const vectorRunnerBuildScriptPath = path.join(repositoryRoot, 'scripts', 'build-release-vector-smoke-runner.mjs')
const vectorRunnerSourcePath = path.join(repositoryRoot, 'electron', 'release-vector-smoke-runner.ts')

function readRequired(file: string) {
  expect(existsSync(file), `Missing macOS cloud qualification contract file: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

function namedStep(source: string, name: string) {
  const start = source.indexOf(`- name: ${name}`)
  expect(start, `Missing workflow step: ${name}`).toBeGreaterThanOrEqual(0)
  const remainder = source.slice(start)
  const nextStep = remainder.search(/\r?\n\s{6}- name:/)
  return nextStep < 0 ? remainder : remainder.slice(0, nextStep)
}

describe('macOS ARM64 cloud build workflow contract', () => {
  it('binds an explicit frozen release/profile contract before installing dependencies', () => {
    const workflow = readRequired(workflowPath)
    for (const input of ['expected_sha', 'release_tag', 'release_version', 'profile_path']) {
      expect(workflow).toContain(`      ${input}:`)
    }
    expect(workflow).toContain('default: .release/release-profile.json')

    const checkout = namedStep(workflow, 'Check out source')
    expect(checkout).toContain('ref: ${{ inputs.expected_sha }}')
    expect(checkout).toContain('fetch-depth: 0')
    expect(checkout).toContain('persist-credentials: false')

    const initialize = namedStep(workflow, 'Initialize macOS v2 acceptance evidence')
    expect(initialize).toContain('EXPECTED_SHA: ${{ inputs.expected_sha }}')
    expect(initialize).toContain('RELEASE_TAG: ${{ inputs.release_tag }}')
    expect(initialize).toContain('RELEASE_VERSION: ${{ inputs.release_version }}')
    expect(initialize).toContain('PROFILE_PATH: ${{ inputs.profile_path }}')
    expect(initialize).toContain('.release/scripts/freeze-release-contract.mjs')
    expect(readRequired(path.join(repositoryRoot, '.release', 'scripts', 'freeze-release-contract.mjs'))).toContain('profileRawBytesSha256')
    expect(readRequired(path.join(repositoryRoot, '.release', 'scripts', 'freeze-release-contract.mjs'))).toContain('contractRawBytesSha256')
    expect(workflow.indexOf('Initialize macOS v2 acceptance evidence')).toBeLessThan(workflow.indexOf('Install locked dependencies'))

    const upload = namedStep(workflow, 'Upload runtime-verified macOS ARM64 package')
    expect(upload).toContain('id: upload-qualified')
    expect(upload).toContain('name: qualified-macos-arm64')
    expect(upload).toContain('retention-days: 14')
  })

  it('uses a manual GitHub-hosted Apple Silicon qualification without Release publication', () => {
    const workflow = readRequired(workflowPath)
    const packageMetadata = JSON.parse(readRequired(packageMetadataPath)) as { scripts?: Record<string, string> }
    const smokeScript = readRequired(macSmokeScriptPath)
    const manifestScript = readRequired(manifestScriptPath)
    const vectorRunnerBuildScript = readRequired(vectorRunnerBuildScriptPath)
    const vectorRunnerSource = readRequired(vectorRunnerSourcePath)

    const triggerBlock = workflow.match(/^on:\r?\n(?<triggers>(?: {2}.*(?:\r?\n|$))*)/m)?.groups?.triggers
    expect(triggerBlock?.trim()).toMatch(/^workflow_dispatch:\r?\n\s+inputs:/)
    expect(workflow).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m)
    expect(workflow).toMatch(/^permissions:\r?\n\s{2}contents:\s*read\s*$/m)
    expect(workflow).toContain('runs-on: macos-14')
    expect(workflow).toContain('timeout-minutes: 60')
    expect(workflow).toMatch(/node-version:\s*['"]?22\.23\.1['"]?/)
    expect(workflow).toMatch(/version:\s*['"]?11\.11\.0['"]?/)
    const checkout = namedStep(workflow, 'Check out source')
    expect(checkout).toContain('ref: ${{ inputs.expected_sha }}')
    expect(checkout).toContain('persist-credentials: false')

    const initializeEvidence = namedStep(workflow, 'Initialize macOS v2 acceptance evidence')
    expect(initializeEvidence).toContain('release-evidence-v2.mjs init --platform macos-arm64')
    expect(initializeEvidence).toContain('--evidence-root "$evidence_root"')
    expect(initializeEvidence).toContain('--repository "$GITHUB_REPOSITORY"')
    expect(initializeEvidence).toContain('--commit "$EXPECTED_SHA"')
    expect(initializeEvidence).toContain('--run-id "$GITHUB_RUN_ID"')
    expect(initializeEvidence).toContain('--run-attempt "$GITHUB_RUN_ATTEMPT"')
    expect(initializeEvidence).toContain("--runner-label 'macos-14'")
    expect(initializeEvidence).toContain('--image-os "$ImageOS"')
    expect(initializeEvidence).toContain('--image-version "$ImageVersion"')
    expect(initializeEvidence).toContain('--expected-node-version 22.23.1')
    expect(initializeEvidence).toContain('--expected-pnpm-version 11.11.0')
    expect(initializeEvidence).toContain("--workflow-path '.github/workflows/macos-arm64-cloud-build.yml'")
    expect(initializeEvidence).toContain("--workflow-name 'macOS ARM64 cloud package qualification'")
    expect(initializeEvidence).toContain('--actor "$GITHUB_ACTOR"')
    expect(initializeEvidence).toContain('--event "$GITHUB_EVENT_NAME"')
    expect(initializeEvidence).toContain("--dispatch-inputs-json '{}'")
    expect(initializeEvidence).toContain('AI_NOVEL_RELEASE_EVIDENCE_ROOT=$evidence_root')
    expect(workflow.indexOf('Initialize macOS v2 acceptance evidence')).toBeLessThan(workflow.indexOf('Install locked dependencies'))

    const expectedRecordedSteps = [
      ['Install locked dependencies', 'install-locked-dependencies', 'pnpm install --frozen-lockfile'],
      ['Install Playwright Chromium', 'install-playwright-chromium', 'pnpm exec playwright install chromium'],
      ['Run renderer browser tests', 'renderer-browser-tests', 'pnpm run test:browser'],
      ['Build native secure helper for macOS tests', 'build-native-secure-helper', 'clang -fobjc-arc -framework Foundation'],
      ['Run test suite', 'test-suite', 'pnpm test'],
      ['Build unsigned macOS ARM64 package', 'build-macos-arm64-package', 'pnpm run build:mac:arm64:artifacts'],
      ['Run mounted-DMG smoke', 'mounted-dmg-smoke', 'AI_NOVEL_RELEASE_TARGET_ARCH=arm64 pnpm run smoke:mac-dmg'],
    ] as const
    for (const [name, step, command] of expectedRecordedSteps) {
      const recordedStep = namedStep(workflow, name)
      expect(recordedStep).toContain('release-evidence-v2.mjs record')
      expect(recordedStep).toContain('--evidence-root "$AI_NOVEL_RELEASE_EVIDENCE_ROOT"')
      expect(recordedStep).toContain(`--step ${step} --`)
      expect(recordedStep).toContain(command)
    }

    const helperPreparation = namedStep(workflow, 'Build native secure helper for macOS tests')
    expect(helperPreparation).toContain('clang -fobjc-arc -framework Foundation')
    expect(helperPreparation).toContain('electron/security/darwin-safe-file-system.m')
    expect(helperPreparation).toContain('chmod +x electron/security/darwin-safe-file-system')
    expect(workflow).toContain('pnpm run build:mac:arm64:artifacts')
    expect(workflow).toContain('pnpm run smoke:mac-dmg')
    expect(workflow).not.toContain('node scripts/generate-macos-cloud-build-manifest.mjs')
    expect(workflow).not.toMatch(/\b(?:gh\s+release|create-release|upload-release|git\s+tag|git\s+push\s+.*(?:tag|refs\/tags)|codesign|notarytool)\b/i)

    const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
    for (const action of actionUses) expect(action).toMatch(/@[a-f0-9]{40}$/)

    const artifactStep = namedStep(workflow, 'Upload runtime-verified macOS ARM64 package')
    expect(artifactStep).toMatch(/if:\s*\$\{\{\s*success\(\)\s*\}\}/)
    expect(artifactStep).toContain('retention-days: 14')
    expect(artifactStep).toContain('macos-arm64-qualified')

    const finalizeEvidence = namedStep(workflow, 'Finalize macOS v2 acceptance receipts')
    expect(finalizeEvidence).toContain('release-evidence-v2.mjs finalize --platform macos-arm64')
    expect(finalizeEvidence).toContain('--evidence-root "$AI_NOVEL_RELEASE_EVIDENCE_ROOT"')
    expect(finalizeEvidence).toContain('project-legacy-qualification.mjs --platform macos-arm64')
    expect(finalizeEvidence).toContain('--source-root "release/$version"')
    expect(finalizeEvidence).toContain('--output-root "$AI_NOVEL_LEGACY_RELEASE_ROOT"')
    expect(finalizeEvidence).toContain('--bundle-root "$AI_NOVEL_LEGACY_RELEASE_ROOT"')
    expect(finalizeEvidence).toContain('--legacy-root "$AI_NOVEL_LEGACY_RELEASE_ROOT"')
    expect(finalizeEvidence).toContain('verify-bundle --platform macos-arm64')
    expect(finalizeEvidence).toContain('finalize-legacy-qualification.mjs --platform macos-arm64')
    expect(finalizeEvidence.indexOf('release-evidence-v2.mjs finalize')).toBeLessThan(finalizeEvidence.indexOf('project-legacy-qualification.mjs'))
    expect(finalizeEvidence.indexOf('project-legacy-qualification.mjs')).toBeLessThan(finalizeEvidence.indexOf('release-evidence-v2.mjs verify-bundle'))
    expect(workflow.indexOf('Finalize macOS v2 acceptance receipts')).toBeGreaterThan(workflow.indexOf('Run mounted-DMG smoke'))
    expect(workflow.indexOf('Finalize macOS v2 acceptance receipts')).toBeLessThan(workflow.indexOf('Upload runtime-verified macOS ARM64 package'))

    expect(packageMetadata.scripts?.['build:mac:artifacts']).toContain('build:mac:arm64:artifacts')
    expect(packageMetadata.scripts?.['build:mac:arm64:artifacts']).toContain('node scripts/build-release-vector-smoke-runner.mjs')
    expect(packageMetadata.scripts?.['build:mac:arm64:artifacts']).toContain('electron-builder --mac --arm64 --publish never')
    expect(packageMetadata.scripts?.['build:mac:x64:artifacts']).toContain('electron-builder --mac --x64 --publish never')
    expect(packageMetadata.scripts?.['smoke:mac-dmg']).toContain('scripts/smoke-macos-dmg.sh')
    expect(smokeScript).toContain('hdiutil attach')
    expect(smokeScript).toContain('hdiutil detach')
    expect(smokeScript).toContain('hdiutil detach "$mount_point" -force -quiet')
    expect(smokeScript).toContain('rm -rf "$smoke_root" || true')
    expect(smokeScript).toContain('--ai-novel-release-smoke=')
    expect(smokeScript).toContain('--ai-novel-release-homepage-smoke=')
    expect(smokeScript).toContain('--ai-novel-release-skin-smoke=')
    expect(smokeScript).toContain('AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN')
    expect(smokeScript).toContain('AI_NOVEL_VELA_HOME')
    expect(smokeScript).toContain('packaged-skin-smoke.json')
    expect(smokeScript).toContain("kind !== 'packaged-skin-smoke'")
    expect(smokeScript).toContain('security/darwin-safe-file-system')
    expect(smokeScript).toContain('SECURE_FS_REPARSE_POINT')
    expect(smokeScript).toContain('secureFileSystemSmoke: true')
    expect(smokeScript).toContain('run_with_timeout')
    expect(smokeScript).toContain('Package smoke process exceeded timeout')
    expect(smokeScript).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(smokeScript).toContain('release-vector-smoke-runner.cjs')
    expect(vectorRunnerBuildScript).toContain('release-vector-smoke-runner.ts')
    expect(vectorRunnerBuildScript).toContain("platform: 'node'")
    expect(vectorRunnerSource).toContain('runReleaseVectorSmoke')
    expect(vectorRunnerSource).toContain('Packaged vector smoke timed out after 90 seconds')
    expect(manifestScript).toContain('finalizeReleaseEvidence')
    expect(manifestScript).toContain('AI_NOVEL_RELEASE_EVIDENCE_ROOT')
  })

  it('qualifies Intel x64 as a separate immutable artifact rather than reusing Apple Silicon evidence', () => {
    const workflow = readRequired(x64WorkflowPath)

    expect(workflow).toContain('name: macOS Intel x64 cloud package qualification')
    expect(workflow).toContain('runs-on: macos-15-intel')
    expect(workflow).toContain('group: macos-x64-cloud-build-${{ inputs.expected_sha }}-${{ inputs.release_version }}')
    expect(workflow).toContain('ref: ${{ inputs.expected_sha }}')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('release-evidence-v2.mjs init --platform macos-x64')
    expect(workflow).toContain("--runner-label 'macos-15-intel'")
    expect(workflow).toContain("--workflow-path '.github/workflows/macos-x64-cloud-build.yml'")
    expect(workflow).toContain("--workflow-name 'macOS Intel x64 cloud package qualification'")
    expect(workflow).toContain('freeze-release-contract.mjs')
    expect(workflow).toContain('--platform macos-x64')
    const nativeBinding = namedStep(workflow, 'Verify Intel LanceDB native binding')
    expect(nativeBinding).toContain('release-evidence-v2.mjs record')
    expect(nativeBinding).toContain('--step verify-lancedb-darwin-x64-binding --')
    expect(nativeBinding).toContain('NAPI_RS_ENFORCE_VERSION_CHECK=1')
    expect(nativeBinding).toContain("require('@lancedb/lancedb-darwin-x64')")
    expect(nativeBinding).toContain("require('@lancedb/lancedb')")
    expect(nativeBinding).toContain("require.resolve('@lancedb/lancedb')")
    expect(nativeBinding).toContain("require.resolve('@lancedb/lancedb-darwin-x64')")
    expect(nativeBinding).toContain("process.arch !== 'x64'")
    expect(workflow.indexOf('Verify Intel LanceDB native binding')).toBeGreaterThan(workflow.indexOf('Install locked dependencies'))
    expect(workflow.indexOf('Verify Intel LanceDB native binding')).toBeLessThan(workflow.indexOf('Run test suite'))
    expect(workflow).toContain('pnpm run build:mac:x64:artifacts')
    expect(workflow).toContain('AI_NOVEL_RELEASE_TARGET_ARCH=x64 pnpm run smoke:mac-dmg')
    expect(workflow).toContain("test \"$(uname -m)\" = 'x86_64'")
    expect(workflow).toContain('name: qualified-macos-x64')
    expect(workflow).toContain('path: ${{ runner.temp }}/macos-x64-qualified')
    expect(workflow).not.toContain('qualified-macos-arm64')
    expect(workflow).not.toMatch(/\b(?:gh\s+release|create-release|upload-release|git\s+tag|git\s+push\s+.*(?:tag|refs\/tags)|codesign|notarytool)\b/i)
  })
})
