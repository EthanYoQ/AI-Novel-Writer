param(
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot,
  [int]$ApplicationTimeoutSeconds = 300,
  [int]$PostExitQuietSeconds = 5
)

$ErrorActionPreference = 'Stop'

# The companion Node launcher starts monitor-win-release-gate.ps1 before this
# process is released, preserving its fail-closed NSIS helper classifications.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedPlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
$resolvedEvidenceRoot = [System.IO.Path]::GetFullPath($EvidenceRoot)
New-Item -ItemType Directory -Path $resolvedEvidenceRoot -Force | Out-Null
$runtimeRoot = Join-Path $resolvedEvidenceRoot 'runtime'
$transcriptPath = Join-Path $resolvedEvidenceRoot 'runner-transcript.log'
$evidencePath = Join-Path $resolvedEvidenceRoot 'in-app-update-e2e.json'
$failureWindowsPath = Join-Path $resolvedEvidenceRoot 'failure-windows.json'
$appExecutableName = "AI$([char]0x5C0F)$([char]0x8BF4)$([char]0x4F5C)$([char]0x5BB6).exe"
$appDisplayName = [System.IO.Path]::GetFileNameWithoutExtension($appExecutableName)

function Assert-E2eCondition {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Write-E2eJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporaryPath = "${Path}.$PID.tmp"
  $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Get-E2eSha256Manifest {
  param([Parameter(Mandatory = $true)][string]$Root)

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $Root -PathType Container) -Message "Cannot hash missing preservation root: $Root"
  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
  $entries = @(
    Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
      $relativePath = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/') -replace '\\', '/'
      [ordered]@{
        path = $relativePath
        size = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  $serialized = $entries | ConvertTo-Json -Depth 4 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($serialized)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $combined = -join ($hasher.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  }
  finally {
    $hasher.Dispose()
  }
  return [ordered]@{
    root = $resolvedRoot
    fileCount = $entries.Count
    sha256 = $combined
    entries = $entries
  }
}

function Get-E2eFrozenFileManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$RelativePaths
  )

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $Root -PathType Container) -Message "Cannot freeze files from a missing root: $Root"
  Assert-E2eCondition -Condition ($RelativePaths.Count -gt 0) -Message 'At least one seeded user-data file must be frozen.'
  Assert-E2eCondition -Condition ((@($RelativePaths | Select-Object -Unique)).Count -eq $RelativePaths.Count) -Message 'Seeded user-data paths must be unique.'
  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
  $rootWithSeparator = $resolvedRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $entries = @(
    foreach ($relativePath in $RelativePaths) {
      Assert-E2eCondition -Condition (-not [string]::IsNullOrWhiteSpace($relativePath)) -Message 'A seeded user-data path is empty.'
      Assert-E2eCondition -Condition (-not [System.IO.Path]::IsPathRooted($relativePath)) -Message "Seeded user-data path must be relative: $relativePath"
      $normalizedRelativePath = $relativePath -replace '/', '\'
      Assert-E2eCondition -Condition (-not ($normalizedRelativePath -match '(^|\\)\.\.(\\|$)')) -Message "Seeded user-data path escapes its root: $relativePath"
      $candidatePath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $normalizedRelativePath))
      Assert-E2eCondition -Condition ($candidatePath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) -Message "Seeded user-data path escapes its root: $relativePath"
      Assert-E2eCondition -Condition (Test-Path -LiteralPath $candidatePath -PathType Leaf) -Message "Seeded user-data file is missing: $relativePath"
      $file = Get-Item -LiteralPath $candidatePath
      [ordered]@{
        path = $normalizedRelativePath -replace '\\', '/'
        size = $file.Length
        sha256 = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  return [ordered]@{
    root = $resolvedRoot
    fileCount = $entries.Count
    entries = $entries
  }
}

