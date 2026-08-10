param(
  [string]$ExePath,
  [int]$ObservationSeconds = 30,
  [string]$VelaHome,
  [System.Collections.Generic.HashSet[string]]$WindowBaselineIdentities,
  [System.Collections.Generic.HashSet[int]]$RelatedProcessIds,
  [hashtable]$RelatedProcessStartTimeTicks,
  [string[]]$RelatedTargetNames = @(),
  [int]$PostExitQuietSeconds = 5,
  [switch]$LoadProbeLibrary,
  [string]$ProjectPathToOpen,
  [string]$LegacyProjectPathToOpen,
  [string]$AcceptanceDirectory,
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'AiNovelSmoke.TopLevelWindowProbe').Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace AiNovelSmoke {
  public static class TopLevelWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr handle);
  }
}
'@
}

function Get-AiNovelProcessTreeIds {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [long]$RootStartTimeTicks = 0,
    [scriptblock]$ProcessStartTimeProvider,
    [hashtable]$DiscoveredStartTimeTicks,
    [switch]$RequireSuccessfulTerminalRefresh,
    [scriptblock]$ProcessChildrenProvider
  )

  if ($null -eq $ProcessStartTimeProvider) {
    $ProcessStartTimeProvider = {
      param([int]$ProcessId)
      try {
        $candidate = [System.Diagnostics.Process]::GetProcessById($ProcessId)
        $ticks = $candidate.StartTime.ToUniversalTime().Ticks
        $candidate.Dispose()
        return [long]$ticks
      }
      catch {
        return $null
      }
    }
  }

  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($RootProcessId)
  if ($RootStartTimeTicks -le 0) {
    $rootIdentity = & $ProcessStartTimeProvider $RootProcessId
    if ($null -eq $rootIdentity) {
      if ($RequireSuccessfulTerminalRefresh) {
        throw "Cannot refresh terminal process lineage for root PID $RootProcessId without its original start time."
      }
      return @($processIds)
    }
    $RootStartTimeTicks = [long]$rootIdentity
  }
  if ($null -ne $DiscoveredStartTimeTicks) {
    $DiscoveredStartTimeTicks[[string]$RootProcessId] = [long]$RootStartTimeTicks
  }

  $pending = [System.Collections.Generic.Queue[object]]::new()
  $pending.Enqueue([pscustomobject]@{
    ProcessId = $RootProcessId
    StartTimeTicks = $RootStartTimeTicks
  })
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    $parentProcessId = [int]$parent.ProcessId
    $currentParentStartTimeTicks = & $ProcessStartTimeProvider $parentProcessId
    $isExitedRootTerminalRefresh = (
      $RequireSuccessfulTerminalRefresh -and
      $parentProcessId -eq $RootProcessId -and
      $null -eq $currentParentStartTimeTicks
    )
    if ($null -eq $currentParentStartTimeTicks -and -not $isExitedRootTerminalRefresh) {
      # ParentProcessId is only meaningful for the exact process instance.
      # If that instance exited, ordinary polling must not guess at children.
      continue
    }
    if (
      $null -ne $currentParentStartTimeTicks -and
      [long]$currentParentStartTimeTicks -ne [long]$parent.StartTimeTicks
    ) {
      # ParentProcessId is only meaningful for the exact process instance.
      # If Windows reused the PID, never follow the replacement process's
      # children into the application tree, including during terminal refresh.
      if ($RequireSuccessfulTerminalRefresh -and $parentProcessId -eq $RootProcessId) {
        throw "Could not complete terminal process lineage refresh for root PID $RootProcessId because Windows reused its PID."
      }
      continue
    }
    try {
      if ($null -ne $ProcessChildrenProvider) {
        $children = @(& $ProcessChildrenProvider $parentProcessId)
      }
      elseif ($RequireSuccessfulTerminalRefresh) {
        # A terminal refresh is a proof obligation: an unavailable CIM query is
        # not evidence that the exited root had no descendants.
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentProcessId" -ErrorAction Stop)
      }
      else {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentProcessId" -ErrorAction SilentlyContinue)
      }
    }
    catch {
      if ($RequireSuccessfulTerminalRefresh) {
        throw "Could not complete terminal process lineage refresh for parent PID ${parentProcessId}: $($_.Exception.Message)"
      }
      continue
    }
    foreach ($child in $children) {
      try {
        $childStartTimeTicks = ([DateTime]$child.CreationDate).ToUniversalTime().Ticks
      }
      catch {
        # A child without a trustworthy creation time cannot be proven to belong
        # to this process instance. This avoids following a stale parent PID after
        # Windows reuses that PID for a newer application process.
        continue
      }
      if ($childStartTimeTicks -lt [long]$parent.StartTimeTicks) {
        continue
      }
      if ($processIds.Add([int]$child.ProcessId)) {
        if ($null -ne $DiscoveredStartTimeTicks) {
          $DiscoveredStartTimeTicks[[string][int]$child.ProcessId] = [long]$childStartTimeTicks
        }
        $pending.Enqueue([pscustomobject]@{
          ProcessId = [int]$child.ProcessId
          StartTimeTicks = [long]$childStartTimeTicks
        })
      }
    }
  }
  return @($processIds)
}

