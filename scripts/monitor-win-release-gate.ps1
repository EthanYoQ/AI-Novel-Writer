param(
  [string]$ControlPath,
  [string]$StatusPath,
  [string]$EvidencePath,
  [switch]$LoadMonitorLibrary
)

$ErrorActionPreference = 'Stop'
$script:AiNovelNativeUpdaterOldApplication = $null

. (Join-Path $PSScriptRoot 'smoke-win-app.ps1') -LoadProbeLibrary

if (-not ('AiNovelReleaseGate.JobProcessMonitor' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AiNovelReleaseGate {
  public enum CommandLineState { Captured, ExitedBeforeRead, UnreadableWhileAlive }

  // A process-start event is either Retained, with the kernel identity
  // (key, start time, image, parent PID) complete, or Unretained with the
  // stage that failed. There is no partially identified member.
  public sealed class JobProcessEvent {
    public string Kind { get; private set; }
    public int ProcessId { get; private set; }
    public uint JobMessage { get; private set; }
    public bool Retained { get; private set; }
    public string FailureStage { get; private set; }
    public int? Win32Error { get; private set; }
    public string CaptureAttemptedAt { get; private set; }
    public long? RetainLatencyMicroseconds { get; private set; }
    public string Key { get; private set; }
    public string ProcessStartTimeTicks { get; private set; }
    public string ProcessName { get; private set; }
    public string ImagePath { get; private set; }
    public int? ParentProcessId { get; private set; }
    public string ParentProcessStartTimeTicks { get; private set; }
    public string ParentImagePath { get; private set; }
    public CommandLineState? CommandLineState { get; private set; }
    public string CommandLine { get; private set; }
    public int? CommandLineRetries { get; private set; }
    public string CommandLineStatus { get; private set; }
    public long? CommandLineReadMicroseconds { get; private set; }
    public string ExitKey { get; private set; }
    public int? ExitCode { get; private set; }
    public bool ExitCodeCaptured { get; private set; }
    public string RecordedAt { get; private set; }

    public string CommandLineLoss {
      get {
        if (!CommandLineState.HasValue) return null;
        if (CommandLineState.Value == AiNovelReleaseGate.CommandLineState.ExitedBeforeRead) return "exited-before-read";
        if (CommandLineState.Value == AiNovelReleaseGate.CommandLineState.UnreadableWhileAlive) return "unreadable-while-alive";
        return String.Empty;
      }
    }

    private JobProcessEvent(string kind, int processId, uint jobMessage) {
      Kind = kind;
      ProcessId = processId;
      JobMessage = jobMessage;
      RecordedAt = DateTime.UtcNow.ToString("o");
    }

    internal static JobProcessEvent Started(
      int processId,
      uint jobMessage,
      long attemptedAtFileTime,
      long? openedAtFileTime,
      string key,
      ProcessSnapshot snapshot,
      string parentProcessStartTimeTicks,
      string parentImagePath
    ) {
      JobProcessEvent started = new JobProcessEvent("process-start", processId, jobMessage);
      started.Retained = true;
      started.CaptureAttemptedAt = DateTime.FromFileTimeUtc(attemptedAtFileTime).ToString("o");
      if (openedAtFileTime.HasValue) {
        started.RetainLatencyMicroseconds = (DateTime.FromFileTimeUtc(openedAtFileTime.Value).Ticks - snapshot.StartTicks) / 10;
      }
      started.Key = key;
      started.ProcessStartTimeTicks = snapshot.StartTicks.ToString(CultureInfo.InvariantCulture);
      started.ImagePath = snapshot.ImagePath;
      started.ProcessName = Path.GetFileNameWithoutExtension(snapshot.ImagePath);
      started.ParentProcessId = snapshot.ParentProcessId;
      started.ParentProcessStartTimeTicks = parentProcessStartTimeTicks;
      started.ParentImagePath = parentImagePath;
      started.CommandLineState = snapshot.CommandLineState;
      started.CommandLine = snapshot.CommandLine;
      started.CommandLineRetries = snapshot.CommandLineRetries;
      started.CommandLineStatus = "0x" + snapshot.CommandLineStatus.ToString("X8", CultureInfo.InvariantCulture);
      started.CommandLineReadMicroseconds = snapshot.CommandLineReadMicroseconds;
      return started;
    }

    internal static JobProcessEvent Unretained(int processId, uint jobMessage, string stage, int? win32Error, long attemptedAtFileTime) {
      JobProcessEvent unretained = new JobProcessEvent("process-start", processId, jobMessage);
      unretained.FailureStage = stage;
      unretained.Win32Error = win32Error;
      unretained.CaptureAttemptedAt = DateTime.FromFileTimeUtc(attemptedAtFileTime).ToString("o");
      return unretained;
    }

    internal static JobProcessEvent Exited(int processId, uint jobMessage, string exitKey, int? exitCode) {
      JobProcessEvent exited = new JobProcessEvent("process-exit", processId, jobMessage);
      exited.Retained = exitKey != null;
      exited.ExitKey = exitKey;
      exited.ExitCode = exitCode;
      exited.ExitCodeCaptured = exitCode.HasValue;
      return exited;
    }

    internal static JobProcessEvent JobEmpty(uint jobMessage) {
      JobProcessEvent empty = new JobProcessEvent("job-empty", 0, jobMessage);
      empty.Retained = true;
      return empty;
    }

    internal static JobProcessEvent MonitorError(int win32Error) {
      return new JobProcessEvent("monitor-error", 0, unchecked((uint)win32Error));
    }
  }

  public sealed class ProcessSnapshot {
    public long StartTicks { get; internal set; }
    public string ImagePath { get; internal set; }
    public int? ParentProcessId { get; internal set; }
    public CommandLineState CommandLineState { get; internal set; }
    public string CommandLine { get; internal set; }
    public int CommandLineRetries { get; internal set; }
    public int CommandLineStatus { get; internal set; }
    public long CommandLineReadMicroseconds { get; internal set; }

    public bool KernelIdentityComplete {
      get { return StartTicks > 0 && !String.IsNullOrEmpty(ImagePath) && ParentProcessId.HasValue; }
    }
  }

  // Reads a process through a handle the caller already holds. Start time,
  // parent PID, and the NT image name (class 27) stay readable after the
  // process exits; the command line does not, so it is read first.
  public static class ProcessReader {
    private const int ProcessBasicInformationClass = 0;
    private const int ProcessImageFileNameClass = 27;
    private const int ProcessCommandLineInformationClass = 60;
    private const int StatusProcessIsTerminating = unchecked((int)0xC000010A);
    private const int MaxCommandLineRetries = 5;
    private const uint WaitObject0 = 0;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
      IntPtr process,
      out NativeFileTime creationTime,
      out NativeFileTime exitTime,
      out NativeFileTime kernelTime,
      out NativeFileTime userTime
    );

    [DllImport("kernel32.dll")]
    private static extern void GetSystemTimePreciseAsFileTime(out long fileTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDevice(string deviceName, StringBuilder targetPath, uint maxLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int processInformationClass,
      IntPtr processInformation,
      int processInformationLength,
      out int returnLength
    );

    private static readonly KeyValuePair<string, string>[] DeviceDrives = ReadDeviceDrives();

    public static long PreciseFileTimeUtc() {
      long fileTime;
      GetSystemTimePreciseAsFileTime(out fileTime);
      return fileTime;
    }

    public static ProcessSnapshot Read(IntPtr process) {
      ProcessSnapshot snapshot = new ProcessSnapshot();
      long readStartedAt = PreciseFileTimeUtc();
      string commandLine;
      int status = ReadCommandLine(process, out commandLine);
      int retries = 0;
      // Thread.Yield hands the core to a ready Normal-priority process that is
      // still filling its PEB; Sleep(1) would stall the Highest pump a timer tick.
      while (String.IsNullOrEmpty(commandLine) && status != StatusProcessIsTerminating && retries < MaxCommandLineRetries) {
        Thread.Yield();
        retries++;
        status = ReadCommandLine(process, out commandLine);
      }
      snapshot.CommandLineReadMicroseconds = (PreciseFileTimeUtc() - readStartedAt) / 10;
      snapshot.CommandLineRetries = retries;
      snapshot.CommandLineStatus = status;
      if (!String.IsNullOrEmpty(commandLine)) {
        snapshot.CommandLineState = CommandLineState.Captured;
        snapshot.CommandLine = commandLine;
      }
      else if (status == StatusProcessIsTerminating || WaitForSingleObject(process, 0) == WaitObject0) {
        snapshot.CommandLineState = CommandLineState.ExitedBeforeRead;
      }
      else {
        snapshot.CommandLineState = CommandLineState.UnreadableWhileAlive;
      }
      snapshot.StartTicks = ReadStartTicks(process);
      snapshot.ImagePath = ReadImagePath(process);
      snapshot.ParentProcessId = ReadParentProcessId(process);
      return snapshot;
    }

    public static string ReadImagePath(IntPtr process) {
      int size = Marshal.SizeOf(typeof(NativeUnicodeString)) + UInt16.MaxValue + 1;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returnedLength;
        if (NtQueryInformationProcess(process, ProcessImageFileNameClass, buffer, size, out returnedLength) != 0) return null;
        NativeUnicodeString value = (NativeUnicodeString)Marshal.PtrToStructure(buffer, typeof(NativeUnicodeString));
        if (value.Buffer == IntPtr.Zero || value.Length == 0) return null;
        return ToDrivePath(Marshal.PtrToStringUni(value.Buffer, value.Length / 2));
      }
      finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    internal static long ReadStartTicks(IntPtr process) {
      NativeFileTime creationTime;
      NativeFileTime exitTime;
      NativeFileTime kernelTime;
      NativeFileTime userTime;
      if (!GetProcessTimes(process, out creationTime, out exitTime, out kernelTime, out userTime)) return 0;
      long fileTime = ((long)creationTime.HighDateTime << 32) | creationTime.LowDateTime;
      return DateTime.FromFileTimeUtc(fileTime).Ticks;
    }

    private static int ReadCommandLine(IntPtr process, out string commandLine) {
      commandLine = null;
      int requiredLength;
      int status = NtQueryInformationProcess(process, ProcessCommandLineInformationClass, IntPtr.Zero, 0, out requiredLength);
      if (requiredLength <= 0) return status;
      IntPtr buffer = Marshal.AllocHGlobal(requiredLength);
      try {
        status = NtQueryInformationProcess(process, ProcessCommandLineInformationClass, buffer, requiredLength, out requiredLength);
        if (status != 0) return status;
        NativeUnicodeString value = (NativeUnicodeString)Marshal.PtrToStructure(buffer, typeof(NativeUnicodeString));
        if (value.Buffer != IntPtr.Zero && value.Length > 0) {
          commandLine = Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
        }
        return status;
      }
      finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static int? ReadParentProcessId(IntPtr process) {
      int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returnedLength;
        if (NtQueryInformationProcess(process, ProcessBasicInformationClass, buffer, size, out returnedLength) != 0) return null;
        ProcessBasicInformation info = (ProcessBasicInformation)Marshal.PtrToStructure(buffer, typeof(ProcessBasicInformation));
        ulong parentProcessId = info.InheritedFromUniqueProcessId.ToUInt64();
        if (parentProcessId == 0 || parentProcessId > Int32.MaxValue) return null;
        return unchecked((int)parentProcessId);
      }
      finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static string ToDrivePath(string devicePath) {
      foreach (KeyValuePair<string, string> drive in DeviceDrives) {
        if (
          devicePath.Length > drive.Key.Length &&
          devicePath[drive.Key.Length] == '\\' &&
          devicePath.StartsWith(drive.Key, StringComparison.OrdinalIgnoreCase)
        ) {
          return drive.Value + devicePath.Substring(drive.Key.Length);
        }
      }
      return null;
    }

    private static KeyValuePair<string, string>[] ReadDeviceDrives() {
      List<KeyValuePair<string, string>> drives = new List<KeyValuePair<string, string>>();
      StringBuilder target = new StringBuilder(1024);
      for (char letter = 'A'; letter <= 'Z'; letter++) {
        string drive = letter + ":";
        if (QueryDosDevice(drive, target, unchecked((uint)target.Capacity)) == 0) continue;
        string device = target.ToString();
        if (device.StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase)) {
          drives.Add(new KeyValuePair<string, string>(device, drive));
        }
      }
      return drives.ToArray();
    }
  }

  // The monitor's TEMP root uses the long profile name, while a captured image
  // path can preserve an 8.3 alias such as C:\\Users\\RUNNER~1. Keep that
  // translation narrowly available to the PowerShell classifier; a failed
  // lookup deliberately leaves the classifier fail-closed.
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

    private sealed class Member {
      public readonly IntPtr Handle;
      public readonly string Key;
      public readonly long StartTicks;
      public readonly string ImagePath;

      public Member(IntPtr handle, string key, long startTicks, string imagePath) {
        Handle = handle;
        Key = key;
        StartTicks = startTicks;
        ImagePath = imagePath;
      }
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
    // Only the pump thread reads or writes the member table, and it closes
    // every retained handle when it stops.
    private readonly Dictionary<int, Member> members = new Dictionary<int, Member>();
    private readonly ConcurrentDictionary<int, bool> assignedRoots = new ConcurrentDictionary<int, bool>();
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
      // A starved pump opens short-lived NSIS probe members only after they
      // have exited; Highest keeps it ahead of the processes it observes.
      worker.Priority = ThreadPriority.Highest;
      worker.Name = "AI Novel release-gate process monitor";
      worker.Start();
    }

    public void AssignProcess(int processId) {
      if (processId <= 0) throw new ArgumentOutOfRangeException("processId");
      IntPtr process = OpenProcess(ProcessSetQuota | ProcessTerminate, false, unchecked((uint)processId));
      if (process == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open release-gate root process " + processId + " for job assignment.");
      }
      assignedRoots[processId] = true;
      try {
        if (!AssignProcessToJobObject(job, process)) {
          int error = Marshal.GetLastWin32Error();
          bool ignored;
          assignedRoots.TryRemove(processId, out ignored);
          throw new Win32Exception(error, "Could not atomically assign release-gate root process " + processId + " to the job object.");
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

    private static string IdentityKey(int processId, ProcessSnapshot snapshot) {
      if (!snapshot.KernelIdentityComplete) return null;
      try {
        return processId.ToString(CultureInfo.InvariantCulture) + "|" +
          snapshot.StartTicks.ToString(CultureInfo.InvariantCulture) + "|" +
          Path.GetFullPath(snapshot.ImagePath);
      }
      catch (Exception) {
        return null;
      }
    }

    private static void ReadOutsideJobParent(
      int parentProcessId,
      long childStartTicks,
      out string parentProcessStartTimeTicks,
      out string parentImagePath
    ) {
      parentProcessStartTimeTicks = null;
      parentImagePath = null;
      IntPtr parent = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, unchecked((uint)parentProcessId));
      if (parent == IntPtr.Zero) return;
      try {
        long parentStartTicks = ProcessReader.ReadStartTicks(parent);
        if (parentStartTicks <= 0 || parentStartTicks > childStartTicks) return;
        parentProcessStartTimeTicks = parentStartTicks.ToString(CultureInfo.InvariantCulture);
        parentImagePath = ProcessReader.ReadImagePath(parent);
      }
      finally {
        CloseHandle(parent);
      }
    }

    private void RetainNewProcess(int processId, uint message) {
      bool ignored;
      bool assignedRoot = assignedRoots.TryRemove(processId, out ignored);
      long attemptedAt = ProcessReader.PreciseFileTimeUtc();
      IntPtr process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, unchecked((uint)processId));
      if (process == IntPtr.Zero) {
        events.Enqueue(JobProcessEvent.Unretained(processId, message, "OpenProcess", Marshal.GetLastWin32Error(), attemptedAt));
        return;
      }
      long openedAt = ProcessReader.PreciseFileTimeUtc();
      ProcessSnapshot snapshot = ProcessReader.Read(process);
      string key = IdentityKey(processId, snapshot);
      if (key == null) {
        CloseHandle(process);
        events.Enqueue(JobProcessEvent.Unretained(processId, message, "KernelIdentity", null, attemptedAt));
        return;
      }
      string parentProcessStartTimeTicks = null;
      string parentImagePath = null;
      Member parent;
      // A retained parent's PID cannot be reused while its handle is held, and
      // its NEW_PROCESS was dequeued before any child it created. A parent that
      // started after this child is a reused PID and stays unbound.
      if (members.TryGetValue(snapshot.ParentProcessId.Value, out parent)) {
        if (parent.StartTicks <= snapshot.StartTicks) {
          parentProcessStartTimeTicks = parent.StartTicks.ToString(CultureInfo.InvariantCulture);
          parentImagePath = parent.ImagePath;
        }
      }
      else if (assignedRoot) {
        ReadOutsideJobParent(snapshot.ParentProcessId.Value, snapshot.StartTicks, out parentProcessStartTimeTicks, out parentImagePath);
      }
      Member stale;
      if (members.TryGetValue(processId, out stale)) CloseHandle(stale.Handle);
      members[processId] = new Member(process, key, snapshot.StartTicks, snapshot.ImagePath);
      // An assigned root was created before the job existed, so its creation
      // time says nothing about how fast the pump retains new members.
      events.Enqueue(JobProcessEvent.Started(
        processId,
        message,
        attemptedAt,
        assignedRoot ? (long?)null : openedAt,
        key,
        snapshot,
        parentProcessStartTimeTicks,
        parentImagePath
      ));
    }

    private void ReleaseExitedProcess(int processId, uint message) {
      Member member;
      if (!members.TryGetValue(processId, out member)) {
        events.Enqueue(JobProcessEvent.Exited(processId, message, null, null));
        return;
      }
      members.Remove(processId);
      int? exitCode = null;
      try {
        uint rawExitCode;
        if (GetExitCodeProcess(member.Handle, out rawExitCode)) exitCode = unchecked((int)rawExitCode);
      }
      finally {
        CloseHandle(member.Handle);
      }
      events.Enqueue(JobProcessEvent.Exited(processId, message, member.Key, exitCode));
    }

    private void Pump() {
      try {
        while (!stopping) {
          uint message;
          UIntPtr completionKey;
          IntPtr overlapped;
          bool received = GetQueuedCompletionStatus(completionPort, out message, out completionKey, out overlapped, 250);
          if (!received) {
            int error = Marshal.GetLastWin32Error();
            if (error == WaitTimeout) continue;
            if (stopping) return;
            events.Enqueue(JobProcessEvent.MonitorError(error));
            continue;
          }
          if (stopping && message == 0) return;
          int processId = unchecked((int)overlapped.ToInt64());
          try {
            if (message == JobObjectMsgNewProcess) {
              RetainNewProcess(processId, message);
            }
            else if (message == JobObjectMsgExitProcess || message == JobObjectMsgAbnormalExitProcess) {
              ReleaseExitedProcess(processId, message);
            }
            else if (message == JobObjectMsgActiveProcessZero) {
              events.Enqueue(JobProcessEvent.JobEmpty(message));
            }
          }
          catch (Exception exception) {
            // An exception on this background thread would end the PowerShell
            // host without a failed status; report it as a lost stream instead.
            events.Enqueue(JobProcessEvent.MonitorError(exception.HResult));
          }
        }
      }
      finally {
        foreach (Member member in members.Values) CloseHandle(member.Handle);
        members.Clear();
      }
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      stopping = true;
      if (completionPort != IntPtr.Zero) PostQueuedCompletionStatus(completionPort, 0, UIntPtr.Zero, IntPtr.Zero);
      if (worker != null) worker.Join(2000);
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
    [ValidateSet('', 'process-failure', 'unobservable-member', 'unobservable-identity', 'error-window', 'process-timeout', 'monitor-failure')]
    [string]$FailureKind = '',
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
  if (-not [string]::IsNullOrEmpty($FailureKind)) {
    $statusRecord.failureKind = $FailureKind
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
  param([Parameter(Mandatory = $true)]$Event)

  # The C# completion-port worker captures these fields while it still owns a
  # native process handle. Do not make a slow CIM call in this PowerShell loop:
  # that would delay draining the next short-lived child event and lose the
  # very command-line evidence this record is meant to preserve.
  return [pscustomobject][ordered]@{
    processId = [int]$Event.ProcessId
    startTimeTicks = if ($null -ne $Event.ProcessStartTimeTicks) { [string]$Event.ProcessStartTimeTicks } else { $null }
    processName = if ($null -ne $Event.ProcessName) { [string]$Event.ProcessName } else { $null }
    executablePath = if ($null -ne $Event.ImagePath) { [string]$Event.ImagePath } else { $null }
    commandLine = if ($null -ne $Event.CommandLine) { [string]$Event.CommandLine } else { $null }
    parentProcessId = if ($null -ne $Event.ParentProcessId) { [int]$Event.ParentProcessId } else { $null }
    parentProcessStartTimeTicks = if ($null -ne $Event.ParentProcessStartTimeTicks) { [string]$Event.ParentProcessStartTimeTicks } else { $null }
    parentExecutablePath = if ($null -ne $Event.ParentImagePath) { [string]$Event.ParentImagePath } else { $null }
    identityCaptured = [bool]$Event.Retained
    commandLineCaptured = [string]$Event.CommandLineState -eq 'Captured'
    identityCaptureError = $null
  }
}

function Test-AiNovelGateSystemPowerShellImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath)) {
    return $false
  }
  try {
    # The monitor captures an absolute image path. Reject a
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

function Test-AiNovelGateProductExecutableInRoot {
  param(
    [AllowEmptyString()][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )

  # 升级测试里的旧版本与新版本 exe 名不同（ADR-0022），安装目录下的任一产品 exe 都算。
  return @(Get-AiNovelProductExecutableNames | Where-Object {
    Test-AiNovelGateSameAbsolutePath -Left $ExecutablePath -Right ([System.IO.Path]::Combine($InstallRoot, $_))
  }).Count -eq 1
}

function Test-AiNovelGateNsisSetupWindowTitle {
  param([AllowEmptyString()][string]$Title)

  $normalizedTitle = ([string]$Title).TrimEnd()
  return @(Get-AiNovelProductNames | Where-Object {
    [string]::Equals($normalizedTitle, "$_ Setup", [System.StringComparison]::Ordinal)
  }).Count -eq 1
}

function Test-AiNovelGateNsisUninstallerImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or $ImagePath -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  try {
    $imageName = [System.IO.Path]::GetFileName([System.IO.Path]::GetFullPath($ImagePath))
    # 升级时新安装程序会调起旧版本的卸载程序，新旧产品名都要认（ADR-0022）。
    return @(Get-AiNovelProductUninstallerNames | Where-Object {
      [string]::Equals($imageName, $_, [System.StringComparison]::OrdinalIgnoreCase)
    }).Count -eq 1
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
  # $SYSDIR can be recorded as System32 while the captured image is the
  # redirected SysWOW64 one. Do not turn this into a basename match.
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
      'findstr.exe',
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
    [Parameter(Mandatory = $true)][ValidateSet('cmd.exe', 'find.exe', 'findstr.exe')][string]$FileName
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

function Get-AiNovelGateNsisCmdProcessCheckVariants {
  # The per-user FIND_PROCESS fallback of electron-builder's NSIS template
  # (perMachine is false). Older templates pipe tasklist into find.exe; 26.15
  # adds /NH and pipes into an anchored findstr.exe. FilterArguments is the
  # child command line exactly as cmd.exe rebuilds it after argv[0].
  # 升级时新安装程序查新 exe 名，它调起的旧卸载程序查旧 exe 名（ADR-0022），两种都是预期命令。
  return @(foreach ($exeName in Get-AiNovelProductExecutableNames) {
    [pscustomobject]@{
      FilterFileName = 'find.exe'
      CmdPrefix = ' /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ' + $exeName + '" /FO CSV | "'
      CmdSuffix = '" "' + $exeName + '"'
      FilterArguments = '  "' + $exeName + '"'
      Classification = 'expected-nsis-find-no-match'
    }
    [pscustomobject]@{
      FilterFileName = 'findstr.exe'
      CmdPrefix = ' /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ' + $exeName + '" /FO CSV /NH | "'
      CmdSuffix = '" /B /I /C:"\"' + $exeName + '\""'
      FilterArguments = '  /B /I /C:"\"' + $exeName + '\""'
      Classification = 'expected-nsis-findstr-no-match'
    }
  })
}

function Get-AiNovelGateNsisCmdProcessCheckVariant {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$CmdImagePath
  )

  $arguments = Get-AiNovelGateBoundCommandArguments `
    -CommandLine $CommandLine `
    -ImagePath $CmdImagePath
  if ($null -eq $arguments) {
    return $null
  }
  try {
    $cmdDirectory = [System.IO.Path]::GetDirectoryName($CmdImagePath)
    foreach ($variant in Get-AiNovelGateNsisCmdProcessCheckVariants) {
      if (
        -not $arguments.StartsWith($variant.CmdPrefix, [System.StringComparison]::Ordinal) -or
        -not $arguments.EndsWith($variant.CmdSuffix, [System.StringComparison]::Ordinal)
      ) {
        continue
      }
      $filterPathLength = $arguments.Length - $variant.CmdPrefix.Length - $variant.CmdSuffix.Length
      if ($filterPathLength -le 0) {
        continue
      }
      $filterPath = $arguments.Substring($variant.CmdPrefix.Length, $filterPathLength)
      if (Test-AiNovelGateSameBoundSystemExecutablePath `
        -Left $filterPath `
        -Right (Join-Path $cmdDirectory $variant.FilterFileName)) {
        # A new object: the variant table is shared by every caller.
        return [pscustomobject]@{
          FilterFileName = $variant.FilterFileName
          FilterArguments = $variant.FilterArguments
          FilterPath = $filterPath
          Classification = $variant.Classification
        }
      }
    }
    return $null
  }
  catch {
    return $null
  }
}

function Test-AiNovelGateKnownNsisCmdProcessCheckCommand {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$CmdImagePath
  )

  return $null -ne (Get-AiNovelGateNsisCmdProcessCheckVariant `
    -CommandLine $CommandLine `
    -CmdImagePath $CmdImagePath)
}

function Get-AiNovelGateNsisFilterNoMatchVariant {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$FilterImagePath
  )

  $arguments = Get-AiNovelGateBoundCommandArguments `
    -CommandLine $CommandLine `
    -ImagePath $FilterImagePath
  if ($null -eq $arguments) {
    return $null
  }
  try {
    $filterFileName = [System.IO.Path]::GetFileName($FilterImagePath)
    foreach ($variant in Get-AiNovelGateNsisCmdProcessCheckVariants) {
      if (
        [string]::Equals($filterFileName, $variant.FilterFileName, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($arguments, $variant.FilterArguments, [System.StringComparison]::Ordinal)
      ) {
        return $variant
      }
    }
    return $null
  }
  catch {
    return $null
  }
}

function Test-AiNovelGateKnownNsisFindNoMatchCommand {
  param(
    [AllowEmptyString()][string]$CommandLine,
    [AllowEmptyString()][string]$FindImagePath
  )

  return $null -ne (Get-AiNovelGateNsisFilterNoMatchVariant `
    -CommandLine $CommandLine `
    -FilterImagePath $FindImagePath)
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
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # Keep the original direct-installer check intact. Additional branches are
  # complete, product-specific uninstaller chains whose every edge is bound by
  # PID, creation time, and absolute image path. The direct installer branch
  # deliberately retains its original classification semantics.
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
        -ParentIdentity $ParentIdentity)) -or
    (Test-AiNovelGateCapturedLegacyBridgeOldUninstallerProbeParent `
      -LegacyBridge $LegacyBridge `
      -ChildIdentity $ChildIdentity `
      -ParentIdentity $ParentIdentity `
      -GrandParentIdentity $GrandParentIdentity `
      -ArmedRootIdentity $ArmedRootIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities) -or
    (Test-AiNovelGateCapturedNativeUpdaterOldUninstallerProbeParent `
      -Step $Step `
      -LegacyBridge $LegacyBridge `
      -ChildIdentity $ChildIdentity `
      -ParentIdentity $ParentIdentity `
      -GrandParentIdentity $GrandParentIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)
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
    [AllowNull()]$LegacyBridge,
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
    -Step $Step `
    -ChildIdentity $ProcessIdentity `
    -ParentIdentity $ParentIdentity `
    -GrandParentIdentity $GrandParentIdentity `
    -LegacyBridge $LegacyBridge `
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
    [AllowNull()]$LegacyBridge,
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
    -Step $Step `
    -ChildIdentity $ProcessIdentity `
    -ParentIdentity $ParentIdentity `
    -GrandParentIdentity $GrandParentIdentity `
    -LegacyBridge $LegacyBridge `
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
    [AllowNull()]$LegacyBridge,
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
    -LegacyBridge $LegacyBridge `
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

function Get-AiNovelGateNsisFilterNoMatchVerdict {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$GreatGrandParentIdentity,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  if (-not (Test-AiNovelGateExpectedExitOne -Step $Step -Event $Event)) {
    return $null
  }
  if (
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    $null -eq $ParentIdentity -or
    -not [bool]$ParentIdentity.commandLineCaptured
  ) {
    return $null
  }
  $cmdVariant = Get-AiNovelGateNsisCmdProcessCheckVariant `
    -CommandLine ([string]$ParentIdentity.commandLine) `
    -CmdImagePath ([string]$ParentIdentity.executablePath)
  # The filter child must be the executable its own cmd.exe parent named, so a
  # find.exe child never borrows a findstr.exe template or the reverse, nor
  # another product executable name.
  if (
    $null -eq $cmdVariant -or
    -not (Test-AiNovelGateSystemUtilityImage `
      -ImagePath ([string]$ProcessIdentity.executablePath) `
      -FileName $cmdVariant.FilterFileName) -or
    -not (Test-AiNovelGateSameBoundSystemExecutablePath `
      -Left $cmdVariant.FilterPath `
      -Right ([string]$ProcessIdentity.executablePath)) -or
    -not (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $ProcessIdentity `
      -ParentIdentity $ParentIdentity) -or
    -not (Test-AiNovelGateSystemUtilityImage `
      -ImagePath ([string]$ParentIdentity.executablePath) `
      -FileName 'cmd.exe') -or
    -not (Test-AiNovelGateCapturedNsisProbeParent `
      -Step $Step `
      -ChildIdentity $ParentIdentity `
      -ParentIdentity $GrandParentIdentity `
      -GrandParentIdentity $GreatGrandParentIdentity `
      -LegacyBridge $LegacyBridge `
      -ArmedRootIdentity $ArmedRootIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)
  ) {
    return $null
  }
  if (-not [bool]$ProcessIdentity.commandLineCaptured) {
    # cmd.exe rebuilds the filter command line from its own verified one; only
    # a filter that exits within milliseconds loses its own copy first.
    return New-AiNovelGateExitVerdict -Kind expected -Classification $cmdVariant.Classification -Basis 'parent-command-line'
  }
  $filterVariant = Get-AiNovelGateNsisFilterNoMatchVariant `
    -CommandLine ([string]$ProcessIdentity.commandLine) `
    -FilterImagePath ([string]$ProcessIdentity.executablePath)
  if (
    $null -eq $filterVariant -or
    -not [string]::Equals($filterVariant.FilterFileName, $cmdVariant.FilterFileName, [System.StringComparison]::Ordinal) -or
    -not [string]::Equals($filterVariant.FilterArguments, $cmdVariant.FilterArguments, [System.StringComparison]::Ordinal)
  ) {
    return New-AiNovelGateExitVerdict `
      -Kind failure `
      -Reason 'filter-command-line-contradicts-parent' `
      -Failure (Get-AiNovelGateProcessExitFailure -Step $Step -Event $Event)
  }
  return New-AiNovelGateExitVerdict -Kind expected -Classification $cmdVariant.Classification -Basis 'own-command-line'
}

function Get-AiNovelGateExpectedNsisFilterNoMatchClassification {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$GreatGrandParentIdentity,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  $verdict = Get-AiNovelGateNsisFilterNoMatchVerdict @PSBoundParameters
  if ($null -eq $verdict -or $verdict.Kind -ne 'expected') {
    return $null
  }
  return [string]$verdict.Classification
}

function Test-AiNovelGateExpectedNsisFindNoMatchExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$GreatGrandParentIdentity,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  return $null -ne (Get-AiNovelGateExpectedNsisFilterNoMatchClassification @PSBoundParameters)
}

function New-AiNovelGateExitVerdict {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('succeeded', 'expected', 'pending', 'result-owned', 'failure', 'unobservable')][string]$Kind,
    [string]$Classification = $Kind,
    [string]$Basis = '',
    [string]$Reason = '',
    [string]$Failure = ''
  )

  # Contradicting evidence is a failure; missing evidence is unobservable.
  # Both block the step, and the label tells the next investigator which.
  $blocks = $Kind -in @('failure', 'unobservable')
  return [pscustomobject][ordered]@{
    Kind = $Kind
    Classification = $Classification
    Basis = $Basis
    Reason = $Reason
    Failure = $Failure
    FailureKind = if ($Kind -eq 'unobservable') { 'unobservable-identity' } elseif ($blocks) { 'process-failure' } else { '' }
    ParentKey = ''
    Blocks = $blocks
  }
}

function Get-AiNovelGateTrackedParentIdentity {
  param(
    [AllowNull()]$Identity,
    [AllowNull()]$TrackedProcessIdentities
  )

  if (
    $null -eq $Identity -or
    $null -eq $Identity.parentProcessId -or
    $null -eq $TrackedProcessIdentities -or
    -not $TrackedProcessIdentities.ContainsKey([int]$Identity.parentProcessId)
  ) {
    return $null
  }
  return $TrackedProcessIdentities[[int]$Identity.parentProcessId]
}

function Get-AiNovelGateUnobservableNsisProcessCheckReason {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$GreatGrandParentIdentity,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # An exit 1 from a cmd.exe that a verified NSIS probe parent started, whose
  # own command line was never read, is indistinguishable from the expected
  # process-check pipeline. So is its find or findstr child.
  if (
    -not [bool]$Event.ExitCodeCaptured -or
    [uint32]$Event.JobMessage -ne 7 -or
    $null -eq $Event.ExitCode -or
    [int]$Event.ExitCode -ne 1 -or
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured
  ) {
    return ''
  }
  $imagePath = [string]$ProcessIdentity.executablePath
  if (
    (Test-AiNovelGateSystemUtilityImage -ImagePath $imagePath -FileName 'cmd.exe') -and
    -not [bool]$ProcessIdentity.commandLineCaptured -and
    (Test-AiNovelGateCapturedNsisProbeParent `
      -Step $Step `
      -ChildIdentity $ProcessIdentity `
      -ParentIdentity $ParentIdentity `
      -GrandParentIdentity $GrandParentIdentity `
      -LegacyBridge $LegacyBridge `
      -ArmedRootIdentity $ArmedRootIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)
  ) {
    return 'nsis-cmd-command-line-unobserved'
  }
  if (
    ((Test-AiNovelGateSystemUtilityImage -ImagePath $imagePath -FileName 'find.exe') -or
      (Test-AiNovelGateSystemUtilityImage -ImagePath $imagePath -FileName 'findstr.exe')) -and
    $null -ne $ParentIdentity -and
    -not [bool]$ParentIdentity.commandLineCaptured -and
    (Test-AiNovelGateSystemUtilityImage -ImagePath ([string]$ParentIdentity.executablePath) -FileName 'cmd.exe') -and
    (Test-AiNovelGateCapturedParentIdentity -ChildIdentity $ProcessIdentity -ParentIdentity $ParentIdentity) -and
    (Test-AiNovelGateCapturedNsisProbeParent `
      -Step $Step `
      -ChildIdentity $ParentIdentity `
      -ParentIdentity $GrandParentIdentity `
      -GrandParentIdentity $GreatGrandParentIdentity `
      -LegacyBridge $LegacyBridge `
      -ArmedRootIdentity $ArmedRootIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)
  ) {
    return 'nsis-filter-parent-command-line-unobserved'
  }
  return ''
}

function Get-AiNovelGateExitVerdict {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$TrackedProcessIdentities,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$VerifiedFindParentKeys
  )

  $parentIdentity = Get-AiNovelGateTrackedParentIdentity -Identity $ProcessIdentity -TrackedProcessIdentities $TrackedProcessIdentities
  $grandParentIdentity = Get-AiNovelGateTrackedParentIdentity -Identity $parentIdentity -TrackedProcessIdentities $TrackedProcessIdentities
  $greatGrandParentIdentity = Get-AiNovelGateTrackedParentIdentity -Identity $grandParentIdentity -TrackedProcessIdentities $TrackedProcessIdentities
  $exitFailure = Get-AiNovelGateProcessExitFailure -Step $Step -Event $Event
  $processIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $ProcessIdentity
  $armedRootIdentityKey = Get-AiNovelGateProcessIdentityKey -ProcessIdentity $ArmedRootIdentity
  # The armed root and its durable result own final success for selected
  # build/installer/upgrade steps. Their identified descendants remain evidence;
  # other steps still fail closed on every abnormal descendant exit.
  $isCapturedNonzeroDescendantExit = (
    $null -ne $processIdentityKey -and
    $null -ne $armedRootIdentityKey -and
    [bool]$Event.ExitCodeCaptured -and
    [uint32]$Event.JobMessage -eq 7 -and
    $null -ne $Event.ExitCode -and
    [int]$Event.ExitCode -ne 0 -and
    -not [string]::Equals(
      $processIdentityKey,
      $armedRootIdentityKey,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  )
  if (
    $null -ne $ProcessIdentity -and
    -not [string]::IsNullOrEmpty([string]$Event.ExitKey) -and
    -not [string]::Equals([string]$processIdentityKey, [string]$Event.ExitKey, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    return New-AiNovelGateExitVerdict `
      -Kind failure `
      -Reason 'exit-key-mismatch' `
      -Failure "Release gate step '$Step' could not match the exit of job-contained PID $($Event.ProcessId) to its recorded process identity."
  }
  if (Test-AiNovelGateLegacyBridgeTermination `
    -Step $Step `
    -LegacyBridge $LegacyBridge `
    -InstallerIdentity $ProcessIdentity) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'legacy-bridge-terminated'
  }
  if (Test-AiNovelGateLegacyBridgeOldApplicationExit `
    -Step $Step `
    -LegacyBridge $LegacyBridge `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'legacy-bridge-old-application-breakpoint'
  }
  if (Test-AiNovelGateNativeUpdaterOldApplicationExit `
    -Step $Step `
    -LegacyBridge $LegacyBridge `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'native-updater-old-application-breakpoint'
  }
  if ($null -eq $exitFailure) {
    return New-AiNovelGateExitVerdict -Kind succeeded
  }
  if (Test-AiNovelGateExpectedLegacyBridgeOldUninstallerPowerShellProbeExit `
    -Step $Step `
    -LegacyBridge $LegacyBridge `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'expected-legacy-bridge-old-uninstaller-powershell-probe'
  }
  if (Test-AiNovelGateExpectedNsisPowerShellProbeExit `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -LegacyBridge $LegacyBridge `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'expected-nsis-powershell-probe'
  }
  $filterVerdict = Get-AiNovelGateNsisFilterNoMatchVerdict `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -GreatGrandParentIdentity $greatGrandParentIdentity `
    -LegacyBridge $LegacyBridge `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities
  if ($null -ne $filterVerdict) {
    if ($filterVerdict.Kind -eq 'expected') {
      $filterVerdict.ParentKey = [string](Get-AiNovelGateProcessIdentityKey -ProcessIdentity $parentIdentity)
    }
    return $filterVerdict
  }
  if (Test-AiNovelGateExpectedNsisCmdProcessCheckExit `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -LegacyBridge $LegacyBridge `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities `
    -VerifiedFindParentKeys $VerifiedFindParentKeys) {
    return New-AiNovelGateExitVerdict -Kind expected -Classification 'expected-nsis-cmd-process-check'
  }
  if (Test-AiNovelGateNsisCmdProcessCheckCandidate `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -LegacyBridge $LegacyBridge `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities) {
    # A cmd.exe exit can reach the completion port before its find.exe child.
    # The caller defers the decision until a matching, validated filter exit.
    return New-AiNovelGateExitVerdict -Kind pending -Classification 'pending-nsis-cmd-process-check' -Failure $exitFailure
  }
  # An unproven NSIS process-check member must not fall into the result-owned
  # exemption below: its exit 1 has no identity the root's result can own.
  $unobservableReason = Get-AiNovelGateUnobservableNsisProcessCheckReason `
    -Step $Step `
    -Event $Event `
    -ProcessIdentity $ProcessIdentity `
    -ParentIdentity $parentIdentity `
    -GrandParentIdentity $grandParentIdentity `
    -GreatGrandParentIdentity $greatGrandParentIdentity `
    -LegacyBridge $LegacyBridge `
    -ArmedRootIdentity $ArmedRootIdentity `
    -TrackedProcessIdentities $TrackedProcessIdentities
  if (-not [string]::IsNullOrEmpty($unobservableReason)) {
    return New-AiNovelGateExitVerdict `
      -Kind unobservable `
      -Reason $unobservableReason `
      -Failure "Release gate step '$Step' could not prove the NSIS process-check exit code $($Event.ExitCode) for job-contained PID $($Event.ProcessId): its command line was not observed."
  }
  if (
    $Step -in @('build:win:artifacts', 'smoke:win-installer', 'smoke:win-v025-upgrade') -and
    $isCapturedNonzeroDescendantExit
  ) {
    return New-AiNovelGateExitVerdict -Kind result-owned -Classification 'ignored-result-owned-descendant-nonzero'
  }
  return New-AiNovelGateExitVerdict -Kind failure -Failure $exitFailure
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
    [AllowEmptyString()][string]$ExitClassification = '',
    [AllowEmptyString()][string]$ExitBasis = '',
    [AllowEmptyString()][string]$ExitReason = ''
  )

  [ordered]@{
    kind = [string]$Event.Kind
    step = $Step
    processId = [int]$Event.ProcessId
    exitCode = $Event.ExitCode
    captureEstablished = [bool]$Event.Retained
    captureAttemptedAt = [string]$Event.CaptureAttemptedAt
    captureFailureStage = [string]$Event.FailureStage
    captureWin32Error = $Event.Win32Error
    retainLatencyMicroseconds = $Event.RetainLatencyMicroseconds
    commandLineLoss = $Event.CommandLineLoss
    commandLineRetries = $Event.CommandLineRetries
    commandLineStatus = $Event.CommandLineStatus
    commandLineReadMicroseconds = $Event.CommandLineReadMicroseconds
    exitCodeCaptured = [bool]$Event.ExitCodeCaptured
    jobMessage = [uint32]$Event.JobMessage
    processIdentity = ConvertTo-AiNovelGateProcessEvidenceIdentity -ProcessIdentity $ProcessIdentity
    exitClassification = $ExitClassification
    exitBasis = $ExitBasis
    exitReason = $ExitReason
    recordedAt = [string]$Event.RecordedAt
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
  } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $Path 'process-events.jsonl') -Encoding utf8
}

