[CmdletBinding()]
param([int]$BridgePort=8787,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId,[switch]$ProbeOnly,[switch]$GuardianRepair,[string]$GuardianComponents='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'mobile-link-operation.ps1')
$logDir=Join-Path $repo 'logs\startup'
$resultPath=Join-Path $repo ('logs\state\desktop-repair-results\'+$RunId+'.json')
$code=1
$result=@{error='独立修复任务未完成，请查看修复日志。';action='Repair'}
try {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  # Also waits for the launcher's atomic registration/start section to finish.
  if (-not (Set-MobileLinkOperation -Repo $repo -OperationId $RunId -Phase checking)) { throw 'Stale worker' }
  $current=Get-MobileLinkOperation $repo
  if (-not $current.active) { throw 'Operation deadline reached' }
  Write-MobileLinkAtomicJson (Join-Path $logDir 'desktop-repair-worker.json') @{runId=$RunId;pid=$PID;startedAt=[datetime]::UtcNow.ToString('o');probe=[bool]$ProbeOnly}
  $hostPath=(Get-Command pwsh.exe).Source
  $arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'mobile-link-control.ps1'),'-BridgePort',"$BridgePort")
  if ($ProbeOnly) { $arguments+=@('-Action','Status') }
  else { $arguments+=@('-Action','Repair','-RestartDesktop','-ScheduledRepairWorker','-OperationId',$RunId) }
  if ($GuardianRepair) { $arguments+=@('-GuardianRepair','-GuardianStage','restart_desktop','-GuardianComponents',$GuardianComponents) }
  $output=& $hostPath @arguments 2> (Join-Path $logDir ('desktop-repair-'+$RunId+'.stderr.log'))
  $code=$LASTEXITCODE
  ($output -join "`n") | Set-Content (Join-Path $logDir ('desktop-repair-'+$RunId+'.stdout.log')) -Encoding utf8
  $result=($output -join "`n") | ConvertFrom-Json
} catch {
  $code=1
  $result=@{error='独立修复任务未完成，请查看修复日志。';action='Repair'}
} finally {
  $gate=Enter-MobileLinkOperationGate $repo
  try {
    $current=Get-MobileLinkOperation $repo
    if ($current -and $current.operationId -eq $RunId -and $current.active) {
      # ProbeOnly never proves the full Repair acceptance contract.
      $phase=if($ProbeOnly -and $code -eq 0){'partial'}else{'failed'}
      Set-MobileLinkOperation -Repo $repo -OperationId $RunId -Phase $phase | Out-Null
    }
    $completion=@{runId=$RunId;exitCode=$code;completedAt=[datetime]::UtcNow.ToString('o');result=$result}
    Write-MobileLinkAtomicJson $resultPath $completion -Depth 10
    # A late worker keeps its own result, but cannot replace a newer latest result.
    if ($current -and $current.operationId -eq $RunId) {
      Write-MobileLinkAtomicJson (Join-Path $repo 'logs\state\desktop-repair-result.json') $completion -Depth 10
    }
  } finally { $gate.ReleaseMutex(); $gate.Dispose() }
}
exit $code
