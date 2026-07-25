param(
  [string]$ControlPath,
  [string]$StatusPath,
  [string]$EvidencePath,
  [switch]$LoadMonitorLibrary
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'smoke-win-app.ps1') -LoadProbeLibrary

if (-not ('AiNovelReleaseGate.JobProcessMonitor' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AiNovelReleaseGate {
  public sealed class JobProcessEvent {
    public string Kind { get; private set; }
    public int ProcessId { get; private set; }
    public int? ExitCode { get; private set; }
    public bool CaptureEstablished { get; private set; }
    public bool ExitCodeCaptured { get; private set; }
    public uint JobMessage { get; private set; }
    public string RecordedAt { get; private set; }

    internal JobProcessEvent(string kind, int processId, int? exitCode, bool captureEstablished, bool exitCodeCaptured, uint jobMessage) {
      Kind = kind;
      ProcessId = processId;
      ExitCode = exitCode;
      CaptureEstablished = captureEstablished;
      ExitCodeCaptured = exitCodeCaptured;
      JobMessage = jobMessage;
      RecordedAt = DateTime.UtcNow.ToString("o");
    }
  }

  public sealed class JobProcessMonitor : IDisposable {
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const uint JobObjectMsgActiveProcessZero = 4;
    private const uint JobObjectMsgNewProcess = 6;
    private const uint JobObjectMsgExitProcess = 7;
    private const uint JobObjectMsgAbnormalExitProcess = 8;
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessSetQuota = 0x0100;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const int WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectAssociateCompletionPort {
      public IntPtr CompletionKey;
      public IntPtr CompletionPort;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int jobObjectInfoClass, ref JobObjectAssociateCompletionPort info, int infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingCompletionPort, UIntPtr completionKey, uint numberOfConcurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(IntPtr completionPort, out uint numberOfBytes, out UIntPtr completionKey, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PostQueuedCompletionStatus(IntPtr completionPort, uint numberOfBytes, UIntPtr completionKey, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private readonly ConcurrentQueue<JobProcessEvent> events = new ConcurrentQueue<JobProcessEvent>();
    private readonly ConcurrentDictionary<int, IntPtr> processHandles = new ConcurrentDictionary<int, IntPtr>();
    private readonly Thread worker;
    private IntPtr job;
    private IntPtr completionPort;
    private volatile bool stopping;
    private bool disposed;

    public JobProcessMonitor() {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero || job == new IntPtr(-1)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the Windows release-gate job object.");
      }
      completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
      if (completionPort == IntPtr.Zero || completionPort == new IntPtr(-1)) {
        int error = Marshal.GetLastWin32Error();
        CloseHandle(job);
        job = IntPtr.Zero;
        throw new Win32Exception(error, "Could not create the Windows release-gate completion port.");
      }
      JobObjectAssociateCompletionPort association = new JobObjectAssociateCompletionPort();
      association.CompletionKey = job;
      association.CompletionPort = completionPort;
      if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, ref association, Marshal.SizeOf(association))) {
        int error = Marshal.GetLastWin32Error();
        CloseHandle(completionPort);
        CloseHandle(job);
        completionPort = IntPtr.Zero;
        job = IntPtr.Zero;
        throw new Win32Exception(error, "Could not associate the Windows release-gate job object with its completion port.");
      }
      worker = new Thread(new ThreadStart(Pump));
      worker.IsBackground = true;
      worker.Name = "AI Novel release-gate process monitor";
      worker.Start();
    }

    public void AssignProcess(int processId) {
      if (processId <= 0) throw new ArgumentOutOfRangeException("processId");
      IntPtr process = OpenProcess(ProcessSetQuota | ProcessTerminate, false, unchecked((uint)processId));
      if (process == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open release-gate root process " + processId + " for job assignment.");
      }
      try {
        if (!AssignProcessToJobObject(job, process)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not atomically assign release-gate root process " + processId + " to the job object.");
        }
      }
      finally {
        CloseHandle(process);
      }
    }

    public JobProcessEvent[] Drain() {
      List<JobProcessEvent> drained = new List<JobProcessEvent>();
      JobProcessEvent item;
      while (events.TryDequeue(out item)) drained.Add(item);
      return drained.ToArray();
    }

    public void Terminate(uint exitCode) {
      if (job == IntPtr.Zero) return;
      if (!TerminateJobObject(job, exitCode)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not terminate the Windows release-gate job object.");
      }
    }

    private void Pump() {
      while (!stopping) {
        uint message;
        UIntPtr completionKey;
        IntPtr overlapped;
        bool received = GetQueuedCompletionStatus(completionPort, out message, out completionKey, out overlapped, 250);
        if (!received) {
          int error = Marshal.GetLastWin32Error();
          if (error == WaitTimeout) continue;
          if (stopping) return;
          events.Enqueue(new JobProcessEvent("monitor-error", 0, null, false, false, unchecked((uint)error)));
          continue;
        }
        if (stopping && message == 0) return;
        int processId = unchecked((int)overlapped.ToInt64());
        if (message == JobObjectMsgNewProcess) {
          IntPtr process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, unchecked((uint)processId));
          bool captured = process != IntPtr.Zero;
          if (captured) {
            IntPtr stale;
            if (processHandles.TryRemove(processId, out stale)) CloseHandle(stale);
            if (!processHandles.TryAdd(processId, process)) {
              CloseHandle(process);
              captured = false;
            }
          }
          events.Enqueue(new JobProcessEvent("process-start", processId, null, captured, false, message));
          continue;
        }
        if (message == JobObjectMsgExitProcess || message == JobObjectMsgAbnormalExitProcess) {
          IntPtr process;
          int? exitCode = null;
          bool captured = processHandles.TryRemove(processId, out process);
          if (captured) {
            try {
              uint rawExitCode;
              if (GetExitCodeProcess(process, out rawExitCode)) exitCode = unchecked((int)rawExitCode);
            }
            finally {
              CloseHandle(process);
            }
          }
          events.Enqueue(new JobProcessEvent("process-exit", processId, exitCode, captured, exitCode.HasValue, message));
          continue;
        }
        if (message == JobObjectMsgActiveProcessZero) {
          events.Enqueue(new JobProcessEvent("job-empty", 0, null, true, false, message));
        }
      }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      stopping = true;
      if (completionPort != IntPtr.Zero) PostQueuedCompletionStatus(completionPort, 0, UIntPtr.Zero, IntPtr.Zero);
      if (worker != null) worker.Join(2000);
      foreach (KeyValuePair<int, IntPtr> pair in processHandles) {
        IntPtr handle;
        if (processHandles.TryRemove(pair.Key, out handle)) CloseHandle(handle);
      }
      if (job != IntPtr.Zero) {
        CloseHandle(job);
        job = IntPtr.Zero;
      }
      if (completionPort != IntPtr.Zero) {
        CloseHandle(completionPort);
        completionPort = IntPtr.Zero;
      }
    }
  }

  public sealed class WindowEvent {
    public string WindowHandle { get; private set; }
    public int ProcessId { get; private set; }
    public string ProcessName { get; private set; }
    public string Title { get; private set; }
    public string ClassName { get; private set; }
    public bool Visible { get; private set; }
    public uint EventType { get; private set; }
    public string RecordedAt { get; private set; }

    internal WindowEvent(IntPtr windowHandle, int processId, string processName, string title, string className, bool visible, uint eventType) {
      WindowHandle = "0x" + windowHandle.ToInt64().ToString("X");
      ProcessId = processId;
      ProcessName = processName;
      Title = title;
      ClassName = className;
      Visible = visible;
      EventType = eventType;
      RecordedAt = DateTime.UtcNow.ToString("o");
    }
  }

  public sealed class WindowEventMonitor : IDisposable {
    private const uint EventSystemDialogStart = 0x0010;
    private const uint EventObjectCreate = 0x8000;
    private const uint EventObjectShow = 0x8002;
    private const uint EventObjectNameChange = 0x800C;
    private const int ObjectIdWindow = 0;
    private const int ObjectIdClient = -4;
    private const uint WinEventOutOfContext = 0;
    private const uint WinEventSkipOwnProcess = 2;
    private const uint WmQuit = 0x0012;

    private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr windowHandle, int objectId, int childId, uint eventThread, uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point {
      public int X;
      public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
      public IntPtr WindowHandle;
      public uint MessageId;
      public UIntPtr WParam;
      public IntPtr LParam;
      public uint Time;
      public Point Point;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr windowHandle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr windowHandle, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr windowHandle, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr windowHandle);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr windowHandle, uint minimum, uint maximum);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Message message, IntPtr windowHandle, uint minimum, uint maximum, uint removeMessage);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private readonly ConcurrentQueue<WindowEvent> events = new ConcurrentQueue<WindowEvent>();
    private readonly List<IntPtr> hooks = new List<IntPtr>();
    private readonly WinEventDelegate callback;
    private readonly ManualResetEvent initialized = new ManualResetEvent(false);
    private readonly Thread worker;
    private Exception initializationError;
    private uint hookThreadId;
    private bool disposed;

    public WindowEventMonitor() {
      callback = new WinEventDelegate(Capture);
      worker = new Thread(new ThreadStart(Run));
      worker.IsBackground = true;
      worker.Name = "AI Novel release-gate window monitor";
      worker.Start();
      if (!initialized.WaitOne(5000)) {
        Dispose();
        throw new TimeoutException("Timed out creating the Windows release-gate error-window message loop.");
      }
      if (initializationError != null) {
        worker.Join(2000);
        throw new InvalidOperationException("Could not initialize the Windows release-gate error-window monitor.", initializationError);
      }
    }

    public WindowEvent[] Drain() {
      List<WindowEvent> drained = new List<WindowEvent>();
      WindowEvent item;
      while (events.TryDequeue(out item)) drained.Add(item);
      return drained.ToArray();
    }

    public void ThrowIfUnhealthy() {
      if (initializationError != null) {
        throw new InvalidOperationException("Windows release-gate error-window monitor stopped unexpectedly.", initializationError);
      }
      if (!disposed && !worker.IsAlive) {
        throw new InvalidOperationException("Windows release-gate error-window monitor thread ended unexpectedly.");
      }
    }

    private void AddHook(uint eventType) {
      IntPtr hook = SetWinEventHook(eventType, eventType, IntPtr.Zero, callback, 0, 0, WinEventOutOfContext | WinEventSkipOwnProcess);
      if (hook == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not install the Windows release-gate error-window event hook.");
      }
      hooks.Add(hook);
    }

    private void Run() {
      try {
        hookThreadId = GetCurrentThreadId();
        Message ignored;
        PeekMessage(out ignored, IntPtr.Zero, 0, 0, 0);
        AddHook(EventSystemDialogStart);
        AddHook(EventObjectCreate);
        AddHook(EventObjectShow);
        AddHook(EventObjectNameChange);
        initialized.Set();
        while (true) {
          Message message;
          int result = GetMessage(out message, IntPtr.Zero, 0, 0);
          if (result == 0) break;
          if (result == -1) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows release-gate error-window message loop failed.");
          }
          TranslateMessage(ref message);
          DispatchMessage(ref message);
        }
      }
      catch (Exception error) {
        initializationError = error;
        initialized.Set();
      }
      finally {
        foreach (IntPtr hook in hooks) UnhookWinEvent(hook);
        hooks.Clear();
        hookThreadId = 0;
      }
    }

    private void Capture(IntPtr hook, uint eventType, IntPtr windowHandle, int objectId, int childId, uint eventThread, uint eventTime) {
      if (windowHandle == IntPtr.Zero || (objectId != ObjectIdWindow && objectId != ObjectIdClient)) return;
      try {
        uint rawProcessId;
        GetWindowThreadProcessId(windowHandle, out rawProcessId);
        int processId = unchecked((int)rawProcessId);
        string processName = "<exited>";
        try {
          using (Process process = Process.GetProcessById(processId)) processName = process.ProcessName;
        }
        catch { }
        int length = GetWindowTextLength(windowHandle);
        StringBuilder title = new StringBuilder(Math.Max(1, length + 1));
        if (length > 0) GetWindowText(windowHandle, title, title.Capacity);
        StringBuilder className = new StringBuilder(256);
        GetClassName(windowHandle, className, className.Capacity);
        events.Enqueue(new WindowEvent(windowHandle, processId, processName, title.ToString(), className.ToString(), IsWindowVisible(windowHandle), eventType));
      }
      catch { }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      uint threadId = hookThreadId;
      if (threadId != 0) PostThreadMessage(threadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
      if (worker != null) worker.Join(2000);
      initialized.Dispose();
    }
  }
}
'@
}

