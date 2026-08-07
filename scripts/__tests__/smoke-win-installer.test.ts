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

  it('runs the installed package against an isolated Vela home to prove the anime asset and custom skin persistence', () => {
    const installer = readFileSync(installerScript, 'utf8')

    expect(installer).toContain('Invoke-AiNovelPackagedSkinSmoke')
    expect(installer).toContain("$env:AI_NOVEL_RELEASE_SKIN_SMOKE = '1'")
    expect(installer).toContain('AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN')
    expect(installer).toContain('AI_NOVEL_VELA_HOME')
    expect(installer).toContain('--ai-novel-release-skin-smoke=')
    expect(installer).toContain('packaged-skin-smoke.json')
    expect(installer).toContain("$result.kind -eq 'packaged-skin-smoke'")
    expect(installer).toContain("$result.builtInAnime.asset -eq 'skins/anime-night.webp'")
    expect(installer).toContain('$result.customSkin.importSucceeded -eq $true')
    expect(installer).toContain('$result.customSkin.readSucceeded -eq $true')
    expect(installer).toContain('$result.customSkin.stateRestored -eq $true')
  })
})

describe('Windows PowerShell smoke script encoding', () => {
  it('uses a UTF-8 BOM for scripts directly executed by Windows PowerShell', () => {
    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])

    for (const script of [probeScript, installerScript, releaseMonitorScript]) {
      expect(readFileSync(script).subarray(0, utf8Bom.length)).toEqual(utf8Bom)
    }
  })

  it('decodes packaged Electron JSON evidence from explicit UTF-8 bytes and preserves failed raw evidence', () => {
    const installer = readFileSync(installerScript, 'utf8')

    expect(installer).toContain('function Get-AiNovelUtf8NonEmptyLines')
    expect(installer).toContain('[System.IO.File]::ReadAllBytes($Path)')
    expect(installer).toContain('[System.Text.UTF8Encoding]::new($false, $true)')
    expect(installer).toContain("$result.failedOpenExternal.rendererError.zhCN -eq '无法打开官方主页，请稍后重试。'")
    expect(installer).toContain('if ($evidenceSucceeded)')
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
    expect(script).toContain('-RequireSuccessfulTerminalRefresh')
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
    expect(appSmoke).toContain('Application root exited during smoke test after terminal lineage refresh')
    expect(appSmoke).toContain('Could not complete terminal process lineage refresh')
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
    expect(releaseMonitor).toContain('Assert-AiNovelGateProcessExitSucceeded')
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

  windowsIt('finalizes redirected output before accepting a zero exit code', () => {
    const output = runInstallerLibrary(`
$probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-exit-finalization-test-' + [guid]::NewGuid().ToString('N'))
$stdoutPath = Join-Path $probeRoot 'stdout.txt'
$stderrPath = Join-Path $probeRoot 'stderr.txt'
$failure = ''
$stdout = ''
$stderr = ''
$previousStdoutValue = $env:AI_NOVEL_EXIT_FINALIZATION_STDOUT
$previousStderrValue = $env:AI_NOVEL_EXIT_FINALIZATION_STDERR
try {
  New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
  $env:AI_NOVEL_EXIT_FINALIZATION_STDOUT = 'stdout-finalized'
  $env:AI_NOVEL_EXIT_FINALIZATION_STDERR = 'stderr-finalized'
  try {
    $parameters = @{
      Path = $installer
      Arguments = @('-NoProfile', '-Command', '[Console]::Out.WriteLine($env:AI_NOVEL_EXIT_FINALIZATION_STDOUT); [Console]::Error.WriteLine($env:AI_NOVEL_EXIT_FINALIZATION_STDERR); exit 0')
      Operation = 'Synthetic redirected zero-exit process'
      StandardOutputPath = $stdoutPath
      StandardErrorPath = $stderrPath
      HideWindow = $true
    }
    Invoke-AiNovelMonitoredExecutable @parameters
  } catch {
    $failure = $_.Exception.Message
  }
  if (Test-Path -LiteralPath $stdoutPath) { $stdout = Get-Content -LiteralPath $stdoutPath -Raw }
  if (Test-Path -LiteralPath $stderrPath) { $stderr = Get-Content -LiteralPath $stderrPath -Raw }
} finally {
  $env:AI_NOVEL_EXIT_FINALIZATION_STDOUT = $previousStdoutValue
  $env:AI_NOVEL_EXIT_FINALIZATION_STDERR = $previousStderrValue
  Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
[pscustomobject]@{
  Failure = $failure
  Stdout = [Convert]::ToString($stdout).Trim()
  Stderr = [Convert]::ToString($stderr).Trim()
  CleanupSucceeded = -not (Test-Path -LiteralPath $probeRoot)
  EnvironmentRestored = $env:AI_NOVEL_EXIT_FINALIZATION_STDOUT -eq $previousStdoutValue -and $env:AI_NOVEL_EXIT_FINALIZATION_STDERR -eq $previousStderrValue
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      Failure: '',
      Stdout: 'stdout-finalized',
      Stderr: 'stderr-finalized',
      CleanupSucceeded: true,
      EnvironmentRestored: true,
    })
  }, 25_000)

  windowsIt('decodes Electron UTF-8 JSON evidence exactly in Windows PowerShell 5.1 with and without a BOM', () => {
    const output = runInstallerLibrary(`
$probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-utf8-evidence-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
  $payload = '{"failedOpenExternal":{"rendererError":{"zhCN":"无法打开官方主页，请稍后重试。","enUS":"Unable to open the official homepage. Please try again later."}}}'
  $withoutBom = Join-Path $probeRoot 'electron-no-bom.jsonl'
  $withBom = Join-Path $probeRoot 'electron-with-bom.jsonl'
  [System.IO.File]::WriteAllText($withoutBom, $payload, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($withBom, $payload, [System.Text.UTF8Encoding]::new($true))
  $withoutBomEvidence = (Get-AiNovelUtf8NonEmptyLines -Path $withoutBom | Select-Object -Last 1 | ConvertFrom-Json)
  $withBomEvidence = (Get-AiNovelUtf8NonEmptyLines -Path $withBom | Select-Object -Last 1 | ConvertFrom-Json)
  [pscustomobject]@{
    PowerShellMajor = $PSVersionTable.PSVersion.Major
    NoBomZhCN = $withoutBomEvidence.failedOpenExternal.rendererError.zhCN
    WithBomZhCN = $withBomEvidence.failedOpenExternal.rendererError.zhCN
    NoBomEnUS = $withoutBomEvidence.failedOpenExternal.rendererError.enUS
    WithBomEnUS = $withBomEvidence.failedOpenExternal.rendererError.enUS
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
`)
    const result = parseLastJsonLine(output)

    expect(result.PowerShellMajor).toBeGreaterThanOrEqual(5)
    expect(result.NoBomZhCN).toBe('无法打开官方主页，请稍后重试。')
    expect(result.WithBomZhCN).toBe('无法打开官方主页，请稍后重试。')
    expect(result.NoBomEnUS).toBe('Unable to open the official homepage. Please try again later.')
    expect(result.WithBomEnUS).toBe('Unable to open the official homepage. Please try again later.')
  })

  windowsIt('fails the release gate for every nonzero or abnormal job-contained descendant exit', () => {
    const output = runReleaseMonitorLibrary(`
function Get-GateExitFailure {
  param($Event)
  try {
    Assert-AiNovelGateProcessExitSucceeded -Step 'synthetic-step' -Event $Event
    return ''
  } catch {
    return $_.Exception.Message
  }
}
$success = Get-GateExitFailure ([pscustomobject]@{ ProcessId = 701; ExitCode = 0; ExitCodeCaptured = $true; JobMessage = 7 })
$nonzero = Get-GateExitFailure ([pscustomobject]@{ ProcessId = 702; ExitCode = 19; ExitCodeCaptured = $true; JobMessage = 7 })
$abnormal = Get-GateExitFailure ([pscustomobject]@{ ProcessId = 703; ExitCode = 0; ExitCodeCaptured = $true; JobMessage = 8 })
$uncaptured = Get-GateExitFailure ([pscustomobject]@{ ProcessId = 704; ExitCode = $null; ExitCodeCaptured = $false; JobMessage = 7 })
[pscustomobject]@{
  Success = $success
  Nonzero = $nonzero
  Abnormal = $abnormal
  Uncaptured = $uncaptured
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.Success).toBe('')
    expect(result.Nonzero).toContain('nonzero exit code 19')
    expect(result.Abnormal).toContain('abnormal exit')
    expect(result.Uncaptured).toContain('could not capture the exit code')
  })

  windowsIt('admits only one exact historical updater handoff into the legacy bridge', () => {
    const output = runReleaseMonitorLibrary(`
$installRoot = 'C:\\e2e\\installed app'
$oldExe = $installRoot + '\\AI' + [char]0x5C0F + [char]0x8BF4 + [char]0x4F5C + [char]0x5BB6 + '.exe'
$pendingExe = 'C:\\Users\\runneradmin\\AppData\\Local\\ai-novel-writer-updater\\pending\\ai-novel-writer-setup-0.7.0.exe'
$old = [pscustomobject]@{
  processId = 410
  startTimeTicks = '638900000000000410'
  executablePath = $oldExe
  identityCaptured = $true
  commandLineCaptured = $true
}
$bridge = [pscustomobject]@{
  State = 'armed'
  OldApplicationIdentity = $old
  ExpectedPendingInstallerPath = $pendingExe
  ExpectedInstallerName = 'ai-novel-writer-setup-0.7.0.exe'
  InstallRoot = $installRoot
  ObservedInstallerIdentity = $null
  AllowedWizardWindowKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
}
function New-LegacyInstallerIdentity {
  param([string]$CommandLine = ('"' + $pendingExe + '" --updated'))
  return [pscustomobject]@{
    processId = 411
    startTimeTicks = '638900000000000411'
    executablePath = $pendingExe
    commandLine = $CommandLine
    identityCaptured = $true
    commandLineCaptured = $true
    parentProcessId = 410
    parentProcessStartTimeTicks = '638900000000000410'
    parentExecutablePath = $oldExe
  }
}
$installer = New-LegacyInstallerIdentity
$exact = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity $installer -ParentIdentity $old
$equivalentWhitespace = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '"' + [char]9 + '--updated  ')) -ParentIdentity $old
$explicitDirectory = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated "/D=' + $installRoot + '"')) -ParentIdentity $old
$silent = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated /S "/D=' + $installRoot + '"')) -ParentIdentity $old
$wrongDirectory = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated /D=C:\\e2e\\other')) -ParentIdentity $old
$directoryFirst = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" "/D=' + $installRoot + '" --updated')) -ParentIdentity $old
$duplicateDirectory = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated "/D=' + $installRoot + '" "/D=' + $installRoot + '"')) -ParentIdentity $old
$duplicateUpdated = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated --updated')) -ParentIdentity $old
$forceRun = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated --force-run')) -ParentIdentity $old
$packageFile = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated --package-file=C:\\temp\\package.7z')) -ParentIdentity $old
$extraArgument = Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity (New-LegacyInstallerIdentity -CommandLine ('"' + $pendingExe + '" --updated unexpected')) -ParentIdentity $old
$wrongParent = [pscustomobject]@{ processId = 410; startTimeTicks = '638900000000000409'; executablePath = $oldExe; identityCaptured = $true }
$wrongParentRejected = -not (Test-AiNovelGateLegacyBridgeInstaller -Step 'windows-in-app-update-e2e' -LegacyBridge $bridge -InstallerIdentity $installer -ParentIdentity $wrongParent)
$wrongStepRejected = -not (Test-AiNovelGateLegacyBridgeInstaller -Step 'other-step' -LegacyBridge $bridge -InstallerIdentity $installer -ParentIdentity $old)
$bridge.ObservedInstallerIdentity = $installer
$bridge.State = 'terminated'
$wizard = [pscustomobject]@{
  WindowHandle = '0x1'
  ProcessId = 411
  Title = ('AI' + [char]0x5C0F + [char]0x8BF4 + [char]0x4F5C + [char]0x5BB6 + ' Setup ')
  ClassName = '#32770'
  Visible = $true
}
[void]$bridge.AllowedWizardWindowKeys.Add((Get-AiNovelGateLegacyBridgeWindowKey -Window $wizard))
$wizardAccepted = Test-AiNovelGateLegacyBridgeWizardWindow -LegacyBridge $bridge -Window $wizard
$wizard.Title = 'Other Setup '
$wrongTitleRejected = -not (Test-AiNovelGateLegacyBridgeWizardWindow -LegacyBridge $bridge -Window $wizard)
[pscustomobject]@{
  HistoricalSource = Test-AiNovelGateLegacyBridgeSourceTag -SourceTag 'v0.6.0'
  NativeSourceRejected = -not (Test-AiNovelGateLegacyBridgeSourceTag -SourceTag 'v0.7.0')
  ExactInstaller = $exact
  EquivalentWhitespace = $equivalentWhitespace
  ExplicitDirectory = $explicitDirectory
  SilentArgumentsRejected = -not $silent
  WrongDirectoryRejected = -not $wrongDirectory
  DirectoryFirstRejected = -not $directoryFirst
  DuplicateDirectoryRejected = -not $duplicateDirectory
  DuplicateUpdatedRejected = -not $duplicateUpdated
  ForceRunRejected = -not $forceRun
  PackageFileRejected = -not $packageFile
  ExtraArgumentRejected = -not $extraArgument
  WrongParentRejected = $wrongParentRejected
  WrongStepRejected = $wrongStepRejected
  WizardAccepted = $wizardAccepted
  WrongTitleRejected = $wrongTitleRejected
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      HistoricalSource: true,
      NativeSourceRejected: true,
      ExactInstaller: true,
      EquivalentWhitespace: true,
      ExplicitDirectory: true,
      SilentArgumentsRejected: true,
      WrongDirectoryRejected: true,
      DirectoryFirstRejected: true,
      DuplicateDirectoryRejected: true,
      DuplicateUpdatedRejected: true,
      ForceRunRejected: true,
      PackageFileRejected: true,
      ExtraArgumentRejected: true,
      WrongParentRejected: true,
      WrongStepRejected: true,
      WizardAccepted: true,
      WrongTitleRejected: true,
    })
  })

  it('persists captured process-start identity before evaluating the legacy bridge handoff', () => {
    const releaseMonitor = readFileSync(releaseMonitorScript, 'utf8')
    const identityEvidence = releaseMonitor.indexOf("-ExitClassification 'identity-captured'")
    const legacyBridgeDecision = releaseMonitor.indexOf('if (Test-AiNovelGateLegacyBridgeInstaller `')

    expect(identityEvidence).toBeGreaterThan(-1)
    expect(legacyBridgeDecision).toBeGreaterThan(identityEvidence)
    expect(releaseMonitor).toContain('if (-not $processEventEvidenceWritten) {')
  })

  windowsIt('arms the legacy bridge only after the monitor captures the exact old application identity', () => {
    const output = runReleaseMonitorLibrary(`
$oldExe = 'C:\\e2e\\installed-app\\AI' + [char]0x5C0F + [char]0x8BF4 + [char]0x4F5C + [char]0x5BB6 + '.exe'
$request = [pscustomobject]@{
  step = 'windows-in-app-update-e2e'
  sourceTag = 'v0.5.2'
  processId = 410
  processStartTimeTicks = '638900000000000410'
  executablePath = $oldExe
  installRoot = 'C:\\e2e\\installed-app'
}
function New-BridgeArmFixture {
  return [pscustomobject]@{
    State = 'pre-armed'
    SourceTag = 'v0.5.2'
    PendingOldApplicationIdentity = $null
    OldApplicationIdentity = $null
    InstallRoot = $null
  }
}
$bridge = New-BridgeArmFixture
$captured = [pscustomobject]@{
  processId = 410
  startTimeTicks = '638900000000000410'
  executablePath = $oldExe
  identityCaptured = $true
}
$tracked = [System.Collections.Generic.Dictionary[int,object]]::new()
Request-AiNovelGateLegacyBridgeArm -LegacyBridge $bridge -Control $request -ActiveStep 'windows-in-app-update-e2e'
$waitingWithoutCapture = (
  $bridge.State -eq 'arm-requested' -and
  -not (Complete-AiNovelGateLegacyBridgeArm -LegacyBridge $bridge -TrackedProcessIdentities $tracked)
)
$tracked[410] = $captured
$armedAfterCapture = Complete-AiNovelGateLegacyBridgeArm -LegacyBridge $bridge -TrackedProcessIdentities $tracked
$exactIdentityRetained = Test-AiNovelGateExactIdentity -Identity $bridge.OldApplicationIdentity -ProcessId 410 -StartTimeTicks '638900000000000410' -ExecutablePath $oldExe

$mismatchBridge = New-BridgeArmFixture
$mismatchTracked = [System.Collections.Generic.Dictionary[int,object]]::new()
$mismatchTracked[410] = [pscustomobject]@{
  processId = 410
  startTimeTicks = '638900000000000409'
  executablePath = $oldExe
  identityCaptured = $true
}
Request-AiNovelGateLegacyBridgeArm -LegacyBridge $mismatchBridge -Control $request -ActiveStep 'windows-in-app-update-e2e'
$mismatchRejected = $false
try {
  [void](Complete-AiNovelGateLegacyBridgeArm -LegacyBridge $mismatchBridge -TrackedProcessIdentities $mismatchTracked)
}
catch {
  $mismatchRejected = $_.Exception.Message -like '*without the captured old application identity*'
}
[pscustomobject]@{
  WaitingWithoutCapture = $waitingWithoutCapture
  ArmedAfterCapture = $armedAfterCapture
  ExactIdentityRetained = $exactIdentityRetained
  MismatchRejected = $mismatchRejected
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      WaitingWithoutCapture: true,
      ArmedAfterCapture: true,
      ExactIdentityRetained: true,
      MismatchRejected: true,
    })
  })

  windowsIt('reads Node-authored UTF-8 monitor control paths without corrupting non-ASCII characters', () => {
    const releaseMonitor = readFileSync(releaseMonitorScript, 'utf8')
    expect(releaseMonitor).toContain(
      '$lines = @(Get-Content -LiteralPath $ControlPath -Encoding UTF8 -ErrorAction Stop)',
    )
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-monitor-control-utf8-'))
    const controlPath = join(root, 'control.jsonl')
    const executablePath = join(root, 'installed-app', 'AI小说作家.exe')
    writeFileSync(controlPath, `${JSON.stringify({
      sequence: 1,
      state: 'legacy-bridge-arm',
      executablePath,
    })}\n`, 'utf8')

    try {
      const output = runReleaseMonitorLibrary(`
$ControlPath = ${quotePowerShell(controlPath)}
$control = Get-AiNovelGateControl
[pscustomobject]@{
  State = [string]$control.state
  ExecutablePath = [string]$control.executablePath
} | ConvertTo-Json -Compress
`)
      expect(parseLastJsonLine(output)).toEqual({
        State: 'legacy-bridge-arm',
        ExecutablePath: executablePath,
      })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  windowsIt('exempts only the known NSIS PowerShell probes during installer smoke steps', () => {
    const output = runReleaseMonitorLibrary(`
$system32 = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$sysWow64 = Join-Path $env:SystemRoot 'SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'
$event = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$parentPath = 'C:\\temp\\ai-novel-writer-setup-0.4.0.exe'
$parentStartTimeTicks = '638900000000000000'
$parent = [pscustomobject]@{
  processId = 700
  startTimeTicks = $parentStartTimeTicks
  identityCaptured = $true
  executablePath = $parentPath
}
$system32Prefix = '"' + $system32 + '" -C "'
$sysWow64Prefix = '"' + $sysWow64 + '" -C "'
$availabilityPayload = 'if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }'
$policyPayload = 'if ((Get-ExecutionPolicy -Scope Process) -eq ''Restricted'') { exit 1 } else { exit 0 }'
$runningProcessPayload = 'if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith(''C:\\temp\\installed'', ''CurrentCultureIgnoreCase'')}).Count -gt 0) { exit 0 } else { exit 1 }'
$availabilityCommand = $system32Prefix + $availabilityPayload + '"'
$unquotedAvailabilityCommand = $system32 + ' -C "' + $availabilityPayload + '"'
$policyCommand = $system32Prefix + $policyPayload + '"'
$runningProcessCommand = $sysWow64Prefix + $runningProcessPayload + '"'
$arbitraryCommand = $system32Prefix + 'Write-Error ''not an NSIS probe''; exit 1"'
$suffixedCommand = $availabilityCommand.Substring(0, $availabilityCommand.Length - 1) + '; Write-Error ''surplus action''"'
$alternateSwitchCommand = $availabilityCommand.Replace(' -C ', ' -Command ')
$lowercaseSwitchCommand = $availabilityCommand.Replace(' -C ', ' -c ')
$changedPayloadCaseCommand = $availabilityCommand.Replace('Get-CimInstance', 'get-ciminstance')
$pathCaseCommand = $availabilityCommand.Replace($system32, $system32.ToUpperInvariant())
$wrongArgvZeroCommand = $availabilityCommand.Replace('"' + $system32 + '"', '"C:\\temp\\totally-unrelated.exe"')
$extraWhitespaceCommand = $availabilityCommand.Replace(' -C ', '  -C ')

function New-ProbeIdentity {
  param(
    [string]$ImagePath,
    [string]$CommandLine,
    [bool]$IdentityCaptured = $true,
    [bool]$CommandLineCaptured = $true,
    [Nullable[int]]$ParentProcessId = 700,
    [AllowNull()][string]$ParentStartTimeTicks = $parentStartTimeTicks,
    [AllowNull()][string]$ParentExecutablePath = $parentPath
  )
  return [pscustomobject]@{
    processId = 701
    identityCaptured = $IdentityCaptured
    commandLineCaptured = $CommandLineCaptured
    parentProcessId = $ParentProcessId
    parentProcessStartTimeTicks = $ParentStartTimeTicks
    parentExecutablePath = $ParentExecutablePath
    executablePath = $ImagePath
    commandLine = $CommandLine
  }
}

function Test-SyntheticNsisProbe {
  param(
    [string]$Step,
    $Event,
    $Identity,
    $Parent
  )
  return Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step $Step -Event $Event -ProcessIdentity $Identity -ParentIdentity $Parent
}

$validAvailability = New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand
$validPolicy = New-ProbeIdentity -ImagePath $system32 -CommandLine $policyCommand
$validRunningProcess = New-ProbeIdentity -ImagePath $sysWow64 -CommandLine $runningProcessCommand
$wrongParent = [pscustomobject]@{ processId = 700; startTimeTicks = $parentStartTimeTicks; identityCaptured = $true; executablePath = 'C:\\temp\\unrelated.exe' }
$relativeParent = [pscustomobject]@{ processId = 700; startTimeTicks = $parentStartTimeTicks; identityCaptured = $true; executablePath = 'ai-novel-writer-setup-0.4.0.exe' }
$nonOne = [pscustomobject]@{ ProcessId = 701; ExitCode = 2; ExitCodeCaptured = $true; JobMessage = 7 }
$abnormal = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 8 }

[pscustomobject]@{
  InstallerAvailability = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity $validAvailability -Parent $parent
  UnquotedInstallerAvailability = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $unquotedAvailabilityCommand) -Parent $parent
  UpgradePolicy = Test-SyntheticNsisProbe -Step 'smoke:win-v025-upgrade' -Event $event -Identity $validPolicy -Parent $parent
  UpdateE2ERunningProcess = Test-SyntheticNsisProbe -Step 'windows-in-app-update-e2e' -Event $event -Identity $validRunningProcess -Parent $parent
  SysWow64RunningProcess = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity $validRunningProcess -Parent $parent
  PathCaseOnly = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $pathCaseCommand) -Parent $parent
  OtherStep = Test-SyntheticNsisProbe -Step 'other-step' -Event $event -Identity $validAvailability -Parent $parent
  ArbitraryPowerShell = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $arbitraryCommand) -Parent $parent
  SuffixedKnownCommand = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $suffixedCommand) -Parent $parent
  AlternateSwitch = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $alternateSwitchCommand) -Parent $parent
  LowercaseSwitch = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $lowercaseSwitchCommand) -Parent $parent
  ChangedPayloadCase = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $changedPayloadCaseCommand) -Parent $parent
  WrongArgvZero = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $wrongArgvZeroCommand) -Parent $parent
  ExtraWhitespace = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $extraWhitespaceCommand) -Parent $parent
  WrongParent = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity $validAvailability -Parent $wrongParent
  ReusedParentPid = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand -ParentStartTimeTicks '638899999999999999') -Parent $parent
  ParentPathMismatch = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand -ParentExecutablePath 'C:\\temp\\other\\ai-novel-writer-setup-0.4.0.exe') -Parent $parent
  RelativeInstallerParent = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand -ParentExecutablePath 'ai-novel-writer-setup-0.4.0.exe') -Parent $relativeParent
  NonOneExit = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $nonOne -Identity $validAvailability -Parent $parent
  AbnormalExit = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $abnormal -Identity $validAvailability -Parent $parent
  ProductProcess = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath 'C:\\temp\\AI小说作家.exe' -CommandLine $availabilityCommand) -Parent $parent
  RelativePowerShell = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath 'System32\\WindowsPowerShell\\v1.0\\powershell.exe' -CommandLine $availabilityCommand) -Parent $parent
  MissingIdentity = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand -IdentityCaptured $false) -Parent $parent
  MissingCommandLine = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine '' -CommandLineCaptured $false) -Parent $parent
  MissingParentMetadata = Test-SyntheticNsisProbe -Step 'smoke:win-installer' -Event $event -Identity (New-ProbeIdentity -ImagePath $system32 -CommandLine $availabilityCommand -ParentProcessId $null) -Parent $parent
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.InstallerAvailability).toBe(true)
    expect(result.UnquotedInstallerAvailability).toBe(true)
    expect(result.UpgradePolicy).toBe(true)
    expect(result.UpdateE2ERunningProcess).toBe(true)
    expect(result.SysWow64RunningProcess).toBe(true)
    expect(result.PathCaseOnly).toBe(true)
    expect(result.OtherStep).toBe(false)
    expect(result.ArbitraryPowerShell).toBe(false)
    expect(result.SuffixedKnownCommand).toBe(false)
    expect(result.AlternateSwitch).toBe(false)
    expect(result.LowercaseSwitch).toBe(false)
    expect(result.ChangedPayloadCase).toBe(false)
    expect(result.WrongArgvZero).toBe(false)
    expect(result.ExtraWhitespace).toBe(false)
    expect(result.WrongParent).toBe(false)
    expect(result.ReusedParentPid).toBe(false)
    expect(result.ParentPathMismatch).toBe(false)
    expect(result.RelativeInstallerParent).toBe(false)
    expect(result.NonOneExit).toBe(false)
    expect(result.AbnormalExit).toBe(false)
    expect(result.ProductProcess).toBe(false)
    expect(result.RelativePowerShell).toBe(false)
    expect(result.MissingIdentity).toBe(false)
    expect(result.MissingCommandLine).toBe(false)
    expect(result.MissingParentMetadata).toBe(false)
  })

  windowsIt('accepts only the NSIS System32 to SysWOW64 command-image redirect aliases', () => {
    const output = runReleaseMonitorLibrary(`
$system32PowerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$sysWow64PowerShell = Join-Path $env:SystemRoot 'SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'
$system32Cmd = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$sysWow64Cmd = Join-Path $env:SystemRoot 'SysWOW64\\cmd.exe'
$system32Find = Join-Path $env:SystemRoot 'System32\\find.exe'
$sysWow64Find = Join-Path $env:SystemRoot 'SysWOW64\\find.exe'
$system32Where = Join-Path $env:SystemRoot 'System32\\where.exe'
$sysWow64Where = Join-Path $env:SystemRoot 'SysWOW64\\where.exe'
$installerPath = 'C:\\temp\\ai-novel-writer-setup-0.4.0.exe'
$installer = [pscustomobject]@{
  processId = 700
  startTimeTicks = '638900000000000000'
  executablePath = $installerPath
  identityCaptured = $true
}
$event = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$availabilityCommand = '"' + $system32PowerShell + '" -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
$cmdCommand = '"' + $system32Cmd + '" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $system32Find + '" "AI小说作家.exe"'
$findCommand = '"' + $system32Find + '"  "AI小说作家.exe"'
$powerShell = [pscustomobject]@{
  processId = 701
  startTimeTicks = '638900000000000100'
  executablePath = $sysWow64PowerShell
  commandLine = $availabilityCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 700
  parentProcessStartTimeTicks = $installer.startTimeTicks
  parentExecutablePath = $installerPath
}
$cmd = [pscustomobject]@{
  processId = 702
  startTimeTicks = '638900000000000200'
  executablePath = $sysWow64Cmd
  commandLine = $cmdCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 700
  parentProcessStartTimeTicks = $installer.startTimeTicks
  parentExecutablePath = $installerPath
}
$find = [pscustomobject]@{
  processId = 703
  startTimeTicks = '638900000000000300'
  executablePath = $sysWow64Find
  commandLine = $findCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = $cmd.processId
  parentProcessStartTimeTicks = $cmd.startTimeTicks
  parentExecutablePath = $sysWow64Cmd
}
$verifiedFindParentKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$verifiedFindParentKeys.Add((Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd))
$wrongFileCommand = $availabilityCommand.Replace($system32PowerShell, $system32Cmd)
$wrongDirectoryCommand = $availabilityCommand.Replace($system32PowerShell, (Join-Path $env:SystemRoot 'SystemOther\\WindowsPowerShell\\v1.0\\powershell.exe'))
$sameBasenameElsewhereCommand = $availabilityCommand.Replace($system32PowerShell, 'C:\\temp\\powershell.exe')
$relativeArgvZeroCommand = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
[pscustomobject]@{
  System32PowerShellArgvZeroSysWow64Actual = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $powerShell -ParentIdentity $installer
  System32CmdArgvZeroSysWow64Actual = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  System32FindArgvZeroSysWow64Actual = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $installer
  WrongFileIsNotAlias = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity ([pscustomobject]@{ processId = 701; startTimeTicks = '638900000000000100'; executablePath = $sysWow64PowerShell; commandLine = $wrongFileCommand; commandLineCaptured = $true; identityCaptured = $true; parentProcessId = 700; parentProcessStartTimeTicks = $installer.startTimeTicks; parentExecutablePath = $installerPath }) -ParentIdentity $installer
  WrongDirectoryIsNotAlias = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity ([pscustomobject]@{ processId = 701; startTimeTicks = '638900000000000100'; executablePath = $sysWow64PowerShell; commandLine = $wrongDirectoryCommand; commandLineCaptured = $true; identityCaptured = $true; parentProcessId = 700; parentProcessStartTimeTicks = $installer.startTimeTicks; parentExecutablePath = $installerPath }) -ParentIdentity $installer
  SameBasenameElsewhereIsNotAlias = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity ([pscustomobject]@{ processId = 701; startTimeTicks = '638900000000000100'; executablePath = $sysWow64PowerShell; commandLine = $sameBasenameElsewhereCommand; commandLineCaptured = $true; identityCaptured = $true; parentProcessId = 700; parentProcessStartTimeTicks = $installer.startTimeTicks; parentExecutablePath = $installerPath }) -ParentIdentity $installer
  RelativeArgvZeroIsNotAlias = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity ([pscustomobject]@{ processId = 701; startTimeTicks = '638900000000000100'; executablePath = $sysWow64PowerShell; commandLine = $relativeArgvZeroCommand; commandLineCaptured = $true; identityCaptured = $true; parentProcessId = 700; parentProcessStartTimeTicks = $installer.startTimeTicks; parentExecutablePath = $installerPath }) -ParentIdentity $installer
  UnlistedSystemExecutableIsNotAlias = Test-AiNovelGateSameBoundSystemExecutablePath -Left $system32Where -Right $sysWow64Where
  ExactNonSystemPathStillBinds = (Get-AiNovelGateBoundCommandArguments -CommandLine '"C:\\temp\\custom.exe" --check' -ImagePath 'C:\\temp\\custom.exe') -eq ' --check'
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      System32PowerShellArgvZeroSysWow64Actual: true,
      System32CmdArgvZeroSysWow64Actual: true,
      System32FindArgvZeroSysWow64Actual: true,
      WrongFileIsNotAlias: false,
      WrongDirectoryIsNotAlias: false,
      SameBasenameElsewhereIsNotAlias: false,
      RelativeArgvZeroIsNotAlias: false,
      UnlistedSystemExecutableIsNotAlias: false,
      ExactNonSystemPathStillBinds: true,
    })
  })

  windowsIt('exempts only the exact NSIS cmd and find no-process fallback chain', () => {
    const output = runReleaseMonitorLibrary(`
$cmdPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$findPath = Join-Path $env:SystemRoot 'System32\\find.exe'
$installerPath = 'C:\\temp\\ai-novel-writer-setup-0.4.0.exe'
$installerStart = '638900000000000000'
$cmdStart = '638900000000000100'
$event = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$installer = [pscustomobject]@{
  processId = 700
  startTimeTicks = $installerStart
  executablePath = $installerPath
  identityCaptured = $true
}
$cmdArguments = ' /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $findPath + '" "AI小说作家.exe"'
$cmdCommand = '"' + $cmdPath + '"' + $cmdArguments
$unquotedCmdCommand = $cmdPath + $cmdArguments
$findCommand = '"' + $findPath + '"  "AI小说作家.exe"'

function New-CmdIdentity {
  param(
    [string]$CommandLine = $cmdCommand,
    [string]$ParentStart = $installerStart,
    [string]$ParentPath = $installerPath
  )
  return [pscustomobject]@{
    processId = 701
    startTimeTicks = $cmdStart
    processName = 'cmd'
    executablePath = $cmdPath
    commandLine = $CommandLine
    commandLineCaptured = $true
    identityCaptured = $true
    parentProcessId = 700
    parentProcessStartTimeTicks = $ParentStart
    parentExecutablePath = $ParentPath
  }
}

function New-FindIdentity {
  param(
    [string]$CommandLine = $findCommand,
    [string]$ParentStart = $cmdStart,
    [string]$ParentPath = $cmdPath
  )
  return [pscustomobject]@{
    processId = 702
    startTimeTicks = '638900000000000200'
    processName = 'find'
    executablePath = $findPath
    commandLine = $CommandLine
    commandLineCaptured = $true
    identityCaptured = $true
    parentProcessId = 701
    parentProcessStartTimeTicks = $ParentStart
    parentExecutablePath = $ParentPath
  }
}

$cmd = New-CmdIdentity
$find = New-FindIdentity
$exitTwo = [pscustomobject]@{ ProcessId = 701; ExitCode = 2; ExitCodeCaptured = $true; JobMessage = 7 }
$unrelatedInstaller = [pscustomobject]@{ processId = 700; startTimeTicks = $installerStart; executablePath = 'C:\\temp\\unrelated.exe'; identityCaptured = $true }
$unverifiedFindParentKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$verifiedFindParentKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$verifiedFindParentKeys.Add((Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd))
[pscustomobject]@{
  CmdSystemImage = Test-AiNovelGateSystemUtilityImage -ImagePath $cmdPath -FileName 'cmd.exe'
  CmdCommand = Test-AiNovelGateKnownNsisCmdProcessCheckCommand -CommandLine $cmdCommand -CmdImagePath $cmdPath
  CmdParent = Test-AiNovelGateCapturedInstallerParent -ChildIdentity $cmd -ParentIdentity $installer
  FindSystemImage = Test-AiNovelGateSystemUtilityImage -ImagePath $findPath -FileName 'find.exe'
  FindCommand = Test-AiNovelGateKnownNsisFindNoMatchCommand -CommandLine $findCommand -FindImagePath $findPath
  FindParent = Test-AiNovelGateCapturedParentIdentity -ChildIdentity $find -ParentIdentity $cmd
  CmdCandidate = Test-AiNovelGateNsisCmdProcessCheckCandidate -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer
  CmdWithoutFindEvent = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $unverifiedFindParentKeys
  CmdAfterVerifiedFind = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  CmdUnquoted = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-CmdIdentity -CommandLine $unquotedCmdCommand) -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  FindExact = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $installer
  CmdExtraCommand = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-CmdIdentity -CommandLine ($cmdCommand + ' & exit 1')) -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  CmdWrongProduct = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-CmdIdentity -CommandLine $cmdCommand.Replace('AI小说作家.exe', 'other.exe')) -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  CmdReusedParent = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-CmdIdentity -ParentStart '638899999999999999') -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  CmdWrongParent = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $unrelatedInstaller -VerifiedFindParentKeys $verifiedFindParentKeys
  FindExtraArgument = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-FindIdentity -CommandLine ($findCommand + ' extra')) -ParentIdentity $cmd -GrandParentIdentity $installer
  FindReusedCmdParent = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity (New-FindIdentity -ParentStart '638899999999999999') -ParentIdentity $cmd -GrandParentIdentity $installer
  FindWrongGrandParent = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $unrelatedInstaller
  OtherStep = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'other-step' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
  ExitTwo = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $exitTwo -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParentKeys
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toMatchObject({
      CmdSystemImage: true,
      CmdCommand: true,
      CmdParent: true,
      FindSystemImage: true,
      FindCommand: true,
      FindParent: true,
      CmdCandidate: true,
      CmdWithoutFindEvent: false,
      CmdAfterVerifiedFind: true,
      CmdUnquoted: true,
      FindExact: true,
      CmdExtraCommand: false,
      CmdWrongProduct: false,
      CmdReusedParent: false,
      CmdWrongParent: false,
      FindExtraArgument: false,
      FindReusedCmdParent: false,
      FindWrongGrandParent: false,
      OtherStep: false,
      ExitTwo: false,
    })
  })

  windowsIt('defers a NSIS cmd exit until the matching find no-match event is verified', () => {
    const output = runReleaseMonitorLibrary(`
$cmdPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$findPath = Join-Path $env:SystemRoot 'System32\\find.exe'
$installerPath = 'C:\\temp\\ai-novel-writer-setup-0.4.0.exe'
$installer = [pscustomobject]@{
  processId = 700
  startTimeTicks = '638900000000000000'
  executablePath = $installerPath
  identityCaptured = $true
}
$cmd = [pscustomobject]@{
  processId = 701
  startTimeTicks = '638900000000000100'
  executablePath = $cmdPath
  commandLine = '"' + $cmdPath + '" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $findPath + '" "AI小说作家.exe"'
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 700
  parentProcessStartTimeTicks = $installer.startTimeTicks
  parentExecutablePath = $installerPath
}
$find = [pscustomobject]@{
  processId = 702
  startTimeTicks = '638900000000000200'
  executablePath = $findPath
  commandLine = '"' + $findPath + '"  "AI小说作家.exe"'
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 701
  parentProcessStartTimeTicks = $cmd.startTimeTicks
  parentExecutablePath = $cmdPath
}
$event = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$verifiedFindParents = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$pendingCmdFailures = @{}
$cmdKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd
$cmdCandidate = Test-AiNovelGateNsisCmdProcessCheckCandidate -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer
$storedPending = if ($cmdCandidate) {
  Add-AiNovelGatePendingNsisCmdExitFailure -PendingNsisCmdExitFailures $pendingCmdFailures -ProcessIdentityKey $cmdKey -Failure (Get-AiNovelGateProcessExitFailure -Step 'smoke:win-installer' -Event $event)
} else { $false }
$beforeFind = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParents
$pendingBeforeFind = Get-AiNovelGatePendingNsisCmdExitFailure -PendingNsisCmdExitFailures $pendingCmdFailures
$noFindDeferredFailure = $pendingBeforeFind
$findVerified = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $installer
$resolvedPending = if ($findVerified) {
  Register-AiNovelGateVerifiedNsisFindParent -VerifiedFindParentKeys $verifiedFindParents -PendingNsisCmdExitFailures $pendingCmdFailures -ParentProcessIdentityKey (Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd)
} else { $false }
$afterFind = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $installer -VerifiedFindParentKeys $verifiedFindParents
$reusedPidCmd = [pscustomobject]@{
  processId = $cmd.processId
  startTimeTicks = '638900000000000999'
  executablePath = $cmdPath
  identityCaptured = $true
}
$unrelatedPending = @{}
[void](Add-AiNovelGatePendingNsisCmdExitFailure -PendingNsisCmdExitFailures $unrelatedPending -ProcessIdentityKey $cmdKey -Failure 'synthetic pending cmd failure')
$reusedPidResolved = Register-AiNovelGateVerifiedNsisFindParent -VerifiedFindParentKeys $verifiedFindParents -PendingNsisCmdExitFailures $unrelatedPending -ParentProcessIdentityKey (Get-AiNovelGateProcessIdentityKey -ProcessIdentity $reusedPidCmd)
[pscustomobject]@{
  CmdCandidate = $cmdCandidate
  StoredPending = $storedPending
  BeforeFind = $beforeFind
  PendingBeforeFind = -not [string]::IsNullOrWhiteSpace($pendingBeforeFind)
  NoFindDeferredFailure = $noFindDeferredFailure -like '*nonzero exit code 1*'
  FindVerified = $findVerified
  ResolvedPending = $resolvedPending
  AfterFind = $afterFind
  PendingCountAfterFind = $pendingCmdFailures.Count
  ReusedPidResolved = $reusedPidResolved
  ReusedPidPendingCount = $unrelatedPending.Count
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      CmdCandidate: true,
      StoredPending: true,
      BeforeFind: false,
      PendingBeforeFind: true,
      NoFindDeferredFailure: true,
      FindVerified: true,
      ResolvedPending: true,
      AfterFind: true,
      PendingCountAfterFind: 0,
      ReusedPidResolved: false,
      ReusedPidPendingCount: 1,
    })
  })

  windowsIt('keeps a promoted NSIS cmd failure reversible across the next Drain only for its matching find identity', () => {
    const output = runReleaseMonitorLibrary(`
$cmdPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$findPath = Join-Path $env:SystemRoot 'System32\\find.exe'
$installerPath = 'C:\\temp\\ai-novel-writer-setup-0.4.0.exe'
$installer = [pscustomobject]@{
  processId = 700
  startTimeTicks = '638900000000000000'
  executablePath = $installerPath
  identityCaptured = $true
}
$cmd = [pscustomobject]@{
  processId = 701
  startTimeTicks = '638900000000000100'
  executablePath = $cmdPath
  commandLine = '"' + $cmdPath + '" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $findPath + '" "AI小说作家.exe"'
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 700
  parentProcessStartTimeTicks = $installer.startTimeTicks
  parentExecutablePath = $installerPath
}
$find = [pscustomobject]@{
  processId = 702
  startTimeTicks = '638900000000000200'
  executablePath = $findPath
  commandLine = '"' + $findPath + '"  "AI小说作家.exe"'
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = 701
  parentProcessStartTimeTicks = $cmd.startTimeTicks
  parentExecutablePath = $cmdPath
}
$event = [pscustomobject]@{ ProcessId = 701; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$now = [DateTime]::Parse('2026-07-27T00:00:00.0000000Z').ToUniversalTime()
$cmdKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd
$verifiedFindParents = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$pending = @{}
[void](Add-AiNovelGatePendingNsisCmdExitFailure -PendingNsisCmdExitFailures $pending -ProcessIdentityKey $cmdKey -Failure (Get-AiNovelGateProcessExitFailure -Step 'smoke:win-installer' -Event $event))
$state = New-AiNovelGateDeferredNsisCmdExitFailureState

# Drain 41: cmd.exe exits, then JobObjectMsgActiveProcessZero arrives. The
# missing find.exe is now deferred, but it must not terminate this iteration.
$promotedOnJobEmpty = Promote-AiNovelGatePendingNsisCmdExitFailure -State $state -PendingEntry (Get-AiNovelGatePendingNsisCmdExitFailureEntry -PendingNsisCmdExitFailures $pending) -NowUtc $now -CurrentDrain 41
$firstDrainDoesNotTerminate = -not (Test-AiNovelGateDeferredNsisCmdExitFailureReady -State $state -NowUtc $now.AddSeconds(5) -CurrentDrain 41)

# Drain 42: the completion port delivers the matching find.exe exit. It must
# revoke the previously promoted cmd.exe failure rather than merely remove the
# pending-map entry.
$findVerified = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $installer
$registeredFind = if ($findVerified) {
  Register-AiNovelGateVerifiedNsisFindParent -VerifiedFindParentKeys $verifiedFindParents -PendingNsisCmdExitFailures $pending -ParentProcessIdentityKey $cmdKey
} else { $false }
$resolvedPromotedFailure = Resolve-AiNovelGateDeferredNsisCmdExitFailure -State $state -ProcessIdentityKey $cmdKey
$secondDrainAfterFindDoesNotTerminate = -not (Test-AiNovelGateDeferredNsisCmdExitFailureReady -State $state -NowUtc $now.AddSeconds(5) -CurrentDrain 42)

# A mismatched find identity may not clear the promoted failure; without a
# verified matching find after the short grace it remains fail-closed.
$noFindPending = @{}
[void](Add-AiNovelGatePendingNsisCmdExitFailure -PendingNsisCmdExitFailures $noFindPending -ProcessIdentityKey $cmdKey -Failure 'synthetic pending cmd failure')
$noFindState = New-AiNovelGateDeferredNsisCmdExitFailureState
$noFindPromoted = Promote-AiNovelGatePendingNsisCmdExitFailure -State $noFindState -PendingEntry (Get-AiNovelGatePendingNsisCmdExitFailureEntry -PendingNsisCmdExitFailures $noFindPending) -NowUtc $now -CurrentDrain 51
$wrongKeyDoesNotResolve = -not (Resolve-AiNovelGateDeferredNsisCmdExitFailure -State $noFindState -ProcessIdentityKey ($cmdKey + '-other'))
$noFindFirstDrainDoesNotTerminate = -not (Test-AiNovelGateDeferredNsisCmdExitFailureReady -State $noFindState -NowUtc $now.AddSeconds(5) -CurrentDrain 51)
$noFindGraceBlocksImmediateFailure = -not (Test-AiNovelGateDeferredNsisCmdExitFailureReady -State $noFindState -NowUtc $now.AddMilliseconds(100) -CurrentDrain 52)
$noFindFailsClosedAfterGrace = Test-AiNovelGateDeferredNsisCmdExitFailureReady -State $noFindState -NowUtc $now.AddSeconds(2) -CurrentDrain 52
[pscustomobject]@{
  PromotedOnJobEmpty = $promotedOnJobEmpty
  FirstDrainDoesNotTerminate = $firstDrainDoesNotTerminate
  FindVerified = $findVerified
  RegisteredFind = $registeredFind
  ResolvedPromotedFailure = $resolvedPromotedFailure
  PendingCountAfterFind = $pending.Count
  SecondDrainAfterFindDoesNotTerminate = $secondDrainAfterFindDoesNotTerminate
  NoFindPromoted = $noFindPromoted
  WrongKeyDoesNotResolve = $wrongKeyDoesNotResolve
  NoFindFirstDrainDoesNotTerminate = $noFindFirstDrainDoesNotTerminate
  NoFindGraceBlocksImmediateFailure = $noFindGraceBlocksImmediateFailure
  NoFindFailsClosedAfterGrace = $noFindFailsClosedAfterGrace
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      PromotedOnJobEmpty: true,
      FirstDrainDoesNotTerminate: true,
      FindVerified: true,
      RegisteredFind: true,
      ResolvedPromotedFailure: true,
      PendingCountAfterFind: 0,
      SecondDrainAfterFindDoesNotTerminate: true,
      NoFindPromoted: true,
      WrongKeyDoesNotResolve: true,
      NoFindFirstDrainDoesNotTerminate: true,
      NoFindGraceBlocksImmediateFailure: true,
      NoFindFailsClosedAfterGrace: true,
    })
  })

  windowsIt('accepts only the complete NSIS uninstaller helper chain for expected process-check exits', () => {
    const output = runReleaseMonitorLibrary(`
$powerShellPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$cmdPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$findPath = Join-Path $env:SystemRoot 'System32\\find.exe'
$tempRoot = [System.IO.Path]::GetTempPath()
$helperPath = Join-Path (Join-Path $tempRoot '~nsuA9.tmp') 'Un_A9.exe'
$nestedHelperPath = Join-Path (Join-Path (Join-Path $tempRoot '~nsuA9.tmp') 'nested') 'Un_A9.exe'
$wrongFileHelperPath = Join-Path (Join-Path $tempRoot '~nsuA9.tmp') 'Un_A9-.exe'
$uninstallerPath = 'C:\\temp\\installed-app\\Uninstall AI小说作家.exe'
$armedRootPath = 'C:\\tools\\node.exe'
$armedRoot = [pscustomobject]@{
  processId = 699
  startTimeTicks = '638899999999999900'
  executablePath = $armedRootPath
  identityCaptured = $true
}
$unrelatedArmedRoot = [pscustomobject]@{
  processId = 698
  startTimeTicks = '638899999999999800'
  executablePath = $armedRootPath
  identityCaptured = $true
}
$wrapperCmd = [pscustomobject]@{
  processId = 700
  startTimeTicks = '638900000000000000'
  executablePath = $cmdPath
  identityCaptured = $true
  parentProcessId = $armedRoot.processId
  parentProcessStartTimeTicks = $armedRoot.startTimeTicks
  parentExecutablePath = $armedRoot.executablePath
}
$wrapperPowerShell = [pscustomobject]@{
  processId = 701
  startTimeTicks = '638900000000000050'
  executablePath = $powerShellPath
  identityCaptured = $true
  parentProcessId = $wrapperCmd.processId
  parentProcessStartTimeTicks = $wrapperCmd.startTimeTicks
  parentExecutablePath = $wrapperCmd.executablePath
}
$uninstallerStart = '638900000000000100'
$uninstaller = [pscustomobject]@{
  processId = 702
  startTimeTicks = $uninstallerStart
  executablePath = $uninstallerPath
  identityCaptured = $true
  parentProcessId = $wrapperPowerShell.processId
  parentProcessStartTimeTicks = $wrapperPowerShell.startTimeTicks
  parentExecutablePath = $wrapperPowerShell.executablePath
}
$helper = [pscustomobject]@{
  processId = 703
  startTimeTicks = '638900000000000200'
  executablePath = $helperPath
  identityCaptured = $true
  parentProcessId = $uninstaller.processId
  parentProcessStartTimeTicks = $uninstallerStart
  parentExecutablePath = $uninstallerPath
}
$availabilityCommand = '"' + $powerShellPath + '" -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
$cmdCommand = '"' + $cmdPath + '" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $findPath + '" "AI小说作家.exe"'
$findCommand = '"' + $findPath + '"  "AI小说作家.exe"'
$powerShell = [pscustomobject]@{
  processId = 704
  startTimeTicks = '638900000000000300'
  executablePath = $powerShellPath
  commandLine = $availabilityCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = $helper.processId
  parentProcessStartTimeTicks = $helper.startTimeTicks
  parentExecutablePath = $helperPath
}
$cmd = [pscustomobject]@{
  processId = 705
  startTimeTicks = '638900000000000400'
  executablePath = $cmdPath
  commandLine = $cmdCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = $helper.processId
  parentProcessStartTimeTicks = $helper.startTimeTicks
  parentExecutablePath = $helperPath
}
$find = [pscustomobject]@{
  processId = 706
  startTimeTicks = '638900000000000500'
  executablePath = $findPath
  commandLine = $findCommand
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = $cmd.processId
  parentProcessStartTimeTicks = $cmd.startTimeTicks
  parentExecutablePath = $cmdPath
}
$trackedProcessIdentities = @{}
$trackedProcessIdentities[[int]$wrapperCmd.processId] = $wrapperCmd
$trackedProcessIdentities[[int]$wrapperPowerShell.processId] = $wrapperPowerShell
$event = [pscustomobject]@{ ProcessId = $powerShell.processId; ExitCode = 1; ExitCodeCaptured = $true; JobMessage = 7 }
$verifiedFindParentKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$verifiedFindParentKeys.Add((Get-AiNovelGateProcessIdentityKey -ProcessIdentity $cmd))
$wrongNamedUninstaller = [pscustomobject]@{
  processId = $uninstaller.processId
  startTimeTicks = $uninstaller.startTimeTicks
  executablePath = 'C:\\temp\\installed-app\\Uninstall other.exe'
  identityCaptured = $true
}
$wrongNamedHelper = [pscustomobject]@{
  processId = $helper.processId
  startTimeTicks = $helper.startTimeTicks
  executablePath = $helperPath
  identityCaptured = $true
  parentProcessId = $uninstaller.processId
  parentProcessStartTimeTicks = $uninstaller.startTimeTicks
  parentExecutablePath = $wrongNamedUninstaller.executablePath
}
$reusedUninstallerHelper = [pscustomobject]@{
  processId = $helper.processId
  startTimeTicks = $helper.startTimeTicks
  executablePath = $helperPath
  identityCaptured = $true
  parentProcessId = $uninstaller.processId
  parentProcessStartTimeTicks = '638899999999999999'
  parentExecutablePath = $uninstaller.executablePath
}
$reusedHelperPowerShell = [pscustomobject]@{
  processId = $powerShell.processId
  startTimeTicks = $powerShell.startTimeTicks
  executablePath = $powerShell.executablePath
  commandLine = $powerShell.commandLine
  commandLineCaptured = $true
  identityCaptured = $true
  parentProcessId = $helper.processId
  parentProcessStartTimeTicks = '638899999999999998'
  parentExecutablePath = $helper.executablePath
}
$missingWrapperTracked = @{}
$missingWrapperTracked[[int]$wrapperCmd.processId] = $wrapperCmd
$reusedWrapperCmd = [pscustomobject]@{
  processId = $wrapperCmd.processId
  startTimeTicks = '638899999999999998'
  executablePath = $wrapperCmd.executablePath
  identityCaptured = $true
  parentProcessId = $armedRoot.processId
  parentProcessStartTimeTicks = $armedRoot.startTimeTicks
  parentExecutablePath = $armedRoot.executablePath
}
$reusedWrapperTracked = @{}
$reusedWrapperTracked[[int]$wrapperCmd.processId] = $reusedWrapperCmd
$reusedWrapperTracked[[int]$wrapperPowerShell.processId] = $wrapperPowerShell
$cycleCmd = [pscustomobject]@{
  processId = $wrapperCmd.processId
  startTimeTicks = $wrapperCmd.startTimeTicks
  executablePath = $wrapperCmd.executablePath
  identityCaptured = $true
  parentProcessId = $wrapperPowerShell.processId
  parentProcessStartTimeTicks = $wrapperPowerShell.startTimeTicks
  parentExecutablePath = $wrapperPowerShell.executablePath
}
$cycleTracked = @{}
$cycleTracked[[int]$wrapperCmd.processId] = $cycleCmd
$cycleTracked[[int]$wrapperPowerShell.processId] = $wrapperPowerShell
[pscustomobject]@{
  HelperImage = Test-AiNovelGateNsisUninstallerHelperImage -ImagePath $helperPath
  UninstallerAncestry = Test-AiNovelGateIdentityAncestryToArmedRoot -StartIdentity $uninstaller -TrackedProcessIdentities $trackedProcessIdentities -ArmedRootIdentity $armedRoot
  HelperParent = Test-AiNovelGateCapturedNsisUninstallerHelperParent -HelperIdentity $helper -UninstallerIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  PowerShellChain = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $powerShell -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  CmdCandidateChain = Test-AiNovelGateNsisCmdProcessCheckCandidate -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  CmdVerifiedChain = Test-AiNovelGateExpectedNsisCmdProcessCheckExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $cmd -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities -VerifiedFindParentKeys $verifiedFindParentKeys
  FindFourLevelChain = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $helper -GreatGrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  SameNamedCompleteChainWrongArmedRoot = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $powerShell -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $unrelatedArmedRoot -TrackedProcessIdentities $trackedProcessIdentities
  MissingWrapperRecord = Test-AiNovelGateIdentityAncestryToArmedRoot -StartIdentity $uninstaller -TrackedProcessIdentities $missingWrapperTracked -ArmedRootIdentity $armedRoot
  ReusedWrapperPid = Test-AiNovelGateIdentityAncestryToArmedRoot -StartIdentity $uninstaller -TrackedProcessIdentities $reusedWrapperTracked -ArmedRootIdentity $armedRoot
  CycleFailsClosed = Test-AiNovelGateIdentityAncestryToArmedRoot -StartIdentity $uninstaller -TrackedProcessIdentities $cycleTracked -ArmedRootIdentity $armedRoot
  DepthFailsClosed = Test-AiNovelGateIdentityAncestryToArmedRoot -StartIdentity $uninstaller -TrackedProcessIdentities $trackedProcessIdentities -ArmedRootIdentity $armedRoot -MaxDepth 2
  OtherStep = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'other-step' -Event $event -ProcessIdentity $powerShell -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  OrphanHelper = Test-AiNovelGateCapturedNsisUninstallerHelperParent -HelperIdentity $helper -UninstallerIdentity $null -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  NestedHelperDirectory = Test-AiNovelGateNsisUninstallerHelperImage -ImagePath $nestedHelperPath
  WrongHelperFile = Test-AiNovelGateNsisUninstallerHelperImage -ImagePath $wrongFileHelperPath
  WrongUninstallerName = Test-AiNovelGateCapturedNsisUninstallerHelperParent -HelperIdentity $wrongNamedHelper -UninstallerIdentity $wrongNamedUninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  ReusedUninstallerPid = Test-AiNovelGateCapturedNsisUninstallerHelperParent -HelperIdentity $reusedUninstallerHelper -UninstallerIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  ReusedHelperPid = Test-AiNovelGateExpectedNsisPowerShellProbeExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $reusedHelperPowerShell -ParentIdentity $helper -GrandParentIdentity $uninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
  FindWrongGreatGrandParent = Test-AiNovelGateExpectedNsisFindNoMatchExit -Step 'smoke:win-installer' -Event $event -ProcessIdentity $find -ParentIdentity $cmd -GrandParentIdentity $helper -GreatGrandParentIdentity $wrongNamedUninstaller -ArmedRootIdentity $armedRoot -TrackedProcessIdentities $trackedProcessIdentities
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result).toEqual({
      HelperImage: true,
      UninstallerAncestry: true,
      HelperParent: true,
      PowerShellChain: true,
      CmdCandidateChain: true,
      CmdVerifiedChain: true,
      FindFourLevelChain: true,
      SameNamedCompleteChainWrongArmedRoot: false,
      MissingWrapperRecord: false,
      ReusedWrapperPid: false,
      CycleFailsClosed: false,
      DepthFailsClosed: false,
      OtherStep: false,
      OrphanHelper: false,
      NestedHelperDirectory: false,
      WrongHelperFile: false,
      WrongUninstallerName: false,
      ReusedUninstallerPid: false,
      ReusedHelperPid: false,
      FindWrongGreatGrandParent: false,
    })
  })

  windowsIt('keeps command-line secrets in memory and redacts them from process evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-evidence-redaction-'))
    const secret = 'super-secret-cli-token'
    try {
      runReleaseMonitorLibrary(`
New-Item -ItemType Directory -Path ${quotePowerShell(root)} -Force | Out-Null
$event = [pscustomobject]@{
  Kind = 'process-start'
  ProcessId = 701
  ExitCode = $null
  CaptureEstablished = $true
  ExitCodeCaptured = $false
  JobMessage = 6
  RecordedAt = '2026-01-01T00:00:00.0000000Z'
}
$identity = [pscustomobject]@{
  processId = 701
  startTimeTicks = '638900000000000000'
  processName = 'powershell'
  executablePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  commandLine = 'powershell.exe -Command Invoke-Thing --token ${secret}'
  parentProcessId = 700
  parentProcessStartTimeTicks = '638899999999999999'
  parentExecutablePath = 'C:\\temp\\parent.exe'
  identityCaptured = $true
  commandLineCaptured = $true
  identityCaptureError = $null
}
Write-AiNovelGateProcessEventEvidence -Path ${quotePowerShell(root)} -Step 'redaction-test' -Event $event -ProcessIdentity $identity -ExitClassification 'failure'
`)
      const rawEvidence = readFileSync(join(root, 'process-events.jsonl'), 'utf8')
      const evidence = JSON.parse(rawEvidence.trim()) as {
        processIdentity?: Record<string, unknown>
      }

      expect(rawEvidence).not.toContain(secret)
      expect(evidence.processIdentity).not.toHaveProperty('commandLine')
      expect(evidence.processIdentity).toMatchObject({
        commandLineCaptured: true,
        commandLineRedacted: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  windowsIt('refreshes an exited root lineage once and fails closed when the terminal child query is unavailable', () => {
    const output = runProbeLibrary(`
$rootStart = [DateTime]::UtcNow.Ticks
$childStart = $rootStart + 10000
$identityProvider = {
  param([int]$ProcessId)
  if ($ProcessId -eq 778) { return $childStart }
  # Root PID 777 has exited. Its historical start time was retained by the
  # smoke monitor and must still be used for one terminal child query.
  return $null
}
$childrenProvider = {
  param([int]$ParentProcessId)
  if ($ParentProcessId -eq 777) {
    return [pscustomobject]@{
      ProcessId = 778
      CreationDate = [DateTime]::new($childStart, [DateTimeKind]::Utc)
    }
  }
  return @()
}
$treeParameters = @{
  RootProcessId = 777
  RootStartTimeTicks = $rootStart
  ProcessStartTimeProvider = $identityProvider
  ProcessChildrenProvider = $childrenProvider
  RequireSuccessfulTerminalRefresh = $true
}
$tree = @(Get-AiNovelProcessTreeIds @treeParameters)
$queryFailure = ''
try {
  $failureParameters = @{
    RootProcessId = 777
    RootStartTimeTicks = $rootStart
    ProcessStartTimeProvider = $identityProvider
    ProcessChildrenProvider = { param([int]$ParentProcessId) throw 'synthetic CIM failure' }
    RequireSuccessfulTerminalRefresh = $true
  }
  Get-AiNovelProcessTreeIds @failureParameters | Out-Null
} catch {
  $queryFailure = $_.Exception.Message
}
[pscustomobject]@{
  RootRetained = $tree -contains 777
  ExitedRootChildTracked = $tree -contains 778
  QueryFailure = $queryFailure
} | ConvertTo-Json -Compress
`)
    const result = parseLastJsonLine(output)

    expect(result.RootRetained).toBe(true)
    expect(result.ExitedRootChildTracked).toBe(true)
    expect(result.QueryFailure).toContain('Could not complete terminal process lineage refresh')
    expect(result.QueryFailure).toContain('synthetic CIM failure')
  })

  windowsIt('does not accept an empty process tree when an exited root has a live terminal child', () => {
    const output = runProbeLibrary(`
$rootProcess = $null
$childProcess = $null
try {
  $rootProcess = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 80; exit 0') -PassThru
  $rootStart = $rootProcess.StartTime.ToUniversalTime().Ticks
  $childProcess = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -PassThru
  $childStart = $childProcess.StartTime.ToUniversalTime().Ticks
  [void]$rootProcess.WaitForExit(5000)
  $rootProcess.Refresh()

  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($rootProcess.Id)
  $startTimeTicks = @{ ([string]$rootProcess.Id) = $rootStart }
  $script:terminalRootProcessId = $rootProcess.Id
  $script:terminalChildProcessId = $childProcess.Id
  $script:terminalChildStart = $childStart
  $terminalChildren = {
    param([int]$ParentProcessId)
    if ($ParentProcessId -eq $script:terminalRootProcessId) {
      return [pscustomobject]@{
        ProcessId = $script:terminalChildProcessId
        CreationDate = [DateTime]::new($script:terminalChildStart, [DateTimeKind]::Utc)
      }
    }
    return @()
  }
  $failure = ''
  try {
    $assertionParameters = @{
      ProcessIds = $processIds
      StartTimeTicks = $startTimeTicks
      RootProcessId = $rootProcess.Id
      ProcessChildrenProvider = $terminalChildren
      TimeoutSeconds = 1
    }
    Assert-AiNovelProcessTreeExited @assertionParameters
  } catch {
    $failure = $_.Exception.Message
  }
  $childProcess.Refresh()
  [pscustomobject]@{
    RootExitedBeforeRefresh = $rootProcess.HasExited
    ChildTracked = $processIds.Contains($childProcess.Id)
    ChildAliveAfterRefresh = -not $childProcess.HasExited
    Failure = $failure
  } | ConvertTo-Json -Compress
} finally {
  foreach ($candidate in @($rootProcess, $childProcess)) {
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

    expect(result.RootExitedBeforeRefresh).toBe(true)
    expect(result.ChildTracked).toBe(true)
    expect(result.ChildAliveAfterRefresh).toBe(true)
    expect(result.Failure).toContain('Application process tree did not terminate')
  }, 15_000)

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
  }, 15_000)

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
