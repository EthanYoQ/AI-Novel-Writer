param(
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot,
  [string]$MonitorControlPath,
  [string]$MonitorStatusPath,
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

function New-E2eUserDataFixture {
  param([Parameter(Mandatory = $true)][string]$RuntimeRoot)

  $isolatedHome = Join-Path $RuntimeRoot 'home'
  $velaHome = Join-Path $isolatedHome '.vela'
  $preservationRoot = Join-Path $velaHome 'e2e-preservation'
  $promptsRoot = Join-Path $velaHome 'prompts'
  $skillsRoot = Join-Path $velaHome 'skills\continuity-e2e'
  $recentProjectRoot = Join-Path $RuntimeRoot 'user-projects\e2e-continuity-fixture'
  $recentProjectMetadataRoot = Join-Path $recentProjectRoot '.vela'
  $recentProjectDraftsRoot = Join-Path $recentProjectRoot 'drafts'
  New-Item -ItemType Directory -Path @(
    $preservationRoot,
    $promptsRoot,
    $skillsRoot,
    $recentProjectMetadataRoot,
    $recentProjectDraftsRoot
  ) -Force | Out-Null

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $writeUtf8 = {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
  }
  & $writeUtf8 (Join-Path $velaHome 'config.json') (@{
    e2eUserSentinel = 'preserve-config-sentinel'
    theme = 'light'
    locale = 'zh-CN'
    proxy = @{ enabled = $false; type = 'http'; host = ''; port = 7890 }
  } | ConvertTo-Json -Depth 4)

  $projectManifest = [ordered]@{
    schemaVersion = 1
    kind = 'ai-novel-project'
    projectId = '00000000-0000-4000-8000-000000000017'
    createdAt = '2026-08-07T00:00:00.000Z'
  }
  & $writeUtf8 (Join-Path $recentProjectMetadataRoot 'project.json') ($projectManifest | ConvertTo-Json -Depth 4)
  & $writeUtf8 (Join-Path $recentProjectDraftsRoot 'chapter-017.md') "# Chapter 17`nThe north-harbor letter remains sealed."
  $recentProjects = @([ordered]@{
    name = 'E2E continuity fixture'
    path = $recentProjectRoot
    updatedAt = '2026-08-07T00:00:00.000Z'
  })
  & $writeUtf8 (Join-Path $velaHome 'recent-projects.json') (ConvertTo-Json -InputObject $recentProjects -Depth 4)

  & $writeUtf8 (Join-Path $promptsRoot 'e2e-continuity.json') (@{
    key = 'e2e-continuity'
    name = 'E2E continuity'
    content = "Keep the heroine's secret, the chapter ledger, and chronology."
  } | ConvertTo-Json -Depth 4)
  & $writeUtf8 (Join-Path $skillsRoot 'SKILL.md') "# E2E continuity fixture`n`nPreserve user-authored continuity evidence across update."
  & $writeUtf8 (Join-Path $preservationRoot 'character-card.json') (@{
    character = 'E2E protagonist'
    unresolvedThread = 'unopened north-harbor letter'
    chapter = 17
  } | ConvertTo-Json -Depth 4)
  & $writeUtf8 (Join-Path $preservationRoot 'chapter-017.md') "# Chapter 17`nThe north-harbor letter remains sealed."
  & $writeUtf8 (Join-Path $preservationRoot 'continuity-ledger.txt') 'timeline=2026-08-07; protagonist=e2e-protagonist; promise=return north'

  return [pscustomobject][ordered]@{
    isolatedHome = $isolatedHome
    velaHome = $velaHome
    preservationRoot = $preservationRoot
    recentProjectRoot = $recentProjectRoot
    frozenUserDataPaths = @(
      'prompts/e2e-continuity.json',
      'skills/continuity-e2e/SKILL.md',
      'e2e-preservation/character-card.json',
      'e2e-preservation/chapter-017.md',
      'e2e-preservation/continuity-ledger.txt'
    )
    recentProjectFrozenPaths = @(
      '.vela/project.json',
      'drafts/chapter-017.md'
    )
  }
}

function Get-E2eJsonWhenAvailable {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    return $null
  }
}

function Read-E2eRequiredJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $Path -PathType Leaf) -Message "$Label is missing: $Path"
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    throw "$Label is not valid JSON: $($_.Exception.Message)"
  }
}

function Assert-E2eManagedConfigPreserved {
  param(
    [Parameter(Mandatory = $true)]$Before,
    [Parameter(Mandatory = $true)]$After
  )

  foreach ($propertyName in @('e2eUserSentinel', 'theme', 'locale')) {
    Assert-E2eCondition -Condition ($Before.PSObject.Properties.Name -contains $propertyName) -Message "Seeded config is missing required $propertyName value."
    Assert-E2eCondition -Condition ($After.PSObject.Properties.Name -contains $propertyName) -Message "Managed config lost the seeded $propertyName value."
    Assert-E2eCondition -Condition ([string]$After.$propertyName -eq [string]$Before.$propertyName) -Message "Managed config changed the seeded $propertyName value."
  }
  Assert-E2eCondition -Condition ($null -ne $Before.proxy -and $null -ne $After.proxy) -Message 'Managed config lost the seeded proxy settings.'
  foreach ($propertyName in @('enabled', 'type', 'host', 'port')) {
    Assert-E2eCondition -Condition ($Before.proxy.PSObject.Properties.Name -contains $propertyName) -Message "Seeded proxy config is missing required $propertyName value."
    Assert-E2eCondition -Condition ($After.proxy.PSObject.Properties.Name -contains $propertyName) -Message "Managed config lost the seeded proxy $propertyName value."
    Assert-E2eCondition -Condition ([string]$After.proxy.$propertyName -eq [string]$Before.proxy.$propertyName) -Message "Managed config changed the seeded proxy $propertyName value."
  }
}