$script:AiNovelGateMonitorStartedAt = ''
$script:AiNovelGateMonitorStoppedAt = ''

function Write-AiNovelGateStatus {
  param(
    [Parameter(Mandatory = $true)][string]$State,
    [string]$Step = '',
    [string]$Failure = ''
  )

  $payload = [pscustomobject]@{
    state = $State
    step = $Step
    failure = $Failure
    updatedAt = [DateTime]::UtcNow.ToString('o')
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
    monitorStoppedAt = $script:AiNovelGateMonitorStoppedAt
  } | ConvertTo-Json -Compress
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $lastWriteError = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      # Node's status reader can briefly hold a Windows share lock. Retrying
      # status publication is transport hygiene only; it does not participate
      # in process/error observation or widen the atomic monitoring boundary.
      [System.IO.File]::WriteAllText($StatusPath, $payload, $encoding)
      return
    }
    catch {
      $lastWriteError = $_
      Start-Sleep -Milliseconds 10
    }
  }
  throw "Could not publish release-gate status after retries: $($lastWriteError.Exception.Message)"
}

function Get-AiNovelGateControl {
  if (-not (Test-Path -LiteralPath $ControlPath -PathType Leaf)) {
    return $null
  }

  try {
    $lines = @(Get-Content -LiteralPath $ControlPath -ErrorAction Stop)
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
      if (-not [string]::IsNullOrWhiteSpace($lines[$index])) {
        return $lines[$index] | ConvertFrom-Json -ErrorAction Stop
      }
    }
  }
  catch {
    # The Node orchestrator may be appending the next control record.
  }
  return $null
}

