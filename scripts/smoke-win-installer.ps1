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
$script:aiNovelPackagedOfficialHomepageEvidencePath = Join-Path $root ("release\{0}\qualification\packaged-official-homepage-smoke.json" -f [string]$packageJson.version)
$script:aiNovelPackagedSkinEvidencePath = Join-Path $root ("release\{0}\qualification\packaged-skin-smoke.json" -f [string]$packageJson.version)
$script:aiNovelAcceptanceDirectory = if (-not [string]::IsNullOrWhiteSpace($env:AI_NOVEL_RELEASE_EVIDENCE_ROOT)) {
  Join-Path $env:AI_NOVEL_RELEASE_EVIDENCE_ROOT 'acceptance'
} else {
  Join-Path $root ("release\{0}\qualification\acceptance" -f [string]$packageJson.version)
}
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

function Get-AiNovelUtf8NonEmptyLines {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return @()
  }

  # Windows PowerShell 5.1 treats UTF-8 without a BOM as the active ANSI code
  # page when Get-Content has no explicit encoding. Electron writes UTF-8 JSON
  # without a BOM, so decode its bytes ourselves and explicitly strip an
  # optional UTF-8 BOM before ConvertFrom-Json sees the evidence.
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
  $offset = if (
    $bytes.Length -ge 3 -and
    $bytes[0] -eq 0xEF -and
    $bytes[1] -eq 0xBB -and
    $bytes[2] -eq 0xBF
  ) { 3 } else { 0 }
  try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $text = $utf8.GetString($bytes, $offset, $bytes.Length - $offset)
  }
  catch {
    throw "Could not decode UTF-8 smoke evidence at ${Path}: $($_.Exception.Message)"
  }

  return @($text -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
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
    $output = Get-AiNovelUtf8NonEmptyLines -Path $stdoutPath
    $errorOutput = Get-AiNovelUtf8NonEmptyLines -Path $stderrPath
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
  # Windows PowerShell can discard the native process handle after an
  # unobserved child exits, leaving ExitCode empty even after WaitForExit().
  # Materialize the handle while the child is alive so finalization below can
  # read the actual exit status.
  [void]$process.Handle
  $operationProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  $operationProcessStartTimeTicks = @{}
  [void](Add-AiNovelTrackedProcess -ProcessIds $operationProcessIds -StartTimeTicks $operationProcessStartTimeTicks -ProcessId $process.Id)
  [void](Add-AiNovelTrackedProcess -ProcessIds $script:observedProcessIds -StartTimeTicks $script:observedProcessStartTimeTicks -ProcessId $process.Id)
  $deadline = [DateTime]::UtcNow.AddSeconds($InstallerTimeoutSeconds)
  $quietSince = $null

  try {
    while ($true) {
      $process.Refresh()
      if ($process.HasExited) {
        Add-AiNovelTrackedProcessTree `
          -RootProcessId $process.Id `
          -ProcessIds $operationProcessIds `
          -StartTimeTicks $operationProcessStartTimeTicks `
          -RequireSuccessfulTerminalRefresh
      }
      else {
        Add-AiNovelTrackedProcessTree -RootProcessId $process.Id -ProcessIds $operationProcessIds -StartTimeTicks $operationProcessStartTimeTicks
      }
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
    [void]$process.WaitForExit()
    $process.Refresh()
    $exitCode = $process.ExitCode
    if ($null -eq $exitCode) {
      throw "$Operation exited without an available exit code after finalization: $Path"
    }
    if ($exitCode -ne 0) {
      throw "$Operation failed with code ${exitCode}: $Path"
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
  $evidenceSucceeded = $false

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

    $resultLine = @(Get-AiNovelUtf8NonEmptyLines -Path $stdoutPath | Select-Object -Last 1)
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
    $evidenceSucceeded = $true
  }
  catch {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      (Get-AiNovelUtf8NonEmptyLines -Path $stderrPath) -join [Environment]::NewLine
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
    if ($evidenceSucceeded) {
      Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-AiNovelPackagedOfficialHomepageSmoke {
  param([Parameter(Mandatory = $true)][string]$Path)

  # The installed executable receives only a fresh one-time token. The
  # packaged main process substitutes its shell.openExternal dependency, so the
  # probe cannot launch a browser or depend on network availability.
  $token = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $smokeRoot 'packaged-official-homepage-smoke.stdout'
  $stderrPath = Join-Path $smokeRoot 'packaged-official-homepage-smoke.stderr'
  $previousReleaseHomepageSmoke = $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE
  $previousReleaseHomepageSmokeToken = $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN
  $evidenceSucceeded = $false

  try {
    $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE = '1'
    $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN = $token
    Invoke-AiNovelMonitoredExecutable `
      -Path $Path `
      -Arguments @("--ai-novel-release-homepage-smoke=$token") `
      -Operation 'Packaged official homepage qualification' `
      -StandardOutputPath $stdoutPath `
      -StandardErrorPath $stderrPath `
      -HideWindow

    $resultLine = @(Get-AiNovelUtf8NonEmptyLines -Path $stdoutPath | Select-Object -Last 1)
    if ($resultLine.Count -ne 1) {
      throw 'Packaged official homepage qualification did not produce exactly one JSON evidence line.'
    }
    try {
      $result = $resultLine[0] | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Packaged official homepage qualification produced invalid JSON evidence: $($_.Exception.Message)"
    }
    $validEvidence = (
      $result.schemaVersion -eq 1 -and
      $result.kind -eq 'packaged-official-homepage-smoke' -and
      $null -ne $result.trustedIntent -and
      $result.trustedIntent.channel -eq 'official-homepage:open' -and
      $result.trustedIntent.requestArgumentCount -eq 0 -and
      $result.trustedIntent.url -eq 'https://github.com/EthanYoQ/AI-Novel-Writer' -and
      $result.trustedIntent.success -eq $true -and
      $result.trustedIntent.shellOpenExternalCalls -eq 1 -and
      $null -ne $result.failedOpenExternal -and
      $result.failedOpenExternal.success -eq $false -and
      $result.failedOpenExternal.shellOpenExternalCalls -eq 1 -and
      $result.failedOpenExternal.controllerError -eq 'Unable to open the official homepage.' -and
      $result.failedOpenExternal.rendererError.zhCN -eq '无法打开官方主页，请稍后重试。' -and
      $result.failedOpenExternal.rendererError.enUS -eq 'Unable to open the official homepage. Please try again later.'
    )
    if (-not $validEvidence) {
      throw 'Packaged official homepage qualification returned incomplete or unexpected evidence.'
    }

    $evidenceDirectory = Split-Path -Parent $script:aiNovelPackagedOfficialHomepageEvidencePath
    New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:aiNovelPackagedOfficialHomepageEvidencePath -Encoding utf8
    Write-Host "Packaged official homepage smoke evidence: $script:aiNovelPackagedOfficialHomepageEvidencePath"
    $evidenceSucceeded = $true
  }
  catch {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      (Get-AiNovelUtf8NonEmptyLines -Path $stderrPath) -join [Environment]::NewLine
    }
    else {
      ''
    }
    if ([string]::IsNullOrWhiteSpace($stderr)) {
      throw
    }
    throw "Packaged official homepage qualification failed: $($_.Exception.Message)$([Environment]::NewLine)$stderr"
  }
  finally {
    $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE = $previousReleaseHomepageSmoke
    $env:AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN = $previousReleaseHomepageSmokeToken
    if ($evidenceSucceeded) {
      Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-AiNovelPackagedSkinSmoke {
  param([Parameter(Mandatory = $true)][string]$Path)

  # The package receives only a one-time token. Its storage root is the
  # installer smoke's isolated Vela home, never a user profile or caller path.
  $token = [guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $smokeRoot 'packaged-skin-smoke.stdout'
  $stderrPath = Join-Path $smokeRoot 'packaged-skin-smoke.stderr'
  $previousReleaseSkinSmoke = $env:AI_NOVEL_RELEASE_SKIN_SMOKE
  $previousReleaseSkinSmokeToken = $env:AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN
  $previousVelaHome = $env:AI_NOVEL_VELA_HOME
  $evidenceSucceeded = $false

  try {
    $env:AI_NOVEL_RELEASE_SKIN_SMOKE = '1'
    $env:AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN = $token
    $env:AI_NOVEL_VELA_HOME = $velaHome
    Invoke-AiNovelMonitoredExecutable `
      -Path $Path `
      -Arguments @("--ai-novel-release-skin-smoke=$token") `
      -Operation 'Packaged skin qualification' `
      -StandardOutputPath $stdoutPath `
      -StandardErrorPath $stderrPath `
      -HideWindow

    $resultLine = @(Get-AiNovelUtf8NonEmptyLines -Path $stdoutPath | Select-Object -Last 1)
    if ($resultLine.Count -ne 1) {
      throw 'Packaged skin qualification did not produce exactly one JSON evidence line.'
    }
    try {
      $result = $resultLine[0] | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Packaged skin qualification produced invalid JSON evidence: $($_.Exception.Message)"
    }
    $validEvidence = (
      $result.schemaVersion -eq 1 -and
      $result.kind -eq 'packaged-skin-smoke' -and
      $null -ne $result.builtInAnime -and
      $result.builtInAnime.asset -eq 'skins/anime-night.webp' -and
      $result.builtInAnime.present -eq $true -and
      $result.builtInAnime.format -eq 'webp' -and
      $null -ne $result.customSkin -and
      $result.customSkin.importSucceeded -eq $true -and
      $result.customSkin.readSucceeded -eq $true -and
      $result.customSkin.stateRestored -eq $true -and
      $result.customSkin.activeSkin -eq 'custom' -and
      $result.customSkin.mime -eq 'image/png' -and
      [int]$result.customSkin.width -gt 0 -and
      [int]$result.customSkin.height -gt 0
    )
    if (-not $validEvidence) {
      throw 'Packaged skin qualification returned incomplete or unexpected evidence.'
    }

    $evidenceDirectory = Split-Path -Parent $script:aiNovelPackagedSkinEvidencePath
    New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:aiNovelPackagedSkinEvidencePath -Encoding utf8
    Write-Host "Packaged skin smoke evidence: $script:aiNovelPackagedSkinEvidencePath"
    $evidenceSucceeded = $true
  }
  catch {
    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      (Get-AiNovelUtf8NonEmptyLines -Path $stderrPath) -join [Environment]::NewLine
    }
    else {
      ''
    }
    if ([string]::IsNullOrWhiteSpace($stderr)) {
      throw
    }
    throw "Packaged skin qualification failed: $($_.Exception.Message)$([Environment]::NewLine)$stderr"
  }
  finally {
    $env:AI_NOVEL_RELEASE_SKIN_SMOKE = $previousReleaseSkinSmoke
    $env:AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN = $previousReleaseSkinSmokeToken
    $env:AI_NOVEL_VELA_HOME = $previousVelaHome
    if ($evidenceSucceeded) {
      Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Install-Silently {
  param([Parameter(Mandatory = $true)][string]$Path)

  Invoke-AiNovelMonitoredExecutable `
    -Path $Path `
    -Arguments @('/S', "/D=$installRoot") `
    -Operation 'Installer'
}

function Get-AiNovelSigningAcceptanceReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [scriptblock]$SignatureProvider
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $signature = if ($null -eq $SignatureProvider) {
    $securityModuleManifest = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    if (-not (Test-Path -LiteralPath $securityModuleManifest -PathType Leaf)) {
      throw "Windows PowerShell security module manifest is missing: $securityModuleManifest"
    }
    Import-Module -Name $securityModuleManifest -Force -ErrorAction Stop
    Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $resolvedPath -ErrorAction Stop
  } else {
    & $SignatureProvider $resolvedPath
  }
  $validationResult = [string]$signature.Status
  if ($validationResult -eq 'Valid') {
    return [ordered]@{
      schemaVersion = 2
      kind = 'windows-signing'
      accepted = $true
      observations = @('Get-AuthenticodeSignature validated the installer signature as Valid.')
      direct = [ordered]@{ authenticodeStatus = $validationResult; installerSha256 = (Get-AiNovelFileSha256 -Path $resolvedPath).ToLowerInvariant() }
      installerPath = $resolvedPath
      installerSha256 = (Get-AiNovelFileSha256 -Path $resolvedPath).ToLowerInvariant()
      status = 'signed'
      validationResult = $validationResult
      signerSubject = [string]$signature.SignerCertificate.Subject
      unsignedDistributionImpact = 'not-applicable'
    }
  }
  if ($validationResult -eq 'NotSigned') {
    return [ordered]@{
      schemaVersion = 2
      kind = 'windows-signing'
      accepted = $true
      observations = @('Get-AuthenticodeSignature directly reported that the installer is not signed.')
      direct = [ordered]@{ authenticodeStatus = $validationResult; installerSha256 = (Get-AiNovelFileSha256 -Path $resolvedPath).ToLowerInvariant() }
      installerPath = $resolvedPath
      installerSha256 = (Get-AiNovelFileSha256 -Path $resolvedPath).ToLowerInvariant()
      status = 'unsigned'
      validationResult = $validationResult
      signerSubject = $null
      unsignedDistributionImpact = 'Windows SmartScreen may display an unknown-publisher warning, enterprise policy may block execution, and users cannot verify publisher identity through a code-signing certificate.'
    }
  }
  throw "Installer Authenticode validation failed closed with status ${validationResult}: $resolvedPath"
}

function Assert-AiNovelUninstallPostcondition {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$InstalledExecutable
  )

  $installedExecutableExists = Test-Path -LiteralPath $InstalledExecutable -PathType Leaf
  if ($installedExecutableExists) {
    throw "Uninstall postcondition failed because the installed executable still exists: $InstalledExecutable"
  }

  $directoryState = 'absent'
  $allowedSystemResiduals = @()
  if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
    $entries = @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop)
    if ($entries.Count -eq 0) {
      $directoryState = 'empty'
    }
    else {
      $unexpected = @($entries | Where-Object {
        $isAllowedName = $_.Name -in @('desktop.ini', 'Thumbs.db')
        $hasSystemAttribute = ([int]$_.Attributes -band [int][System.IO.FileAttributes]::System) -ne 0
        $_.PSIsContainer -or -not $isAllowedName -or -not $hasSystemAttribute
      })
      if ($unexpected.Count -gt 0) {
        throw "Uninstall postcondition failed because the product directory contains unexpected residue: $($unexpected.Name -join ', ')"
      }
      $directoryState = 'system-residue-only'
      $allowedSystemResiduals = @($entries | ForEach-Object Name)
    }
  }

  return [ordered]@{
    schemaVersion = 2
    kind = 'windows-uninstall'
    accepted = $true
    observations = @(
      'The monitored uninstaller exited successfully and completed its post-exit quiet period.'
      'The installed product executable no longer exists.'
      'The product install directory is absent, empty, or contains only explicitly allowed system files.'
    )
    direct = [ordered]@{
      installedExecutableExists = $false
      installDirectoryState = $directoryState
      allowedSystemResiduals = $allowedSystemResiduals
    }
    installedExecutableExists = $false
    installDirectoryState = $directoryState
    allowedSystemResiduals = $allowedSystemResiduals
  }
}

function Write-AiNovelPackagedSmokeAcceptanceReceipt {
  $records = @(
    @{ kind = 'packaged-vector-smoke'; path = $script:aiNovelPackagedVectorEvidencePath }
    @{ kind = 'packaged-official-homepage-smoke'; path = $script:aiNovelPackagedOfficialHomepageEvidencePath }
    @{ kind = 'packaged-skin-smoke'; path = $script:aiNovelPackagedSkinEvidencePath }
  ) | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_.path -PathType Leaf)) {
      throw "Packaged smoke evidence is missing: $($_.path)"
    }
    $record = Get-Content -LiteralPath $_.path -Raw | ConvertFrom-Json
    if ([string]$record.kind -ne [string]$_.kind) {
      throw "Packaged smoke evidence kind mismatch: $($_.path)"
    }
    [ordered]@{
      kind = [string]$_.kind
      evidencePath = "qualification/$([System.IO.Path]::GetFileName([string]$_.path))"
      sha256 = (Get-AiNovelFileSha256 -Path $_.path).ToLowerInvariant()
    }
  }
  Write-AiNovelAcceptanceReceipt `
    -Directory $script:aiNovelAcceptanceDirectory `
    -FileName 'packaged-smoke.json' `
    -Receipt ([ordered]@{
      schemaVersion = 2
      kind = 'windows-packaged-smoke-summary'
      accepted = $true
      observations = @('The installed package produced the required vector, official-homepage, and skin smoke evidence.')
      direct = [ordered]@{ evidenceCount = @($records).Count; evidenceKinds = @($records | ForEach-Object { $_.kind }) }
      evidence = @($records)
    })
}

if ($LoadInstallerLibrary) {
  return
}

$smokeSucceeded = $false
$failureRecord = $null
$upgradeFixtureSeeded = $false
$upgradeValidationEvidence = $null
$currentInstallCompleted = $false

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
$currentInstallCompleted = $true

  $exePath = Join-Path $installRoot 'AI小说作家.exe'
  if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Installed application is missing: $exePath"
  }
  $signingReceipt = Get-AiNovelSigningAcceptanceReceipt -Path $resolvedInstaller
  Write-AiNovelAcceptanceReceipt `
    -Directory $script:aiNovelAcceptanceDirectory `
    -FileName 'signing.json' `
    -Receipt $signingReceipt
  Write-AiNovelAcceptanceReceipt `
    -Directory $script:aiNovelAcceptanceDirectory `
    -FileName 'install.json' `
    -Receipt ([ordered]@{
      schemaVersion = 2
      kind = 'windows-install'
      accepted = $true
      observations = @(
        'The real NSIS installer and its complete observed process tree exited with code zero.'
        'The installed product executable exists at the requested isolated install location.'
      )
      direct = [ordered]@{
        installerExitCode = 0
        installedExecutable = $exePath
        installedExecutableExists = $true
      }
      installerPath = $resolvedInstaller
      installerSha256 = (Get-AiNovelFileSha256 -Path $resolvedInstaller).ToLowerInvariant()
      installerExitCode = 0
      installRoot = $installRoot
      installedExecutable = $exePath
      installedExecutableExists = $true
    })
  Invoke-AiNovelPackagedVectorSmoke -Path $exePath
  Invoke-AiNovelPackagedOfficialHomepageSmoke -Path $exePath
  Invoke-AiNovelPackagedSkinSmoke -Path $exePath
  Write-AiNovelPackagedSmokeAcceptanceReceipt
  $appSmokeParameters = @{
    ExePath = $exePath
    ObservationSeconds = $ObservationSeconds
    PostExitQuietSeconds = $PostExitQuietSeconds
    VelaHome = $velaHome
    WindowBaselineIdentities = $roundBaselineIdentities
    RelatedProcessIds = $observedProcessIds
    RelatedProcessStartTimeTicks = $observedProcessStartTimeTicks
    RelatedTargetNames = @($roundTargetNames)
    AcceptanceDirectory = $script:aiNovelAcceptanceDirectory
    ExpectedVersion = [string]$packageJson.version
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
    Write-AiNovelAcceptanceReceipt `
      -Directory $script:aiNovelAcceptanceDirectory `
      -FileName 'upgrade-data.json' `
      -Receipt ([ordered]@{
        schemaVersion = 2
        kind = 'windows-upgrade-data'
        accepted = $true
        observations = @(
          'The verified v0.2.5 fixture was opened before upgrade and reopened by the current installed application.'
          'Project database records, physical assets, embedding search, global settings, and recent-project state were validated after upgrade.'
        )
        direct = [ordered]@{
          previousVersion = '0.2.5'
          legacyTableCount = [int]$upgradeValidationEvidence.legacyTableCount
          preservedAssetCount = [int]$upgradeValidationEvidence.preservedAssetCount
          vectorDimension = [int]$upgradeValidationEvidence.embeddingSpace.vectorDimension
          queryResultCount = [int]$upgradeValidationEvidence.embeddingSpace.queryResultCount
        }
        previousVersion = '0.2.5'
        previousSource = if (-not [string]::IsNullOrWhiteSpace($PreviousPortableZipPath)) { 'verified-portable-zip' } else { 'verified-installer' }
        legacyTableCount = [int]$upgradeValidationEvidence.legacyTableCount
        assetCount = [int]$upgradeValidationEvidence.assetCount
        preservedAssetCount = [int]$upgradeValidationEvidence.preservedAssetCount
        vectorDimension = [int]$upgradeValidationEvidence.embeddingSpace.vectorDimension
        queryResultCount = [int]$upgradeValidationEvidence.embeddingSpace.queryResultCount
        settingsPreserved = $true
        recentProjectPreserved = $true
      })
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
  if ($currentInstallCompleted -and -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    if ($null -eq $failureRecord) {
      $failureRecord = [System.Management.Automation.ErrorRecord]::new(
        [System.IO.FileNotFoundException]::new("Installed uninstaller is missing: $uninstaller"),
        'AiNovelUninstallerMissing',
        [System.Management.Automation.ErrorCategory]::ObjectNotFound,
        $uninstaller
      )
    }
    $smokeSucceeded = $false
  }
  elseif (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    try {
      Invoke-AiNovelMonitoredExecutable `
        -Path $uninstaller `
        -Arguments @('/S') `
        -Operation 'Uninstaller'
      $uninstallReceipt = Assert-AiNovelUninstallPostcondition `
        -InstallRoot $installRoot `
        -InstalledExecutable (Join-Path $installRoot 'AI小说作家.exe')
      Write-AiNovelAcceptanceReceipt `
        -Directory $script:aiNovelAcceptanceDirectory `
        -FileName 'uninstall.json' `
        -Receipt $uninstallReceipt
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
