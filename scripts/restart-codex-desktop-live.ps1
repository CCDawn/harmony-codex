[CmdletBinding()]
param(
  [int]$CdpPort = 9229,
  [string]$BridgeUrl = 'http://127.0.0.1:8787',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$SessionId = '',
  [string]$CodexAppPath = '',
  [switch]$KeepExistingCodex,
  [switch]$UsePackagedActivation,
  [switch]$RefusePlainCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-CompatiblePowerShellHost {
  $currentHost = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentHost -and -not [string]::IsNullOrWhiteSpace([string]$currentHost.Path) -and (Test-Path -LiteralPath ([string]$currentHost.Path))) {
    return [string]$currentHost.Path
  }

  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not [string]::IsNullOrWhiteSpace([string]$pwsh.Source) -and (Test-Path -LiteralPath ([string]$pwsh.Source))) {
    return [string]$pwsh.Source
  }

  throw '未找到可用的 PowerShell 主机'
}

$powerShellHostPath = Resolve-CompatiblePowerShellHost

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-PlainCodexShellRunning {
  $shells = @(Get-CodexDesktopProcesses | Where-Object {
    [string]$_.CommandLine -notmatch '\s--type='
  })
  foreach ($proc in $shells) {
    if ([string]$proc.CommandLine -notmatch 'remote-debugging-port') {
      return $true
    }
  }
  return $false
}

function Get-CodexDesktopProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $path = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    $isPackagedChatGpt = $path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or
      $cmd -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe'
    $isLegacyCodex = $path.EndsWith('\app\Codex.exe', [System.StringComparison]::OrdinalIgnoreCase) -or
      ($cmd -match '\\app\\Codex\.exe"?(?:\s|$)')
    $isPackagedChatGpt -or $isLegacyCodex
  }
}

function Resolve-CodexAppDir {
  param([string]$ExplicitPath)

  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    if (-not (Test-Path -LiteralPath $ExplicitPath)) {
      throw "Codex App 路径不存在: $ExplicitPath"
    }
    $resolved = [System.IO.Path]::GetFullPath($ExplicitPath)
    if ((Split-Path -Leaf $resolved) -match '^(Codex|ChatGPT)\.exe$') {
      return Split-Path -Parent $resolved
    }
    if ((Test-Path -LiteralPath (Join-Path $resolved 'ChatGPT.exe')) -or
        (Test-Path -LiteralPath (Join-Path $resolved 'Codex.exe'))) {
      return $resolved
    }
    if ((Test-Path -LiteralPath (Join-Path $resolved 'app\ChatGPT.exe')) -or
        (Test-Path -LiteralPath (Join-Path $resolved 'app\Codex.exe'))) {
      return Join-Path $resolved 'app'
    }
    return $resolved
  }

  $appxPackages = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue)
  $appxPackage = $appxPackages |
    Sort-Object -Property @{ Expression = { try { [version]$_.Version } catch { [version]'0.0.0.0' } } } -Descending |
    Select-Object -First 1
  if ($appxPackage -and -not [string]::IsNullOrWhiteSpace($appxPackage.InstallLocation)) {
    $appxAppDir = Join-Path ([string]$appxPackage.InstallLocation) 'app'
    if ((Test-Path -LiteralPath (Join-Path $appxAppDir 'ChatGPT.exe')) -or
        (Test-Path -LiteralPath (Join-Path $appxAppDir 'Codex.exe'))) {
      return $appxAppDir
    }
  }

  $running = Get-CodexDesktopProcesses | Select-Object -First 1
  if ($running -and -not [string]::IsNullOrWhiteSpace($running.ExecutablePath)) {
    $runningDir = Split-Path -Parent ([string]$running.ExecutablePath)
    if ((Test-Path -LiteralPath (Join-Path $runningDir 'ChatGPT.exe')) -or
        (Test-Path -LiteralPath (Join-Path $runningDir 'Codex.exe'))) {
      return $runningDir
    }
  }

  $candidates = Get-ChildItem -LiteralPath 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName 'app\ChatGPT.exe')) -or
        (Test-Path -LiteralPath (Join-Path $_.FullName 'app\Codex.exe'))
    } |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'app' }

  if (-not $candidates -or $candidates.Count -eq 0) {
    throw '未找到 Codex App 目录'
  }
  return [string]$candidates[0]
}