function Get-AiNovelAliveProcessIds {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$ProcessStartTimeTicks
  )

  $alive = [System.Collections.Generic.List[int]]::new()
  foreach ($processId in $ProcessIds) {
    try {
      if (-not $ProcessStartTimeTicks.ContainsKey([int]$processId)) {
        continue
      }
      $process = [System.Diagnostics.Process]::GetProcessById([int]$processId)
      $process.Refresh()
      $sameProcess = (
        -not $process.HasExited -and
        $process.StartTime.ToUniversalTime().Ticks -eq [long]$ProcessStartTimeTicks[[int]$processId]
      )
      if ($sameProcess) {
        $alive.Add([int]$processId)
      }
      $process.Dispose()
    }
    catch {
      # A missing process has exited.
    }
  }
  return @($alive)
}

function Stop-AiNovelGateProcesses {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$ProcessStartTimeTicks
  )

  foreach ($processId in @(Get-AiNovelAliveProcessIds `
    -ProcessIds $ProcessIds `
    -ProcessStartTimeTicks $ProcessStartTimeTicks)) {
    try {
      & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    }
    catch {
      try {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
      catch {
        # Best-effort cleanup; the preserved evidence remains authoritative.
      }
    }
  }
}

function Add-AiNovelTrackedProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$ProcessStartTimeTicks,
    [long]$ExpectedStartTimeTicks = 0
  )

  try {
    $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    $process.Refresh()
    if ($process.HasExited) {
      $process.Dispose()
      return $false
    }
    $startTimeTicks = $process.StartTime.ToUniversalTime().Ticks
    $process.Dispose()
    if ($ExpectedStartTimeTicks -gt 0 -and $startTimeTicks -ne $ExpectedStartTimeTicks) {
      return $false
    }

    if ($ProcessStartTimeTicks.ContainsKey($ProcessId)) {
      return [long]$ProcessStartTimeTicks[$ProcessId] -eq $startTimeTicks
    }

    [void]$ProcessIds.Add($ProcessId)
    $ProcessStartTimeTicks[$ProcessId] = $startTimeTicks
    return $true
  }
  catch {
    return $false
  }
}

