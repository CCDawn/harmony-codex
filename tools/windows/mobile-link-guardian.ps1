[CmdletBinding()]
param(
  [ValidateSet('Status','Enable','Disable','SetPolicy','Ensure','Run')][string]$Action='Status',
  [ValidateSet('Preserve','Allow','Deny')][string]$RestartPolicy='Preserve',
  [ValidateRange(1,65535)][int]$BridgePort=8787,
  [switch]$Once
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'mobile-link-lifecycle.ps1')
. (Join-Path $PSScriptRoot 'mobile-voice-tunnel.ps1')
$stateDir=Join-Path $repo 'logs\state'
$configPath=Join-Path $stateDir 'mobile-link-guardian-config.json'
$statusPath=Join-Path $stateDir 'mobile-link-guardian-status.json'
$runtimePath=Join-Path $stateDir 'mobile-link-guardian-runtime.json'
$diagnosticsPath=Join-Path $stateDir 'mobile-link-guardian-diagnostics.json'
$hostPath=(Get-Process -Id $PID).Path
function Value($Object,[string]$Name,$Fallback=$null) {
  if ($null -eq $Object) { return $Fallback }
  $property=$Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
  $property.Value
}
function Read-GuardianJson([string]$Path,$Fallback) {
  try { Get-Content -Raw -Encoding utf8 -LiteralPath $Path | ConvertFrom-Json } catch { $Fallback }
}
function Write-GuardianJson([string]$Path,$Object) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temp,($Object | ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp,$Path,[NullString]::Value) } else { [IO.File]::Move($temp,$Path) }
  } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Get-GuardianConfig { Read-GuardianJson $configPath ([pscustomobject]@{version=1;enabled=$false;allowForceRestart=$false;updatedAt=$null}) }
