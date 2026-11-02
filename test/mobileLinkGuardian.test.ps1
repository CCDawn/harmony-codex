$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-guardian-test-'+[guid]::NewGuid().ToString('N'))
$hostPath=(Get-Process -Id $PID).Path
$checks=0
function Assert([bool]$Condition,[string]$Message) {if(-not $Condition){throw $Message};$script:checks++}
# Mock local bridge on a random loopback port: /health answers ok=true only
# while bridge-up.txt exists, so the worker's cheap probe can be driven by files.
$probeListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$probeListener.Start()
$bridgePort=$probeListener.LocalEndpoint.Port
$engine=[powershell]::Create()
$null=$engine.AddScript({
  param($Listener,$Root)
  while($true){
    try{$client=$Listener.AcceptTcpClient()}catch{break}
    try{
      $stream=$client.GetStream()
      $reader=[IO.StreamReader]::new($stream)
      while($true){$line=$reader.ReadLine();if([string]::IsNullOrEmpty($line)){break}}
      $body='{"ok":false,"runtime":{"mode":"desktop"}}'
      if([IO.File]::Exists((Join-Path $Root 'bridge-up.txt'))){$body='{"ok":true,"runtime":{"mode":"desktop"}}'}
      $bytes=[Text.Encoding]::UTF8.GetBytes($body)
      $writer=[IO.StreamWriter]::new($stream)
      $writer.Write("HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n$body")
      $writer.Flush();$writer.Dispose()
    }catch{ }finally{$client.Dispose()}
  }
}).AddArgument($probeListener).AddArgument($root)
$engineHandle=$engine.BeginInvoke()
function Guardian([string]$Action,[switch]$Once) {
  $arguments=@('-NoProfile','-File',(Join-Path $root 'tools\windows\mobile-link-guardian.ps1'),'-Action',$Action,'-BridgePort',"$bridgePort")
  if($Once){$arguments+='-Once'}
  $output=& $hostPath @arguments
  if($LASTEXITCODE -ne 0){throw ('Guardian CLI failed: '+($output -join ' '))}
  if($output){($output -join "`n")|ConvertFrom-Json}
}
function Tick { $null=Guardian Run -Once; (Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-status.json')|ConvertFrom-Json) }
function Runtime { Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-runtime.json')|ConvertFrom-Json }
function Snapshot { Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-diagnostics.json')|ConvertFrom-Json }
function SnapshotStamp {
  # checkedAt survives ConvertFrom-Json only as a DateTime; assert the wire
  # format on the raw snapshot text instead.
  $raw=Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-diagnostics.json')
  if($raw -match '"checkedAt":"([^"]+)"'){[datetimeoffset]::Parse($Matches[1])}else{throw 'Snapshot checkedAt is missing'}
}
function RepairCount { $path=Join-Path $root 'repair-actions.txt'; if(Test-Path $path){@(Get-Content -LiteralPath $path).Count}else{0} }
function Write-Config([bool]$Enabled) {
  @{version=1;enabled=$Enabled;allowForceRestart=$true;updatedAt='2026-10-18T00:00:00Z'}|ConvertTo-Json|Set-Content (Join-Path $root 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
}
try {
  foreach($dir in @('tools\windows','tools\harmony','logs\state')){New-Item -ItemType Directory -Force (Join-Path $root $dir)|Out-Null}
  foreach($file in @('mobile-link-guardian.ps1','mobile-link-guardian-policy.mjs','mobile-link-lifecycle.ps1')){Copy-Item (Join-Path $repo ('tools\windows\'+$file)) (Join-Path $root ('tools\windows\'+$file))}
  @'
function Get-MobileVoiceTunnelStatus { param($Repo) [pscustomobject]@{state='unverified'} }
'@|Set-Content (Join-Path $root 'tools\windows\mobile-voice-tunnel.ps1') -Encoding utf8
  @'
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(fs.existsSync(path.join(root,'probe-delay.txt')))await new Promise(r=>setTimeout(r,1500));
const healthy=fs.existsSync(path.join(root,'healthy.txt'));
const component=(fs.existsSync(path.join(root,'fault-component.txt'))?fs.readFileSync(path.join(root,'fault-component.txt'),'utf8'):'bridge').trim()||'bridge';
const manual=fs.existsSync(path.join(root,'manual-fault.txt'));
const faults=healthy?[]:[{id:component,component,kind:'transport',repairable:true}];
if(manual)faults.push({id:'companion',component:'companion',kind:'auth',repairable:false});
console.log(JSON.stringify({severity:healthy?'unverified':'degraded',summary:healthy?'mock ok':'mock fault',nextAction:healthy?'none':'safe_repair',restartRequired:false,checks:[{id:component,title:'mock',state:healthy?'ready':'error',message:'mock'}],guardianSignals:{faults}}));
'@|Set-Content (Join-Path $root 'tools\windows\mobile-link-diagnostics.mjs') -Encoding utf8
  @'
param($Action,$GuardianStage,$GuardianComponents,$BridgePort)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Add-Content (Join-Path $root 'repair-actions.txt') $GuardianStage
if($GuardianStage -eq 'restart_services' -and (Test-Path (Join-Path $root 'repair-enabled.txt'))){
  [IO.File]::WriteAllText((Join-Path $root 'healthy.txt'),'mock bridge booted directly')
  [IO.File]::WriteAllText((Join-Path $root 'bridge-up.txt'),'mock probe target up')
}
@{accepted=$true}|ConvertTo-Json -Compress
'@|Set-Content (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Encoding utf8
  Set-Content (Join-Path $root 'fault-component.txt') 'bridge' -Encoding utf8
  Set-Content (Join-Path $root 'repair-enabled.txt') '1' -Encoding utf8
  $status=Guardian Status
  Assert (-not $status.guardian.enabled -and $status.guardian.phase -eq 'disabled') 'Missing config must default off'
  . (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
  Write-Config $true
  $gate=Enter-MobileLinkCycle $root
  Assert ($null -eq $gate) 'Legacy watcher must yield to enabled guardian'
  # Fast bridge channel: two cheap-probe failures must repair without policy.
  $first=Tick
  Assert ($first.phase -eq 'suspect' -and $first.attempts -eq 0) 'First probe failure must not repair'
  Assert (-not (Test-Path (Join-Path $root 'repair-actions.txt'))) 'A single probe failure must not repair'
  $snap=Snapshot
  $snapshotFields=((@($snap.PSObject.Properties.Name)|Sort-Object) -join ',')
  Assert ($snapshotFields -eq 'checkedAt,checks,guardianSignals,nextAction,restartRequired,severity,summary') 'Snapshot must carry exactly the consumer contract fields'
  $snapRaw=Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-diagnostics.json')
  Assert ($snapRaw -match '"checkedAt":"\d{4}-\d{2}-\d{2}T[\d:.]+Z"') 'Snapshot checkedAt must be UTC with a Z suffix'
  $stamp=SnapshotStamp
  Assert ($stamp.Offset -eq [timespan]::Zero) 'Snapshot checkedAt must parse as UTC'
  Assert (@($snap.checks).Count -ge 1 -and @($snap.checks)[0].id) 'Snapshot checks must be a populated array'
  Assert ($null -ne $snap.guardianSignals) 'Snapshot must carry guardianSignals verbatim'
  $second=Tick
  Assert ($second.phase -eq 'repairing' -and (Get-Content (Join-Path $root 'repair-actions.txt') -Raw).Trim() -eq 'restart_services') 'Two probe failures must request the fast bridge restart_services repair'
  $runtime=Runtime
  Assert ($runtime.componentBudgets.bridge.attempts -eq 1) 'Fast repair must consume one bridge attempt'
  Assert ($runtime.bridgeQuickStreak -eq 0) 'Fast trigger must clear the probe streak'
  Assert ((Test-Path (Join-Path $root 'healthy.txt')) -and (Test-Path (Join-Path $root 'bridge-up.txt'))) 'Fast repair must boot the mock bridge'
  Assert ($second.history[-1].action -eq 'restart_services') 'Fast repair must record its history event'
  $third=Tick
  Assert ($third.phase -eq 'healthy' -and $third.attempts -eq 1) 'Healthy probe must retain the attempt budget until a second confirmation'
  $beforeStamp=(SnapshotStamp).UtcTicks
  $fourth=Tick
  Assert ($fourth.phase -eq 'healthy' -and $fourth.attempts -eq 0) 'Two healthy probes must confirm stable recovery'
  Assert ((SnapshotStamp).UtcTicks -gt $beforeStamp) 'Snapshot must refresh on every successful diagnostic round'
  # Manual faults (repairable:false) must stand the fast path down entirely:
  # probe failures may not trigger restart_services while one is persisted.
  Set-Content (Join-Path $root 'manual-fault.txt') 'auth' -Encoding utf8
  Remove-Item (Join-Path $root 'healthy.txt'),(Join-Path $root 'bridge-up.txt') -ErrorAction SilentlyContinue
  $null=Tick
  Assert ((RepairCount) -eq 1) 'Manual-fault round one must not add a repair'
  $manualTick=Tick
  Assert ((RepairCount) -eq 1) 'Manual fault must block the fast restart_services repair'
  Assert ($manualTick.phase -eq 'needs_attention') 'Manual fault must surface needs_attention without any repair'
  $manualRuntime=Runtime
  Assert ([int]$manualRuntime.componentBudgets.bridge.attempts -eq 0) 'Gated fast path must not consume the bridge budget'
  Remove-Item (Join-Path $root 'manual-fault.txt')
  Remove-Item (Join-Path $root 'repair-actions.txt') -ErrorAction SilentlyContinue
  # Cooldown coordination across the fast and slow paths.
  Remove-Item (Join-Path $root 'healthy.txt'),(Join-Path $root 'bridge-up.txt'),(Join-Path $root 'repair-actions.txt') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $root 'repair-enabled.txt')
  $null=Tick
  Assert ((RepairCount) -eq 0) 'Cooldown scenario starts from a fault-confirming round'
  $null=Tick
  Assert ((RepairCount) -eq 1) 'Second probe failure must fast-repair again'
  $null=Tick
  Assert ((RepairCount) -eq 2) 'A short probe streak must hand the round back to policy'
  $null=Tick
  Assert ((RepairCount) -eq 3) 'The fast path must consume its third attempt'
  $cooling=Tick
  $runtime=Runtime
  Assert ($cooling.phase -eq 'cooldown') 'Slow path must enter the five minute cooldown after three attempts'
  Assert ([bool]$runtime.componentBudgets.bridge.cooldownUntil) 'Cooldown must be recorded on the bridge budget'
  $null=Tick
  Assert ((RepairCount) -eq 3) 'A cooling bridge must not fast-repair'
  # Paused and disabled guardians never probe or repair.
  Set-MobileLinkDesiredState -Repo $root -State stopped
  $actions=(RepairCount)
  Assert ((Tick).phase -eq 'paused') 'Manual stop must preserve enabled mode and pause'
  Assert ((RepairCount) -eq $actions) 'Paused guardian must not run recovery'
  Write-Config $false
  Assert ((Tick).phase -eq 'disabled') 'Disable must prevent recovery'
  Assert ((RepairCount) -eq $actions) 'Disabled guardian must not run recovery'
  Set-MobileLinkDesiredState -Repo $root -State running
  $gate=Enter-MobileLinkCycle $root
  Assert ($null -ne $gate) 'Disabled guardian must release legacy watcher ownership'
  Exit-MobileLinkCycle $gate
  # Hold singleton in this process: a second Run must return without probing.
  Write-Config $true
  $singleton=New-MobileLinkMutex ($root+'\guardian-worker');$null=$singleton.WaitOne(0)
  try {
    $before=(Get-Item (Join-Path $root 'logs\state\mobile-link-guardian-status.json')).LastWriteTimeUtc
    $null=Guardian Run -Once
    Assert ((Get-Item (Join-Path $root 'logs\state\mobile-link-guardian-status.json')).LastWriteTimeUtc -eq $before) 'Second worker must not write status'
  }finally{$singleton.ReleaseMutex();$singleton.Dispose()}
  # Change desired state during the probe, before a previously primed repair.
  Set-Content (Join-Path $root 'repair-enabled.txt') '1' -Encoding utf8
  Set-Content (Join-Path $root 'bridge-up.txt') 'probe target back' -Encoding utf8
  $null=Tick
  Set-Content (Join-Path $root 'probe-delay.txt') 'delay'
  $info=[Diagnostics.ProcessStartInfo]::new($hostPath)
  $info.Arguments='-NoProfile -File "'+(Join-Path $root 'tools\windows\mobile-link-guardian.ps1')+'" -Action Run -Once -BridgePort '+$bridgePort
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $child=[Diagnostics.Process]::Start($info)
  try {
    Start-Sleep -Milliseconds 500
    Set-MobileLinkDesiredState -Repo $root -State stopped
    Assert ($child.WaitForExit(10000)) 'Stopped probe did not return'
  } finally {$child.Dispose()}
  Assert ((RepairCount) -eq $actions) 'Stop during probe must cancel planned repair'
  Assert ((Guardian Status).guardian.phase -eq 'paused') 'Public state must reflect stop immediately'
  Write-Output ('PASS: '+$checks+' isolated guardian worker checks')
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'mobile-link-guardian-test-*') {Remove-Item -LiteralPath $resolved -Recurse -Force}
  try { $probeListener.Stop(); $engine.Stop(); $engine.Dispose() } catch { }
}
