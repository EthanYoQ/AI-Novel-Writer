# This helper is deliberately shipped as an extraResource instead of relying on
# Node's path APIs. It opens every component below the supplied root directory
# handle with OBJ_DONT_REPARSE, so a junction/symlink replacement cannot redirect
# a later read, mkdir, list, or atomic replacement outside that root.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiNovelSecureFs {
  public sealed class SecureFsException : Exception {
    public string Code { get; private set; }
    public SecureFsException(string code) : base(code) { Code = code; }
  }

  public sealed class SecureDirectoryEntry {
    public string Name { get; set; }
    public bool IsDirectory { get; set; }
  }

  public static class SecureHandleFileSystem {
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const uint OBJ_DONT_REPARSE = 0x00001000;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint FILE_READ_DATA = 0x00000001;
    private const uint FILE_WRITE_DATA = 0x00000002;
    private const uint FILE_ADD_FILE = 0x00000002;
    private const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
    private const uint DELETE = 0x00010000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_DIRECTORY_FILE = 0x00000001;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_OPEN = 0x00000001;
    private const uint FILE_CREATE = 0x00000002;
    private const uint FILE_OPEN_IF = 0x00000003;
    private const int FileDirectoryInformation = 1;
    private const int FileRenameInformation = 10;
    private const int FileDispositionInformation = 13;
    private const int FileRenameInformationEx = 65;
    private const uint FILE_RENAME_REPLACE_IF_EXISTS = 0x00000001;
    private const uint FILE_RENAME_POSIX_SEMANTICS = 0x00000002;
    private const int STATUS_SUCCESS = 0;
    private const int STATUS_BUFFER_OVERFLOW = unchecked((int)0x80000005);
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);
    private const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
    private const int STATUS_OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);
    private const int STATUS_REPARSE_POINT_ENCOUNTERED = unchecked((int)0xC000050B);
    private const int STATUS_REPARSE_POINT_NOT_RESOLVED = unchecked((int)0xC0000280);
    private const int STATUS_DIRECTORY_IS_A_REPARSE_POINT = unchecked((int)0xC0000281);
    private const int MaxTextBytes = 64 * 1024 * 1024;
    private const int MaxSegments = 256;
    private const int MaxEntries = 16384;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes {
      public int Length;
      public IntPtr RootDirectory;
      public IntPtr ObjectName;
      public uint Attributes;
      public IntPtr SecurityDescriptor;
      public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock {
      public int Status;
      public IntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInformationHeader {
      public byte ReplaceIfExists;
      public IntPtr RootDirectory;
      public uint FileNameLength;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInformationExHeader {
      public uint Flags;
      public IntPtr RootDirectory;
      public uint FileNameLength;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DispositionInformation {
      public byte DeleteFile;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
      out IntPtr fileHandle,
      uint desiredAccess,
      ref ObjectAttributes objectAttributes,
      out IoStatusBlock ioStatusBlock,
      IntPtr allocationSize,
      uint fileAttributes,
      uint shareAccess,
      uint createDisposition,
      uint createOptions,
      IntPtr eaBuffer,
      uint eaLength);

    [DllImport("ntdll.dll")]
    private static extern int NtClose(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(
      IntPtr fileHandle,
      out IoStatusBlock ioStatusBlock,
      IntPtr fileInformation,
      uint length,
      int fileInformationClass);

    [DllImport("ntdll.dll")]
    private static extern int NtWriteFile(
      IntPtr fileHandle,
      IntPtr eventHandle,
      IntPtr apcRoutine,
      IntPtr apcContext,
      out IoStatusBlock ioStatusBlock,
      [In] byte[] buffer,
      uint length,
      IntPtr byteOffset,
      IntPtr key);

    [DllImport("ntdll.dll")]
    private static extern int NtFlushBuffersFile(
      IntPtr fileHandle,
      out IoStatusBlock ioStatusBlock);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryDirectoryFile(
      IntPtr fileHandle,
      IntPtr eventHandle,
      IntPtr apcRoutine,
      IntPtr apcContext,
      out IoStatusBlock ioStatusBlock,
      IntPtr fileInformation,
      uint length,
      int fileInformationClass,
      [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry,
      IntPtr fileName,
      [MarshalAs(UnmanagedType.U1)] bool restartScan);

    private static bool IsValidHandle(IntPtr handle) {
      return handle != IntPtr.Zero && handle != new IntPtr(-1);
    }

    private static void CloseHandle(ref IntPtr handle) {
      if (IsValidHandle(handle)) NtClose(handle);
      handle = IntPtr.Zero;
    }

    private static void ThrowForStatus(int status) {
      if (status == STATUS_REPARSE_POINT_ENCOUNTERED || status == STATUS_REPARSE_POINT_NOT_RESOLVED || status == STATUS_DIRECTORY_IS_A_REPARSE_POINT) {
        throw new SecureFsException("SECURE_FS_REPARSE_POINT");
      }
      if (status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND) {
        throw new SecureFsException("SECURE_FS_NOT_FOUND");
      }
      throw new SecureFsException("SECURE_FS_OPEN_FAILED");
    }

    private static string ToNtPath(string rootPath) {
      if (String.IsNullOrEmpty(rootPath) || rootPath.IndexOf('\0') >= 0) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string full = Path.GetFullPath(rootPath);
      if (full.StartsWith("\\\\?\\", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      if (full.StartsWith("\\\\", StringComparison.Ordinal)) {
        return "\\??\\UNC\\" + full.Substring(2);
      }
      if (full.Length >= 3 && Char.IsLetter(full[0]) && full[1] == ':' && (full[2] == '\\' || full[2] == '/')) {
        return "\\??\\" + full;
      }
      throw new SecureFsException("SECURE_FS_INVALID_PATH");
    }

    private static void ValidateSegment(string segment) {
      if (String.IsNullOrEmpty(segment) || segment == "." || segment == ".." || segment.IndexOf('\0') >= 0
        || segment.IndexOf(':') >= 0 || segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string bare = segment.Split('.')[0];
      string upper = bare.ToUpperInvariant();
      if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL"
        || (upper.StartsWith("COM") && upper.Length == 4 && upper[3] >= '1' && upper[3] <= '9')
        || (upper.StartsWith("LPT") && upper.Length == 4 && upper[3] >= '1' && upper[3] <= '9')) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
    }

    private static string[] RelativeSegments(string relativePath) {
      if (relativePath == null || relativePath.IndexOf('\0') >= 0 || relativePath.StartsWith("\\", StringComparison.Ordinal)
        || relativePath.StartsWith("/", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string[] raw = relativePath.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
      if (raw.Length > MaxSegments) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      foreach (string segment in raw) ValidateSegment(segment);
      return raw;
    }

    private static IntPtr OpenRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options) {
      return OpenRelative(
        rootDirectory,
        name,
        desiredAccess,
        fileAttributes,
        disposition,
        options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }

    private static IntPtr OpenRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options,
      uint shareAccess) {
      if (name == null || name.Length > 32760) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      IntPtr nameBuffer = IntPtr.Zero;
      try {
        nameBuffer = Marshal.StringToHGlobalUni(name);
        UnicodeString unicode = new UnicodeString {
          Length = checked((ushort)(name.Length * 2)),
          MaximumLength = checked((ushort)((name.Length * 2) + 2)),
          Buffer = nameBuffer,
        };
        IntPtr unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try {
          Marshal.StructureToPtr(unicode, unicodePointer, false);
          ObjectAttributes attributes = new ObjectAttributes {
            Length = Marshal.SizeOf(typeof(ObjectAttributes)),
            RootDirectory = rootDirectory,
            ObjectName = unicodePointer,
            Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            SecurityDescriptor = IntPtr.Zero,
            SecurityQualityOfService = IntPtr.Zero,
          };
          IoStatusBlock ioStatus;
          IntPtr handle;
          int status = NtCreateFile(
            out handle,
            desiredAccess,
            ref attributes,
            out ioStatus,
            IntPtr.Zero,
            fileAttributes,
            shareAccess,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            IntPtr.Zero,
            0);
          if (status != STATUS_SUCCESS) ThrowForStatus(status);
          return handle;
        } finally {
          Marshal.FreeHGlobal(unicodePointer);
        }
      } finally {
        if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
      }
    }

    private static uint DirectoryAccess(bool writable) {
      uint access = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
      if (writable) access |= FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
      return access;
    }

    private static IntPtr OpenRoot(string rootPath, bool writable) {
      return OpenRelative(
        IntPtr.Zero,
        ToNtPath(rootPath),
        DirectoryAccess(writable),
        FILE_ATTRIBUTE_DIRECTORY,
        FILE_OPEN,
        FILE_DIRECTORY_FILE);
    }

    private static IntPtr OpenDirectory(IntPtr parent, string segment, bool createIfMissing, bool writable) {
      return OpenRelative(
        parent,
        segment,
        DirectoryAccess(writable),
        FILE_ATTRIBUTE_DIRECTORY,
        createIfMissing ? FILE_OPEN_IF : FILE_OPEN,
        FILE_DIRECTORY_FILE);
    }

    private static IntPtr OpenFile(IntPtr parent, string segment, uint desiredAccess, uint disposition) {
      return OpenRelative(
        parent,
        segment,
        desiredAccess,
        FILE_ATTRIBUTE_NORMAL,
        disposition,
        FILE_NON_DIRECTORY_FILE);
    }

    private static List<IntPtr> OpenDirectoryChain(string rootPath, string[] segments, bool createIfMissing, bool writable) {
      List<IntPtr> handles = new List<IntPtr>();
      try {
        IntPtr current = OpenRoot(rootPath, writable);
        handles.Add(current);
        foreach (string segment in segments) {
          current = OpenDirectory(current, segment, createIfMissing, writable);
          handles.Add(current);
        }
        return handles;
      } catch {
        for (int i = handles.Count - 1; i >= 0; i--) {
          IntPtr handle = handles[i];
          CloseHandle(ref handle);
        }
        throw;
      }
    }

    private static void CloseDirectoryChain(List<IntPtr> handles) {
      for (int i = handles.Count - 1; i >= 0; i--) {
        IntPtr handle = handles[i];
        CloseHandle(ref handle);
      }
    }

    public static string ReadTextBase64(string rootPath, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      List<IntPtr> directories = OpenDirectoryChain(rootPath, Prefix(segments), false, false);
      IntPtr file = IntPtr.Zero;
      try {
        file = OpenFile(
          directories[directories.Count - 1],
          segments[segments.Length - 1],
          FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_OPEN);
        SafeFileHandle safeHandle = new SafeFileHandle(file, true);
        file = IntPtr.Zero;
        using (safeHandle) {
          using (FileStream stream = new FileStream(safeHandle, FileAccess.Read, 4096, false)) {
            if (stream.Length > MaxTextBytes) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
            using (MemoryStream content = new MemoryStream((int)stream.Length)) {
              stream.CopyTo(content);
              if (content.Length > MaxTextBytes) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
              return Convert.ToBase64String(content.ToArray());
            }
          }
        }
      } finally {
        CloseHandle(ref file);
        CloseDirectoryChain(directories);
      }
    }

    private static string[] Prefix(string[] segments) {
      if (segments.Length <= 1) return new string[0];
      string[] prefix = new string[segments.Length - 1];
      Array.Copy(segments, prefix, prefix.Length);
      return prefix;
    }

    private static void RenameIntoDirectory(IntPtr fileHandle, IntPtr parentDirectory, string targetName) {
      byte[] name = System.Text.Encoding.Unicode.GetBytes(targetName);
      int lengthOffset = (int)Marshal.OffsetOf(typeof(RenameInformationHeader), "FileNameLength") + sizeof(uint);
      IntPtr buffer = Marshal.AllocHGlobal(lengthOffset + name.Length);
      try {
        RenameInformationHeader header = new RenameInformationHeader {
          ReplaceIfExists = 1,
          RootDirectory = parentDirectory,
          FileNameLength = checked((uint)name.Length),
        };
        Marshal.StructureToPtr(header, buffer, false);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, lengthOffset), name.Length);
        IoStatusBlock ioStatus;
        int status = NtSetInformationFile(
          fileHandle,
          out ioStatus,
          buffer,
          checked((uint)(lengthOffset + name.Length)),
          FileRenameInformation);
        if (status != STATUS_SUCCESS) ThrowForStatus(status);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void RenameExistingIntoDirectory(IntPtr fileHandle, IntPtr parentDirectory, string targetName) {
      byte[] name = System.Text.Encoding.Unicode.GetBytes(targetName);
      int lengthOffset = (int)Marshal.OffsetOf(typeof(RenameInformationExHeader), "FileNameLength") + sizeof(uint);
      IntPtr buffer = Marshal.AllocHGlobal(lengthOffset + name.Length);
      try {
        RenameInformationExHeader header = new RenameInformationExHeader {
          Flags = FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS,
          RootDirectory = parentDirectory,
          FileNameLength = checked((uint)name.Length),
        };
        Marshal.StructureToPtr(header, buffer, false);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, lengthOffset), name.Length);
        IoStatusBlock ioStatus;
        int status = NtSetInformationFile(
          fileHandle,
          out ioStatus,
          buffer,
          checked((uint)(lengthOffset + name.Length)),
          FileRenameInformationEx);
        // FileRenameInformationEx/Posix is the only write-only commit path. If
        // this OS or file system rejects it, fail closed instead of falling
        // back to FileRenameInformation, which can create a missing target.
        if (status != STATUS_SUCCESS) throw new SecureFsException("SECURE_FS_WRITE_FAILED");
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void MarkDeleteOnClose(IntPtr fileHandle) {
      DispositionInformation disposition = new DispositionInformation { DeleteFile = 1 };
      IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(DispositionInformation)));
      try {
        Marshal.StructureToPtr(disposition, buffer, false);
        IoStatusBlock ioStatus;
        NtSetInformationFile(
          fileHandle,
          out ioStatus,
          buffer,
          checked((uint)Marshal.SizeOf(typeof(DispositionInformation))),
          FileDispositionInformation);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void WriteAndFlush(IntPtr fileHandle, byte[] content) {
      IoStatusBlock ioStatus;
      int status = NtWriteFile(
        fileHandle,
        IntPtr.Zero,
        IntPtr.Zero,
        IntPtr.Zero,
        out ioStatus,
        content,
        checked((uint)content.Length),
        IntPtr.Zero,
        IntPtr.Zero);
      if (status != STATUS_SUCCESS || ioStatus.Information.ToInt64() != content.Length) {
        throw new SecureFsException("SECURE_FS_WRITE_FAILED");
      }
      status = NtFlushBuffersFile(fileHandle, out ioStatus);
      if (status != STATUS_SUCCESS) throw new SecureFsException("SECURE_FS_WRITE_FAILED");
    }

    private static IntPtr OpenExistingTargetForWriteOnlyCommit(IntPtr parentDirectory, string targetName) {
      return OpenRelative(
        parentDirectory,
        targetName,
        // A metadata-only handle does not reliably participate in Windows
        // share-delete arbitration. FILE_WRITE_DATA makes this write-only
        // no-DELETE share lease effective while it stays open through commit.
        FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_ATTRIBUTE_NORMAL,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
        FILE_SHARE_READ | FILE_SHARE_WRITE);
    }

    /** Holds the temporary file and directory handles until main-process lease validation decides commit/cancel. */
    public sealed class AtomicWriteSession : IDisposable {
      private List<IntPtr> directories;
      private SafeFileHandle temporaryFile;
      private IntPtr parentDirectory;
      private IntPtr requiredTarget;
      private string targetName;
      private bool committed;

      internal AtomicWriteSession(
        List<IntPtr> directories,
        SafeFileHandle temporaryFile,
        IntPtr parentDirectory,
        IntPtr requiredTarget,
        string targetName) {
        this.directories = directories;
        this.temporaryFile = temporaryFile;
        this.parentDirectory = parentDirectory;
        this.requiredTarget = requiredTarget;
        this.targetName = targetName;
      }

      public void Commit(bool mustAlreadyExist) {
        if (temporaryFile == null || temporaryFile.IsClosed || temporaryFile.IsInvalid) {
          throw new SecureFsException("SECURE_FS_WRITE_FAILED");
        }
        try {
          if (mustAlreadyExist) {
            if (!IsValidHandle(requiredTarget)) throw new SecureFsException("SECURE_FS_WRITE_FAILED");
            RenameExistingIntoDirectory(temporaryFile.DangerousGetHandle(), parentDirectory, targetName);
          } else {
            RenameIntoDirectory(temporaryFile.DangerousGetHandle(), parentDirectory, targetName);
          }
          committed = true;
        } finally {
          CloseHandle(ref requiredTarget);
        }
      }

      public void Dispose() {
        if (temporaryFile != null) {
          if (!committed && !temporaryFile.IsClosed && !temporaryFile.IsInvalid) {
            MarkDeleteOnClose(temporaryFile.DangerousGetHandle());
          }
          temporaryFile.Dispose();
          temporaryFile = null;
        }
        if (directories != null) {
          CloseDirectoryChain(directories);
          directories = null;
        }
        CloseHandle(ref requiredTarget);
        parentDirectory = IntPtr.Zero;
        targetName = null;
      }
    }

    public static AtomicWriteSession BeginAtomicWrite(string rootPath, string relativePath, byte[] content, bool mustAlreadyExist) {
      if (content == null || content.Length > MaxTextBytes) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      List<IntPtr> directories = OpenDirectoryChain(rootPath, Prefix(segments), false, true);
      IntPtr temporaryFile = IntPtr.Zero;
      IntPtr requiredTarget = IntPtr.Zero;
      try {
        IntPtr parent = directories[directories.Count - 1];
        if (mustAlreadyExist) {
          requiredTarget = OpenExistingTargetForWriteOnlyCommit(parent, segments[segments.Length - 1]);
        }
        string temporaryName = ".ai-novel-" + Guid.NewGuid().ToString("N") + ".tmp";
        temporaryFile = OpenFile(
          parent,
          temporaryName,
          FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | DELETE | SYNCHRONIZE,
          FILE_CREATE);
        WriteAndFlush(temporaryFile, content);
        SafeFileHandle safeHandle = new SafeFileHandle(temporaryFile, true);
        temporaryFile = IntPtr.Zero;
        AtomicWriteSession session = new AtomicWriteSession(
          directories,
          safeHandle,
          parent,
          requiredTarget,
          segments[segments.Length - 1]);
        directories = null;
        requiredTarget = IntPtr.Zero;
        return session;
      } finally {
        CloseHandle(ref temporaryFile);
        CloseHandle(ref requiredTarget);
        if (directories != null) CloseDirectoryChain(directories);
      }
    }

    public static void MakeDirectory(string rootPath, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      List<IntPtr> directories = OpenDirectoryChain(rootPath, segments, true, true);
      CloseDirectoryChain(directories);
    }

    public static bool Exists(string rootPath, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) {
        List<IntPtr> root = OpenDirectoryChain(rootPath, segments, false, false);
        CloseDirectoryChain(root);
        return true;
      }
      List<IntPtr> directories;
      try {
        directories = OpenDirectoryChain(rootPath, Prefix(segments), false, false);
      } catch (SecureFsException error) {
        if (error.Code == "SECURE_FS_NOT_FOUND") return false;
        throw;
      }
      IntPtr target = IntPtr.Zero;
      try {
        target = OpenRelative(
          directories[directories.Count - 1],
          segments[segments.Length - 1],
          FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_ATTRIBUTE_NORMAL,
          FILE_OPEN,
          0);
        return true;
      } catch (SecureFsException error) {
        if (error.Code == "SECURE_FS_NOT_FOUND") return false;
        throw;
      } finally {
        CloseHandle(ref target);
        CloseDirectoryChain(directories);
      }
    }

    public static SecureDirectoryEntry[] ListDirectory(string rootPath, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      List<IntPtr> directories = OpenDirectoryChain(rootPath, segments, false, false);
      IntPtr buffer = IntPtr.Zero;
      try {
        IntPtr directory = directories[directories.Count - 1];
        buffer = Marshal.AllocHGlobal(65536);
        List<SecureDirectoryEntry> entries = new List<SecureDirectoryEntry>();
        bool restart = true;
        while (true) {
          IoStatusBlock ioStatus;
          int status = NtQueryDirectoryFile(
            directory,
            IntPtr.Zero,
            IntPtr.Zero,
            IntPtr.Zero,
            out ioStatus,
            buffer,
            65536,
            FileDirectoryInformation,
            false,
            IntPtr.Zero,
            restart);
          restart = false;
          if (status == STATUS_NO_MORE_FILES) break;
          if (status != STATUS_SUCCESS && status != STATUS_BUFFER_OVERFLOW) ThrowForStatus(status);
          int bytes = checked((int)ioStatus.Information.ToInt64());
          int offset = 0;
          while (offset < bytes) {
            int nextOffset = Marshal.ReadInt32(buffer, offset);
            uint attributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56));
            int nameLength = Marshal.ReadInt32(buffer, offset + 60);
            if (nameLength < 0 || (nameLength % 2) != 0 || offset + 64 + nameLength > bytes) {
              throw new SecureFsException("SECURE_FS_HELPER_FAILED");
            }
            string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 64), nameLength / 2);
            if (name != "." && name != "..") {
              // A directory may legitimately contain system compatibility
              // junctions (for example C:\Documents and Settings). Omitting
              // them keeps recursive enumeration usable without making the
              // entry traversable: any explicit access still goes through
              // OBJ_DONT_REPARSE in OpenRelative and fails closed.
              if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
                ValidateSegment(name);
                entries.Add(new SecureDirectoryEntry {
                  Name = name,
                  IsDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
                });
                if (entries.Count > MaxEntries) throw new SecureFsException("SECURE_FS_DIRECTORY_TOO_LARGE");
              }
            }
            if (nextOffset == 0) break;
            if (nextOffset < 0 || offset + nextOffset > bytes) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
            offset += nextOffset;
          }
        }
        return entries.ToArray();
      } finally {
        if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        CloseDirectoryChain(directories);
      }
    }
  }
}
'@

function Write-HelperResponse([object]$response) {
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
}

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop | Out-Null
  $inputLine = [Console]::In.ReadLine()
  if ($null -eq $inputLine -or $inputLine.Length -gt 100000000) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_REQUEST_TOO_LARGE')
  }
  $request = $inputLine | ConvertFrom-Json -ErrorAction Stop
  if (($null -eq $request) -or ($request.PSObject.Properties.Name -notcontains 'operation') -or ($request.PSObject.Properties.Name -notcontains 'rootPath') -or ($request.PSObject.Properties.Name -notcontains 'relativePath')) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_PATH')
  }
  if ($request.rootPath -isnot [string] -or $request.relativePath -isnot [string]) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_PATH')
  }

  switch ([string]$request.operation) {
    'read' {
      $contentBase64 = [AiNovelSecureFs.SecureHandleFileSystem]::ReadTextBase64($request.rootPath, $request.relativePath)
      Write-HelperResponse ([pscustomobject]@{ ok = $true; contentBase64 = $contentBase64 })
      break
    }
    'write' {
      if ($request.PSObject.Properties.Name -notcontains 'contentBase64' -or $request.contentBase64 -isnot [string]) {
        throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_TEXT')
      }
      $mustAlreadyExist = $false
      if ($request.PSObject.Properties.Name -contains 'mustAlreadyExist') {
        if ($request.mustAlreadyExist -isnot [bool]) {
          throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_OPERATION')
        }
        $mustAlreadyExist = [bool]$request.mustAlreadyExist
      }
      $content = [Convert]::FromBase64String([string]$request.contentBase64)
      $session = $null
      try {
        $session = [AiNovelSecureFs.SecureHandleFileSystem]::BeginAtomicWrite($request.rootPath, $request.relativePath, $content, $mustAlreadyExist)
        Write-HelperResponse ([pscustomobject]@{ ok = $true; phase = 'ready' })
        $commandLine = [Console]::In.ReadLine()
        if ($null -eq $commandLine -or $commandLine.Length -gt 4096) {
          throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_CANCELLED')
        }
        $command = $commandLine | ConvertFrom-Json -ErrorAction Stop
        if ($command.command -ne 'commit') {
          Write-HelperResponse ([pscustomobject]@{ ok = $false; code = 'SECURE_FS_CANCELLED' })
          break
        }
        $session.Commit($mustAlreadyExist)
        Write-HelperResponse ([pscustomobject]@{ ok = $true })
      } finally {
        if ($null -ne $session) { $session.Dispose() }
      }
      break
    }
    'mkdir' {
      [AiNovelSecureFs.SecureHandleFileSystem]::MakeDirectory($request.rootPath, $request.relativePath)
      Write-HelperResponse ([pscustomobject]@{ ok = $true })
      break
    }
    'exists' {
      $exists = [AiNovelSecureFs.SecureHandleFileSystem]::Exists($request.rootPath, $request.relativePath)
      Write-HelperResponse ([pscustomobject]@{ ok = $true; exists = $exists })
      break
    }
    'list' {
      $entries = @(
        [AiNovelSecureFs.SecureHandleFileSystem]::ListDirectory($request.rootPath, $request.relativePath) |
          ForEach-Object { [pscustomobject]@{ name = $_.Name; isDirectory = $_.IsDirectory } }
      )
      Write-HelperResponse ([pscustomobject]@{ ok = $true; entries = $entries })
      break
    }
    default {
      throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_OPERATION')
    }
  }
} catch {
  $code = 'SECURE_FS_HELPER_FAILED'
  if ($_.Exception -is [AiNovelSecureFs.SecureFsException]) {
    $code = $_.Exception.Code
  } elseif ($_.Exception.InnerException -is [AiNovelSecureFs.SecureFsException]) {
    $code = $_.Exception.InnerException.Code
  } elseif ($_.Exception.Message -match '^SECURE_FS_[A-Z0-9_]+$') {
    $code = $_.Exception.Message
  }
  Write-HelperResponse ([pscustomobject]@{ ok = $false; code = $code })
}
