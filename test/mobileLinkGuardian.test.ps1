$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-guardian-test-'+[guid]::NewGuid().ToString('N'))
$hostPath=(Get-Process -Id $PID).Path
$checks=0
function Assert([bool]$Condition,[string]$Message) {if(-not $Condition){throw $Message};$script:checks++}
function Guardian([string]$Action,[switch]$Once) {
  $arguments=@('-NoProfile','-File',(Join-Path $root 'tools\windows\mobile-link-guardian.ps1'),'-Action',$Action)
  if($Once){$arguments+='-Once'}
  $output=& $hostPath @arguments
  if($LASTEXITCODE -ne 0){throw ('Guardian CLI failed: '+($output -join ' '))}
  if($output){($output -join "`n")|ConvertFrom-Json}
}
function Tick { $null=Guardian Run -Once; (Get-Content -Raw -Encoding utf8 (Join-Path $root 'logs\state\mobile-link-guardian-status.json')|ConvertFrom-Json) }
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
console.log(JSON.stringify({checks:[],guardianSignals:{faults:healthy?[]:[{id:'bridge',component:'bridge',kind:'transport',repairable:true}]}}));
'@|Set-Content (Join-Path $root 'tools\windows\mobile-link-diagnostics.mjs') -Encoding utf8
  @'
param($Action,$GuardianStage,$GuardianComponents,$BridgePort)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Add-Content (Join-Path $root 'repair-actions.txt') $GuardianStage
if($GuardianStage -eq 'restart_services'){[IO.File]::WriteAllText((Join-Path $root 'healthy.txt'),'mock bridge booted directly')}
@{accepted=$true}|ConvertTo-Json -Compress
'@|Set-Content (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Encoding utf8
  $status=Guardian Status
  Assert (-not $status.guardian.enabled -and $status.guardian.phase -eq 'disabled') 'Missing config must default off'
  . (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
  Write-Config $true
  $gate=Enter-MobileLinkCycle $root
  Assert ($null -eq $gate) 'Legacy watcher must yield to enabled guardian'
  $first=Tick
  Assert ($first.phase -eq 'suspect' -and $first.attempts -eq 0) 'First failure must not repair'
  $second=Tick
  Assert ($second.attempts -eq 1 -and (Get-Content (Join-Path $root 'repair-actions.txt') -Raw).Trim() -eq 'reconnect') 'Second failure must request reconnect'
  $third=Tick
  Assert ($third.attempts -eq 2 -and (Test-Path (Join-Path $root 'healthy.txt'))) 'Scoped restart must start mock bridge even while legacy watchers are suppressed'
  $fourth=Tick
  Assert ($fourth.phase -eq 'healthy' -and $fourth.attempts -eq 2) 'First independent healthy probe must retain the failure budget'
  Assert ((Tick).attempts -eq 0) 'Two healthy probes must confirm stable recovery'
  Set-MobileLinkDesiredState -Repo $root -State stopped
  Remove-Item (Join-Path $root 'healthy.txt')
  $actions=@(Get-Content (Join-Path $root 'repair-actions.txt')).Count
  Assert ((Tick).phase -eq 'paused') 'Manual stop must preserve enabled mode and pause'
  Assert (@(Get-Content (Join-Path $root 'repair-actions.txt')).Count -eq $actions) 'Paused guardian must not run recovery'
  Write-Config $false
  Assert ((Tick).phase -eq 'disabled') 'Disable must prevent recovery'
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
  $null=Tick
  Set-Content (Join-Path $root 'probe-delay.txt') 'delay'
  $info=[Diagnostics.ProcessStartInfo]::new($hostPath)
  $info.Arguments='-NoProfile -File "'+(Join-Path $root 'tools\windows\mobile-link-guardian.ps1')+'" -Action Run -Once'
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $child=[Diagnostics.Process]::Start($info)
  try {
    Start-Sleep -Milliseconds 500
    Set-MobileLinkDesiredState -Repo $root -State stopped
    Assert ($child.WaitForExit(10000)) 'Stopped probe did not return'
  } finally {$child.Dispose()}
  Assert (@(Get-Content (Join-Path $root 'repair-actions.txt')).Count -eq $actions) 'Stop during probe must cancel planned repair'
  Assert ((Guardian Status).guardian.phase -eq 'paused') 'Public state must reflect stop immediately'
  Write-Output ('PASS: '+$checks+' isolated guardian worker checks')
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'mobile-link-guardian-test-*') {Remove-Item -LiteralPath $resolved -Recurse -Force}
}
