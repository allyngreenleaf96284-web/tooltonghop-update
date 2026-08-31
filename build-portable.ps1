param(
  [string]$OutputRoot = "C:\tmp\tooltonghop-portable"
)

$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = $OutputRoot
$appDest = Join-Path $distRoot "tooltonghop"
$bundledAppsDest = Join-Path $appDest "bundled-apps"
$nodeSource = "C:\Program Files\nodejs"
$robocopyArgs = @("/MIR", "/MT:32", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")

$xemTbSource = "C:\Users\CPT\Documents\New project\tool-xem-tb-portable-20260427"
$shippingSource = "C:\Users\CPT\Documents\New project\Shipping-Full-Studio"
$hmaStudioSource = "C:\Users\CPT\Documents\New project\dist\HMA-Studio-Portable-20260420"

if (Test-Path $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $distRoot | Out-Null
New-Item -ItemType Directory -Path $appDest | Out-Null
New-Item -ItemType Directory -Path $bundledAppsDest | Out-Null

Write-Host "Copying app..."
$excludedDirs = @("logs")
if ($distRoot.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  $relativeOutput = $distRoot.Substring($sourceRoot.Length).TrimStart('\')
  if ($relativeOutput) {
    $topLevelOutput = $relativeOutput.Split('\')[0]
    if ($topLevelOutput -and -not ($excludedDirs -contains $topLevelOutput)) {
      $excludedDirs += $topLevelOutput
    }
  }
}
robocopy $sourceRoot $appDest @robocopyArgs /XD @excludedDirs | Out-Null

Write-Host "Copying Node runtime..."
robocopy $nodeSource (Join-Path $distRoot "node-runtime") @robocopyArgs | Out-Null

Write-Host "Copying bundled apps..."
robocopy $xemTbSource (Join-Path $bundledAppsDest "tool-xem-tb-portable-20260427") @robocopyArgs | Out-Null
robocopy $shippingSource (Join-Path $bundledAppsDest "Shipping-Full-Studio") @robocopyArgs | Out-Null
robocopy $hmaStudioSource (Join-Path $bundledAppsDest "HMA-Studio-Portable-20260420") @robocopyArgs | Out-Null

$cmdPath = Join-Path $distRoot "Run Tool Tong Hop.cmd"
$vbsPath = Join-Path $distRoot "Mo Tool Tong Hop.vbs"
$readmePath = Join-Path $distRoot "README-PORTABLE.txt"

$cmd = @'
@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0tooltonghop\logs" mkdir "%~dp0tooltonghop\logs"
start "ToolTongHopServer" /min "%~dp0node-runtime\node.exe" "%~dp0tooltonghop\server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5177"
exit /b 0
'@
Set-Content -LiteralPath $cmdPath -Value $cmd -Encoding ASCII

$vbs = @'
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & WScript.ScriptFullName & "\..\Run Tool Tong Hop.cmd" & Chr(34), 0, False
'@
$vbsFixed = @'
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run Chr(34) & base & "\Run Tool Tong Hop.cmd" & Chr(34), 0, False
'@
Set-Content -LiteralPath $vbsPath -Value $vbsFixed -Encoding ASCII

$readme = @'
Tool tong hop portable

1. Giai nen thu muc nay sang may khac.
2. Double click:
   - Mo Tool Tong Hop.vbs  (an console)
   hoac
   - Run Tool Tong Hop.cmd (hien console)
3. Truy cap http://127.0.0.1:5177

Luu y:
- Ban portable da kem Node runtime.
- Da kem cac app phu thuoc cho xem thong bao / lam full / HMA Studio.
- Neu can, sua file tooltonghop\config.json tren may moi.
'@
Set-Content -LiteralPath $readmePath -Value $readme -Encoding UTF8

Write-Host "Portable package created at: $distRoot"
