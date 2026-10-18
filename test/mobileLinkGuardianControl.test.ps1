$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-guardian-control-test-'+[guid]::NewGuid().ToString('N'))
$hostPath=(Get-Process -Id $PID).Path
$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  foreach($dir in @('tools\windows','tools\harmony','scripts','src','logs\state','HarmonyCodexRemote\entry\src\main\ets\config')){New-Item -ItemType Directory -Force (Join-Path $root $dir)|Out-Null}
  foreach($file in @('mobile-link-control.ps1','mobile-link-lifecycle.ps1','mobile-link-guardian.ps1','mobile-voice-tunnel.ps1')){Copy-Item (Join-Path $repo ('tools\windows\'+$file)) (Join-Path $root ('tools\windows\'+$file))}
  @'
export const DEFAULT_BRIDGE_TOKEN: string = 'mock-only';
export const DEFAULT_BRIDGE_URL: string = 'http://example.invalid';
'@|Set-Content (Join-Path $root 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets') -Encoding utf8
  @'
param($BridgePort,[switch]$SkipCodexDesktop,[switch]$KeepExistingCodex,[switch]$SkipHdcRelay)
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
if(-not $SkipCodexDesktop -or -not $KeepExistingCodex -or -not $SkipHdcRelay){throw 'Scoped bridge bootstrap leaked into other components'}
# Taking a watcher cycle here would self-lock or be suppressed by guardian.
# Real bootstrap owns a direct start path and must remain usable in this mode.
if(-not (Test-MobileLinkGuardianEnabled $root)){throw 'Guardian config was not inherited'}
Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"'+(Join-Path $root 'src\server.js')+'"'),"$BridgePort") -WindowStyle Hidden | Out-Null
$deadline=[datetime]::UtcNow.AddSeconds(8)
do {try{$result=Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 1;if($result.ok){exit 0}}catch{};Start-Sleep -Milliseconds 100}while([datetime]::UtcNow -lt $deadline)
exit 1
'@|Set-Content (Join-Path $root 'scripts\start-codex-mobile-stack.ps1') -Encoding utf8
  "require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true}))).listen(Number(process.argv[2]),'127.0.0.1');"|Set-Content (Join-Path $root 'src\server.js') -Encoding utf8
  @{version=1;enabled=$true;allowForceRestart=$true;updatedAt='2026-10-18T00:00:00Z'}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  . (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$reservation.Start();$port=$reservation.LocalEndpoint.Port;$reservation.Stop()
  $result=(& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action GuardianRepair -GuardianStage restart_services -GuardianComponents bridge -BridgePort $port) | ConvertFrom-Json
  Assert ($LASTEXITCODE -eq 0 -and $result.accepted) 'Scoped recovery did not complete'
  Assert ((Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2).ok) 'Actual scoped bootstrap must start mock service while watchers are suppressed'
  $queueGate=New-MobileLinkMutex $root;$null=$queueGate.WaitOne(0)
  $info=[Diagnostics.ProcessStartInfo]::new($hostPath)
  $info.Arguments='-NoProfile -File "'+(Join-Path $root 'tools\windows\mobile-link-control.ps1')+'" -Action Repair -RestartDesktop -GuardianRepair -ScheduledRepairWorker -BridgePort '+$port
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $queued=[Diagnostics.Process]::Start($info)
  try {
    Start-Sleep -Milliseconds 600
    @{version=1;enabled=$false;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
    $queueGate.ReleaseMutex();$queueGate.Dispose();$queueGate=$null
    Assert ($queued.WaitForExit(10000)) 'Queued repair must finish after disabling'
    $cancelled=$queued.StandardOutput.ReadToEnd()|ConvertFrom-Json
    Assert ($cancelled.skipped) 'Repair must recheck enabled policy after acquiring mutex'
  } finally {if($queueGate){$queueGate.ReleaseMutex();$queueGate.Dispose()};$queued.Dispose()}
  @{version=1;enabled=$true;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  Set-MobileLinkDesiredState -Repo $root -State stopped
  $result=(& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action Repair -RestartDesktop -GuardianRepair -ScheduledRepairWorker -BridgePort $port) | ConvertFrom-Json
  Assert ($result.skipped -and (Test-MobileLinkPaused $root)) 'Queued strong recovery must preserve manual stop before invoking desktop scripts'
  Set-MobileLinkDesiredState -Repo $root -State running
  @{version=1;enabled=$false;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  $result=(& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action Repair -RestartDesktop -GuardianRepair -ScheduledRepairWorker -BridgePort $port) | ConvertFrom-Json
  Assert ($result.skipped) 'Disable must cancel scheduled strong recovery'
  # Exercise Enable/Ensure with scheduler APIs mocked inside this PowerShell;
  # no real task registration or startup occurs in acceptance tests.
  function Get-ScheduledTask {param($TaskName,$ErrorAction) $null}
  function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) $global:guardianFixtureTaskArgs=$Argument;@{Execute=$Execute}}
  function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) @{}}
  function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$RestartCount,$RestartInterval) @{}}
  function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User) @{}}
  function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings,$Trigger,[switch]$Force) $global:guardianFixtureRegistered=$true}
  function Start-ScheduledTask {param($TaskName) $global:guardianFixtureTaskStarted=$true}
  $global:guardianFixtureRegistered=$false;$global:guardianFixtureTaskStarted=$false;$global:guardianFixtureTaskArgs=''
  # An already running script keeps its old in-memory functions even after its
  # file is replaced. Enable must replace that monitor, preserving the service.
  $watchPath=Join-Path $root 'tools\harmony\watch-local-bridge.ps1'
  @'
