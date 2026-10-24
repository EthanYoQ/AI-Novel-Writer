import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const releaseMonitorScript = resolve('scripts/monitor-win-release-gate.ps1')
const electronExecutable = resolve('node_modules/electron/dist/electron.exe')
const windowsIt = process.platform === 'win32' ? it : it.skip

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// execFileSync blocks the event loop, so its own timeout must end a stuck
// probe before the Vitest case timeout would.
function runMonitorLibrary(script: string, timeoutMilliseconds: number): Record<string, unknown> {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$ErrorActionPreference = 'Stop'\n. ${quotePowerShell(releaseMonitorScript)} -LoadMonitorLibrary\n${script}`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMilliseconds, killSignal: 'SIGKILL' },
  )
  const line = output.trim().split(/\r?\n/).at(-1)
  if (!line) throw new Error('PowerShell probe did not return JSON')
  return JSON.parse(line) as Record<string, unknown>
}

const waitingProcessHelpers = String.raw`
function Start-AiNovelTestWaitingProcess {
  param([string]$Path, [string]$Arguments, [hashtable]$Environment = @{})
  $info = [System.Diagnostics.ProcessStartInfo]::new($Path, $Arguments)
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.CreateNoWindow = $true
  foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = [string]$Environment[$name] }
  return [System.Diagnostics.Process]::Start($info)
}

function Stop-AiNovelTestWaitingProcess {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process) { return }
  try { $Process.StandardInput.Close() } catch { }
  if (-not $Process.WaitForExit(5000)) { $Process.Kill(); [void]$Process.WaitForExit(5000) }
  $Process.Dispose()
}
`

function compareImagePaths(shortPathOnly: boolean): Record<string, unknown> {
  return runMonitorLibrary(String.raw`