function Initialize-AiNovelGateRootIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][long]$RootProcessStartTimeTicks,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$ProcessStartTimeTicks
  )

  if ($RootProcessStartTimeTicks -le 0) {
    return $false
  }
  return Add-AiNovelTrackedProcess `
    -ProcessId $RootProcessId `
    -ProcessIds $ProcessIds `
    -ProcessStartTimeTicks $ProcessStartTimeTicks `
    -ExpectedStartTimeTicks $RootProcessStartTimeTicks
}

function New-AiNovelGateQuietDeadline {
  param(
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [Parameter(Mandatory = $true)][int]$QuietSeconds
  )

  return $NowUtc.AddSeconds([Math]::Max(5, $QuietSeconds))
}

function Test-AiNovelGateQuietPeriodComplete {
  param(
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [Parameter(Mandatory = $true)][DateTime]$QuietDeadline
  )

  return $NowUtc -ge $QuietDeadline
}

function Get-AiNovelStepCompletionDecision {
  param(
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [Parameter(Mandatory = $true)][int]$AliveProcessCount,
    [Parameter(Mandatory = $true)][DateTime]$ProcessExitDeadline,
    [Nullable[DateTime]]$PostExitQuietDeadline
  )

  if ($AliveProcessCount -gt 0) {
    return [pscustomobject]@{
      State = if ($NowUtc -ge $ProcessExitDeadline) { 'process-timeout' } else { 'waiting-for-exit' }
      PostExitQuietDeadline = $null
    }
  }

  $quietDeadline = if ($null -eq $PostExitQuietDeadline) {
    New-AiNovelGateQuietDeadline -NowUtc $NowUtc -QuietSeconds 5
  } else {
    [DateTime]$PostExitQuietDeadline
  }
  return [pscustomobject]@{
    State = if (Test-AiNovelGateQuietPeriodComplete -NowUtc $NowUtc -QuietDeadline $quietDeadline) {
      'complete'
    } else {
      'waiting-for-quiet'
    }
    PostExitQuietDeadline = $quietDeadline
  }
}