function Assert-E2eFrozenFileManifestUnchanged {
  param(
    [Parameter(Mandatory = $true)]$Before,
    [Parameter(Mandatory = $true)]$After
  )

  $beforeEntries = @($Before.entries)
  $afterEntries = @($After.entries)
  Assert-E2eCondition -Condition ($beforeEntries.Count -eq $afterEntries.Count) -Message 'The frozen seeded user-data file count changed during the in-app update.'
  for ($index = 0; $index -lt $beforeEntries.Count; $index += 1) {
    $beforeEntry = $beforeEntries[$index]
    $afterEntry = $afterEntries[$index]
    Assert-E2eCondition -Condition ($beforeEntry.path -eq $afterEntry.path) -Message "The frozen seeded user-data path changed at index $index."
    Assert-E2eCondition -Condition ($beforeEntry.size -eq $afterEntry.size) -Message "The frozen seeded user-data size changed: $($beforeEntry.path)"
    Assert-E2eCondition -Condition ($beforeEntry.sha256 -eq $afterEntry.sha256) -Message "The frozen seeded user-data hash changed: $($beforeEntry.path)"
  }
}

function Get-E2eFreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Wait-E2eCdpEndpoint {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $endpoint = "http://127.0.0.1:$Port"
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastFailure = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$endpoint/json/version" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return $endpoint
      }
    }
    catch {
      $lastFailure = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for Electron CDP endpoint $endpoint. Last error: $lastFailure"
}

function Get-E2eInstalledVersion {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ElectronRunner
  )

  $asarPath = Join-Path (Split-Path -Parent $ExePath) 'resources\app.asar'
  Assert-E2eCondition -Condition (Test-Path -LiteralPath $asarPath -PathType Leaf) -Message "Installed app archive is missing: $asarPath"
  $packagePath = "$asarPath\package.json"
  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $version = (& $ElectronRunner -e "process.stdout.write(require(process.argv[1]).version)" $packagePath 2>&1 | Out-String).Trim()
    Assert-E2eCondition -Condition ($version -match '^\d+\.\d+\.\d+$') -Message "Installed app package does not report a final semantic version: $version"
    return $version
  }
  finally {
    $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
  }
}

function Wait-E2eInstalledVersion {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ElectronRunner,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastObservation = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $lastObservation = Get-E2eInstalledVersion -ExePath $ExePath -ElectronRunner $ElectronRunner
      if ($lastObservation -eq $ExpectedVersion) {
        return $lastObservation
      }
    }
    catch {
      $lastObservation = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Installed app did not become v$ExpectedVersion after in-app update. Last observation: $lastObservation"
}

function Get-E2eInstalledAppProcesses {
  param([Parameter(Mandatory = $true)][string]$ExePath)

  $canonicalExe = [System.IO.Path]::GetFullPath($ExePath)
  return @(
    Get-CimInstance Win32_Process -Filter "Name = '$appExecutableName'" -ErrorAction Stop | Where-Object {
      -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
      [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($canonicalExe, [System.StringComparison]::OrdinalIgnoreCase)
    }
  )
}

function Stop-E2eExistingInstalledApps {
  param([Parameter(Mandatory = $true)][string]$ExePath)

  foreach ($entry in @(Get-E2eInstalledAppProcesses -ExePath $ExePath)) {
    $process = $null
    try {
      $process = [System.Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)
      if ($process.HasExited) { continue }
      $processIds = [System.Collections.Generic.HashSet[int]]::new()
      $startTimeTicks = @{}
      Add-AiNovelTrackedProcess -ProcessIds $processIds -StartTimeTicks $startTimeTicks -ProcessId $process.Id | Out-Null
      Add-AiNovelTrackedProcessTree -RootProcessId $process.Id -ProcessIds $processIds -StartTimeTicks $startTimeTicks
      $windows = @(Get-AiNovelTopLevelWindowSnapshot)
      $visibleMainWindows = @($windows | Where-Object { Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $processIds })
      if ($visibleMainWindows.Count -eq 1) {
        Close-AiNovelProcessTreeGracefully -Process $process -ProcessIds $processIds -StartTimeTicks $startTimeTicks -Windows $windows -TimeoutSeconds 15
      }
      else {
        Stop-AiNovelProcessTree -Process $process -ProcessIds $processIds -StartTimeTicks $startTimeTicks
        Assert-AiNovelProcessTreeExited -ProcessIds $processIds -StartTimeTicks $startTimeTicks -TimeoutSeconds 15 -RootProcessId $process.Id
      }
    }
    finally {
      if ($null -ne $process) { $process.Dispose() }
    }
  }
}

function Stop-E2eAppGracefully {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[string]]$BaselineWindows,
    [Parameter(Mandatory = $true)][string[]]$TargetNames
  )

  Add-AiNovelTrackedProcessTree -RootProcessId $Process.Id -ProcessIds $ProcessIds -StartTimeTicks $StartTimeTicks
  $windows = @(Get-AiNovelTopLevelWindowSnapshot)
  Close-AiNovelProcessTreeGracefully -Process $Process -ProcessIds $ProcessIds -StartTimeTicks $StartTimeTicks -Windows $windows -TimeoutSeconds 20
  $lastWindowSnapshot = @()
  Wait-AiNovelPostExitQuietPeriod `
    -BaselineIdentities $BaselineWindows `
    -TargetProcessIds $ProcessIds `
    -TargetProcessStartTimeTicks $StartTimeTicks `
    -TargetNames $TargetNames `
    -QuietSeconds $PostExitQuietSeconds `
    -LastWindowSnapshot ([ref]$lastWindowSnapshot)
}