$shortPathOnly = ${shortPathOnly ? '$true' : '$false'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AiNovelTestWin32Image {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint length);

  public static string Read(IntPtr process) {
    int size = 32768;
    StringBuilder buffer = new StringBuilder(size);
    return QueryFullProcessImageName(process, 0, buffer, ref size) ? buffer.ToString() : null;
  }

  public static string Short(string path) {
    StringBuilder buffer = new StringBuilder(32768);
    uint written = GetShortPathName(path, buffer, (uint)buffer.Capacity);
    return written == 0 ? null : buffer.ToString();
  }
}
'@
${waitingProcessHelpers}
$system32 = Join-Path $env:SystemRoot 'System32'
$sysWow64 = Join-Path $env:SystemRoot 'SysWOW64'
$shortDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-novel-image-compare-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $shortDirectory | Out-Null
$copiedFind = Join-Path $shortDirectory 'find.exe'
Copy-Item -LiteralPath (Join-Path $system32 'find.exe') -Destination $copiedFind
$shortFind = [AiNovelTestWin32Image]::Short($copiedFind)
$shortPathUnavailable = if ([string]::IsNullOrEmpty($shortFind) -or $shortFind -notmatch '~' -or $shortFind -eq $copiedFind) {
  "The TEMP volume did not expose an 8.3 alias for $copiedFind (GetShortPathName returned '$shortFind')."
} else { '' }
$cases = if ($shortPathOnly) {
  if ($shortPathUnavailable) { @() } else { @(@{ Name = 'short-path-find'; Path = $shortFind; Arguments = '"zzz"' }) }
} else {
  @(
    @{ Name = 'system32-cmd'; Path = (Join-Path $system32 'cmd.exe'); Arguments = '/d /q /k' },
    @{ Name = 'system32-find'; Path = (Join-Path $system32 'find.exe'); Arguments = '"zzz"' },
    @{ Name = 'system32-findstr'; Path = (Join-Path $system32 'findstr.exe'); Arguments = 'zzz' },
    @{ Name = 'syswow64-find'; Path = (Join-Path $sysWow64 'find.exe'); Arguments = '"zzz"' },
    @{ Name = 'repository-electron'; Path = ${quotePowerShell(electronExecutable)}; Arguments = '-e "process.stdin.resume()"'; Environment = @{ ELECTRON_RUN_AS_NODE = '1' } }
  )
}
$results = [System.Collections.Generic.List[object]]::new()
try {
  foreach ($case in $cases) {
    $environment = if ($case.ContainsKey('Environment')) { $case.Environment } else { @{} }
    $process = Start-AiNovelTestWaitingProcess -Path $case.Path -Arguments $case.Arguments -Environment $environment
    try {
      $win32 = [AiNovelTestWin32Image]::Read($process.Handle)
      $nt = [AiNovelReleaseGate.ProcessReader]::ReadImagePath($process.Handle)
      $results.Add([pscustomobject][ordered]@{
        name = $case.Name
        launchedAs = $case.Path
        win32 = $win32
        nt = $nt
        ordinalEqual = [string]::Equals($win32, $nt, [System.StringComparison]::Ordinal)
        sameAbsolutePath = Test-AiNovelGateSameAbsolutePath -Left $win32 -Right $nt
        alive = -not $process.HasExited
      })
    }
    finally {
      Stop-AiNovelTestWaitingProcess -Process $process
    }
  }
}
finally {
  Remove-Item -LiteralPath $shortDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
[pscustomobject]@{ shortPathUnavailable = $shortPathUnavailable; results = @($results) } | ConvertTo-Json -Compress -Depth 4
`, 45_000)
}

function expectSameImagePaths(rows: Array<Record<string, unknown>>, names: string[]): void {
  console.info('Release gate image path comparison:', JSON.stringify(rows))
  expect(rows.map(row => row.name)).toEqual(names)
  for (const row of rows) {
    expect(row).toMatchObject({ alive: true, sameAbsolutePath: true })
    expect(row.win32).toEqual(expect.stringMatching(/^[A-Za-z]:\\/))
  }
}

describe('Windows release gate process capture', () => {
  windowsIt('reads the same image path through NT class 27 as QueryFullProcessImageName on live processes', () => {
    const result = compareImagePaths(false)
    expectSameImagePaths(result.results as Array<Record<string, unknown>>, [
      'system32-cmd',
      'system32-find',
      'system32-findstr',
      'syswow64-find',
      'repository-electron',
    ])
  }, 60_000)

  windowsIt('reads the same 8.3 short image path through NT class 27 as QueryFullProcessImageName', (context) => {
    const result = compareImagePaths(true)
    if (result.shortPathUnavailable) {
      console.info('Release gate 8.3 image path comparison skipped:', result.shortPathUnavailable)
      context.skip(String(result.shortPathUnavailable))
      return
    }
    expectSameImagePaths(result.results as Array<Record<string, unknown>>, ['short-path-find'])
  }, 60_000)

  windowsIt('keeps the kernel identity of an exited process readable through its retained handle', () => {
    const result = runMonitorLibrary(String.raw`
${waitingProcessHelpers}
$findPath = Join-Path $env:SystemRoot 'System32\find.exe'
$winIni = Join-Path $env:SystemRoot 'win.ini'
$info = [System.Diagnostics.ProcessStartInfo]::new($findPath, '"zzz" "' + $winIni + '"')
$info.UseShellExecute = $false
$info.RedirectStandardOutput = $true
$info.CreateNoWindow = $true
$exited = [System.Diagnostics.Process]::Start($info)
[void]$exited.StandardOutput.ReadToEnd()
$exited.WaitForExit()
$afterExit = [AiNovelReleaseGate.ProcessReader]::Read($exited.Handle)
$exited.Dispose()
$live = Start-AiNovelTestWaitingProcess -Path $findPath -Arguments '"zzz"'
try {
  $whileAlive = [AiNovelReleaseGate.ProcessReader]::Read($live.Handle)
}
finally {
  Stop-AiNovelTestWaitingProcess -Process $live
}
function ConvertTo-Snapshot {
  param($Snapshot)
  [pscustomobject][ordered]@{
    startTicks = [string]$Snapshot.StartTicks
    imageIsFind = Test-AiNovelGateSameAbsolutePath -Left $Snapshot.ImagePath -Right $findPath
    parentIsProbe = $Snapshot.ParentProcessId -eq $PID
    kernelIdentityComplete = $Snapshot.KernelIdentityComplete
    commandLineState = [string]$Snapshot.CommandLineState
    commandLine = $Snapshot.CommandLine
  }
}
[pscustomobject]@{
  afterExit = ConvertTo-Snapshot $afterExit
  whileAlive = ConvertTo-Snapshot $whileAlive
  expectedLiveCommandLine = '"' + $findPath + '" "zzz"'
} | ConvertTo-Json -Compress -Depth 4
`, 20_000)
    const afterExit = result.afterExit as Record<string, unknown>
    const whileAlive = result.whileAlive as Record<string, unknown>

    for (const snapshot of [afterExit, whileAlive]) {
      expect(snapshot).toMatchObject({ imageIsFind: true, parentIsProbe: true, kernelIdentityComplete: true })
      expect(snapshot.startTicks).toMatch(/^[1-9]\d+$/)
    }
    expect(['ExitedBeforeRead', 'Captured']).toContain(afterExit.commandLineState)
    if (afterExit.commandLineState === 'ExitedBeforeRead') expect(afterExit.commandLine).toBeNull()
    expect(whileAlive).toMatchObject({ commandLineState: 'Captured', commandLine: result.expectedLiveCommandLine })
  }, 30_000)

  windowsIt('classifies synthetic NSIS process-check exits into a closed verdict set', () => {
    const result = runMonitorLibrary(String.raw`
$sys = $env:SystemRoot
$setupPath = 'C:\Users\runneradmin\AppData\Local\Temp\ai-novel-release-gate-nsis-probes-sMkF7V\ai-novel-writer-setup-0.4.0.exe'
$nodePath = 'C:\hostedtoolcache\windows\node\22.23.1\x64\node.exe'
$cmdPath = "$sys\System32\cmd.exe"
$findPath = "$sys\System32\find.exe"
$powerShellPath = "$sys\System32\WindowsPowerShell\v1.0\powershell.exe"

function New-Identity {
  param($Id, $Ticks, $Path, $CommandLine, $ParentId, $ParentTicks, $ParentPath)
  [pscustomobject][ordered]@{
    processId = [int]$Id
    startTimeTicks = $Ticks
    processName = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    executablePath = $Path
    commandLine = $CommandLine
    parentProcessId = $ParentId
    parentProcessStartTimeTicks = $ParentTicks
    parentExecutablePath = $ParentPath
    identityCaptured = $true
    commandLineCaptured = -not [string]::IsNullOrEmpty($CommandLine)
    identityCaptureError = $null
  }
}

# Field values from the CI failure of find.exe PID 6184 (run 40106025587).
$node = New-Identity 4708 '639284519675272350' $nodePath ('"' + $nodePath + '" x') 2348 '639284519247807311' $nodePath
$armedRoot = New-Identity 4708 '639284519675272350' $nodePath $null $null $null $null
$setup = New-Identity 3832 '639284519679965455' $setupPath ('"' + $setupPath + '" a') 4708 $node.startTimeTicks $nodePath
$cmdLine = '"' + $cmdPath + '" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "' + $findPath + '" "AI小说作家.exe"'
$findLine = '"' + $findPath + '"  "AI小说作家.exe"'
function New-Cmd {
  param($CommandLine = $cmdLine, $ParentTicks = $setup.startTimeTicks, $Ticks = '639284519689376751')
  New-Identity 5576 $Ticks $cmdPath $CommandLine 3832 $ParentTicks $setupPath
}
function New-Find {
  param($CommandLine = $findLine, $Path = $findPath, $ParentTicks = '639284519689376751', $ParentPath = $cmdPath)
  New-Identity 6184 '639284519689708262' $Path $CommandLine 5576 $ParentTicks $ParentPath
}
$cmd = New-Cmd
$descendantPowerShell = New-Identity 7001 '639284519690000000' $powerShellPath ('"' + $powerShellPath + '" -NoProfile -Command exit 37') 4708 $node.startTimeTicks $nodePath

function Get-Verdict {
  param($Step, $Identity, $Members = @($node, $setup, $cmd), $ExitCode = 1, $JobMessage = 7, $ExitKey = 'recorded', $VerifiedParents = @())
  $tracked = @{}
  foreach ($member in @($Members) + @($Identity)) { $tracked[[int]$member.processId] = $member }
  $verified = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($parent in @($VerifiedParents)) { [void]$verified.Add((Get-AiNovelGateProcessIdentityKey -ProcessIdentity $parent)) }
  $key = if ($ExitKey -eq 'recorded') { Get-AiNovelGateProcessIdentityKey -ProcessIdentity $Identity } else { $ExitKey }
  $event = [pscustomobject]@{
    Kind = 'process-exit'
    ProcessId = $Identity.processId
    Retained = $true
    ExitCodeCaptured = $true
    ExitCode = $ExitCode
    JobMessage = [uint32]$JobMessage
    ExitKey = $key
  }
  $verdict = Get-AiNovelGateExitVerdict -Step $Step -Event $event -ProcessIdentity $Identity -TrackedProcessIdentities $tracked -LegacyBridge $null -ArmedRootIdentity $armedRoot -VerifiedFindParentKeys $verified
  return '{0}|{1}|{2}|{3}|{4}' -f $verdict.Kind, $verdict.Classification, $verdict.Basis, $verdict.Reason, $verdict.Blocks
}

$e2e = 'windows-in-app-update-e2e'
$smoke = 'smoke:win-installer'
$build = 'build:win:artifacts'
$laterCmd = New-Cmd -Ticks '639284519689800000'
[pscustomobject][ordered]@{
  FindExactE2e = Get-Verdict $e2e (New-Find)
  FindWithoutCommandLineE2e = Get-Verdict $e2e (New-Find -CommandLine $null)
  FindWithoutCommandLineSmoke = Get-Verdict $smoke (New-Find -CommandLine $null)
  FindContradictsParentE2e = Get-Verdict $e2e (New-Find -CommandLine ('"' + $findPath + '"  "other.exe"'))
  FindContradictsParentSmoke = Get-Verdict $smoke (New-Find -CommandLine ('"' + $findPath + '"  "other.exe"'))
  FindOutsideNamedPathE2e = Get-Verdict $e2e (New-Find -CommandLine $null -Path 'C:\temp\find.exe')
  FindstrUnderFindTemplateE2e = Get-Verdict $e2e (New-Find -CommandLine $null -Path "$sys\System32\findstr.exe")
  FindParentStartedLaterE2e = Get-Verdict $e2e (New-Find -CommandLine $null -ParentTicks $null -ParentPath $null) -Members @($node, $setup, $laterCmd)
  FindInstallerEdgeUnboundE2e = Get-Verdict $e2e (New-Find) -Members @($node, $setup, (New-Cmd -ParentTicks $null))
  FindExitKeyMismatchE2e = Get-Verdict $e2e (New-Find) -ExitKey '6184|639284519689708262|C:\temp\other.exe'
  CmdWithoutCommandLineE2e = Get-Verdict $e2e (New-Cmd -CommandLine $null) -Members @($node, $setup)
  CmdWithoutCommandLineSmoke = Get-Verdict $smoke (New-Cmd -CommandLine $null) -Members @($node, $setup)
  CmdWithoutCommandLineUpgrade = Get-Verdict 'smoke:win-v025-upgrade' (New-Cmd -CommandLine $null) -Members @($node, $setup)
  FindUnderUnobservedCmdSmoke = Get-Verdict $smoke (New-Find -CommandLine $null) -Members @($node, $setup, (New-Cmd -CommandLine $null))
  CmdOtherCommandSmoke = Get-Verdict $smoke (New-Cmd -CommandLine ('"' + $cmdPath + '" /C exit 1')) -Members @($node, $setup)
  CmdAwaitingVerifiedFilterE2e = Get-Verdict $e2e $cmd -Members @($node, $setup)
  CmdAfterVerifiedFilterE2e = Get-Verdict $e2e $cmd -Members @($node, $setup) -VerifiedParents @($cmd)
  UnlistedNonzeroBuild = Get-Verdict $build $descendantPowerShell -ExitCode 37
  UnlistedNonzeroSmoke = Get-Verdict $smoke $descendantPowerShell -ExitCode 37
  UnlistedNonzeroE2e = Get-Verdict $e2e $descendantPowerShell -ExitCode 37
  AbnormalExitBuild = Get-Verdict $build $descendantPowerShell -ExitCode 1 -JobMessage 8
  ArmedRootNonzeroBuild = Get-Verdict $build $node -Members @() -ExitCode 1
  SucceededE2e = Get-Verdict $e2e (New-Find) -ExitCode 0
} | ConvertTo-Json -Compress
`, 20_000)

    expect(result).toEqual({
      FindExactE2e: 'expected|expected-nsis-find-no-match|own-command-line||False',
      FindWithoutCommandLineE2e: 'expected|expected-nsis-find-no-match|parent-command-line||False',
      FindWithoutCommandLineSmoke: 'expected|expected-nsis-find-no-match|parent-command-line||False',
      FindContradictsParentE2e: 'failure|failure||filter-command-line-contradicts-parent|True',
      FindContradictsParentSmoke: 'failure|failure||filter-command-line-contradicts-parent|True',
      FindOutsideNamedPathE2e: 'failure|failure|||True',
      FindstrUnderFindTemplateE2e: 'failure|failure|||True',
      FindParentStartedLaterE2e: 'failure|failure|||True',
      FindInstallerEdgeUnboundE2e: 'failure|failure|||True',
      FindExitKeyMismatchE2e: 'failure|failure||exit-key-mismatch|True',
      CmdWithoutCommandLineE2e: 'unobservable|unobservable||nsis-cmd-command-line-unobserved|True',
      CmdWithoutCommandLineSmoke: 'unobservable|unobservable||nsis-cmd-command-line-unobserved|True',
      CmdWithoutCommandLineUpgrade: 'unobservable|unobservable||nsis-cmd-command-line-unobserved|True',
      FindUnderUnobservedCmdSmoke: 'unobservable|unobservable||nsis-filter-parent-command-line-unobserved|True',
      CmdOtherCommandSmoke: 'result-owned|ignored-result-owned-descendant-nonzero|||False',
      CmdAwaitingVerifiedFilterE2e: 'pending|pending-nsis-cmd-process-check|||False',
      CmdAfterVerifiedFilterE2e: 'expected|expected-nsis-cmd-process-check|||False',
      UnlistedNonzeroBuild: 'result-owned|ignored-result-owned-descendant-nonzero|||False',
      UnlistedNonzeroSmoke: 'result-owned|ignored-result-owned-descendant-nonzero|||False',
      UnlistedNonzeroE2e: 'failure|failure|||True',
      AbnormalExitBuild: 'failure|failure|||True',
      ArmedRootNonzeroBuild: 'failure|failure|||True',
      SucceededE2e: 'succeeded|succeeded|||False',
    })
  }, 30_000)
})
