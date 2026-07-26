import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeConnection, getEmbeddingSpaces, search } from '../../electron/vector-store'

const windowsIt = process.platform === 'win32' ? it : it.skip
const probeScript = resolve('scripts/smoke-win-app.ps1')
const installerScript = resolve('scripts/smoke-win-installer.ps1')
const releaseMonitorScript = resolve('scripts/monitor-win-release-gate.ps1')
const upgradeFixtureScript = resolve('scripts/upgrade-data-fixture.mjs')
const electronNodeRunner = resolve('node_modules/electron/dist/electron.exe')

describe('packaged vector qualification wiring', () => {
  it('runs the installed application under a dual-gated one-time token and preserves machine-readable evidence', () => {
    const installer = readFileSync(installerScript, 'utf8')

    expect(installer).toContain('Invoke-AiNovelPackagedVectorSmoke')
    expect(installer).toContain("$env:AI_NOVEL_RELEASE_SMOKE = '1'")
    expect(installer).toContain('AI_NOVEL_RELEASE_SMOKE_TOKEN')
    expect(installer).toContain('--ai-novel-release-smoke=')
    expect(installer).toContain('packaged-vector-smoke.json')
    expect(installer).toContain('$result.projectB.initialVectorDimension -eq 768')
    expect(installer).toContain('$result.projectB.vectorDimension -eq 1536')
    expect(installer).toContain('$result.projectB.sameFingerprintRebuilt -eq $true')
    expect(installer).toContain('Assert-NoNewInstallerErrorWindow')
    expect(installer).toContain('RedirectStandardOutput')
  })

  it('runs an offline dual-gated packaged official-homepage probe and preserves its JSON evidence', () => {
    const installer = readFileSync(installerScript, 'utf8')

    expect(installer).toContain('Invoke-AiNovelPackagedOfficialHomepageSmoke')
    expect(installer).toContain("$env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE = '1'")
    expect(installer).toContain('AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN')
    expect(installer).toContain('--ai-novel-release-homepage-smoke=')
    expect(installer).toContain('packaged-official-homepage-smoke.json')
    expect(installer).toContain("$result.kind -eq 'packaged-official-homepage-smoke'")
    expect(installer).toContain("$result.trustedIntent.url -eq 'https://github.com/EthanYoQ/AI-Novel-Writer'")
    expect(installer).toContain('$result.trustedIntent.success -eq $true')
    expect(installer).toContain('$result.failedOpenExternal.success -eq $false')
    expect(installer).toContain('$result.failedOpenExternal.rendererError.enUS -eq \'Unable to open the official homepage. Please try again later.\'')
  })
})

describe('Windows PowerShell smoke script encoding', () => {
  it('uses a UTF-8 BOM for scripts directly executed by Windows PowerShell', () => {
    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])

    for (const script of [probeScript, installerScript]) {
      expect(readFileSync(script).subarray(0, utf8Bom.length)).toEqual(utf8Bom)
    }
  })
})

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function runProbeLibrary(script: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `. ${quotePowerShell(probeScript)} -LoadProbeLibrary\n${script}`,
    ],
    { encoding: 'utf8' },
  )
}