function Get-AppUserModelIdFromAppDir {
  param([string]$AppDir)

  $dir = Get-Item -LiteralPath $AppDir
  $packageDir = if ($dir.Name -ieq 'app') { $dir.Parent } else { $dir }
  $packageName = $packageDir.Name
  if ($packageName -notmatch '^(OpenAI\.Codex)_[^_]+_.*__(.+)$') {
    return ''
  }
  return "$($Matches[1])_$($Matches[2])!App"
}

function Test-LoopbackPortAvailable {
  param([int]$Port)
  if ($Port -eq 0) { return $true }
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Select-LoopbackPort {
  param([int]$Requested)
  if (Test-LoopbackPortAvailable -Port $Requested) {
    return $Requested
  }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), 0)
  try {
    $listener.Start()
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Wait-Cdp {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 25
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      foreach ($path in @('/json', '/json/list')) {
        $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 2)
        $pages = @($targets | Where-Object {
            $_.type -eq 'page' -and -not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl)
          })
        if ($pages.Count -gt 0) {
          return $targets
        }
      }
      $lastError = 'CDP endpoint responded without a page websocket target'
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 700
  }
  throw "CDP 端口未就绪: 127.0.0.1:$Port; $lastError"
}

function Test-CdpReady {
  param([int]$Port)
  foreach ($path in @('/json', '/json/list')) {
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 2)
      foreach ($target in $targets) {
        if ($target.type -eq 'page' -and -not [string]::IsNullOrWhiteSpace([string]$target.webSocketDebuggerUrl)) {
          return $true
        }
      }
    } catch {
    }
  }
  return $false
}

function Invoke-BridgeJson {
  param(
    [string]$Url,
    [string]$Token
  )
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $headers['X-Codex-Bridge-Token'] = $Token
  }
  Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec 8
}

function Stop-DesktopLiveHost {
  $escapedRepo = [Regex]::Escape($repoRoot)
  $allProcesses = @(Get-CimInstance Win32_Process)
  function Stop-ProcessTreeLocal {
    param([int]$TargetProcessId)
    $children = @($allProcesses | Where-Object { $_.ParentProcessId -eq $TargetProcessId })
    foreach ($child in $children) {
      Stop-ProcessTreeLocal -TargetProcessId ([int]$child.ProcessId)
    }
    Stop-Process -Id $TargetProcessId -Force -ErrorAction SilentlyContinue
  }

  $targets = @($allProcesses | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.ProcessId -ne $PID -and
      $commandLine -match 'start-desktop-cdp-live-host\.mjs' -and
      ($commandLine -match $escapedRepo -or $commandLine -match 'CODEX_BRIDGE_URL')
  })

  foreach ($target in $targets) {
    $children = @($allProcesses | Where-Object { $_.ParentProcessId -eq $target.ProcessId })
    foreach ($child in $children) {
      if ([string]$child.CommandLine -match 'start-desktop-cdp-live-host\.mjs') {
        Write-Host "停止旧桌面 CDP host 子进程 PID=$($child.ProcessId)" -ForegroundColor DarkGray
        Stop-ProcessTreeLocal -TargetProcessId ([int]$child.ProcessId)
      }
    }
    Write-Host "停止旧桌面 CDP host PID=$($target.ProcessId)" -ForegroundColor DarkGray
    Stop-ProcessTreeLocal -TargetProcessId ([int]$target.ProcessId)
  }
}

