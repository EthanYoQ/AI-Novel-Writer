param(
  [string]$InstallerPath,
  [string]$PreviousInstallerPath,
  [string]$PreviousPortableZipPath,
  [int]$ObservationSeconds = 30,
  [int]$InstallerTimeoutSeconds = 300,
  [int]$PostExitQuietSeconds = 5,
  [switch]$RequireCompleteV025Fixture,
  [switch]$LoadInstallerLibrary
)

$ErrorActionPreference = 'Stop'

$installerObservationSeconds = $ObservationSeconds
$installerPostExitQuietSeconds = $PostExitQuietSeconds
. (Join-Path $PSScriptRoot 'smoke-win-app.ps1') -LoadProbeLibrary
$ObservationSeconds = $installerObservationSeconds
$PostExitQuietSeconds = $installerPostExitQuietSeconds

$root = Split-Path -Parent $PSScriptRoot
$script:aiNovelUpgradeDataFixtureScript = Join-Path $PSScriptRoot 'upgrade-data-fixture.mjs'
$script:aiNovelElectronNodeRunner = Join-Path $root 'node_modules\electron\dist\electron.exe'
$packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $InstallerPath = Join-Path $root ("release\{0}\ai-novel-writer-setup-{0}.exe" -f [string]$packageJson.version)
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$script:aiNovelPackagedVectorEvidencePath = Join-Path $root ("release\{0}\qualification\packaged-vector-smoke.json" -f [string]$packageJson.version)
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-installer-smoke-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $smokeRoot 'installed-app'
$velaHome = Join-Path $smokeRoot 'vela-home'
$globalConfig = Join-Path $velaHome 'config.json'
$recentProjects = Join-Path $velaHome 'recent-projects.json'
$upgradeFixtureRoot = Join-Path $smokeRoot 'user-projects\upgrade-preservation-fixture'
$uninstaller = Join-Path $installRoot 'Uninstall AI小说作家.exe'
$lastWindowSnapshot = @()
$observedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$observedProcessStartTimeTicks = @{}
$roundTargetNames = [System.Collections.Generic.List[string]]::new()
foreach ($name in @(
  [System.IO.Path]::GetFileName($resolvedInstaller),
  [System.IO.Path]::GetFileNameWithoutExtension($resolvedInstaller),
  'AI小说作家.exe',
  'AI小说作家',
  'ai-novel-writer'
)) {
  if (-not [string]::IsNullOrWhiteSpace($name) -and -not $roundTargetNames.Contains($name)) {
    $roundTargetNames.Add($name)
  }
}
$roundBaselineIdentities = New-AiNovelWindowIdentitySet -Windows @()

function Stop-AiNovelMonitoredProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )

  if (Test-AiNovelTrackedProcessAlive -ProcessId $Process.Id -StartTimeTicks $StartTimeTicks) {
    Stop-Process -Id $Process.Id -Force
  }
}

function Get-AiNovelFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return -join ($hasher.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
  }
  finally {
    $stream.Dispose()
    $hasher.Dispose()
  }
}