function New-AiNovelGateCaptureSummary {
  param([AllowEmptyString()][string]$Step = '')

  return @{
    Step = $Step
    Written = $false
    Starts = 0
    Retained = 0
    Unretained = @{ OpenProcess = 0; KernelIdentity = 0 }
    CommandLineLoss = @{ 'exited-before-read' = 0; 'unreadable-while-alive' = 0 }
    RetainLatencies = [System.Collections.Generic.List[long]]::new()
    IgnoredResultOwnedNonzero = 0
    IgnoredResultOwnedImages = [System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  }
}

function Add-AiNovelGateCaptureSummaryStart {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Summary,
    [Parameter(Mandatory = $true)]$Event
  )

  $Summary.Starts += 1
  if (-not [bool]$Event.Retained) {
    $Summary.Unretained[[string]$Event.FailureStage] += 1
    return
  }
  $Summary.Retained += 1
  $loss = [string]$Event.CommandLineLoss
  if ($Summary.CommandLineLoss.ContainsKey($loss)) {
    $Summary.CommandLineLoss[$loss] += 1
  }
  if ($null -ne $Event.RetainLatencyMicroseconds) {
    $Summary.RetainLatencies.Add([long]$Event.RetainLatencyMicroseconds)
  }
}

function Add-AiNovelGateCaptureSummaryIgnoredExit {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Summary,
    [AllowNull()]$ProcessIdentity
  )

  $Summary.IgnoredResultOwnedNonzero += 1
  $imageName = [System.IO.Path]::GetFileName([string]$ProcessIdentity.executablePath)
  if (-not [string]::IsNullOrWhiteSpace($imageName)) {
    [void]$Summary.IgnoredResultOwnedImages.Add($imageName)
  }
}

