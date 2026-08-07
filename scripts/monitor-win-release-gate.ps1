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
using System.IO;
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
    public string ProcessStartTimeTicks { get; private set; }
    public string ProcessName { get; private set; }
    public string ImagePath { get; private set; }
    public string CommandLine { get; private set; }
    public int? ParentProcessId { get; private set; }
    public string ParentProcessStartTimeTicks { get; private set; }
    public string ParentImagePath { get; private set; }
    public bool IdentityCaptured { get; private set; }
    public bool CommandLineCaptured { get; private set; }
    public string IdentityCaptureError { get; private set; }
    public string RecordedAt { get; private set; }

    internal JobProcessEvent(
      string kind,
      int processId,
      int? exitCode,
      bool captureEstablished,
      bool exitCodeCaptured,
      uint jobMessage,
      string processStartTimeTicks = null,
      string processName = null,
      string imagePath = null,
      string commandLine = null,
      int? parentProcessId = null,
      string parentProcessStartTimeTicks = null,
      string parentImagePath = null,
      bool identityCaptured = false,
      bool commandLineCaptured = false,
      string identityCaptureError = null
    ) {
      Kind = kind;
      ProcessId = processId;
      ExitCode = exitCode;
      CaptureEstablished = captureEstablished;
      ExitCodeCaptured = exitCodeCaptured;
      JobMessage = jobMessage;
      ProcessStartTimeTicks = processStartTimeTicks;
      ProcessName = processName;
      ImagePath = imagePath;
      CommandLine = commandLine;
      ParentProcessId = parentProcessId;
      ParentProcessStartTimeTicks = parentProcessStartTimeTicks;
      ParentImagePath = parentImagePath;
      IdentityCaptured = identityCaptured;
      CommandLineCaptured = commandLineCaptured;
      IdentityCaptureError = identityCaptureError;
      RecordedAt = DateTime.UtcNow.ToString("o");
    }
  }

  // QueryFullProcessImageName can preserve an 8.3 alias such as
  // C:\\Users\\RUNNER~1 even though the monitor's TEMP root uses the long
  // profile name. Keep that translation narrowly available to the PowerShell
  // classifier; a failed lookup deliberately leaves the classifier fail-closed.
  public static class WindowsPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(
      string shortPath,
      StringBuilder longPath,
      uint cchBuffer
    );

    public static string TryGetLongPathName(string path) {
      if (String.IsNullOrWhiteSpace(path)) return null;
      uint required = GetLongPathName(path, null, 0);
      if (required == 0) return null;
      StringBuilder buffer = new StringBuilder(unchecked((int)required + 1));
      uint written = GetLongPathName(path, buffer, unchecked((uint)buffer.Capacity));
      if (written == 0 || written >= buffer.Capacity) return null;
      return buffer.ToString();
    }

  }

  public static class WindowsCommandLine {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Parse(string commandLine) {
      if (String.IsNullOrWhiteSpace(commandLine)) {
        throw new ArgumentException("A Windows command line is required.", "commandLine");
      }
      int argumentCount;
      IntPtr argumentVector = CommandLineToArgvW(commandLine, out argumentCount);
      if (argumentVector == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not parse the Windows command line.");
      }
      try {
        string[] arguments = new string[argumentCount];
        for (int index = 0; index < argumentCount; index++) {
          IntPtr argument = Marshal.ReadIntPtr(argumentVector, index * IntPtr.Size);
          arguments[index] = Marshal.PtrToStringUni(argument);
        }
        return arguments;
      }
      finally {
        LocalFree(argumentVector);
      }
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
    private const int ProcessCommandLineInformation = 60;
    private const int WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectAssociateCompletionPort {
      public IntPtr CompletionKey;
      public IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime {
      public uint LowDateTime;
      public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeUnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation {
      public IntPtr Reserved1;
      public IntPtr PebBaseAddress;
      public IntPtr Reserved2_0;
      public IntPtr Reserved2_1;
      public UIntPtr UniqueProcessId;
      public UIntPtr InheritedFromUniqueProcessId;
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
    private static extern bool GetProcessTimes(
      IntPtr process,
      out NativeFileTime creationTime,
      out NativeFileTime exitTime,
      out NativeFileTime kernelTime,
      out NativeFileTime userTime
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
      IntPtr process,
      uint flags,
      StringBuilder executablePath,
      ref int size
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int processInformationClass,
      IntPtr processInformation,
      int processInformationLength,
      out int returnLength
    );

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

    private static string TryReadProcessStartTimeTicks(IntPtr process) {
      NativeFileTime creationTime;
      NativeFileTime exitTime;
      NativeFileTime kernelTime;
      NativeFileTime userTime;
      if (!GetProcessTimes(process, out creationTime, out exitTime, out kernelTime, out userTime)) return null;
      long fileTime = ((long)creationTime.HighDateTime << 32) | creationTime.LowDateTime;
      return DateTime.FromFileTimeUtc(fileTime).Ticks.ToString();
    }

    private static string TryReadProcessImagePath(IntPtr process) {
      int size = 32768;
      StringBuilder buffer = new StringBuilder(size);
      if (!QueryFullProcessImageName(process, 0, buffer, ref size)) return null;
      return buffer.ToString();
    }

    private static string TryReadProcessCommandLine(IntPtr process) {
      int requiredLength;
      NtQueryInformationProcess(
        process,
        ProcessCommandLineInformation,
        IntPtr.Zero,
        0,
        out requiredLength
      );
      if (requiredLength <= 0) return null;
      IntPtr buffer = Marshal.AllocHGlobal(requiredLength);
      try {
        int status = NtQueryInformationProcess(
          process,
          ProcessCommandLineInformation,
          buffer,
          requiredLength,
          out requiredLength
        );
        if (status != 0) return null;
        NativeUnicodeString value = (NativeUnicodeString)Marshal.PtrToStructure(buffer, typeof(NativeUnicodeString));
        if (value.Buffer == IntPtr.Zero || value.Length == 0) return String.Empty;
        return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
      }
      finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static int? TryReadParentProcessId(IntPtr process) {
      int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returnedLength;
        int status = NtQueryInformationProcess(
          process,
          0,
          buffer,
          size,
          out returnedLength
        );
        if (status != 0) return null;
        ProcessBasicInformation info = (ProcessBasicInformation)Marshal.PtrToStructure(buffer, typeof(ProcessBasicInformation));
        ulong parentProcessId = info.InheritedFromUniqueProcessId.ToUInt64();
        if (parentProcessId == 0 || parentProcessId > Int32.MaxValue) return null;
        return unchecked((int)parentProcessId);
      }
      finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void CaptureParentProcessIdentity(
      int? parentProcessId,
      out string parentProcessStartTimeTicks,
      out string parentImagePath
    ) {
      parentProcessStartTimeTicks = null;
      parentImagePath = null;
      if (!parentProcessId.HasValue || parentProcessId.Value <= 0) return;
      IntPtr parent = OpenProcess(
        ProcessQueryLimitedInformation | Synchronize,
        false,
        unchecked((uint)parentProcessId.Value)
      );
      if (parent == IntPtr.Zero) return;
      try {
        parentProcessStartTimeTicks = TryReadProcessStartTimeTicks(parent);
        parentImagePath = TryReadProcessImagePath(parent);
      }
      finally {
        CloseHandle(parent);
      }
    }

    private static void CaptureProcessIdentity(
      IntPtr process,
      int processId,
      out string processStartTimeTicks,
      out string processName,
      out string imagePath,
      out string commandLine,
      out int? parentProcessId,
      out string parentProcessStartTimeTicks,
      out string parentImagePath,
      out bool identityCaptured,
      out bool commandLineCaptured,
      out string captureError
    ) {
      processStartTimeTicks = null;
      processName = null;
      imagePath = null;
      commandLine = null;
      parentProcessId = null;
      parentProcessStartTimeTicks = null;
      parentImagePath = null;
      identityCaptured = false;
      commandLineCaptured = false;
      captureError = null;
      try {
        processStartTimeTicks = TryReadProcessStartTimeTicks(process);
        imagePath = TryReadProcessImagePath(process);
        if (!String.IsNullOrEmpty(imagePath)) processName = Path.GetFileNameWithoutExtension(imagePath);
        if (String.IsNullOrEmpty(processName)) {
          try {
            using (Process managedProcess = Process.GetProcessById(processId)) {
              processName = managedProcess.ProcessName;
            }
          }
          catch { }
        }
        identityCaptured = !String.IsNullOrEmpty(processStartTimeTicks);
        commandLine = TryReadProcessCommandLine(process);
        commandLineCaptured = !String.IsNullOrEmpty(commandLine);
        parentProcessId = TryReadParentProcessId(process);
        CaptureParentProcessIdentity(
          parentProcessId,
          out parentProcessStartTimeTicks,
          out parentImagePath
        );
      }
      catch (Exception exception) {
        captureError = exception.Message;
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
          string processStartTimeTicks = null;
          string processName = null;
          string imagePath = null;
          string commandLine = null;
          int? parentProcessId = null;
          string parentProcessStartTimeTicks = null;
          string parentImagePath = null;
          bool identityCaptured = false;
          bool commandLineCaptured = false;
          string identityCaptureError = null;
          if (captured) {
            CaptureProcessIdentity(
              process,
              processId,
              out processStartTimeTicks,
              out processName,
              out imagePath,
              out commandLine,
              out parentProcessId,
              out parentProcessStartTimeTicks,
              out parentImagePath,
              out identityCaptured,
              out commandLineCaptured,
              out identityCaptureError
            );
            IntPtr stale;
            if (processHandles.TryRemove(processId, out stale)) CloseHandle(stale);
            if (!processHandles.TryAdd(processId, process)) {
              CloseHandle(process);
              captured = false;
            }
          }
          events.Enqueue(new JobProcessEvent(
            "process-start",
            processId,
            null,
            captured,
            false,
            message,
            processStartTimeTicks,
            processName,
            imagePath,
            commandLine,
            parentProcessId,
            parentProcessStartTimeTicks,
            parentImagePath,
            identityCaptured,
            commandLineCaptured,
            identityCaptureError
          ));
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
    [string]$Failure = '',
    [AllowNull()]$LegacyBridge = $null
  )

  $statusRecord = [ordered]@{
    state = $State
    step = $Step
    failure = $Failure
    updatedAt = [DateTime]::UtcNow.ToString('o')
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
    monitorStoppedAt = $script:AiNovelGateMonitorStoppedAt
  }
  if ($null -ne $LegacyBridge) {
    $statusRecord.legacyBridge = $LegacyBridge
  }
  $payload = [pscustomobject]$statusRecord | ConvertTo-Json -Depth 8 -Compress
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
    $lines = @(Get-Content -LiteralPath $ControlPath -Encoding UTF8 -ErrorAction Stop)
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

function Get-AiNovelGateArmedRootIdentity {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][long]$RootProcessStartTimeTicks
  )

  # Capture the gate root once, while it is deliberately held before release.
  # Child lifecycle records can later be consumed after that root has exited,
  # so the uninstaller exception must retain this immutable PID/start/path
  # identity instead of accepting a same-named helper chain from elsewhere in
  # the Job Object.
  if ($RootProcessStartTimeTicks -le 0) {
    return $null
  }
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($RootProcessId)
    $process.Refresh()
    if ($process.HasExited) {
      return $null
    }
    $actualStartTimeTicks = $process.StartTime.ToUniversalTime().Ticks
    if ($actualStartTimeTicks -ne $RootProcessStartTimeTicks) {
      return $null
    }
    $imagePath = [System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)
    if ([string]::IsNullOrWhiteSpace($imagePath) -or $imagePath -notmatch '^[A-Za-z]:\\') {
      return $null
    }
    return [pscustomobject][ordered]@{
      processId = $RootProcessId
      startTimeTicks = [string]$actualStartTimeTicks
      processName = [string]$process.ProcessName
      executablePath = $imagePath
      commandLine = $null
      parentProcessId = $null
      parentProcessStartTimeTicks = $null
      parentExecutablePath = $null
      identityCaptured = $true
      commandLineCaptured = $false
      identityCaptureError = $null
    }
  }
  catch {
    return $null
  }
  finally {
    if ($null -ne $process) {
      $process.Dispose()
    }
  }
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

function Assert-AiNovelGateProcessExitSucceeded {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event
  )

  $failure = Get-AiNovelGateProcessExitFailure -Step $Step -Event $Event
  if ($null -ne $failure) {
    throw $failure
  }
}

function Get-AiNovelGateProcessExitFailure {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event
  )

  if (-not [bool]$Event.ExitCodeCaptured -or $null -eq $Event.ExitCode) {
    return "Release gate could not capture the exit code for job-contained PID $($Event.ProcessId)."
  }
  if ([uint32]$Event.JobMessage -eq 8) {
    return "Release gate step '$Step' observed an abnormal exit for job-contained PID $($Event.ProcessId) with code $($Event.ExitCode)."
  }
  if ([int]$Event.ExitCode -ne 0) {
    return "Release gate step '$Step' observed a nonzero exit code $($Event.ExitCode) for job-contained PID $($Event.ProcessId)."
  }
  return $null
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

function Get-AiNovelGateProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$Event,
    [long]$ExpectedStartTimeTicks = 0
  )

  # The C# completion-port worker captures these fields while it still owns a
  # native process handle. Do not make a slow CIM call in this PowerShell loop:
  # that would delay draining the next short-lived child event and lose the
  # very command-line evidence this record is meant to preserve.
  $identity = [ordered]@{
    processId = [int]$Event.ProcessId
    startTimeTicks = if ($null -ne $Event.ProcessStartTimeTicks) { [string]$Event.ProcessStartTimeTicks } else { $null }
    processName = if ($null -ne $Event.ProcessName) { [string]$Event.ProcessName } else { $null }
    executablePath = if ($null -ne $Event.ImagePath) { [string]$Event.ImagePath } else { $null }
    commandLine = if ($null -ne $Event.CommandLine) { [string]$Event.CommandLine } else { $null }
    parentProcessId = if ($null -ne $Event.ParentProcessId) { [int]$Event.ParentProcessId } else { $null }
    parentProcessStartTimeTicks = if ($null -ne $Event.ParentProcessStartTimeTicks) { [string]$Event.ParentProcessStartTimeTicks } else { $null }
    parentExecutablePath = if ($null -ne $Event.ParentImagePath) { [string]$Event.ParentImagePath } else { $null }
    identityCaptured = [bool]$Event.IdentityCaptured
    commandLineCaptured = [bool]$Event.CommandLineCaptured
    identityCaptureError = if ($null -ne $Event.IdentityCaptureError) { [string]$Event.IdentityCaptureError } else { $null }
  }
  if (
    $ExpectedStartTimeTicks -gt 0 -and
    $identity.identityCaptured -and
    [long]$identity.startTimeTicks -ne $ExpectedStartTimeTicks
  ) {
    $identity['identityCaptured'] = $false
    $identity['identityCaptureError'] = 'process start identity did not match the tracked Job Object member'
  }
  return [pscustomobject]$identity
}

function Test-AiNovelGateSystemPowerShellImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath)) {
    return $false
  }
  try {
    # QueryFullProcessImageName returns an absolute image path. Reject a
    # relative lookalike before normalization so the exception remains limited
    # to the two Windows PowerShell binaries the NSIS stub can invoke.
    if ($ImagePath -notmatch '^[A-Za-z]:\\') {
      return $false
    }
    $systemRoot = [System.Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) {
      return $false
    }
    $windowsRoot = [System.IO.Path]::GetFullPath($systemRoot)
    $expectedPaths = @(
      [System.IO.Path]::GetFullPath((Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')),
      [System.IO.Path]::GetFullPath((Join-Path $windowsRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'))
    )
    $actual = [System.IO.Path]::GetFullPath($ImagePath)
    return @($expectedPaths | Where-Object {
      [string]::Equals($actual, $_, [System.StringComparison]::OrdinalIgnoreCase)
    }).Count -eq 1
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateNsisInstallerImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath)) {
    return $false
  }
  try {
    if ($ImagePath -notmatch '^[A-Za-z]:\\') {
      return $false
    }
    $fileName = [System.IO.Path]::GetFileName($ImagePath)
    return $fileName -match '^ai-novel-writer-setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.exe$'
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateKnownNsisPowerShellProbeCommand {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$PowerShellImagePath
  )

  if (
    [string]::IsNullOrWhiteSpace($CommandLine) -or
    [string]::IsNullOrWhiteSpace($PowerShellImagePath)
  ) {
    return $false
  }
  # nsExec may remove the source template's argv[0] quotes when it launches a
  # path without spaces. Bind either runtime form to the captured full image
  # path; the switch, whitespace, and payload remain byte-for-byte literals.
  $arguments = Get-AiNovelGateBoundCommandArguments `
    -CommandLine $CommandLine `
    -ImagePath $PowerShellImagePath
  if ($null -eq $arguments) {
    return $false
  }
  $availabilityArguments =
    ' -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
  $policyArguments =
    ' -C "if ((Get-ExecutionPolicy -Scope Process) -eq ''Restricted'') { exit 1 } else { exit 0 }"'
  if (
    [string]::Equals($arguments, $availabilityArguments, [System.StringComparison]::Ordinal) -or
    [string]::Equals($arguments, $policyArguments, [System.StringComparison]::Ordinal)
  ) {
    return $true
  }

  $runningProcessPrefix =
    ' -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('''
  $runningProcessSuffix =
    ''', ''CurrentCultureIgnoreCase'')}).Count -gt 0) { exit 0 } else { exit 1 }"'
  if (
    -not $arguments.StartsWith($runningProcessPrefix, [System.StringComparison]::Ordinal) -or
    -not $arguments.EndsWith($runningProcessSuffix, [System.StringComparison]::Ordinal)
  ) {
    return $false
  }
  $installPathLength = $arguments.Length - $runningProcessPrefix.Length - $runningProcessSuffix.Length
  if ($installPathLength -le 0) {
    return $false
  }
  $installPath = $arguments.Substring($runningProcessPrefix.Length, $installPathLength)
  return $installPath -notmatch "['`r`n]"
}

function Test-AiNovelGateSameAbsolutePath {
  param(
    [AllowEmptyString()][string]$Left,
    [AllowEmptyString()][string]$Right
  )

  if (
    [string]::IsNullOrWhiteSpace($Left) -or
    [string]::IsNullOrWhiteSpace($Right) -or
    $Left -notmatch '^[A-Za-z]:\\' -or
    $Right -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }
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

function Resolve-AiNovelGateCanonicalExistingPath {
  param([AllowEmptyString()][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\') {
    return $null
  }
  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    # Do not accept a path merely because its textual 8.3 spelling happens to
    # resemble TEMP. When the file still exists (as the NSIS helper does while
    # its probes run), expand the alias through kernel32. If expansion fails,
    # retain the absolute spelling and let the strict TEMP containment test
    # reject any unproven alias.
    $longPath = [AiNovelReleaseGate.WindowsPath]::TryGetLongPathName($fullPath)
    if (-not [string]::IsNullOrWhiteSpace($longPath)) {
      return [System.IO.Path]::GetFullPath($longPath)
    }
    return $fullPath
  }
  catch {
    return $null
  }
}

function Test-AiNovelGateDirectChildDirectory {
  param(
    [AllowEmptyString()][string]$DirectoryPath,
    [AllowEmptyString()][string]$RootPath
  )

  $directoryFullPath = Resolve-AiNovelGateCanonicalExistingPath -Path $DirectoryPath
  $rootFullPath = Resolve-AiNovelGateCanonicalExistingPath -Path $RootPath
  if (
    [string]::IsNullOrWhiteSpace($directoryFullPath) -or
    [string]::IsNullOrWhiteSpace($rootFullPath)
  ) {
    return $false
  }
  try {
    $rootWithSeparator = $rootFullPath.TrimEnd([char]92) + [char]92
    if (-not $directoryFullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
    $relativeDirectory = $directoryFullPath.Substring($rootWithSeparator.Length)
    return (
      -not [string]::IsNullOrWhiteSpace($relativeDirectory) -and
      $relativeDirectory.IndexOf([char]92) -lt 0
    )
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateNsisUninstallerImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or $ImagePath -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  try {
    return [string]::Equals(
      [System.IO.Path]::GetFileName([System.IO.Path]::GetFullPath($ImagePath)),
      'Uninstall AI小说作家.exe',
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateNsisUninstallerHelperImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or $ImagePath -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  try {
    $helperFullPath = Resolve-AiNovelGateCanonicalExistingPath -Path $ImagePath
    if ([string]::IsNullOrWhiteSpace($helperFullPath)) {
      return $false
    }
    $helperDirectory = [System.IO.Path]::GetDirectoryName($helperFullPath)
    $helperFileName = [System.IO.Path]::GetFileName($helperFullPath)
    $helperDirectoryName = [System.IO.Path]::GetFileName($helperDirectory)
    return (
      (Test-AiNovelGateDirectChildDirectory `
        -DirectoryPath $helperDirectory `
        -RootPath ([System.IO.Path]::GetTempPath())) -and
      $helperDirectoryName -match '^(?i:~nsu[A-Za-z0-9]+\.tmp)$' -and
      $helperFileName -match '^(?i:Un_[A-Za-z0-9]+\.exe)$'
    )
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateSameBoundSystemExecutablePath {
  param(
    [AllowEmptyString()][string]$Left,
    [AllowEmptyString()][string]$Right
  )

  # The command line must normally bind argv[0] to the exact image path
  # captured from the process. A 32-bit NSIS stub is the narrow exception:
  # $SYSDIR can be recorded as System32 while QueryFullProcessImageName sees
  # the redirected SysWOW64 image. Do not turn this into a basename match.
  if (Test-AiNovelGateSameAbsolutePath -Left $Left -Right $Right) {
    return $true
  }
  if (
    [string]::IsNullOrWhiteSpace($Left) -or
    [string]::IsNullOrWhiteSpace($Right) -or
    $Left -notmatch '^[A-Za-z]:\\' -or
    $Right -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }
  try {
    $systemRoot = [System.Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot) -or $systemRoot -notmatch '^[A-Za-z]:\\') {
      return $false
    }
    $windowsRoot = [System.IO.Path]::GetFullPath($systemRoot)
    $leftFullPath = [System.IO.Path]::GetFullPath($Left)
    $rightFullPath = [System.IO.Path]::GetFullPath($Right)
    $allowedRelativeExecutablePaths = @(
      'cmd.exe',
      'find.exe',
      'WindowsPowerShell\v1.0\powershell.exe'
    )
    foreach ($relativeExecutablePath in $allowedRelativeExecutablePaths) {
      $system32Path = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot (Join-Path 'System32' $relativeExecutablePath)))
      $sysWow64Path = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot (Join-Path 'SysWOW64' $relativeExecutablePath)))
      $isSystem32ToSysWow64 = (
        [string]::Equals($leftFullPath, $system32Path, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($rightFullPath, $sysWow64Path, [System.StringComparison]::OrdinalIgnoreCase)
      )
      $isSysWow64ToSystem32 = (
        [string]::Equals($leftFullPath, $sysWow64Path, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($rightFullPath, $system32Path, [System.StringComparison]::OrdinalIgnoreCase)
      )
      if ($isSystem32ToSysWow64 -or $isSysWow64ToSystem32) {
        return $true
      }
    }
    return $false
  }
  catch {
    return $false
  }
}

function Get-AiNovelGateBoundCommandArguments {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$ImagePath
  )

  if (
    [string]::IsNullOrWhiteSpace($CommandLine) -or
    [string]::IsNullOrWhiteSpace($ImagePath)
  ) {
    return $null
  }
  $argvZero = ''
  $arguments = ''
  if ($CommandLine[0] -eq '"') {
    $closingQuote = $CommandLine.IndexOf('"', 1)
    if ($closingQuote -le 1) {
      return $null
    }
    $argvZero = $CommandLine.Substring(1, $closingQuote - 1)
    $arguments = $CommandLine.Substring($closingQuote + 1)
  }
  else {
    $firstWhitespace = [regex]::Match($CommandLine, '\s')
    if (-not $firstWhitespace.Success -or $firstWhitespace.Index -le 0) {
      return $null
    }
    $argvZero = $CommandLine.Substring(0, $firstWhitespace.Index)
    $arguments = $CommandLine.Substring($firstWhitespace.Index)
  }
  if (-not (Test-AiNovelGateSameBoundSystemExecutablePath -Left $argvZero -Right $ImagePath)) {
    return $null
  }
  return [string]$arguments
}

function Test-AiNovelGateSystemUtilityImage {
  param(
    [AllowEmptyString()][string]$ImagePath,
    [Parameter(Mandatory = $true)][ValidateSet('cmd.exe', 'find.exe')][string]$FileName
  )

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or $ImagePath -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  try {
    $systemRoot = [System.Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) {
      return $false
    }
    $expectedPaths = @(
      (Join-Path $systemRoot (Join-Path 'System32' $FileName))
      (Join-Path $systemRoot (Join-Path 'SysWOW64' $FileName))
    )
    return @($expectedPaths | Where-Object {
      Test-AiNovelGateSameAbsolutePath -Left $ImagePath -Right $_
    }).Count -eq 1
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateKnownNsisCmdProcessCheckCommand {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$CmdImagePath
  )

  $arguments = Get-AiNovelGateBoundCommandArguments `
    -CommandLine $CommandLine `
    -ImagePath $CmdImagePath
  if ($null -eq $arguments) {
    return $false
  }
  try {
    $expectedFindPath = Join-Path ([System.IO.Path]::GetDirectoryName($CmdImagePath)) 'find.exe'
    $prefix = ' /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq AI小说作家.exe" /FO CSV | "'
    $suffix = '" "AI小说作家.exe"'
    if (
      -not $arguments.StartsWith($prefix, [System.StringComparison]::Ordinal) -or
      -not $arguments.EndsWith($suffix, [System.StringComparison]::Ordinal)
    ) {
      return $false
    }
    $findPathLength = $arguments.Length - $prefix.Length - $suffix.Length
    if ($findPathLength -le 0) {
      return $false
    }
    $findPath = $arguments.Substring($prefix.Length, $findPathLength)
    return Test-AiNovelGateSameBoundSystemExecutablePath -Left $findPath -Right $expectedFindPath
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateKnownNsisFindNoMatchCommand {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$FindImagePath
  )

  $arguments = Get-AiNovelGateBoundCommandArguments `
    -CommandLine $CommandLine `
    -ImagePath $FindImagePath
  return (
    $null -ne $arguments -and
    [string]::Equals($arguments, '  "AI小说作家.exe"', [System.StringComparison]::Ordinal)
  )
}

function Test-AiNovelGateExpectedExitOne {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event
  )

  return (
    $Step -in @('smoke:win-installer', 'smoke:win-v025-upgrade', 'windows-in-app-update-e2e') -and
    [bool]$Event.ExitCodeCaptured -and
    $null -ne $Event.ExitCode -and
    [uint32]$Event.JobMessage -eq 7 -and
    [int]$Event.ExitCode -eq 1
  )
}

function Test-AiNovelGateCapturedParentIdentity {
  param(
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity
  )

  if (
    $null -eq $ChildIdentity -or
    $null -eq $ParentIdentity -or
    -not [bool]$ChildIdentity.identityCaptured -or
    -not [bool]$ParentIdentity.identityCaptured -or
    $null -eq $ChildIdentity.parentProcessId -or
    [int]$ParentIdentity.processId -ne [int]$ChildIdentity.parentProcessId -or
    [string]::IsNullOrWhiteSpace([string]$ParentIdentity.startTimeTicks) -or
    [string]::IsNullOrWhiteSpace([string]$ChildIdentity.parentProcessStartTimeTicks) -or
    -not [string]::Equals(
      [string]$ParentIdentity.startTimeTicks,
      [string]$ChildIdentity.parentProcessStartTimeTicks,
      [System.StringComparison]::Ordinal
    ) -or
    -not (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$ParentIdentity.executablePath) `
      -Right ([string]$ChildIdentity.parentExecutablePath))
  ) {
    return $false
  }
  return $true
}

function Test-AiNovelGateCapturedInstallerParent {
  param(
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity
  )

  return (
    (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $ChildIdentity `
      -ParentIdentity $ParentIdentity) -and
    (Test-AiNovelGateNsisInstallerImage -ImagePath ([string]$ParentIdentity.executablePath))
  )
}

function Test-AiNovelGateIdentityAncestryToArmedRoot {
  param(
    [AllowNull()]$StartIdentity,
    [AllowNull()]$TrackedProcessIdentities,
    [AllowNull()]$ArmedRootIdentity,
    [ValidateRange(1, 64)][int]$MaxDepth = 16
  )

  # The release launcher can add shell wrappers before it starts the NSIS
  # uninstaller. Walk the captured parent identities rather than assuming that
  # the named uninstaller is a direct child of the armed Node root. Every edge
  # remains bound to PID, creation time, and absolute image path; a missing
  # record, PID reuse, cycle, or excessive ancestry depth fails closed.
  if (
    $null -eq $StartIdentity -or
    $null -eq $TrackedProcessIdentities -or
    $null -eq $ArmedRootIdentity
  ) {
    return $false
  }

  try {
    $seenIdentityKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $currentIdentity = $StartIdentity
    for ($depth = 0; $depth -lt $MaxDepth; $depth += 1) {
      $currentIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $currentIdentity
      if ($null -eq $currentIdentityKey -or -not $seenIdentityKeys.Add($currentIdentityKey)) {
        return $false
      }

      if (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $currentIdentity `
        -ParentIdentity $ArmedRootIdentity) {
        return $true
      }

      if (
        $null -eq $currentIdentity.parentProcessId -or
        -not $TrackedProcessIdentities.ContainsKey([int]$currentIdentity.parentProcessId)
      ) {
        return $false
      }
      $parentIdentity = $TrackedProcessIdentities[[int]$currentIdentity.parentProcessId]
      if (-not (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $currentIdentity `
        -ParentIdentity $parentIdentity)) {
        return $false
      }
      $currentIdentity = $parentIdentity
    }
  }
  catch {
    return $false
  }

  return $false
}

function Test-AiNovelGateCapturedNsisUninstallerHelperParent {
  param(
    [AllowNull()]$HelperIdentity,
    [AllowNull()]$UninstallerIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # electron-builder's NSIS uninstaller first copies itself into the current
  # TEMP root (~nsu*.tmp\Un_*.exe), then runs its process-exit checks from that
  # helper. This is intentionally a fixed product chain, not a basename-based
  # exemption for arbitrary temporary executables.
  return (
    (Test-AiNovelGateNsisUninstallerHelperImage -ImagePath ([string]$HelperIdentity.executablePath)) -and
    (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $HelperIdentity `
      -ParentIdentity $UninstallerIdentity) -and
    (Test-AiNovelGateNsisUninstallerImage -ImagePath ([string]$UninstallerIdentity.executablePath)) -and
    # The named uninstaller is not itself the armed Node release-gate root.
    # Its complete captured ancestry must terminate at that exact root so an
    # unrelated same-named NSIS chain inside the Job Object cannot qualify.
    (Test-AiNovelGateIdentityAncestryToArmedRoot `
      -StartIdentity $UninstallerIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities `
      -ArmedRootIdentity $ArmedRootIdentity)
  )
}

function Test-AiNovelGateCapturedNsisProbeParent {
  param(
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # Keep the original direct-installer check intact. The only additional
  # branch is the complete helper -> named uninstaller -> armed gate-root
  # chain, with every edge bound by PID, creation time, and absolute image
  # path. The direct installer branch deliberately retains its original
  # classification semantics.
  return (
    (Test-AiNovelGateCapturedInstallerParent `
      -ChildIdentity $ChildIdentity `
      -ParentIdentity $ParentIdentity) -or
    ((Test-AiNovelGateCapturedNsisUninstallerHelperParent `
        -HelperIdentity $ParentIdentity `
        -UninstallerIdentity $GrandParentIdentity `
        -ArmedRootIdentity $ArmedRootIdentity `
        -TrackedProcessIdentities $TrackedProcessIdentities) -and
      (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $ChildIdentity `
        -ParentIdentity $ParentIdentity))
  )
}

function Get-AiNovelGateProcessIdentityKey {
  param([AllowNull()]$ProcessIdentity)

  # A PID by itself can be reused. Keep the immutable creation time and
  # canonical image path in the correlation key so a verified find.exe child
  # cannot authorize a different cmd.exe instance.
  if (
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    $null -eq $ProcessIdentity.processId -or
    [int]$ProcessIdentity.processId -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$ProcessIdentity.startTimeTicks) -or
    [string]::IsNullOrWhiteSpace([string]$ProcessIdentity.executablePath) -or
    [string]$ProcessIdentity.executablePath -notmatch '^[A-Za-z]:\\'
  ) {
    return $null
  }
  try {
    $startTimeTicks = [long]$ProcessIdentity.startTimeTicks
    if ($startTimeTicks -le 0) {
      return $null
    }
    $fullPath = [System.IO.Path]::GetFullPath([string]$ProcessIdentity.executablePath)
    return ('{0}|{1}|{2}' -f [int]$ProcessIdentity.processId, $startTimeTicks, $fullPath)
  }
  catch {
    return $null
  }
}

function Test-AiNovelGateExpectedNsisPowerShellProbeExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # electron-builder's NSIS template deliberately treats exit 1 from these
  # three probe commands as a normal branch: PowerShell availability,
  # execution-policy availability, and "no process in INSTDIR". This exception
  # applies only to installer smoke steps, not to a general PowerShell process.
  if (-not (Test-AiNovelGateExpectedExitOne -Step $Step -Event $Event)) {
    return $false
  }
  if (
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    -not [bool]$ProcessIdentity.commandLineCaptured -or
    $null -eq $ProcessIdentity.parentProcessId
  ) {
    return $false
  }
  if (-not (Test-AiNovelGateSystemPowerShellImage -ImagePath ([string]$ProcessIdentity.executablePath))) {
    return $false
  }
  if (-not (Test-AiNovelGateKnownNsisPowerShellProbeCommand `
    -CommandLine ([string]$ProcessIdentity.commandLine) `
    -PowerShellImagePath ([string]$ProcessIdentity.executablePath))) {
    return $false
  }
  return Test-AiNovelGateCapturedNsisProbeParent `
    -ChildIdentity $ProcessIdentity `
    -ParentIdentity $ParentIdentity `
    -GrandParentIdentity $GrandParentIdentity `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities
}

function Test-AiNovelGateNsisCmdProcessCheckCandidate {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  if (-not (Test-AiNovelGateExpectedExitOne -Step $Step -Event $Event)) {
    return $false
  }
  if (
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    -not [bool]$ProcessIdentity.commandLineCaptured -or
    -not (Test-AiNovelGateSystemUtilityImage `
      -ImagePath ([string]$ProcessIdentity.executablePath) `
      -FileName 'cmd.exe') -or
    -not (Test-AiNovelGateKnownNsisCmdProcessCheckCommand `
      -CommandLine ([string]$ProcessIdentity.commandLine) `
      -CmdImagePath ([string]$ProcessIdentity.executablePath))
  ) {
    return $false
  }
  return Test-AiNovelGateCapturedNsisProbeParent `
    -ChildIdentity $ProcessIdentity `
    -ParentIdentity $ParentIdentity `
    -GrandParentIdentity $GrandParentIdentity `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities
}

function Test-AiNovelGateExpectedNsisCmdProcessCheckExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities,
    [AllowNull()]$VerifiedFindParentKeys
  )

  if (-not (Test-AiNovelGateNsisCmdProcessCheckCandidate `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $ParentIdentity `
    -GrandParentIdentity $GrandParentIdentity `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities)) {
    return $false
  }
  $processIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $ProcessIdentity
  return (
    $null -ne $VerifiedFindParentKeys -and
    $null -ne $processIdentityKey -and
    $VerifiedFindParentKeys.Contains($processIdentityKey)
  )
}

function Register-AiNovelGateVerifiedNsisFindParent {
  param(
    [Parameter(Mandatory = $true)]$VerifiedFindParentKeys,
    [Parameter(Mandatory = $true)][hashtable]$PendingNsisCmdExitFailures,
    [AllowEmptyString()][string]$ParentProcessIdentityKey
  )

  if ([string]::IsNullOrWhiteSpace($ParentProcessIdentityKey)) {
    return $false
  }
  [void]$VerifiedFindParentKeys.Add($ParentProcessIdentityKey)
  $wasPending = $PendingNsisCmdExitFailures.ContainsKey($ParentProcessIdentityKey)
  [void]$PendingNsisCmdExitFailures.Remove($ParentProcessIdentityKey)
  return $wasPending
}

function Add-AiNovelGatePendingNsisCmdExitFailure {
  param(
    [Parameter(Mandatory = $true)][hashtable]$PendingNsisCmdExitFailures,
    [AllowEmptyString()][string]$ProcessIdentityKey,
    [AllowEmptyString()][string]$Failure
  )

  if (
    [string]::IsNullOrWhiteSpace($ProcessIdentityKey) -or
    [string]::IsNullOrWhiteSpace($Failure)
  ) {
    return $false
  }
  if (-not $PendingNsisCmdExitFailures.ContainsKey($ProcessIdentityKey)) {
    # The failure text comes from the durable Job Object event and contains
    # only step, PID, and exit code. Do not retain the command line here.
    $PendingNsisCmdExitFailures[$ProcessIdentityKey] = $Failure
  }
  return $true
}

function Get-AiNovelGatePendingNsisCmdExitFailure {
  param([Parameter(Mandatory = $true)][hashtable]$PendingNsisCmdExitFailures)

  $entry = Get-AiNovelGatePendingNsisCmdExitFailureEntry `
    -PendingNsisCmdExitFailures $PendingNsisCmdExitFailures
  if ($null -eq $entry) {
    return $null
  }
  return [string]$entry.Failure
}

function Get-AiNovelGatePendingNsisCmdExitFailureEntry {
  param([Parameter(Mandatory = $true)][hashtable]$PendingNsisCmdExitFailures)

  if ($PendingNsisCmdExitFailures.Count -eq 0) {
    return $null
  }
  $entry = @($PendingNsisCmdExitFailures.GetEnumerator() | Sort-Object {
    [string]$_.Key
  } | Select-Object -First 1)
  if ($entry.Count -ne 1) {
    return $null
  }
  $processIdentityKey = [string]$entry[0].Key
  $failure = [string]$entry[0].Value
  if (
    [string]::IsNullOrWhiteSpace($processIdentityKey) -or
    [string]::IsNullOrWhiteSpace($failure)
  ) {
    return $null
  }
  return [pscustomobject][ordered]@{
    processIdentityKey = $processIdentityKey
    failure = $failure
  }
}

function New-AiNovelGateDeferredNsisCmdExitFailureState {
  return @{
    failure = $null
    source = ''
    processIdentityKey = $null
    correlationDeadline = $null
    earliestFailureDrain = 0
  }
}

function Clear-AiNovelGateDeferredNsisCmdExitFailureState {
  param([Parameter(Mandatory = $true)][hashtable]$State)

  $State.failure = $null
  $State.source = ''
  $State.processIdentityKey = $null
  $State.correlationDeadline = $null
  $State.earliestFailureDrain = 0
}

function Promote-AiNovelGatePendingNsisCmdExitFailure {
  param(
    [Parameter(Mandatory = $true)][hashtable]$State,
    [AllowNull()]$PendingEntry,
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [Parameter(Mandatory = $true)][int]$CurrentDrain,
    [ValidateRange(1, 10)][int]$CorrelationGraceSeconds = 1
  )

  if (
    $null -ne $State.failure -or
    $null -eq $PendingEntry -or
    [string]::IsNullOrWhiteSpace([string]$PendingEntry.processIdentityKey) -or
    [string]::IsNullOrWhiteSpace([string]$PendingEntry.failure)
  ) {
    return $false
  }
  # The terminal Job Object notification may precede the child find.exe
  # completion record. Preserve the exact cmd.exe identity so only that
  # process's verified find.exe child can revoke this deferred failure.
  $State.failure = [string]$PendingEntry.failure
  $State.source = 'nsis-cmd-awaiting-verified-find'
  $State.processIdentityKey = [string]$PendingEntry.processIdentityKey
  $State.correlationDeadline = $NowUtc.AddSeconds($CorrelationGraceSeconds)
  $State.earliestFailureDrain = $CurrentDrain + 1
  return $true
}

function Resolve-AiNovelGateDeferredNsisCmdExitFailure {
  param(
    [Parameter(Mandatory = $true)][hashtable]$State,
    [AllowEmptyString()][string]$ProcessIdentityKey
  )

  if (
    [string]::IsNullOrWhiteSpace($ProcessIdentityKey) -or
    $State.source -ne 'nsis-cmd-awaiting-verified-find' -or
    [string]::IsNullOrWhiteSpace([string]$State.processIdentityKey) -or
    -not [string]::Equals(
      [string]$State.processIdentityKey,
      $ProcessIdentityKey,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    return $false
  }
  Clear-AiNovelGateDeferredNsisCmdExitFailureState -State $State
  return $true
}

function Test-AiNovelGateDeferredNsisCmdExitFailureReady {
  param(
    [Parameter(Mandatory = $true)][hashtable]$State,
    [Parameter(Mandatory = $true)][DateTime]$NowUtc,
    [Parameter(Mandatory = $true)][int]$CurrentDrain
  )

  if ($null -eq $State.failure) {
    return $false
  }
  # A malformed special state must never silently permit a release. The valid
  # state, however, always waits through one later Drain() plus its short
  # correlation grace so the next batch can deliver the matching find.exe.
  if (
    $State.source -ne 'nsis-cmd-awaiting-verified-find' -or
    [string]::IsNullOrWhiteSpace([string]$State.processIdentityKey) -or
    $null -eq $State.correlationDeadline -or
    [int]$State.earliestFailureDrain -le 0
  ) {
    return $true
  }
  return (
    $CurrentDrain -ge [int]$State.earliestFailureDrain -and
    $NowUtc -ge [DateTime]$State.correlationDeadline
  )
}

function Test-AiNovelGateExpectedNsisFindNoMatchExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$GreatGrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  if (-not (Test-AiNovelGateExpectedExitOne -Step $Step -Event $Event)) {
    return $false
  }
  if (
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    -not [bool]$ProcessIdentity.commandLineCaptured -or
    -not (Test-AiNovelGateSystemUtilityImage `
      -ImagePath ([string]$ProcessIdentity.executablePath) `
      -FileName 'find.exe') -or
    -not (Test-AiNovelGateKnownNsisFindNoMatchCommand `
      -CommandLine ([string]$ProcessIdentity.commandLine) `
      -FindImagePath ([string]$ProcessIdentity.executablePath)) -or
    -not (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $ProcessIdentity `
      -ParentIdentity $ParentIdentity) -or
    $null -eq $ParentIdentity -or
    -not [bool]$ParentIdentity.commandLineCaptured -or
    -not (Test-AiNovelGateSystemUtilityImage `
      -ImagePath ([string]$ParentIdentity.executablePath) `
      -FileName 'cmd.exe') -or
    -not (Test-AiNovelGateKnownNsisCmdProcessCheckCommand `
      -CommandLine ([string]$ParentIdentity.commandLine) `
      -CmdImagePath ([string]$ParentIdentity.executablePath))
  ) {
    return $false
  }
  return Test-AiNovelGateCapturedNsisProbeParent `
    -ChildIdentity $ParentIdentity `
    -ParentIdentity $GrandParentIdentity `
    -GrandParentIdentity $GreatGrandParentIdentity `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities
}

function ConvertTo-AiNovelGateProcessEvidenceIdentity {
  param([AllowNull()]$ProcessIdentity)

  if ($null -eq $ProcessIdentity) {
    return $null
  }
  # The full command line is retained only in memory for the exact NSIS probe
  # classifier. Diagnostics are downloadable artifacts, so persist only the
  # fact that capture succeeded and never the argument payload itself.
  return [pscustomobject][ordered]@{
    processId = $ProcessIdentity.processId
    startTimeTicks = $ProcessIdentity.startTimeTicks
    processName = $ProcessIdentity.processName
    executablePath = $ProcessIdentity.executablePath
    parentProcessId = $ProcessIdentity.parentProcessId
    parentProcessStartTimeTicks = $ProcessIdentity.parentProcessStartTimeTicks
    parentExecutablePath = $ProcessIdentity.parentExecutablePath
    identityCaptured = [bool]$ProcessIdentity.identityCaptured
    commandLineCaptured = [bool]$ProcessIdentity.commandLineCaptured
    commandLineRedacted = [bool]$ProcessIdentity.commandLineCaptured
    identityCaptureError = $ProcessIdentity.identityCaptureError
  }
}

function Write-AiNovelGateProcessEventEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity = $null,
    [AllowEmptyString()][string]$ExitClassification = ''
  )

  [ordered]@{
    kind = [string]$Event.Kind
    step = $Step
    processId = [int]$Event.ProcessId
    exitCode = $Event.ExitCode
    captureEstablished = [bool]$Event.CaptureEstablished
    exitCodeCaptured = [bool]$Event.ExitCodeCaptured
    jobMessage = [uint32]$Event.JobMessage
    processIdentity = ConvertTo-AiNovelGateProcessEvidenceIdentity -ProcessIdentity $ProcessIdentity
    exitClassification = $ExitClassification
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

function Test-AiNovelGateLegacyBridgeSourceTag {
  param([AllowEmptyString()][string]$SourceTag)

  if ([string]::IsNullOrWhiteSpace($SourceTag) -or $SourceTag -notmatch '^v\d+\.\d+\.\d+$') {
    return $false
  }
  try {
    return ([version]$SourceTag.Substring(1)) -lt ([version]'0.7.0')
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateExactIdentity {
  param(
    [AllowNull()]$Identity,
    [int]$ProcessId,
    [AllowEmptyString()][string]$StartTimeTicks,
    [AllowEmptyString()][string]$ExecutablePath
  )

  return (
    $null -ne $Identity -and
    [bool]$Identity.identityCaptured -and
    $ProcessId -gt 0 -and
    [int]$Identity.processId -eq $ProcessId -and
    -not [string]::IsNullOrWhiteSpace($StartTimeTicks) -and
    [string]$Identity.startTimeTicks -eq $StartTimeTicks -and
    (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$Identity.executablePath) `
      -Right $ExecutablePath)
  )
}

function Test-AiNovelGateLiveIdentity {
  param([AllowNull()]$Identity)

  if (
    $null -eq $Identity -or
    -not [bool]$Identity.identityCaptured -or
    [int]$Identity.processId -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$Identity.startTimeTicks) -or
    [string]::IsNullOrWhiteSpace([string]$Identity.executablePath)
  ) {
    return $false
  }
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$Identity.processId)
    $process.Refresh()
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks -ne [long]$Identity.startTimeTicks) {
      return $false
    }
    return Test-AiNovelGateSameAbsolutePath `
      -Left ([System.IO.Path]::GetFullPath([string]$process.MainModule.FileName)) `
      -Right ([string]$Identity.executablePath)
  }
  catch {
    return $false
  }
  finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Test-AiNovelGateLegacyBridgeHistoricalCommand {
  param(
    [AllowNull()]$InstallerIdentity,
    [AllowEmptyString()][string]$InstallRoot
  )

  if (
    $null -eq $InstallerIdentity -or
    -not [bool]$InstallerIdentity.commandLineCaptured -or
    [string]::IsNullOrWhiteSpace($InstallRoot) -or
    $InstallRoot -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }
  try {
    [string[]]$arguments = [AiNovelReleaseGate.WindowsCommandLine]::Parse(
      [string]$InstallerIdentity.commandLine
    )
  }
  catch {
    return $false
  }
  if (
    $arguments.Count -lt 2 -or
    -not (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$arguments[0]) `
      -Right ([string]$InstallerIdentity.executablePath)) -or
    -not [string]::Equals(
      [string]$arguments[1],
      '--updated',
      [System.StringComparison]::Ordinal
    )
  ) {
    return $false
  }

  # Historical electron-updater launches are interactive. They contain only
  # --updated, plus an optional install-directory binding when explicitly set.
  # Parse argv with Windows' own tokenizer so quoting and separator whitespace
  # are accepted without admitting silent, package, reordered, or extra flags.
  if ($arguments.Count -eq 2) {
    return $true
  }
  if ($arguments.Count -ne 3) {
    return $false
  }
  $directoryArgument = [string]$arguments[2]
  $directoryPrefix = '/D='
  if (-not $directoryArgument.StartsWith($directoryPrefix, [System.StringComparison]::Ordinal)) {
    return $false
  }
  $boundInstallRoot = $directoryArgument.Substring($directoryPrefix.Length)
  if ([string]::IsNullOrWhiteSpace($boundInstallRoot)) {
    return $false
  }
  return Test-AiNovelGateSameAbsolutePath -Left $boundInstallRoot -Right $InstallRoot
}

function New-AiNovelGateLegacyBridgeState {
  param(
    [AllowNull()]$Control,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step
  )

  if ($null -eq $Control.legacyBridge) {
    return $null
  }
  if ($Step -ne 'windows-in-app-update-e2e') {
    throw "Release gate rejected a legacy bridge outside the Windows in-app update E2E step."
  }
  $bridge = $Control.legacyBridge
  if (
    [string]$bridge.mode -ne 'legacy-bridge' -or
    -not (Test-AiNovelGateLegacyBridgeSourceTag -SourceTag ([string]$bridge.sourceTag))
  ) {
    throw 'Release gate rejected an invalid legacy bridge mode or source version.'
  }
  $installer = $bridge.expectedInstaller
  if (
    $null -eq $installer -or
    [string]$installer.name -notmatch '^ai-novel-writer-setup-\d+\.\d+\.\d+\.exe$' -or
    [long]$installer.size -le 0 -or
    [string]$installer.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
    [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
    $env:LOCALAPPDATA -notmatch '^[A-Za-z]:\\'
  ) {
    throw 'Release gate rejected incomplete legacy bridge installer metadata.'
  }
  $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA (Join-Path 'ai-novel-writer-updater\pending' ([string]$installer.name))))
  if (-not (Test-AiNovelGateSameAbsolutePath -Left ([string]$bridge.expectedPendingInstallerPath) -Right $expectedPath)) {
    throw 'Release gate rejected a legacy bridge pending installer path outside LOCALAPPDATA.'
  }
  return [pscustomobject]@{
    Mode = 'legacy-bridge'
    SourceTag = [string]$bridge.sourceTag
    ExpectedPendingInstallerPath = $expectedPath
    ExpectedInstallerName = [string]$installer.name
    ExpectedInstallerSize = [long]$installer.size
    ExpectedInstallerSha256 = ([string]$installer.sha256).ToLowerInvariant()
    State = 'pre-armed'
    PendingOldApplicationIdentity = $null
    OldApplicationIdentity = $null
    ObservedInstallerIdentity = $null
    InstallRoot = $null
    AllowedWizardWindowKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  }
}

function Request-AiNovelGateLegacyBridgeArm {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Control,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ActiveStep
  )

  if ($null -eq $LegacyBridge -or $ActiveStep -ne 'windows-in-app-update-e2e' -or $LegacyBridge.State -ne 'pre-armed') {
    throw 'Release gate rejected an unexpected legacy bridge arm request.'
  }
  if ([string]$Control.step -ne $ActiveStep -or [string]$Control.sourceTag -ne $LegacyBridge.SourceTag) {
    throw 'Release gate rejected a legacy bridge arm request with a mismatched step or source tag.'
  }
  $installRoot = [string]$Control.installRoot
  if ([string]::IsNullOrWhiteSpace($installRoot) -or $installRoot -notmatch '^[A-Za-z]:\\') {
    throw 'Release gate rejected a legacy bridge arm request without an absolute install root.'
  }
  $resolvedInstallRoot = [System.IO.Path]::GetFullPath($installRoot)
  $expectedOldApplication = Join-Path $resolvedInstallRoot ('AI' + [char]0x5C0F + [char]0x8BF4 + [char]0x4F5C + [char]0x5BB6 + '.exe')
  if (
    [int]$Control.processId -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$Control.processStartTimeTicks) -or
    -not (Test-AiNovelGateSameAbsolutePath -Left ([string]$Control.executablePath) -Right $expectedOldApplication)
  ) {
    throw 'Release gate rejected a legacy bridge arm request with an invalid old application identity.'
  }

  $LegacyBridge.PendingOldApplicationIdentity = [pscustomobject]@{
    processId = [int]$Control.processId
    startTimeTicks = [string]$Control.processStartTimeTicks
    executablePath = [System.IO.Path]::GetFullPath([string]$Control.executablePath)
  }
  $LegacyBridge.InstallRoot = $resolvedInstallRoot
  $LegacyBridge.State = 'arm-requested'
}

function Complete-AiNovelGateLegacyBridgeArm {
  param(
    [AllowNull()]$LegacyBridge,
    [Parameter(Mandatory = $true)]$TrackedProcessIdentities
  )

  if ($null -eq $LegacyBridge -or $LegacyBridge.State -ne 'arm-requested') {
    return $false
  }
  $pendingIdentity = $LegacyBridge.PendingOldApplicationIdentity
  if ($null -eq $pendingIdentity -or -not $TrackedProcessIdentities.ContainsKey([int]$pendingIdentity.processId)) {
    return $false
  }
  $oldApplicationIdentity = $TrackedProcessIdentities[[int]$pendingIdentity.processId]
  if (-not (Test-AiNovelGateExactIdentity `
    -Identity $oldApplicationIdentity `
    -ProcessId ([int]$pendingIdentity.processId) `
    -StartTimeTicks ([string]$pendingIdentity.startTimeTicks) `
    -ExecutablePath ([string]$pendingIdentity.executablePath))) {
    throw 'Release gate rejected a legacy bridge arm request without the captured old application identity.'
  }

  $LegacyBridge.OldApplicationIdentity = $oldApplicationIdentity
  $LegacyBridge.PendingOldApplicationIdentity = $null
  $LegacyBridge.State = 'armed'
  return $true
}

function Get-AiNovelGateLegacyBridgeStatus {
  param([AllowNull()]$LegacyBridge)

  if ($null -eq $LegacyBridge) {
    return $null
  }
  $installer = $LegacyBridge.ObservedInstallerIdentity
  return [pscustomobject][ordered]@{
    mode = $LegacyBridge.Mode
    sourceTag = $LegacyBridge.SourceTag
    state = $LegacyBridge.State
    expectedPendingInstallerPath = $LegacyBridge.ExpectedPendingInstallerPath
    expectedInstaller = [ordered]@{
      name = $LegacyBridge.ExpectedInstallerName
      size = $LegacyBridge.ExpectedInstallerSize
      sha256 = $LegacyBridge.ExpectedInstallerSha256
    }
    processId = if ($null -ne $installer) { [int]$installer.processId } else { $null }
    startTimeTicks = if ($null -ne $installer) { [string]$installer.startTimeTicks } else { $null }
    executablePath = if ($null -ne $installer) { [string]$installer.executablePath } else { $null }
    legacyInteractiveHandoffObserved = ($null -ne $installer)
    bridgeApplied = ($LegacyBridge.State -eq 'terminated')
    allowedWizardWindowCount = $LegacyBridge.AllowedWizardWindowKeys.Count
  }
}

function Test-AiNovelGateLegacyBridgeInstaller {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$InstallerIdentity,
    [AllowNull()]$ParentIdentity
  )

  if (
    $Step -ne 'windows-in-app-update-e2e' -or
    $null -eq $LegacyBridge -or
    $LegacyBridge.State -ne 'armed' -or
    $null -eq $LegacyBridge.OldApplicationIdentity -or
    $null -eq $InstallerIdentity
  ) {
    return $false
  }
  return (
    [bool]$InstallerIdentity.identityCaptured -and
    [bool]$InstallerIdentity.commandLineCaptured -and
    (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$InstallerIdentity.executablePath) `
      -Right $LegacyBridge.ExpectedPendingInstallerPath) -and
    ([System.IO.Path]::GetFileName([string]$InstallerIdentity.executablePath) -eq $LegacyBridge.ExpectedInstallerName) -and
    (Test-AiNovelGateExactIdentity `
      -Identity $ParentIdentity `
      -ProcessId ([int]$LegacyBridge.OldApplicationIdentity.processId) `
      -StartTimeTicks ([string]$LegacyBridge.OldApplicationIdentity.startTimeTicks) `
      -ExecutablePath ([string]$LegacyBridge.OldApplicationIdentity.executablePath)) -and
    (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $InstallerIdentity `
      -ParentIdentity $ParentIdentity) -and
    (Test-AiNovelGateLegacyBridgeHistoricalCommand `
      -InstallerIdentity $InstallerIdentity `
      -InstallRoot $LegacyBridge.InstallRoot)
  )
}

function Test-AiNovelGateLegacyBridgeTermination {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$InstallerIdentity
  )

  return (
    $Step -eq 'windows-in-app-update-e2e' -and
    $null -ne $LegacyBridge -and
    $LegacyBridge.State -eq 'termination-armed' -and
    $null -ne $LegacyBridge.ObservedInstallerIdentity -and
    (Test-AiNovelGateExactIdentity `
      -Identity $InstallerIdentity `
      -ProcessId ([int]$LegacyBridge.ObservedInstallerIdentity.processId) `
      -StartTimeTicks ([string]$LegacyBridge.ObservedInstallerIdentity.startTimeTicks) `
      -ExecutablePath ([string]$LegacyBridge.ObservedInstallerIdentity.executablePath))
  )
}

function Get-AiNovelGateLegacyBridgeWindowKey {
  param([AllowNull()]$Window)

  if ($null -eq $Window) {
    return $null
  }
  return "$([string]$Window.WindowHandle)|$([int]$Window.ProcessId)"
}

function Test-AiNovelGateLegacyBridgeWizardWindow {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Window
  )

  if (
    $null -eq $LegacyBridge -or
    $null -eq $LegacyBridge.ObservedInstallerIdentity -or
    $null -eq $Window -or
    -not [bool]$Window.Visible -or
    [string]$Window.ClassName -ne '#32770' -or
    [int]$Window.ProcessId -ne [int]$LegacyBridge.ObservedInstallerIdentity.processId
  ) {
    return $false
  }
  $expectedTitle = 'AI' + [char]0x5C0F + [char]0x8BF4 + [char]0x4F5C + [char]0x5BB6 + ' Setup '
  if ([string]$Window.Title -cne $expectedTitle) {
    return $false
  }
  $key = Get-AiNovelGateLegacyBridgeWindowKey -Window $Window
  if ($LegacyBridge.State -eq 'terminated') {
    return $LegacyBridge.AllowedWizardWindowKeys.Contains($key)
  }
  if ($LegacyBridge.State -notin @('observed', 'authorized', 'termination-armed')) {
    return $false
  }
  return (Test-AiNovelGateLiveIdentity -Identity $LegacyBridge.ObservedInstallerIdentity)
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
$trackedProcessIdentities = @{}
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
$deferredProcessFailure = $null
$deferredProcessFailureDeadline = $null
$deferredNsisCmdExitFailure = New-AiNovelGateDeferredNsisCmdExitFailureState
$armedRootIdentity = $null
$verifiedNsisFindParentKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$pendingNsisCmdExitFailures = @{}
$legacyBridge = $null
$drainSequence = 0

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
        $trackedProcessIdentities.Clear()
        $deferredProcessFailure = $null
        $deferredProcessFailureDeadline = $null
        Clear-AiNovelGateDeferredNsisCmdExitFailureState -State $deferredNsisCmdExitFailure
        $armedRootIdentity = $null
        $verifiedNsisFindParentKeys.Clear()
        $pendingNsisCmdExitFailures.Clear()
        $legacyBridge = New-AiNovelGateLegacyBridgeState -Control $control -Step $activeStep
        $rootIdentityAccepted = Initialize-AiNovelGateRootIdentity `
          -RootProcessId ([int]$control.rootProcessId) `
          -RootProcessStartTimeTicks ([long]$control.rootProcessStartTimeTicks) `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks
        if (-not $rootIdentityAccepted) {
          throw "Release gate rejected missing, exited, or reused root process identity for step '$activeStep'."
        }
        $armedRootIdentity = Get-AiNovelGateArmedRootIdentity `
          -RootProcessId ([int]$control.rootProcessId) `
          -RootProcessStartTimeTicks ([long]$control.rootProcessStartTimeTicks)
        if ($null -eq $armedRootIdentity) {
          throw "Release gate could not capture the immutable PID/start/path identity for root process $($control.rootProcessId) in step '$activeStep'."
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
        Write-AiNovelGateStatus -State 'monitoring' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
      }
      elseif ([string]$control.state -eq 'legacy-bridge-arm') {
        Request-AiNovelGateLegacyBridgeArm -LegacyBridge $legacyBridge -Control $control -ActiveStep $activeStep
        Write-AiNovelGateStatus -State 'legacy-bridge-awaiting-old-application' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
      }
      elseif ([string]$control.state -eq 'legacy-bridge-authorize') {
        if ($null -eq $legacyBridge -or $activeStep -ne 'windows-in-app-update-e2e' -or $legacyBridge.State -ne 'observed') {
          throw 'Release gate rejected an unexpected legacy bridge authorization request.'
        }
        if (
          [string]$control.step -ne $activeStep -or
          [string]$control.sourceTag -ne $legacyBridge.SourceTag -or
          -not [bool]$control.pendingInstallerDigestMatched -or
          [string]$control.stagingInstallerSha256 -cne $legacyBridge.ExpectedInstallerSha256 -or
          -not (Test-AiNovelGateExactIdentity `
            -Identity $legacyBridge.ObservedInstallerIdentity `
            -ProcessId ([int]$control.processId) `
            -StartTimeTicks ([string]$control.processStartTimeTicks) `
            -ExecutablePath ([string]$control.executablePath))
        ) {
          throw 'Release gate rejected a legacy bridge authorization request that did not bind the observed installer identity and release digest.'
        }
        $legacyBridge.State = 'authorized'
        Write-AiNovelGateStatus -State 'legacy-bridge-authorized' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
      }
      elseif ([string]$control.state -eq 'legacy-bridge-terminate') {
        if ($null -eq $legacyBridge -or $activeStep -ne 'windows-in-app-update-e2e' -or $legacyBridge.State -ne 'authorized') {
          throw 'Release gate rejected an unexpected legacy bridge termination request.'
        }
        if (
          [string]$control.step -ne $activeStep -or
          [string]$control.sourceTag -ne $legacyBridge.SourceTag -or
          -not (Test-AiNovelGateExactIdentity `
            -Identity $legacyBridge.ObservedInstallerIdentity `
            -ProcessId ([int]$control.processId) `
            -StartTimeTicks ([string]$control.processStartTimeTicks) `
            -ExecutablePath ([string]$control.executablePath))
        ) {
          throw 'Release gate rejected a legacy bridge termination request that did not bind the observed installer identity.'
        }
        $legacyBridge.State = 'termination-armed'
        Write-AiNovelGateStatus -State 'legacy-bridge-termination-armed' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
      }
      elseif ([string]$control.state -eq 'step-complete') {
        $completionDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $completionQuietDeadline = $null
      }
      elseif ([string]$control.state -eq 'quiet') {
        $activeStep = [string]$control.step
        $trackedProcessIds.Clear()
        $trackedProcessStartTimeTicks.Clear()
        $trackedProcessIdentities.Clear()
        $deferredProcessFailure = $null
        $deferredProcessFailureDeadline = $null
        Clear-AiNovelGateDeferredNsisCmdExitFailureState -State $deferredNsisCmdExitFailure
        $armedRootIdentity = $null
        $verifiedNsisFindParentKeys.Clear()
        $pendingNsisCmdExitFailures.Clear()
        $legacyBridge = $null
        $completionDeadline = $null
        $completionQuietDeadline = $null
        $quietDeadline = New-AiNovelGateQuietDeadline `
          -NowUtc ([DateTime]::UtcNow) `
          -QuietSeconds ([int]$control.quietSeconds)
        Write-AiNovelGateStatus -State 'monitoring' -Step $activeStep
      }
    }

    $windowEventSnapshots = @()
    $jobBecameEmpty = $false
    $drainSequence += 1
    foreach ($processEvent in @($atomicMonitor.Job.Drain())) {
      $processIdentity = $null
      $exitClassification = ''
      $processEventEvidenceWritten = $false
      if ([string]$processEvent.Kind -eq 'process-start') {
        $processIdentity = Get-AiNovelGateProcessIdentity -Event $processEvent
        if (-not [bool]$processEvent.CaptureEstablished) {
          Write-AiNovelGateProcessEventEvidence `
            -Path $EvidencePath `
            -Step $activeStep `
            -Event $processEvent `
            -ProcessIdentity $processIdentity `
            -ExitClassification 'capture-failure'
          throw "Release gate could not retain a process handle for job-contained PID $($processEvent.ProcessId); its eventual exit code would be unobservable."
        }
        $eventStartTimeTicks = 0
        try {
          $eventStartTimeTicks = [long]$processEvent.ProcessStartTimeTicks
        }
        catch {
          # Fall back to a direct identity read only for a legacy or degraded
          # event that did not retain the creation time in the native worker.
        }
        if ($eventStartTimeTicks -gt 0) {
          [void]$trackedProcessIds.Add([int]$processEvent.ProcessId)
          $trackedProcessStartTimeTicks[[int]$processEvent.ProcessId] = $eventStartTimeTicks
        } else {
          [void](Add-AiNovelTrackedProcess `
            -ProcessId ([int]$processEvent.ProcessId) `
            -ProcessIds $trackedProcessIds `
            -ProcessStartTimeTicks $trackedProcessStartTimeTicks)
        }
        $expectedStartTimeTicks = if ($trackedProcessStartTimeTicks.ContainsKey([int]$processEvent.ProcessId)) {
          [long]$trackedProcessStartTimeTicks[[int]$processEvent.ProcessId]
        } else { 0 }
        $processIdentity = Get-AiNovelGateProcessIdentity `
          -Event $processEvent `
          -ExpectedStartTimeTicks $expectedStartTimeTicks
        $trackedProcessIdentities[[int]$processEvent.ProcessId] = $processIdentity
        try {
          if ($null -ne $processIdentity.processName) {
            [void]$trackedNames.Add([string]$processIdentity.processName)
          }
        }
        catch {
          # The event's durable Job Object record is still retained below.
        }
        Write-AiNovelGateProcessEventEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ExitClassification 'identity-captured'
        $processEventEvidenceWritten = $true
        if ($null -ne $legacyBridge) {
          $legacyParentIdentity = $null
          if (
            $null -ne $processIdentity.parentProcessId -and
            $trackedProcessIdentities.ContainsKey([int]$processIdentity.parentProcessId)
          ) {
            $legacyParentIdentity = $trackedProcessIdentities[[int]$processIdentity.parentProcessId]
          }
          if (Test-AiNovelGateLegacyBridgeInstaller `
            -Step $activeStep `
            -LegacyBridge $legacyBridge `
            -InstallerIdentity $processIdentity `
            -ParentIdentity $legacyParentIdentity) {
            $legacyBridge.ObservedInstallerIdentity = $processIdentity
            $legacyBridge.State = 'observed'
            Write-AiNovelGateStatus -State 'legacy-bridge-observed' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
          }
          elseif (
            $legacyBridge.State -eq 'armed' -and
            (Test-AiNovelGateNsisInstallerImage -ImagePath ([string]$processIdentity.executablePath))
          ) {
            throw 'Release gate rejected an unbound NSIS installer while the legacy bridge was armed.'
          }
          elseif (
            $legacyBridge.State -in @('observed', 'authorized', 'termination-armed') -and
            (Test-AiNovelGateSameAbsolutePath `
              -Left ([string]$processIdentity.executablePath) `
              -Right $legacyBridge.ExpectedPendingInstallerPath)
          ) {
            throw 'Release gate rejected a second legacy bridge installer process.'
          }
        }
      }
      elseif ([string]$processEvent.Kind -eq 'process-exit') {
        if ($trackedProcessIdentities.ContainsKey([int]$processEvent.ProcessId)) {
          $processIdentity = $trackedProcessIdentities[[int]$processEvent.ProcessId]
        }
        $parentIdentity = $null
        $grandParentIdentity = $null
        $greatGrandParentIdentity = $null
        try {
          if (
            $null -ne $processIdentity -and
            $null -ne $processIdentity.parentProcessId -and
            $trackedProcessIdentities.ContainsKey([int]$processIdentity.parentProcessId)
          ) {
            $parentIdentity = $trackedProcessIdentities[[int]$processIdentity.parentProcessId]
            if (
              $null -ne $parentIdentity.parentProcessId -and
              $trackedProcessIdentities.ContainsKey([int]$parentIdentity.parentProcessId)
            ) {
              $grandParentIdentity = $trackedProcessIdentities[[int]$parentIdentity.parentProcessId]
              if (
                $null -ne $grandParentIdentity.parentProcessId -and
                $trackedProcessIdentities.ContainsKey([int]$grandParentIdentity.parentProcessId)
              ) {
                $greatGrandParentIdentity = $trackedProcessIdentities[[int]$grandParentIdentity.parentProcessId]
              }
            }
          }
        }
        catch {
          # Missing parent metadata remains fail-closed in the classifier.
        }
        $exitFailure = Get-AiNovelGateProcessExitFailure -Step $activeStep -Event $processEvent
        if (Test-AiNovelGateLegacyBridgeTermination `
          -Step $activeStep `
          -LegacyBridge $legacyBridge `
          -InstallerIdentity $processIdentity) {
          $legacyBridge.State = 'terminated'
          $exitClassification = 'legacy-bridge-terminated'
          Write-AiNovelGateStatus -State 'legacy-bridge-terminated' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
        }
        elseif ($null -eq $exitFailure) {
          $exitClassification = 'succeeded'
        }
        elseif (Test-AiNovelGateExpectedNsisPowerShellProbeExit `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ParentIdentity $parentIdentity `
          -GrandParentIdentity $grandParentIdentity `
          -ArmedRootIdentity $armedRootIdentity `
          -TrackedProcessIdentities $trackedProcessIdentities) {
          $exitClassification = 'expected-nsis-powershell-probe'
        }
        elseif (Test-AiNovelGateExpectedNsisFindNoMatchExit `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ParentIdentity $parentIdentity `
          -GrandParentIdentity $grandParentIdentity `
          -GreatGrandParentIdentity $greatGrandParentIdentity `
          -ArmedRootIdentity $armedRootIdentity `
          -TrackedProcessIdentities $trackedProcessIdentities) {
          $parentProcessIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $parentIdentity
          if ($null -eq $parentProcessIdentityKey) {
            $exitClassification = 'failure'
          } else {
            [void](Register-AiNovelGateVerifiedNsisFindParent `
              -VerifiedFindParentKeys $verifiedNsisFindParentKeys `
              -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures `
              -ParentProcessIdentityKey $parentProcessIdentityKey)
            [void](Resolve-AiNovelGateDeferredNsisCmdExitFailure `
              -State $deferredNsisCmdExitFailure `
              -ProcessIdentityKey $parentProcessIdentityKey)
            $exitClassification = 'expected-nsis-find-no-match'
          }
        }
        elseif (Test-AiNovelGateExpectedNsisCmdProcessCheckExit `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ParentIdentity $parentIdentity `
          -GrandParentIdentity $grandParentIdentity `
          -ArmedRootIdentity $armedRootIdentity `
          -TrackedProcessIdentities $trackedProcessIdentities `
          -VerifiedFindParentKeys $verifiedNsisFindParentKeys) {
          $exitClassification = 'expected-nsis-cmd-process-check'
        }
        elseif (Test-AiNovelGateNsisCmdProcessCheckCandidate `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ParentIdentity $parentIdentity `
          -GrandParentIdentity $grandParentIdentity `
          -ArmedRootIdentity $armedRootIdentity `
          -TrackedProcessIdentities $trackedProcessIdentities) {
          $processIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $processIdentity
          if (Add-AiNovelGatePendingNsisCmdExitFailure `
            -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures `
            -ProcessIdentityKey $processIdentityKey `
            -Failure $exitFailure) {
            # A cmd.exe exit can reach the completion port before its find.exe
            # child. Delay the exception decision until a matching, validated
            # find.exe no-match event is observed.
            $exitClassification = 'pending-nsis-cmd-process-check'
          } else {
            $exitClassification = 'failure'
          }
        }
        else {
          $exitClassification = 'failure'
        }
      }
      elseif ([string]$processEvent.Kind -eq 'job-empty') {
        # Delay resolution until the whole Drain() batch is processed: a
        # completion port can surface cmd.exe before its find.exe child.
        $jobBecameEmpty = $true
        $exitClassification = 'job-empty'
      }
      if (-not $processEventEvidenceWritten) {
        Write-AiNovelGateProcessEventEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -ExitClassification $exitClassification
      }
      if ([string]::IsNullOrWhiteSpace($activeStep)) {
        continue
      }
      if ([string]$processEvent.Kind -eq 'monitor-error') {
        throw "Release gate lost its Job Object completion-port stream (Win32 error $($processEvent.JobMessage))."
      }
      if ([string]$processEvent.Kind -eq 'process-start') {
        continue
      }
      elseif ([string]$processEvent.Kind -eq 'process-exit') {
        # Job Object membership is the atomic boundary. A nonzero or abnormal
        # exit from any descendant is still a release-gate failure, even when
        # the launcher's own command record reports success. Do not terminate
        # the Job Object here: the armed launcher must first get the chance to
        # write its durable result.json. The failure is finalized on the
        # explicit step-complete acknowledgement, or after a bounded drain
        # deadline if the launcher never completes.
        if ($exitClassification -in @(
          'expected-nsis-powershell-probe',
          'expected-nsis-cmd-process-check',
          'expected-nsis-find-no-match',
          'pending-nsis-cmd-process-check',
          'legacy-bridge-terminated'
        )) {
          continue
        }
        $exitFailure = Get-AiNovelGateProcessExitFailure -Step $activeStep -Event $processEvent
        if ($null -ne $exitFailure -and $null -eq $deferredProcessFailure) {
          $deferredProcessFailure = $exitFailure
          $deferredProcessFailureDeadline = [DateTime]::UtcNow.AddSeconds(15)
          Write-AiNovelGateProcessTreeEvidence `
            -Path $EvidencePath `
            -Step $activeStep `
            -ProcessIds $trackedProcessIds `
            -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
            -Reason 'process-failure-awaiting-launch-result'
        }
      }
    }

    if (Complete-AiNovelGateLegacyBridgeArm `
      -LegacyBridge $legacyBridge `
      -TrackedProcessIdentities $trackedProcessIdentities) {
      Write-AiNovelGateStatus -State 'legacy-bridge-armed' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
    }

    if ($jobBecameEmpty -and $null -eq $deferredProcessFailure) {
      $pendingNsisCmdFailure = Get-AiNovelGatePendingNsisCmdExitFailureEntry `
        -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures
      if (Promote-AiNovelGatePendingNsisCmdExitFailure `
        -State $deferredNsisCmdExitFailure `
        -PendingEntry $pendingNsisCmdFailure `
        -NowUtc ([DateTime]::UtcNow) `
        -CurrentDrain $drainSequence) {
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'nsis-cmd-awaiting-verified-find'
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
      if ($null -ne $legacyBridge -and $newErrorWindows.Count -gt 0) {
        $unallowedErrorWindows = [System.Collections.Generic.List[object]]::new()
        foreach ($window in $newErrorWindows) {
          if (Test-AiNovelGateLegacyBridgeWizardWindow -LegacyBridge $legacyBridge -Window $window) {
            $windowKey = Get-AiNovelGateLegacyBridgeWindowKey -Window $window
            if (
              $legacyBridge.AllowedWizardWindowKeys.Contains($windowKey) -or
              $legacyBridge.AllowedWizardWindowKeys.Count -eq 0
            ) {
              [void]$legacyBridge.AllowedWizardWindowKeys.Add($windowKey)
              continue
            }
          }
          $unallowedErrorWindows.Add($window)
        }
        $newErrorWindows = @($unallowedErrorWindows)
      }
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

    if (
      $completionDeadline -and
      $null -eq $deferredProcessFailure -and
      $null -eq $deferredNsisCmdExitFailure.failure
    ) {
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
        # If the Job Object did not deliver its terminal notification, keep
        # draining through the normal post-exit quiet period and fail closed
        # immediately before this step could otherwise be marked complete.
        $pendingNsisCmdFailure = Get-AiNovelGatePendingNsisCmdExitFailureEntry `
          -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures
        if (Promote-AiNovelGatePendingNsisCmdExitFailure `
          -State $deferredNsisCmdExitFailure `
          -PendingEntry $pendingNsisCmdFailure `
          -NowUtc ([DateTime]::UtcNow) `
          -CurrentDrain $drainSequence) {
          Write-AiNovelGateProcessTreeEvidence `
            -Path $EvidencePath `
            -Step $activeStep `
            -ProcessIds $trackedProcessIds `
            -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
            -Reason 'nsis-cmd-awaiting-verified-find'
        } else {
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
      $null -ne $deferredProcessFailure -and (
        $null -ne $completionDeadline -or
        ([DateTime]::UtcNow -ge [DateTime]$deferredProcessFailureDeadline)
      )
    ) {
      # A formal launch gate emits step-complete only after it has read the
      # result sidecar. If a malformed launcher never does so, the bounded
      # drain keeps this path fail-closed instead of allowing a failed child to
      # run indefinitely.
      $failure = [string]$deferredProcessFailure
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
        -Reason 'deferred-process-failure'
      $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
      Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure
      Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
      Stop-AiNovelGateProcesses `
        -ProcessIds $trackedProcessIds `
        -ProcessStartTimeTicks $trackedProcessStartTimeTicks
      exit 1
    }

    if (
      $null -eq $deferredProcessFailure -and
      (Test-AiNovelGateDeferredNsisCmdExitFailureReady `
        -State $deferredNsisCmdExitFailure `
        -NowUtc ([DateTime]::UtcNow) `
        -CurrentDrain $drainSequence)
    ) {
      # The narrow NSIS exception is fail-closed: after a whole later Drain()
      # and a bounded correlation grace, a cmd.exe no-process exit without its
      # exact, identity-bound find.exe child remains a real installer failure.
      $failure = [string]$deferredNsisCmdExitFailure.failure
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
        -Reason 'nsis-cmd-missing-verified-find'
      $script:AiNovelGateMonitorStoppedAt = [DateTime]::UtcNow.ToString('o')
      Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure
      Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
      Stop-AiNovelGateProcesses `
        -ProcessIds $trackedProcessIds `
        -ProcessStartTimeTicks $trackedProcessStartTimeTicks
      exit 1
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