function Invoke-AiNovelUpgradeDataFixture {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('seed', 'validate')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SettingsPath
  )

  if (-not (Test-Path -LiteralPath $script:aiNovelElectronNodeRunner -PathType Leaf)) {
    throw "Project Electron runtime is missing: $script:aiNovelElectronNodeRunner"
  }
  if (-not (Test-Path -LiteralPath $script:aiNovelUpgradeDataFixtureScript -PathType Leaf)) {
    throw "Upgrade data fixture helper is missing: $script:aiNovelUpgradeDataFixtureScript"
  }

  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $previousNodeNoWarnings = $env:NODE_NO_WARNINGS
  $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-upgrade-fixture-' + [guid]::NewGuid().ToString('N') + '.out')
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-upgrade-fixture-' + [guid]::NewGuid().ToString('N') + '.err')
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:NODE_NO_WARNINGS = '1'
    $quotedFixtureScript = '"' + $script:aiNovelUpgradeDataFixtureScript.Replace('"', '\"') + '"'
    $quotedProjectRoot = '"' + $ProjectRoot.Replace('"', '\"') + '"'
    $fixtureArguments = @($quotedFixtureScript, $Mode, $quotedProjectRoot)
    if (-not [string]::IsNullOrWhiteSpace($SettingsPath)) {
      $fixtureArguments += '"' + $SettingsPath.Replace('"', '\"') + '"'
    }
    $process = Start-Process `
      -FilePath $script:aiNovelElectronNodeRunner `
      -ArgumentList $fixtureArguments `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    $output = if (Test-Path -LiteralPath $stdoutPath) { @(Get-Content -LiteralPath $stdoutPath) } else { @() }
    $errorOutput = if (Test-Path -LiteralPath $stderrPath) { @(Get-Content -LiteralPath $stderrPath) } else { @() }
    if ($process.ExitCode -ne 0) {
      throw "Upgrade data fixture $Mode failed with code $($process.ExitCode): $($errorOutput -join [Environment]::NewLine)"
    }
    $resultLine = $output | Select-Object -Last 1
    $result = $resultLine | ConvertFrom-Json
    $completeV025Evidence = (
      $result.mode -eq $Mode -and
      $result.legacyTableCount -eq 11 -and
      $result.characterCount -eq 2 -and
      $result.currentStateCount -eq 2 -and
      $result.blueprintCount -eq 1 -and
      $result.contentCount -eq 4 -and
      $result.draftCount -eq 2 -and
      $result.finalizedDraftCount -eq 1 -and
      $result.reviewCount -eq 1 -and
      $result.revisionCount -eq 1 -and
      $result.postProcessRunCount -eq 1 -and
      $result.postProcessStepCount -eq 2 -and
      $result.llmCallCount -eq 2 -and
      $result.failedLlmCallCount -eq 1 -and
      $result.summarySnapshotCount -eq 2 -and
      $result.assetInventoryPath -eq '.vela/upgrade-data-inventory.json' -and
      $result.assetCount -ge 6 -and
      $result.preservedAssetCount -eq $result.assetCount -and
      $result.embeddingSpace.vectorDimension -eq 768 -and
      $result.embeddingSpace.queryResultCount -eq 1
    )
    if (-not $completeV025Evidence) {
      throw "Upgrade data fixture $Mode returned incomplete validation evidence."
    }
    return $result
  }
  finally {
    $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
    $env:NODE_NO_WARNINGS = $previousNodeNoWarnings
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-NoNewInstallerErrorWindow {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$TargetProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$TargetProcessStartTimeTicks,
    [Parameter(Mandatory = $true)][string[]]$TargetNames,
    [Parameter(Mandatory = $true)][string]$Operation
  )

  $script:lastWindowSnapshot = @(Get-AiNovelTopLevelWindowSnapshot)
  $newErrorWindows = @(Get-AiNovelNewErrorWindows `
    -BaselineIdentities $script:roundBaselineIdentities `
    -CurrentWindows $script:lastWindowSnapshot `
    -TargetProcessIds $TargetProcessIds `
    -TargetProcessStartTimeTicks $TargetProcessStartTimeTicks `
    -TargetNames $TargetNames)
  if ($newErrorWindows.Count -gt 0) {
    throw "$Operation displayed a new Windows error dialog: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
  }
}

function Test-AiNovelAnyProcessAlive {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )

  foreach ($processId in $ProcessIds) {
    if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $StartTimeTicks) {
      return $true
    }
  }
  return $false
}