function Get-AiNovelGateNearestRank {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][long[]]$Sorted,
    [Parameter(Mandatory = $true)][double]$Fraction
  )

  if ($Sorted.Count -eq 0) {
    return $null
  }
  return $Sorted[[Math]::Max(1, [int][Math]::Ceiling($Fraction * $Sorted.Count)) - 1]
}

function Write-AiNovelGateCaptureSummaryEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowNull()][hashtable]$Summary
  )

  # One summary per step, whichever terminal path or step transition comes first.
  if ($null -eq $Summary -or $Summary.Written -or [string]::IsNullOrWhiteSpace([string]$Summary.Step)) {
    return
  }
  $Summary.Written = $true
  $sorted = [long[]]@($Summary.RetainLatencies | Sort-Object)
  [ordered]@{
    kind = 'process-capture-summary'
    step = [string]$Summary.Step
    starts = $Summary.Starts
    retained = $Summary.Retained
    unretainedOpenProcess = $Summary.Unretained.OpenProcess
    unretainedKernelIdentity = $Summary.Unretained.KernelIdentity
    commandLineLoss = [ordered]@{
      exitedBeforeRead = $Summary.CommandLineLoss['exited-before-read']
      unreadableWhileAlive = $Summary.CommandLineLoss['unreadable-while-alive']
    }
    retainLatencyMicroseconds = [ordered]@{
      p50 = Get-AiNovelGateNearestRank -Sorted $sorted -Fraction 0.5
      p99 = Get-AiNovelGateNearestRank -Sorted $sorted -Fraction 0.99
      max = Get-AiNovelGateNearestRank -Sorted $sorted -Fraction 1
    }
    ignoredResultOwnedNonzero = [ordered]@{
      count = $Summary.IgnoredResultOwnedNonzero
      images = @($Summary.IgnoredResultOwnedImages)
    }
    recordedAt = [DateTime]::UtcNow.ToString('o')
    monitorStartedAt = $script:AiNovelGateMonitorStartedAt
  } | ConvertTo-Json -Compress -Depth 4 | Add-Content -LiteralPath (Join-Path $Path 'process-events.jsonl') -Encoding utf8
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
    TerminationArmedAtUtc = $null
    TerminatedAtUtc = $null
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
  if (
    [int]$Control.processId -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$Control.processStartTimeTicks) -or
    -not (Test-AiNovelGateProductExecutableInRoot -ExecutablePath ([string]$Control.executablePath) -InstallRoot $resolvedInstallRoot)
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
    legacyInstallerHandoffObserved = ($null -ne $installer)
    legacyInteractiveWizardObserved = ($LegacyBridge.AllowedWizardWindowKeys.Count -gt 0)
    commandLineCaptured = ($null -ne $installer -and [bool]$installer.commandLineCaptured)
    commandLineAuthorizationMode = 'record-only'
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
      -ParentIdentity $ParentIdentity)
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

