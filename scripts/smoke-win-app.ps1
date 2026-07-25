param(
  [string]$ExePath,
  [int]$ObservationSeconds = 30,
  [string]$VelaHome
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $root = Split-Path -Parent $PSScriptRoot
  $packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $ExePath = Join-Path $root ("release\{0}\win-unpacked\AI小说作家.exe" -f [string]$packageJson.version)
}

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
  }
}
'@

function Get-ProcessTreeIds {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $processIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$processIds.Add($RootProcessId)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $parentProcessId = $pending.Dequeue()
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
      if ($processIds.Add([int]$child.ProcessId)) {
        $pending.Enqueue([int]$child.ProcessId)
      }
    }
  }
  return @($processIds)
}

function Get-ProcessTopLevelWindowTitles {
  param([Parameter(Mandatory = $true)][int[]]$ProcessIds)

  $titles = [System.Collections.Generic.List[string]]::new()
  [AiNovelSmoke.TopLevelWindowProbe]::EnumWindows({
    param($handle, $state)
    $windowProcessId = 0
    [void][AiNovelSmoke.TopLevelWindowProbe]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
    if ($ProcessIds -contains $windowProcessId) {
      $length = [AiNovelSmoke.TopLevelWindowProbe]::GetWindowTextLength($handle)
      $title = [System.Text.StringBuilder]::new($length + 1)
      [void][AiNovelSmoke.TopLevelWindowProbe]::GetWindowText($handle, $title, $title.Capacity)
      $titles.Add($title.ToString())
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  return @($titles)
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

try {
  if (-not [string]::IsNullOrWhiteSpace($VelaHome)) {
    New-Item -ItemType Directory -Path $VelaHome -Force | Out-Null
    $env:AI_NOVEL_VELA_HOME = $VelaHome
  }

  $process = Start-Process `
    -FilePath $resolvedExe `
    -ArgumentList @("--user-data-dir=$smokeRoot", '--enable-logging', '--v=1', "--log-file=$chromiumLog") `
    -WindowStyle Hidden `
    -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds($ObservationSeconds)
  $windowCreated = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) {
      throw "Application exited during smoke test with code $($process.ExitCode)"
    }
    $processTreeIds = Get-ProcessTreeIds -RootProcessId $process.Id
    $windowTitles = Get-ProcessTopLevelWindowTitles -ProcessIds $processTreeIds
    if ($windowTitles | Where-Object { $_ -match '应用程序错误|Application Error|unknown software exception' }) {
      throw "Application displayed a Windows error dialog: $($windowTitles -join '; ')"
    }
    if ($windowTitles.Count -gt 0) {
      $windowCreated = $true
    }
  }

  if (-not $windowCreated) {
    throw "Application stayed alive but did not create a main window within $ObservationSeconds seconds"
  }
  if (Test-Path -LiteralPath $chromiumLog) {
    $fatalGpuLines = Get-Content -LiteralPath $chromiumLog | Where-Object { $_ -match 'GPU process isn.t usable|:FATAL:' }
    if ($fatalGpuLines) {
      throw "Application reached a Chromium fatal startup condition: $($fatalGpuLines[-1])"
    }
  }

  Write-Host "Windows application smoke test passed: PID $($process.Id), top-level window remained healthy for $ObservationSeconds seconds"
}
finally {
  if ($process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
    }
  }
  $env:AI_NOVEL_VELA_HOME = $previousVelaHome
  if (Test-Path -LiteralPath $smokeRoot) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction Stop
        break
      }
      catch {
        if ($attempt -eq 19) {
          Write-Warning "Could not remove smoke-test user data: $smokeRoot"
        }
        else {
          Start-Sleep -Milliseconds 500
        }
      }
    }
  }
}