function Invoke-AiNovelMonitoredExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Operation,
    [string]$StandardOutputPath,
    [string]$StandardErrorPath,
    [switch]$HideWindow
  )

  $targetNames = @(
    [System.IO.Path]::GetFileName($Path),
    [System.IO.Path]::GetFileNameWithoutExtension($Path),
    @($script:roundTargetNames)
  )
  foreach ($targetName in $targetNames) {
    if (-not [string]::IsNullOrWhiteSpace($targetName) -and -not $script:roundTargetNames.Contains($targetName)) {
      $script:roundTargetNames.Add($targetName)
    }
  }
  if ([string]::IsNullOrWhiteSpace($StandardOutputPath) -xor [string]::IsNullOrWhiteSpace($StandardErrorPath)) {
    throw "$Operation must redirect both stdout and stderr together."
  }
  $startParameters = @{
    FilePath = $Path
    ArgumentList = $Arguments
    PassThru = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($StandardOutputPath)) {
    $startParameters.RedirectStandardOutput = $StandardOutputPath
    $startParameters.RedirectStandardError = $StandardErrorPath
  }
  if ($HideWindow) {
    $startParameters.WindowStyle = 'Hidden'
  }
  $process = Start-Process @startParameters
  $operationProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  $operationProcessStartTimeTicks = @{}
  [void](Add-AiNovelTrackedProcess -ProcessIds $operationProcessIds -StartTimeTicks $operationProcessStartTimeTicks -ProcessId $process.Id)
  [void](Add-AiNovelTrackedProcess -ProcessIds $script:observedProcessIds -StartTimeTicks $script:observedProcessStartTimeTicks -ProcessId $process.Id)
  $deadline = [DateTime]::UtcNow.AddSeconds($InstallerTimeoutSeconds)
  $quietSince = $null

  try {
    while ($true) {
      $process.Refresh()
      Add-AiNovelTrackedProcessTree -RootProcessId $process.Id -ProcessIds $operationProcessIds -StartTimeTicks $operationProcessStartTimeTicks
      foreach ($processId in $operationProcessIds) {
        if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $operationProcessStartTimeTicks) {
          [void]$script:observedProcessIds.Add([int]$processId)
          $script:observedProcessStartTimeTicks[[string]$processId] = $operationProcessStartTimeTicks[[string]$processId]
        }
      }
      Assert-NoNewInstallerErrorWindow `
        -TargetProcessIds $operationProcessIds `
        -TargetProcessStartTimeTicks $operationProcessStartTimeTicks `
        -TargetNames $targetNames `
        -Operation $Operation

      if ($process.HasExited -and -not (Test-AiNovelAnyProcessAlive -ProcessIds $operationProcessIds -StartTimeTicks $operationProcessStartTimeTicks)) {
        if ($null -eq $quietSince) {
          $quietSince = [DateTime]::UtcNow
        }
        elseif (([DateTime]::UtcNow - $quietSince).TotalSeconds -ge $PostExitQuietSeconds) {
          break
        }
      }
      else {
        $quietSince = $null
        if ([DateTime]::UtcNow -ge $deadline) {
          throw "$Operation exceeded the $InstallerTimeoutSeconds second timeout: $Path"
        }
      }
      Start-Sleep -Milliseconds 100
    }

    # Take one final desktop snapshot after the complete quiet period before accepting the exit.
    Assert-NoNewInstallerErrorWindow `
      -TargetProcessIds $operationProcessIds `
      -TargetProcessStartTimeTicks $operationProcessStartTimeTicks `
      -TargetNames $targetNames `
      -Operation $Operation
    if ($process.ExitCode -ne 0) {
      throw "$Operation failed with code $($process.ExitCode): $Path"
    }
  }
  catch {
    Save-AiNovelSmokeFailureEvidence `
      -Path $smokeRoot `
      -Failure $_.Exception.Message `
      -Windows $script:lastWindowSnapshot `
      -ObservedProcessIds @($script:observedProcessIds)
    Stop-AiNovelMonitoredProcess -Process $process -StartTimeTicks $operationProcessStartTimeTicks
    throw
  }
  finally {
    $process.Dispose()
  }
}