function Stop-CodexDesktopShell {
  $deadline = (Get-Date).AddSeconds(18)

  do {
    $desktopProcesses = @(Get-CodexDesktopProcesses)
    if ($desktopProcesses.Count -eq 0) {
      return
    }

    foreach ($proc in $desktopProcesses) {
      Write-Host "停止 Codex 桌面进程 PID=$($proc.ProcessId)" -ForegroundColor DarkGray
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 700
  } while ((Get-Date) -lt $deadline)

  $remaining = @(Get-CodexDesktopProcesses)
  if ($remaining.Count -gt 0) {
    $ids = ($remaining | Select-Object -ExpandProperty ProcessId) -join ', '
    throw "Codex 桌面进程未能完整退出: PID=$ids"
  }
}

function Wait-DesktopScriptOnline {
  param(
    [string]$Url,
    [string]$Token,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $lastStatus = Invoke-BridgeJson -Url "$Url/desktop/script/status" -Token $Token
      $scriptAuth = $lastStatus.bridge.scriptAuth
      $authHealthy = if ($null -eq $scriptAuth) { $true } else { [bool]$scriptAuth.healthy }
      if ($lastStatus.bridge.online -eq $true -and $authHealthy) {
        return $lastStatus
      }
      if ($lastStatus.bridge.online -eq $true -and -not $authHealthy) {
        $lastStatus = @{
          error = 'desktop script bridge auth unhealthy'
          bridge = $lastStatus.bridge
        }
      }
    } catch {
      $lastStatus = @{ error = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds 700
  }
  throw "桌面脚本桥未上线: $($lastStatus | ConvertTo-Json -Depth 8)"
}

function Save-DesktopLiveStatus {
  param([hashtable]$Status)
  $logsDir = Join-Path $repoRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $path = Join-Path $logsDir 'desktop-live-status.json'
  $Status['updatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
  $Status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
}

function Add-ApplicationActivationManagerType {
  if ('CodexHramony.ApplicationActivationManager' -as [type]) {
    return
  }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexHramony {
  [Flags]
  public enum ActivateOptions {
    None = 0,
    DesignMode = 1,
    NoErrorUI = 2,
    NoSplashScreen = 4
  }

  [ComImport]
  [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments,
      ActivateOptions options,
      out uint processId);

    [PreserveSig]
    int ActivateForFile(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      [MarshalAs(UnmanagedType.LPWStr)] string verb,
      out uint processId);

    [PreserveSig]
    int ActivateForProtocol(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      out uint processId);
  }

  [ComImport]
  [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager {}

  public static class ActivationBridge {
    public static uint ActivateApplication(string appUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int hr = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.NoErrorUI, out processId);
      if (hr != 0) {
        Marshal.ThrowExceptionForHR(hr);
      }
      return processId;
    }
  }
}
'@
}

function Start-PackagedCodex {
  param(
    [string]$AppUserModelId,
    [string]$Arguments
  )

  Add-ApplicationActivationManagerType
  return [uint32][CodexHramony.ActivationBridge]::ActivateApplication($AppUserModelId, $Arguments)
}

$relaunchMutex = New-Object System.Threading.Mutex($false, 'Local\CodexHarmonyDesktopRelaunch')
$relaunchMutexOwned = $false
try {
  try {
    $relaunchMutexOwned = $relaunchMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $relaunchMutexOwned = $true
  }
} catch {
  $relaunchMutexOwned = $false
}
if (-not $relaunchMutexOwned) {
  Write-Host '已有 Codex 拉起正在进行，本次不重复启动。'
  exit 10
}

try {
$repoRoot = Split-Path -Parent $PSScriptRoot
$BridgeUrl = $BridgeUrl.TrimEnd('/')
$codexAppDir = Resolve-CodexAppDir -ExplicitPath $CodexAppPath
$packagedDesktopExe = Join-Path $codexAppDir 'ChatGPT.exe'
$legacyDesktopExe = Join-Path $codexAppDir 'Codex.exe'
$codexDesktopExe = if (Test-Path -LiteralPath $packagedDesktopExe) { $packagedDesktopExe } else { $legacyDesktopExe }
$appUserModelId = Get-AppUserModelIdFromAppDir -AppDir $codexAppDir

Write-Step "准备重启 Codex 桌面壳"
Write-Host "Codex App: $codexAppDir" -ForegroundColor DarkGray
Write-Host "AUMID: $appUserModelId" -ForegroundColor DarkGray
if ($RefusePlainCodex -and (Test-PlainCodexShellRunning)) {
  Write-Host '检测到普通 Codex 正在运行，已停止自动拉起。'
  exit 11
}
if (-not $KeepExistingCodex) {
  Stop-DesktopLiveHost
  Stop-CodexDesktopShell
} else {
  Write-Host "保留现有 Codex 进程；如果单实例拦截启动参数，CDP 可能不会出现。" -ForegroundColor Yellow
}

$selectedCdpPort = if ($KeepExistingCodex) { $CdpPort } else { Select-LoopbackPort -Requested $CdpPort }
Write-Host "CDP: http://127.0.0.1:$selectedCdpPort" -ForegroundColor DarkGray
Save-DesktopLiveStatus @{
  status = 'starting'
  cdpPort = $selectedCdpPort
  bridgeUrl = $BridgeUrl
  codexAppDir = $codexAppDir
  codexDesktopExe = $codexDesktopExe
  appUserModelId = $appUserModelId
}

Write-Step "用本项目启动器带 CDP 参数启动 Codex 桌面"
$arguments = @(
  "--remote-debugging-port=$selectedCdpPort",
  "--remote-allow-origins=http://127.0.0.1:$selectedCdpPort"
)
$argumentString = $arguments -join ' '
if ($KeepExistingCodex -and (Test-CdpReady -Port $selectedCdpPort)) {
  Write-Host "复用已存在的 Codex CDP 端口，不重复激活桌面壳。" -ForegroundColor DarkGray
} elseif ($KeepExistingCodex) {
  throw "保留现有 Codex 时 CDP 端口未在线: 127.0.0.1:$selectedCdpPort。为避免启动第二个 Codex 桌面壳或触发 Electron 协议弹窗，已停止注入。请手动重启带 CDP 的 Codex，或不使用 -KeepExistingCodex。"
} elseif ($UsePackagedActivation -and -not [string]::IsNullOrWhiteSpace($appUserModelId)) {
  $activatedProcessId = Start-PackagedCodex -AppUserModelId $appUserModelId -Arguments $argumentString
  Write-Host "已通过 Windows AppUserModelId 激活 Codex PID=$activatedProcessId" -ForegroundColor DarkGray
} else {
  if (-not (Test-Path -LiteralPath $codexDesktopExe)) {
    throw "Codex 桌面可执行文件不存在: $codexDesktopExe"
  }
  Start-Process -FilePath $codexDesktopExe -ArgumentList $arguments -WorkingDirectory $codexAppDir
  Write-Host "已直接启动 Codex Electron 桌面壳并保留 CDP 参数: $codexDesktopExe" -ForegroundColor DarkGray
}

Write-Step "等待 CDP 端口"
$targets = Wait-Cdp -Port $selectedCdpPort
$pages = @($targets | Where-Object { $_.type -eq 'page' })
Write-Host "CDP targets: $(@($targets).Count), pages: $($pages.Count)" -ForegroundColor DarkGray

Write-Step "启动桌面 CDP live host"
Stop-DesktopLiveHost
$hostStdout = Join-Path $repoRoot 'logs\startup\desktop-cdp-live-host.stdout.log'
$hostStderr = Join-Path $repoRoot 'logs\startup\desktop-cdp-live-host.stderr.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hostStdout) | Out-Null
$hostCommand = @"
`$env:CODEX_BRIDGE_URL='$BridgeUrl'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_DESKTOP_CDP_PORT='$selectedCdpPort'
node .\scripts\start-desktop-cdp-live-host.mjs
"@
Start-Process -WindowStyle Hidden -FilePath $powerShellHostPath -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command', $hostCommand
) -WorkingDirectory $repoRoot -RedirectStandardOutput $hostStdout -RedirectStandardError $hostStderr | Out-Null

Write-Step "验证桌面脚本桥状态"
$scriptStatus = Wait-DesktopScriptOnline -Url $BridgeUrl -Token $BridgeToken
$scriptStatus | ConvertTo-Json -Depth 8
Save-DesktopLiveStatus @{
  status = 'injected'
  cdpPort = $selectedCdpPort
  bridgeUrl = $BridgeUrl
  codexAppDir = $codexAppDir
  appUserModelId = $appUserModelId
  scriptStatus = $scriptStatus
}

if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
  Write-Step "验证目标会话 live 状态"
  $encodedSessionId = [System.Uri]::EscapeDataString($SessionId)
  $liveStatus = Invoke-BridgeJson -Url "$BridgeUrl/desktop/live/status?sessionId=$encodedSessionId" -Token $BridgeToken
  $liveStatus | ConvertTo-Json -Depth 8
}
} finally {
  if ($relaunchMutexOwned) {
    $relaunchMutex.ReleaseMutex() | Out-Null
    $relaunchMutex.Dispose()
  }
}