function Set-GuardianConfig {
  param([Nullable[bool]]$Enabled=$null,[string]$ExpectedUpdatedAt='',
    [ValidateSet('Preserve','Allow','Deny')][string]$Policy='Preserve')
  $gate=New-MobileLinkMutex ($repo+'\guardian-config');$owns=$false
  try {
    try {$owns=$gate.WaitOne(1000)}catch [Threading.AbandonedMutexException]{$owns=$true}
    if(-not $owns){throw 'Guardian config busy'}
    $config=Get-GuardianConfig
    if($ExpectedUpdatedAt){
      $current=Value $config 'updatedAt'
      if(-not $current -or ([datetimeoffset]$current).UtcTicks -ne ([datetimeoffset]$ExpectedUpdatedAt).UtcTicks){return $null}
    }
    $enabledValue=if($null -eq $Enabled){(Value $config 'enabled' $false) -eq $true}else{[bool]$Enabled}
    $forceValue=if($Policy -eq 'Preserve'){(Value $config 'allowForceRestart' $false) -eq $true}else{$Policy -eq 'Allow'}
    $updated=[datetime]::UtcNow.ToString('o')
    Write-GuardianJson $configPath @{version=1;enabled=$enabledValue;allowForceRestart=$forceValue;updatedAt=$updated}
    $updated
  }finally{if($owns){$gate.ReleaseMutex()};$gate.Dispose()}
}
function Get-GuardianStatus {
  $config=Get-GuardianConfig
  $saved=Read-GuardianJson $statusPath $null
  $enabled=(Value $config 'enabled' $false) -eq $true
  $paused=Test-MobileLinkPaused $repo
  $phase=if(-not $enabled){'disabled'}elseif($paused){'paused'}else{[string](Value $saved 'phase' 'suspect')}
  $summary=if(-not $enabled){'自动守护已关闭'}elseif($paused){'链路已手动停止；守护开关已保存，等待手动启动'}else{[string](Value $saved 'summary' '自动守护已开启，等待后台检测')}
  if ($enabled -and -not $paused -and (Value $saved 'heartbeatAt')) {
    try {
      $heartbeat=Value $saved 'heartbeatAt'
      $beat=if($heartbeat -is [datetime]){$heartbeat.ToUniversalTime()}else{[datetimeoffset]::Parse([string]$heartbeat).UtcDateTime}
      if (([datetime]::UtcNow-$beat).TotalSeconds -gt 90) {$phase='needs_attention';$summary='后台检测心跳已过期，请重新开启自动守护'}
    } catch {$phase='needs_attention';$summary='后台检测状态不可读，请重新开启自动守护'}
  }
  # Return a fixed public shape; internal counters, paths, errors and credentials
  # never cross the CLI/API boundary.
  [pscustomobject]@{version=1;enabled=$enabled;allowForceRestart=((Value $config 'allowForceRestart' $false) -eq $true);phase=$phase;summary=$summary
    checkedAt=(Value $saved 'checkedAt');heartbeatAt=(Value $saved 'heartbeatAt');lastSuccessAt=(Value $saved 'lastSuccessAt');lastRepairAt=(Value $saved 'lastRepairAt')
    attempts=[int](Value $saved 'attempts' 0);nextCheckAt=(Value $saved 'nextCheckAt')
    faults=@(Value $saved 'faults' @());history=@(Value $saved 'history' @())}
}
function Invoke-GuardianChild {
  param([string]$Executable,[string[]]$Arguments,[string]$InputJson='',[int]$TimeoutSeconds=45)
  $info=[Diagnostics.ProcessStartInfo]::new($Executable)
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.Encoding]::UTF8; $info.StandardErrorEncoding=[Text.Encoding]::UTF8
  $info.WorkingDirectory=$repo
  # Windows paths cannot contain quotes. All other arguments are fixed enums,
  # booleans, ports or internal comma-separated component names.
  $info.Arguments=(@($Arguments | ForEach-Object { '"'+$_.Replace('"','\"')+'"' }) -join ' ')
  if ($InputJson) { $info.RedirectStandardInput=$true }
  $process=[Diagnostics.Process]::new(); $process.StartInfo=$info
  try {
    [void]$process.Start()
    $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
    if ($InputJson) { $process.StandardInput.Write($InputJson); $process.StandardInput.Close() }
    $deadline=[datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not $process.WaitForExit(1000)) {
      # Heartbeat remains current during bounded repair/diagnostic waits.
      if ($script:workerStatus) { $script:workerStatus.heartbeatAt=[datetime]::UtcNow.ToString('o'); Write-GuardianJson $statusPath $script:workerStatus }
      if ([datetime]::UtcNow -ge $deadline) {
        # Kill only this invocation; independent repair tasks keep their own
        # bounded execution and mutex. Do not kill their service descendants.
        $process.Kill(); throw 'Guardian child timeout'
      }
    }
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 2) { throw 'Guardian child failed' }
    # A descendant that inherited this child's redirected pipes keeps them open
    # past child exit; the pending ReadToEndAsync would then freeze this worker
    # loop forever. Bound the drain and fail the round recognizably instead so
    # the existing catch path records unconfirmed and the loop self-heals.
    if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Guardian child output pipes still held by descendant' }
    ($stdout.Result | ConvertFrom-Json)
  } finally { $process.Dispose() }
}
function Test-GuardianBridgeQuick {
  param([int]$Port)
  # In-process cheap /health probe against the local bridge, mirroring the
  # diagnostics child's own healthy check (ok=true with runtime.mode=desktop).
  # The token comes from the same local bridge config that child reads and is
  # only ever placed in the request header; it is never logged or persisted.
  $headers=@{}
  try {
    $configFile=Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
    if([IO.File]::Exists($configFile)){
      $tokenMatch=[regex]::Match([IO.File]::ReadAllText($configFile),'DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*[''"]([^''"]*)[''"]')
      if($tokenMatch.Success -and $tokenMatch.Groups[1].Value){$headers['X-Codex-Bridge-Token']=$tokenMatch.Groups[1].Value}
    }
  } catch { }
  try {
    $health=Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $Port) -Headers $headers -TimeoutSec 3
    [bool]((Value $health 'ok' $false) -eq $true -and [string](Value (Value $health 'runtime' $null) 'mode' '') -eq 'desktop')
  } catch { $false }
}
function Get-GuardianBridgeBudget {
  param($Runtime)
  $budgets=Value $Runtime 'componentBudgets' $null
  if(-not $budgets){
    $budgets=[pscustomobject]@{}
    Add-Member -InputObject $Runtime -NotePropertyName componentBudgets -NotePropertyValue $budgets -Force
  }
  $bridge=Value $budgets 'bridge' $null
  if(-not $bridge){
    $bridge=[pscustomobject]@{failures=0;attempts=0;cooldownUntil=$null}
    Add-Member -InputObject $budgets -NotePropertyName bridge -NotePropertyValue $bridge -Force
  }
  $bridge
}
function Get-GuardianInstant($Value) {
  # ConvertFrom-Json hands cooldown stamps back as UTC datetimes; a [string]
  # round-trip would lose the Kind and reinterpret the wall clock as local
  # time. Parse the original value directly instead.
  if($null -eq $Value){ return [datetimeoffset]::MinValue }
  if($Value -is [datetimeoffset]){ return $Value }
  if($Value -is [datetime]){
    if($Value.Kind -eq [DateTimeKind]::Local){ return [datetimeoffset]::new($Value) }
    return [datetimeoffset]::new([datetime]::SpecifyKind($Value,[DateTimeKind]::Utc))
  }
  return [datetimeoffset]::Parse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
}
function Test-GuardianBridgeFastRepair {
  # Mirror of the policy per-component walk for bridge: an active cooldown
  # blocks the round, three consumed attempts enter a five minute cooldown, and
  # a served cooldown opens a fresh window. Advances the bridge budget in place
  # (failures/attempts +1 per existing semantics) and returns $true only when
  # this round must run the fast restart_services repair.
  param($Runtime)
  $bridge=Get-GuardianBridgeBudget -Runtime $Runtime
  $attempts=[int](Value $bridge 'attempts' 0)
  $cooldown=Value $bridge 'cooldownUntil' $null
  if($null -ne $cooldown){
    $cooling=$false
    try { $cooling=[datetimeoffset]::UtcNow.UtcTicks -lt (Get-GuardianInstant $cooldown).UtcTicks } catch { $cooling=$false }
    if($cooling){ return $false }
  }
  if($attempts -ge 3){
    if($cooldown){
      $bridge.attempts=0; $bridge.failures=1; $bridge.cooldownUntil=$null
    } else {
      $bridge.cooldownUntil=[datetime]::UtcNow.AddMinutes(5).ToString('o')
      return $false
    }
  }
  $bridge.failures=[int](Value $bridge 'failures' 0)+1
  $bridge.attempts=[int](Value $bridge 'attempts' 0)+1
  return $true
}
function Test-GuardianManualFaultPresent {
  # A persisted manual fault (repairable:false, e.g. companion auth) cannot be
  # fixed by any restart, so the fast path must stand down and let the policy
  # surface needs_attention instead of running another restart_services round.
  $snapshot=Read-GuardianJson $diagnosticsPath $null
  $signals=Value $snapshot 'guardianSignals' $null
  $faults=Value $signals 'faults' @()
  foreach($fault in @($faults)) {
    if($null -ne $fault -and (Value $fault 'repairable' $true) -ne $true) { return $true }
  }
  return $false
}
function Ensure-GuardianWorker {
  if ((Value (Get-GuardianConfig) 'enabled' $false) -ne $true) { return }
  $gate=New-MobileLinkMutex ($repo+'\guardian-launch')
  $owns=$false
  try {
    try { $owns=$gate.WaitOne(1000) } catch [Threading.AbandonedMutexException] { $owns=$true }
    if(-not $owns){return}
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($repo.ToLowerInvariant()))).Replace('-','').Substring(0,12) } finally { $sha.Dispose() }
    $name='CodexHarmonyGuardian-'+$hash
    $existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing -and [string]$existing.State -eq 'Running') { return }
    $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments='--headless "'+$pwsh+'" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action Run -BridgePort '+$BridgePort
    $taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $repo
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    # Login restores an enabled guardian after reboot. Disabled workers exit
    # without starting services; no service/desktop startup is coupled here.
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    Register-ScheduledTask -TaskName $name -Action $taskAction -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
    Start-ScheduledTask -TaskName $name
  } finally { if($owns){$gate.ReleaseMutex()};$gate.Dispose() }
}
function Ensure-GuardianWatchers {
  param([switch]$Force)
  $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'mobile-link-lifecycle.ps1')).Hash
  $marker=Read-GuardianJson (Join-Path $stateDir 'mobile-link-guardian-watchers.json') $null
  if(-not $Force -and (Value $marker 'lifecycleSha256') -eq $hash){return}
  $handoff=Invoke-GuardianChild -Executable $hostPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'mobile-link-control.ps1'),'-Action','GuardianReloadWatchers','-BridgePort',"$BridgePort") -TimeoutSeconds 18
  if((Value $handoff 'reloaded' $false) -ne $true){throw 'Guardian watchdog handoff failed'}
}
$script:workerStatus=$null
try {
  if ($Action -in @('Enable','Disable')) {
    $pending=Set-GuardianConfig -Enabled $false -Policy $RestartPolicy
    if($Action -eq 'Enable'){
      # Complete the old-watcher handoff before committing enabled=true. Leave
      # the config mutex free so a concurrent Disable can cancel this request.
      Ensure-GuardianWatchers -Force
      $committed=Set-GuardianConfig -Enabled $true -ExpectedUpdatedAt $pending
      if(-not $committed){@{guardian=(Get-GuardianStatus)}|ConvertTo-Json -Depth 10 -Compress;return}
      $fresh=Get-GuardianStatus;$fresh.phase=if(Test-MobileLinkPaused $repo){'paused'}else{'suspect'}
      $fresh.summary=if($fresh.phase -eq 'paused'){'链路已手动停止；守护开关已保存，等待手动启动'}else{'自动守护已开启，等待后台检测'}
      Write-GuardianJson $statusPath $fresh
    }
  }
  if ($Action -eq 'SetPolicy') { $null=Set-GuardianConfig -Policy $RestartPolicy }
  if ($Action -eq 'Ensure' -and (Value (Get-GuardianConfig) 'enabled' $false) -eq $true) {
    try { Ensure-GuardianWatchers } catch { $null=Set-GuardianConfig -Enabled $false; throw }
  }
  if ($Action -in @('Enable','Disable','Ensure')) { Ensure-GuardianWorker }
  if ($Action -ne 'Run') { @{guardian=(Get-GuardianStatus)} | ConvertTo-Json -Depth 10 -Compress; return }
  $workerGate=New-MobileLinkMutex ($repo+'\guardian-worker');$workerOwns=$false
  try {
    try {$workerOwns=$workerGate.WaitOne(0)} catch [Threading.AbandonedMutexException] {$workerOwns=$true}
    if(-not $workerOwns){return}
    $runtime=Read-GuardianJson $runtimePath ([pscustomobject]@{})
    do {
      $started=[datetime]::UtcNow
      $config=Get-GuardianConfig
      if ((Value $runtime 'configUpdatedAt') -ne (Value $config 'updatedAt')) { $runtime=[pscustomobject]@{} }
      $saved=Get-GuardianStatus
      $script:workerStatus=$saved
      try {
        $diagnostics=[pscustomobject]@{checks=@();guardianSignals=@{faults=@()}}
        $probed=$false
        $fastBridgeRepair=$false
        if ((Value $config 'enabled' $false) -eq $true -and -not (Test-MobileLinkPaused $repo)) {
          # Cheap in-process bridge probe before spawning the full diagnostic
          # child. Two consecutive failures with an un-cooled bridge budget
          # short-circuit the reconnect round that cannot help the bridge. The
          # streak persists through the worker-owned runtime field so a
          # restarted worker keeps counting.
          $probed=$true
          $probeHealthy=Test-GuardianBridgeQuick -Port $BridgePort
          $bridgeProbeFailures=if($probeHealthy){0}else{[int](Value $runtime 'bridgeQuickStreak' 0)+1}
          # A persisted manual fault (repairable:false) means restarts cannot
          # help this window; gate the fast path so the policy round decides.
          if(-not $probeHealthy -and $bridgeProbeFailures -ge 2 -and -not (Test-GuardianManualFaultPresent)){ $fastBridgeRepair=Test-GuardianBridgeFastRepair -Runtime $runtime }
        }
        if ($fastBridgeRepair) {
          # Worker-owned bridge round: the budget advanced above, so commit the
          # state before the repair child. Policy is skipped this round so the
          # same fault window cannot be repaired twice; the full diagnostic
          # still runs below for the snapshot and the other components.
          $fastConfig=Get-GuardianConfig
          if ((Value $fastConfig 'enabled' $false) -eq $true -and -not (Test-MobileLinkPaused $repo)) {
            $runtime | Add-Member -NotePropertyName bridgeQuickStreak -NotePropertyValue 0 -Force
            $runtime | Add-Member -NotePropertyName configUpdatedAt -NotePropertyValue (Value $fastConfig 'updatedAt') -Force
            # Mirror the policy aggregates over the component budgets so the
            # next slow round inherits consistent public counters.
            $maxFailures=0;$maxAttempts=0;$earliestCooldown=$null;$earliestTick=[long]::MaxValue
            $fastBudgets=Value $runtime 'componentBudgets' $null
            if($fastBudgets){ foreach($entry in $fastBudgets.PSObject.Properties){
              $value=[int](Value $entry.Value 'attempts' 0); if($value -gt $maxAttempts){$maxAttempts=$value}
              $value=[int](Value $entry.Value 'failures' 0); if($value -gt $maxFailures){$maxFailures=$value}
              $cooldown=Value $entry.Value 'cooldownUntil' $null
              if($null -ne $cooldown){ try {
                $tick=(Get-GuardianInstant $cooldown).UtcTicks
                if($tick -lt $earliestTick){$earliestCooldown=$cooldown;$earliestTick=$tick}
              } catch { } } } }
            $runtime | Add-Member -NotePropertyName failures -NotePropertyValue $maxFailures -Force
            $runtime | Add-Member -NotePropertyName attempts -NotePropertyValue $maxAttempts -Force
            $runtime | Add-Member -NotePropertyName cooldownUntil -NotePropertyValue $earliestCooldown -Force
            Write-GuardianJson $runtimePath $runtime
            $status=$saved
            $status.phase='repairing'; $status.summary='正在恢复本地桥接服务'
            $status.lastRepairAt=[datetime]::UtcNow.ToString('o')
            $status.heartbeatAt=$status.lastRepairAt
            $status.nextCheckAt=[datetime]::UtcNow.AddSeconds(15).ToString('o')
            $status.attempts=$maxAttempts
            $script:workerStatus=$status
            Write-GuardianJson $statusPath $status
            $outcome='requested';$message='已执行恢复，等待下一次独立检测确认'
            try {
              $result=Invoke-GuardianChild -Executable $hostPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'mobile-link-control.ps1'),'-Action','GuardianRepair','-GuardianStage','restart_services','-GuardianComponents','bridge','-BridgePort',"$BridgePort") -TimeoutSeconds 270
              if ((Value $result 'skipped' $false) -eq $true) {$outcome='skipped';$message='守护已关闭或链路已停止，取消待执行恢复'}
            } catch {$outcome='unconfirmed';$message='恢复未确认完成，将按下一次检测结果处理'}
            $status.history=@(@(@($status.history)+@(@{at=[datetime]::UtcNow.ToString('o');action='restart_services';outcome=$outcome;message=$message})) | Select-Object -Last 20)
            $status.heartbeatAt=[datetime]::UtcNow.ToString('o')
            $started=[datetime]::UtcNow
            $status.nextCheckAt=$started.AddSeconds(15).ToString('o')
            $status.summary=$message
            Write-GuardianJson $statusPath $status
          } else { $fastBridgeRepair=$false }
        }
        if ((Value $config 'enabled' $false) -eq $true -and -not (Test-MobileLinkPaused $repo)) {
          $voice=Get-MobileVoiceTunnelStatus $repo
          $diagnostics=Invoke-GuardianChild -Executable (Get-Command node -ErrorAction Stop).Source -Arguments @((Join-Path $PSScriptRoot 'mobile-link-diagnostics.mjs'),'--port',"$BridgePort",'--paused','false','--voice-state',([string](Value $voice 'state' 'unverified')),'--guardian-json') -TimeoutSeconds 60
          # Persist the successful child output verbatim plus checkedAt (the
          # only worker-added field) for read-only consumers. A failed,
          # timed-out or unparseable round leaves the previous snapshot in
          # place so it can age out; it is never deleted here.
          $snapshot=$diagnostics | Select-Object -Property *
          Add-Member -InputObject $snapshot -NotePropertyName checkedAt -NotePropertyValue ([datetime]::UtcNow.ToString('o')) -Force
          Write-GuardianJson $diagnosticsPath $snapshot
        }
        if ($probed -and -not $fastBridgeRepair) { $runtime | Add-Member -NotePropertyName bridgeQuickStreak -NotePropertyValue ([int]$bridgeProbeFailures) -Force }
        if (-not $fastBridgeRepair) {
        $config=Get-GuardianConfig
        $input=@{config=$config;state=$runtime;diagnostics=$diagnostics;paused=(Test-MobileLinkPaused $repo);now=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 12 -Compress
        $decision=Invoke-GuardianChild -Executable (Get-Command node -ErrorAction Stop).Source -Arguments @((Join-Path $PSScriptRoot 'mobile-link-guardian-policy.mjs')) -InputJson $input -TimeoutSeconds 10
        $runtime=$decision.state
        $runtime | Add-Member -NotePropertyName configUpdatedAt -NotePropertyValue (Value $config 'updatedAt') -Force
        $status=$decision.status
        $status.history=@(@(Value $saved 'history' @()) | Select-Object -Last 19)
        $script:workerStatus=$status
        Write-GuardianJson $statusPath $status
        Write-GuardianJson $runtimePath $runtime
        if ($decision.action -and (Value (Get-GuardianConfig) 'enabled' $false) -eq $true -and -not (Test-MobileLinkPaused $repo)) {
          $outcome='requested';$message='已执行恢复，等待下一次独立检测确认'
          try {
            $result=Invoke-GuardianChild -Executable $hostPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'mobile-link-control.ps1'),'-Action','GuardianRepair','-GuardianStage',([string]$decision.action.stage),'-GuardianComponents',(@($decision.action.components) -join ','),'-BridgePort',"$BridgePort") -TimeoutSeconds 270
            if ((Value $result 'skipped' $false) -eq $true) {$outcome='skipped';$message='守护已关闭或链路已停止，取消待执行恢复'}
          } catch {$outcome='unconfirmed';$message='恢复未确认完成，将按下一次检测结果处理'}
          $status.history=@(@(@($status.history)+@(@{at=[datetime]::UtcNow.ToString('o');action=$decision.action.stage;outcome=$outcome;message=$message})) | Select-Object -Last 20)
          $status.heartbeatAt=[datetime]::UtcNow.ToString('o')
          $started=[datetime]::UtcNow
          $status.nextCheckAt=$started.AddSeconds(15).ToString('o')
          $status.summary=$message
          Write-GuardianJson $statusPath $status
        }
        }
      } catch {
        $status=Get-GuardianStatus
        if ($status.enabled -and -not (Test-MobileLinkPaused $repo)) { $status.phase='needs_attention';$status.summary='守护检测暂时不可用，等待下次检测；未执行新的恢复' }
        $status.heartbeatAt=[datetime]::UtcNow.ToString('o');$status.nextCheckAt=[datetime]::UtcNow.AddSeconds(15).ToString('o')
        Write-GuardianJson $statusPath $status
      }
      if ($Once -or (Value (Get-GuardianConfig) 'enabled' $false) -ne $true) { break }
      $remaining=[Math]::Max(0,15000-([datetime]::UtcNow-$started).TotalMilliseconds)
      if ($remaining -gt 0) {Start-Sleep -Milliseconds ([int]$remaining)}
    } while ($true)
  } finally {if($workerOwns){$workerGate.ReleaseMutex()};$workerGate.Dispose()}
} catch {
  # A launcher failure is distinct from a diagnostic failure. Persist only a
  # fixed public message, never native exception text or command arguments.
  $status=Get-GuardianStatus
  if ($status.enabled) {$status.phase='needs_attention';$status.summary='自动守护后台未启动，请检查 Windows 计划任务后重试'}
  try { Write-GuardianJson $statusPath $status } catch { }
  @{guardian=$status} | ConvertTo-Json -Depth 10 -Compress
  exit 1
}