function Get-AiNovelTopLevelWindowSnapshot {
  $windows = [System.Collections.Generic.List[object]]::new()
  [AiNovelSmoke.TopLevelWindowProbe]::EnumWindows({
    param($handle, $state)
    $length = [AiNovelSmoke.TopLevelWindowProbe]::GetWindowTextLength($handle)
    $title = [System.Text.StringBuilder]::new([Math]::Max(1, $length + 1))
    if ($length -gt 0) {
      [void][AiNovelSmoke.TopLevelWindowProbe]::GetWindowText($handle, $title, $title.Capacity)
    }
    $className = [System.Text.StringBuilder]::new(256)
    [void][AiNovelSmoke.TopLevelWindowProbe]::GetClassName($handle, $className, $className.Capacity)
    $windowProcessId = 0
    [void][AiNovelSmoke.TopLevelWindowProbe]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
    $processName = '<exited>'
    try {
      $owner = [System.Diagnostics.Process]::GetProcessById([int]$windowProcessId)
      $processName = $owner.ProcessName
      $owner.Dispose()
    }
    catch {
      # The owner may exit between EnumWindows and process lookup; retain the PID as evidence.
    }

    $windows.Add([pscustomobject]@{
      WindowHandle = ('0x{0:X}' -f $handle.ToInt64())
      ProcessId = [int]$windowProcessId
      ProcessName = $processName
      Title = $title.ToString()
      ClassName = $className.ToString()
      Visible = [AiNovelSmoke.TopLevelWindowProbe]::IsWindowVisible($handle)
    })
    return $true
  }, [IntPtr]::Zero) | Out-Null

  return @($windows)
}

function Get-AiNovelWindowIdentity {
  param([Parameter(Mandatory = $true)]$Window)
  return '{0}|{1}|{2}|{3}|{4}' -f $Window.WindowHandle, $Window.ProcessId, $Window.Title, $Window.ClassName, $Window.Visible
}

function New-AiNovelWindowIdentitySet {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Windows)

  $identities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($window in $Windows) {
    [void]$identities.Add((Get-AiNovelWindowIdentity -Window $window))
  }
  return ,$identities
}

function Test-AiNovelErrorWindowTitle {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Title)

  return $Title -match '(?i)(应用程序错误|application error|unknown software exception|system error|系统错误|程序无法正常启动|unable to start correctly|bad image|错误的映像|javascript error|runtime error|\bfatal\b|\bcrash(?:ed)?\b|has stopped working|已停止工作|崩溃)'
}

function Test-AiNovelVisibleModalDialog {
  param([Parameter(Mandatory = $true)]$Window)

  return $Window.PSObject.Properties['Visible'] `
    -and [bool]$Window.Visible `
    -and [string]$Window.ClassName -eq '#32770'
}

function Test-AiNovelVisibleTargetWindow {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$TargetProcessIds
  )

  return $Window.PSObject.Properties['Visible'] `
    -and [bool]$Window.Visible `
    -and $TargetProcessIds.Contains([int]$Window.ProcessId)
}

function Test-AiNovelVisibleMainWindow {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$TargetProcessIds
  )

  if (-not (Test-AiNovelVisibleTargetWindow -Window $Window -TargetProcessIds $TargetProcessIds)) {
    return $false
  }
  if ([string]$Window.ClassName -ne 'Chrome_WidgetWin_1') {
    return $false
  }

  $title = [string]$Window.Title
  if ([string]::IsNullOrWhiteSpace($title)) {
    return $false
  }
  return $title.IndexOf('AI小说作家', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -or $title.IndexOf('AI Novel Writer', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function New-AiNovelMainWindowContinuityState {
  return [pscustomobject]@{
    Seen = $false
    MissingSinceUtc = $null
  }
}

function Assert-AiNovelMainWindowContinuity {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][bool]$Visible,
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [int]$GraceMilliseconds = 1000
  )

  if ($Visible) {
    $State.Seen = $true
    $State.MissingSinceUtc = $null
    return
  }
  if (-not [bool]$State.Seen) {
    return
  }
  if ($null -eq $State.MissingSinceUtc) {
    $State.MissingSinceUtc = $NowUtc
    return
  }
  if (($NowUtc - [DateTime]$State.MissingSinceUtc).TotalMilliseconds -ge $GraceMilliseconds) {
    throw "Application main window disappeared for more than $GraceMilliseconds milliseconds during the smoke-test observation period."
  }
}