param($BridgePort,$RuntimeMode)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
function Enter-MobileLinkCycle {param($Repo) $gate=New-MobileLinkMutex $Repo;if(-not $gate.WaitOne(0)){$gate.Dispose();return $null};$gate}
[IO.File]::WriteAllText((Join-Path $root 'watch-loaded.txt'),'old')
while($true){$gate=Enter-MobileLinkCycle $root;if($gate){Exit-MobileLinkCycle $gate};Start-Sleep -Milliseconds 100}
'@|Set-Content $watchPath -Encoding utf8
  $oldWatcher=Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-File',('"'+$watchPath+'"')) -WindowStyle Hidden -PassThru
  $deadline=[datetime]::UtcNow.AddSeconds(5)
  while(-not (Test-Path (Join-Path $root 'watch-loaded.txt')) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
  Assert ((Get-Content (Join-Path $root 'watch-loaded.txt') -Raw) -eq 'old') 'Legacy watcher fixture must have loaded old functions'
  @'
param($BridgePort,$RuntimeMode)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
[IO.File]::WriteAllText((Join-Path $root 'watch-loaded.txt'),'new')
while($true){$gate=Enter-MobileLinkCycle $root;if($gate){Exit-MobileLinkCycle $gate};Start-Sleep -Milliseconds 100}
'@|Set-Content $watchPath -Encoding utf8
  $bridgeOwner=@(Get-NetTCPConnection -LocalPort $port -State Listen)[0].OwningProcess
  $enableTimer=[Diagnostics.Stopwatch]::StartNew()
  $enabled=(& (Join-Path $root 'tools\windows\mobile-link-guardian.ps1') -Action Enable)|ConvertFrom-Json
  $enableTimer.Stop()
  Assert ($enableTimer.Elapsed.TotalSeconds -lt 25) 'Enable handoff must fit the existing bounded CLI/API operation'
  Assert ($enabled.guardian.enabled -and $global:guardianFixtureRegistered -and $global:guardianFixtureTaskStarted) ('Enable must persist and ensure independent worker: '+($enabled|ConvertTo-Json -Compress)+' registered='+$global:guardianFixtureRegistered+' started='+$global:guardianFixtureTaskStarted)
  Assert ($global:guardianFixtureTaskArgs -match '--headless .* -Action Run' -and $global:guardianFixtureTaskArgs.Contains($root)) 'Worker must use independent headless scheduler entrypoint with its own checkout'
  $config=Get-Content -Raw (Join-Path $root 'logs\state\mobile-link-guardian-config.json')|ConvertFrom-Json
  Assert ($config.allowForceRestart -eq $true) 'Enable must retain the explicitly authorized strong restart policy'
  Assert ($oldWatcher.HasExited) 'Enable must stop the old in-memory watcher'
  $oldWatcher.Dispose()
  $deadline=[datetime]::UtcNow.AddSeconds(5)
  while((Get-Content (Join-Path $root 'watch-loaded.txt') -Raw) -ne 'new' -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
  Assert ((Get-Content (Join-Path $root 'watch-loaded.txt') -Raw) -eq 'new') 'Enable must launch the updated watcher code'
  Assert (@(Get-NetTCPConnection -LocalPort $port -State Listen)[0].OwningProcess -eq $bridgeOwner) 'Watcher handoff must preserve the actual bridge process'
  Assert ((Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2).ok) 'Mobile bridge must remain healthy after watcher handoff'
  $disabled=(& (Join-Path $root 'tools\windows\mobile-link-guardian.ps1') -Action Disable)|ConvertFrom-Json
  Assert (-not $disabled.guardian.enabled) 'Disable must persist across CLI invocations'
  # Force handoff failure before scheduler code, proving Enable cannot leave a
  # committed enabled flag or launch a background worker on a failed upgrade.
  @'
param($Action,$BridgePort)
@{reloaded=$false}|ConvertTo-Json -Compress
'@|Set-Content (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Encoding utf8
  $global:guardianFixtureTaskStarted=$false
  $failed=(& (Join-Path $root 'tools\windows\mobile-link-guardian.ps1') -Action Enable)|ConvertFrom-Json
  Assert (-not $failed.guardian.enabled -and -not $global:guardianFixtureTaskStarted) 'Failed handoff must remain disabled and never start the worker'
  Write-Output ('PASS: '+$checks+' isolated guardian controller and scheduler checks')
} finally {
  . (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
  Stop-MobileLinkOwnedProcesses -Repo $root | Out-Null
  $resolved=[IO.Path]::GetFullPath($root)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'mobile-link-guardian-control-test-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