$evidence = [ordered]@{
  schemaVersion = 1
  kind = 'windows-in-app-update-e2e'
  startedAt = [DateTime]::UtcNow.ToString('o')
  releasePlanPath = $resolvedPlanPath
  status = 'running'
}
$oldUserProfile = $env:USERPROFILE
$oldHome = $env:HOME
$oldVelaHome = $env:AI_NOVEL_VELA_HOME
$oldElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$oldAppProcess = $null
$newAppProcess = $null
$oldAppIds = [System.Collections.Generic.HashSet[int]]::new()
$newAppIds = [System.Collections.Generic.HashSet[int]]::new()
$oldAppStartTimes = @{}
$newAppStartTimes = @{}
$transcriptStarted = $false

try {
  Start-Transcript -LiteralPath $transcriptPath -Append | Out-Null
  $transcriptStarted = $true
  $plan = Get-Content -LiteralPath $resolvedPlanPath -Raw | ConvertFrom-Json
  Assert-E2eCondition -Condition ($plan.schemaVersion -eq 1) -Message 'Release plan schema is unsupported.'
  Assert-E2eCondition -Condition ($plan.officialRepository.owner -eq 'EthanYoQ' -and $plan.officialRepository.repo -eq 'AI-Novel-Writer') -Message 'Release plan is not pinned to the official repository.'
  Assert-E2eCondition -Condition ($plan.from.tag -match '^v\d+\.\d+\.\d+$') -Message 'from_tag in release plan is not a final semantic version.'
  Assert-E2eCondition -Condition ($plan.expected.tag -match '^v\d+\.\d+\.\d+$') -Message 'expected_tag in release plan is not a final semantic version.'
  Assert-E2eCondition -Condition ($plan.expected.tag -eq $plan.latest.tag) -Message 'expected_tag is not the current latest formal Release.'
  Assert-E2eCondition -Condition ($plan.expected.version -eq $plan.expected.tag.Substring(1)) -Message 'Expected Release version does not match its tag.'
  $fromInstaller = [System.IO.Path]::GetFullPath([string]$plan.from.assets.installer.downloadedPath)
  Assert-E2eCondition -Condition (Test-Path -LiteralPath $fromInstaller -PathType Leaf) -Message "Downloaded official from_tag installer is missing: $fromInstaller"
  Assert-E2eCondition -Condition ((Get-FileHash -LiteralPath $fromInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -eq ([string]$plan.from.assets.installer.sha256).ToLowerInvariant()) -Message 'Downloaded official from_tag installer SHA-256 changed before install.'

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $e2eInstallRoot = Join-Path $runtimeRoot 'installed-app'
  $isolatedHome = Join-Path $runtimeRoot 'home'
  $velaHome = Join-Path $isolatedHome '.vela'
  $preservationRoot = Join-Path $velaHome 'e2e-preservation'
  $promptsRoot = Join-Path $velaHome 'prompts'
  $skillsRoot = Join-Path $velaHome 'skills\continuity-e2e'
  New-Item -ItemType Directory -Path $preservationRoot, $promptsRoot, $skillsRoot -Force | Out-Null
  @{
    theme = 'light'
    locale = 'zh-CN'
    proxy = @{ enabled = $false; type = 'http'; host = ''; port = 7890 }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $velaHome 'config.json') -Encoding utf8
  @(@{ name = 'E2E continuity fixture'; path = $preservationRoot; updatedAt = '2026-08-07T00:00:00.000Z' }) |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $velaHome 'recent-projects.json') -Encoding utf8
  @{ key = 'e2e-continuity'; name = 'E2E continuity'; content = "Keep the heroine's secret, the chapter ledger, and chronology." } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $promptsRoot 'e2e-continuity.json') -Encoding utf8
  Set-Content -LiteralPath (Join-Path $skillsRoot 'SKILL.md') -Value "# E2E continuity fixture`n`nPreserve user-authored continuity evidence across update." -Encoding utf8
  @{ character = 'E2E protagonist'; unresolvedThread = 'unopened north-harbor letter'; chapter = 17 } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $preservationRoot 'character-card.json') -Encoding utf8
  Set-Content -LiteralPath (Join-Path $preservationRoot 'chapter-017.md') -Value '# Chapter 17`nThe north-harbor letter remains sealed.' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $preservationRoot 'continuity-ledger.txt') -Value 'timeline=2026-08-07; protagonist=e2e-protagonist; promise=return north' -Encoding utf8
  $frozenUserDataPaths = @(
    'config.json',
    'recent-projects.json',
    'prompts/e2e-continuity.json',
    'skills/continuity-e2e/SKILL.md',
    'e2e-preservation/character-card.json',
    'e2e-preservation/chapter-017.md',
    'e2e-preservation/continuity-ledger.txt'
  )
  $beforeFrozenUserData = Get-E2eFrozenFileManifest -Root $velaHome -RelativePaths $frozenUserDataPaths
  $beforePreservation = Get-E2eSha256Manifest -Root $preservationRoot
  $beforeVelaHome = Get-E2eSha256Manifest -Root $velaHome
  $evidence.userData = [ordered]@{
    isolatedUserHome = $isolatedHome
    velaHome = $velaHome
    preservationRoot = $preservationRoot
    frozenFilesBefore = $beforeFrozenUserData
    beforePreservation = $beforePreservation
    beforeVelaHome = $beforeVelaHome
  }

  # Reuse the existing installer/error-window monitor. Its /S + final /D form
  # is the existing NSIS silent-install contract; no relaxed helper exception is added here.
  . (Join-Path $PSScriptRoot 'smoke-win-installer.ps1') -InstallerPath $fromInstaller -LoadInstallerLibrary
  $startupWindows = @(Get-AiNovelTopLevelWindowSnapshot)
  $baselineWindows = New-AiNovelWindowIdentitySet -Windows $startupWindows
  $script:roundBaselineIdentities = $baselineWindows
  $script:roundTargetNames.Clear()
  foreach ($name in @(
    [System.IO.Path]::GetFileName($fromInstaller),
    [System.IO.Path]::GetFileNameWithoutExtension($fromInstaller),
    $appExecutableName,
    $appDisplayName,
    'ai-novel-writer'
  )) {
    if (-not [string]::IsNullOrWhiteSpace($name)) { [void]$script:roundTargetNames.Add($name) }
  }
  $oldInstallerStdout = Join-Path $resolvedEvidenceRoot 'old-installer.stdout.log'
  $oldInstallerStderr = Join-Path $resolvedEvidenceRoot 'old-installer.stderr.log'
  Invoke-AiNovelMonitoredExecutable `
    -Path $fromInstaller `
    -Arguments @('/S', "/D=$e2eInstallRoot") `
    -Operation 'Official from_tag silent NSIS installer' `
    -StandardOutputPath $oldInstallerStdout `
    -StandardErrorPath $oldInstallerStderr `
    -HideWindow
  $oldExe = Join-Path $e2eInstallRoot $appExecutableName
  Assert-E2eCondition -Condition (Test-Path -LiteralPath $oldExe -PathType Leaf) -Message "v$($plan.from.version) application is missing after silent installation: $oldExe"
  $electronRunner = Join-Path $repositoryRoot 'node_modules\electron\dist\electron.exe'
  Assert-E2eCondition -Condition (Test-Path -LiteralPath $electronRunner -PathType Leaf) -Message "Project Electron runner is missing: $electronRunner"
  $installedOldVersion = Get-E2eInstalledVersion -ExePath $oldExe -ElectronRunner $electronRunner
  Assert-E2eCondition -Condition ($installedOldVersion -eq $plan.from.version) -Message "Installed old app version $installedOldVersion does not match v$($plan.from.version)"
  $evidence.oldInstallation = [ordered]@{ exePath = $oldExe; version = $installedOldVersion; silent = $true }

  $env:USERPROFILE = $isolatedHome
  $env:HOME = $isolatedHome
  $env:AI_NOVEL_VELA_HOME = $velaHome
  $oldDebugPort = Get-E2eFreeTcpPort
  $oldAppStdout = Join-Path $resolvedEvidenceRoot 'old-app.stdout.log'
  $oldAppStderr = Join-Path $resolvedEvidenceRoot 'old-app.stderr.log'
  $oldElectronLog = Join-Path $resolvedEvidenceRoot 'old-electron.log'
  $oldAppProcess = Start-Process -FilePath $oldExe -ArgumentList @(
    "--remote-debugging-port=$oldDebugPort",
    '--disable-gpu',
    '--no-sandbox',
    '--enable-logging',
    '--v=1',
    "--log-file=$oldElectronLog"
  ) -PassThru -RedirectStandardOutput $oldAppStdout -RedirectStandardError $oldAppStderr
  [void]$oldAppProcess.Handle
  Add-AiNovelTrackedProcess -ProcessIds $oldAppIds -StartTimeTicks $oldAppStartTimes -ProcessId $oldAppProcess.Id | Out-Null
  Add-AiNovelTrackedProcessTree -RootProcessId $oldAppProcess.Id -ProcessIds $oldAppIds -StartTimeTicks $oldAppStartTimes
  $oldEndpoint = Wait-E2eCdpEndpoint -Port $oldDebugPort -TimeoutSeconds 45
  & node (Join-Path $PSScriptRoot 'windows-in-app-update-e2e-driver.mjs') trigger `
    --endpoint $oldEndpoint `
    --expected-version ([string]$plan.expected.version) `
    --evidence-root $resolvedEvidenceRoot
  if ($LASTEXITCODE -ne 0) { throw "Live UI update trigger failed with exit code $LASTEXITCODE." }
  $evidence.oldApplication = [ordered]@{ processId = $oldAppProcess.Id; cdpEndpoint = $oldEndpoint; triggerEvidence = 'ui-trigger.json' }

  $oldAppProcess.WaitForExit($ApplicationTimeoutSeconds * 1000) | Out-Null
  $oldAppProcess.Refresh()
  Assert-E2eCondition -Condition $oldAppProcess.HasExited -Message 'Old application did not exit after the live Restart and update now click.'
  Assert-AiNovelProcessTreeExited -ProcessIds $oldAppIds -StartTimeTicks $oldAppStartTimes -TimeoutSeconds $ApplicationTimeoutSeconds -RootProcessId $oldAppProcess.Id
  $postOldExitSnapshot = @()
  Wait-AiNovelPostExitQuietPeriod `
    -BaselineIdentities $baselineWindows `
    -TargetProcessIds $oldAppIds `
    -TargetProcessStartTimeTicks $oldAppStartTimes `
    -TargetNames @($script:roundTargetNames) `
    -QuietSeconds $PostExitQuietSeconds `
    -LastWindowSnapshot ([ref]$postOldExitSnapshot)

  $updatedExe = Join-Path $e2eInstallRoot $appExecutableName
  $installedUpdatedVersion = Wait-E2eInstalledVersion `
    -ExePath $updatedExe `
    -ElectronRunner $electronRunner `
    -ExpectedVersion ([string]$plan.expected.version) `
    -TimeoutSeconds $ApplicationTimeoutSeconds
  Stop-E2eExistingInstalledApps -ExePath $updatedExe
  $newDebugPort = Get-E2eFreeTcpPort
  $newAppStdout = Join-Path $resolvedEvidenceRoot 'updated-app.stdout.log'
  $newAppStderr = Join-Path $resolvedEvidenceRoot 'updated-app.stderr.log'
  $updatedElectronLog = Join-Path $resolvedEvidenceRoot 'updated-electron.log'
  $newAppProcess = Start-Process -FilePath $updatedExe -ArgumentList @(
    "--remote-debugging-port=$newDebugPort",
    '--disable-gpu',
    '--no-sandbox',
    '--enable-logging',
    '--v=1',
    "--log-file=$updatedElectronLog"
  ) -PassThru -RedirectStandardOutput $newAppStdout -RedirectStandardError $newAppStderr
  [void]$newAppProcess.Handle
  Add-AiNovelTrackedProcess -ProcessIds $newAppIds -StartTimeTicks $newAppStartTimes -ProcessId $newAppProcess.Id | Out-Null
  Add-AiNovelTrackedProcessTree -RootProcessId $newAppProcess.Id -ProcessIds $newAppIds -StartTimeTicks $newAppStartTimes
  $newEndpoint = Wait-E2eCdpEndpoint -Port $newDebugPort -TimeoutSeconds 45
  & node (Join-Path $PSScriptRoot 'windows-in-app-update-e2e-driver.mjs') verify `
    --endpoint $newEndpoint `
    --expected-version ([string]$plan.expected.version) `
    --evidence-root $resolvedEvidenceRoot
  if ($LASTEXITCODE -ne 0) { throw "Restarted application version verification failed with exit code $LASTEXITCODE." }
  $evidence.newApplication = [ordered]@{
    exePath = $updatedExe
    installedVersion = $installedUpdatedVersion
    processId = $newAppProcess.Id
    cdpEndpoint = $newEndpoint
    restartEvidence = 'ui-restart.json'
  }
  Stop-E2eAppGracefully `
    -Process $newAppProcess `
    -ProcessIds $newAppIds `
    -StartTimeTicks $newAppStartTimes `
    -BaselineWindows $baselineWindows `
    -TargetNames @($script:roundTargetNames)

  $afterFrozenUserData = Get-E2eFrozenFileManifest -Root $velaHome -RelativePaths $frozenUserDataPaths
  $afterPreservation = Get-E2eSha256Manifest -Root $preservationRoot
  $afterVelaHome = Get-E2eSha256Manifest -Root $velaHome
  Assert-E2eFrozenFileManifestUnchanged -Before $beforeFrozenUserData -After $afterFrozenUserData
  Assert-E2eCondition -Condition ($beforePreservation.sha256 -eq $afterPreservation.sha256) -Message 'The representative ~/.vela preservation fixture changed during the in-app update.'
  $evidence.userData.frozenFilesAfter = $afterFrozenUserData
  $evidence.userData.frozenFilesHashMatched = $true
  $evidence.userData.afterPreservation = $afterPreservation
  $evidence.userData.afterVelaHome = $afterVelaHome
  $evidence.userData.preservationHashMatched = $true
  $evidence.status = 'passed'
}
catch {
  $evidence.status = 'failed'
  $evidence.failure = $_.Exception.Message
  try {
    @(Get-AiNovelTopLevelWindowSnapshot) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $failureWindowsPath -Encoding utf8
    $evidence.failureWindows = 'failure-windows.json'
  }
  catch {
    $evidence.failureWindowCaptureError = $_.Exception.Message
  }
  throw
}
finally {
  $evidence.finishedAt = [DateTime]::UtcNow.ToString('o')
  try { Write-E2eJson -Path $evidencePath -Value $evidence } catch { Write-Warning "Could not write E2E evidence: $($_.Exception.Message)" }
  if ($null -ne $newAppProcess) { $newAppProcess.Dispose() }
  if ($null -ne $oldAppProcess) { $oldAppProcess.Dispose() }
  $env:USERPROFILE = $oldUserProfile
  $env:HOME = $oldHome
  $env:AI_NOVEL_VELA_HOME = $oldVelaHome
  $env:ELECTRON_RUN_AS_NODE = $oldElectronRunAsNode
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
