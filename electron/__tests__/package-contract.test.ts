import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { readNormalizedSource } from '../../test/source-contract'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  packageManager?: string
  optionalDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

describe('release dependency contract', () => {
  it('uses one pinned package manager and exposes every shipped LanceDB native binding', () => {
    expect(pkg.packageManager).toBe('pnpm@11.11.0')
    expect(pkg.optionalDependencies?.['@lancedb/lancedb-darwin-arm64']).toBe('0.27.2')
    expect(pkg.optionalDependencies?.['@lancedb/lancedb-win32-x64-msvc']).toBe('0.27.2')
    expect(existsSync('package-lock.json')).toBe(false)
  })

  it('runs clean, native verification, and executable smoke gates for Windows builds', () => {
    expect(pkg.scripts?.['build:win-dir']).toContain('pnpm run clean:build')
    expect(pkg.scripts?.['build:win-dir']).toContain('pnpm run rebuild:electron')
    expect(pkg.scripts?.['build:win-dir']).toContain('pnpm run verify:win-package')
    expect(pkg.scripts?.['verify:win-package']).toBe('node scripts/verify-win-package.mjs')
    expect(pkg.scripts?.['smoke:win-app']).toContain('scripts/smoke-win-app.ps1')

    const builder = readFileSync('electron-builder.json5', 'utf8')
    expect(builder).toContain('ai-novel-writer-mac-arm64-${version}-installer.${ext}')
    expect(builder).toContain('node_modules/@lancedb/lancedb/**/*')
    expect(builder).toContain('node_modules/@lancedb/lancedb-win32-x64-msvc/**/*')
    expect(builder).toContain('electron/security/windows-safe-file-system.ps1')
    expect(builder).toContain('security/windows-safe-file-system.ps1')

    const safeFileSystem = readFileSync('electron/security/windows-safe-file-system.ts', 'utf8')
    const safeFileSystemHelper = readFileSync('electron/security/windows-safe-file-system.ps1', 'utf8')
    expect(safeFileSystem).toContain('electron.app.isPackaged === true')
    expect(safeFileSystemHelper).toContain('public void Commit(bool mustAlreadyExist)')
    expect(safeFileSystemHelper).toContain('private const int FileRenameInformationEx = 65;')
    expect(safeFileSystemHelper).toContain('FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS')
    expect(safeFileSystemHelper).toContain('FILE_SHARE_READ | FILE_SHARE_WRITE);')
    expect(safeFileSystemHelper).toContain('RenameExistingIntoDirectory(temporaryFile.DangerousGetHandle()')
    expect(safeFileSystemHelper).toContain('$session.Commit($mustAlreadyExist)')
  })

  it('makes the formal Windows updater build self-verifying and keeps portable ZIPs out of the release workflow', () => {
    expect(pkg.scripts?.build).not.toContain('electron-builder')
    expect(pkg.scripts?.['build:win']).toBe('pnpm run release:win:verify')
    expect(pkg.scripts?.['release:win:verify']).toBe('node scripts/release-win-verify.mjs')
    expect(pkg.scripts?.['build:win:artifacts']).toMatch(/^node scripts\/require-release-gate\.mjs && /)
    expect(pkg.scripts?.['build:win:artifacts']).toContain('pnpm run rebuild:electron')
    expect(pkg.scripts?.['build:win:artifacts']).toContain('electron-builder --win --x64')
    expect(pkg.scripts?.['build:win:artifacts']).toContain('--publish never')

    const releaseGate = readFileSync('scripts/release-win-verify.mjs', 'utf8')
    const releaseMonitor = readNormalizedSource('scripts/monitor-win-release-gate.ps1')
    expect(releaseGate).toContain('monitor-win-release-gate.ps1')
    expect(releaseGate.indexOf("await waitForMonitorState(['ready']")).toBeLessThan(
      releaseGate.indexOf('for (const step of releaseVerificationSteps)'),
    )
    expect(releaseGate).toContain("state: 'step-complete'")
    expect(releaseGate).toContain("['step-completed']")
    expect(releaseGate).toContain('child.exitCode !== null')
    expect(releaseMonitor).toContain('$baselineWindows = @(Get-AiNovelTopLevelWindowSnapshot)')
    expect(releaseMonitor).toContain('Get-AiNovelProcessTreeIds')
    expect(releaseMonitor).toContain('Get-AiNovelNewErrorWindows')
    expect(releaseMonitor).toContain('Save-AiNovelSmokeFailureEvidence')
    expect(releaseMonitor).toContain('left related processes running')

    expect(pkg.scripts?.['build:win-zip']).toBeUndefined()
    expect(pkg.scripts?.['verify:github-update-release']).toBe('node scripts/verify-github-update-release.mjs')
  })

  it('runs the full test suite before the outer monitor starts', () => {
    expect(pkg.scripts?.test).toBe('vitest run')
    expect(pkg.scripts?.['test:release-monitor-selftest']).toBeUndefined()
    expect(pkg.scripts?.['test:release-workload']).toBeUndefined()

    const releaseGate = readFileSync('scripts/release-win-verify.mjs', 'utf8')
    const releaseMonitor = readNormalizedSource('scripts/monitor-win-release-gate.ps1')
    const plan = spawnSync(process.execPath, ['scripts/release-win-verify.mjs', '--print-plan'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(plan.status, plan.stderr || plan.error?.message).toBe(0)
    expect(JSON.parse(plan.stdout)).toEqual([
      'test',
      'prepare:native-node',
      'clean:build',
      'build:win:artifacts',
      'verify:win-update-artifacts',
      'verify:win-package',
      'smoke:win-app',
      'smoke:win-installer',
      'smoke:win-v025-upgrade',
      'restore:native-node',
      'verify:native-node',
      'final:quiet',
    ])
    const releasePlan = JSON.parse(plan.stdout) as string[]
    expect(releasePlan[0]).toBe('test')
    expect(releasePlan.filter(step => step === 'test')).toHaveLength(1)

    const preMonitorStepsDefinition = releaseGate.indexOf('export const releasePreMonitorSteps = [')
    const releaseVerificationStepsDefinition = releaseGate.indexOf('export const releaseVerificationSteps = [')
    const releaseFinalizationStepsDefinition = releaseGate.indexOf('export const releaseFinalizationSteps = [')
    const preMonitorSteps = releaseGate.slice(
      preMonitorStepsDefinition,
      releaseVerificationStepsDefinition,
    )
    const releaseVerificationSteps = releaseGate.slice(
      releaseVerificationStepsDefinition,
      releaseFinalizationStepsDefinition,
    )
    const preMonitorLoop = releaseGate.indexOf('for (const step of releasePreMonitorSteps)')
    const preMonitorInvocation = releaseGate.indexOf('await runPreMonitorSteps()')
    const monitorStartDefinition = releaseGate.indexOf('async function startReleaseMonitor()')
    const monitorStartCall = releaseGate.lastIndexOf('await startReleaseMonitor()')
    const finalizationFlagSet = releaseGate.indexOf('releaseFinalizationRequired = true')
    const monitorReadyWait = releaseGate.indexOf("await waitForMonitorState(['ready'], 10_000)")
    const monitorSpawn = releaseGate.indexOf('monitor = spawn(', monitorStartDefinition)
    const monitorPidValidation = releaseGate.indexOf('!Number.isInteger(monitor.pid) || monitor.pid <= 0')
    const monitorMarkerPublish = releaseGate.indexOf(
      'renameSync(monitorProcessTemporaryPath, monitorProcessPath)',
    )
    const monitoredWorkloadLoop = releaseGate.indexOf('for (const step of releaseVerificationSteps)')
    const finalizationGuard = releaseGate.indexOf('if (releaseFinalizationRequired) {')
    const canUseMonitorDefinition = releaseGate.indexOf('function canUseMonitor()')
    const canUseMonitorBody = releaseGate.slice(
      canUseMonitorDefinition,
      releaseGate.indexOf('async function runMonitoredNodeProcess', canUseMonitorDefinition),
    )
    const monitorStartBody = releaseGate.slice(
      monitorStartDefinition,
      releaseGate.indexOf('async function main()', monitorStartDefinition),
    )
    expect(preMonitorLoop).toBeGreaterThanOrEqual(0)
    expect(preMonitorInvocation).toBeGreaterThanOrEqual(0)
    expect(preMonitorStepsDefinition).toBeGreaterThanOrEqual(0)
    expect(releaseVerificationStepsDefinition).toBeGreaterThan(preMonitorStepsDefinition)
    expect(releaseFinalizationStepsDefinition).toBeGreaterThan(releaseVerificationStepsDefinition)
    expect(preMonitorSteps.match(/'test'/g) ?? []).toHaveLength(1)
    expect(releaseVerificationSteps).not.toMatch(/'test(?:[^']*)?'/)
    expect(monitorStartDefinition).toBeGreaterThanOrEqual(0)
    expect(preMonitorInvocation).toBeLessThan(monitorStartCall)
    expect(monitorStartCall).toBeLessThan(finalizationFlagSet)
    expect(finalizationFlagSet).toBeLessThan(monitorReadyWait)
    expect(monitorReadyWait).toBeLessThan(monitoredWorkloadLoop)
    expect(monitorSpawn).toBeGreaterThan(monitorStartDefinition)
    expect(monitorPidValidation).toBeGreaterThan(monitorSpawn)
    expect(monitorMarkerPublish).toBeGreaterThan(monitorPidValidation)
    expect(monitorMarkerPublish).toBeLessThan(monitorStartCall)
    expect(releaseGate.match(/monitor = spawn\(/g) ?? []).toHaveLength(1)
    expect(releaseGate.match(/await startReleaseMonitor\(\)/g) ?? []).toHaveLength(1)
    expect(monitorStartBody).toContain('observeChild(monitor)')
    expect(monitorStartBody).toContain('catch (markerPublicationError)')
    expect(monitorStartBody).toContain('monitor.kill()')
    expect(monitorStartBody).toContain(
      'await waitForObservedChildToSettleWithin(monitor, 5_000)',
    )
    expect(monitorStartBody).toContain(
      'rmSync(monitorProcessTemporaryPath, { force: true })',
    )
    expect(finalizationGuard).toBeGreaterThan(monitoredWorkloadLoop)
    expect(canUseMonitorBody).toContain('monitor.exitCode === null')
    expect(canUseMonitorBody).toContain('monitor.signalCode === null')
    expect(releaseGate.slice(preMonitorLoop, preMonitorInvocation)).toContain(
      "await runNodeProcess([pnpmCli, 'run', step])",
    )
    expect(releaseGate).toContain('let releaseFinalizationRequired = false')
    expect(releaseGate).not.toContain('preMonitorSucceeded')
    expect(releaseGate).toContain(
      "const monitorProcessPath = join(monitorRoot, 'monitor-process.json')",
    )
    expect(releaseGate).toContain('startedAt: new Date().toISOString()')

    expect(
      createHash('sha256').update(releaseMonitor).digest('hex'),
    ).toBe('c0bfaa9efe640442812bef8ab5bfb9b613aea4bd50e0c3ede3686910ef281858')
  })

  it('blocks direct Windows artifact builds outside the release gate', () => {
    // 使用最小环境，避免 Windows 对大小写不敏感的继承变量产生重复键并污染断言。
    const bypassEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      npm_lifecycle_event: 'build:win:artifacts',
    } as unknown as NodeJS.ProcessEnv
    const bypass = spawnSync(process.execPath, ['scripts/require-release-gate.mjs'], {
      cwd: process.cwd(),
      env: bypassEnv,
      encoding: 'utf8',
    })

    expect(bypass.status).not.toBe(0)
    expect(bypass.stderr).toContain('Direct Windows artifact builds are blocked')

    const gated = spawnSync(process.execPath, ['scripts/require-release-gate.mjs'], {
      cwd: process.cwd(),
      env: { ...bypassEnv, AI_NOVEL_RELEASE_GATE: 'release-win-verify' },
      encoding: 'utf8',
    })
    expect(gated.status, gated.stderr || gated.error?.message).toBe(0)
  })
})