function Assert-E2eRecentProjectPreserved {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$RecentProjects,
    [Parameter(Mandatory = $true)][string]$ExpectedProjectRoot
  )

  $matches = @(
    $RecentProjects | Where-Object {
      $null -ne $_ -and
      $_.PSObject.Properties.Name -contains 'path' -and
      -not [string]::IsNullOrWhiteSpace([string]$_.path) -and
      (Test-E2eSameAbsolutePath -Left ([string]$_.path) -Right $ExpectedProjectRoot)
    }
  )
  Assert-E2eCondition -Condition ($matches.Count -eq 1) -Message 'Managed recent projects did not retain exactly one entry for the seeded recent project.'
}

function Wait-E2eMonitorState {
  param(
    [Parameter(Mandatory = $true)][string]$StatusPath,
    [Parameter(Mandatory = $true)][string]$ExpectedState,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastStatus = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $status = Get-E2eJsonWhenAvailable -Path $StatusPath
    if ($null -ne $status) {
      $lastStatus = $status
      if ([string]$status.state -eq 'failed') {
        throw "Release monitor failed during $($Phase): $([string]$status.failure)"
      }
      if ([string]$status.state -eq $ExpectedState) {
        return $status
      }
    }
    Start-Sleep -Milliseconds 100
  }
  $lastState = if ($null -ne $lastStatus) { [string]$lastStatus.state } else { 'missing' }
  throw "Timed out waiting for release monitor $Phase state '$ExpectedState'. Last state: $lastState"
}

function Add-E2eMonitorControl {
  param(
    [Parameter(Mandatory = $true)][string]$ControlPath,
    [Parameter(Mandatory = $true)][hashtable]$Payload
  )

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $ControlPath -PathType Leaf) -Message "Release monitor control file is missing: $ControlPath"
  $lastRecord = $null
  foreach ($line in @(Get-Content -LiteralPath $ControlPath -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $lastRecord = $line | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Release monitor control file contains malformed JSON."
    }
  }
  Assert-E2eCondition -Condition ($null -ne $lastRecord -and $null -ne $lastRecord.sequence) -Message 'Release monitor control file does not contain an initial sequence.'
  $record = [ordered]@{ sequence = ([int]$lastRecord.sequence + 1) }
  foreach ($key in $Payload.Keys) {
    $record[$key] = $Payload[$key]
  }
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::AppendAllText($ControlPath, (([pscustomobject]$record | ConvertTo-Json -Depth 8 -Compress) + "`n"), $encoding)
}

function Test-E2eSameAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  try {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath($Left),
      [System.IO.Path]::GetFullPath($Right),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  catch {
    return $false
  }
}

function Test-E2eLegacyBridgeSourceTag {
  param([Parameter(Mandatory = $true)][string]$SourceTag)

  if ($SourceTag -notmatch '^v\d+\.\d+\.\d+$') {
    throw "Legacy bridge source tag is not a final semantic version: $SourceTag"
  }
  return ([version]$SourceTag.Substring(1)) -lt ([version]'0.7.0')
}

function Get-E2eExpectedPendingInstallerPath {
  param([Parameter(Mandatory = $true)]$Plan)

  Assert-E2eCondition -Condition ($env:LOCALAPPDATA -match '^[A-Za-z]:\\') -Message 'The Windows in-app update E2E requires an absolute LOCALAPPDATA path.'
  $installerName = [string]$Plan.expected.assets.installer.name
  Assert-E2eCondition -Condition ($installerName -match '^ai-novel-writer-setup-\d+\.\d+\.\d+\.exe$') -Message 'The expected pending installer name is unsafe.'
  $pendingRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ai-novel-writer-updater\pending'))
  $pendingInstallerPath = [System.IO.Path]::GetFullPath((Join-Path $pendingRoot $installerName))
  Assert-E2eCondition -Condition ((Split-Path -Parent $pendingInstallerPath) -eq $pendingRoot) -Message 'The expected pending installer path escaped its canonical cache directory.'
  return $pendingInstallerPath
}