function New-AiNovelGateAtomicMonitor {
  $jobMonitor = $null
  try {
    $jobMonitor = [AiNovelReleaseGate.JobProcessMonitor]::new()
    $windowMonitor = [AiNovelReleaseGate.WindowEventMonitor]::new()
    return [pscustomobject]@{
      Job = $jobMonitor
      Windows = $windowMonitor
    }
  }
  catch {
    if ($null -ne $jobMonitor) {
      $jobMonitor.Dispose()
    }
    throw
  }
}

function Stop-AiNovelGateAtomicJob {
  param([AllowNull()]$AtomicMonitor)

  if ($null -eq $AtomicMonitor) {
    return
  }
  try {
    $AtomicMonitor.Job.Terminate(1)
  }
  catch {
    # The job can already be empty or closed after a monitor failure. The
    # ordinary PID cleanup below remains a secondary best effort.
  }
}

function Complete-AiNovelGateAtomicMonitor {
  param([AllowNull()]$AtomicMonitor)

  if ($null -eq $AtomicMonitor) {
    return
  }
  try {
    $AtomicMonitor.Windows.Dispose()
  }
  finally {
    $AtomicMonitor.Job.Dispose()
  }
}

function Write-AiNovelGateProcessEventEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event
  )

  [ordered]@{
    kind = [string]$Event.Kind
    step = $Step
    processId = [int]$Event.ProcessId
    exitCode = $Event.ExitCode
    captureEstablished = [bool]$Event.CaptureEstablished
    exitCodeCaptured = [bool]$Event.ExitCodeCaptured
    jobMessage = [uint32]$Event.JobMessage
    recordedAt = [string]$Event.RecordedAt
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
  } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $Path 'process-events.jsonl') -Encoding utf8
}

function Write-AiNovelGateWindowEventEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event
  )

  [ordered]@{
    kind = 'window-event'
    step = $Step
    windowHandle = [string]$Event.WindowHandle
    processId = [int]$Event.ProcessId
    processName = [string]$Event.ProcessName
    title = [string]$Event.Title
    className = [string]$Event.ClassName
    visible = [bool]$Event.Visible
    eventType = [uint32]$Event.EventType
    recordedAt = [string]$Event.RecordedAt
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
  } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $Path 'window-events.jsonl') -Encoding utf8
}

function Write-AiNovelGateProcessTreeEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$ProcessIds,
    [Parameter(Mandatory = $true)][hashtable]$ProcessStartTimeTicks,
    [Parameter(Mandatory = $true)][string]$Reason
  )

  $processes = @($ProcessIds | Sort-Object | ForEach-Object {
    [ordered]@{
      processId = [int]$_
      startTimeTicks = if ($ProcessStartTimeTicks.ContainsKey([int]$_)) { [string]$ProcessStartTimeTicks[[int]$_] } else { $null }
    }
  })
  [ordered]@{
    kind = 'process-tree'
    step = $Step
    reason = $Reason
    processes = $processes
    recordedAt = [DateTime]::UtcNow.ToString('o')
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
  } | ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath (Join-Path $Path 'process-events.jsonl') -Encoding utf8
}

function ConvertFrom-AiNovelGateWindowEvent {
  param([Parameter(Mandatory = $true)]$Event)

  return [pscustomobject]@{
    WindowHandle = [string]$Event.WindowHandle
    ProcessId = [int]$Event.ProcessId
    ProcessName = [string]$Event.ProcessName
    Title = [string]$Event.Title
    ClassName = [string]$Event.ClassName
    Visible = [bool]$Event.Visible
  }
}