function runInstallerLibrary(script: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$installer = (Get-Command powershell.exe).Source
. ${quotePowerShell(installerScript)} -InstallerPath $installer -InstallerTimeoutSeconds 12 -PostExitQuietSeconds 5 -LoadInstallerLibrary
${script}`,
    ],
    { encoding: 'utf8' },
  )
}

function runReleaseMonitorLibrary(script: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `. ${quotePowerShell(releaseMonitorScript)} -LoadMonitorLibrary\n${script}`,
    ],
    { encoding: 'utf8' },
  )
}

function parseLastJsonLine(output: string): Record<string, unknown> {
  const line = output.trim().split(/\r?\n/).at(-1)
  if (!line) throw new Error('PowerShell probe did not return JSON')
  return JSON.parse(line) as Record<string, unknown>
}

function runWinFormsGracefulCloseProbe(rejectClose: boolean, timeoutSeconds: number): Record<string, unknown> {
  const rejectCloseHandler = rejectClose
    ? '$form.add_FormClosing({ param($sender, $eventArgs) $eventArgs.Cancel = $true })'
    : ''
  const output = runProbeLibrary(`
$childScript = @'
Add-Type -AssemblyName System.Windows.Forms
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'AI Novel Writer graceful-close test'
${rejectCloseHandler}
$form.Show()
[System.Windows.Forms.Application]::Run($form)
'@
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($childScript))
$process = $null
try {
  $process = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Sta', '-EncodedCommand', $encoded) -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  } while ($process.MainWindowTitle -ne 'AI Novel Writer graceful-close test' -and [DateTime]::UtcNow -lt $deadline)
  if ($process.MainWindowTitle -ne 'AI Novel Writer graceful-close test') {
    throw 'WinForms test process did not expose its main window.'
  }
  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($process.Id)
  $startTimeTicks = @{ ([string]$process.Id) = $process.StartTime.ToUniversalTime().Ticks }
  $windows = @([pscustomobject]@{
    ProcessId = $process.Id
    Visible = $true
    ClassName = 'Chrome_WidgetWin_1'
    Title = 'AI Novel Writer graceful-close test'
  })
  $failure = ''
  try {
    Close-AiNovelProcessTreeGracefully -Process $process -ProcessIds $processIds -StartTimeTicks $startTimeTicks -Windows $windows -TimeoutSeconds ${timeoutSeconds}
  } catch {
    $failure = $_.Exception.Message
  }
  $process.Refresh()
  [pscustomobject]@{
    Failure = $failure
    Exited = $process.HasExited
    ExitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  } | ConvertTo-Json -Compress
} finally {
  if ($process) {
    $process.Refresh()
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      [void]$process.WaitForExit(5000)
    }
    $process.Dispose()
  }
}
`)
  return parseLastJsonLine(output)
}

function runUpgradeFixture(mode: 'seed' | 'validate', projectRoot: string): Record<string, unknown> {
  const output = execFileSync(
    electronNodeRunner,
    [upgradeFixtureScript, mode, projectRoot],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    },
  )
  return parseLastJsonLine(output)
}

function runUpgradeFixtureWithNode(
  mode: 'seed' | 'validate',
  projectRoot: string,
  settingsPath?: string,
): Record<string, unknown> {
  const output = execFileSync(
    process.execPath,
    [upgradeFixtureScript, mode, projectRoot, ...(settingsPath ? [settingsPath] : [])],
    { encoding: 'utf8' },
  )
  return parseLastJsonLine(output)
}

function validateUpgradeFixtureWithNode(projectRoot: string, settingsPath?: string) {
  return spawnSync(
    process.execPath,
    [upgradeFixtureScript, 'validate', projectRoot, ...(settingsPath ? [settingsPath] : [])],
    { encoding: 'utf8' },
  )
}

function writeUpgradeFixtureSettings(settingsPath: string) {
  writeFileSync(settingsPath, JSON.stringify({
    theme: 'light',
    locale: 'zh-CN',
    proxy: { enabled: false, type: 'http', host: '', port: 7890 },
  }), 'utf8')
}

describe('Windows installer smoke contract', () => {
  it('runs the installed executable with isolated Vela data and supports an old-installer upgrade path', () => {
    const script = readFileSync('scripts/smoke-win-installer.ps1', 'utf8')

    expect(script).toContain('$PreviousInstallerPath')
    expect(script).toContain('$PreviousPortableZipPath')
    expect(script).toContain('Expand-Archive')
    expect(script).toContain('Install-Silently')
    expect(script).toContain('$InstallerTimeoutSeconds')
    expect(script).toContain('$PostExitQuietSeconds = 5')
    expect(script).toContain('$installerObservationSeconds')
    expect(script).toContain('$installerPostExitQuietSeconds')
    expect(script).toContain('Get-AiNovelNewErrorWindows')
    expect(script.match(/Get-AiNovelStartupBlockingErrorWindows/g)?.length).toBe(2)
    expect(script).toContain('Installer smoke cannot start while an existing product error dialog is open')
    expect(script).toContain('Add-AiNovelTrackedProcessTree')
    expect(script).toContain('Take one final desktop snapshot')
    expect(script).toContain('Invoke-AiNovelUpgradeDataFixture')
    expect(script).toContain('upgrade-data-fixture.mjs')
    expect(script).toContain('ELECTRON_RUN_AS_NODE')
    expect(script).toContain('[string]$SettingsPath')
    expect(script).toContain('-SettingsPath $globalConfig')
    expect(script).toContain('.vela\\vela.db')
    expect(script).toContain('recent-projects.json')
    expect(script).toContain('$upgradeFixtureRoot')
    expect(script).toContain('$result.legacyTableCount -eq 11')
    expect(script).toContain('$result.revisionCount -eq 1')
    expect(script).toContain('$result.reviewCount -eq 1')
    expect(script).toContain('$result.postProcessRunCount -eq 1')
    expect(script).toContain('$result.postProcessStepCount -eq 2')
    expect(script).toContain('$result.llmCallCount -eq 2')
    expect(script).toContain('$result.summarySnapshotCount -eq 2')
    expect(script).toContain('$result.assetInventoryPath -eq \'.vela/upgrade-data-inventory.json\'')
    expect(script).toContain('$result.assetCount -ge 6')
    expect(script).toContain('$result.preservedAssetCount -eq $result.assetCount')
    expect(script).toContain('$result.embeddingSpace.vectorDimension -eq 768')
    expect(script).toContain('$result.embeddingSpace.queryResultCount -eq 1')
    expect(script).toContain('v0.2.5 upgrade data preservation evidence:')
    expect(script).toContain('-LegacyProjectPathToOpen $upgradeFixtureRoot')
    expect(script.indexOf('-LegacyProjectPathToOpen $upgradeFixtureRoot')).toBeLessThan(
      script.indexOf('Install-Silently $resolvedInstaller'),
    )
    expect(script).toContain('RelatedProcessStartTimeTicks')
    expect(script).toContain('$fixtureRecentEntry')
    expect(script).toContain('did not retain the opened fixture in recent projects')
    expect(script).not.toContain('Start-Process -FilePath $Path -ArgumentList $Arguments -Wait')
    expect(script).toContain('smoke-win-app.ps1')
    expect(script).toContain('VelaHome = $velaHome')
    expect(script).toContain('$appSmokeParameters.ProjectPathToOpen = $upgradeFixtureRoot')
    expect(script).toContain('PostExitQuietSeconds = $PostExitQuietSeconds')
    expect(script).toContain('Installer smoke changed existing global configuration')

    const appSmoke = readFileSync('scripts/smoke-win-app.ps1', 'utf8')
    expect(appSmoke).toContain('AI_NOVEL_SMOKE_OPEN_PROJECT')
    expect(appSmoke.match(/Get-AiNovelStartupBlockingErrorWindows/g)?.length).toBeGreaterThanOrEqual(3)
    expect(appSmoke).toContain('Application smoke cannot start while an existing product error dialog is open')
    expect(appSmoke).toContain('project-opened.json')
    expect(appSmoke).toContain('renderer did not open and confirm the upgrade fixture project')
    const appSource = readFileSync('src/App.tsx', 'utf8')
    const projectController = readFileSync('electron/controllers/project-controller.ts', 'utf8')
    expect(appSource).toContain("ipc.invoke('project:smoke-open-request')")
    expect(appSource).toContain('openProject(request.projectPath)')
    expect(appSource).toContain("ipc.invoke('project:smoke-open-confirm', request.projectPath)")
    expect(projectController).toContain('getCurrentProjectPath()')
    expect(projectController).toContain('AI_NOVEL_SMOKE_PROJECT_MARKER')
    expect(appSmoke).toContain('$PostExitQuietSeconds = 5')
    expect(appSmoke).toContain('Stop-AiNovelProcessTree')
    expect(appSmoke).toContain('Assert-AiNovelProcessTreeExited')
    expect(appSmoke).toContain('Wait-AiNovelPostExitQuietPeriod')
    expect(appSmoke.indexOf('Assert-AiNovelProcessTreeExited')).toBeLessThan(
      appSmoke.lastIndexOf('Wait-AiNovelPostExitQuietPeriod'),
    )
    expect(appSmoke.indexOf('$smokeSucceeded = $true')).toBeGreaterThan(
      appSmoke.lastIndexOf('Wait-AiNovelPostExitQuietPeriod'),
    )
    expect(appSmoke).toContain('GetClassName')
    expect(appSmoke).toContain('IsWindowVisible')
    expect(appSmoke).toContain('Test-AiNovelVisibleTargetWindow')
    expect(appSmoke).toContain('Test-AiNovelVisibleMainWindow')
    expect(appSmoke).toContain('-TargetProcessIds $liveAppProcessIds')
    expect(appSmoke).toContain('Test-AiNovelTrackedProcessAlive')
    expect(appSmoke).toContain('Get-AiNovelLiveTrackedProcessIds')
    expect(appSmoke).not.toContain('taskkill.exe')
    expect(appSmoke).toContain('probe-legacy-project-open.mjs')
    expect(appSmoke).not.toContain('-WindowStyle Hidden')
    expect(appSmoke).toContain('#32770')
    expect(appSmoke).toContain('javascript error')
    expect(appSmoke).toContain('Chrome_WidgetWin_1')
    expect(appSmoke).toContain('Assert-AiNovelMainWindowContinuity')
    expect(appSmoke).toContain('$healthyObservationDeadline = $nowUtc.AddSeconds($ObservationSeconds)')
    expect(appSmoke).toContain('full $ObservationSeconds seconds after first appearing')
    expect(appSmoke.indexOf('$healthyObservationDeadline = $nowUtc.AddSeconds($ObservationSeconds)')).toBeGreaterThan(
      appSmoke.indexOf('Test-AiNovelVisibleMainWindow'),
    )
    expect(appSmoke).toContain('main window disappeared for more than $GraceMilliseconds milliseconds')
    expect(appSmoke).toContain('main window was not visible in the final smoke-test snapshot')

    const releaseMonitor = readFileSync('scripts/monitor-win-release-gate.ps1', 'utf8')
    expect(releaseMonitor).toContain('$targetNameSnapshot = [string[]]@(')
    expect(releaseMonitor).toContain('-TargetNames $targetNameSnapshot')
    expect(releaseMonitor).toContain('Get-AiNovelStartupBlockingErrorWindows')
    expect(releaseMonitor.indexOf('Get-AiNovelStartupBlockingErrorWindows')).toBeLessThan(
      releaseMonitor.indexOf("Write-AiNovelGateStatus -State 'ready'"),
    )
    expect(appSmoke).toContain('[AllowEmptyCollection()][AllowEmptyString()][string[]]$TargetNames')

    const fixture = readFileSync('scripts/upgrade-data-fixture.mjs', 'utf8')
    expect(fixture).toContain("from 'node:sqlite'")
    expect(fixture).toContain("from '@lancedb/lancedb'")
    expect(fixture).toContain("from 'apache-arrow'")
    expect(fixture).toContain("const ASSET_INVENTORY_RELATIVE_PATH = '.vela/upgrade-data-inventory.json'")
    expect(fixture).toContain("const EMBEDDING_DIMENSION = 768")
    expect(fixture).toContain("const PROMPT_TEMPLATE_RELATIVE_PATH = '.vela/prompts/chapter-style.md'")
    expect(fixture).toContain('CREATE TABLE project_core')
    expect(fixture).toContain('CREATE TABLE characters')
    expect(fixture).toContain('CREATE TABLE blueprints')
    expect(fixture).toContain('CREATE TABLE contents')
    expect(fixture).toContain('CREATE TABLE drafts')
    expect(fixture).toContain('CREATE TABLE revisions')
    expect(fixture).toContain('CREATE TABLE reviews')
    expect(fixture).toContain('CREATE TABLE post_process_runs')
    expect(fixture).toContain('CREATE TABLE post_process_steps')
    expect(fixture).toContain('CREATE TABLE llm_calls')
    expect(fixture).toContain('CREATE TABLE summary_snapshots')
    expect(fixture).toContain('cs_updated_at_chapter')
    expect(fixture).toContain("status: 'finalized'")
    expect(fixture).toContain("join(resolve(projectRoot), '.vela', 'vela.db')")

    const releaseGate = readFileSync('scripts/release-win-verify.mjs', 'utf8')
    const cloudWorkflow = readFileSync('.github/workflows/windows-cloud-build-test.yml', 'utf8')
    expect(releaseGate).toContain("'smoke:win-v025-upgrade'")
    expect(cloudWorkflow).toContain('pnpm run build:win')
  })

  it('records every physical upgrade asset and proves a non-2048 embedding space remains queryable', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-novel-upgrade-inventory-'))
    const settingsPath = join(projectRoot, 'isolated-user-settings.json')
    try {
      writeUpgradeFixtureSettings(settingsPath)
      const before = runUpgradeFixtureWithNode('seed', projectRoot, settingsPath)

      expect(before).toMatchObject({
        assetInventoryPath: '.vela/upgrade-data-inventory.json',
        assetCount: expect.any(Number),
        embeddingSpace: {
          vectorDimension: 768,
          activeGeneration: expect.any(Number),
          queryResultCount: 1,
        },
      })
      expect(before.assetCount).toBeGreaterThanOrEqual(6)
      expect(before.assetInventory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          byteSize: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          path: '.vela/vela.db',
          semanticTags: expect.arrayContaining([
            'architecture',
            'blueprints',
            'characters',
            'worldbuilding',
            'drafts',
            'body',
          ]),
        }),
        expect.objectContaining({ path: '.vela/project.json', semanticTags: ['project-manifest'] }),
        expect.objectContaining({ path: '.vela/prompts/chapter-style.md', semanticTags: ['prompt-template'] }),
        expect.objectContaining({ path: '第7章 失真的航标.txt', semanticTags: ['finalized-manuscript'] }),
        expect.objectContaining({ path: '.vela/embedding-spaces.json', semanticTags: ['embedding-registry'] }),
        expect.objectContaining({ location: 'settings', semanticTags: ['user-settings'] }),
      ]))

      const vector = Array.from({ length: 768 }, (_, index) => index / 768)
      const identity = {
        modelFingerprint: 'upgrade-fixture/non-2048-768',
        distanceMetric: 'l2',
      }
      await expect(getEmbeddingSpaces(projectRoot)).resolves.toMatchObject({
        activeGeneration: 1,
        spaces: [expect.objectContaining({
          ...identity,
          vectorDimension: 768,
          tableName: 'chunks__space_1',
          status: 'active',
        })],
      })
      await expect(search(projectRoot, '升级夹具知识库', vector, 5, identity)).resolves.toEqual([
        expect.objectContaining({
          fileName: '升级知识库.txt',
          text: '升级夹具知识库：轨道港航标失真记录必须保留并可检索。',
        }),
      ])
      closeConnection(projectRoot)

      const after = runUpgradeFixtureWithNode('validate', projectRoot, settingsPath)
      expect(after).toMatchObject({
        assetInventoryPath: '.vela/upgrade-data-inventory.json',
        assetCount: before.assetCount,
        preservedAssetCount: before.assetCount,
        embeddingSpace: before.embeddingSpace,
      })
      expect(after.assetInventory).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '.vela/vela.db', semanticVerified: true }),
        expect.objectContaining({ path: '.vela/project.json', hashMatched: true }),
        expect.objectContaining({ path: '.vela/prompts/chapter-style.md', hashMatched: true }),
        expect.objectContaining({ path: '第7章 失真的航标.txt', hashMatched: true }),
        expect.objectContaining({ path: '.vela/embedding-spaces.json', semanticVerified: true }),
      ]))
    } finally {
      closeConnection(projectRoot)
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects deliberate loss or corruption in every upgrade asset category and keeps its diagnostic inventory', () => {
    const cases: Array<{
      name: string
      mutate(projectRoot: string, settingsPath: string): void
      error: string
    }> = [
      {
        name: 'SQLite database carrying architecture, blueprints, characters, drafts, and bodies',
        mutate: (projectRoot) => rmSync(join(projectRoot, '.vela', 'vela.db')),
        error: 'Upgrade fixture database is missing',
      },
      {
        name: 'project manifest',
        mutate: (projectRoot) => writeFileSync(join(projectRoot, '.vela', 'project.json'), '{}\n', 'utf8'),
        error: 'Upgrade asset content changed: .vela/project.json',
      },
      {
        name: 'custom prompt template',
        mutate: (projectRoot) => writeFileSync(join(projectRoot, '.vela', 'prompts', 'chapter-style.md'), 'changed\n', 'utf8'),
        error: 'Upgrade asset content changed: .vela/prompts/chapter-style.md',
      },
      {
        name: 'finalized manuscript projection',
        mutate: (projectRoot) => rmSync(join(projectRoot, '第7章 失真的航标.txt')),
        error: 'Preserved upgrade asset 第7章 失真的航标.txt is missing',
      },
      {
        name: 'embedding-space registry',
        mutate: (projectRoot) => writeFileSync(join(projectRoot, '.vela', 'embedding-spaces.json'), '{}\n', 'utf8'),
        error: 'Embedding-space registry version changed during upgrade',
      },
      {
        name: 'LanceDB full-text and vector tables',
        mutate: (projectRoot) => rmSync(join(projectRoot, '.vela', 'lancedb'), { recursive: true, force: true }),
        error: 'Knowledge-base canonical chunks table is missing during upgrade',
      },
      {
        name: 'user settings',
        mutate: (_projectRoot, settingsPath) => writeFileSync(settingsPath, JSON.stringify({
          theme: 'dark',
          locale: 'zh-CN',
          proxy: { enabled: false, type: 'http', host: '', port: 7890 },
        }), 'utf8'),
        error: 'Upgrade settings semantic content changed',
      },
    ]

    for (const testCase of cases) {
      const projectRoot = mkdtempSync(join(tmpdir(), 'ai-novel-upgrade-asset-loss-'))
      const settingsPath = join(projectRoot, 'isolated-user-settings.json')
      try {
        writeUpgradeFixtureSettings(settingsPath)
        runUpgradeFixtureWithNode('seed', projectRoot, settingsPath)
        testCase.mutate(projectRoot, settingsPath)

        const rejected = validateUpgradeFixtureWithNode(projectRoot, settingsPath)
        expect(rejected.status, testCase.name).not.toBe(0)
        expect(rejected.stderr, testCase.name).toContain(testCase.error)
        expect(readFileSync(join(projectRoot, '.vela', 'upgrade-data-inventory.json'), 'utf8'), testCase.name)
          .toContain('"assets"')
      } finally {
        rmSync(projectRoot, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it('accepts only semantic-preserving database and settings migrations when their recorded baselines still hold', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-novel-upgrade-semantic-migration-'))
    const settingsPath = join(projectRoot, 'isolated-user-settings.json')
    try {
      writeUpgradeFixtureSettings(settingsPath)
      runUpgradeFixtureWithNode('seed', projectRoot, settingsPath)
      execFileSync(
        process.execPath,
        [
          '-e',
          "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.AI_NOVEL_FIXTURE_DB);db.exec('ALTER TABLE project_core ADD COLUMN migration_marker TEXT');db.close()",
        ],
        { env: { ...process.env, AI_NOVEL_FIXTURE_DB: join(projectRoot, '.vela', 'vela.db') } },
      )
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'light',
        locale: 'zh-CN',
        proxy: { enabled: false, type: 'http', host: '', port: 7890 },
        updatePreferences: { lastCheckedAt: '2026-01-02T03:12:05.000Z' },
      }), 'utf8')

      const validated = runUpgradeFixtureWithNode('validate', projectRoot, settingsPath)
      const assets = validated.assetInventory as Array<Record<string, unknown>>
      expect(assets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: '.vela/vela.db',
          hashMatched: false,
          semanticVerified: true,
        }),
        expect.objectContaining({
          location: 'settings',
          hashMatched: false,
          semanticVerified: true,
        }),
      ]))
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('exposes a release smoke gate that requires an explicit official v0.2.5 installer', () => {
    const script = readFileSync('scripts/smoke-win-v025-upgrade.ps1', 'utf8')
    const packageJson = readFileSync('package.json', 'utf8')

    expect(script).toContain('AI_NOVEL_PREVIOUS_INSTALLER')
    expect(script).toContain('AI_NOVEL_PREVIOUS_PORTABLE_ZIP')
    expect(script).toContain('AE9C88997A7DF3A48A8BEECCB0AB624BF947358CBBF702C19E70EC8460B9DFE7')
    expect(script).toContain('22B38B7337A456882BF130CCB898F17616FFFB85D6C8B8B3D0EE431409F18531')
    expect(script).toContain('Get-Sha256')
    expect(script).toContain('RequireCompleteV025Fixture = $true')
    expect(script).toContain('SHA256]::Create')
    expect(script).toContain('smoke-win-installer.ps1')
    expect(packageJson).toContain('smoke:win-v025-upgrade')
  })

  windowsIt('detects only new error windows, including system-owned dialogs outside the app process tree', () => {
    const output = runProbeLibrary(`
