$ErrorActionPreference = "SilentlyContinue"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32PopupTools {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

$wmClose = 0x0010
$patterns = @(
  "JavaScript error occurred in the main process",
  "EBUSY",
  "resource busy or locked"
)

function Get-WindowTextSafe([IntPtr]$handle) {
  $buffer = New-Object System.Text.StringBuilder 2048
  [void][Win32PopupTools]::GetWindowText($handle, $buffer, $buffer.Capacity)
  return $buffer.ToString()
}

function Get-WindowClassSafe([IntPtr]$handle) {
  $buffer = New-Object System.Text.StringBuilder 256
  [void][Win32PopupTools]::GetClassName($handle, $buffer, $buffer.Capacity)
  return $buffer.ToString()
}

function Get-ChildText([IntPtr]$handle) {
  $parts = New-Object System.Collections.Generic.List[string]
  [void][Win32PopupTools]::EnumChildWindows($handle, {
    param($childHandle, $lParam)
    $text = Get-WindowTextSafe $childHandle
    if ($text) { $parts.Add($text) }
    return $true
  }, [IntPtr]::Zero)
  return ($parts -join "`n")
}

while ($true) {
  try {
    [void][Win32PopupTools]::EnumWindows({
      param($handle, $lParam)
      if (-not [Win32PopupTools]::IsWindowVisible($handle)) { return $true }

      $title = Get-WindowTextSafe $handle
      $className = Get-WindowClassSafe $handle
      if ($title -ne "Error" -and $className -ne "#32770") { return $true }

      $text = "$title`n$(Get-ChildText $handle)"
      foreach ($pattern in $patterns) {
        if ($text -like "*$pattern*") {
          [void][Win32PopupTools]::PostMessage($handle, $wmClose, [IntPtr]::Zero, [IntPtr]::Zero)
          break
        }
      }
      return $true
    }, [IntPtr]::Zero)
  } catch {}
  Start-Sleep -Milliseconds 1500
}