function Get-E2eLegacyBridgeContract {
  param([Parameter(Mandatory = $true)]$Plan)

  $sourceTag = [string]$Plan.from.tag
  if (-not (Test-E2eLegacyBridgeSourceTag -SourceTag $sourceTag)) {
    return $null
  }
  Assert-E2eCondition -Condition ($env:AI_NOVEL_RELEASE_GATE -eq 'windows-in-app-update-e2e') -Message 'The legacy bridge is only available inside the Windows in-app update E2E release gate.'
  Assert-E2eCondition -Condition (-not [string]::IsNullOrWhiteSpace($MonitorControlPath)) -Message 'The legacy bridge requires the release monitor control path.'
  Assert-E2eCondition -Condition (-not [string]::IsNullOrWhiteSpace($MonitorStatusPath)) -Message 'The legacy bridge requires the release monitor status path.'
  Assert-E2eCondition -Condition ($env:LOCALAPPDATA -match '^[A-Za-z]:\\') -Message 'The legacy bridge requires an absolute LOCALAPPDATA path.'
  $installer = $Plan.expected.assets.installer
  $installerName = [string]$installer.name
  $installerSha256 = [string]$installer.sha256
  $installerSize = [long]$installer.size
  Assert-E2eCondition -Condition ($installerName -match '^ai-novel-writer-setup-\d+\.\d+\.\d+\.exe$') -Message 'The legacy bridge expected installer name is unsafe.'
  Assert-E2eCondition -Condition ($installerSize -gt 0) -Message 'The legacy bridge expected installer size is invalid.'
  Assert-E2eCondition -Condition ($installerSha256 -match '^[a-fA-F0-9]{64}$') -Message 'The legacy bridge expected installer SHA-256 is invalid.'
  $pendingRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ai-novel-writer-updater\pending'))
  $pendingInstallerPath = [System.IO.Path]::GetFullPath((Join-Path $pendingRoot $installerName))
  Assert-E2eCondition -Condition ((Split-Path -Parent $pendingInstallerPath) -eq $pendingRoot) -Message 'The legacy bridge pending installer path escaped its canonical cache directory.'
  return [pscustomobject][ordered]@{
    mode = 'legacy-bridge'
    sourceTag = $sourceTag
    pendingRoot = $pendingRoot
    pendingInstallerPath = $pendingInstallerPath
    installerName = $installerName
    installerSize = $installerSize
    installerSha256 = $installerSha256.ToLowerInvariant()
  }
}

function Assert-E2ePathHasNoReparseBoundary {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $canonicalRoot = [System.IO.Path]::GetFullPath($Root)
  $canonicalPath = [System.IO.Path]::GetFullPath($Path)
  $rootWithSeparator = $canonicalRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  Assert-E2eCondition -Condition ($canonicalPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) -Message "Legacy bridge path escaped its allowed root: $canonicalPath"
  $candidates = [System.Collections.Generic.List[string]]::new()
  $candidates.Add($canonicalRoot)
  $cursor = $canonicalRoot
  foreach ($segment in $canonicalPath.Substring($rootWithSeparator.Length).Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor = Join-Path $cursor $segment
    $candidates.Add($cursor)
  }
  foreach ($candidate in $candidates) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    Assert-E2eCondition -Condition (-not (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) -Message "Legacy bridge rejected a reparse-point path component: $candidate"
  }
  return $canonicalPath
}

function Test-E2eLegacyBridgePendingInstaller {
  param(
    [Parameter(Mandatory = $true)]$Contract
  )

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $Contract.pendingInstallerPath -PathType Leaf) -Message "Legacy bridge pending installer is missing: $($Contract.pendingInstallerPath)"
  $canonicalPath = Assert-E2ePathHasNoReparseBoundary -Root $Contract.pendingRoot -Path $Contract.pendingInstallerPath
  Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left $canonicalPath -Right $Contract.pendingInstallerPath) -Message 'Legacy bridge pending installer canonical path did not match the expected cache path.'
  $installer = Get-Item -LiteralPath $canonicalPath -Force
  Assert-E2eCondition -Condition ($installer.Name -eq $Contract.installerName) -Message 'Legacy bridge pending installer file name did not match the release plan.'
  Assert-E2eCondition -Condition ($installer.Length -eq [long]$Contract.installerSize) -Message 'Legacy bridge pending installer size did not match the release plan.'
  $sha256 = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-E2eCondition -Condition ($sha256 -eq $Contract.installerSha256) -Message 'Legacy bridge pending installer SHA-256 did not match the release plan.'
  return [pscustomobject][ordered]@{
    path = $canonicalPath
    name = $installer.Name
    size = $installer.Length
    sha256 = $sha256
  }
}

