# Codex 远程链路一键启动器（桌面快捷方式入口）
# 运行宿主：pwsh 7+（本文件与仓库脚本均含中文，Windows PowerShell 5.1 无法解析）。
# 凭据只从 BridgeConfig.ets 读取，经环境变量传给栈脚本，绝不打印。
param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
# Normal launches use the one management application. The legacy hard-restart path
# remains explicit for compatibility, but is no longer a separate desktop shortcut.
$unifiedTray = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\CodexMobileRemoteTray-unified-v1.exe'
if (-not $ForceRestart -and (Test-Path -LiteralPath $unifiedTray)) {
  Start-Process -FilePath $unifiedTray -WindowStyle Hidden
  exit 0
}
$repo = Split-Path -Parent $PSScriptRoot  # 本文件位于 <repo>\tools
$bridgeUrl = 'http://127.0.0.1:8787'

function Update-DesktopShortcuts {
  $hostPath = (Get-Process -Id $PID).Path
  if (-not $hostPath -or -not (Test-Path -LiteralPath $hostPath)) { return }
  $desktop = [Environment]::GetFolderPath('Desktop')
  $launcher = Join-Path $repo 'tools\launch-codex-remote.ps1'
  $pairs = @(
    @{ Name = 'Codex 手机链路.lnk'; Force = $false },
    @{ Name = '强制重建 Codex 远程链路.lnk'; Force = $true }
  )
  $stale = @('启动 Codex 远程链路.lnk')
  foreach ($name in $stale) {
    $old = Join-Path $desktop $name
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
  }
  $trayExe = Join-Path $repo 'bin\CodexMobileRemoteTray-icon-v1.exe'
  if (-not (Test-Path -LiteralPath $trayExe)) {
    $trayExe = Join-Path $repo 'bin\CodexMobileRemoteTray.exe'
  }
  $ws = New-Object -ComObject WScript.Shell
  foreach ($pair in $pairs) {
    $lnk = Join-Path $desktop $pair.Name
    $sc = $ws.CreateShortcut($lnk)
    if (-not $pair.Force -and (Test-Path -LiteralPath $trayExe)) {
      $sc.TargetPath = $trayExe
      $sc.Arguments = ''
      $sc.WorkingDirectory = $repo
      $sc.WindowStyle = 1
      $sc.IconLocation = "$trayExe,0"
    } else {
      $sc.TargetPath = $hostPath
      $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" + $(if ($pair.Force) { ' -ForceRestart' } else { '' })
      $sc.WorkingDirectory = $repo
      $sc.WindowStyle = 1
      $sc.IconLocation = "$hostPath,0"
    }
    $sc.Save()
  }
}

Update-DesktopShortcuts

$cfg = Get-Content (Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets') -Raw
$token = [regex]::Match($cfg, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']+)'").Groups[1].Value
$secret = [regex]::Match($cfg, "DEFAULT_BRIDGE_TOTP_SECRET:\s*string\s*=\s*'([^']+)'").Groups[1].Value
$publicUrl = [regex]::Match($cfg, "DEFAULT_BRIDGE_URL:\s*string\s*=\s*'([^']+)'").Groups[1].Value
if (-not ($token -and $secret -and $publicUrl)) { throw 'BridgeConfig.ets 中缺少凭据常量' }
$env:CODEX_BRIDGE_TOKEN = $token
$env:CODEX_BRIDGE_TOTP_SECRET = $secret
$env:CODEX_BRIDGE_PUBLIC_URL = $publicUrl

function Get-BridgeJson([string]$Path) {
  try { return Invoke-RestMethod -Uri ($bridgeUrl + $Path) -Headers @{ 'X-Codex-Bridge-Token' = $token } -TimeoutSec 6 }
  catch { return $null }
}

function Wait-UserClose {
  if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Read-Host '按回车关闭'
  }
}

Write-Host '=== Codex 远程链路一键启动 ==='

if (-not $ForceRestart) {
  $health = Get-BridgeJson '/health'
  $live = $null
  if ($health) { $live = Get-BridgeJson '/desktop/live/status' }
  $relayListening = $false
  try { $relayListening = [bool](Get-NetTCPConnection -State Listen -LocalPort 11078 -ErrorAction SilentlyContinue) } catch {}

  $desktopOk = ($live -and $live.desktop -and $live.desktop.desktopLive -eq $true -and $live.desktop.status -eq 'ready')
  if ($health -and $health.ok -and $desktopOk -and $relayListening) {
    Write-Host ''
    Write-Host '全链路正常，无需干预：' -ForegroundColor Green
    Write-Host ('  桥接服务  : ok（' + $bridgeUrl + '）')
    Write-Host ('  桌面通道  : ready（CDP ' + $live.desktop.cdpPort + '）')
    Write-Host '  手机中继  : 监听中（127.0.0.1:11078）'
    Write-Host ''
    Write-Host '若链路异常需要完全重建，请用桌面上的「强制重建 Codex 远程链路」。'
    Wait-UserClose
    exit 0
  }
  $gaps = @()
  if (-not ($health -and $health.ok)) { $gaps += '桥接' }
  if (-not $desktopOk) { $gaps += '桌面实时通道' }
  if (-not $relayListening) { $gaps += '手机中继' }
  Write-Host ('检测到缺口: ' + ($gaps -join '、') + '，交给栈脚本补齐（默认不重启健康组件）...')
} else {
  Write-Host '已指定强制重建：桥接将重启，手机会短暂重连，正在运行的任务会被保护性检查。' -ForegroundColor Yellow
}

try {
  $stackArgs = @{}
  if ($ForceRestart) { $stackArgs['ForceRestart'] = $true }
  & (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') @stackArgs
  Write-Host ''
  Write-Host '链路补齐完成。' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host ('启动失败: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ('日志目录: ' + (Join-Path $repo 'logs\startup'))
}
Wait-UserClose