$baseline = @(
  [pscustomobject]@{ WindowHandle = '0x1'; ProcessId = 101; ProcessName = 'WerFault'; Title = 'Old Application Error' }
)
$current = @(
  $baseline[0],
  [pscustomobject]@{ WindowHandle = '0x2'; ProcessId = 202; ProcessName = 'explorer'; Title = 'Documents' },
  [pscustomobject]@{ WindowHandle = '0x3'; ProcessId = 303; ProcessName = 'WerFault'; Title = 'AI小说作家.exe - 应用程序错误' },
  [pscustomobject]@{ WindowHandle = '0x4'; ProcessId = 404; ProcessName = 'WerFault'; Title = 'AI小说作家.exe - System Error' },
  [pscustomobject]@{ WindowHandle = '0x5'; ProcessId = 505; ProcessName = 'AI小说作家'; Title = 'unknown software exception (0x80000003)' },
  [pscustomobject]@{ WindowHandle = '0x6'; ProcessId = 606; ProcessName = 'WerFault'; ParentProcessId = 0; CommandLine = 'WerFault.exe -p 707 -s 1'; Title = 'System Error' },
  [pscustomobject]@{ WindowHandle = '0x7'; ProcessId = 808; ProcessName = 'WerFault'; ParentProcessId = 0; CommandLine = 'WerFault.exe -p 909 -s 1'; Title = 'OtherTool.exe - Application Error' },
  [pscustomobject]@{ WindowHandle = '0x8'; ProcessId = 505; ProcessName = 'AI小说作家'; ClassName = 'Chrome_WidgetWin_1'; Visible = $true; Title = 'A JavaScript error occurred in the main process' },
  [pscustomobject]@{ WindowHandle = '0x9'; ProcessId = 505; ProcessName = 'AI小说作家'; ClassName = '#32770'; Visible = $true; Title = 'Unexpected condition' },
  [pscustomobject]@{ WindowHandle = '0xA'; ProcessId = 909; ProcessName = 'OtherTool'; ClassName = '#32770'; Visible = $true; Title = 'Unexpected condition' },
  [pscustomobject]@{ WindowHandle = '0xB'; ProcessId = 505; ProcessName = 'AI小说作家'; ClassName = '#32770'; Visible = $false; Title = 'Unexpected condition' },
  [pscustomobject]@{ WindowHandle = '0xC'; ProcessId = 505; ProcessName = 'AI小说作家'; ClassName = 'Chrome_WidgetWin_1'; Visible = $true; Title = 'Unexpected condition' },
  [pscustomobject]@{ WindowHandle = '0xD'; ProcessId = 505; ProcessName = 'AI小说作家'; ClassName = '#32770'; Visible = $true; Title = '' },
  [pscustomobject]@{ WindowHandle = '0xE'; ProcessId = 909; ProcessName = 'OtherTool'; ClassName = '#32770'; Visible = $true; Title = '' }
)
$identities = New-AiNovelWindowIdentitySet -Windows $baseline
$targetProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$targetProcessIds.Add(505)
[void]$targetProcessIds.Add(707)
$matches = @(Get-AiNovelNewErrorWindows -BaselineIdentities $identities -CurrentWindows $current -TargetProcessIds $targetProcessIds -TargetNames @('AI小说作家.exe', 'ai-novel-writer'))
[pscustomobject]@{
  Count = $matches.Count
  Processes = @($matches | ForEach-Object ProcessName)
  Titles = @($matches | ForEach-Object Title)
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.Count).toBe(7)
    expect(result.Processes).toEqual(['WerFault', 'WerFault', 'AI小说作家', 'WerFault', 'AI小说作家', 'AI小说作家', 'AI小说作家'])
    expect(result.Titles).toEqual([
      'AI小说作家.exe - 应用程序错误',
      'AI小说作家.exe - System Error',
      'unknown software exception (0x80000003)',
      'System Error',
      'A JavaScript error occurred in the main process',
      'Unexpected condition',
      '',
    ])
  })

  windowsIt('accepts only visible top-level windows owned by the launched application tree', () => {
    const output = runProbeLibrary(`
$appProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$appProcessIds.Add(505)
$hiddenTarget = [pscustomobject]@{ ProcessId = 505; Visible = $false }
$visibleOther = [pscustomobject]@{ ProcessId = 909; Visible = $true }
$visibleTarget = [pscustomobject]@{ ProcessId = 505; Visible = $true }
[pscustomobject]@{
  HiddenTargetAccepted = Test-AiNovelVisibleTargetWindow -Window $hiddenTarget -TargetProcessIds $appProcessIds
  VisibleOtherAccepted = Test-AiNovelVisibleTargetWindow -Window $visibleOther -TargetProcessIds $appProcessIds
  VisibleTargetAccepted = Test-AiNovelVisibleTargetWindow -Window $visibleTarget -TargetProcessIds $appProcessIds
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      HiddenTargetAccepted: false,
      VisibleOtherAccepted: false,
      VisibleTargetAccepted: true,
    })
  })

  it('keeps forceful process cleanup out of the successful application smoke path', () => {
    const appSmoke = readFileSync(probeScript, 'utf8')
    const outerCatch = appSmoke.search(/\r?\ncatch \{\r?\n {2}Save-AiNovelSmokeFailureEvidence/)
    const outerTry = appSmoke.lastIndexOf('try {', outerCatch)
    const outerFinally = appSmoke.indexOf('finally {', outerCatch)

    expect(outerTry).toBeGreaterThanOrEqual(0)
    expect(outerCatch).toBeGreaterThan(outerTry)
    expect(outerFinally).toBeGreaterThan(outerCatch)
    expect(appSmoke.slice(outerTry, outerCatch)).toContain('Close-AiNovelProcessTreeGracefully')
    expect(appSmoke.slice(outerTry, outerCatch)).not.toContain('Stop-AiNovelProcessTree')
    const finallyBlock = appSmoke.slice(outerFinally)
    expect(finallyBlock).toContain('if ($process) {')
    expect(finallyBlock).not.toContain('$process.HasExited')
    expect(finallyBlock).toContain('Stop-AiNovelProcessTree')
  })

  windowsIt('cleans a live tracked child after the root process has already exited', () => {
    const output = runProbeLibrary(`
$parentProcess = $null
$childProcess = $null
try {
  $parentProcess = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250; exit 0') -PassThru
  $parentStartTimeTicks = $parentProcess.StartTime.ToUniversalTime().Ticks
  $childProcess = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -PassThru
  $childStartTimeTicks = $childProcess.StartTime.ToUniversalTime().Ticks
  [void]$parentProcess.WaitForExit(5000)
  $parentProcess.Refresh()

  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($parentProcess.Id)
  [void]$processIds.Add($childProcess.Id)
  $startTimeTicks = @{
    ([string]$parentProcess.Id) = $parentStartTimeTicks
    ([string]$childProcess.Id) = $childStartTimeTicks
  }
  $parentExitedBeforeCleanup = $parentProcess.HasExited
  Stop-AiNovelProcessTree -Process $parentProcess -ProcessIds $processIds -StartTimeTicks $startTimeTicks
  [void]$childProcess.WaitForExit(5000)
  $childProcess.Refresh()

  [pscustomobject]@{
    ParentExitedBeforeCleanup = $parentExitedBeforeCleanup
    ChildExitedAfterCleanup = $childProcess.HasExited
  } | ConvertTo-Json -Compress
} finally {
  foreach ($candidate in @($parentProcess, $childProcess)) {
    if ($null -eq $candidate) { continue }
    try {
      $candidate.Refresh()
      if (-not $candidate.HasExited) {
        Stop-Process -Id $candidate.Id -Force -ErrorAction SilentlyContinue
        [void]$candidate.WaitForExit(5000)
      }
    } finally {
      $candidate.Dispose()
    }
  }
}
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      ParentExitedBeforeCleanup: true,
      ChildExitedAfterCleanup: true,
    })
  }, 15_000)

  windowsIt('closes a real WinForms process through the default CloseMainWindow path', () => {
    const result = runWinFormsGracefulCloseProbe(false, 5)

    expect(result).toEqual({
      Failure: '',
      Exited: true,
      ExitCode: 0,
    })
  }, 15_000)

  windowsIt('fails closed before invoking providers when a tracked start time no longer matches', () => {
    const output = runProbeLibrary(`
$processIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$processIds.Add($PID)
$startTimeTicks = @{ ([string]$PID) = 0 }
$windows = @([pscustomobject]@{
  ProcessId = $PID
  Visible = $true
  ClassName = 'Chrome_WidgetWin_1'
  Title = 'AI Novel Writer graceful-close test'
})
$providerCalls = 0
$closeCalls = 0
$failure = ''
try {
  $parameters = @{
    Windows = $windows
    ProcessIds = $processIds
    StartTimeTicks = $startTimeTicks
    ProcessProvider = { param($processId) $script:providerCalls += 1; [System.Diagnostics.Process]::GetProcessById($processId) }
    CloseMainWindowProvider = { param($process) $script:closeCalls += 1; $true }
  }
  Request-AiNovelGracefulMainWindowClose @parameters
} catch {
  $failure = $_.Exception.Message
}
[pscustomobject]@{
  ProviderCalls = $providerCalls
  CloseCalls = $closeCalls
  Failure = $failure
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.ProviderCalls).toBe(0)
    expect(result.CloseCalls).toBe(0)
    expect(result.Failure).toContain('current tracked process')
  })

  windowsIt('fails when a graceful close is accepted but the current process tree does not exit', () => {
    const result = runWinFormsGracefulCloseProbe(true, 1)

    expect(result.Failure).toContain('Application process tree did not terminate')
    expect(result.Exited).toBe(false)
  }, 15_000)

  windowsIt('accepts only the visible, titled Chromium product main window', () => {
    const output = runProbeLibrary(`
$appProcessIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$appProcessIds.Add(505)
$windows = @(
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = 'Chrome_WidgetWin_0'; Title = 'AI小说作家 — AI Novel Writer' },
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = 'Electron_SystemPreferencesHostWindow'; Title = 'AI小说作家 — AI Novel Writer' },
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = 'Chrome_WidgetWin_1'; Title = '' },
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = '#32770'; Title = 'AI小说作家 — AI Novel Writer' },
  [pscustomobject]@{ ProcessId = 909; Visible = $true; ClassName = 'Chrome_WidgetWin_1'; Title = 'AI小说作家 — AI Novel Writer' },
  [pscustomobject]@{ ProcessId = 505; Visible = $false; ClassName = 'Chrome_WidgetWin_1'; Title = 'AI小说作家 — AI Novel Writer' },
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = 'Chrome_WidgetWin_1'; Title = 'Unrelated Electron Window' },
  [pscustomobject]@{ ProcessId = 505; Visible = $true; ClassName = 'Chrome_WidgetWin_1'; Title = 'AI小说作家 — AI Novel Writer' }
)
$results = @($windows | ForEach-Object {
  Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $appProcessIds
})
[pscustomobject]@{ Results = $results } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.Results).toEqual([false, false, false, false, false, false, false, true])
  })

  windowsIt('detects new global error windows when both target collections are empty', () => {
    const output = runProbeLibrary(String.raw`
$baseline = [System.Collections.Generic.HashSet[string]]::new()
$processIds = [System.Collections.Generic.HashSet[int]]::new()
$windows = @(
  [pscustomobject]@{
    WindowHandle = '0x11'
    ProcessId = 501
    ProcessName = 'WerFault'
    Title = 'AI小说作家.exe - 应用程序错误'
    ClassName = '#32770'
    Visible = $true
  },
  [pscustomobject]@{
    WindowHandle = '0x12'
    ProcessId = 502
    ProcessName = 'notepad'
    Title = 'ordinary window'
    ClassName = 'Notepad'
    Visible = $true
  }
)
$matches = @(Get-AiNovelNewErrorWindows -BaselineIdentities $baseline -CurrentWindows $windows -TargetProcessIds $processIds -TargetNames @())
[pscustomobject]@{
  Count = $matches.Count
  ProcessName = $matches[0].ProcessName
  Title = $matches[0].Title
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output) as {
      Count: number
      ProcessName: string
      Title: string
    }
    expect(result).toEqual({
      Count: 1,
      ProcessName: 'WerFault',
      Title: 'AI小说作家.exe - 应用程序错误',
    })
  })

  windowsIt('rejects pre-existing product and WerFault error dialogs without rejecting unrelated windows', () => {
    const output = runProbeLibrary(`
$windows = @(
  [pscustomobject]@{ WindowHandle = '0x21'; ProcessId = 601; ProcessName = 'WerFault'; Title = 'System Error'; ClassName = '#32770'; Visible = $true },
  [pscustomobject]@{ WindowHandle = '0x22'; ProcessId = 602; ProcessName = 'AI小说作家'; Title = 'unknown software exception'; ClassName = '#32770'; Visible = $true },
  [pscustomobject]@{ WindowHandle = '0x23'; ProcessId = 603; ProcessName = 'notepad'; Title = 'Notes'; ClassName = 'Notepad'; Visible = $true }
)
$matches = @(Get-AiNovelStartupBlockingErrorWindows -CurrentWindows $windows -ProductNames @('AI小说作家.exe', 'AI小说作家'))
[pscustomobject]@{ Handles = @($matches | ForEach-Object WindowHandle) } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)
    expect(result.Handles).toEqual(['0x21', '0x22'])
  })

  windowsIt('allows a brief main-window polling gap but rejects a lasting disappearance', () => {
    const output = runProbeLibrary(`
$state = New-AiNovelMainWindowContinuityState
$start = [DateTime]'2026-01-01T00:00:00Z'
Assert-AiNovelMainWindowContinuity -State $state -Visible $true -NowUtc $start
Assert-AiNovelMainWindowContinuity -State $state -Visible $false -NowUtc $start.AddMilliseconds(100)
Assert-AiNovelMainWindowContinuity -State $state -Visible $false -NowUtc $start.AddMilliseconds(999)
$briefGapAccepted = $true
Assert-AiNovelMainWindowContinuity -State $state -Visible $true -NowUtc $start.AddMilliseconds(1000)
Assert-AiNovelMainWindowContinuity -State $state -Visible $false -NowUtc $start.AddMilliseconds(1100)
$failure = ''
try {
  Assert-AiNovelMainWindowContinuity -State $state -Visible $false -NowUtc $start.AddMilliseconds(2100)
} catch {
  $failure = $_.Exception.Message
}
[pscustomobject]@{
  BriefGapAccepted = $briefGapAccepted
  LastingGapFailure = $failure
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.BriefGapAccepted).toBe(true)
    expect(result.LastingGapFailure).toContain('main window disappeared')
  })

  windowsIt('waits for a continuous five-second quiet period and takes a final snapshot after the process tree exits', () => {
    const output = runInstallerLibrary(`
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Invoke-AiNovelMonitoredExecutable -Path $installer -Arguments @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 100') -Operation 'Synthetic installer'
$watch.Stop()
[pscustomobject]@{ ElapsedMilliseconds = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.ElapsedMilliseconds).toEqual(expect.any(Number))
    expect(result.ElapsedMilliseconds as number).toBeGreaterThanOrEqual(4900)
    expect(result.ElapsedMilliseconds as number).toBeLessThan(20_000)
  }, 25_000)

  windowsIt('does not treat a reused process ID as the process originally tracked by the release gate', () => {
    const output = runReleaseMonitorLibrary(`
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($PID)
$startTimes = @{}
$startTimes[$PID] = 0
$sameIdentity = Add-AiNovelTrackedProcess -ProcessId $PID -ProcessIds $ids -ProcessStartTimeTicks $startTimes
$alive = @(Get-AiNovelAliveProcessIds -ProcessIds $ids -ProcessStartTimeTicks $startTimes)
[pscustomobject]@{
  SameIdentity = $sameIdentity
  AliveCount = $alive.Count
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.SameIdentity).toBe(false)
    expect(result.AliveCount).toBe(0)
  })

  windowsIt('does not treat a reused process ID as an application smoke target', () => {
    const output = runProbeLibrary(`
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($PID)
$startTimes = @{ ([string]$PID) = 0 }
$alive = Get-AiNovelLiveTrackedProcessIds -ProcessIds $ids -StartTimeTicks $startTimes
[pscustomobject]@{ AliveCount = $alive.Count } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)
    expect(result.AliveCount).toBe(0)
  })

  windowsIt('attributes a delayed generic WerFault dialog to an exited tracked process identity', () => {
    const output = runProbeLibrary(`
$historicalPid = 2147483000
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($historicalPid)
$startTimes = @{}
# The outer release monitor stores integer keys while app smoke stores strings.
$startTimes[$historicalPid] = [DateTime]::UtcNow.Ticks
$baseline = [System.Collections.Generic.HashSet[string]]::new()
$window = [pscustomobject]@{
  WindowHandle = '0x123'
  ProcessId = 999
  ProcessName = 'WerFault'
  ParentProcessId = 0
  CommandLine = "WerFault.exe -p $historicalPid -s 123"
  Title = 'unknown software exception (0x80000003)'
  ClassName = '#32770'
  Visible = $true
}
$matches = @(Get-AiNovelNewErrorWindows -BaselineIdentities $baseline -CurrentWindows @($window) -TargetProcessIds $ids -TargetProcessStartTimeTicks $startTimes -TargetNames @('AI小说作家.exe'))
[pscustomobject]@{ MatchCount = $matches.Count } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)
    expect(result.MatchCount).toBe(1)
  })

  windowsIt('does not follow a stale parent PID into a process that predates the current parent instance', () => {
    const output = runProbeLibrary(`
$rootStart = [DateTime]::UtcNow.Ticks
function Get-CimInstance {
  param($ClassName, [string]$Filter, $ErrorAction)
  if ($Filter -eq 'ParentProcessId = 777') {
    return @(
      [pscustomobject]@{
        ProcessId = 778
        CreationDate = [DateTime]::new($rootStart - 10000, [DateTimeKind]::Utc)
      },
      [pscustomobject]@{
        ProcessId = 779
        CreationDate = [DateTime]::new($rootStart + 10000, [DateTimeKind]::Utc)
      }
    )
  }
  return @()
}
$identityProvider = {
  param([int]$ProcessId)
  if ($ProcessId -eq 777) { return $rootStart }
  if ($ProcessId -eq 779) { return $rootStart + 10000 }
  return $null
}
$tree = @(Get-AiNovelProcessTreeIds -RootProcessId 777 -RootStartTimeTicks $rootStart -ProcessStartTimeProvider $identityProvider)
[pscustomobject]@{
  ContainsRoot = $tree -contains 777
  ContainsOlderStaleChild = $tree -contains 778
  ContainsNewerRealChild = $tree -contains 779
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.ContainsRoot).toBe(true)
    expect(result.ContainsOlderStaleChild).toBe(false)
    expect(result.ContainsNewerRealChild).toBe(true)
  })

  windowsIt('does not expand or track descendants after a queued parent PID is reused', () => {
    const output = runProbeLibrary(`
$rootStart = [DateTime]::UtcNow.Ticks
$childStart = $rootStart + 10000
function Get-CimInstance {
  param($ClassName, [string]$Filter, $ErrorAction)
  if ($Filter -eq 'ParentProcessId = 777') {
    return @([pscustomobject]@{
      ProcessId = 778
      CreationDate = [DateTime]::new($childStart, [DateTimeKind]::Utc)
    })
  }
  if ($Filter -eq 'ParentProcessId = 778') {
    return @([pscustomobject]@{
      ProcessId = 779
      CreationDate = [DateTime]::new($childStart + 10000, [DateTimeKind]::Utc)
    })
  }
  return @()
}
$identityProvider = {
  param([int]$ProcessId)
  if ($ProcessId -eq 777) { return $rootStart }
  if ($ProcessId -eq 778) { return $childStart + 50000 }
  return $null
}
$discovered = @{}
$tree = @(Get-AiNovelProcessTreeIds -RootProcessId 777 -RootStartTimeTicks $rootStart -ProcessStartTimeProvider $identityProvider -DiscoveredStartTimeTicks $discovered)
$tracked = [System.Collections.Generic.HashSet[int]]::new()
$trackedStarts = @{}
$addReused = Add-AiNovelTrackedProcess -ProcessIds $tracked -StartTimeTicks $trackedStarts -ProcessId $PID -ExpectedStartTimeTicks 1
[pscustomobject]@{
  ContainsReusedParent = $tree -contains 778
  ContainsReplacementChild = $tree -contains 779
  AcceptedMismatchedIdentity = $addReused
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      ContainsReusedParent: true,
      ContainsReplacementChild: false,
      AcceptedMismatchedIdentity: false,
    })
  })

  windowsIt('waits at least five seconds after the application process tree is terminated', () => {
    const output = runProbeLibrary(`
$baseline = [System.Collections.Generic.HashSet[string]]::new()
$processIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$processIds.Add(424242)
$lastSnapshot = @()
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Wait-AiNovelPostExitQuietPeriod -BaselineIdentities $baseline -TargetProcessIds $processIds -TargetNames @('AI小说作家.exe') -QuietSeconds 5 -SnapshotProvider { @() } -LastWindowSnapshot ([ref]$lastSnapshot)
$watch.Stop()
[pscustomobject]@{ ElapsedMilliseconds = $watch.ElapsedMilliseconds; FinalSnapshotCount = $lastSnapshot.Count } | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.ElapsedMilliseconds).toEqual(expect.any(Number))
    expect(result.ElapsedMilliseconds as number).toBeGreaterThanOrEqual(4900)
    expect(result.ElapsedMilliseconds as number).toBeLessThan(8_000)
    expect(result.FinalSnapshotCount).toBe(0)
  }, 10_000)

  windowsIt('rejects a delayed product error dialog during the application post-exit period', () => {
    const output = runProbeLibrary(`
$baseline = [System.Collections.Generic.HashSet[string]]::new()
$processIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$processIds.Add(707)
$lastSnapshot = @()
$script:snapshotCallCount = 0
$failure = ''
try {
  Wait-AiNovelPostExitQuietPeriod -BaselineIdentities $baseline -TargetProcessIds $processIds -TargetNames @('AI小说作家.exe') -QuietSeconds 5 -SnapshotProvider {
    $script:snapshotCallCount += 1
    if ($script:snapshotCallCount -ge 2) {
      [pscustomobject]@{ WindowHandle = '0xBAD'; ProcessId = 606; ProcessName = 'WerFault'; Title = 'AI小说作家.exe - 应用程序错误' }
    }
  } -LastWindowSnapshot ([ref]$lastSnapshot)
} catch {
  $failure = $_.Exception.Message
}
[pscustomobject]@{
  Failure = $failure
  FinalTitle = $lastSnapshot[0].Title
  SnapshotCalls = $script:snapshotCallCount
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.Failure).toContain('after exit')
    expect(result.FinalTitle).toBe('AI小说作家.exe - 应用程序错误')
    expect(result.SnapshotCalls).toBe(2)
  })

  windowsIt('seeds with ordinary Node and validates with Electron using the real v0.2.5 SQLite format', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ai-novel-v025-sqlite-fixture-'))
    try {
      const seeded = runUpgradeFixtureWithNode('seed', fixtureRoot)
      const validated = runUpgradeFixture('validate', fixtureRoot)

      expect(seeded.databasePath).toBe(join(fixtureRoot, '.vela', 'vela.db'))
      expect(seeded.projectName).toBe('升级保留验证小说')
      expect(seeded.characterCount).toBe(2)
      expect(seeded.currentStateCount).toBe(2)
      expect(seeded.blueprintCount).toBe(1)
      expect(seeded.legacyTableCount).toBe(11)
      expect(seeded.contentCount).toBe(4)
      expect(seeded.draftCount).toBe(2)
      expect(seeded.finalizedDraftCount).toBe(1)
      expect(seeded.reviewCount).toBe(1)
      expect(seeded.revisionCount).toBe(1)
      expect(seeded.postProcessRunCount).toBe(1)
      expect(seeded.postProcessStepCount).toBe(2)
      expect(seeded.llmCallCount).toBe(2)
      expect(seeded.failedLlmCallCount).toBe(1)
      expect(seeded.summarySnapshotCount).toBe(2)
      expect(validated).toMatchObject({
        mode: 'validate',
        legacyTableCount: 11,
        projectName: '升级保留验证小说',
        characterCount: 2,
        currentStateCount: 2,
        blueprintCount: 1,
        contentCount: 4,
        draftCount: 2,
        finalizedDraftCount: 1,
        reviewCount: 1,
        revisionCount: 1,
        postProcessRunCount: 1,
        postProcessStepCount: 2,
        llmCallCount: 2,
        failedLlmCallCount: 1,
        summarySnapshotCount: 2,
      })

      execFileSync(
        electronNodeRunner,
        ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.AI_NOVEL_FIXTURE_DB);db.prepare(\"UPDATE characters SET cs_location='changed' WHERE name='林舟'\").run();db.close()"],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_NO_WARNINGS: '1',
            AI_NOVEL_FIXTURE_DB: join(fixtureRoot, '.vela', 'vela.db'),
          },
        },
      )
      const rejected = spawnSync(
        electronNodeRunner,
        [upgradeFixtureScript, 'validate', fixtureRoot],
        {
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
        },
      )
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('characters fields or current state changed')

      execFileSync(
        electronNodeRunner,
        ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.AI_NOVEL_FIXTURE_DB);db.prepare(\"UPDATE characters SET cs_location='轨道港' WHERE name='林舟'\").run();db.prepare(\"UPDATE contents SET body='changed' WHERE id=701\").run();db.close()"],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_NO_WARNINGS: '1',
            AI_NOVEL_FIXTURE_DB: join(fixtureRoot, '.vela', 'vela.db'),
          },
        },
      )
      const contentRejected = spawnSync(
        electronNodeRunner,
        [upgradeFixtureScript, 'validate', fixtureRoot],
        {
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
        },
      )
      expect(contentRejected.status).not.toBe(0)
      expect(contentRejected.stderr).toContain('content bodies changed during upgrade')
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  windowsIt('rejects corruption in every extended v0.2.5 upgrade table', () => {
    const cases = [
      {
        sql: "UPDATE revisions SET user_prompt='changed' WHERE id=91",
        message: 'revision records changed during upgrade',
      },
      {
        sql: 'UPDATE reviews SET review_index=2 WHERE id=81',
        message: 'review records changed during upgrade',
      },
      {
        sql: "UPDATE post_process_runs SET source_label='changed'",
        message: 'post-process run records changed during upgrade',
      },
      {
        sql: "UPDATE post_process_steps SET error_msg='changed' WHERE id=102",
        message: 'post-process step records changed during upgrade',
      },
      {
        sql: "UPDATE llm_calls SET error_message='changed' WHERE id=112",
        message: 'LLM call history changed during upgrade',
      },
      {
        sql: "UPDATE summary_snapshots SET character_states='changed' WHERE id=122",
        message: 'summary snapshots changed during upgrade',
      },
    ]

    for (const testCase of cases) {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'ai-novel-v025-table-check-'))
      try {
        runUpgradeFixtureWithNode('seed', fixtureRoot)
        execFileSync(
          process.execPath,
          [
            '-e',
            `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.AI_NOVEL_FIXTURE_DB);db.exec(process.env.AI_NOVEL_MUTATION);db.close()`,
          ],
          {
            env: {
              ...process.env,
              AI_NOVEL_FIXTURE_DB: join(fixtureRoot, '.vela', 'vela.db'),
              AI_NOVEL_MUTATION: testCase.sql,
            },
          },
        )
        const rejected = spawnSync(
          process.execPath,
          [upgradeFixtureScript, 'validate', fixtureRoot],
          { encoding: 'utf8' },
        )
        expect(rejected.status).not.toBe(0)
        expect(rejected.stderr).toContain(testCase.message)
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    }
  }, 30_000)

  windowsIt('runs the SQLite seeder and validator through the project Electron runtime', () => {
    const output = runInstallerLibrary(`
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-v025-wrapper-test-' + [guid]::NewGuid().ToString('N'))
$before = $env:ELECTRON_RUN_AS_NODE
try {
  New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
  $settingsPath = Join-Path $fixtureRoot 'isolated-settings.json'
  @{ theme = 'light'; locale = 'zh-CN'; proxy = @{ enabled = $false; type = 'http'; host = ''; port = 7890 } } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $settingsPath -Encoding utf8
  $seeded = Invoke-AiNovelUpgradeDataFixture -Mode seed -ProjectRoot $fixtureRoot -SettingsPath $settingsPath
  $validated = Invoke-AiNovelUpgradeDataFixture -Mode validate -ProjectRoot $fixtureRoot -SettingsPath $settingsPath
  [pscustomobject]@{
    SeededCharacters = $seeded.characterCount
      ValidatedCharacters = $validated.characterCount
      CurrentStates = $validated.currentStateCount
      LegacyTables = $validated.legacyTableCount
      Revisions = $validated.revisionCount
      Reviews = $validated.reviewCount
      PostProcessSteps = $validated.postProcessStepCount
       LlmCalls = $validated.llmCallCount
       SummarySnapshots = $validated.summarySnapshotCount
       AssetCount = $validated.assetCount
       PreservedAssets = $validated.preservedAssetCount
       EmbeddingDimension = $validated.embeddingSpace.vectorDimension
       EmbeddingQueryCount = $validated.embeddingSpace.queryResultCount
       SettingsAssetCount = @($validated.assetInventory | Where-Object { $_.location -eq 'settings' }).Count
       EnvironmentRestored = $env:ELECTRON_RUN_AS_NODE -eq $before
    DatabaseExists = Test-Path -LiteralPath (Join-Path $fixtureRoot '.vela\\vela.db') -PathType Leaf
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      SeededCharacters: 2,
      ValidatedCharacters: 2,
      CurrentStates: 2,
      LegacyTables: 11,
      Revisions: 1,
      Reviews: 1,
      PostProcessSteps: 2,
      LlmCalls: 2,
      SummarySnapshots: 2,
      AssetCount: expect.any(Number),
      PreservedAssets: expect.any(Number),
      EmbeddingDimension: 768,
      EmbeddingQueryCount: 1,
      SettingsAssetCount: 1,
      EnvironmentRestored: true,
      DatabaseExists: true,
    })
    expect(result.AssetCount).toBe(result.PreservedAssets)
    expect(Number(result.AssetCount)).toBeGreaterThanOrEqual(7)
  }, 15_000)

  windowsIt('persists structured failure evidence and removes diagnostics only after success', () => {
    const output = runProbeLibrary(`
$diagnostics = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-probe-test-' + [guid]::NewGuid().ToString('N'))
$windows = @(
  [pscustomobject]@{ WindowHandle = '0xCAFE'; ProcessId = 99; ProcessName = 'WerFault'; Title = 'Application Error' }
)
Save-AiNovelSmokeFailureEvidence -Path $diagnostics -Failure 'simulated failure' -Windows $windows -ObservedProcessIds @(7, 8)
$snapshot = Get-Content -LiteralPath (Join-Path $diagnostics 'window-snapshot.json') -Raw | ConvertFrom-Json
$failureWritten = Test-Path -LiteralPath (Join-Path $diagnostics 'failure.txt')
Complete-AiNovelSmokeDiagnostics -Path $diagnostics -Succeeded $false
$keptAfterFailure = Test-Path -LiteralPath $diagnostics
Complete-AiNovelSmokeDiagnostics -Path $diagnostics -Succeeded $true
[pscustomobject]@{
  FailureWritten = $failureWritten
  SnapshotProcess = $snapshot.ProcessName
  SnapshotTitle = $snapshot.Title
  KeptAfterFailure = $keptAfterFailure
  RemovedAfterSuccess = -not (Test-Path -LiteralPath $diagnostics)
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      FailureWritten: true,
      SnapshotProcess: 'WerFault',
      SnapshotTitle: 'Application Error',
      KeptAfterFailure: true,
      RemovedAfterSuccess: true,
    })
  })
})