function Test-AiNovelGateNativeUpdaterOldApplicationIdentity {
  param(
    [AllowNull()]$OldApplicationIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  if (
    $null -eq $OldApplicationIdentity -or
    $null -eq $TrackedProcessIdentities -or
    -not [bool]$OldApplicationIdentity.identityCaptured -or
    -not [bool]$OldApplicationIdentity.commandLineCaptured -or
    [int]$OldApplicationIdentity.processId -le 0 -or
    [string]::IsNullOrWhiteSpace($env:AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT) -or
    $env:AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }

  try {
    $oldApplicationPath = [string]$OldApplicationIdentity.executablePath
    if ($null -ne $script:AiNovelNativeUpdaterOldApplication) {
      $registered = $script:AiNovelNativeUpdaterOldApplication
      if (-not (Test-AiNovelGateExactIdentity -Identity $OldApplicationIdentity `
        -ProcessId $registered.processId -StartTimeTicks $registered.startTimeTicks -ExecutablePath $registered.executablePath)) {
        return $false
      }
      $oldApplicationExpected = (Get-AiNovelProductExecutableNames) -contains [System.IO.Path]::GetFileName($oldApplicationPath) -and
        (Test-AiNovelGateSameAbsolutePath -Left $oldApplicationPath -Right $registered.executablePath)
    }
    else {
      $oldApplicationExpected = Test-AiNovelGateProductExecutableInRoot `
        -ExecutablePath $oldApplicationPath `
        -InstallRoot ([System.IO.Path]::GetFullPath([System.IO.Path]::Combine(
          $env:AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT,
          'runtime',
          'installed-app'
        )))
    }
    if (-not $oldApplicationExpected -or
      -not $TrackedProcessIdentities.ContainsKey([int]$OldApplicationIdentity.processId)) {
      return $false
    }
    $trackedOldApplicationIdentity = $TrackedProcessIdentities[[int]$OldApplicationIdentity.processId]
    return (
      [bool]$trackedOldApplicationIdentity.commandLineCaptured -and
      (Test-AiNovelGateExactIdentity `
        -Identity $trackedOldApplicationIdentity `
        -ProcessId ([int]$OldApplicationIdentity.processId) `
        -StartTimeTicks ([string]$OldApplicationIdentity.startTimeTicks) `
        -ExecutablePath ([string]$OldApplicationIdentity.executablePath))
    )
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateNativeUpdaterPendingInstallerIdentity {
  param(
    [AllowNull()]$InstallerIdentity,
    [AllowNull()]$OldApplicationIdentity
  )

  # Native updater handoff has no legacy control record. Bind it to the one
  # expected final NSIS artifact underneath the updater-owned pending root and
  # to the exact captured old-app parent; do not infer authorization from a
  # basename or a merely similar LOCALAPPDATA path.
  if (
    $null -eq $InstallerIdentity -or
    $null -eq $OldApplicationIdentity -or
    -not [bool]$InstallerIdentity.identityCaptured -or
    -not [bool]$InstallerIdentity.commandLineCaptured -or
    [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
    $env:LOCALAPPDATA -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }
  try {
    $installerName = [System.IO.Path]::GetFileName([string]$InstallerIdentity.executablePath)
    if ($installerName -notmatch '^ai-novel-writer-setup-\d+\.\d+\.\d+\.exe$') {
      return $false
    }
    $expectedPendingInstallerPath = [System.IO.Path]::GetFullPath((Join-Path `
      $env:LOCALAPPDATA `
      (Join-Path 'ai-novel-writer-updater\pending' $installerName)))
    return (
      (Test-AiNovelGateSameAbsolutePath `
        -Left ([string]$InstallerIdentity.executablePath) `
        -Right $expectedPendingInstallerPath) -and
      (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $InstallerIdentity `
        -ParentIdentity $OldApplicationIdentity)
    )
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateNativeUpdaterOldApplicationExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # Electron can surface STATUS_BREAKPOINT after native autoUpdater has handed
  # its exact updater-owned pending installer to the old application. This is
  # deliberately independent of the legacy bridge and rejects every partial,
  # reused, drifted, or ambiguous process chain.
  if (
    $Step -ne 'windows-in-app-update-e2e' -or
    $null -ne $LegacyBridge -or
    $null -eq $Event -or
    $null -eq $ProcessIdentity -or
    $null -eq $TrackedProcessIdentities -or
    -not [bool]$Event.ExitCodeCaptured -or
    [uint32]$Event.JobMessage -ne 8 -or
    [int]$Event.ExitCode -ne -2147483645 -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    -not [bool]$ProcessIdentity.commandLineCaptured -or
    [int]$ProcessIdentity.processId -le 0 -or
    [int]$Event.ProcessId -ne [int]$ProcessIdentity.processId -or
    [string]::IsNullOrWhiteSpace($env:AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT) -or
    $env:AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT -notmatch '^[A-Za-z]:\\'
  ) {
    return $false
  }

  try {
    if (-not (Test-AiNovelGateNativeUpdaterOldApplicationIdentity `
      -OldApplicationIdentity $ProcessIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)) {
      return $false
    }
    $trackedOldApplicationIdentity = $TrackedProcessIdentities[[int]$ProcessIdentity.processId]
    $matchingInstallerCount = 0
    foreach ($candidateIdentity in @($TrackedProcessIdentities.Values)) {
      if (Test-AiNovelGateNativeUpdaterPendingInstallerIdentity `
        -InstallerIdentity $candidateIdentity `
        -OldApplicationIdentity $trackedOldApplicationIdentity) {
        $matchingInstallerCount += 1
      }
    }
    return $matchingInstallerCount -eq 1
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateLegacyBridgeOldApplicationExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Event,
    [AllowNull()]$ProcessIdentity
  )

  # Historical Electron can report STATUS_BREAKPOINT while quitting after its
  # already-bound updater handoff. Keep this exception tied to the exact old
  # app and exact direct-child official installer identity; no other process,
  # exit code, or pre-authorization state is accepted.
  if (
    $Step -ne 'windows-in-app-update-e2e' -or
    $null -eq $LegacyBridge -or
    -not (Test-AiNovelGateLegacyBridgeSourceTag -SourceTag ([string]$LegacyBridge.SourceTag)) -or
    $LegacyBridge.State -notin @('authorized', 'termination-armed', 'terminated') -or
    $null -eq $LegacyBridge.OldApplicationIdentity -or
    $null -eq $LegacyBridge.ObservedInstallerIdentity -or
    $null -eq $Event -or
    -not [bool]$Event.ExitCodeCaptured -or
    [uint32]$Event.JobMessage -ne 8 -or
    [int]$Event.ExitCode -ne -2147483645 -or
    -not [bool]$LegacyBridge.ObservedInstallerIdentity.identityCaptured -or
    -not [bool]$LegacyBridge.ObservedInstallerIdentity.commandLineCaptured -or
    -not (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$LegacyBridge.ObservedInstallerIdentity.executablePath) `
      -Right ([string]$LegacyBridge.ExpectedPendingInstallerPath)) -or
    -not (Test-AiNovelGateExactIdentity `
      -Identity $ProcessIdentity `
      -ProcessId ([int]$LegacyBridge.OldApplicationIdentity.processId) `
      -StartTimeTicks ([string]$LegacyBridge.OldApplicationIdentity.startTimeTicks) `
      -ExecutablePath ([string]$LegacyBridge.OldApplicationIdentity.executablePath)) -or
    -not (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $LegacyBridge.ObservedInstallerIdentity `
      -ParentIdentity $LegacyBridge.OldApplicationIdentity)
  ) {
    return $false
  }
  return $true
}

function Test-AiNovelGateLegacyBridgeOldUninstallerImage {
  param([AllowEmptyString()][string]$ImagePath)

  if ([string]::IsNullOrWhiteSpace($ImagePath) -or $ImagePath -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  try {
    $fullPath = Resolve-AiNovelGateCanonicalExistingPath -Path $ImagePath
    if ([string]::IsNullOrWhiteSpace($fullPath)) {
      return $false
    }
    $directory = [System.IO.Path]::GetDirectoryName($fullPath)
    $directoryName = [System.IO.Path]::GetFileName($directory)
    return (
      (Test-AiNovelGateDirectChildDirectory `
        -DirectoryPath $directory `
        -RootPath ([System.IO.Path]::GetTempPath())) -and
      $directoryName -match '^(?i:ns[A-Za-z0-9]+\.tmp)$' -and
      [string]::Equals(
        [System.IO.Path]::GetFileName($fullPath),
        'old-uninstaller.exe',
        [System.StringComparison]::OrdinalIgnoreCase
      )
    )
  }
  catch {
    return $false
  }
}

function Get-AiNovelGateLegacyBridgeStagingInstallerPath {
  param([AllowNull()]$LegacyBridge)

  if (
    $null -eq $LegacyBridge -or
    [string]$LegacyBridge.Mode -ne 'legacy-bridge' -or
    -not (Test-AiNovelGateLegacyBridgeSourceTag -SourceTag ([string]$LegacyBridge.SourceTag)) -or
    [string]::IsNullOrWhiteSpace([string]$LegacyBridge.InstallRoot) -or
    [string]::IsNullOrWhiteSpace([string]$LegacyBridge.ExpectedInstallerName) -or
    [string]$LegacyBridge.InstallRoot -notmatch '^[A-Za-z]:\\'
  ) {
    return $null
  }
  try {
    $installRoot = [System.IO.Path]::GetFullPath([string]$LegacyBridge.InstallRoot)
    if (-not [string]::Equals(
      [System.IO.Path]::GetFileName($installRoot.TrimEnd([char]92)),
      'installed-app',
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      return $null
    }
    $runtimeRoot = [System.IO.Path]::GetDirectoryName($installRoot.TrimEnd([char]92))
    return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine(
      $runtimeRoot,
      'legacy-bridge-staging',
      [string]$LegacyBridge.ExpectedInstallerName
    ))
  }
  catch {
    return $null
  }
}

function Test-AiNovelGateCapturedLegacyBridgeOldUninstallerProbeParent {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  $expectedStagingInstallerPath = Get-AiNovelGateLegacyBridgeStagingInstallerPath -LegacyBridge $LegacyBridge
  if (
    $null -eq $LegacyBridge -or
    $null -eq $ChildIdentity -or
    $null -eq $ParentIdentity -or
    $null -eq $GrandParentIdentity -or
    $null -eq $ArmedRootIdentity -or
    $null -eq $TrackedProcessIdentities
  ) {
    return $false
  }
  return (
    [string]$LegacyBridge.State -eq 'terminated' -and
    -not [string]::IsNullOrWhiteSpace($expectedStagingInstallerPath) -and
    (Test-AiNovelGateLegacyBridgeOldUninstallerImage -ImagePath ([string]$ParentIdentity.executablePath)) -and
    (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $ChildIdentity `
      -ParentIdentity $ParentIdentity) -and
    [bool]$GrandParentIdentity.identityCaptured -and
    [bool]$GrandParentIdentity.commandLineCaptured -and
    (Test-AiNovelGateSameAbsolutePath `
      -Left ([string]$GrandParentIdentity.executablePath) `
      -Right $expectedStagingInstallerPath) -and
    [string]::Equals(
      [System.IO.Path]::GetFileName([string]$GrandParentIdentity.executablePath),
      [string]$LegacyBridge.ExpectedInstallerName,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    (Test-AiNovelGateCapturedParentIdentity `
      -ChildIdentity $ParentIdentity `
      -ParentIdentity $GrandParentIdentity) -and
    (Test-AiNovelGateIdentityAncestryToArmedRoot `
      -StartIdentity $GrandParentIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities `
      -ArmedRootIdentity $ArmedRootIdentity)
  )
}

function Test-AiNovelGateCapturedNativeUpdaterOldUninstallerProbeParent {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$ChildIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # Native updater has no control record. The only valid old-uninstaller probe
  # chain is the captured E2E old app -> updater-owned pending installer ->
  # TEMP\ns<ASCII-alnum>.tmp\old-uninstaller.exe sequence. Keep each process
  # record identity-bound so a reused PID or similarly named temporary helper
  # cannot inherit this exception.
  if (
    $Step -ne 'windows-in-app-update-e2e' -or
    $null -ne $LegacyBridge -or
    $null -eq $ChildIdentity -or
    $null -eq $ParentIdentity -or
    $null -eq $GrandParentIdentity -or
    $null -eq $TrackedProcessIdentities -or
    [int]$ChildIdentity.processId -le 0 -or
    [int]$ParentIdentity.processId -le 0 -or
    [int]$GrandParentIdentity.processId -le 0 -or
    $null -eq $GrandParentIdentity.parentProcessId -or
    -not $TrackedProcessIdentities.ContainsKey([int]$ChildIdentity.processId) -or
    -not $TrackedProcessIdentities.ContainsKey([int]$ParentIdentity.processId) -or
    -not $TrackedProcessIdentities.ContainsKey([int]$GrandParentIdentity.processId) -or
    -not $TrackedProcessIdentities.ContainsKey([int]$GrandParentIdentity.parentProcessId)
  ) {
    return $false
  }

  try {
    $trackedChildIdentity = $TrackedProcessIdentities[[int]$ChildIdentity.processId]
    $trackedOldUninstallerIdentity = $TrackedProcessIdentities[[int]$ParentIdentity.processId]
    $trackedPendingInstallerIdentity = $TrackedProcessIdentities[[int]$GrandParentIdentity.processId]
    $trackedOldApplicationIdentity = $TrackedProcessIdentities[[int]$GrandParentIdentity.parentProcessId]
    if (
      -not (Test-AiNovelGateExactIdentity `
        -Identity $trackedChildIdentity `
        -ProcessId ([int]$ChildIdentity.processId) `
        -StartTimeTicks ([string]$ChildIdentity.startTimeTicks) `
        -ExecutablePath ([string]$ChildIdentity.executablePath)) -or
      -not (Test-AiNovelGateExactIdentity `
        -Identity $trackedOldUninstallerIdentity `
        -ProcessId ([int]$ParentIdentity.processId) `
        -StartTimeTicks ([string]$ParentIdentity.startTimeTicks) `
        -ExecutablePath ([string]$ParentIdentity.executablePath)) -or
      -not (Test-AiNovelGateExactIdentity `
        -Identity $trackedPendingInstallerIdentity `
        -ProcessId ([int]$GrandParentIdentity.processId) `
        -StartTimeTicks ([string]$GrandParentIdentity.startTimeTicks) `
        -ExecutablePath ([string]$GrandParentIdentity.executablePath)) -or
      -not (Test-AiNovelGateLegacyBridgeOldUninstallerImage `
        -ImagePath ([string]$ParentIdentity.executablePath)) -or
      -not (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $ChildIdentity `
        -ParentIdentity $ParentIdentity) -or
      -not (Test-AiNovelGateCapturedParentIdentity `
        -ChildIdentity $ParentIdentity `
        -ParentIdentity $GrandParentIdentity) -or
      -not (Test-AiNovelGateNativeUpdaterOldApplicationIdentity `
        -OldApplicationIdentity $trackedOldApplicationIdentity `
        -TrackedProcessIdentities $TrackedProcessIdentities) -or
      -not (Test-AiNovelGateNativeUpdaterPendingInstallerIdentity `
        -InstallerIdentity $trackedPendingInstallerIdentity `
        -OldApplicationIdentity $trackedOldApplicationIdentity)
    ) {
      return $false
    }

    $matchingInstallerCount = 0
    foreach ($candidateIdentity in @($TrackedProcessIdentities.Values)) {
      if (Test-AiNovelGateNativeUpdaterPendingInstallerIdentity `
        -InstallerIdentity $candidateIdentity `
        -OldApplicationIdentity $trackedOldApplicationIdentity) {
        $matchingInstallerCount += 1
      }
    }
    return $matchingInstallerCount -eq 1
  }
  catch {
    return $false
  }
}

function Test-AiNovelGateExpectedLegacyBridgeOldUninstallerPowerShellProbeExit {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Step,
    [AllowNull()]$LegacyBridge,
    [Parameter(Mandatory = $true)]$Event,
    [AllowNull()]$ProcessIdentity,
    [AllowNull()]$ParentIdentity,
    [AllowNull()]$GrandParentIdentity,
    [AllowNull()]$ArmedRootIdentity,
    [AllowNull()]$TrackedProcessIdentities
  )

  # The historical NSIS upgrade copies the installed uninstaller to
  # TEMP\ns<ASCII-alnum>.tmp\old-uninstaller.exe. Its fixed PowerShell probes use exit 1
  # as a normal negative result. This branch is intentionally limited to the
  # same-byte legacy bridge's private staging installer after the official
  # handoff has been terminated, with every ancestry edge identity-bound.
  if (
    $Step -ne 'windows-in-app-update-e2e' -or
    -not (Test-AiNovelGateExpectedExitOne -Step $Step -Event $Event) -or
    $null -eq $ProcessIdentity -or
    -not [bool]$ProcessIdentity.identityCaptured -or
    -not [bool]$ProcessIdentity.commandLineCaptured -or
    -not (Test-AiNovelGateSystemPowerShellImage -ImagePath ([string]$ProcessIdentity.executablePath)) -or
    -not (Test-AiNovelGateKnownNsisPowerShellProbeCommand `
      -CommandLine ([string]$ProcessIdentity.commandLine) `
      -PowerShellImagePath ([string]$ProcessIdentity.executablePath)) -or
    -not (Test-AiNovelGateCapturedLegacyBridgeOldUninstallerProbeParent `
      -LegacyBridge $LegacyBridge `
      -ChildIdentity $ProcessIdentity `
      -ParentIdentity $ParentIdentity `
      -GrandParentIdentity $GrandParentIdentity `
      -ArmedRootIdentity $ArmedRootIdentity `
      -TrackedProcessIdentities $TrackedProcessIdentities)
  ) {
    return $false
  }
  return $true
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
  if (-not (Test-AiNovelGateNsisSetupWindowTitle -Title ([string]$Window.Title))) {
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

function Test-AiNovelGateLegacyBridgeTransientWindow {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Window
  )

  # A bound historical NSIS process can briefly publish an untitled dialog
  # while the runner completes its exact-identity termination handshake. This
  # is not evidence that the interactive Setup wizard was observed.
  if (
    $null -eq $LegacyBridge -or
    $LegacyBridge.State -notin @('observed', 'authorized', 'termination-armed') -or
    $null -eq $LegacyBridge.ObservedInstallerIdentity -or
    $null -eq $Window -or
    -not [bool]$Window.Visible -or
    [string]$Window.ClassName -ne '#32770' -or
    -not [string]::IsNullOrWhiteSpace([string]$Window.Title) -or
    [int]$Window.ProcessId -ne [int]$LegacyBridge.ObservedInstallerIdentity.processId
  ) {
    return $false
  }
  return (Test-AiNovelGateLiveIdentity -Identity $LegacyBridge.ObservedInstallerIdentity)
}

function Test-AiNovelGateLegacyBridgeTerminationArmedCleanupWindow {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Window,
    [Parameter(Mandatory = $true)][hashtable]$TrackedProcessIdentities,
    [Parameter(Mandatory = $true)][DateTime]$NowUtc
  )

  # Stop-Process can make the exact bound installer cease being live before
  # its durable Job Object exit event is consumed. Bound this destruction gap
  # from the accepted termination control, without trusting a reused PID.
  if (
    $null -eq $LegacyBridge -or
    $LegacyBridge.State -ne 'termination-armed' -or
    $null -eq $LegacyBridge.TerminationArmedAtUtc -or
    $null -eq $LegacyBridge.ObservedInstallerIdentity -or
    $null -eq $Window -or
    -not [bool]$Window.Visible -or
    [string]$Window.ClassName -ne '#32770' -or
    [int]$Window.ProcessId -ne [int]$LegacyBridge.ObservedInstallerIdentity.processId
  ) {
    return $false
  }
  $terminationArmedAtUtc = [DateTime]$LegacyBridge.TerminationArmedAtUtc
  $cleanupAge = $NowUtc - $terminationArmedAtUtc
  if ($cleanupAge.TotalMilliseconds -lt 0 -or $cleanupAge.TotalSeconds -gt 5) {
    return $false
  }
  $installerProcessId = [int]$LegacyBridge.ObservedInstallerIdentity.processId
  if (-not $TrackedProcessIdentities.ContainsKey($installerProcessId)) {
    return $false
  }
  if (-not (Test-AiNovelGateExactIdentity `
    -Identity $TrackedProcessIdentities[$installerProcessId] `
    -ProcessId $installerProcessId `
    -StartTimeTicks ([string]$LegacyBridge.ObservedInstallerIdentity.startTimeTicks) `
    -ExecutablePath ([string]$LegacyBridge.ObservedInstallerIdentity.executablePath))) {
    return $false
  }
  $title = [string]$Window.Title
  if ([string]::IsNullOrWhiteSpace($title)) {
    return $true
  }
  return (Test-AiNovelGateNsisSetupWindowTitle -Title $title)
}

function Test-AiNovelGateLegacyBridgeTerminationCleanupWindow {
  param(
    [AllowNull()]$LegacyBridge,
    [AllowNull()]$Window,
    [Parameter(Mandatory = $true)][hashtable]$TrackedProcessIdentities,
    [Parameter(Mandatory = $true)][DateTime]$NowUtc
  )

  if (
    $null -eq $LegacyBridge -or
    $LegacyBridge.State -ne 'terminated' -or
    $null -eq $LegacyBridge.TerminatedAtUtc -or
    $null -eq $LegacyBridge.ObservedInstallerIdentity -or
    $null -eq $Window -or
    -not [bool]$Window.Visible -or
    [string]$Window.ClassName -ne '#32770' -or
    [int]$Window.ProcessId -ne [int]$LegacyBridge.ObservedInstallerIdentity.processId
  ) {
    return $false
  }
  $terminatedAtUtc = [DateTime]$LegacyBridge.TerminatedAtUtc
  $cleanupAge = $NowUtc - $terminatedAtUtc
  if ($cleanupAge.TotalMilliseconds -lt 0 -or $cleanupAge.TotalSeconds -gt 5) {
    return $false
  }
  $installerProcessId = [int]$LegacyBridge.ObservedInstallerIdentity.processId
  if (-not $TrackedProcessIdentities.ContainsKey($installerProcessId)) {
    return $false
  }
  if (-not (Test-AiNovelGateExactIdentity `
    -Identity $TrackedProcessIdentities[$installerProcessId] `
    -ProcessId $installerProcessId `
    -StartTimeTicks ([string]$LegacyBridge.ObservedInstallerIdentity.startTimeTicks) `
    -ExecutablePath ([string]$LegacyBridge.ObservedInstallerIdentity.executablePath))) {
    return $false
  }
  $title = [string]$Window.Title
  if ([string]::IsNullOrWhiteSpace($title)) {
    return $true
  }
  return (Test-AiNovelGateNsisSetupWindowTitle -Title $title)
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
  Get-AiNovelProductExecutableNames
  Get-AiNovelProductNames
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
$deferredProcessFailureKind = ''
$deferredProcessFailureDeadline = $null
$deferredNsisCmdExitFailure = New-AiNovelGateDeferredNsisCmdExitFailureState
$monitorFailureKind = 'monitor-failure'
$captureSummary = New-AiNovelGateCaptureSummary
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
  Write-AiNovelGateStatus -State 'failed' -Failure $failure -FailureKind 'monitor-failure'
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
  Write-AiNovelGateStatus -State 'failed' -Failure $failure -FailureKind 'error-window'
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
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
        Write-AiNovelGateStatus -State 'stopped' -Step $activeStep
        break
      }

      if ([string]$control.state -eq 'running') {
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
        $activeStep = [string]$control.step
        $captureSummary = New-AiNovelGateCaptureSummary -Step $activeStep
        $script:AiNovelNativeUpdaterOldApplication = $null
        $trackedProcessIds.Clear()
        $trackedProcessStartTimeTicks.Clear()
        $trackedProcessIdentities.Clear()
        $deferredProcessFailure = $null
        $deferredProcessFailureKind = ''
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
      elseif ([string]$control.state -eq 'native-updater-old-application') {
        $installRoot = [string]$control.installRoot
        $cacheRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime\.cache'
        $runtimeRoot = [System.IO.Path]::GetDirectoryName($installRoot)
        if ($activeStep -ne 'windows-in-app-update-e2e' -or [string]$control.step -ne $activeStep -or
          $null -ne $legacyBridge -or $null -ne $script:AiNovelNativeUpdaterOldApplication -or
          $installRoot -notmatch '^[A-Za-z]:\\' -or
          [System.IO.Path]::GetFileName($installRoot) -ne 'installed-app' -or
          [System.IO.Path]::GetFileName($runtimeRoot) -notmatch '^update-e2e-[a-f0-9]{32}$' -or
          -not (Test-AiNovelGateSameAbsolutePath -Left ([System.IO.Path]::GetDirectoryName($runtimeRoot)) -Right $cacheRoot) -or
          [int]$control.processId -le 0 -or [string]::IsNullOrWhiteSpace([string]$control.processStartTimeTicks) -or
          -not (Test-AiNovelGateProductExecutableInRoot -ExecutablePath ([string]$control.executablePath) -InstallRoot $installRoot)) {
          throw 'Release gate rejected native updater old application registration.'
        }
        $script:AiNovelNativeUpdaterOldApplication = [pscustomobject]@{
          processId = [int]$control.processId
          startTimeTicks = [string]$control.processStartTimeTicks
          executablePath = [System.IO.Path]::GetFullPath([string]$control.executablePath)
        }
        Write-AiNovelGateStatus -State 'native-updater-registered' -Step $activeStep
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
        $legacyBridge.TerminationArmedAtUtc = [DateTime]::UtcNow
        Write-AiNovelGateStatus -State 'legacy-bridge-termination-armed' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
      }
      elseif ([string]$control.state -eq 'step-complete') {
        $completionDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $completionQuietDeadline = $null
      }
      elseif ([string]$control.state -eq 'quiet') {
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
        $activeStep = [string]$control.step
        $captureSummary = New-AiNovelGateCaptureSummary -Step $activeStep
        $script:AiNovelNativeUpdaterOldApplication = $null
        $trackedProcessIds.Clear()
        $trackedProcessStartTimeTicks.Clear()
        $trackedProcessIdentities.Clear()
        $deferredProcessFailure = $null
        $deferredProcessFailureKind = ''
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
      $exitVerdict = $null
      $exitClassification = ''
      $processEventEvidenceWritten = $false
      if ([string]$processEvent.Kind -eq 'process-start') {
        Add-AiNovelGateCaptureSummaryStart -Summary $captureSummary -Event $processEvent
        $processIdentity = Get-AiNovelGateProcessIdentity -Event $processEvent
        if (-not [bool]$processEvent.Retained) {
          Write-AiNovelGateProcessEventEvidence `
            -Path $EvidencePath `
            -Step $activeStep `
            -Event $processEvent `
            -ProcessIdentity $processIdentity `
            -ExitClassification 'unobservable'
          $monitorFailureKind = 'unobservable-member'
          $unretainedFailure = if ([string]$processEvent.FailureStage -eq 'KernelIdentity') {
            "Release gate could not read the kernel identity of job-contained PID $($processEvent.ProcessId); its eventual exit could not be attributed."
          } else {
            "Release gate could not retain a process handle for job-contained PID $($processEvent.ProcessId); its eventual exit code would be unobservable."
          }
          throw $unretainedFailure
        }
        [void]$trackedProcessIds.Add([int]$processEvent.ProcessId)
        $trackedProcessStartTimeTicks[[int]$processEvent.ProcessId] = [long]$processEvent.ProcessStartTimeTicks
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
          $legacyParentIdentity = Get-AiNovelGateTrackedParentIdentity `
            -Identity $processIdentity `
            -TrackedProcessIdentities $trackedProcessIdentities
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
        $exitVerdict = Get-AiNovelGateExitVerdict `
          -Step $activeStep `
          -Event $processEvent `
          -ProcessIdentity $processIdentity `
          -TrackedProcessIdentities $trackedProcessIdentities `
          -LegacyBridge $legacyBridge `
          -ArmedRootIdentity $armedRootIdentity `
          -VerifiedFindParentKeys $verifiedNsisFindParentKeys
        $exitClassification = [string]$exitVerdict.Classification
        if ($exitClassification -eq 'legacy-bridge-terminated') {
          $legacyBridge.State = 'terminated'
          $legacyBridge.TerminatedAtUtc = [DateTime]::UtcNow
          Write-AiNovelGateStatus -State 'legacy-bridge-terminated' -Step $activeStep -LegacyBridge (Get-AiNovelGateLegacyBridgeStatus -LegacyBridge $legacyBridge)
        }
        elseif (-not [string]::IsNullOrEmpty([string]$exitVerdict.ParentKey)) {
          [void](Register-AiNovelGateVerifiedNsisFindParent `
            -VerifiedFindParentKeys $verifiedNsisFindParentKeys `
            -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures `
            -ParentProcessIdentityKey $exitVerdict.ParentKey)
          [void](Resolve-AiNovelGateDeferredNsisCmdExitFailure `
            -State $deferredNsisCmdExitFailure `
            -ProcessIdentityKey $exitVerdict.ParentKey)
        }
        elseif ($exitVerdict.Kind -eq 'pending') {
          [void](Add-AiNovelGatePendingNsisCmdExitFailure `
            -PendingNsisCmdExitFailures $pendingNsisCmdExitFailures `
            -ProcessIdentityKey (Get-AiNovelGateProcessIdentityKey -ProcessIdentity $processIdentity) `
            -Failure $exitVerdict.Failure)
        }
        elseif ($exitVerdict.Kind -eq 'result-owned') {
          Add-AiNovelGateCaptureSummaryIgnoredExit -Summary $captureSummary -ProcessIdentity $processIdentity
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
          -ExitClassification $exitClassification `
          -ExitBasis ([string]$exitVerdict.Basis) `
          -ExitReason ([string]$exitVerdict.Reason)
      }
      if ([string]::IsNullOrWhiteSpace($activeStep)) {
        continue
      }
      if ([string]$processEvent.Kind -eq 'monitor-error') {
        throw "Release gate lost its Job Object completion-port stream (Win32 error $($processEvent.JobMessage))."
      }
      if ([string]$processEvent.Kind -eq 'process-exit' -and $exitVerdict.Blocks -and $null -eq $deferredProcessFailure) {
        $deferredProcessFailure = [string]$exitVerdict.Failure
        $deferredProcessFailureKind = [string]$exitVerdict.FailureKind
        $deferredProcessFailureDeadline = [DateTime]::UtcNow.AddSeconds(15)
        Write-AiNovelGateProcessTreeEvidence `
          -Path $EvidencePath `
          -Step $activeStep `
          -ProcessIds $trackedProcessIds `
          -ProcessStartTimeTicks $trackedProcessStartTimeTicks `
          -Reason 'process-failure-awaiting-launch-result'
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
          if (Test-AiNovelGateLegacyBridgeTransientWindow -LegacyBridge $legacyBridge -Window $window) {
            continue
          }
          if (Test-AiNovelGateLegacyBridgeTerminationArmedCleanupWindow `
            -LegacyBridge $legacyBridge `
            -Window $window `
            -TrackedProcessIdentities $trackedProcessIdentities `
            -NowUtc ([DateTime]::UtcNow)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$window.Title)) {
              $windowKey = Get-AiNovelGateLegacyBridgeWindowKey -Window $window
              if (
                -not $legacyBridge.AllowedWizardWindowKeys.Contains($windowKey) -and
                $legacyBridge.AllowedWizardWindowKeys.Count -gt 0
              ) {
                $unallowedErrorWindows.Add($window)
                continue
              }
              [void]$legacyBridge.AllowedWizardWindowKeys.Add($windowKey)
            }
            continue
          }
          if (Test-AiNovelGateLegacyBridgeTerminationCleanupWindow `
            -LegacyBridge $legacyBridge `
            -Window $window `
            -TrackedProcessIdentities $trackedProcessIdentities `
            -NowUtc ([DateTime]::UtcNow)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$window.Title)) {
              $windowKey = Get-AiNovelGateLegacyBridgeWindowKey -Window $window
              if (
                -not $legacyBridge.AllowedWizardWindowKeys.Contains($windowKey) -and
                $legacyBridge.AllowedWizardWindowKeys.Count -gt 0
              ) {
                $unallowedErrorWindows.Add($window)
                continue
              }
              [void]$legacyBridge.AllowedWizardWindowKeys.Add($windowKey)
            }
            continue
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
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
        Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure -FailureKind 'error-window'
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
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
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
        Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
        Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure -FailureKind 'process-timeout'
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
      Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
      Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure -FailureKind $deferredProcessFailureKind
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
      Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
      Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure -FailureKind 'process-failure'
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
      Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
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
  Write-AiNovelGateCaptureSummaryEvidence -Path $EvidencePath -Summary $captureSummary
  Write-AiNovelGateStatus -State 'failed' -Step $activeStep -Failure $failure -FailureKind $monitorFailureKind
  Stop-AiNovelGateAtomicJob -AtomicMonitor $atomicMonitor
  Stop-AiNovelGateProcesses `
    -ProcessIds $trackedProcessIds `
    -ProcessStartTimeTicks $trackedProcessStartTimeTicks
  throw
}
finally {
  Complete-AiNovelGateAtomicMonitor -AtomicMonitor $atomicMonitor
}