function Invoke-AiNovelPackagedVectorSmoke {
  param([Parameter(Mandatory = $true)][string]$Path)

  # This is a package-only bridge, not a general application command: the
  # installed executable receives no paths, only a freshly generated one-time
  # token that must also be present in its inherited environment.
  $token = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $smokeRoot 'packaged-vector-smoke.stdout'
  $stderrPath = Join-Path $smokeRoot 'packaged-vector-smoke.stderr'
  $previousReleaseSmoke = $env:AI_NOVEL_RELEASE_SMOKE
  $previousReleaseSmokeToken = $env:AI_NOVEL_RELEASE_SMOKE_TOKEN

  try {
    $env:AI_NOVEL_RELEASE_SMOKE = '1'
    $env:AI_NOVEL_RELEASE_SMOKE_TOKEN = $token
    Invoke-AiNovelMonitoredExecutable `
      -Path $Path `
      -Arguments @("--ai-novel-release-smoke=$token") `
      -Operation 'Packaged vector qualification' `
      -StandardOutputPath $stdoutPath `
      -StandardErrorPath $stderrPath `
      -HideWindow

    $resultLine = @(
      Get-Content -LiteralPath $stdoutPath -ErrorAction Stop |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Last 1
    )
    if ($resultLine.Count -ne 1) {
      throw 'Packaged vector qualification did not produce exactly one JSON evidence line.'
    }
    try {
      $result = $resultLine[0] | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Packaged vector qualification produced invalid JSON evidence: $($_.Exception.Message)"
    }
    $validEvidence = (
      $result.schemaVersion -eq 1 -and
      $result.kind -eq 'packaged-vector-smoke' -and
      $null -ne $result.projectA -and
      $result.projectA.vectorDimension -eq 768 -and
      $result.projectA.importChunkCount -eq 1 -and
      $result.projectA.ftsResultCount -eq 0 -and
      $result.projectA.semanticResultCount -eq 1 -and
      $null -ne $result.projectB -and
      $result.projectB.initialVectorDimension -eq 768 -and
      $result.projectB.vectorDimension -eq 1536 -and
      $result.projectB.initialImportChunkCount -eq 1 -and
      $result.projectB.backfilledChunkCount -eq 1 -and
      $result.projectB.sameFingerprintRebuilt -eq $true -and
      $result.projectB.ftsResultCount -eq 0 -and
      $result.projectB.semanticResultCount -eq 1
    )
    if (-not $validEvidence) {
      throw 'Packaged vector qualification returned incomplete or unexpected evidence.'
    }

    $evidenceDirectory = Split-Path -Parent $script:aiNovelPackagedVectorEvidencePath
    New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:aiNovelPackagedVectorEvidencePath -Encoding utf8
    Write-Host "Packaged vector smoke evidence: $script:aiNovelPackagedVectorEvidencePath"
  }
  catch {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      (Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    }
    else {
      ''
    }
    if ([string]::IsNullOrWhiteSpace($stderr)) {
      throw
    }
    throw "Packaged vector qualification failed: $($_.Exception.Message)$([Environment]::NewLine)$stderr"
  }
  finally {
    $env:AI_NOVEL_RELEASE_SMOKE = $previousReleaseSmoke
    $env:AI_NOVEL_RELEASE_SMOKE_TOKEN = $previousReleaseSmokeToken
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Install-Silently {
  param([Parameter(Mandatory = $true)][string]$Path)

  Invoke-AiNovelMonitoredExecutable `
    -Path $Path `
    -Arguments @('/S', "/D=$installRoot") `
    -Operation 'Installer'
}

if ($LoadInstallerLibrary) {
  return
}

$smokeSucceeded = $false
$failureRecord = $null
$upgradeFixtureSeeded = $false
$upgradeValidationEvidence = $null

try {
  $startupWindowsBeforeBaseline = @(Get-AiNovelTopLevelWindowSnapshot)
  $startupBlockingWindows = @(Get-AiNovelStartupBlockingErrorWindows `
    -CurrentWindows $startupWindowsBeforeBaseline `
    -ProductNames @($roundTargetNames))
  if ($startupBlockingWindows.Count -gt 0) {
    throw "Installer smoke cannot start while an existing product error dialog is open: $(Format-AiNovelWindowEvidence -Windows $startupBlockingWindows)"
  }
  $roundBaselineIdentities = New-AiNovelWindowIdentitySet -Windows $startupWindowsBeforeBaseline
  $startupWindowsAfterBaseline = @(Get-AiNovelTopLevelWindowSnapshot)
  $startupBlockingWindows = @(Get-AiNovelStartupBlockingErrorWindows `
    -CurrentWindows $startupWindowsAfterBaseline `
    -ProductNames @($roundTargetNames))
  if ($startupBlockingWindows.Count -gt 0) {
    throw "Installer smoke cannot start while an existing product error dialog is open: $(Format-AiNovelWindowEvidence -Windows $startupBlockingWindows)"
  }

  New-Item -ItemType Directory -Path $velaHome -Force | Out-Null
  @{ theme = 'light'; locale = 'zh-CN'; proxy = @{ enabled = $false; type = 'http'; host = ''; port = 7890 } } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $globalConfig -Encoding utf8

  $hasPreviousVersion = (
    (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) -or
    (-not [string]::IsNullOrWhiteSpace($PreviousPortableZipPath))
  )
  if ($hasPreviousVersion) {
    if (-not [string]::IsNullOrWhiteSpace($PreviousPortableZipPath)) {
      $portableExtractRoot = Join-Path $smokeRoot 'previous-portable'
      Expand-Archive -LiteralPath (Resolve-Path -LiteralPath $PreviousPortableZipPath).Path -DestinationPath $portableExtractRoot -Force
      $portableExecutable = Get-ChildItem -LiteralPath $portableExtractRoot -Recurse -File -Filter 'AI小说作家.exe' |
        Select-Object -First 1
      if ($null -eq $portableExecutable) {
        throw 'Official previous-version portable package does not contain AI小说作家.exe.'
      }
      New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
      Copy-Item -Path (Join-Path $portableExecutable.Directory.FullName '*') -Destination $installRoot -Recurse -Force
    }
    else {
      Install-Silently (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
    }
    # Seed the real v0.2.5 project format only after the old installer is present:
    # {project}\.vela\vela.db with all 11 v0.2.5 tables and representative
    # core, draft, revision, review, post-process, LLM, and summary records.
    Invoke-AiNovelUpgradeDataFixture -Mode seed -ProjectRoot $upgradeFixtureRoot -SettingsPath $globalConfig | Out-Null
    Invoke-AiNovelUpgradeDataFixture -Mode validate -ProjectRoot $upgradeFixtureRoot -SettingsPath $globalConfig | Out-Null
    $upgradeFixtureSeeded = $true
    @(
      @{
        name = '升级保留验证小说'
        path = $upgradeFixtureRoot
        updatedAt = '2026-01-02T03:04:05.000Z'
      }
    ) | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $recentProjects -Encoding utf8

    $legacyExePath = Join-Path $installRoot 'AI小说作家.exe'
    if (-not (Test-Path -LiteralPath $legacyExePath -PathType Leaf)) {
      throw "Previous-version application is missing after installation: $legacyExePath"
    }
    & (Join-Path $PSScriptRoot 'smoke-win-app.ps1') `
      -ExePath $legacyExePath `
      -ObservationSeconds $ObservationSeconds `
      -PostExitQuietSeconds $PostExitQuietSeconds `
      -VelaHome $velaHome `
      -WindowBaselineIdentities $roundBaselineIdentities `
      -RelatedProcessIds $observedProcessIds `
      -RelatedProcessStartTimeTicks $observedProcessStartTimeTicks `
      -RelatedTargetNames @($roundTargetNames) `
      -LegacyProjectPathToOpen $upgradeFixtureRoot
  }
  Install-Silently $resolvedInstaller

  $exePath = Join-Path $installRoot 'AI小说作家.exe'
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Installed application is missing: $exePath"
  }
  Invoke-AiNovelPackagedVectorSmoke -Path $exePath
  $appSmokeParameters = @{
    ExePath = $exePath
    ObservationSeconds = $ObservationSeconds
    PostExitQuietSeconds = $PostExitQuietSeconds
    VelaHome = $velaHome
    WindowBaselineIdentities = $roundBaselineIdentities
    RelatedProcessIds = $observedProcessIds
    RelatedProcessStartTimeTicks = $observedProcessStartTimeTicks
    RelatedTargetNames = @($roundTargetNames)
  }
  if ($upgradeFixtureSeeded) {
    $appSmokeParameters.ProjectPathToOpen = $upgradeFixtureRoot
  }
  & (Join-Path $PSScriptRoot 'smoke-win-app.ps1') @appSmokeParameters

  $config = Get-Content -LiteralPath $globalConfig -Raw | ConvertFrom-Json
  if ($config.theme -ne 'light' -or $config.locale -ne 'zh-CN' -or $config.proxy.port -ne 7890) {
    throw 'Installer smoke changed existing global configuration instead of preserving it.'
  }
  if ($upgradeFixtureSeeded) {
    $upgradeValidationEvidence = Invoke-AiNovelUpgradeDataFixture -Mode validate -ProjectRoot $upgradeFixtureRoot -SettingsPath $globalConfig
    if ($RequireCompleteV025Fixture -and $upgradeValidationEvidence.legacyTableCount -ne 11) {
      throw 'The required complete v0.2.5 upgrade fixture was not validated.'
    }
    if (-not (Test-Path -LiteralPath $recentProjects -PathType Leaf)) {
      throw 'Installer upgrade removed the isolated recent-projects file.'
    }
    $recentProjectEntries = @(Get-Content -LiteralPath $recentProjects -Raw | ConvertFrom-Json)
    $fixtureRecentEntry = @($recentProjectEntries | Where-Object {
      [System.IO.Path]::GetFullPath([string]$_.path) -eq [System.IO.Path]::GetFullPath($upgradeFixtureRoot)
    })
    if ($fixtureRecentEntry.Count -ne 1) {
      throw 'The upgraded application did not retain the opened fixture in recent projects.'
    }
  }
  $smokeSucceeded = $true
}
catch {
  $failureRecord = $_
  Save-AiNovelSmokeFailureEvidence `
    -Path $smokeRoot `
    -Failure $_.Exception.Message `
    -Windows $lastWindowSnapshot `
    -ObservedProcessIds @($observedProcessIds)
}
finally {
  if (Test-Path -LiteralPath $uninstaller) {
    try {
      Invoke-AiNovelMonitoredExecutable `
        -Path $uninstaller `
        -Arguments @('/S') `
        -Operation 'Uninstaller'
    }
    catch {
      if ($null -eq $failureRecord) {
        $failureRecord = $_
      }
      $smokeSucceeded = $false
      Write-Warning "Installer smoke cleanup failed: $($_.Exception.Message)"
    }
  }
  Complete-AiNovelSmokeDiagnostics -Path $smokeRoot -Succeeded $smokeSucceeded
}

if ($null -ne $failureRecord) {
  throw $failureRecord
}

if ($null -ne $upgradeValidationEvidence) {
  Write-Host "v0.2.5 upgrade data preservation evidence: $($upgradeValidationEvidence | ConvertTo-Json -Compress)"
}
Write-Host "Windows installer smoke test passed: $resolvedInstaller"
