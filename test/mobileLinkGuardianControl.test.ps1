$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# The controller pins UTF-8 output and ConvertTo-Json leaves native text
# unescaped; a harness decoding child stdout with the OEM code page mangles
# the Chinese diagnostics and can even swallow closing quotes, so read the
# children back as UTF-8 before any ConvertFrom-Json.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-guardian-control-test-'+[guid]::NewGuid().ToString('N'))
$hostPath=(Get-Process -Id $PID).Path
$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  foreach($dir in @('tools\windows','tools\harmony','scripts','src','logs\state','HarmonyCodexRemote\entry\src\main\ets\config')){New-Item -ItemType Directory -Force (Join-Path $root $dir)|Out-Null}
  foreach($file in @('mobile-link-control.ps1','mobile-link-operation.ps1','mobile-link-lifecycle.ps1','mobile-link-guardian.ps1','mobile-voice-tunnel.ps1')){Copy-Item (Join-Path $repo ('tools\windows\'+$file)) (Join-Path $root ('tools\windows\'+$file))}
  @'
export const DEFAULT_BRIDGE_TOKEN: string = 'mock-only';
export const DEFAULT_BRIDGE_URL: string = 'http://example.invalid';
'@|Set-Content (Join-Path $root 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets') -Encoding utf8
  @'
param(
  [string]$Phase,
  [string]$TrackResultFile,
  [int]$BridgePort,
  [string]$BridgeUrl,
  [string]$RuntimeMode,
  [string]$ConfigPath,
  [string]$BridgeToken,
  [string]$BridgeTotpSecret,
  [string]$BridgePublicUrl,
  [string]$CanaryThreadIds,
  [string]$LinkControlVersion,
  [switch]$GuardianRepair,
  [string]$GuardianConfigVersion,
  [switch]$SkipCodexDesktop,
  [switch]$KeepExistingCodex,
  [switch]$SkipHdcRelay
)
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
$ErrorActionPreference='Stop'
# Scoped guardian recovery forks only the Background sub-phase (watchdogs,
# voice, HDC) outside the lifecycle gate; the controller launches the bridge
# directly, so this track must never rerun the full bootstrap. -SkipHdcRelay
# stays bound for old-style foreground callers only.
if($Phase -ne 'Background'){throw 'Scoped recovery must not rerun the full bootstrap'}
if(-not (Test-MobileLinkGuardianEnabled $root)){throw 'Guardian config was not inherited'}
if(-not $SkipCodexDesktop -or -not $KeepExistingCodex){throw 'Scoped bridge bootstrap leaked into other components'}
# Touching neither desktop, HDC nor the bridge: this fixture starts nothing,
# marks the scoped handoff and returns; the controller owns the bridge process.
[IO.File]::WriteAllText((Join-Path $root 'track-ok.txt'),'background')
exit 0
'@|Set-Content (Join-Path $root 'scripts\start-codex-mobile-stack.ps1') -Encoding utf8
  @'
const http=require('http');
const fs=require('fs'),path=require('path');
// The controller launches the bridge directly: the port arrives through the
// CODEX_BRIDGE_PORT environment variable and argv[2] is only the unparsed
// workspace ownership marker.
const port=Number(process.env.CODEX_BRIDGE_PORT);
if(!Number.isFinite(port)){process.exit(2);}
const root=path.dirname(__dirname);
http.createServer((q,r)=>{
  r.setHeader('Content-Type','application/json');
  // Shapes are exactly what the controller fast probe reads: health ok with
  // desktop runtime mode, live desktop status and a non-null sessions list.
  // sessions-mode.txt flips the session endpoint for probe verdict regression:
  // 'empty' serves a bare cold-start list, 'reject' answers 401.
  if(q.url==='/health') r.end(JSON.stringify({ok:true,runtime:{mode:'desktop'}}));
  else if(q.url==='/desktop/live/status') r.end(JSON.stringify({desktop:{desktopLive:true,desktopProcessMode:'remote_debug',cdpPort:12345}}));
  else if(q.url.indexOf('/codex/sessions')===0){
    let mode='full';
    try{ mode=fs.readFileSync(path.join(root,'sessions-mode.txt'),'utf8').trim(); }catch(e){}
    if(mode==='empty') r.end(JSON.stringify({sessions:[]}));
    else if(mode==='reject'){ r.statusCode=401; r.end(JSON.stringify({error:'unauthorized'})); }
    else r.end(JSON.stringify({sessions:[{id:'fixture-session',title:'fixture'}],total:1}));
  }
  else r.end(JSON.stringify({ok:true}));
}).listen(port,'127.0.0.1');
'@|Set-Content (Join-Path $root 'src\server.js') -Encoding utf8
  @{version=1;enabled=$true;allowForceRestart=$true;updatedAt='2026-10-18T00:00:00Z'}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  . (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$reservation.Start();$port=$reservation.LocalEndpoint.Port;$reservation.Stop()
  $result=(& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action GuardianRepair -GuardianStage restart_services -GuardianComponents bridge -BridgePort $port) | ConvertFrom-Json
  Assert ($LASTEXITCODE -eq 0 -and $result.accepted) 'Scoped recovery did not complete'
  Assert ((Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2).ok) 'Actual scoped bootstrap must start mock service while watchers are suppressed'
  # The track fork is best-effort inside the controller, so a broken contract
  # would only surface in background-track.log. The marker proves the fork ran
  # with the scoped Background binding (a param mismatch never writes it).
  $trackDeadline=[datetime]::UtcNow.AddSeconds(10)
  while(-not (Test-Path (Join-Path $root 'track-ok.txt')) -and [datetime]::UtcNow -lt $trackDeadline){Start-Sleep -Milliseconds 50}
  Assert ((Get-Content (Join-Path $root 'track-ok.txt') -Raw -ErrorAction SilentlyContinue) -eq 'background') 'Background track must fork with scoped flags while the gate is held'
  # Fast-probe verdict regression against the running mock, with the probe
  # functions extracted verbatim from the controller: an empty session list is
  # session readiness (cold start), a rejected endpoint is not.
  $probeTokens=$null;$probeErrors=$null
  $probeAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'tools\windows\mobile-link-control.ps1'),[ref]$probeTokens,[ref]$probeErrors)
  Assert ($probeErrors.Count -eq 0) 'Controller must parse for fast-probe extraction'
  foreach($probeFn in @('Get-LinkValue','Get-LinkHeaders','Get-LinkTotpCode','Get-LinkFastProbe')){
    $found=$probeAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $probeFn},$true)
    & ([scriptblock]::Create($found.Extent.Text.Replace("function $probeFn","function script:$probeFn")))
  }
  $bridgeUrl='http://127.0.0.1:'+$port
  $script:linkTotpKey=$null # controller initializes this at script scope; extracted probe expects it under StrictMode
  Set-Content -LiteralPath (Join-Path $root 'sessions-mode.txt') -Value 'empty' -Encoding utf8
  $probe=Get-LinkFastProbe
  Assert ($probe.healthOk -and $probe.desktopLive -and $probe.sessionsReady) 'Empty session list must count as session readiness'
  Set-Content -LiteralPath (Join-Path $root 'sessions-mode.txt') -Value 'reject' -Encoding utf8
  $probe=Get-LinkFastProbe
  Assert (-not $probe.sessionsReady) 'Rejected session endpoint must not claim session readiness'
  Remove-Item -LiteralPath (Join-Path $root 'sessions-mode.txt') -ErrorAction SilentlyContinue
  $probe=Get-LinkFastProbe
  Assert ($probe.sessionsReady) 'Default mock session payload must satisfy the fast probe'
  # Maintain diagnostics sourcing: a fresh guardian snapshot must replace the
  # self node probe; a stale one or a disabled guardian must fall back to the
  # self probe and record the reason. The fixture copies no
  # mobile-link-diagnostics.mjs, so the self probe ends in the controller's
  # structured unknown fallback — diagnostics.source='self' proves the
  # fallback branch was chosen rather than a successful probe.
  $snapshotPath=Join-Path $root 'logs\state\mobile-link-guardian-diagnostics.json'
  $snapshotFixture=@{
    checkedAt=[datetime]::UtcNow.ToString('o');severity='healthy';summary='守护快照检测通过';nextAction='none';restartRequired=$false
    checks=@(
      @{id='bridge';title='本地桥接';state='ready';message='快照-桥接'}
      @{id='desktop';title='Codex 桌面连接';state='ready';message='快照-桌面'}
      @{id='companion';title='个人助手会话';state='ready';message='快照-助手'}
    )
    guardianSignals=@{faults=@()}
  }
  function Invoke-Maintain {
    ((& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action Maintain -BridgePort $script:port) -join "`n") | ConvertFrom-Json
  }
  $snapshotFixture|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $snapshotPath -Encoding utf8
  $maintained=Invoke-Maintain
  Assert ($maintained.diagnostics.source -eq 'guardian') 'Maintain must consume a fresh guardian snapshot'
  # checkedAt rides through two JSON conversions (controller out, harness in),
  # each coercing the ISO string into a [datetime]; compare the UTC instants,
  # never wall-clock values, or the 8-hour offset trap flunks the assert.
  Assert ([datetimeoffset]::new($maintained.diagnostics.checkedAt.ToUniversalTime()).UtcDateTime -eq [datetimeoffset]::Parse([string]$snapshotFixture.checkedAt).UtcDateTime) 'Guardian diagnostics must carry the snapshot checkedAt'
  Assert (@($maintained.diagnostics.checks|Where-Object{$_.id -eq 'companion' -and $_.message -eq '快照-助手'}).Count -eq 1) 'Snapshot checks must flow into the status diagnostics'
  Assert (@($maintained.diagnostics.checks|Where-Object{$_.id -eq 'phone_debug'}).Count -eq 1) 'Cheap HDC check must stay computed locally on top of the snapshot'
  $snapshotFixture.checkedAt=[datetime]::UtcNow.AddMinutes(-2).ToString('o')
  $snapshotFixture|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $snapshotPath -Encoding utf8
  $stale=Invoke-Maintain
  Assert ($stale.diagnostics.source -eq 'self') 'A stale snapshot must fall back to the self probe'
  Assert ((Get-Content (Join-Path $root 'logs\startup\manager.events.log') -Raw) -match 'diagnostics-snapshot-fallback reason=stale') 'Stale fallback must record its reason'
  $snapshotFixture.checkedAt=[datetime]::UtcNow.ToString('o')
  $snapshotFixture|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $snapshotPath -Encoding utf8
  @{version=1;enabled=$false;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  $disabled=Invoke-Maintain
  Assert ($disabled.diagnostics.source -eq 'self') 'A disabled guardian must fall back to the self probe'
  Assert ((Get-Content (Join-Path $root 'logs\startup\manager.events.log') -Raw) -match 'diagnostics-snapshot-fallback reason=guardian-disabled') 'Disabled fallback must record its reason'
  @{version=1;enabled=$true;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
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