function Test-AiNovelErrorWindowTargetsProduct {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$TargetProcessIds,
    [hashtable]$TargetProcessStartTimeTicks = @{},
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$TargetNames
  )

  if ($TargetProcessIds.Contains([int]$Window.ProcessId)) {
    $matchesTrackedIdentity = $TargetProcessStartTimeTicks.Count -eq 0
    if (-not $matchesTrackedIdentity) {
      $matchesTrackedIdentity = Test-AiNovelHistoricalProcessIdentity `
        -ProcessId ([int]$Window.ProcessId) `
        -StartTimeTicks $TargetProcessStartTimeTicks
    }
    if ($matchesTrackedIdentity) {
      return $true
    }
  }

  $title = [string]$Window.Title
  $processName = [string]$Window.ProcessName
  foreach ($targetName in $TargetNames) {
    if ([string]::IsNullOrWhiteSpace($targetName)) {
      continue
    }
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($targetName)
    if ($title.IndexOf($targetName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $title.IndexOf($baseName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $processName.Equals($targetName, [System.StringComparison]::OrdinalIgnoreCase) -or
        $processName.Equals($baseName, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  if (-not $processName.Equals('WerFault', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $ownerInfo = $Window
  if (-not $Window.PSObject.Properties['ParentProcessId'] -or
      -not $Window.PSObject.Properties['CommandLine']) {
    $ownerInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($Window.ProcessId)" -ErrorAction SilentlyContinue
  }
  if ($ownerInfo -and $TargetProcessIds.Contains([int]$ownerInfo.ParentProcessId)) {
    $matchesTrackedParent = $TargetProcessStartTimeTicks.Count -eq 0
    if (-not $matchesTrackedParent) {
      $matchesTrackedParent = Test-AiNovelHistoricalProcessIdentity `
        -ProcessId ([int]$ownerInfo.ParentProcessId) `
        -StartTimeTicks $TargetProcessStartTimeTicks
    }
    if ($matchesTrackedParent) {
      return $true
    }
  }
  $commandLine = [string]$ownerInfo.CommandLine
  foreach ($targetProcessId in $TargetProcessIds) {
    if ($commandLine -match "(?<!\d)$([regex]::Escape([string]$targetProcessId))(?!\d)") {
      $matchesTrackedCommandTarget = $TargetProcessStartTimeTicks.Count -eq 0
      if (-not $matchesTrackedCommandTarget) {
        $matchesTrackedCommandTarget = Test-AiNovelHistoricalProcessIdentity `
          -ProcessId ([int]$targetProcessId) `
          -StartTimeTicks $TargetProcessStartTimeTicks
      }
      if ($matchesTrackedCommandTarget) {
        return $true
      }
    }
  }
  return $false
}

function Get-AiNovelNewErrorWindows {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$BaselineIdentities,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$CurrentWindows,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$TargetProcessIds,
    [hashtable]$TargetProcessStartTimeTicks = @{},
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$TargetNames
  )

  $nonEmptyTargetNames = @($TargetNames | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_)
  })
  $hasKnownTarget = $TargetProcessIds.Count -gt 0 -or $nonEmptyTargetNames.Count -gt 0

  return @($CurrentWindows | Where-Object {
    -not $BaselineIdentities.Contains((Get-AiNovelWindowIdentity -Window $_)) -and
    (
      (Test-AiNovelErrorWindowTitle -Title ([string]$_.Title)) -or
      (Test-AiNovelVisibleModalDialog -Window $_)
    ) -and
    (
      -not $hasKnownTarget -or
        (Test-AiNovelErrorWindowTargetsProduct `
         -Window $_ `
         -TargetProcessIds $TargetProcessIds `
         -TargetProcessStartTimeTicks $TargetProcessStartTimeTicks `
         -TargetNames $nonEmptyTargetNames)
    )
  })
}

function Get-AiNovelStartupBlockingErrorWindows {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$CurrentWindows,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$ProductNames
  )

  $emptyProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  return @($CurrentWindows | Where-Object {
    (
      (Test-AiNovelErrorWindowTitle -Title ([string]$_.Title)) -or
      (Test-AiNovelVisibleModalDialog -Window $_)
    ) -and
    (
      ([string]$_.ProcessName).Equals('WerFault', [System.StringComparison]::OrdinalIgnoreCase) -or
      (Test-AiNovelErrorWindowTargetsProduct `
        -Window $_ `
        -TargetProcessIds $emptyProcessIds `
        -TargetNames $ProductNames)
    )
  })
}

function Wait-AiNovelPostExitQuietPeriod {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$BaselineIdentities,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$TargetProcessIds,
    [hashtable]$TargetProcessStartTimeTicks = @{},
    [Parameter(Mandatory = $true)][string[]]$TargetNames,
    [int]$QuietSeconds = 5,
    [scriptblock]$SnapshotProvider,
    [Parameter(Mandatory = $true)][ref]$LastWindowSnapshot
  )

  if ($QuietSeconds -lt 5) {
    throw 'The application post-exit quiet period must be at least 5 seconds.'
  }
  if ($null -eq $SnapshotProvider) {
    $SnapshotProvider = { Get-AiNovelTopLevelWindowSnapshot }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($QuietSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $LastWindowSnapshot.Value = @(& $SnapshotProvider)
    $newErrorWindows = @(Get-AiNovelNewErrorWindows `
      -BaselineIdentities $BaselineIdentities `
      -CurrentWindows $LastWindowSnapshot.Value `
      -TargetProcessIds $TargetProcessIds `
      -TargetProcessStartTimeTicks $TargetProcessStartTimeTicks `
      -TargetNames $TargetNames)
    if ($newErrorWindows.Count -gt 0) {
      throw "Application displayed a new Windows error dialog after exit: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
    }
    Start-Sleep -Milliseconds 100
  }

  # A final snapshot closes the gap between the last polling interval and acceptance.
  $LastWindowSnapshot.Value = @(& $SnapshotProvider)
  $newErrorWindows = @(Get-AiNovelNewErrorWindows `
    -BaselineIdentities $BaselineIdentities `
    -CurrentWindows $LastWindowSnapshot.Value `
    -TargetProcessIds $TargetProcessIds `
    -TargetProcessStartTimeTicks $TargetProcessStartTimeTicks `
    -TargetNames $TargetNames)
  if ($newErrorWindows.Count -gt 0) {
    throw "Application displayed a new Windows error dialog after exit: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
  }
}

function Format-AiNovelWindowEvidence {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Windows)

  return ($Windows | ForEach-Object {
    'handle={0}, pid={1}, process={2}, class={3}, visible={4}, title="{5}"' -f $_.WindowHandle, $_.ProcessId, $_.ProcessName, $_.ClassName, $_.Visible, $_.Title
  }) -join '; '
}

function Add-AiNovelTrackedProcess {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [long]$ExpectedStartTimeTicks = 0
  )
  try {
    $candidate = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    $ticks = $candidate.StartTime.ToUniversalTime().Ticks
    $candidate.Dispose()
    if ($ExpectedStartTimeTicks -gt 0 -and [long]$ticks -ne $ExpectedStartTimeTicks) {
      return $false
    }
    $key = [string]$ProcessId
    if ($StartTimeTicks.ContainsKey($key)) {
      return [long]$StartTimeTicks[$key] -eq [long]$ticks
    }
    [void]$ProcessIds.Add($ProcessId)
    $StartTimeTicks[$key] = [long]$ticks
    return $true
  }
  catch {
    return $false
  }
}

function Test-AiNovelTrackedProcessAlive {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )
  $key = [string]$ProcessId
  if (-not $StartTimeTicks.ContainsKey($key)) { return $false }
  try {
    $candidate = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    $alive = (-not $candidate.HasExited) -and
      ($candidate.StartTime.ToUniversalTime().Ticks -eq [long]$StartTimeTicks[$key])
    $candidate.Dispose()
    return $alive
  }
  catch {
    return $false
  }
}

function Test-AiNovelHistoricalProcessIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )

  $stringKey = [string]$ProcessId
  $startTime = if ($StartTimeTicks.ContainsKey($stringKey)) {
    $StartTimeTicks[$stringKey]
  } elseif ($StartTimeTicks.ContainsKey($ProcessId)) {
    $StartTimeTicks[$ProcessId]
  } else {
    return $false
  }
  try {
    $candidate = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    $sameIdentity = $candidate.StartTime.ToUniversalTime().Ticks -eq [long]$startTime
    $candidate.Dispose()
    return $sameIdentity
  }
  catch {
    # The exact tracked process has exited. Keeping its PID + creation-time pair
    # lets a delayed WerFault command line still be attributed to the product.
    return $true
  }
}

function Get-AiNovelLiveTrackedProcessIds {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )
  $live = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $ProcessIds) {
    if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $StartTimeTicks) {
      [void]$live.Add([int]$processId)
    }
  }
  return ,$live
}

function Add-AiNovelTrackedProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [switch]$RequireSuccessfulTerminalRefresh,
    [scriptblock]$ProcessChildrenProvider
  )
  $rootStartTimeKey = [string]$RootProcessId
  if (-not $StartTimeTicks.ContainsKey($rootStartTimeKey)) {
    if ($RequireSuccessfulTerminalRefresh) {
      throw "Cannot refresh terminal process lineage for untracked root PID $RootProcessId."
    }
    return
  }
  if (
    -not $RequireSuccessfulTerminalRefresh -and
    -not (Test-AiNovelTrackedProcessAlive -ProcessId $RootProcessId -StartTimeTicks $StartTimeTicks)
  ) {
    return
  }
  $rootStartTimeTicks = [long]$StartTimeTicks[$rootStartTimeKey]
  $discoveredStartTimeTicks = @{}
  foreach ($processId in @(Get-AiNovelProcessTreeIds `
      -RootProcessId $RootProcessId `
      -RootStartTimeTicks $rootStartTimeTicks `
      -DiscoveredStartTimeTicks $discoveredStartTimeTicks `
      -RequireSuccessfulTerminalRefresh:$RequireSuccessfulTerminalRefresh `
      -ProcessChildrenProvider $ProcessChildrenProvider)) {
    [void](Add-AiNovelTrackedProcess `
      -ProcessIds $ProcessIds `
      -StartTimeTicks $StartTimeTicks `
      -ProcessId ([int]$processId) `
      -ExpectedStartTimeTicks ([long]$discoveredStartTimeTicks[[string][int]$processId]))
  }
}

function Stop-AiNovelProcessTree {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks
  )

  Add-AiNovelTrackedProcessTree -RootProcessId $Process.Id -ProcessIds $ProcessIds -StartTimeTicks $StartTimeTicks
  foreach ($processId in @($ProcessIds)) {
    if (-not (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $StartTimeTicks)) {
      continue
    }
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    catch {
      # A process disappearing after the identity check is the expected path.
    }
  }
  try {
    [void]$Process.WaitForExit(5000)
  }
  catch {
    # The post-exit window monitor below is authoritative for delayed error dialogs.
  }
}

function Assert-AiNovelProcessTreeExited {
  param(
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [int]$TimeoutSeconds = 5,
    [int]$RootProcessId = 0,
    [scriptblock]$ProcessChildrenProvider
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $terminalLineageRefreshed = $false
  do {
    if (
      $RootProcessId -gt 0 -and
      -not $terminalLineageRefreshed -and
      -not (Test-AiNovelTrackedProcessAlive -ProcessId $RootProcessId -StartTimeTicks $StartTimeTicks)
    ) {
      # Do not accept an empty historical set merely because the root exited
      # between ordinary child scans. This one strict refresh is deliberately
      # before the alive=0 success branch below.
      Add-AiNovelTrackedProcessTree `
        -RootProcessId $RootProcessId `
        -ProcessIds $ProcessIds `
        -StartTimeTicks $StartTimeTicks `
        -RequireSuccessfulTerminalRefresh `
        -ProcessChildrenProvider $ProcessChildrenProvider
      $terminalLineageRefreshed = $true
    }
    $alive = [System.Collections.Generic.List[int]]::new()
    foreach ($processId in $ProcessIds) {
      if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $StartTimeTicks) {
        $alive.Add([int]$processId)
      }
    }
    if ($alive.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Application process tree did not terminate before post-exit monitoring: $($alive -join ', ')"
}

function Request-AiNovelGracefulMainWindowClose {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Windows,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [scriptblock]$ProcessProvider,
    [scriptblock]$CloseMainWindowProvider
  )

  $visibleMainWindows = @($Windows | Where-Object {
    Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $ProcessIds
  })
  if ($visibleMainWindows.Count -ne 1) {
    throw "Application must expose exactly one visible product main window before graceful close; found $($visibleMainWindows.Count)."
  }

  $mainWindowProcessId = [int]$visibleMainWindows[0].ProcessId
  $startTimeKey = [string]$mainWindowProcessId
  if (
    -not $ProcessIds.Contains($mainWindowProcessId) -or
    -not $StartTimeTicks.ContainsKey($startTimeKey) -or
    -not (Test-AiNovelTrackedProcessAlive -ProcessId $mainWindowProcessId -StartTimeTicks $StartTimeTicks)
  ) {
    throw 'Application main-window owner is not the current tracked process.'
  }

  $candidate = $null
  try {
    $candidate = if ($null -eq $ProcessProvider) {
      [System.Diagnostics.Process]::GetProcessById($mainWindowProcessId)
    }
    else {
      & $ProcessProvider $mainWindowProcessId
    }
    if ($candidate -isnot [System.Diagnostics.Process]) {
      throw 'Application main-window owner could not be verified as the current tracked process.'
    }

    $candidate.Refresh()
    $expectedStartTimeTicks = [long]$StartTimeTicks[$startTimeKey]
    if (
      $candidate.HasExited -or
      $candidate.Id -ne $mainWindowProcessId -or
      $candidate.StartTime.ToUniversalTime().Ticks -ne $expectedStartTimeTicks
    ) {
      throw 'Application main-window owner is not the current tracked process.'
    }

    $closeAccepted = if ($null -eq $CloseMainWindowProvider) {
      $candidate.CloseMainWindow()
    }
    else {
      & $CloseMainWindowProvider $candidate
    }
    if (-not $closeAccepted) {
      throw 'Application rejected graceful main-window close request.'
    }
  }
  catch {
    if ($_.Exception.Message -like 'Application *') {
      throw
    }
    throw "Application main-window owner could not be verified as the current tracked process: $($_.Exception.Message)"
  }
  finally {
    if ($null -ne $candidate) {
      $candidate.Dispose()
    }
  }
}

function Close-AiNovelProcessTreeGracefully {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$StartTimeTicks,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Windows,
    [int]$TimeoutSeconds = 5,
    [scriptblock]$ProcessProvider,
    [scriptblock]$CloseMainWindowProvider
  )

  if ($TimeoutSeconds -lt 1) {
    throw 'Graceful process-tree shutdown timeout must be at least one second.'
  }
  Add-AiNovelTrackedProcessTree -RootProcessId $Process.Id -ProcessIds $ProcessIds -StartTimeTicks $StartTimeTicks
  Request-AiNovelGracefulMainWindowClose `
    -Windows $Windows `
    -ProcessIds $ProcessIds `
    -StartTimeTicks $StartTimeTicks `
    -ProcessProvider $ProcessProvider `
    -CloseMainWindowProvider $CloseMainWindowProvider
  Assert-AiNovelProcessTreeExited `
    -ProcessIds $ProcessIds `
    -StartTimeTicks $StartTimeTicks `
    -TimeoutSeconds $TimeoutSeconds `
    -RootProcessId $Process.Id
}

function Save-AiNovelSmokeFailureEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Failure,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Windows,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]]$ObservedProcessIds
  )

  try {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $Path 'failure.txt') -Value $Failure -Encoding utf8
    ConvertTo-Json -InputObject @($Windows) -Depth 4 |
      Set-Content -LiteralPath (Join-Path $Path 'window-snapshot.json') -Encoding utf8
    ConvertTo-Json -InputObject @($ObservedProcessIds) |
      Set-Content -LiteralPath (Join-Path $Path 'observed-process-ids.json') -Encoding utf8
  }
  catch {
    Write-Warning "Could not save complete smoke-test diagnostics in ${Path}: $($_.Exception.Message)"
  }
}

