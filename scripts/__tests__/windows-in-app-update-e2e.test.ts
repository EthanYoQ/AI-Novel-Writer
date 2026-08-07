import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OFFICIAL_UPDATE_REPOSITORY,
  WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS,
  WINDOWS_UPDATE_RUNNER_COMMAND,
  appendMonitorControl,
  createLegacyUpdateBridgePlan,
  createOfficialUpdatePlan,
  normalizeFinalReleaseTag,
  parseWindowsInAppUpdateE2eCli,
} from '../windows-in-app-update-e2e.mjs'

const temporaryRoots: string[] = []
const windowsIt = process.platform === 'win32' ? it : it.skip

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function runWindowsE2ePowerShellFunctions(functionNames: string[], script: string): string {
  const sourcePath = resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1')
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', [
      `$tokens = $null; $errors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(sourcePath)}, [ref]$tokens, [ref]$errors)`,
      `if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }`,
      ...functionNames.flatMap(functionName => [
        `$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq ${quotePowerShell(functionName)} }, $true)`,
        `if ($null -eq $definition) { throw ${quotePowerShell(`${functionName} was not found.`)} }`,
        `Invoke-Expression $definition.Extent.Text`,
      ]),
      script,
    ].join('; '),
  ], { cwd: process.cwd(), encoding: 'utf8' })
}

function runWindowsE2ePowerShellFunction(script: string): string {
  return runWindowsE2ePowerShellFunctions(['Stop-E2eExistingInstalledApps'], script)
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-novel-update-e2e-test-'))
  temporaryRoots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

function response(body: unknown, contentType = 'application/json'): Response {
  return new Response(
    Buffer.isBuffer(body) ? body : JSON.stringify(body),
    { status: 200, headers: { 'content-type': contentType } },
  )
}

function releaseFixture(tag: string) {
  const version = tag.slice(1)
  const installerName = `ai-novel-writer-setup-${version}.exe`
  const installer = Buffer.from(`official installer ${tag}`, 'utf8')
  const blockMap = Buffer.from(`official blockmap ${tag}`, 'utf8')
  const latestYml = Buffer.from([
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512(installer)}`,
    `    size: ${installer.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512(installer)}`,
  ].join('\n'), 'utf8')
  const asset = (name: string, bytes: Buffer) => ({
    name,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
    browser_download_url: `https://downloads.example.test/${tag}/${encodeURIComponent(name)}`,
  })
  return {
    release: {
      id: tag,
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        asset('latest.yml', latestYml),
        asset(installerName, installer),
        asset(`${installerName}.blockmap`, blockMap),
      ],
    },
    files: new Map([
      [`https://downloads.example.test/${tag}/${encodeURIComponent('latest.yml')}`, latestYml],
      [`https://downloads.example.test/${tag}/${encodeURIComponent(installerName)}`, installer],
      [`https://downloads.example.test/${tag}/${encodeURIComponent(`${installerName}.blockmap`)}`, blockMap],
    ]),
  }
}

