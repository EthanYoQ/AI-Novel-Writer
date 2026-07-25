import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  packageManager?: string
  optionalDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

describe('release dependency contract', () => {
  it('uses one pinned package manager and exposes the Windows LanceDB binding', () => {
    expect(pkg.packageManager).toBe('pnpm@11.11.0')
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
    const releaseMonitor = readFileSync('scripts/monitor-win-release-gate.ps1', 'utf8')
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

    const plan = spawnSync(process.execPath, ['scripts/release-win-verify.mjs', '--print-plan'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(plan.status).toBe(0)
    expect(JSON.parse(plan.stdout)).toEqual([
      'prepare:native-node',
      'test',
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
    expect(pkg.scripts?.['build:win-zip']).toBeUndefined()
    expect(pkg.scripts?.['verify:github-update-release']).toBe('node scripts/verify-github-update-release.mjs')
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