function Get-E2eLiveProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedImagePath
  )

  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    Assert-E2eCondition -Condition (-not $process.HasExited) -Message "Expected process $ProcessId has already exited."
    $startTimeTicks = $process.StartTime.ToUniversalTime().Ticks
    $imagePath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
    Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left $imagePath -Right $ExpectedImagePath) -Message "Process $ProcessId image path did not match its expected identity."
    return [pscustomobject][ordered]@{
      processId = $process.Id
      startTimeTicks = [string]$startTimeTicks
      executablePath = $imagePath
    }
  }
  finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Stop-E2eExactProcess {
  param(
    [Parameter(Mandatory = $true)]$Identity,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$Identity.processId)
    $process.Refresh()
    Assert-E2eCondition -Condition (-not $process.HasExited) -Message "Legacy bridge installer PID $($Identity.processId) exited before controlled termination."
    Assert-E2eCondition -Condition ($process.StartTime.ToUniversalTime().Ticks -eq [long]$Identity.startTimeTicks) -Message 'Legacy bridge installer PID was reused before controlled termination.'
    $imagePath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
    Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left $imagePath -Right ([string]$Identity.executablePath)) -Message 'Legacy bridge installer image changed before controlled termination.'
    $process.Kill($true)
    Assert-E2eCondition -Condition ($process.WaitForExit($TimeoutSeconds * 1000)) -Message 'Legacy bridge installer did not exit after controlled termination.'
  }
  finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Invoke-E2eLegacyBridge {
  param(
    [Parameter(Mandatory = $true)]$Contract,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$StagingRoot,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)]$Evidence
  )

  $observedStatus = Wait-E2eMonitorState -StatusPath $MonitorStatusPath -ExpectedState 'legacy-bridge-observed' -TimeoutSeconds $TimeoutSeconds -Phase 'legacy bridge installer observation'
  $observed = $observedStatus.legacyBridge
  Assert-E2eCondition -Condition ($null -ne $observed -and [string]$observed.mode -eq 'legacy-bridge') -Message 'Release monitor did not publish a legacy bridge observation record.'
  Assert-E2eCondition -Condition ([string]$observed.sourceTag -eq $Contract.sourceTag) -Message 'Release monitor legacy bridge source tag did not match the release plan.'
  Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left ([string]$observed.executablePath) -Right $Contract.pendingInstallerPath) -Message 'Release monitor observed an unexpected legacy installer path.'
  Assert-E2eCondition -Condition ([bool]$observed.commandLineCaptured) -Message 'Release monitor did not capture the legacy installer command line for record-only evidence.'
  $installerIdentity = [pscustomobject][ordered]@{
    processId = [int]$observed.processId
    startTimeTicks = [string]$observed.startTimeTicks
    executablePath = [string]$observed.executablePath
  }
  $pending = Test-E2eLegacyBridgePendingInstaller -Contract $Contract
  $Evidence.legacyInstallerHandoffObserved = $true
  $Evidence.pendingInstallerDigestMatched = $true
  $Evidence.legacyBridge.pendingInstaller = $pending
  $Evidence.legacyBridge.observedInstaller = [ordered]@{
    processId = $installerIdentity.processId
    startTimeTicks = $installerIdentity.startTimeTicks
    executablePath = $installerIdentity.executablePath
    commandLineCaptured = $true
    commandLineAuthorizationMode = 'record-only'
  }

  New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
  $stagingInstaller = Join-Path $StagingRoot $Contract.installerName
  Assert-E2eCondition -Condition (-not (Test-Path -LiteralPath $stagingInstaller)) -Message "Legacy bridge staging path already exists: $stagingInstaller"
  Copy-Item -LiteralPath $pending.path -Destination $stagingInstaller -ErrorAction Stop
  $staged = Get-Item -LiteralPath $stagingInstaller -Force
  Assert-E2eCondition -Condition ($staged.Length -eq [long]$Contract.installerSize) -Message 'Legacy bridge staging installer size did not match the release plan.'
  $stagedSha256 = (Get-FileHash -LiteralPath $stagingInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-E2eCondition -Condition ($stagedSha256 -eq $Contract.installerSha256) -Message 'Legacy bridge staging installer SHA-256 did not match the release plan.'
  $Evidence.legacyBridge.stagingInstaller = [ordered]@{
    path = $stagingInstaller
    size = $staged.Length
    sha256 = $stagedSha256
  }

  Add-E2eMonitorControl -ControlPath $MonitorControlPath -Payload @{
    state = 'legacy-bridge-authorize'
    step = 'windows-in-app-update-e2e'
    sourceTag = $Contract.sourceTag
    processId = $installerIdentity.processId
    processStartTimeTicks = $installerIdentity.startTimeTicks
    executablePath = $installerIdentity.executablePath
    pendingInstallerDigestMatched = $true
    stagingInstallerSha256 = $stagedSha256
  }
  [void](Wait-E2eMonitorState -StatusPath $MonitorStatusPath -ExpectedState 'legacy-bridge-authorized' -TimeoutSeconds 15 -Phase 'legacy bridge authorization')
  $terminationIdentity = Get-E2eLiveProcessIdentity -ProcessId $installerIdentity.processId -ExpectedImagePath $installerIdentity.executablePath
  Assert-E2eCondition -Condition ($terminationIdentity.startTimeTicks -eq $installerIdentity.startTimeTicks) -Message 'Legacy bridge installer identity changed before controlled termination.'
  Add-E2eMonitorControl -ControlPath $MonitorControlPath -Payload @{
    state = 'legacy-bridge-terminate'
    step = 'windows-in-app-update-e2e'
    sourceTag = $Contract.sourceTag
    processId = $installerIdentity.processId
    processStartTimeTicks = $installerIdentity.startTimeTicks
    executablePath = $installerIdentity.executablePath
  }
  [void](Wait-E2eMonitorState -StatusPath $MonitorStatusPath -ExpectedState 'legacy-bridge-termination-armed' -TimeoutSeconds 15 -Phase 'legacy bridge controlled termination')
  Stop-E2eExactProcess -Identity $terminationIdentity -TimeoutSeconds 15
  $terminatedStatus = Wait-E2eMonitorState -StatusPath $MonitorStatusPath -ExpectedState 'legacy-bridge-terminated' -TimeoutSeconds 15 -Phase 'legacy bridge installer termination'
  $Evidence.legacyInteractiveWizardObserved = [bool]$terminatedStatus.legacyBridge.legacyInteractiveWizardObserved

  $bridgeStdout = Join-Path $resolvedEvidenceRoot 'legacy-bridge-installer.stdout.log'
  $bridgeStderr = Join-Path $resolvedEvidenceRoot 'legacy-bridge-installer.stderr.log'
  Invoke-AiNovelMonitoredExecutable `
    -Path $stagingInstaller `
    -Arguments @('--updated', '/S', '--force-run', "/D=$InstallRoot") `
    -Operation 'Verified legacy bridge silent NSIS installer' `
    -StandardOutputPath $bridgeStdout `
    -StandardErrorPath $bridgeStderr `
    -HideWindow
  $Evidence.bridgeApplied = $true
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

function Wait-E2ePendingInstallerIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedImagePath,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $canonicalExpectedPath = [System.IO.Path]::GetFullPath($ExpectedImagePath)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastObservation = 'no exact pending installer process was observed'
  while ([DateTime]::UtcNow -lt $deadline) {
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
      if ([string]::IsNullOrWhiteSpace([string]$entry.ExecutablePath)) { continue }
      if (-not (Test-E2eSameAbsolutePath -Left ([string]$entry.ExecutablePath) -Right $canonicalExpectedPath)) { continue }
      try {
        $matches.Add((Get-E2eLiveProcessIdentity -ProcessId ([int]$entry.ProcessId) -ExpectedImagePath $canonicalExpectedPath))
      }
      catch [System.ArgumentException] {
        $lastObservation = "pending installer PID $($entry.ProcessId) exited while its exact identity was being captured"
      }
    }
    if ($matches.Count -eq 1) {
      return $matches[0]
    }
    if ($matches.Count -gt 1) {
      throw "Observed multiple exact pending installer processes at $canonicalExpectedPath."
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Did not observe the exact pending installer before timeout: $canonicalExpectedPath. Last observation: $lastObservation"
}

function Wait-E2ePendingInstallerRootExit {
  param(
    [Parameter(Mandatory = $true)]$Identity,
    [Parameter(Mandatory = $true)][string]$ExpectedImagePath,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$PollMilliseconds = 100,
    [scriptblock]$ProcessIdentityProvider
  )

  $expectedProcessId = [int]$Identity.processId
  $expectedStartTimeTicks = [long]$Identity.startTimeTicks
  $canonicalExpectedPath = [System.IO.Path]::GetFullPath($ExpectedImagePath)
  Assert-E2eCondition -Condition ($expectedProcessId -gt 0) -Message 'Pending installer identity does not contain a valid PID.'
  Assert-E2eCondition -Condition ($expectedStartTimeTicks -gt 0) -Message 'Pending installer identity does not contain a valid start time.'
  Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left ([string]$Identity.executablePath) -Right $canonicalExpectedPath) -Message 'Pending installer identity path does not match the expected cache path.'
  Assert-E2eCondition -Condition ($PollMilliseconds -gt 0) -Message 'Pending installer root-exit polling interval must be positive.'
  if ($null -eq $ProcessIdentityProvider) {
    $ProcessIdentityProvider = {
      param($CandidateIdentity)
      $process = $null
      try {
        try {
          $process = [System.Diagnostics.Process]::GetProcessById([int]$CandidateIdentity.processId)
        }
        catch [System.ArgumentException] {
          return $null
        }
        $process.Refresh()
        if ($process.HasExited) { return $null }
        return [pscustomobject][ordered]@{
          processId = [int]$process.Id
          startTimeTicks = [string]($process.StartTime.ToUniversalTime().Ticks)
          executablePath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
        }
      }
      catch [System.InvalidOperationException] {
        return $null
      }
      finally {
        if ($null -ne $process) { $process.Dispose() }
      }
    }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $observed = & $ProcessIdentityProvider $Identity
    if ($null -eq $observed) {
      return
    }
    Assert-E2eCondition -Condition ([int]$observed.processId -eq $expectedProcessId) -Message 'Pending installer PID changed before exit.'
    Assert-E2eCondition -Condition ([long]$observed.startTimeTicks -eq $expectedStartTimeTicks) -Message 'Pending installer start time changed before exit.'
    Assert-E2eCondition -Condition (Test-E2eSameAbsolutePath -Left ([string]$observed.executablePath) -Right $canonicalExpectedPath) -Message 'Pending installer path changed before exit.'
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  throw "Exact pending installer root did not exit before timeout: PID $expectedProcessId at $canonicalExpectedPath"
}

function Get-E2eInstallRootFingerprint {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)

  Assert-E2eCondition -Condition (Test-Path -LiteralPath $InstallRoot -PathType Container) -Message "Installed app root is missing: $InstallRoot"
  $canonicalRoot = (Resolve-Path -LiteralPath $InstallRoot).Path.TrimEnd('\\', '/')
  $entries = @(
    Get-ChildItem -LiteralPath $canonicalRoot -File -Recurse -ErrorAction Stop | Sort-Object FullName | ForEach-Object {
      $relativePath = $_.FullName.Substring($canonicalRoot.Length).TrimStart('\\', '/') -replace '\\', '/'
      "${relativePath}:$($_.Length):$($_.LastWriteTimeUtc.Ticks)"
    }
  )
  return ((@("root:$((Get-Item -LiteralPath $canonicalRoot -Force).LastWriteTimeUtc.Ticks)") + $entries) -join "`n")
}