if ($LoadMonitorLibrary) {
  return
}

foreach ($requiredPath in @($ControlPath, $StatusPath, $EvidencePath)) {
  if ([string]::IsNullOrWhiteSpace($requiredPath)) {
    throw 'ControlPath, StatusPath, and EvidencePath are required outside library mode.'
  }
}

$trackedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$trackedProcessStartTimeTicks = @{}
$trackedNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in @(
  'AI小说作家.exe',
  'AI小说作家',
  'ai-novel-writer',
  'electron-builder',
  'electron-rebuild',
  'rcedit',
  'makensis',
  '7za'
)) {
  [void]$trackedNames.Add($name)
}

$activeStep = ''
$lastSequence = -1
$completionDeadline = $null
$completionQuietDeadline = $null
$quietDeadline = $null
$lastWindowSnapshot = @()
$atomicMonitor = $null

New-Item -ItemType Directory -Path $EvidencePath -Force | Out-Null
try {
  # Both durable channels must exist before the orchestrator is allowed to
  # release a gated target: the Job Object owns the full descendant set and
  # its completion port retains lifecycle events; WinEventHook retains a
  # short-lived error window that a desktop polling snapshot could miss.
  $atomicMonitor = New-AiNovelGateAtomicMonitor
  $script:AiNovelGateMonitorStartedAt = [DateTime]::UtcNow.ToString('o')
}
catch {
  $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
  $failure = "Release gate could not initialize its atomic process/window monitor: $($_.Exception.Message)"
  Save-AiNovelSmokeFailureEvidence `
    -Path $EvidencePath `
    -Failure $failure `
    -Windows @() `
    -ObservedProcessIds @()
  Write-AiNovelGateStatus -State 'failed' -Failure $failure
  throw
}

$baselineWindows = @(Get-AiNovelTopLevelWindowSnapshot)
$startupBlockingWindows = @(Get-AiNovelStartupBlockingErrorWindows `
  -CurrentWindows $baselineWindows `
  -ProductNames ([string[]]@($trackedNames)))
$baselineWindowIdentities = New-AiNovelWindowIdentitySet -Windows $baselineWindows
# Events raised by windows that already existed before the baseline belong to
# the baseline epoch, not to the first release step.
[void]$atomicMonitor.Windows.Drain()

if ($startupBlockingWindows.Count -gt 0) {
  $failure = "Release gate found a pre-existing product error dialog before the first step: $(Format-AiNovelWindowEvidence -Windows $startupBlockingWindows)"
  Save-AiNovelSmokeFailureEvidence `
    -Path $EvidencePath `
    -Failure $failure `
    -Windows $baselineWindows `
    -ObservedProcessIds @()
  $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
  Write-AiNovelGateStatus -State 'failed' -Failure $failure
  exit 1
}
Write-AiNovelGateStatus -State 'ready'

