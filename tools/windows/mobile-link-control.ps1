[CmdletBinding()]
param(
  [ValidateSet('Status','Maintain','Start','Repair','Stop','Pair')][string]$Action='Status',
  [ValidateRange(1,65535)][int]$BridgePort=8787
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'mobile-link-lifecycle.ps1')
$gate = New-MobileLinkMutex $repo
$owns = $false
$bridgeUrl='http://127.0.0.1:'+$BridgePort
function Write-LinkEvent([string]$Event) {
  try {
    $dir=Join-Path $repo 'logs\startup'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'manager.events.log') -Value ([datetime]::UtcNow.ToString('o')+' '+$Action+' '+$Event) -Encoding utf8
  } catch { }
}
function Get-LinkHeaders {
  $path = Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
  $headers = @{}
  if (Test-Path -LiteralPath $path) {
    $config = Get-Content -Raw -LiteralPath $path
    $token = [regex]::Match($config, 'DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*[''"]([^''"]+)[''"]').Groups[1].Value
    if ($token) { $headers['X-Codex-Bridge-Token']=$token }
  }
  $headers
}
function Set-LinkEnvironment {
  $path=Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
  if (-not (Test-Path -LiteralPath $path)) { throw '缺少本地桥接配置。' }
  $config=Get-Content -Raw -LiteralPath $path
  foreach($entry in @(@('DEFAULT_BRIDGE_TOKEN','CODEX_BRIDGE_TOKEN'),@('DEFAULT_BRIDGE_TOTP_SECRET','CODEX_BRIDGE_TOTP_SECRET'),@('DEFAULT_BRIDGE_URL','CODEX_BRIDGE_PUBLIC_URL'))) {
    $value=[regex]::Match($config, ($entry[0]+':\s*string\s*=\s*[''"]([^''"]*)[''"]')).Groups[1].Value
    [Environment]::SetEnvironmentVariable($entry[1], $value, 'Process')
  }
}
function Get-LinkApi([string]$Path) {
  try { Invoke-RestMethod -Uri ($bridgeUrl+$Path) -Headers (Get-LinkHeaders) -TimeoutSec 3 }
  catch { $null }
}
function Get-LinkStatus {
  $all = @(Get-CimInstance Win32_Process)
  $owned = @(Get-MobileLinkOwnedProcesses -Repo $repo -Processes $all)
  $services = @($owned | ForEach-Object {
    [pscustomobject]@{ role=(Get-MobileLinkRole $_); pid=[int]$_.ProcessId; createdAt=([datetime]$_.CreationDate).ToUniversalTime().ToString('o'); ownership='managed' }
  })
  $health = Get-LinkApi '/health'
  $desktop = Get-LinkApi '/desktop/live/status'
  $ownedIds = @($owned | ForEach-Object { [int]$_.ProcessId })
  $ports = @(foreach ($port in @($BridgePort,8790,9229,11078)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    foreach ($listener in ($listeners | Sort-Object OwningProcess -Unique)) {
      [pscustomobject]@{ port=$port; pid=[int]$listener.OwningProcess; ownership=$(if ($ownedIds -contains $listener.OwningProcess) {'managed'} else {'external'}) }
    }
  })
  $mode = 'unknown'
  if ($health -and $health.runtime) { $mode=[string]$health.runtime.mode }
  $live = $false
  if ($desktop -and $desktop.desktop) { $live=[bool]$desktop.desktop.desktopLive }
  $state = [pscustomobject]@{
    version=1; checkedAt=[datetime]::UtcNow.ToString('o'); paused=(Test-MobileLinkPaused $repo)
    bridgeHealthy=($null -ne $health -and [bool]$health.ok); runtimeMode=$mode; desktopLive=$live
    services=$services; ports=$ports; config='BridgeConfig.ets + hdc-relay.local.psd1'
    logDirectory=(Join-Path $repo 'logs'); officialCodex='external-host'
  }
  $dir=Join-Path $repo 'logs\state'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $dir 'mobile-link-status.json') -Encoding utf8
  $state
}
function Start-Link {
  Write-LinkEvent 'checking-start-ownership'
  # Refuse a runtime conversion or an unknown port owner instead of silently stopping it.
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $BridgePort -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $owned=@(Get-MobileLinkOwnedProcesses -Repo $repo -Processes @(Get-CimInstance Win32_Process))
    $ids=@($owned | ForEach-Object { [int]$_.ProcessId })
    if (@($listeners | Where-Object { [int]$_.OwningProcess -notin $ids }).Count -gt 0) {
      throw '桥接端口由外部服务持有，保留现有服务。'
    }
    $health=Get-LinkApi '/health'
    if (-not $health -or -not $health.ok -or $health.runtime.mode -ne 'desktop') {
      throw '8787 已被占用或桥接模式不同；安全修复保留现场，请查看日志。'
    }
  }
  Set-MobileLinkDesiredState -Repo $repo -State running
  Set-LinkEnvironment
  Write-LinkEvent 'starting-stack-with-desktop-protected'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs\startup') | Out-Null
  # Skip desktop lifecycle entirely: official host is never restarted by this controller.
  $startup=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments @('-BridgePort',"$BridgePort",'-SkipCodexDesktop','-KeepExistingCodex') -LogPath (Join-Path $repo 'logs\startup\manager-start.log') -WorkingDirectory $repo
  try { $startup.WaitForExit(); Write-LinkEvent ('startup-exit='+$startup.ExitCode); if ($startup.ExitCode -ne 0) { throw '链路启动脚本未成功完成，请查看启动日志。' } }
  finally { $startup.Dispose() }
  Write-LinkEvent 'startup-returned'
  Ensure-LinkMonitors
}
function Ensure-LinkMonitors {
  if (Test-MobileLinkPaused $repo) { return }
  $owned=@(Get-MobileLinkOwnedProcesses -Repo $repo -Processes @(Get-CimInstance Win32_Process))
  $relayConfig=Join-Path $repo 'tools\harmony\hdc-relay.local.psd1'
  foreach($role in @('watch-local-bridge','watch-desktop-live','watch-bridge-proxy','watch-hdc-connection')) {
    if ($owned | Where-Object { (Get-MobileLinkRole $_) -eq $role }) { continue }
    $watch=Join-Path $repo ('tools\harmony\'+$role+'.ps1')
    if (-not (Test-Path -LiteralPath $watch)) { continue }
    $arguments=@()
    if ($role -in @('watch-local-bridge','watch-desktop-live')) { $arguments+=@('-BridgePort',"$BridgePort") }
    if ($role -eq 'watch-local-bridge') { $arguments+=@('-RuntimeMode','desktop') }
    if ($role -in @('watch-bridge-proxy','watch-hdc-connection')) {
      if (-not (Test-Path -LiteralPath $relayConfig)) { continue }
      $arguments+=@('-ConfigPath',$relayConfig)
    }
    $logs=Join-Path $repo 'logs\startup'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $monitor=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath $watch -Arguments $arguments -LogPath (Join-Path $logs ($role+'.log')) -WorkingDirectory $repo
    $monitor.Dispose()
  }
}
try {
  if ($Action -ne 'Status') {
    $waitMs=15000
    if ($Action -eq 'Maintain') { $waitMs=0 }
    try { $owns=$gate.WaitOne($waitMs) } catch [Threading.AbandonedMutexException] { $owns=$true }
    if (-not $owns -and $Action -eq 'Maintain') { Get-LinkStatus | ConvertTo-Json -Depth 6 -Compress; return }
    if (-not $owns) { throw '另一项链路管理操作正在进行，请稍后重试。' }
  }
  switch ($Action) {
    'Maintain' { Ensure-LinkMonitors }
    'Start' { Start-Link }
    'Repair' { Start-Link }
    'Stop' {
      Set-MobileLinkDesiredState -Repo $repo -State stopped
      Remove-Item -LiteralPath (Join-Path $repo 'logs\state\desktop-supervisor.json') -ErrorAction SilentlyContinue
      $result=Stop-MobileLinkOwnedProcesses -Repo $repo
      if ($result.remaining.Count -gt 0) { throw '部分服务未停止，请查看状态。' }
    }
    'Pair' {
      $pair=Invoke-RestMethod -Uri ($bridgeUrl+'/desktop/pair/create') -Method Post -ContentType 'application/json' -Body '{}' -Headers (Get-LinkHeaders) -TimeoutSec 5
      # Only an expiring enrollment code goes into the display file, never the master token.
      $path=Join-Path $repo 'logs\state\mobile-link-pair.html'
      $code=[Net.WebUtility]::HtmlEncode([string]$pair.pairingCode)
      $expiry=[Net.WebUtility]::HtmlEncode([string]$pair.expiresAt)
      $html='<!doctype html><meta charset="utf-8"><title>Codex 手机链路 · 配对</title><body style="font-family:Segoe UI,sans-serif;text-align:center;padding:40px;background:#f4f7fb;color:#16304e"><h1>手机配对</h1><p>在 Codex Remote 中扫描二维码，或输入下方配对码。</p><div style="width:300px;margin:24px auto">'+$pair.qrSvg+'</div><h2>'+$code+'</h2><p>配对码五分钟内有效，每次打开都会重新生成。</p><p>已配对的手机无需重新配对。</p><small>到期时间：'+$expiry+'</small></body>'
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
      Set-Content -LiteralPath $path -Value $html -Encoding utf8
      [pscustomobject]@{ pairingFile=$path } | ConvertTo-Json -Compress
      return
    }
  }
  Write-LinkEvent 'collecting-status'
  Get-LinkStatus | ConvertTo-Json -Depth 6 -Compress
  Write-LinkEvent 'completed'
} catch {
  Write-LinkEvent ('failed type='+$_.Exception.GetType().Name+' line='+$_.InvocationInfo.ScriptLineNumber)
  # Avoid writing exception details which can contain authenticated URLs or response data.
  [pscustomobject]@{ error='链路操作未完成：端口、模式、配置或操作互斥检查未通过。请打开日志目录检查。'; action=$Action } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($owns) { $gate.ReleaseMutex() }
  $gate.Dispose()
}