function Wait-E2eInstallRootStable {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$ElectronRunner,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$StableSeconds = 2
  )

  Assert-E2eCondition -Condition ($StableSeconds -gt 0) -Message 'Install-root stability duration must be positive.'
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastObservation = $null
  $lastFingerprint = $null
  $stableSince = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $lastObservation = Get-E2eInstalledVersion -ExePath $ExePath -ElectronRunner $ElectronRunner
      if ($lastObservation -eq $ExpectedVersion) {
        $fingerprint = Get-E2eInstallRootFingerprint -InstallRoot $InstallRoot
        if ($fingerprint -eq $lastFingerprint) {
          if ($null -eq $stableSince) {
            $stableSince = [DateTime]::UtcNow
          }
          elseif (([DateTime]::UtcNow - $stableSince).TotalSeconds -ge $StableSeconds) {
            return $lastObservation
          }
        }
        else {
          $lastFingerprint = $fingerprint
          $stableSince = [DateTime]::UtcNow
        }
      }
      else {
        $lastFingerprint = $null
        $stableSince = $null
      }
    }
    catch {
      $lastObservation = $_.Exception.Message
      $lastFingerprint = $null
      $stableSince = $null
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Installed app root did not remain stable at v$ExpectedVersion after in-app update. Last observation: $lastObservation"
}

