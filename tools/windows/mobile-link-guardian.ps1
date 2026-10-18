[CmdletBinding()]
param(
  [ValidateSet('Status','Enable','Disable','Ensure','Run')][string]$Action='Status',
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
  param([bool]$Enabled,[string]$ExpectedUpdatedAt='')
  $gate=New-MobileLinkMutex ($repo+'\guardian-config');$owns=$false
  try {
    try {$owns=$gate.WaitOne(1000)}catch [Threading.AbandonedMutexException]{$owns=$true}
    if(-not $owns){throw 'Guardian config busy'}
    if($ExpectedUpdatedAt){
      $current=Value (Get-GuardianConfig) 'updatedAt'
      if(-not $current -or ([datetimeoffset]$current).UtcTicks -ne ([datetimeoffset]$ExpectedUpdatedAt).UtcTicks){return $null}
    }
    $updated=[datetime]::UtcNow.ToString('o')
    Write-GuardianJson $configPath @{version=1;enabled=$Enabled;allowForceRestart=$true;updatedAt=$updated}
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
  [pscustomobject]@{version=1;enabled=$enabled;phase=$phase;summary=$summary
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
    ($stdout.Result | ConvertFrom-Json)
  } finally { $process.Dispose() }
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
    $pending=Set-GuardianConfig -Enabled $false
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
        if ((Value $config 'enabled' $false) -eq $true -and -not (Test-MobileLinkPaused $repo)) {
          $voice=Get-MobileVoiceTunnelStatus $repo
          $diagnostics=Invoke-GuardianChild -Executable (Get-Command node -ErrorAction Stop).Source -Arguments @((Join-Path $PSScriptRoot 'mobile-link-diagnostics.mjs'),'--port',"$BridgePort",'--paused','false','--voice-state',([string](Value $voice 'state' 'unverified')),'--guardian-json') -TimeoutSeconds 60
        }
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