function fixtureFetcher(fromTag: string, expectedTag: string, options: { latestTag?: string, corruptDigest?: boolean } = {}) {
  const from = releaseFixture(fromTag)
  const expected = releaseFixture(expectedTag)
  if (options.corruptDigest) {
    expected.release.assets[1].digest = `sha256:${'0'.repeat(64)}`
  }
  const latestTag = options.latestTag ?? expectedTag
  const requests: string[] = []
  const fetcher = async (url: string | URL) => {
    const value = String(url)
    requests.push(value)
    if (value === 'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/latest') {
      return response({ ...expected.release, tag_name: latestTag })
    }
    if (value === `https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/${fromTag}`) {
      return response(from.release)
    }
    if (value === `https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/${expectedTag}`) {
      return response(expected.release)
    }
    const bytes = from.files.get(value) ?? expected.files.get(value)
    if (bytes) return response(bytes, 'application/octet-stream')
    return new Response('not found', { status: 404 })
  }
  return { fetcher, requests }
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('Windows official in-app update E2E contract', () => {
  it('allocates monitor control sequences from the shared durable JSONL stream', () => {
    const root = temporaryRoot()
    const controlPath = join(root, 'control.jsonl')
    writeFileSync(controlPath, [
      JSON.stringify({ sequence: 1, state: 'running' }),
      JSON.stringify({ sequence: 2, state: 'legacy-bridge-arm' }),
      '',
    ].join('\n'))

    expect(appendMonitorControl(controlPath, { state: 'step-complete' })).toBe(3)
    expect(appendMonitorControl(controlPath, { state: 'stop' })).toBe(4)
    const records = readFileSync(controlPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line))
    expect(records.map(record => record.sequence)).toEqual([1, 2, 3, 4])
  })

  it('pins the official repository and accepts final semantic release tags only', () => {
    expect(OFFICIAL_UPDATE_REPOSITORY).toEqual({ owner: 'EthanYoQ', repo: 'AI-Novel-Writer' })
    expect(normalizeFinalReleaseTag('v0.5.2', 'from_tag')).toBe('v0.5.2')
    expect(normalizeFinalReleaseTag('0.6.0', 'expected_tag')).toBe('v0.6.0')

    for (const invalid of ['v0.6.0-rc.1', 'v0.6.0+build.4', 'refs/heads/main', ' v0.6.0', 'v0.6']) {
      expect(() => normalizeFinalReleaseTag(invalid, 'expected_tag')).toThrow('final semantic version')
    }
  })

  it('writes verified official assets only when expected_tag is the current formal latest release', async () => {
    const evidenceRoot = temporaryRoot()
    const { fetcher, requests } = fixtureFetcher('v0.5.2', 'v0.6.0')

    const plan = await createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot,
      fetcher,
    })

    expect(plan).toMatchObject({
      schemaVersion: 1,
      officialRepository: OFFICIAL_UPDATE_REPOSITORY,
      from: { tag: 'v0.5.2', version: '0.5.2' },
      expected: { tag: 'v0.6.0', version: '0.6.0' },
      latest: { tag: 'v0.6.0' },
    })
    expect(plan.expected.assets.installer.name).toBe('ai-novel-writer-setup-0.6.0.exe')
    expect(readFileSync(join(evidenceRoot, 'release-plan.json'), 'utf8')).toContain('sha256:')
    expect(requests).toEqual(expect.arrayContaining([
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/latest',
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/v0.5.2',
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/v0.6.0',
    ]))
    expect(requests.every(url => url.includes('EthanYoQ/AI-Novel-Writer') || url.startsWith('https://downloads.example.test/'))).toBe(true)
  })

  it('rejects a non-latest expected tag and any mismatched GitHub asset digest', async () => {
    await expect(createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: temporaryRoot(),
      fetcher: fixtureFetcher('v0.5.2', 'v0.6.0', { latestTag: 'v0.6.1' }).fetcher,
    })).rejects.toThrow('expected_tag must equal the current latest formal Release')

    await expect(createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: temporaryRoot(),
      fetcher: fixtureFetcher('v0.5.2', 'v0.6.0', { corruptDigest: true }).fetcher,
    })).rejects.toThrow('SHA-256 digest does not match')
  })

  it('pre-arms a one-time legacy bridge only for sources older than v0.7.0', () => {
    const historicalPlan = {
      from: { tag: 'v0.6.0' },
      expected: {
        tag: 'v0.7.0',
        assets: {
          installer: {
            name: 'ai-novel-writer-setup-0.7.0.exe',
            size: 234_679_883,
            sha256: 'd751d4ed6edbef1589380304c1cfff521f0b97eeb9f1a2f0936b0032f579f66c',
          },
        },
      },
    }

    expect(createLegacyUpdateBridgePlan(historicalPlan, {
      localAppData: 'C:\\Users\\runneradmin\\AppData\\Local',
    })).toEqual({
      mode: 'legacy-bridge',
      sourceTag: 'v0.6.0',
      expectedPendingInstallerPath: 'C:\\Users\\runneradmin\\AppData\\Local\\ai-novel-writer-updater\\pending\\ai-novel-writer-setup-0.7.0.exe',
      expectedInstaller: {
        name: 'ai-novel-writer-setup-0.7.0.exe',
        size: 234_679_883,
        sha256: 'd751d4ed6edbef1589380304c1cfff521f0b97eeb9f1a2f0936b0032f579f66c',
      },
    })

    expect(createLegacyUpdateBridgePlan({
      ...historicalPlan,
      from: { tag: 'v0.7.0' },
      expected: { ...historicalPlan.expected, tag: 'v0.7.1' },
    }, {
      localAppData: 'C:\\Users\\runneradmin\\AppData\\Local',
    })).toBeNull()
  })

  it('exposes a CLI with only release-tag and evidence-root inputs', () => {
    expect(parseWindowsInAppUpdateE2eCli([
      'prepare',
      '--from-tag', 'v0.5.2',
      '--expected-tag', 'v0.6.0',
      '--evidence-root', 'C:\\evidence',
    ])).toEqual({
      command: 'prepare',
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: 'C:\\evidence',
    })
    expect(() => parseWindowsInAppUpdateE2eCli([
      'prepare', '--from-tag', 'v0.5.2', '--expected-tag', 'v0.6.0', '--repository', 'other/repo',
    ])).toThrow('Usage:')
  })

  it('keeps the dispatch-only workflow and real UI/update evidence requirements explicit', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/windows-in-app-update-e2e.yml'), 'utf8')
    const powershell = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1'), 'utf8')
    const orchestration = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.mjs'), 'utf8')
    const releaseMonitor = readFileSync(resolve(process.cwd(), 'scripts/monitor-win-release-gate.ps1'), 'utf8')
    const driver = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e-driver.mjs'), 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('${{ env.AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT }}/*.json')
    expect(workflow).not.toContain('path: ${{ env.AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT }}')
    expect(workflow).toContain('node scripts/windows-in-app-update-e2e.mjs run')
    expect(workflow).toContain('EthanYoQ/AI-Novel-Writer')
    expect(workflow).toContain('v0.5.2')
    expect(workflow).toContain('v0.6.0')

    expect(powershell).toContain('smoke-win-installer.ps1')
    expect(powershell).toContain('monitor-win-release-gate.ps1')
    expect(powershell).toContain('AI_NOVEL_VELA_HOME')
    expect(powershell).toContain('Get-FileHash')
    expect(powershell).toContain('--remote-debugging-port')
    expect(powershell).toContain('--disable-gpu')
    expect(powershell).toContain('--user-data-dir=')
    expect(powershell).toContain("'chromium-profile'")
    expect(powershell).not.toContain('--no-sandbox')
    expect(powershell).toContain('--enable-logging')
    expect(powershell).toContain('--log-file=')
    expect(powershell).toContain('$e2eInstallRoot')
    expect(powershell).not.toMatch(/\$installRoot\s*=/)
    expect(powershell).toContain("'resources\\app.asar'")
    expect(powershell).not.toContain("'resources\\app.asar\\package.json'")
    expect(driver).toContain('connectOverCDP')
    expect(driver).toContain('检查更新')
    expect(driver).toContain('Check for updates')
    expect(driver).toContain('立即重启更新')
    expect(driver).toContain('Restart and update now')
    expect(driver).toContain('startup-auto-check')
    expect(driver).toContain('checkButton.isEnabled()')
    expect(driver).toContain('restartButton.isVisible()')

    expect(orchestration).toContain('createLegacyUpdateBridgePlan')
    expect(orchestration).toContain("mode: 'legacy-bridge'")
    expect(orchestration).toContain('legacyBridge,')
    expect(orchestration).toContain('-MonitorControlPath')
    expect(orchestration).toContain('-MonitorStatusPath')
    expect(powershell).toContain("state = 'legacy-bridge-arm'")
    expect(powershell).toContain(
      'foreach ($line in @(Get-Content -LiteralPath $ControlPath -Encoding UTF8))',
    )
    expect(powershell).toContain('Test-E2eLegacyBridgePendingInstaller')
    expect(powershell).toContain('Invoke-E2eLegacyBridge')
    expect(powershell).toContain('legacyInstallerHandoffObserved')
    expect(powershell).toContain('legacyInteractiveWizardObserved')
    expect(powershell).not.toContain('legacyInteractiveHandoffObserved')
    expect(powershell).toContain("commandLineAuthorizationMode = 'record-only'")
    expect(powershell).toContain('$preTriggerOldAppIdentity = Get-E2eLiveProcessIdentity')
    expect(powershell).toContain('Old application identity changed before triggering the legacy updater handoff.')
    expect(powershell).toContain('pendingInstallerDigestMatched')
    expect(powershell).toContain('nativeSilentSourceVersion = $false')
    expect(releaseMonitor).toContain('Test-AiNovelGateLegacyBridgeInstaller')
    expect(releaseMonitor).toContain('Test-AiNovelGateLegacyBridgeWizardWindow')
    expect(releaseMonitor).toContain("'legacy-bridge-observed'")
    expect(releaseMonitor).toContain("'legacy-bridge-terminated'")
    expect(releaseMonitor).toContain('Release gate rejected a second legacy bridge installer process.')
    expect(releaseMonitor).toContain("displayed a new Windows error dialog")
  })

  it('persists and uploads the three live UI lifecycle screenshots', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/windows-in-app-update-e2e.yml'), 'utf8')
    const driver = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e-driver.mjs'), 'utf8')

    expect(driver).toContain("const screenshots = join(evidenceRoot, 'screenshots')")
    expect(driver).toContain('mkdirSync(screenshots, { recursive: true })')
    expect(driver).toContain("join(screenshots, 'before-check-update.png')")
    expect(driver).toContain("join(screenshots, 'ready-to-restart-update.png')")
    expect(driver).toContain('join(screenshots, `restarted-${expectedVersion}.png`)')
    expect(workflow).toContain('${{ env.AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT }}/screenshots')
  })

  it('freezes each seeded user-data file while allowing updater-owned profile state to change', () => {
    const powershell = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1'), 'utf8')

    expect(powershell).toContain('function Get-E2eFrozenFileManifest')
    expect(powershell).toContain('function Assert-E2eFrozenFileManifestUnchanged')
    expect(powershell).toContain('frozenUserDataPaths = @(')
    for (const path of [
      'prompts/e2e-continuity.json',
      'skills/continuity-e2e/SKILL.md',
      'e2e-preservation/character-card.json',
      'e2e-preservation/chapter-017.md',
      'e2e-preservation/continuity-ledger.txt',
    ]) {
      expect(powershell).toContain(`'${path}'`)
    }
    expect(powershell).toContain('Get-E2eFrozenFileManifest -Root $e2eVelaHome -RelativePaths $e2eFrozenUserDataPaths')
    expect(powershell).toContain('Assert-E2eFrozenFileManifestUnchanged -Before $beforeFrozenUserData -After $afterFrozenUserData')
    expect(powershell).toContain('frozenFilesBefore = $beforeFrozenUserData')
    expect(powershell).toContain('frozenFilesAfter = $afterFrozenUserData')
    expect(powershell).toContain('frozenFilesHashMatched = $true')
    expect(powershell).not.toContain('$beforeVelaHome.sha256 -eq $afterVelaHome.sha256')
    expect(powershell).toContain('$e2eVelaHome = [string]$userDataFixture.velaHome')
    expect(powershell).toContain('$env:AI_NOVEL_VELA_HOME = $e2eVelaHome')
    expect(powershell).toContain('Get-E2eFrozenFileManifest -Root $e2eVelaHome')
    expect(powershell).toContain('Assert-E2eFrozenFileManifestUnchanged -Before $beforeRecentProject -After $afterRecentProject')
    expect(powershell).toContain('Assert-E2eManagedConfigPreserved -Before $beforeManagedConfig -After $afterManagedConfig')
    expect(powershell).toContain('Assert-E2eRecentProjectPreserved -RecentProjects $afterRecentProjects')
  })

  windowsIt('allows managed JSON normalization while rejecting lost user config or recent projects', () => {
    const expectedProject = 'C:\\e2e\\projects\\continuity'
    const output = runWindowsE2ePowerShellFunctions([
      'Assert-E2eCondition',
      'Test-E2eSameAbsolutePath',
      'Assert-E2eManagedConfigPreserved',
      'Assert-E2eRecentProjectPreserved',
    ], `
$before = [pscustomobject]@{
  e2eUserSentinel = 'preserve-config-sentinel'
  theme = 'light'
  locale = 'zh-CN'
  proxy = [pscustomobject]@{ enabled = $false; type = 'http'; host = '127.0.0.1'; port = 7890 }
}
$normalized = [pscustomobject]@{
  locale = 'zh-CN'
  theme = 'light'
  proxy = [pscustomobject]@{ port = 7890; host = '127.0.0.1'; type = 'http'; enabled = $false }
  e2eUserSentinel = 'preserve-config-sentinel'
  editorFontSize = 16
  updatePreferences = [pscustomobject]@{ lastCheckedAt = '2026-08-08T00:00:00.000Z' }
}
$normalizedAccepted = $true
try { Assert-E2eManagedConfigPreserved -Before $before -After $normalized } catch { $normalizedAccepted = $false }

$lostSentinelRejected = $false
try { Assert-E2eManagedConfigPreserved -Before $before -After ([pscustomobject]@{ theme = 'light'; locale = 'zh-CN'; proxy = $before.proxy }) } catch { $lostSentinelRejected = $_.Exception.Message -like '*sentinel*' }
$changedValueRejected = $false
try { Assert-E2eManagedConfigPreserved -Before $before -After ([pscustomobject]@{ e2eUserSentinel = $before.e2eUserSentinel; theme = 'dark'; locale = 'zh-CN'; proxy = $before.proxy }) } catch { $changedValueRejected = $_.Exception.Message -like '*theme*' }

$recentAccepted = $true
try { Assert-E2eRecentProjectPreserved -RecentProjects @([pscustomobject]@{ path = ${quotePowerShell(expectedProject)} }, [pscustomobject]@{ path = 'C:\\other' }) -ExpectedProjectRoot ${quotePowerShell(expectedProject)} } catch { $recentAccepted = $false }
$missingRecentRejected = $false
try { Assert-E2eRecentProjectPreserved -RecentProjects @([pscustomobject]@{ path = 'C:\\other' }) -ExpectedProjectRoot ${quotePowerShell(expectedProject)} } catch { $missingRecentRejected = $_.Exception.Message -like '*recent project*' }

[pscustomobject]@{
  NormalizedAccepted = $normalizedAccepted
  LostSentinelRejected = $lostSentinelRejected
  ChangedValueRejected = $changedValueRejected
  RecentAccepted = $recentAccepted
  MissingRecentRejected = $missingRecentRejected
} | ConvertTo-Json -Compress
`)

    expect(JSON.parse(output.trim())).toEqual({
      NormalizedAccepted: true,
      LostSentinelRejected: true,
      ChangedValueRejected: true,
      RecentAccepted: true,
      MissingRecentRejected: true,
    })
  })

  windowsIt('seeds a valid recent-project array whose authorized project data is frozen independently', () => {
    const root = temporaryRoot()
    const output = runWindowsE2ePowerShellFunctions(['New-E2eUserDataFixture'], `
$fixture = New-E2eUserDataFixture -RuntimeRoot ${quotePowerShell(root)}
$rawRecentProjects = Get-Content -LiteralPath (Join-Path $fixture.velaHome 'recent-projects.json') -Raw -Encoding UTF8
$recentProjects = @($rawRecentProjects | ConvertFrom-Json)
$projectManifest = Get-Content -LiteralPath (Join-Path $fixture.recentProjectRoot '.vela\\project.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$representativePath = Join-Path $fixture.recentProjectRoot 'drafts\\chapter-017.md'
$originalVelaHome = [System.IO.Path]::GetFullPath([string]$fixture.velaHome)
$e2eVelaHome = $fixture.velaHome
$velaHome = 'C:\\polluted-by-dot-source'
[pscustomobject]@{
  JsonIsArray = $rawRecentProjects.TrimStart().StartsWith('[')
  RecentCount = $recentProjects.Count
  ConfigSentinel = (Get-Content -LiteralPath (Join-Path $fixture.velaHome 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).e2eUserSentinel
  RecentPathMatches = [System.IO.Path]::GetFullPath([string]$recentProjects[0].path) -eq [System.IO.Path]::GetFullPath([string]$fixture.recentProjectRoot)
  ProjectRootExists = Test-Path -LiteralPath $fixture.recentProjectRoot -PathType Container
  ManifestValid = $projectManifest.schemaVersion -eq 1 -and $projectManifest.kind -eq 'ai-novel-project' -and [guid]::TryParse([string]$projectManifest.projectId, [ref]([guid]::Empty))
  RepresentativeExists = Test-Path -LiteralPath $representativePath -PathType Leaf
  RepresentativeFrozen = @($fixture.recentProjectFrozenPaths) -contains 'drafts/chapter-017.md'
  VelaHomeSurvivesCollision = [System.IO.Path]::GetFullPath([string]$e2eVelaHome) -eq $originalVelaHome
} | ConvertTo-Json -Compress
`)

    expect(JSON.parse(output.trim())).toEqual({
      JsonIsArray: true,
      RecentCount: 1,
      ConfigSentinel: 'preserve-config-sentinel',
      RecentPathMatches: true,
      ProjectRootExists: true,
      ManifestValid: true,
      RepresentativeExists: true,
      RepresentativeFrozen: true,
      VelaHomeSurvivesCollision: true,
    })
  })

  it('keeps the PowerShell runner ASCII-safe for Windows PowerShell child-process parsing', () => {
    const powershellBytes = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1'))

    expect([...powershellBytes].every(byte => byte < 0x80)).toBe(true)
  })

  it('allows a cold GitHub runner enough time to initialize the release monitor', () => {
    expect(WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('runs the E2E orchestration under the workflow PowerShell runtime', () => {
    expect(WINDOWS_UPDATE_RUNNER_COMMAND).toBe('pwsh.exe')
  })

  windowsIt('treats an already-exited installed app as clean while rejecting PID reuse', () => {
    const output = runWindowsE2ePowerShellFunction(`
$script:stopCalled = $false
function Add-AiNovelTrackedProcess { param($ProcessIds, $StartTimeTicks, $ProcessId); [void]$ProcessIds.Add([int]$ProcessId); $StartTimeTicks[[int]$ProcessId] = '1'; return $true }
function Add-AiNovelTrackedProcessTree { param($RootProcessId, $ProcessIds, $StartTimeTicks) }
function Get-AiNovelTopLevelWindowSnapshot { return @() }
function Test-AiNovelVisibleMainWindow { return $false }
function Stop-AiNovelProcessTree { $script:stopCalled = $true; throw 'unsafe stop invoked' }
function Assert-AiNovelProcessTreeExited { throw 'unsafe exit assertion invoked' }

$missingPid = 2147483000
function Get-E2eInstalledAppProcesses {
  return [pscustomobject]@{ ProcessId = $missingPid; ExecutablePath = 'C:\\e2e\\AI.exe'; StartTimeTicks = '639217262838291804' }
}
$naturalExitAccepted = $true
try { Stop-E2eExistingInstalledApps -ExePath 'C:\\e2e\\AI.exe' } catch { $naturalExitAccepted = $false }

$current = [System.Diagnostics.Process]::GetCurrentProcess()
try {
  $currentPath = [System.IO.Path]::GetFullPath([string]$current.MainModule.FileName)
  $currentStart = $current.StartTime.ToUniversalTime()
  function Get-E2eInstalledAppProcesses {
    return [pscustomobject]@{ ProcessId = $PID; ExecutablePath = $currentPath; StartTimeTicks = [string]($currentStart.AddSeconds(-1).Ticks) }
  }
  $script:stopCalled = $false
  $startMismatchRejected = $false
  try { Stop-E2eExistingInstalledApps -ExePath $currentPath } catch { $startMismatchRejected = $_.Exception.Message -like '*identity changed*' }
  $startMismatchStoppedNothing = -not $script:stopCalled

  $expectedOtherPath = 'C:\\e2e\\other\\AI.exe'
  function Get-E2eInstalledAppProcesses {
    return [pscustomobject]@{ ProcessId = $PID; ExecutablePath = $expectedOtherPath; StartTimeTicks = [string]$currentStart.Ticks }
  }
  $script:stopCalled = $false
  $pathMismatchRejected = $false
  try { Stop-E2eExistingInstalledApps -ExePath $expectedOtherPath } catch { $pathMismatchRejected = $_.Exception.Message -like '*path changed*' }
  $pathMismatchStoppedNothing = -not $script:stopCalled

  [pscustomobject]@{
    NaturalExitAccepted = $naturalExitAccepted
    StartMismatchRejected = $startMismatchRejected
    StartMismatchStoppedNothing = $startMismatchStoppedNothing
    PathMismatchRejected = $pathMismatchRejected
    PathMismatchStoppedNothing = $pathMismatchStoppedNothing
  } | ConvertTo-Json -Compress
}
finally {
  $current.Dispose()
}
`)
    expect(JSON.parse(output.trim().split(/\r?\n/).at(-1)!)).toEqual({
      NaturalExitAccepted: true,
      StartMismatchRejected: true,
      StartMismatchStoppedNothing: true,
      PathMismatchRejected: true,
      PathMismatchStoppedNothing: true,
    })
  })
})