function Get-E2eInstalledAppProcesses {
  param([Parameter(Mandatory = $true)][string]$ExePath)

  $canonicalExe = [System.IO.Path]::GetFullPath($ExePath)
  return @(
    $entries = @(Get-CimInstance Win32_Process -Filter "Name = '$appExecutableName'" -ErrorAction Stop | Where-Object {
      -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
      [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($canonicalExe, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($entry in $entries) {
      $process = $null
      try {
        try {
          $process = [System.Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)
        }
        catch [System.ArgumentException] {
          continue
        }
        $process.Refresh()
        if ($process.HasExited) { continue }
        $currentPath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
        if (-not $currentPath.Equals($canonicalExe, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw 'Existing installed application path changed while capturing cleanup identity.'
        }
        [pscustomobject]@{
          ProcessId = [int]$process.Id
          StartTimeTicks = [string]($process.StartTime.ToUniversalTime().Ticks)
          ExecutablePath = $currentPath
        }
      }
      finally {
        if ($null -ne $process) { $process.Dispose() }
      }
    }
  )
}

function Stop-E2eExistingInstalledApps {
  param([Parameter(Mandatory = $true)][string]$ExePath)

  foreach ($entry in @(Get-E2eInstalledAppProcesses -ExePath $ExePath)) {
    $process = $null
    try {
      try {
        $process = [System.Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)
      }
      catch [System.ArgumentException] {
        continue
      }
      $canonicalExe = [System.IO.Path]::GetFullPath($ExePath)
      if (-not [System.IO.Path]::GetFullPath([string]$entry.ExecutablePath).Equals($canonicalExe, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Existing installed application path changed before cleanup.'
      }
      if (
        [string]::IsNullOrWhiteSpace([string]$entry.StartTimeTicks) -or
        [long]$entry.StartTimeTicks -le 0
      ) {
        throw 'Existing installed application identity changed before cleanup.'
      }
      $process.Refresh()
      if ($process.HasExited) { continue }
      if ($process.StartTime.ToUniversalTime().Ticks -ne [long]$entry.StartTimeTicks) {
        throw 'Existing installed application identity changed before cleanup.'
      }
      $currentPath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
      if (-not $currentPath.Equals($canonicalExe, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Existing installed application path changed before cleanup.'
      }
      $processIds = [System.Collections.Generic.HashSet[int]]::new()
      $startTimeTicks = @{}
      Add-AiNovelTrackedProcess -ProcessIds $processIds -StartTimeTicks $startTimeTicks -ProcessId $process.Id | Out-Null
      Add-AiNovelTrackedProcessTree -RootProcessId $process.Id -ProcessIds $processIds -StartTimeTicks $startTimeTicks
      $process.Refresh()
      if ($process.HasExited) { continue }
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
$legacyBridgeContract = $null
$oldAppIdentity = $null
$preTriggerOldAppIdentity = $null
$pendingInstallerIdentity = $null
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
  $legacyBridgeContract = Get-E2eLegacyBridgeContract -Plan $plan
  $expectedPendingInstallerPath = Get-E2eExpectedPendingInstallerPath -Plan $plan
  $evidence.mode = if ($null -ne $legacyBridgeContract) { 'legacy-bridge' } else { 'native-silent' }
  $evidence.legacyInstallerHandoffObserved = $false
  $evidence.legacyInteractiveWizardObserved = $false
  $evidence.pendingInstallerDigestMatched = $false
  $evidence.bridgeApplied = $false
  $evidence.nativeSilentSourceVersion = ($null -eq $legacyBridgeContract)
  if ($null -ne $legacyBridgeContract) {
    $evidence.nativeSilentSourceVersion = $false
    $evidence.legacyBridge = [ordered]@{
      sourceTag = $legacyBridgeContract.sourceTag
      expectedPendingInstallerPath = $legacyBridgeContract.pendingInstallerPath
      expectedInstaller = [ordered]@{
        name = $legacyBridgeContract.installerName
        size = $legacyBridgeContract.installerSize
        sha256 = $legacyBridgeContract.installerSha256
      }
    }
  }
  $fromInstaller = [System.IO.Path]::GetFullPath([string]$plan.from.assets.installer.downloadedPath)
  Assert-E2eCondition -Condition (Test-Path -LiteralPath $fromInstaller -PathType Leaf) -Message "Downloaded official from_tag installer is missing: $fromInstaller"
  Assert-E2eCondition -Condition ((Get-FileHash -LiteralPath $fromInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -eq ([string]$plan.from.assets.installer.sha256).ToLowerInvariant()) -Message 'Downloaded official from_tag installer SHA-256 changed before install.'

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $e2eInstallRoot = Join-Path $runtimeRoot 'installed-app'
  $chromiumUserDataDir = Join-Path $runtimeRoot 'chromium-profile'
  New-Item -ItemType Directory -Path $chromiumUserDataDir -Force | Out-Null
  $userDataFixture = New-E2eUserDataFixture -RuntimeRoot $runtimeRoot
  $e2eIsolatedHome = [string]$userDataFixture.isolatedHome
  $e2eVelaHome = [string]$userDataFixture.velaHome
  $e2ePreservationRoot = [string]$userDataFixture.preservationRoot
  $e2eRecentProjectRoot = [string]$userDataFixture.recentProjectRoot
  $e2eFrozenUserDataPaths = @($userDataFixture.frozenUserDataPaths)
  $e2eRecentProjectFrozenPaths = @($userDataFixture.recentProjectFrozenPaths)
  $e2eConfigPath = Join-Path $e2eVelaHome 'config.json'
  $e2eRecentProjectsPath = Join-Path $e2eVelaHome 'recent-projects.json'
  $beforeManagedConfig = Read-E2eRequiredJsonFile -Path $e2eConfigPath -Label 'Seeded managed config'
  $beforeRecentProjects = @(Read-E2eRequiredJsonFile -Path $e2eRecentProjectsPath -Label 'Seeded recent projects')
  [void](Assert-E2eRecentProjectPreserved -RecentProjects $beforeRecentProjects -ExpectedProjectRoot $e2eRecentProjectRoot)
  $beforeFrozenUserData = Get-E2eFrozenFileManifest -Root $e2eVelaHome -RelativePaths $e2eFrozenUserDataPaths
  $beforeRecentProject = Get-E2eFrozenFileManifest -Root $e2eRecentProjectRoot -RelativePaths $e2eRecentProjectFrozenPaths
  $beforePreservation = Get-E2eSha256Manifest -Root $e2ePreservationRoot
  $beforeVelaHome = Get-E2eSha256Manifest -Root $e2eVelaHome
  $evidence.userData = [ordered]@{
    isolatedUserHome = $e2eIsolatedHome
    velaHome = $e2eVelaHome
    preservationRoot = $e2ePreservationRoot
    recentProjectRoot = $e2eRecentProjectRoot
    managedConfigSentinel = [string]$beforeManagedConfig.e2eUserSentinel
    recentProjectCanonicalPath = [System.IO.Path]::GetFullPath($e2eRecentProjectRoot)
    frozenFilesBefore = $beforeFrozenUserData
    recentProjectFrozenFilesBefore = $beforeRecentProject
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

  $env:USERPROFILE = $e2eIsolatedHome
  $env:HOME = $e2eIsolatedHome
  $env:AI_NOVEL_VELA_HOME = $e2eVelaHome
  $oldDebugPort = Get-E2eFreeTcpPort
  $oldAppStdout = Join-Path $resolvedEvidenceRoot 'old-app.stdout.log'
  $oldAppStderr = Join-Path $resolvedEvidenceRoot 'old-app.stderr.log'
  $oldElectronLog = Join-Path $resolvedEvidenceRoot 'old-electron.log'
  $oldAppProcess = Start-Process -FilePath $oldExe -ArgumentList @(
    "--remote-debugging-port=$oldDebugPort",
    '--disable-gpu',
    "--user-data-dir=$chromiumUserDataDir",
    '--enable-logging',
    '--v=1',
    "--log-file=$oldElectronLog"
  ) -PassThru -RedirectStandardOutput $oldAppStdout -RedirectStandardError $oldAppStderr
  [void]$oldAppProcess.Handle
  Add-AiNovelTrackedProcess -ProcessIds $oldAppIds -StartTimeTicks $oldAppStartTimes -ProcessId $oldAppProcess.Id | Out-Null
  Add-AiNovelTrackedProcessTree -RootProcessId $oldAppProcess.Id -ProcessIds $oldAppIds -StartTimeTicks $oldAppStartTimes
  $oldEndpoint = Wait-E2eCdpEndpoint -Port $oldDebugPort -TimeoutSeconds 45
  if ($null -ne $legacyBridgeContract) {
    $oldAppIdentity = Get-E2eLiveProcessIdentity -ProcessId $oldAppProcess.Id -ExpectedImagePath $oldExe
    Add-E2eMonitorControl -ControlPath $MonitorControlPath -Payload @{
      state = 'legacy-bridge-arm'
      step = 'windows-in-app-update-e2e'
      sourceTag = $legacyBridgeContract.sourceTag
      processId = $oldAppIdentity.processId
      processStartTimeTicks = $oldAppIdentity.startTimeTicks
      executablePath = $oldAppIdentity.executablePath
      installRoot = $e2eInstallRoot
    }
    [void](Wait-E2eMonitorState -StatusPath $MonitorStatusPath -ExpectedState 'legacy-bridge-armed' -TimeoutSeconds 15 -Phase 'legacy bridge pre-arm')
    $preTriggerOldAppIdentity = Get-E2eLiveProcessIdentity -ProcessId $oldAppIdentity.processId -ExpectedImagePath $oldAppIdentity.executablePath
    Assert-E2eCondition -Condition ($preTriggerOldAppIdentity.startTimeTicks -eq $oldAppIdentity.startTimeTicks) -Message 'Old application identity changed before triggering the legacy updater handoff.'
  }
  & node (Join-Path $PSScriptRoot 'windows-in-app-update-e2e-driver.mjs') trigger `
    --endpoint $oldEndpoint `
    --expected-version ([string]$plan.expected.version) `
    --evidence-root $resolvedEvidenceRoot
  if ($LASTEXITCODE -ne 0) { throw "Live UI update trigger failed with exit code $LASTEXITCODE." }
  $pendingInstallerIdentity = Wait-E2ePendingInstallerIdentity `
    -ExpectedImagePath $expectedPendingInstallerPath `
    -TimeoutSeconds $ApplicationTimeoutSeconds
  $evidence.oldApplication = [ordered]@{
    processId = $oldAppProcess.Id
    cdpEndpoint = $oldEndpoint
    triggerEvidence = 'ui-trigger.json'
    exactIdentityBeforeTrigger = $preTriggerOldAppIdentity
  }
  $evidence.pendingInstaller = [ordered]@{
    expectedPath = $expectedPendingInstallerPath
    exactIdentity = $pendingInstallerIdentity
  }

  $oldAppProcess.WaitForExit($ApplicationTimeoutSeconds * 1000) | Out-Null
  $oldAppProcess.Refresh()
  Assert-E2eCondition -Condition $oldAppProcess.HasExited -Message 'Old application did not exit after the live Restart and update now click.'
  if ($null -ne $legacyBridgeContract) {
    Invoke-E2eLegacyBridge `
      -Contract $legacyBridgeContract `
      -InstallRoot $e2eInstallRoot `
      -StagingRoot (Join-Path $runtimeRoot 'legacy-bridge-staging') `
      -TimeoutSeconds $ApplicationTimeoutSeconds `
      -Evidence $evidence
  }
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
  Wait-E2ePendingInstallerRootExit `
    -Identity $pendingInstallerIdentity `
    -ExpectedImagePath $expectedPendingInstallerPath `
    -TimeoutSeconds $ApplicationTimeoutSeconds
  Stop-E2eExistingInstalledApps -ExePath $updatedExe
  $installedUpdatedVersion = Wait-E2eInstallRootStable `
    -InstallRoot $e2eInstallRoot `
    -ExePath $updatedExe `
    -ElectronRunner $electronRunner `
    -ExpectedVersion ([string]$plan.expected.version) `
    -TimeoutSeconds $ApplicationTimeoutSeconds
  $newDebugPort = Get-E2eFreeTcpPort
  $newAppStdout = Join-Path $resolvedEvidenceRoot 'updated-app.stdout.log'
  $newAppStderr = Join-Path $resolvedEvidenceRoot 'updated-app.stderr.log'
  $updatedElectronLog = Join-Path $resolvedEvidenceRoot 'updated-electron.log'
  $newAppProcess = Start-Process -FilePath $updatedExe -ArgumentList @(
    "--remote-debugging-port=$newDebugPort",
    '--disable-gpu',
    "--user-data-dir=$chromiumUserDataDir",
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

  $afterFrozenUserData = Get-E2eFrozenFileManifest -Root $e2eVelaHome -RelativePaths $e2eFrozenUserDataPaths
  $afterRecentProject = Get-E2eFrozenFileManifest -Root $e2eRecentProjectRoot -RelativePaths $e2eRecentProjectFrozenPaths
  $afterPreservation = Get-E2eSha256Manifest -Root $e2ePreservationRoot
  $afterVelaHome = Get-E2eSha256Manifest -Root $e2eVelaHome
  $afterManagedConfig = Read-E2eRequiredJsonFile -Path $e2eConfigPath -Label 'Updated managed config'
  $afterRecentProjects = @(Read-E2eRequiredJsonFile -Path $e2eRecentProjectsPath -Label 'Updated recent projects')
  Assert-E2eManagedConfigPreserved -Before $beforeManagedConfig -After $afterManagedConfig
  Assert-E2eRecentProjectPreserved -RecentProjects $afterRecentProjects -ExpectedProjectRoot $e2eRecentProjectRoot
  Assert-E2eFrozenFileManifestUnchanged -Before $beforeFrozenUserData -After $afterFrozenUserData
  Assert-E2eFrozenFileManifestUnchanged -Before $beforeRecentProject -After $afterRecentProject
  Assert-E2eCondition -Condition ($beforePreservation.sha256 -eq $afterPreservation.sha256) -Message 'The representative ~/.vela preservation fixture changed during the in-app update.'
  $evidence.userData.frozenFilesAfter = $afterFrozenUserData
  $evidence.userData.frozenFilesHashMatched = $true
  $evidence.userData.recentProjectFrozenFilesAfter = $afterRecentProject
  $evidence.userData.recentProjectFrozenFilesHashMatched = $true
  $evidence.userData.managedConfigSemanticsPreserved = $true
  $evidence.userData.recentProjectSemanticsPreserved = $true
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