function Complete-AiNovelSmokeDiagnostics {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$Succeeded
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not $Succeeded) {
    Write-Warning "Smoke-test diagnostics preserved at: $Path"
    return
  }

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    }
    catch {
      if ($attempt -eq 19) {
        Write-Warning "Could not remove successful smoke-test diagnostics: $Path"
      }
      else {
        Start-Sleep -Milliseconds 500
      }
    }
  }
}

function Write-AiNovelAcceptanceReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][object]$Receipt
  )

  if ($Receipt.accepted -ne $true) {
    throw "Acceptance receipt must be accepted before publication: $FileName"
  }
  if (@($Receipt.observations).Count -eq 0) {
    throw "Acceptance receipt must contain direct observations: $FileName"
  }
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $destination = Join-Path $Directory $FileName
  $temporary = "${destination}.$PID.tmp"
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText(
    $temporary,
    (($Receipt | ConvertTo-Json -Depth 12) + "`n"),
    $encoding
  )
  Move-Item -LiteralPath $temporary -Destination $destination -Force
}

if ($LoadProbeLibrary) {
  return
}

if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $root = Split-Path -Parent $PSScriptRoot
  $packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $ExePath = Join-Path $root ("release\{0}\win-unpacked\AI小说作家.exe" -f [string]$packageJson.version)
}

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
if ([System.IO.Path]::GetExtension($resolvedExe) -ne '.exe') {
  throw "Smoke target must be an .exe file: $resolvedExe"
}

