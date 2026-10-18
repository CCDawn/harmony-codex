[CmdletBinding()]
param(
  [ValidateSet('Status','Maintain','Start','Repair','Stop','Pair','GuardianRepair','GuardianReloadWatchers')][string]$Action='Status',
  [ValidateRange(1,65535)][int]$BridgePort=8787,
  [switch]$RestartDesktop,
  [switch]$ScheduledRepairWorker,
  [switch]$GuardianRepair,
  [ValidateSet('reconnect','restart_services','restart_desktop')][string]$GuardianStage='reconnect',
  [string]$GuardianComponents=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Node emits UTF-8 and the tray reads UTF-8. A hidden Windows host otherwise
# defaults to the system code page and corrupts native JSON before parsing.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'mobile-link-lifecycle.ps1')
. (Join-Path $PSScriptRoot 'mobile-voice-tunnel.ps1')
$gate = New-MobileLinkMutex $repo
$owns = $false
$bridgeUrl='http://127.0.0.1:'+$BridgePort
$script:desktopRecovery = $null
function Get-LinkValue([object]$Object,[string]$Name,$Fallback=$null) {
  if ($null -eq $Object) { return $Fallback }
  $property=$Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
  $property.Value
}
function Get-LinkDiagnostics([bool]$Paused,[object]$VoiceTunnel) {
  try {
    $node=(Get-Command node -ErrorAction Stop).Source
    $diagnosticScript=Join-Path $repo 'tools\windows\mobile-link-diagnostics.mjs'
    $output=& $node $diagnosticScript --port $BridgePort --paused $Paused.ToString().ToLowerInvariant() --voice-state ([string]$VoiceTunnel.state) 2>$null
    $parsed=($output -join "`n") | ConvertFrom-Json
    if (-not (Get-LinkValue $parsed 'severity')) { throw 'Incomplete diagnostics' }
    return $parsed
  } catch {
    Write-LinkEvent ('diagnostics-failed type='+$_.Exception.GetType().Name+' line='+$_.InvocationInfo.ScriptLineNumber)
    return [pscustomobject]@{ severity=$(if($Paused){'stopped'}else{'unknown'}); summary=$(if($Paused){'链路已停止'}else{'业务检测未完成，不能确认通道状态'}); nextAction=$(if($Paused){'start'}else{'check_logs'}); checks=@(); restartRequired=$false }
  }
}
function Get-LinkHdcStatus {
  $hdc=''
  foreach($relative in @('tools\harmony\hdc-relay.local.psd1','tools\harmony\codex-remote.config.psd1')) {
    try {
      $config=Import-PowerShellDataFile -LiteralPath (Join-Path $repo $relative)
      if ($config.ContainsKey('HdcPath') -and (Test-Path -LiteralPath ([string]$config.HdcPath))) { $hdc=[string]$config.HdcPath; break }
    } catch { }
  }
  if (-not $hdc) { $command=Get-Command hdc -ErrorAction SilentlyContinue; if($command){$hdc=$command.Source} }
  $check=[pscustomobject]@{id='phone_debug';title='手机安装与调试';state='unknown';message='调试工具或配置不可用；此状态不代表手机会话是否在线'}
  if (-not $hdc) { return $check }
  $process=[Diagnostics.Process]::new()
  try {
    $process.StartInfo=[Diagnostics.ProcessStartInfo]::new($hdc,'list targets')
    $process.StartInfo.UseShellExecute=$false
    $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true
    $process.StartInfo.RedirectStandardError=$true
    [void]$process.Start()
    if (-not $process.WaitForExit(3000)) { $process.Kill(); return $check }
    $output=$process.StandardOutput.ReadToEnd()
    if($process.ExitCode -ne 0 -or $output -match '(?i)\[Fail\]|error|failed'){return $check}
    $targets=@($output -split '\r?\n' | Where-Object { $_.Trim() -and $_ -notmatch '\[Empty\]' })
    $check.state=if($targets.Count -gt 0){'ready'}else{'waiting'}
    $check.message=if($targets.Count -gt 0){'发现在线调试设备；安装结果仍需单独验证'}else{'未发现在线调试设备，暂不能安装；不代表手机会话离线'}
    return $check
  } catch { return $check }
  finally { $process.Dispose() }
}
function Invoke-DesktopSafeRecovery {
  if ((Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) -and -not (Test-GuardianRepairAllowed)) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
  $response=Get-LinkApi '/desktop/live/status'
  $desktop=Get-LinkValue $response 'desktop'
  if ([bool](Get-LinkValue $desktop 'desktopLive' $false)) {
    return [pscustomobject]@{state='not-needed';message='桌面连接已经在线，无需恢复'}
  }
  $mode=[string](Get-LinkValue $desktop 'desktopProcessMode' '')
  $port=[int](Get-LinkValue $desktop 'cdpPort' 0)
  if ($mode -eq 'missing') {
    return Start-MissingDesktop
  }
  if ($null -eq $desktop -or $mode -eq 'plain' -or ($port -le 0 -and $mode -ne 'remote_debug')) {
    return [pscustomobject]@{state='blocked';message='当前没有可用的桌面远程连接端口；已保留运行中的 Codex，重启需要另行确认'}
  }
  try {
    $result=Invoke-RestMethod -Uri ($bridgeUrl+'/desktop/live/recover') -Method Post -ContentType 'application/json' -Body '{"mode":"soft"}' -Headers (Get-LinkHeaders) -TimeoutSec 20
    $updated=Get-LinkValue $result 'desktop'
    if ([bool](Get-LinkValue $updated 'desktopLive' $false)) {
      return [pscustomobject]@{state='recovered';message='桌面实时连接已恢复，未重启 Codex'}
    }
    return [pscustomobject]@{state='unconfirmed';message='已尝试安全恢复，桌面实时连接尚未确认；请查看各通道状态'}
  } catch {
    return [pscustomobject]@{state='failed';message='桌面安全恢复未完成；已保留 Codex，请查看日志'}
  }
}
function Get-DesktopLauncherArguments {
  param([string[]]$Arguments)
  if (Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) {
    # Carry the persisted intent through the detached launcher's slow discovery.
    # Hashes also cancel an older request after Stop/Start or Disable/Enable.
    $configPath=Join-Path $repo 'logs\state\mobile-link-guardian-config.json'
    $controlPath=Get-MobileLinkStatePath $repo
    $configVersion=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    $controlVersion=if (Test-Path -LiteralPath $controlPath) { (Get-FileHash -LiteralPath $controlPath -Algorithm SHA256).Hash } else { 'missing' }
    $Arguments+=@('-GuardianRepair','-GuardianConfigVersion',$configVersion,'-GuardianControlVersion',$controlVersion)
  }
  $Arguments
}
function Invoke-DesktopRepair {
  $safe=Invoke-DesktopSafeRecovery
  if ($safe.state -in @('not-needed','recovered','pending')) { return $safe }
  if ((Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) -and -not (Test-GuardianRepairAllowed)) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
  Write-LinkEvent 'desktop-restart-requested'
  $arguments=@('-BridgeUrl',$bridgeUrl)
  if (Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) { $arguments=Get-DesktopLauncherArguments $arguments }
  $launcher=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\restart-codex-desktop-live.ps1') -Arguments $arguments -LogPath (Join-Path $repo 'logs\startup\desktop-repair.log') -WorkingDirectory $repo
  try {
    if (-not $launcher.WaitForExit(120000) -or $launcher.ExitCode -eq 10) {
      return [pscustomobject]@{state='pending';message='桌面重启恢复仍在进行，请稍后刷新状态，无需重复操作'}
    }
    if ($launcher.ExitCode -eq 12) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
    $updated=Get-LinkValue (Get-LinkApi '/desktop/live/status') 'desktop'
    if ($launcher.ExitCode -eq 0 -and [bool](Get-LinkValue $updated 'desktopLive' $false)) {
      return [pscustomobject]@{state='restarted';message='已重启 Codex 并重新连接桌面接口，正在验证会话读取'}
    }
    return [pscustomobject]@{state='failed';message='已执行桌面恢复，但连接验证未通过，请查看 desktop-repair.log'}
  } finally { $launcher.Dispose() }
}
function Start-MissingDesktop {
  if ((Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) -and -not (Test-GuardianRepairAllowed)) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
  # StartOnly refuses an existing desktop and never stops its processes, even
  # if the status snapshot became stale while the launcher was starting.
  $arguments=@('-BridgeUrl',$bridgeUrl,'-StartOnly','-RefusePlainCodex')
  if (Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) { $arguments=Get-DesktopLauncherArguments $arguments }
  $launcher=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\restart-codex-desktop-live.ps1') -Arguments $arguments -LogPath (Join-Path $repo 'logs\startup\desktop-start.log') -WorkingDirectory $repo
  try {
    if (-not $launcher.WaitForExit(90000)) {
      return [pscustomobject]@{state='pending';message='Codex 桌面仍在启动，请稍后查看状态；无需重复点击启动'}
    }
    if ($launcher.ExitCode -eq 10) {
      return [pscustomobject]@{state='pending';message='已有 Codex 启动操作正在进行，请稍后查看状态'}
    }
    if ($launcher.ExitCode -eq 12) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
    $updated=Get-LinkValue (Get-LinkApi '/desktop/live/status') 'desktop'
    if ([bool](Get-LinkValue $updated 'desktopLive' $false)) {
      return [pscustomobject]@{state='recovered';message='已启动 Codex 并连接桌面通道'}
    }
    if ($launcher.ExitCode -eq 11) {
      return [pscustomobject]@{state='blocked';message='检测到 Codex 已在运行，已保留现有工作；请查看桌面连接状态'}
    }
    return [pscustomobject]@{state='failed';message='Codex 桌面启动后尚未连接，请查看 desktop-start.log'}
  } finally { $launcher.Dispose() }
}
function Get-LinkStartupOutcome([object]$Status,[bool]$RequireAssistant=$false) {
  $checks=@($Status.diagnostics.checks)
  $required=@('bridge','desktop','sessions')
  $ready=@($checks | Where-Object { $_.id -in $required -and $_.state -eq 'ready' }).Count -eq $required.Count
  $recoveryState=[string](Get-LinkValue $script:desktopRecovery 'state' '')
  if (($recoveryState -eq 'restarted' -or $RequireAssistant) -and $ready -and -not @($checks | Where-Object { $_.id -eq 'companion' -and $_.state -eq 'ready' }).Count) {
    return [pscustomobject]@{state='partial';exitCode=2;message='桌面已重连，但个人助手会话读取尚未通过，请查看检测结果'}
  }
  if ($ready) {
    if (@($checks | Where-Object { $_.id -eq 'voice' -and $_.state -eq 'error' }).Count) {
      return [pscustomobject]@{state='partial';exitCode=2;message='桌面连接与会话读取已就绪，但语音隧道异常；请查看语音检测结果'}
    }
    return [pscustomobject]@{state='ready';exitCode=0;message='桌面连接与会话读取已就绪；通话状态请查看单独检测结果'}
  }
  if ($recoveryState -eq 'pending') {
    return [pscustomobject]@{state='pending';exitCode=2;message=$script:desktopRecovery.message}
  }
  if ($recoveryState -eq 'failed') {
    return [pscustomobject]@{state='failed';exitCode=2;message=$script:desktopRecovery.message}
  }
  if ($recoveryState -eq 'blocked' -or @($checks | Where-Object { $_.id -eq 'desktop' -and $_.state -eq 'blocked' }).Count) {
    return [pscustomobject]@{state='blocked';exitCode=2;message='桌面连接未就绪，已保留正在运行的 Codex；重复启动不能解决，请先查看桌面恢复提示'}
  }
  return [pscustomobject]@{state='failed';exitCode=2;message='启动尚未完成：桌面连接或会话读取未通过，请查看各通道状态'}
}
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
  $ownedIds = @($owned | ForEach-Object { [int]$_.ProcessId })
  $ports = @(foreach ($port in @($BridgePort,8790,9229,11078)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    foreach ($listener in ($listeners | Sort-Object OwningProcess -Unique)) {
      # Windows can retain a listener record after its owning process has exited.
      if (-not (Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction SilentlyContinue)) { continue }
      [pscustomobject]@{ port=$port; pid=[int]$listener.OwningProcess; ownership=$(if ($ownedIds -contains $listener.OwningProcess) {'managed'} else {'external'}) }
    }
  })
  $mode = 'unknown'
  if ($health -and $health.runtime) { $mode=[string]$health.runtime.mode }
  $live = $false
  $paused=Test-MobileLinkPaused $repo
  $voiceTunnel=Get-MobileVoiceTunnelStatus $repo
  $diagnostics=Get-LinkDiagnostics $paused $voiceTunnel
  # Use the same probe as the detailed checks, not an earlier desktop snapshot.
  $live=@($diagnostics.checks | Where-Object { $_.id -eq 'desktop' -and $_.state -eq 'ready' }).Count -gt 0
  # HDC is an optional installation channel, never a prerequisite for normal mobile conversation.
  $diagnostics.checks=@($diagnostics.checks) + @(Get-LinkHdcStatus)
  $state = [pscustomobject]@{
    version=2; checkedAt=[datetime]::UtcNow.ToString('o'); paused=$paused
    bridgeHealthy=($null -ne $health -and [bool]$health.ok); runtimeMode=$mode; desktopLive=$live
    services=$services; ports=$ports; voiceTunnel=$voiceTunnel; diagnostics=$diagnostics; desktopRecovery=$script:desktopRecovery; config='BridgeConfig.ets + hdc-relay.local.psd1 + voice-tunnel.local.psd1'
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
  # Guardian follows persisted intent; it must never turn a concurrent manual
  # Stop back into running after the ownership/health probes have completed.
  if ($GuardianRepair) {
    if (-not (Test-GuardianRepairAllowed)) { return }
  } else { Set-MobileLinkDesiredState -Repo $repo -State running }
  Set-LinkEnvironment
  Write-LinkEvent 'starting-stack-with-desktop-protected'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs\startup') | Out-Null
  # Bootstrap bridge separately; only explicit Repair -RestartDesktop may restart the official desktop.
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { return }
  $startup=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments @('-BridgePort',"$BridgePort",'-SkipCodexDesktop','-KeepExistingCodex') -LogPath (Join-Path $repo 'logs\startup\manager-start.log') -WorkingDirectory $repo
  try { if($GuardianRepair){if(-not $startup.WaitForExit(90000)){throw 'Guardian bootstrap timeout'}}else{$startup.WaitForExit()}; Write-LinkEvent ('startup-exit='+$startup.ExitCode); if ($startup.ExitCode -notin @(0,2)) { throw '链路启动脚本未成功完成，请查看启动日志。' } }
  finally { $startup.Dispose() }
  Write-LinkEvent 'startup-returned'
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { return }
  # Exit 2 means dependencies are not ready yet, not a fatal bootstrap error.
  # Resolve the desktop dependency synchronously before collecting final status.
  $script:desktopRecovery=if ($Action -eq 'Repair' -and $RestartDesktop) { Invoke-DesktopRepair } else { Invoke-DesktopSafeRecovery }
  Ensure-LinkMonitors
}
function Ensure-LinkMonitors {
  param([switch]$SkipServiceRecovery)
  if (Test-MobileLinkPaused $repo) { return }
  try { if (-not $SkipServiceRecovery -and -not (Test-MobileLinkGuardianEnabled $repo)) { Ensure-MobileVoiceTunnel $repo } }
  catch { Write-LinkEvent 'voice-tunnel-recovery-failed; collecting structured diagnostics' }
  $owned=@(Get-MobileLinkOwnedProcesses -Repo $repo -Processes @(Get-CimInstance Win32_Process))
  $relayConfig=Join-Path $repo 'tools\harmony\hdc-relay.local.psd1'
  foreach($role in @('watch-local-bridge','watch-desktop-live','watch-bridge-proxy','watch-hdc-connection','watch-voice-tunnel')) {
    if ($role -eq 'watch-voice-tunnel' -and $null -eq (Get-MobileVoiceTunnelConfig $repo)) { continue }
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
function Test-GuardianRepairAllowed {
  if (Test-MobileLinkPaused $repo) { return $false }
  $path=Join-Path $repo 'logs\state\mobile-link-guardian-config.json'
  try {
    $config=Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    return $config.enabled -eq $true -and (-not $RestartDesktop -or $config.allowForceRestart -eq $true)
  } catch { return $false }
}
function Invoke-GuardianScopedRepair {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs\startup') | Out-Null
  $components=@($GuardianComponents -split ',' | Where-Object { $_ -in @('bridge','desktop','sessions','companion','public','voice') })
  if (-not (Test-GuardianRepairAllowed)) { return }
  if ($GuardianStage -eq 'restart_services') {
    if ('bridge' -in $components) {
      # Refuse external listeners before invoking the established bootstrap.
      $owned=@(Get-MobileLinkOwnedProcesses -Repo $repo -Processes @(Get-CimInstance Win32_Process))
      $ids=@($owned | ForEach-Object { [int]$_.ProcessId })
      if (@(Get-NetTCPConnection -State Listen -LocalPort $BridgePort -ErrorAction SilentlyContinue | Where-Object { [int]$_.OwningProcess -notin $ids }).Count) { throw 'External bridge listener' }
      if (-not (Test-GuardianRepairAllowed)) { return }
      Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('bridge','bridge-host') | Out-Null
      if (-not (Test-GuardianRepairAllowed)) { return }
      Set-LinkEnvironment
      $startup=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments @('-BridgePort',"$BridgePort",'-SkipCodexDesktop','-KeepExistingCodex','-SkipHdcRelay') -LogPath (Join-Path $repo 'logs\startup\guardian-bridge-repair.log') -WorkingDirectory $repo
      try { if (-not $startup.WaitForExit(90000) -or $startup.ExitCode -notin @(0,2)) { throw 'Bridge bootstrap failed or timed out' } } finally { $startup.Dispose() }
    }
    if ('public' -in $components -and (Test-GuardianRepairAllowed)) {
      Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('public-proxy') | Out-Null
      if (-not (Test-GuardianRepairAllowed)) { return }
      $proxy=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'tools\harmony\start-hdc-relay.ps1') -Arguments @('-Mode','BridgeProxy') -LogPath (Join-Path $repo 'logs\startup\guardian-public-repair.log') -WorkingDirectory $repo
      $proxy.Dispose()
    }
    if ('voice' -in $components -and (Test-GuardianRepairAllowed)) {
      # The bridge supervisor recreates only its managed voice child on exit;
      # a local media-service fault must not be mistaken for just an SSH fault.
      Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('voice') | Out-Null
      Stop-MobileVoiceTunnel $repo
      if (Test-GuardianRepairAllowed) { Ensure-MobileVoiceTunnel $repo }
    }
  }
  if (@($components | Where-Object { $_ -in @('desktop','sessions','companion') }).Count -and (Test-GuardianRepairAllowed)) {
    $script:desktopRecovery=Invoke-DesktopSafeRecovery
  }
}
try {
  # Persist manual intent before waiting for any in-flight repair. Its next
  # irreversible boundary will observe the stop even while holding the gate.
  if ($Action -eq 'Stop') { Set-MobileLinkDesiredState -Repo $repo -State stopped }
  if ($Action -eq 'GuardianRepair') {
    $GuardianRepair=$true
    if ($GuardianStage -eq 'restart_desktop') { $Action='Repair'; $RestartDesktop=$true }
  }
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { @{skipped=$true;reason='guardian_disabled_or_paused'} | ConvertTo-Json -Compress; return }
  if ($Action -eq 'Repair' -and $RestartDesktop -and -not $ScheduledRepairWorker) {
    . (Join-Path $PSScriptRoot 'mobile-link-repair-task.ps1')
    $operation=Start-MobileLinkRepairTask -Repo $repo -BridgePort $BridgePort -GuardianRepair:$GuardianRepair
    $deadline=[datetime]::UtcNow.AddSeconds(240)
    do {
      if (Test-Path -LiteralPath $operation.resultPath) {
        try { $completion=Get-Content -LiteralPath $operation.resultPath -Raw | ConvertFrom-Json } catch { $completion=$null }
        if ($completion -and $completion.runId -eq $operation.runId) {
          $completion.result | ConvertTo-Json -Depth 8 -Compress
          exit ([int]$completion.exitCode)
        }
      }
      Start-Sleep -Seconds 1
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Independent repair is still running; inspect desktop-repair-worker.json.'
  }
  if ($Action -ne 'Status') {
    $waitMs=15000
    if ($Action -eq 'Maintain') { $waitMs=0 }
    try { $owns=$gate.WaitOne($waitMs) } catch [Threading.AbandonedMutexException] { $owns=$true }
    if (-not $owns -and $Action -eq 'Maintain') { Get-LinkStatus | ConvertTo-Json -Depth 6 -Compress; return }
    if (-not $owns) { throw '另一项链路管理操作正在进行，请稍后重试。' }
  }
  # The user may have disabled guardian or stopped the link while this operation
  # was queued behind another controller or the independent repair task.
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { @{skipped=$true;reason='guardian_disabled_or_paused'} | ConvertTo-Json -Compress; return }
  switch ($Action) {
    'GuardianReloadWatchers' {
      # Old PowerShell watchers retain dot-sourced functions in memory. Replace
      # only owned monitors while holding their shared cycle gate; all bridge,
      # proxy, media and desktop processes remain alive during this handoff.
      $stopped=Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('watch-local-bridge','watch-desktop-live','watch-bridge-proxy','watch-hdc-connection','watch-voice-tunnel')
      if ($stopped.remaining.Count) { throw 'Watchdog handoff incomplete' }
      Ensure-LinkMonitors -SkipServiceRecovery
      $marker=Join-Path $repo 'logs\state\mobile-link-guardian-watchers.json'
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
      @{version=1;lifecycleSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'mobile-link-lifecycle.ps1')).Hash;updatedAt=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8
      @{reloaded=$true} | ConvertTo-Json -Compress; return
    }
    'GuardianRepair' { Invoke-GuardianScopedRepair; @{accepted=$true;stage=$GuardianStage} | ConvertTo-Json -Compress; return }
    'Maintain' { Ensure-LinkMonitors }
    'Start' { Start-Link }
    'Repair' { Start-Link }
    'Stop' {
      Set-MobileLinkDesiredState -Repo $repo -State stopped
      Stop-MobileVoiceTunnel $repo
      Remove-Item -LiteralPath (Join-Path $repo 'logs\state\desktop-supervisor.json') -ErrorAction SilentlyContinue
      $result=Stop-MobileLinkOwnedProcesses -Repo $repo
      if ($result.remaining.Count -gt 0) { throw '部分服务未停止，请查看状态。' }
    }
    'Pair' {
      Set-LinkEnvironment
      $pairBody=@{publicUrl=$env:CODEX_BRIDGE_PUBLIC_URL} | ConvertTo-Json -Compress
      $pair=Invoke-RestMethod -Uri ($bridgeUrl+'/desktop/pair/create') -Method Post -ContentType 'application/json' -Body $pairBody -Headers (Get-LinkHeaders) -TimeoutSec 5
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
  $status=Get-LinkStatus
  # A freshly opened desktop may still be loading the assistant module. Retry
  # readback only; never repeat the restart just because the first read timed out.
  if ($Action -eq 'Repair' -and $RestartDesktop) {
    for ($attempt=0; $attempt -lt 2 -and $status.desktopLive; $attempt++) {
      $verified=@($status.diagnostics.checks | Where-Object { $_.id -in @('sessions','companion') -and $_.state -eq 'ready' }).Count -eq 2
      if ($verified) { break }
      Write-LinkEvent 'waiting-for-conversation-readback'
      Start-Sleep -Seconds 2
      $status=Get-LinkStatus
    }
  }
  $resultCode=0
  if ($Action -in @('Start','Repair')) {
    $outcome=Get-LinkStartupOutcome $status -RequireAssistant ($Action -eq 'Repair' -and $RestartDesktop)
    $status | Add-Member -NotePropertyName startupOutcome -NotePropertyValue $outcome
    $resultCode=$outcome.exitCode
    Write-LinkEvent ('startup-outcome='+$outcome.state)
    $status | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $repo 'logs\state\mobile-link-status.json') -Encoding utf8
  }
  $status | ConvertTo-Json -Depth 6 -Compress
  Write-LinkEvent 'completed'
  if ($resultCode -ne 0) { exit $resultCode }
} catch {
  Write-LinkEvent ('failed type='+$_.Exception.GetType().Name+' line='+$_.InvocationInfo.ScriptLineNumber)
  # Avoid writing exception details which can contain authenticated URLs or response data.
  [pscustomobject]@{ error='链路操作未完成：端口、模式、配置或操作互斥检查未通过。请打开日志目录检查。'; action=$Action } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($owns) { $gate.ReleaseMutex() }
  $gate.Dispose()
}