try {
  while ($true) {
    $control = Get-AiNovelGateControl
    if ($control -and [int]$control.sequence -gt $lastSequence) {
      $lastSequence = [int]$control.sequence
      if ([string]$control.state -eq 'stop') {
        $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
        Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'monitor-stop'
        Stop-AiNovelGateProcesses `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks
        Write-AiNovelGateStatus -State 'stopped' -Step $activeStep
        break
      }

      if ([string]$control.state -eq 'running') {
        $activeStep = [string]$control.step
        $trackedProcessIds.Clear()
        $trackedProcessStartTimeTicks.Clear()
        $rootIdentityAccepted = Initialize-AiNovelGateRootIdentity `
          -RootProcessId ([int]$control.rootProcessId) `
          -RootProcessStartTimeTicks ([long]$control.rootProcessStartTimeTicks) `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks
        if (-not $rootIdentityAccepted) {
          throw "Release gate rejected missing, exited, or reused root process identity for step '$activeStep'."
        }
        try {
          # The launcher is deliberately held at its gate. Assigning it to the
          # Job Object before publishing `monitoring` makes every real command
          # and descendant it later creates part of a durable lifecycle stream.
          $atomicMonitor.Job.AssignProcess([int]$control.rootProcessId)
        }
        catch {
          throw "Release gate could not atomically arm step '$activeStep': $($_.Exception.Message)"
        }
        foreach ($name in @($control.relatedTargetNames)) {
          if (-not [string]::IsNullOrWhiteSpace([string]$name)) {
            [void]$trackedNames.Add([string]$name)
          }
        }
        $completionDeadline = $null
        $completionQuietDeadline = $null
        $quietDeadline = $null
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'root-assigned-before-release'
        Write-AiNovelGateStatus -State 'monitoring' -Step $activeStep
      }
      elseif ([string]$control.state -eq 'step-complete') {
        $completionDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $completionQuietDeadline = $null
      }
      elseif ([string]$control.state -eq 'quiet') {
        $activeStep = [string]$control.step
        $trackedProcessIds.Clear()
        $trackedProcessStartTimeTicks.Clear()
        $completionDeadline = $null
        $completionQuietDeadline = $null
        $quietDeadline = New-AiNovelGateQuietDeadline `
          -NowUtc ([DateTime]::UtcNow) `
          -QuietSeconds ([int]$control.quietSeconds)
        Write-AiNovelGateStatus -State 'monitoring' -Step $activeStep
      }
    }

    $windowEventSnapshots = @()
    foreach ($processEvent in @($atomicMonitor.Job.Drain())) {
      Write-AiNovelGateProcessEventEvidence `
        -Path $EvidencePath `
        -Step $activeStep `
        -Event $processEvent
      if ([string]::IsNullOrWhiteSpace($activeStep)) {
        continue
      }
      if ([string]$processEvent.Kind -eq 'monitor-error') {
        throw "Release gate lost its Job Object completion-port stream (Win32 error $($processEvent.JobMessage))."
      }
      if ([string]$processEvent.Kind -eq 'process-start') {
        if (-not [bool]$processEvent.CaptureEstablished) {
          throw "Release gate could not retain a process handle for job-contained PID $($processEvent.ProcessId); its eventual exit code would be unobservable."
        }
        [void](Add-AiNovelTrackedProcess `
          -ProcessId ([int]$processEvent.ProcessId) `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks)
        try {
          $eventProcess = [System.Diagnostics.Process]::GetProcessById([int]$processEvent.ProcessId)
          [void]$trackedNames.Add($eventProcess.ProcessName)
          $eventProcess.Dispose()
        }
        catch {
          # The Job Object still retains the lifecycle record even when the
          # process has already disappeared from the ordinary process table.
        }
      }
      elseif ([string]$processEvent.Kind -eq 'process-exit') {
        if (-not [bool]$processEvent.ExitCodeCaptured) {
          throw "Release gate could not capture the exit code for job-contained PID $($processEvent.ProcessId)."
        }
        if ([int]$processEvent.ExitCode -ne 0) {
          throw "Release gate step '$activeStep' observed job-contained PID $($processEvent.ProcessId) exit code $($processEvent.ExitCode)."
        }
      }
    }

    $atomicMonitor.Windows.ThrowIfUnhealthy()
    foreach ($windowEvent in @($atomicMonitor.Windows.Drain())) {
      Write-AiNovelGateWindowEventEvidence `
        -Path $EvidencePath `
        -Step $activeStep `
        -Event $windowEvent
      $windowEventSnapshots += ConvertFrom-AiNovelGateWindowEvent -Event $windowEvent
    }

    foreach ($knownProcessId in @($trackedProcessIds)) {
      $isOriginalProcess = Add-AiNovelTrackedProcess `
        -ProcessId ([int]$knownProcessId) `
        -ProcessIds $trackedProcessIds `
        -ProcessStartTimeTicks $trackedProcessStartTimeTicks
      if (-not $isOriginalProcess) {
        continue
      }
      $discoveredStartTimeTicks = @{}
      foreach ($descendantId in @(Get-AiNovelProcessTreeIds `
          -RootProcessId $knownProcessId `
          -RootStartTimeTicks ([long]$trackedProcessStartTimeTicks[$knownProcessId]) `
          -DiscoveredStartTimeTicks $discoveredStartTimeTicks)) {
        $isOriginalProcess = Add-AiNovelTrackedProcess `
          -ProcessId ([int]$descendantId) `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -ExpectedStartTimeTicks ([long]$discoveredStartTimeTicks[[string][int]$descendantId])
        if (-not $isOriginalProcess) {
          continue
        }
        try {
          $descendant = [System.Diagnostics.Process]::GetProcessById([int]$descendantId)
          [void]$trackedNames.Add($descendant.ProcessName)
          $descendant.Dispose()
        }
        catch {
          # The process may exit while its identity is being recorded.
        }
      }
    }

    $lastWindowSnapshot = @(Get-AiNovelTopLevelWindowSnapshot)
    # A hooked event is preserved even if the dialog vanished before this
    # ordinary desktop snapshot. The current snapshot remains useful for
    # windows whose accessibility event was unavailable or delayed.
    $windowCandidates = @($lastWindowSnapshot) + @($windowEventSnapshots)
    if (-not [string]::IsNullOrWhiteSpace($activeStep)) {
      $targetNameSnapshot = [string[]]@($trackedNames | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_)
      })
      $newErrorWindows = @(Get-AiNovelNewErrorWindows `
        -BaselineIdentities $baselineWindowIdentities `
        -CurrentWindows $windowCandidates `
        -TargetProcessIds $trackedProcessIds `
        -TargetProcessStartTimeTicks $trackedProcessStartTimeTicks `
        -TargetNames $targetNameSnapshot)
      if ($newErrorWindows.Count -gt 0) {
        $failure = "Release gate step '$activeStep' displayed a new Windows error dialog: $(Format-AiNovelWindowEvidence -Windows $newErrorWindows)"
        Save-AiNovelSmokeFailureEvidence `
          -Path $EvidencePath `
          -Failure $failure `
          -Windows $windowCandidates `
          -ObservedProcessIds @($trackedProcessIds)
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'error-window'
        $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
        Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure
        Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
        Stop-AiNovelGateProcesses `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks
        exit 1
      }
    }

    if ($completionDeadline) {
      $aliveProcessIds = @(Get-AiNovelAliveProcessIds `
        -ProcessIds $trackedProcessIds `
        -ProcessStartTimeTicks $trackedProcessStartTimeTicks)
      $completionDecision = Get-AiNovelStepCompletionDecision `
        -NowUtc ([DateTime]::UtcNow) `
        -AliveProcessCount $aliveProcessIds.Count `
        -ProcessExitDeadline $completionDeadline `
        -PostExitQuietDeadline $completionQuietDeadline
      $completionQuietDeadline = $completionDecision.PostExitQuietDeadline
      if ($completionDecision.State -eq 'complete') {
        # Keep the full historical PID + start-time set until error-window
        # detection has run continuously for five seconds after process exit.
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'step-completed-after-quiet-period'
        Write-AiNovelGateStatus -State 'step-completed' -Step $activeStep
        $completionDeadline = $null
        $completionQuietDeadline = $null
      }
      elseif ($completionDecision.State -eq 'process-timeout') {
        $failure = "Release gate step '$activeStep' left related processes running: $($aliveProcessIds -join ', ')"
        Save-AiNovelSmokeFailureEvidence `
          -Path $EvidencePath `
          -Failure $failure `
          -Windows $lastWindowSnapshot `
          -ObservedProcessIds @($trackedProcessIds)
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'process-timeout'
        $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
        Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure
        Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
        Stop-AiNovelGateProcesses `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks
        exit 1
      }
    }

    if (
      $quietDeadline -and
      (Test-AiNovelGateQuietPeriodComplete `
        -NowUtc ([DateTime]::UtcNow) `
        -QuietDeadline $quietDeadline)
    ) {
      # Error-window detection above has run continuously for the full quiet
      # interval, including this final desktop snapshot.
      Write-AiNovelGateProcessTreeEvidence `
        -Path $EvidencePath `
        -Step $activeStep `
        -ProcessIds $trackedProcessIds `
        -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
        -Reason 'final-quiet-period-completed'
      Write-AiNovelGateStatus -State 'step-completed' -Step $activeStep
      $quietDeadline = $null
    }

    Start-Sleep -Milliseconds 100
  }
}
catch {
  $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
  $failure = "Release gate monitor failed during '$activeStep': $($_.Exception.Message)"
  Save-AiNovelSmokeFailureEvidence `
    -Path $EvidencePath `
    -Failure $failure `
    -Windows $lastWindowSnapshot `
    -ObservedProcessIds @($trackedProcessIds)
  Write-AiNovelGateProcessTreeEvidence `
    -Path $EvidencePath `
    -Step $activeStep `
    -ProcessIds $trackedProcessIds `
    -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
    -Reason 'monitor-failure'
  Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure
  Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
  Stop-AiNovelGateProcesses `
    -ProcessIds $trackedProcessIds `
    -ProcessStartTimeTicks $trackedProcessStartTimeTicks
  throw
}
finally {
  Complete-AiNovelGateAtomicMonitor -AtomicMonitor $atomicMonitor
}