$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-smoke-' + [guid]::NewGuid().ToString('N'))
$chromiumLog = Join-Path $smokeRoot 'chromium.log'
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$process = $null
$previousVelaHome = $env:AI_NOVEL_VELA_HOME
$previousSmokeOpenProject = $env:AI_NOVEL_SMOKE_OPEN_PROJECT
$previousSmokeProjectMarker = $env:AI_NOVEL_SMOKE_PROJECT_MARKER
$previousUserProfile = $env:USERPROFILE
$projectOpenMarker = Join-Path $smokeRoot 'project-opened.json'
$legacyDebuggerPort = $null
$legacyProofComplete = $false
$acceptedMainWindowCount = 0
$smokeSucceeded = $false
$lastWindowSnapshot = @()
$observedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$appProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$observedProcessStartTimeTicks = @{}
$appProcessStartTimeTicks = @{}
$targetNames = @(
  [System.IO.Path]::GetFileName($resolvedExe),
  [System.IO.Path]::GetFileNameWithoutExtension($resolvedExe),
  'AI小说作家.exe',
  'AI小说作家',
  'ai-novel-writer'
  $RelatedTargetNames
)
$baselineWindowIdentities = $WindowBaselineIdentities
if ($null -ne $RelatedProcessIds -and $null -ne $RelatedProcessStartTimeTicks) {
  foreach ($relatedProcessId in $RelatedProcessIds) {
    $key = [string]$relatedProcessId
    if ($RelatedProcessStartTimeTicks.ContainsKey($key)) {
      [void]$observedProcessIds.Add([int]$relatedProcessId)
      $observedProcessStartTimeTicks[$key] = [long]$RelatedProcessStartTimeTicks[$key]
    }
  }
}

