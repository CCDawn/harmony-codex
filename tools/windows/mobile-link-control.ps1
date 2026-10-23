[CmdletBinding()]
param(
  [ValidateSet('Status','Maintain','Start','Repair','Stop','Pair','GuardianRepair','GuardianReloadWatchers')][string]$Action='Status',
  [ValidateRange(1,65535)][int]$BridgePort=8787,
  [switch]$RestartDesktop,
  [switch]$ScheduledRepairWorker,
  [ValidatePattern('^$|^[a-f0-9]{32}$')][string]$OperationId='',
  [switch]$GuardianRepair,
  [ValidateSet('reconnect','restart_services','restart_desktop')][string]$GuardianStage='reconnect',
  [string]$GuardianComponents='',
  [string]$StandbyFile=''
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
$script:linkOperationId=''
$script:fastStartStatus=$null
$script:fastStartOutcome=$null
$script:linkTotpKey=$null
$operationScript=Join-Path $PSScriptRoot 'mobile-link-operation.ps1'
if (Test-Path -LiteralPath $operationScript) { . $operationScript }
function Set-LinkOperationPhase([string]$Phase) {
  if (-not $script:linkOperationId) { return }
  if (-not (Set-MobileLinkOperation -Repo $repo -OperationId $script:linkOperationId -Phase $Phase)) { throw 'Operation ownership expired or changed' }
  $current=Get-MobileLinkOperation $repo
  if ($current.phase -ne $Phase) { throw 'Operation deadline or cancellation changed the outcome' }
  if (-not $current.active -and $Phase -notin @('ready','partial','failed')) { throw 'Operation deadline reached' }
}
function Wait-LinkOperation([string]$Id) {
  do {
    $current=Get-MobileLinkOperation $repo
    if (-not $current -or $current.operationId -ne $Id) { throw 'Joined operation superseded' }
    if ($current.active -and [datetimeoffset]::UtcNow -ge [datetimeoffset]::Parse($current.deadlineAt)) {
      Set-MobileLinkOperation -Repo $repo -OperationId $Id -Phase failed | Out-Null
      $current=Get-MobileLinkOperation $repo
    }
    if (-not $current.active) { return $current }
    Start-Sleep -Seconds 1
  } while ($true)
}
function Get-LinkValue([object]$Object,[string]$Name,$Fallback=$null) {
  if ($null -eq $Object) { return $Fallback }
  $property=$Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
  $property.Value
}
function Get-LinkDiagnostics([bool]$Paused,[object]$VoiceTunnel) {
  $process=$null
  try {
    $node=(Get-Command node -ErrorAction Stop).Source
    $diagnosticScript=Join-Path $repo 'tools\windows\mobile-link-diagnostics.mjs'
    # Bounded probe: a hung node diagnostic must not pin the whole control command.
    $info=[Diagnostics.ProcessStartInfo]::new($node)
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.Encoding]::UTF8
    $info.StandardErrorEncoding=[Text.Encoding]::UTF8
    $info.Arguments='"'+$diagnosticScript+'" --port '+$BridgePort+' --paused '+$Paused.ToString().ToLowerInvariant()+' --voice-state "'+[string]$VoiceTunnel.state+'"'
    $process=[Diagnostics.Process]::Start($info)
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(20000)){$process.Kill();throw 'Diagnostics probe timed out'}
    $parsed=$stdout.Result | ConvertFrom-Json
    if (-not (Get-LinkValue $parsed 'severity')) { throw 'Incomplete diagnostics' }
    return $parsed
  } catch {
    Write-LinkEvent ('diagnostics-failed type='+$_.Exception.GetType().Name+' line='+$_.InvocationInfo.ScriptLineNumber)
    return [pscustomobject]@{ severity=$(if($Paused){'stopped'}else{'unknown'}); summary=$(if($Paused){'链路已停止'}else{'业务检测未完成，不能确认通道状态'}); nextAction=$(if($Paused){'start'}else{'check_logs'}); checks=@(); restartRequired=$false }
  } finally { if($process){$process.Dispose()} }
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
function Get-LinkBootstrapArguments {
  param([string[]]$Arguments)
  # Bind a detached bootstrap to the intent that authorized this launch.
  # A later Stop/Start or Disable/Enable must invalidate the old child.
  $controlPath=Join-Path $repo 'logs\state\mobile-link-control.json'
  $version=if(Test-Path -LiteralPath $controlPath){(Get-FileHash -LiteralPath $controlPath -Algorithm SHA256).Hash}else{'missing'}
  $Arguments+=@('-LinkControlVersion',$version)
  if ($GuardianRepair) {
    $configPath=Join-Path $repo 'logs\state\mobile-link-guardian-config.json'
    $Arguments+=@('-GuardianRepair','-GuardianConfigVersion',(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash)
  }
  $Arguments
}
function Invoke-DesktopRepair {
  $safe=Invoke-DesktopSafeRecovery
  if ($safe.state -in @('not-needed','recovered','pending')) { return $safe }
  if ((Get-Variable GuardianRepair -ValueOnly -ErrorAction SilentlyContinue) -and -not (Test-GuardianRepairAllowed)) { return [pscustomobject]@{state='cancelled';message='自动恢复已取消'} }
  Write-LinkEvent 'desktop-restart-requested'
  if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase 'restarting_desktop' }
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
  if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase 'connecting_desktop' }
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
  if ($ready -and -not @($checks | Where-Object { $_.id -eq 'companion' -and $_.state -eq 'ready' }).Count) {
    return [pscustomobject]@{state='partial';exitCode=2;message='桌面已连接，但个人助手会话读取尚未通过，请查看检测结果'}
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
function Get-LinkQuickProbe {
  # Cheap pending-loop signal: operation progress file plus two short-timeout
  # bridge reads over the existing $bridgeUrl. These mirror the data sources of
  # the full diagnostics (bridge=/health, desktop=/desktop/live/status) so a
  # "possibly ready" verdict can be detected without running the node probe.
  # Never throws; an unreachable bridge reads as "not ready".
  $operation=$null
  if (Get-Command Get-MobileLinkOperation -ErrorAction SilentlyContinue) { $operation=Get-MobileLinkOperation $repo }
  $health=$null
  try { $health=Invoke-RestMethod -Uri ($bridgeUrl+'/health') -Headers (Get-LinkHeaders) -TimeoutSec 2 } catch { }
  $desktop=$null
  try { $desktop=Invoke-RestMethod -Uri ($bridgeUrl+'/desktop/live/status') -Headers (Get-LinkHeaders) -TimeoutSec 2 } catch { }
  $healthOk=([bool](Get-LinkValue $health 'ok' $false) -and [string](Get-LinkValue (Get-LinkValue $health 'runtime') 'mode' '') -eq 'desktop')
  $desktopLive=[bool](Get-LinkValue (Get-LinkValue $desktop 'desktop') 'desktopLive' $false)
  $remainingSeconds=$null
  if ($operation) {
    try { $remainingSeconds=[int]([datetimeoffset]::Parse([string]$operation.deadlineAt)-[datetimeoffset]::UtcNow).TotalSeconds } catch { }
  }
  [pscustomobject]@{
    healthOk=$healthOk; desktopLive=$desktopLive
    phase=[string](Get-LinkValue $operation 'phase' ''); message=[string](Get-LinkValue $operation 'message' '')
    remainingSeconds=$remainingSeconds
  }
}
function Get-LinkTotpCode([string]$Secret) {
  # RFC 6238 compatible with src/totp.js: base32 secret, HMAC-SHA1, 30s step,
  # 6 digits. Lets the control script authenticate like mobile-link-diagnostics.mjs.
  if (-not $Secret) { return $null }
  if ($null -eq $script:linkTotpKey) {
    $clean=($Secret -replace '[\s-]','').TrimEnd('=').ToUpperInvariant()
    $alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $bytes=New-Object System.Collections.Generic.List[byte]
    $bits=0; $value=[long]0
    foreach($char in $clean.ToCharArray()){
      $index=$alphabet.IndexOf($char)
      if($index -lt 0){ return $null }
      $value=(($value -shl 5) -bor $index) -band 4294967295
      $bits+=5
      if($bits -ge 8){ $bytes.Add([byte](($value -shr ($bits-8)) -band 255)); $bits-=8 }
    }
    if($bytes.Count -eq 0){ return $null }
    $script:linkTotpKey=$bytes.ToArray()
  }
  $step=[long][math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()/30)
  $message=[byte[]]@(0,0,0,0,[byte](($step -shr 24) -band 255),[byte](($step -shr 16) -band 255),[byte](($step -shr 8) -band 255),[byte]($step -band 255))
  $hmac=[Security.Cryptography.HMACSHA1]::new([byte[]]$script:linkTotpKey)
  try { $digest=$hmac.ComputeHash($message) } finally { $hmac.Dispose() }
  $offset=$digest[19] -band 0x0F
  $binary=((([int]$digest[$offset] -band 0x7F) -shl 24) -bor (([int]$digest[$offset+1] -band 255) -shl 16) -bor (([int]$digest[$offset+2] -band 255) -shl 8) -bor ([int]$digest[$offset+3] -band 255))
  return ($binary % 1000000).ToString('D6')
}
function Get-LinkFastProbe {
  param([switch]$SkipHealth)
  # Start fast-path readiness: the three signals behind the ready verdict,
  # read directly over the loopback bridge with token+OTP auth identical to
  # mobile-link-diagnostics.mjs. Never throws; failures read as "not ready".
  # -SkipHealth omits the /health request for callers that already latched the
  # bridge green; the locked verdict is reported so the synthesized status and
  # the ready condition stay correct without repeating the request each round.
  $headers=Get-LinkHeaders
  $code=Get-LinkTotpCode ([string]$env:CODEX_BRIDGE_TOTP_SECRET)
  if ($code) { $headers['X-Codex-Bridge-OTP']=$code }
  $health=$null; $desktop=$null; $sessions=$null
  if (-not $SkipHealth) {
    try { $health=Invoke-RestMethod -Uri ($bridgeUrl+'/health') -Headers $headers -TimeoutSec 1 } catch { }
  }
  try { $desktop=Invoke-RestMethod -Uri ($bridgeUrl+'/desktop/live/status') -Headers $headers -TimeoutSec 1 } catch { }
  try { $sessions=Invoke-RestMethod -Uri ($bridgeUrl+'/codex/sessions?limit=1') -Headers $headers -TimeoutSec 1 } catch { }
  $operation=$null
  if (Get-Command Get-MobileLinkOperation -ErrorAction SilentlyContinue) { $operation=Get-MobileLinkOperation $repo }
  $remainingSeconds=$null
  if ($operation) {
    try { $remainingSeconds=[int]([datetimeoffset]::Parse([string]$operation.deadlineAt)-[datetimeoffset]::UtcNow).TotalSeconds } catch { }
  }
  [pscustomobject]@{
    healthOk=$(if($SkipHealth){$true}else{[bool](Get-LinkValue $health 'ok' $false) -and [string](Get-LinkValue (Get-LinkValue $health 'runtime') 'mode' '') -eq 'desktop'})
    desktopLive=[bool](Get-LinkValue (Get-LinkValue $desktop 'desktop') 'desktopLive' $false)
    sessionsReady=($null -ne (Get-LinkValue $sessions 'sessions' $null))
    remainingSeconds=$remainingSeconds
  }
}
function New-LinkFastStatus {
  param([object]$Probe)
  # Start fast-path output: the same envelope the tray consumes, with the three
  # readiness checks synthesized from the cheap probes instead of a node run.
  $checks=@(
    [pscustomobject]@{id='bridge';title='本地桥接';state=$(if($Probe.healthOk){'ready'}else{'error'});message=$(if($Probe.healthOk){'健康检查通过，使用桌面模式'}else{'桥接健康检查未通过'})}
    [pscustomobject]@{id='desktop';title='Codex 桌面连接';state=$(if($Probe.desktopLive){'ready'}else{'error'});message=$(if($Probe.desktopLive){'桌面实时通道已连接'}else{'桌面通道未连接，可尝试安全修复'})}
    [pscustomobject]@{id='sessions';title='普通会话';state=$(if($Probe.sessionsReady){'ready'}else{'error'});message=$(if($Probe.sessionsReady){'会话列表读取正常；未验证发送'}else{'会话接口未就绪'})}
  )
  $failures=@($checks | Where-Object { $_.state -in @('error','blocked') })
  $diagnostics=[pscustomobject]@{
    severity=$(if($failures.Count){'degraded'}else{'unverified'})
    summary=$(if($failures.Count){'连接需要处理：'+(@($failures | ForEach-Object { $_.title }) -join '、')}else{'读取与连接检测通过；发送、通话和远程操作仍需验证'})
    nextAction=$(if($failures.Count){'safe_repair'}else{'none'})
    checks=$checks
  }
  [pscustomobject]@{
    version=2; checkedAt=[datetime]::UtcNow.ToString('o'); paused=(Test-MobileLinkPaused $repo)
    bridgeHealthy=$Probe.healthOk; runtimeMode=$(if($Probe.healthOk){'desktop'}else{'unknown'}); desktopLive=$Probe.desktopLive
    services=@(); ports=@(); voiceTunnel=(Get-MobileVoiceTunnelStatus $repo); diagnostics=$diagnostics; desktopRecovery=$script:desktopRecovery; config='BridgeConfig.ets + hdc-relay.local.psd1 + voice-tunnel.local.psd1'
    logDirectory=(Join-Path $repo 'logs'); officialCodex='external-host'
  }
}
function Complete-LinkFastStart {
  param([object]$Startup)
  # Active fast verification for Start: bridge bring-up, desktop soft recovery
  # and readiness probing run concurrently instead of waiting for the stack
  # script to finish. The stack exit code is recorded, never awaited as a gate.
  $spawnedAt=[datetimeoffset]::UtcNow
  $bridgeGreen=$false
  $recoveryStarted=$false
  $startupExitRecorded=$false
  $phaseTick=0
  do {
    $probe=Get-LinkFastProbe -SkipHealth:$bridgeGreen
    if ($probe.healthOk -and -not $bridgeGreen) { $bridgeGreen=$true; Write-LinkEvent 'fast-start bridge-green' }
    if ($bridgeGreen -and -not $recoveryStarted -and -not $probe.desktopLive) {
      if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase 'connecting_desktop' }
      $recoveryStarted=$true
      # Soft recovery only needs the bridge; the stack keeps working in background.
      $script:desktopRecovery=Invoke-DesktopSafeRecovery
      if ((Get-LinkValue $script:desktopRecovery 'state' '') -in @('failed','blocked')) {
        $script:fastStartStatus=New-LinkFastStatus -Probe (Get-LinkFastProbe)
        $script:fastStartOutcome=Get-LinkStartupOutcome $script:fastStartStatus
        break
      }
      $probe=Get-LinkFastProbe -SkipHealth:$bridgeGreen
    }
    if ($bridgeGreen -and $probe.desktopLive -and $probe.sessionsReady) {
      $script:fastStartStatus=New-LinkFastStatus -Probe $probe
      # Same state/message/exit the full-diagnostics ready outcome produces; the
      # assistant/voice detail checks stay a Status/Repair responsibility.
      $script:fastStartOutcome=[pscustomobject]@{state='ready';exitCode=0;message='桌面连接与会话读取已就绪；通话状态请查看单独检测结果'}
      Write-LinkEvent 'fast-start ready'
      break
    }
    if (-not $startupExitRecorded -and $Startup.HasExited) {
      $startupExitRecorded=$true
      Write-LinkEvent ('startup-exit='+$Startup.ExitCode)
      Write-LinkEvent 'startup-returned'
    }
    if ($startupExitRecorded -and -not $bridgeGreen -and ([datetimeoffset]::UtcNow - $spawnedAt).TotalSeconds -ge 60) {
      throw '链路启动脚本未成功完成，请查看启动日志。'
    }
    if (Test-MobileLinkPaused $repo) { throw 'Operation cancelled by Stop' }
    if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { throw 'Guardian operation cancelled' }
    $phaseTick++
    if ($phaseTick -ge 5) {
      $phaseTick=0
      # Deadline and ownership enforcement on the same ~2s cadence the previous
      # pending loop used; Set-LinkOperationPhase throws once the deadline passes.
      if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase ($(if($bridgeGreen){'connecting_desktop'}else{'starting_services'})) }
    }
    Start-Sleep -Milliseconds 400
  } while ($true)
}
function Get-LinkStatus {
  if (Get-Command Get-MobileLinkOperation -ErrorAction SilentlyContinue) {
    $progress=Get-MobileLinkOperation $repo
    if ($progress -and $progress.active -and [datetimeoffset]::UtcNow -ge [datetimeoffset]::Parse($progress.deadlineAt)) {
      Set-MobileLinkOperation -Repo $repo -OperationId $progress.operationId -Phase failed | Out-Null
    }
  }
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
function Start-LinkBridgeProcess {
  # Fast Start path: launch the node bridge directly instead of paying a second
  # pwsh cold start inside the stack script's Phase All flow. The injected
  # environment and argv stay item-for-item identical to the stack's
  # Start-LocalBridgeProcess, including the voice presence guard and the
  # unparsed ownership marker argv that lifecycle process matching requires.
  $stdout=Join-Path $repo 'logs\startup\bridge.stdout.log'
  $stderr=Join-Path $repo 'logs\startup\bridge.stderr.log'
  $runtimeMode=[string]$env:CODEX_BRIDGE_RUNTIME_MODE
  if ([string]::IsNullOrWhiteSpace($runtimeMode)) { $runtimeMode='desktop' }
  $runtimeMode=$runtimeMode.Trim().ToLowerInvariant()
  # Same voice presence guard as the stack: without voice\voice_server.py the bridge stays voice-free.
  $voiceEnabled='0'
  $voiceCommand=''
  $voiceServerPath=Join-Path $repo 'voice\voice_server.py'
  if (Test-Path -LiteralPath $voiceServerPath) {
    $voiceEnabled='1'
    $voicePython=Join-Path $repo '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $voicePython)) { $voicePython='python' }
    $voiceCommand='"'+$voicePython+'" "'+$voiceServerPath+'" --port 8790'
  }
  $env:CODEX_BRIDGE_HOST='0.0.0.0'
  $env:CODEX_BRIDGE_PORT="$BridgePort"
  $env:CODEX_BRIDGE_WORKSPACE="$repo"
  $env:CODEX_BRIDGE_ADAPTER='codex'
  $env:CODEX_BRIDGE_RUNTIME_MODE="$runtimeMode"
  $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS="$([string]$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS)"
  $env:CODEX_BRIDGE_VOICE_ENABLED="$voiceEnabled"
  $env:CODEX_BRIDGE_VOICE_COMMAND="$voiceCommand"
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  # Direct node argv no longer contains the repo root path, so lifecycle
  # ownership matching would treat the bridge as external (Stop could not kill
  # it and Start would refuse the port). The unparsed marker restores the
  # forward-slash root match. Double quotes keep the values interpolated --
  # single-quoted literals would hand node '' and parseInt would yield NaN.
  $workspaceMarker='--codex-bridge-workspace='+$repo.Replace('\','/')+'/'
  $bridge=Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @('src/server.js',$workspaceMarker) -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $null=$bridge.Handle # Retain the handle so a fast exit still yields ExitCode.
  return $bridge
}
function Start-LinkBackgroundTrack {
  param([string]$RuntimeMode)
  # Fork the stack script's existing Background sub-phase: watchdogs, voice
  # tunnel, HDC relay and the gentle session confirmation probes. That phase
  # never launches the bridge; the argument passthrough mirrors the stack's own
  # Start-ServicesTrackProcess fork. Best-effort: a failed fork is recorded and
  # never fatal; Ensure-LinkMonitors re-checks the watchers after readiness.
  $trackArguments=@(
    '-Phase','Background',
    '-TrackResultFile',(Join-Path $repo ('logs\startup\background-track.'+$PID+'.result.json')),
    '-BridgePort',"$BridgePort",
    '-BridgeUrl',$bridgeUrl,
    '-RuntimeMode',$RuntimeMode,
    '-ConfigPath',(Join-Path $repo 'tools\harmony\hdc-relay.local.psd1')
  )
  if ($env:CODEX_BRIDGE_TOKEN) { $trackArguments+=@('-BridgeToken',$env:CODEX_BRIDGE_TOKEN) }
  if ($env:CODEX_BRIDGE_TOTP_SECRET) { $trackArguments+=@('-BridgeTotpSecret',$env:CODEX_BRIDGE_TOTP_SECRET) }
  if ($env:CODEX_BRIDGE_PUBLIC_URL) { $trackArguments+=@('-BridgePublicUrl',$env:CODEX_BRIDGE_PUBLIC_URL) }
  if ($env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS) { $trackArguments+=@('-CanaryThreadIds',$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS) }
  $trackArguments=Get-LinkBootstrapArguments ($trackArguments+@('-SkipCodexDesktop','-KeepExistingCodex'))
  $track=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments $trackArguments -LogPath (Join-Path $repo 'logs\startup\background-track.log') -WorkingDirectory $repo
  $track.Dispose()
}
function Start-Link {
  if ($GuardianRepair -and $RestartDesktop) {
    # The third guardian round must keep its component scope. Do not run the
    # full bootstrap, touch a cooling public proxy, or require optional HDC.
    $selected=@($GuardianComponents -split ',' | Where-Object { $_ -in @('desktop','sessions','companion') })
    if (-not $selected.Count) { throw 'Missing scoped desktop recovery components' }
    if (-not (Test-GuardianRepairAllowed)) { return }
    Set-LinkEnvironment
    if (-not (Test-GuardianRepairAllowed)) { return }
    Set-LinkOperationPhase 'connecting_desktop'
    $script:desktopRecovery=Invoke-DesktopRepair
    return
  }
  Write-LinkEvent 'checking-start-ownership'
  # Cheap-first occupancy gate: a 200ms loopback TcpClient connect resolves a
  # free port without paying the cold Get-NetTCPConnection/WMI ownership scan.
  # The full refusal semantics only run when something actually listens.
  $portOccupied=$false
  try {
    $probeClient=[Net.Sockets.TcpClient]::new()
    try { $portOccupied=[bool]$probeClient.ConnectAsync('127.0.0.1',$BridgePort).Wait(200) }
    finally { $probeClient.Dispose() }
  } catch { $portOccupied=$false } # Refused connect = free port.
  if ($portOccupied) {
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
  }
  # Guardian follows persisted intent; it must never turn a concurrent manual
  # Stop back into running after the ownership/health probes have completed.
  if ($GuardianRepair) {
    if (-not (Test-GuardianRepairAllowed)) { return }
  } else { Set-MobileLinkDesiredState -Repo $repo -State running }
  Set-LinkEnvironment
  if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase 'starting_services' }
  Write-LinkEvent 'starting-stack-with-desktop-protected'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs\startup') | Out-Null
  # Bootstrap bridge separately; only explicit Repair -RestartDesktop may restart the official desktop.
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { return }
  if ($Action -eq 'Start' -and -not $GuardianRepair) {
    # Fast start: launch the node bridge directly and hand watchdog/voice/HDC
    # work to the stack's Background sub-phase, skipping the Phase All pwsh hop
    # entirely. Desktop soft recovery is triggered as soon as the bridge
    # answers, so it overlaps with the background track instead of waiting.
    Write-LinkEvent 'bridge-direct-launch'
    $bridge=Start-LinkBridgeProcess
    try { Start-LinkBackgroundTrack -RuntimeMode ([string]$env:CODEX_BRIDGE_RUNTIME_MODE) }
    catch { Write-LinkEvent ('background-track-fork-failed type='+$_.Exception.GetType().Name) }
    try { Complete-LinkFastStart -Startup $bridge } finally { $bridge.Dispose() }
    Ensure-LinkMonitors
    return
  }
  $startupArguments=Get-LinkBootstrapArguments @('-BridgePort',"$BridgePort",'-SkipCodexDesktop','-KeepExistingCodex')
  $startup=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments $startupArguments -LogPath (Join-Path $repo 'logs\startup\manager-start.log') -WorkingDirectory $repo
  try { if(-not $startup.WaitForExit(90000)){throw 'Bootstrap timeout'}; Write-LinkEvent ('startup-exit='+$startup.ExitCode); if ($startup.ExitCode -notin @(0,2)) { throw '链路启动脚本未成功完成，请查看启动日志。' } }
  finally { $startup.Dispose() }
  Write-LinkEvent 'startup-returned'
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { return }
  if (Test-MobileLinkPaused $repo) { throw 'Operation cancelled by Stop' }
  if (Get-Command Set-LinkOperationPhase -ErrorAction SilentlyContinue) { Set-LinkOperationPhase 'connecting_desktop' }
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
function Get-GuardianVoiceRepairComponents {
  param([string[]]$Requested)
  $process=$null
  try {
    $voice=Get-MobileVoiceTunnelStatus $repo
    $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node -ErrorAction Stop).Source)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.Encoding]::UTF8
    $info.StandardErrorEncoding=[Text.Encoding]::UTF8
    $diagnosticScript=Join-Path $repo 'tools\windows\mobile-link-diagnostics.mjs'
    $info.Arguments='"'+$diagnosticScript+'" --port '+$BridgePort+' --voice-repair-json --voice-state "'+$voice.state+'"'
    $process=[Diagnostics.Process]::Start($info)
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(35000)){$process.Kill();throw 'Voice recheck timed out'}
    if($process.ExitCode -ne 0){throw 'Voice recheck failed'}
    $fresh=$stdout.Result | ConvertFrom-Json
    $signals=Get-LinkValue $fresh 'guardianSignals'
    $faults=Get-LinkValue $signals 'faults'
    if($null -eq $faults -or @($faults | Where-Object { (Get-LinkValue $_ 'repairable') -ne $true }).Count){return}
    foreach($component in $Requested){
      $id=if($component -eq 'voice'){'voice_transport'}else{'voice_tunnel'}
      $kind=if($component -eq 'voice'){'local_service'}else{'transport'}
      if(@($faults | Where-Object { (Get-LinkValue $_ 'id') -eq $id -and (Get-LinkValue $_ 'component') -eq $component -and (Get-LinkValue $_ 'kind') -eq $kind }).Count){$component}
    }
  } catch { Write-LinkEvent 'guardian-voice-recheck-unconfirmed; preserving services' }
  finally { if($process){$process.Dispose()} }
}
function Invoke-GuardianScopedRepair {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs\startup') | Out-Null
  $components=@($GuardianComponents -split ',' | Where-Object { $_ -in @('bridge','desktop','sessions','companion','public','voice','voice_tunnel') })
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
      $startupArguments=Get-LinkBootstrapArguments @('-BridgePort',"$BridgePort",'-SkipCodexDesktop','-KeepExistingCodex','-SkipHdcRelay')
      $startup=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'scripts\start-codex-mobile-stack.ps1') -Arguments $startupArguments -LogPath (Join-Path $repo 'logs\startup\guardian-bridge-repair.log') -WorkingDirectory $repo
      try { if (-not $startup.WaitForExit(90000) -or $startup.ExitCode -notin @(0,2)) { throw 'Bridge bootstrap failed or timed out' } } finally { $startup.Dispose() }
    }
    if ('public' -in $components -and (Test-GuardianRepairAllowed)) {
      Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('public-proxy') | Out-Null
      if (-not (Test-GuardianRepairAllowed)) { return }
      $proxy=Start-MobileLinkDetached -HostPath (Get-Process -Id $PID).Path -ScriptPath (Join-Path $repo 'tools\harmony\start-hdc-relay.ps1') -Arguments @('-Mode','BridgeProxy') -LogPath (Join-Path $repo 'logs\startup\guardian-public-repair.log') -WorkingDirectory $repo
      $proxy.Dispose()
    }
  }
  $requestedVoice=@($components | Where-Object { $_ -in @('voice','voice_tunnel') })
  if($requestedVoice.Count -and (Test-GuardianRepairAllowed)){
    # Queued faults can already be healthy. A fresh, scoped probe is required
    # before stopping anything; unknown/auth/upstream failures preserve services.
    $confirmed=@(Get-GuardianVoiceRepairComponents -Requested $requestedVoice)
    if('voice' -in $confirmed -and $GuardianStage -eq 'restart_services' -and (Test-GuardianRepairAllowed)){
      Write-LinkEvent 'guardian-voice-repair stopping-media; local-fault-reconfirmed'
      Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('voice') | Out-Null
    }
    if('voice_tunnel' -in $confirmed -and (Test-GuardianRepairAllowed)){
      if($GuardianStage -eq 'restart_services'){
        Write-LinkEvent 'guardian-voice-repair restarting-tunnel; media-preserved'
        Stop-MobileVoiceTunnel $repo -CanStop { Test-GuardianRepairAllowed }
      }
      if(Test-GuardianRepairAllowed){Ensure-MobileVoiceTunnel $repo -CanStart { Test-GuardianRepairAllowed }}
    }
  }
  if (@($components | Where-Object { $_ -in @('desktop','sessions','companion') }).Count -and (Test-GuardianRepairAllowed)) {
    $script:desktopRecovery=Invoke-DesktopSafeRecovery
  }
}
try {
  # 托盘预热握手：-StandbyFile 由托盘在 exe 初始化时传入，此时本进程已完成
  # pwsh 冷启动与脚本解析（真正的预热），等待托盘探测结论——go 则按正常
  # Start 继续，abort/超时则无副作用退出。认领 operation、互斥闸门、状态
  # 写入等一切副作用都发生在本块之后，超时路径零痕迹。
  if ($StandbyFile -and $Action -eq 'Start') {
    $standbyDeadline=[datetime]::UtcNow.AddSeconds(6)
    $standbyGo=$false
    while ([datetime]::UtcNow -lt $standbyDeadline) {
      if (Test-Path -LiteralPath $StandbyFile) {
        $standbyGo=(([string](Get-Content -Raw -LiteralPath $StandbyFile -ErrorAction SilentlyContinue)) -replace '\s','') -eq 'go'
        break
      }
      Start-Sleep -Milliseconds 100
    }
    if (-not $standbyGo) { Write-LinkEvent 'standby-abort'; exit 0 }
    Remove-Item -LiteralPath $StandbyFile -ErrorAction SilentlyContinue
    Write-LinkEvent 'standby-go'
  }
  # Persist manual intent before waiting for any in-flight repair. Its next
  # irreversible boundary will observe the stop even while holding the gate.
  if ($Action -eq 'Stop') {
    Set-MobileLinkDesiredState -Repo $repo -State stopped
    if (Get-Command Get-MobileLinkOperation -ErrorAction SilentlyContinue) {
      $cancelled=Get-MobileLinkOperation $repo
      if ($cancelled -and $cancelled.active) { Set-MobileLinkOperation -Repo $repo -OperationId $cancelled.operationId -Phase failed | Out-Null }
    }
  }
  if ($Action -eq 'GuardianRepair') {
    $GuardianRepair=$true
    if ($GuardianStage -eq 'restart_desktop') { $Action='Repair'; $RestartDesktop=$true }
  }
  if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { @{skipped=$true;reason='guardian_disabled_or_paused'} | ConvertTo-Json -Compress; return }
  if ($Action -eq 'Repair' -and $RestartDesktop -and -not $ScheduledRepairWorker) {
    . (Join-Path $PSScriptRoot 'mobile-link-repair-task.ps1')
    $operation=Start-MobileLinkRepairTask -Repo $repo -BridgePort $BridgePort -GuardianRepair:$GuardianRepair -GuardianComponents $GuardianComponents
    if ($operation.joined -and $operation.action -ne 'Repair') {
      $joined=Wait-LinkOperation $operation.runId
      [pscustomobject]@{action=$Action;operationId=$joined.operationId;startupOutcome=@{state=$joined.phase;exitCode=$(if($joined.phase -eq 'ready'){0}else{2});message=$joined.message}} | ConvertTo-Json -Depth 6 -Compress
      if ($joined.phase -ne 'ready') { exit 2 }; return
    }
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
    $current=Get-MobileLinkOperation $repo
    [pscustomobject]@{action=$Action;operationId=$operation.runId;startupOutcome=@{state=$(if($current -and $current.operationId -eq $operation.runId){$current.phase}else{'pending'});exitCode=2;message='独立修复任务仍在后台执行，请查看操作进度。'}} | ConvertTo-Json -Depth 6 -Compress
    exit 2
  }
  if ($Action -in @('Start','Repair')) {
    if ($OperationId) {
      $current=Get-MobileLinkOperation $repo
      if (-not $current -or $current.operationId -ne $OperationId -or -not $current.active) { throw 'Scheduled operation no longer owns progress' }
      $script:linkOperationId=$OperationId
    } else {
      $claim=New-MobileLinkOperation -Repo $repo -Action $Action
      if ($claim.joined) {
        $joined=Wait-LinkOperation $claim.operation.operationId
        [pscustomobject]@{action=$Action;operationId=$joined.operationId;startupOutcome=@{state=$joined.phase;exitCode=$(if($joined.phase -eq 'ready'){0}else{2});message=$joined.message}} | ConvertTo-Json -Depth 6 -Compress
        if ($joined.phase -ne 'ready') { exit 2 }; return
      }
      $script:linkOperationId=$claim.operation.operationId
    }
    Set-LinkOperationPhase 'checking'
  }
  if ($Action -ne 'Status') {
    $waitMs=15000
    if ($Action -eq 'Maintain') { $waitMs=0 }
    # Stop has already published cancellation. Give bounded launchers time to
    # observe it, then clean up any service started immediately before Stop.
    if ($Action -eq 'Stop') { $waitMs=180000 }
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
    'Maintain' {
      Ensure-LinkMonitors
      # Only monitor mutations need the lifecycle gate. Slow read-only status
      # probes must not make a foreground Start/Repair exhaust its lock wait.
      if ($owns) { $gate.ReleaseMutex(); $owns=$false }
    }
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
  if ($Action -in @('Start','Repair')) { Set-LinkOperationPhase 'verifying' }
  # Fast Start already verified readiness through the probe loop; its snapshot
  # carries synthesized checks so the shared tail below stays untouched.
  $status=if ($script:fastStartStatus) { $script:fastStartStatus } else { Get-LinkStatus }
  # A detached desktop launcher may outlive its initial wait. Keep only read-only
  # verification alive; never issue another restart while it is pending.
  if (-not $script:fastStartStatus -and $Action -in @('Start','Repair') -and (Get-LinkValue $script:desktopRecovery 'state' '') -eq 'pending') {
    Set-LinkOperationPhase 'pending'
    # Cheap-first polling: only escalate to the full status probe when the quick
    # signal says the link may be ready, the quick signal jumped, or the operation
    # deadline is near. Terminal detection still comes from the full status, so
    # exit conditions and output stay identical to the previous every-round probe.
    $quickSignature=''
    do {
      $pendingOutcome=Get-LinkStartupOutcome $status -RequireAssistant ($Action -eq 'Repair' -and $RestartDesktop)
      if ($pendingOutcome.state -ne 'pending') { break }
      if (Test-MobileLinkPaused $repo) { throw 'Operation cancelled by Stop' }
      if ($GuardianRepair -and -not (Test-GuardianRepairAllowed)) { throw 'Guardian operation cancelled' }
      Start-Sleep -Seconds 2
      Set-LinkOperationPhase 'pending'
      $quick=Get-LinkQuickProbe
      $quickSignatureNew='health='+$quick.healthOk+';desktop='+$quick.desktopLive+';phase='+$quick.phase+';message='+$quick.message
      $quickReady=$quick.healthOk -and $quick.desktopLive
      $quickDeadlineNear=($null -eq $quick.remainingSeconds) -or $quick.remainingSeconds -le 20
      if ($quickReady -or $quickDeadlineNear -or $quickSignatureNew -ne $quickSignature) {
        $quickSignature=$quickSignatureNew
        $status=Get-LinkStatus
      }
    } while ($true)
    Set-LinkOperationPhase 'verifying'
  }
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
    $outcome=if ($script:fastStartOutcome) { $script:fastStartOutcome } else { Get-LinkStartupOutcome $status -RequireAssistant ($Action -eq 'Repair' -and $RestartDesktop) }
    $status | Add-Member -NotePropertyName startupOutcome -NotePropertyValue $outcome
    $resultCode=$outcome.exitCode
    $phase=if($outcome.state -in @('ready','partial','pending')){$outcome.state}else{'failed'}
    Set-LinkOperationPhase $phase
    Write-LinkEvent ('startup-outcome='+$outcome.state)
    $status | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $repo 'logs\state\mobile-link-status.json') -Encoding utf8
  }
  $status | ConvertTo-Json -Depth 6 -Compress
  Write-LinkEvent 'completed'
  if ($resultCode -ne 0) { exit $resultCode }
} catch {
  if ($script:linkOperationId) {
    try { Set-MobileLinkOperation -Repo $repo -OperationId $script:linkOperationId -Phase failed | Out-Null } catch { }
  }
  Write-LinkEvent ('failed type='+$_.Exception.GetType().Name+' line='+$_.InvocationInfo.ScriptLineNumber)
  # Avoid writing exception details which can contain authenticated URLs or response data.
  [pscustomobject]@{ error='链路操作未完成：端口、模式、配置或操作互斥检查未通过。请打开日志目录检查。'; action=$Action } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($owns) { $gate.ReleaseMutex() }
  $gate.Dispose()
}
