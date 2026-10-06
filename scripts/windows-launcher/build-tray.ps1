[CmdletBinding()]
param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'CodexMobileRemoteLauncher.cs'
$trayIcon = Join-Path $repo 'assets\codex-mobile-link-tray-v1.ico'
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $repo 'bin\CodexMobileRemoteTray-unified-v1.exe'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
& $compiler /nologo /target:winexe /optimize+ /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/win32icon:$trayIcon" "/out:$OutputPath" $source (Join-Path $PSScriptRoot 'UnifiedTrayContext.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray build failed' }
Write-Output $OutputPath