try {
  $startupWindowsBeforeBaseline = @(Get-AiNovelTopLevelWindowSnapshot)
  $startupBlockingWindows = @(Get-AiNovelStartupBlockingErrorWindows `
    -CurrentWindows $startupWindowsBeforeBaseline `
    -ProductNames $targetNames)
  if ($startupBlockingWindows.Count -gt 0) {
    throw "Application smoke cannot start while an existing product error dialog is open: $(Format-AiNovelWindowEvidence -Windows $startupBlockingWindows)"
  }
  if ($null -eq $baselineWindowIdentities) {
    $baselineWindowIdentities = New-AiNovelWindowIdentitySet -Windows $startupWindowsBeforeBaseline
  }
  $startupWindowsAfterBaseline = @(Get-AiNovelTopLevelWindowSnapshot)
  $startupBlockingWindows = @(Get-AiNovelStartupBlockingErrorWindows `
    -CurrentWindows $startupWindowsAfterBaseline `
    -ProductNames $targetNames)
  if ($startupBlockingWindows.Count -gt 0) {
    throw "Application smoke cannot start while an existing product error dialog is open: $(Format-AiNovelWindowEvidence -Windows $startupBlockingWindows)"
  }

  if (-not [string]::IsNullOrWhiteSpace($VelaHome)) {
    New-Item -ItemType Directory -Path $VelaHome -Force | Out-Null
    $env:AI_NOVEL_VELA_HOME = $VelaHome
  }
  if (-not [string]::IsNullOrWhiteSpace($ProjectPathToOpen)) {
    $env:AI_NOVEL_SMOKE_OPEN_PROJECT = (Resolve-Path -LiteralPath $ProjectPathToOpen).Path
    $env:AI_NOVEL_SMOKE_PROJECT_MARKER = $projectOpenMarker
  }
  if (-not [string]::IsNullOrWhiteSpace($LegacyProjectPathToOpen)) {
    if ([string]::IsNullOrWhiteSpace($VelaHome)) {
      throw 'Legacy project-open proof requires an isolated VelaHome.'
    }
    # v0.2.5 predates AI_NOVEL_VELA_HOME and derives .vela from os.homedir().
    $env:USERPROFILE = $VelaHome
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $legacyDebuggerPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
  }

  $launchArguments = @("--user-data-dir=$smokeRoot", '--enable-logging', '--v=1', "--log-file=$chromiumLog")
  if ($null -ne $legacyDebuggerPort) {
    $launchArguments += "--remote-debugging-port=$legacyDebuggerPort"
  }
  $process = Start-Process `
    -FilePath $resolvedExe `
    -ArgumentList $launchArguments `
    -PassThru
  [void](Add-AiNovelTrackedProcess -ProcessIds $observedProcessIds -StartTimeTicks $observedProcessStartTimeTicks -ProcessId $process.Id)
  [void](Add-AiNovelTrackedProcess -ProcessIds $appProcessIds -StartTimeTicks $appProcessStartTimeTicks -ProcessId $process.Id)

  $startupDeadline = [DateTime]::UtcNow.AddSeconds($ObservationSeconds)
  $healthyObservationDeadline = $null
  $mainWindowContinuity = New-AiNovelMainWindowContinuityState
  while ($true) {
    $process.Refresh()
    if (-not $process.HasExited) {
      Add-AiNovelTrackedProcessTree -RootProcessId $process.Id -ProcessIds $appProcessIds -StartTimeTicks $appProcessStartTimeTicks
      foreach ($processId in $appProcessIds) {
        if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $appProcessStartTimeTicks) {
          [void]$observedProcessIds.Add([int]$processId)
          $observedProcessStartTimeTicks[[string]$processId] = $appProcessStartTimeTicks[[string]$processId]
        }
      }
    }
    else {
      # The root can create a child between normal polls and then exit. Refresh
      # its historical lineage once, fail closed if that query is unavailable,
      # and retain any live child for diagnostics and cleanup.
      Add-AiNovelTrackedProcessTree `
        -RootProcessId $process.Id `
        -ProcessIds $appProcessIds `
        -StartTimeTicks $appProcessStartTimeTicks `
        -RequireSuccessfulTerminalRefresh
      foreach ($processId in $appProcessIds) {
        if (Test-AiNovelTrackedProcessAlive -ProcessId $processId -StartTimeTicks $appProcessStartTimeTicks) {
          [void]$observedProcessIds.Add([int]$processId)
          $observedProcessStartTimeTicks[[string]$processId] = $appProcessStartTimeTicks[[string]$processId]
        }
      }
    }
    $liveObservedProcessIds = Get-AiNovelLiveTrackedProcessIds -ProcessIds $observedProcessIds -StartTimeTicks $observedProcessStartTimeTicks
    $liveAppProcessIds = Get-AiNovelLiveTrackedProcessIds -ProcessIds $appProcessIds -StartTimeTicks $appProcessStartTimeTicks

    $lastWindowSnapshot = @(Get-AiNovelTopLevelWindowSnapshot)
    $newErrorWindows = @(Get-AiNovelNewErrorWindows `
      -BaselineIdentities $baselineWindowIdentities `
      -CurrentWindows $lastWindowSnapshot `
      -TargetProcessIds $liveObservedProcessIds `
      -TargetProcessStartTimeTicks $observedProcessStartTimeTicks `
      -TargetNames $targetNames)
    if ($newErrorWindows.Count -gt 0) {
      throw "Application displayed a new Windows error dialog: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
    }

    if ($process.HasExited) {
      $liveDescendantProcessIds = @($liveAppProcessIds | Where-Object { [int]$_ -ne $process.Id })
      if ($liveDescendantProcessIds.Count -gt 0) {
        throw "Application root exited during smoke test after terminal lineage refresh; live descendant PID(s): $($liveDescendantProcessIds -join ', ')"
      }
      throw "Application exited during smoke test with code $($process.ExitCode)"
    }

    $visibleMainWindow = @($lastWindowSnapshot | Where-Object {
      Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $liveAppProcessIds
    })
    $nowUtc = [DateTime]::UtcNow
    Assert-AiNovelMainWindowContinuity `
      -State $mainWindowContinuity `
      -Visible ($visibleMainWindow.Count -gt 0) `
      -NowUtc $nowUtc
    if ($visibleMainWindow.Count -gt 0 -and $null -eq $healthyObservationDeadline) {
      # The full health interval starts only after the real product main window first appears.
      $healthyObservationDeadline = $nowUtc.AddSeconds($ObservationSeconds)
    }
    $shouldProbeLegacyProject = (
      ($visibleMainWindow.Count -gt 0) -and
      (-not $legacyProofComplete) -and
      (-not [string]::IsNullOrWhiteSpace($LegacyProjectPathToOpen))
    )
    if ($shouldProbeLegacyProject) {
      & node (Join-Path $PSScriptRoot 'probe-legacy-project-open.mjs') `
        ([string]$legacyDebuggerPort) `
        (Resolve-Path -LiteralPath $LegacyProjectPathToOpen).Path `
        $projectOpenMarker
      if ($LASTEXITCODE -ne 0) {
        throw "Legacy renderer project-open probe failed with code $LASTEXITCODE"
      }
      $legacyProofComplete = $true
    }
    if ($null -ne $healthyObservationDeadline -and $nowUtc -ge $healthyObservationDeadline) {
      break
    }
    if ($null -eq $healthyObservationDeadline -and $nowUtc -ge $startupDeadline) {
      throw "Application stayed alive but did not create a main window within $ObservationSeconds seconds"
    }
    Start-Sleep -Milliseconds 100
  }

  # Acceptance requires the real product window to remain visible in the final snapshot.
  $lastWindowSnapshot = @(Get-AiNovelTopLevelWindowSnapshot)
  $liveObservedProcessIds = Get-AiNovelLiveTrackedProcessIds -ProcessIds $observedProcessIds -StartTimeTicks $observedProcessStartTimeTicks
  $liveAppProcessIds = Get-AiNovelLiveTrackedProcessIds -ProcessIds $appProcessIds -StartTimeTicks $appProcessStartTimeTicks
  $newErrorWindows = @(Get-AiNovelNewErrorWindows `
    -BaselineIdentities $baselineWindowIdentities `
    -CurrentWindows $lastWindowSnapshot `
    -TargetProcessIds $liveObservedProcessIds `
    -TargetProcessStartTimeTicks $observedProcessStartTimeTicks `
    -TargetNames $targetNames)
  if ($newErrorWindows.Count -gt 0) {
    throw "Application displayed a new Windows error dialog in the final snapshot: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
  }
  if (-not ($lastWindowSnapshot | Where-Object {
    Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $liveAppProcessIds
  })) {
    throw 'Application main window was not visible in the final smoke-test snapshot.'
  }
  $acceptedMainWindowCount = @($lastWindowSnapshot | Where-Object {
    Test-AiNovelVisibleMainWindow -Window $_ -TargetProcessIds $liveAppProcessIds
  }).Count
  if (Test-Path -LiteralPath $chromiumLog) {
    $fatalGpuLines = Get-Content -LiteralPath $chromiumLog | Where-Object { $_ -match 'GPU process isn.t usable|:FATAL:' }
    if ($fatalGpuLines) {
      throw "Application reached a Chromium fatal startup condition: $($fatalGpuLines[-1])"
    }
  }
  $expectedOpenedProjectPath = if (-not [string]::IsNullOrWhiteSpace($ProjectPathToOpen)) {
    $ProjectPathToOpen
  } else {
    $LegacyProjectPathToOpen
  }
  if (-not [string]::IsNullOrWhiteSpace($expectedOpenedProjectPath)) {
    if (-not (Test-Path -LiteralPath $projectOpenMarker -PathType Leaf)) {
      throw 'Application main window opened, but the renderer did not open and confirm the upgrade fixture project.'
    }
    $openedProject = Get-Content -LiteralPath $projectOpenMarker -Raw | ConvertFrom-Json
    if ([System.IO.Path]::GetFullPath([string]$openedProject.projectPath) -ne
        [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $expectedOpenedProjectPath).Path)) {
      throw 'Application confirmed a different project than the requested upgrade fixture.'
    }
  }

  Close-AiNovelProcessTreeGracefully `
    -Process $process `
    -ProcessIds $appProcessIds `
    -StartTimeTicks $appProcessStartTimeTicks `
    -Windows $lastWindowSnapshot
  foreach ($processId in $appProcessIds) {
    [void]$observedProcessIds.Add([int]$processId)
    $observedProcessStartTimeTicks[[string]$processId] = $appProcessStartTimeTicks[[string]$processId]
  }
  Wait-AiNovelPostExitQuietPeriod `
    -BaselineIdentities $baselineWindowIdentities `
    -TargetProcessIds $observedProcessIds `
    -TargetProcessStartTimeTicks $observedProcessStartTimeTicks `
    -TargetNames $targetNames `
    -QuietSeconds $PostExitQuietSeconds `
    -LastWindowSnapshot ([ref]$lastWindowSnapshot)

  if (-not [string]::IsNullOrWhiteSpace($AcceptanceDirectory)) {
    $versionInfo = (Get-Item -LiteralPath $resolvedExe).VersionInfo
    $actualVersion = [string]$versionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($actualVersion)) {
      throw 'Installed application did not expose a product version.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
      $actualSemanticVersion = $null
      $expectedSemanticVersion = $null
      if (-not [version]::TryParse($actualVersion, [ref]$actualSemanticVersion)) {
        throw "Installed application exposed an invalid product version: $actualVersion"
      }
      if (-not [version]::TryParse($ExpectedVersion, [ref]$expectedSemanticVersion)) {
        throw "Expected application version is invalid: $ExpectedVersion"
      }
      $versionMatches = (
        $actualSemanticVersion.Major -eq $expectedSemanticVersion.Major -and
        $actualSemanticVersion.Minor -eq $expectedSemanticVersion.Minor -and
        $actualSemanticVersion.Build -eq $expectedSemanticVersion.Build -and
        (
          $actualSemanticVersion.Revision -eq $expectedSemanticVersion.Revision -or
          ($expectedSemanticVersion.Revision -eq -1 -and $actualSemanticVersion.Revision -eq 0)
        )
      )
      if (-not $versionMatches) {
        throw "Installed application version mismatch: expected $ExpectedVersion, got $actualVersion"
      }
    }
    $rootProcessStartTimeTicks = [long]$appProcessStartTimeTicks[[string]$process.Id]
    Write-AiNovelAcceptanceReceipt `
      -Directory $AcceptanceDirectory `
      -FileName 'launch.json' `
      -Receipt ([ordered]@{
        schemaVersion = 2
        kind = 'windows-launch'
        accepted = $true
        observations = @(
          'A visible product main window remained healthy for the complete observation interval.'
          'The exact root process identity and packaged product version were captured.'
          'The process tree exited gracefully before the post-exit quiet window completed.'
        )
        direct = [ordered]@{
          executablePath = $resolvedExe
          productVersion = $actualVersion
          processId = [int]$process.Id
          processStartTimeTicks = [string]$rootProcessStartTimeTicks
          visibleMainWindowCount = $acceptedMainWindowCount
        }
        executablePath = $resolvedExe
        productVersion = $actualVersion
        expectedVersion = $ExpectedVersion
        processId = [int]$process.Id
        processStartTimeTicks = [string]$rootProcessStartTimeTicks
        visibleMainWindowObserved = ($acceptedMainWindowCount -gt 0)
        visibleMainWindowCount = $acceptedMainWindowCount
        healthyObservationSeconds = $ObservationSeconds
        postExitQuietSeconds = $PostExitQuietSeconds
        newProductErrorDialogCount = 0
      })
  }

  $smokeSucceeded = $true
  Write-Host "Windows application smoke test passed: PID $($process.Id), top-level window remained continuously healthy for a full $ObservationSeconds seconds after first appearing and no delayed error dialog appeared during the $PostExitQuietSeconds-second post-exit quiet period"
}
catch {
  Save-AiNovelSmokeFailureEvidence `
    -Path $smokeRoot `
    -Failure $_.Exception.Message `
    -Windows $lastWindowSnapshot `
    -ObservedProcessIds @($observedProcessIds)
  throw
}
finally {
  if ($process) {
    Stop-AiNovelProcessTree -Process $process -ProcessIds $appProcessIds -StartTimeTicks $appProcessStartTimeTicks
  }
  $env:AI_NOVEL_VELA_HOME = $previousVelaHome
  $env:AI_NOVEL_SMOKE_OPEN_PROJECT = $previousSmokeOpenProject
  $env:AI_NOVEL_SMOKE_PROJECT_MARKER = $previousSmokeProjectMarker
  $env:USERPROFILE = $previousUserProfile
  Complete-AiNovelSmokeDiagnostics -Path $smokeRoot -Succeeded $smokeSucceeded
}
