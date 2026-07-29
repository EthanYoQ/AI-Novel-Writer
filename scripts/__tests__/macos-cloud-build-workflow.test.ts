import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'macos-arm64-cloud-build.yml')
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
  it('uses a manual GitHub-hosted Apple Silicon qualification without Release publication', () => {
    const workflow = readRequired(workflowPath)
    const packageMetadata = JSON.parse(readRequired(packageMetadataPath)) as { scripts?: Record<string, string> }
    const smokeScript = readRequired(macSmokeScriptPath)
    const manifestScript = readRequired(manifestScriptPath)
    const vectorRunnerBuildScript = readRequired(vectorRunnerBuildScriptPath)
    const vectorRunnerSource = readRequired(vectorRunnerSourcePath)

    const triggerBlock = workflow.match(/^on:\r?\n(?<triggers>(?: {2}.*(?:\r?\n|$))*)/m)?.groups?.triggers
    expect(triggerBlock?.trim()).toBe('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m)
    expect(workflow).toMatch(/^permissions:\r?\n\s{2}contents:\s*read\s*$/m)
    expect(workflow).toContain('runs-on: macos-14')
    expect(workflow).toContain('timeout-minutes: 60')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toMatch(/node-version:\s*['"]?22\.23\.1['"]?/)
    expect(workflow).toMatch(/version:\s*['"]?11\.11\.0['"]?/)
    const helperPreparation = namedStep(workflow, 'Build native secure helper for macOS tests')
    expect(helperPreparation).toContain('clang -fobjc-arc -framework Foundation')
    expect(helperPreparation).toContain('electron/security/darwin-safe-file-system.m')
    expect(helperPreparation).toContain('chmod +x electron/security/darwin-safe-file-system')
    expect(workflow).toContain('pnpm run build:mac:artifacts')
    expect(workflow).toContain('pnpm run smoke:mac-dmg')
    expect(workflow).toContain('node scripts/generate-macos-cloud-build-manifest.mjs')
    expect(workflow).not.toMatch(/\b(?:gh\s+release|create-release|upload-release|git\s+tag|git\s+push\s+.*(?:tag|refs\/tags)|codesign|notarytool)\b/i)

    const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
    for (const action of actionUses) expect(action).toMatch(/@[a-f0-9]{40}$/)

    const artifactStep = namedStep(workflow, 'Upload runtime-verified macOS ARM64 package')
    expect(artifactStep).toMatch(/if:\s*\$\{\{\s*success\(\)\s*\}\}/)
    expect(artifactStep).toContain('retention-days: 7')
    expect(artifactStep).toContain('ai-novel-writer-mac-arm64-*-installer.dmg')
    expect(artifactStep).toContain('ai-novel-writer-mac-arm64-*-installer.dmg.sha256')
    expect(artifactStep).toContain('SHA256SUMS.txt')
    expect(artifactStep).toContain('manifest.json')
    expect(artifactStep).toContain('qualification/packaged-vector-smoke.json')
    expect(artifactStep).toContain('qualification/packaged-official-homepage-smoke.json')
    expect(artifactStep).toContain('qualification/macos-dmg-smoke.json')

    expect(packageMetadata.scripts?.['build:mac:artifacts']).toContain('node scripts/build-release-vector-smoke-runner.mjs')
    expect(packageMetadata.scripts?.['build:mac:artifacts']).toContain('electron-builder --mac --arm64 --publish never')
    expect(packageMetadata.scripts?.['smoke:mac-dmg']).toContain('scripts/smoke-macos-dmg.sh')
    expect(smokeScript).toContain('hdiutil attach')
    expect(smokeScript).toContain('hdiutil detach')
    expect(smokeScript).toContain('hdiutil detach "$mount_point" -force -quiet')
    expect(smokeScript).toContain('rm -rf "$smoke_root" || true')
    expect(smokeScript).toContain('--ai-novel-release-smoke=')
    expect(smokeScript).toContain('--ai-novel-release-homepage-smoke=')
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
    expect(manifestScript).toContain("platform: 'darwin'")
    expect(manifestScript).toContain("arch: 'arm64'")
    expect(manifestScript).toContain("gateLevel: 'RUNTIME_VERIFIED'")
    expect(manifestScript).toContain('releaseCreated: false')
    expect(manifestScript).toContain('dmgChecksum')
  })
})
