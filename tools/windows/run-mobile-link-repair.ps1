[CmdletBinding()]
param([int]$BridgePort=8787,[Parameter(Mandatory=$true)][string]$RunId,[switch]$ProbeOnly,[switch]$GuardianRepair)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$logDir=Join-Path $repo 'logs\startup'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$resultPath=Join-Path $repo 'logs\state\desktop-repair-result.json'
New-Item -ItemType Directory -Force -Path (Split-Path $resultPath) | Out-Null
@{runId=$RunId;pid=$PID;startedAt=[datetime]::UtcNow.ToString('o');probe=[bool]$ProbeOnly} | ConvertTo-Json | Set-Content (Join-Path $logDir 'desktop-repair-worker.json') -Encoding utf8
try {
  $hostPath=(Get-Command pwsh.exe).Source
  $arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'mobile-link-control.ps1'),'-BridgePort',"$BridgePort")
  if ($ProbeOnly) { $arguments+=@('-Action','Status') }
  else { $arguments+=@('-Action','Repair','-RestartDesktop','-ScheduledRepairWorker') }
  if ($GuardianRepair) { $arguments+='-GuardianRepair' }
  $output=& $hostPath @arguments 2> (Join-Path $logDir 'desktop-repair-worker.stderr.log')
  $code=$LASTEXITCODE
  ($output -join "`n") | Set-Content (Join-Path $logDir 'desktop-repair-worker.stdout.log') -Encoding utf8
  $result=($output -join "`n") | ConvertFrom-Json
} catch { $code=1; $result=@{error='独立修复任务未完成，请查看修复日志。';failureType=$_.Exception.GetType().Name;failureLine=$_.InvocationInfo.ScriptLineNumber} }
@{runId=$RunId;exitCode=$code;completedAt=[datetime]::UtcNow.ToString('o');result=$result} | ConvertTo-Json -Depth 10 | Set-Content $resultPath -Encoding utf8
exit $code
