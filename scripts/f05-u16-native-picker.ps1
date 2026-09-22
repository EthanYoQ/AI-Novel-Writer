param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$ExpectedExe,
  [Parameter(Mandatory=$true)][string]$DialogTitle
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class NativePickerInput {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder buffer, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder buffer, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, StringBuilder lparam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUI info);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI {
    public int cbSize; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public ushort vk;
    [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags;
    [FieldOffset(16)] public uint time;
    [FieldOffset(24)] public IntPtr extra;
  }
  public static string Class(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
  public static string Text(IntPtr h) { var b=new StringBuilder(4096); GetWindowText(h,b,b.Capacity); return b.ToString(); }
  public static string EditText(IntPtr h) { var b=new StringBuilder(4096); SendMessage(h,0xD,(IntPtr)b.Capacity,b); return b.ToString(); }
  public static INPUT Key(ushort vk, ushort scan, uint flags) { return new INPUT { type=1, vk=vk, scan=scan, flags=flags }; }
  public static uint Send(INPUT[] inputs) { return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  public static GUI Gui(uint thread) { var g=new GUI(); g.cbSize=Marshal.SizeOf(typeof(GUI)); GetGUIThreadInfo(thread,ref g); return g; }
}
'@
$matches = [System.Collections.Generic.List[object]]::new()
$cb = [NativePickerInput+EnumProc]{ param($h,$x)
  if ([NativePickerInput]::Class($h) -eq '#32770' -and [NativePickerInput]::Text($h) -eq $DialogTitle) {
    [uint32]$dialogPid = 0
    $thread = [NativePickerInput]::GetWindowThreadProcessId($h,[ref]$dialogPid)
    $proc = Get-Process -Id $dialogPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -eq $ExpectedExe) { $matches.Add([pscustomobject]@{ h=$h; pid=$dialogPid; thread=$thread }) }
  }
  return $true
}
for($i=0; $i -lt 100 -and $matches.Count -eq 0; $i++){ [NativePickerInput]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 100 }
if($matches.Count -ne 1){ throw "Expected one matching Electron save dialog; found $($matches.Count)" }
$d = $matches[0]
$edits = [System.Collections.Generic.List[IntPtr]]::new()
$buttons = [System.Collections.Generic.List[IntPtr]]::new()
$allControls = [System.Collections.Generic.List[string]]::new()
$child = [NativePickerInput+EnumProc]{ param($h,$x)
  $allControls.Add("$([NativePickerInput]::Class($h)):$([NativePickerInput]::GetDlgCtrlID($h))")
  if([NativePickerInput]::Class($h) -eq 'Edit'){ $edits.Add($h) }
  if([NativePickerInput]::Class($h) -eq 'Button'){ $buttons.Add($h) }
  return $true
}
[NativePickerInput]::EnumChildWindows($d.h,$child,[IntPtr]::Zero) | Out-Null
$fileNameId = switch ($DialogTitle) {
  '导出项目存档' { 1001 }
  '选择项目存档' { 1148 }
  '选择作者原稿文件' { 1148 }
  '选择恢复副本所在文件夹' { 1152 }
  default { throw "Unsupported picker title: $DialogTitle" }
}
$fileNameEdits = @($edits | Where-Object { [NativePickerInput]::GetDlgCtrlID($_) -eq $fileNameId })
if($fileNameEdits.Count -ne 1){
  $controls = @($edits | ForEach-Object { "Edit:$([NativePickerInput]::GetDlgCtrlID($_))" })
  throw "Expected one File name Edit control id $fileNameId; found $($fileNameEdits.Count); edit controls=[$($controls -join ',')]; child classes/ids=[$($allControls -join ',')]"
}
$edit = $fileNameEdits[0]
$currentThread = [NativePickerInput]::GetCurrentThreadId()
$priorForeground = [NativePickerInput]::GetForegroundWindow()
[uint32]$foregroundPid = 0
$foregroundThread = [NativePickerInput]::GetWindowThreadProcessId($priorForeground,[ref]$foregroundPid)
$foregroundAttached = $foregroundThread -ne $currentThread -and [NativePickerInput]::AttachThreadInput($currentThread,$foregroundThread,$true)
$attached = [NativePickerInput]::AttachThreadInput($currentThread,$d.thread,$true)
if(-not $attached){ throw 'AttachThreadInput to dialog failed' }
try {
  [NativePickerInput]::SetForegroundWindow($d.h) | Out-Null
  [NativePickerInput]::SetFocus($edit) | Out-Null
} finally {
  [NativePickerInput]::AttachThreadInput($currentThread,$d.thread,$false) | Out-Null
  if($foregroundAttached){ [NativePickerInput]::AttachThreadInput($currentThread,$foregroundThread,$false) | Out-Null }
}
Start-Sleep -Milliseconds 100
$foreground = [NativePickerInput]::GetForegroundWindow()
$focus = [NativePickerInput]::Gui($d.thread).hwndFocus
if($foreground -ne $d.h -or $focus -ne $edit){ throw "Focus mismatch foreground=$foreground dialog=$($d.h) focus=$focus edit=$edit" }
$before = [NativePickerInput]::EditText($edit)
$controlA = @([NativePickerInput]::Key(0x11,0,0),[NativePickerInput]::Key(0x41,0,0),[NativePickerInput]::Key(0x41,0,2),[NativePickerInput]::Key(0x11,0,2))
if([NativePickerInput]::Send($controlA) -ne $controlA.Length){ throw 'Ctrl+A SendInput incomplete' }
$keys = [System.Collections.Generic.List[NativePickerInput+INPUT]]::new()
foreach($unit in $Target.ToCharArray()) {
  $keys.Add([NativePickerInput]::Key(0,[uint16][char]$unit,4))
  $keys.Add([NativePickerInput]::Key(0,[uint16][char]$unit,6))
}
if([NativePickerInput]::Send($keys.ToArray()) -ne $keys.Count){ throw 'Unicode SendInput incomplete' }
Start-Sleep -Milliseconds 300
$after = [NativePickerInput]::EditText($edit)
if($after -ne $Target){ throw "Edit readback mismatch before=[$before] after=[$after]" }
$enter = @([NativePickerInput]::Key(0x0d,0,0),[NativePickerInput]::Key(0x0d,0,2))
if($DialogTitle -eq '选择恢复副本所在文件夹'){
  $confirm = @($buttons | Where-Object { [NativePickerInput]::GetDlgCtrlID($_) -eq 1 })
  if($confirm.Count -ne 1 -or [NativePickerInput]::Text($confirm[0]) -ne '选择文件夹' -or
     -not [NativePickerInput]::IsWindowVisible($confirm[0]) -or -not [NativePickerInput]::IsWindowEnabled($confirm[0])){
    throw 'Expected one visible, enabled 选择文件夹 Button id 1'
  }
  [NativePickerInput]::SendMessage($confirm[0],0xF5,[IntPtr]::Zero,$null) | Out-Null
} elseif([NativePickerInput]::Send($enter) -ne $enter.Length){ throw 'Enter SendInput incomplete' }
[pscustomobject]@{ dialogTitle=$DialogTitle; dialogPid=$d.pid; dialogHandle=$d.h.ToInt64(); focusHandle=$focus.ToInt64(); before=$before; typedExact=$true; submitted=$true; submitControl=$(if($DialogTitle -eq '选择恢复副本所在文件夹'){'Button:1'}else{'Enter'}) } | ConvertTo-Json -Compress
