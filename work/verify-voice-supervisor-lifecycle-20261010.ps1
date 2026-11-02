$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools/windows/mobile-link-lifecycle.ps1')
. (Join-Path $repo 'tools/windows/mobile-voice-tunnel.ps1')
$config=Get-MobileVoiceTunnelConfig $repo
$gate=New-MobileLinkMutex $repo
$owns=$false;$stopped=$false
try {
  try {$owns=$gate.WaitOne(30000)} catch [Threading.AbandonedMutexException] {$owns=$true}
  if(-not $owns){throw 'Manager busy'}
  if(@(Get-NetTCPConnection -LocalPort 8790 -State Established -ErrorAction SilentlyContinue).Count){throw 'Voice connection active; preserving tunnel'}
  $state=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $config.ScriptPath) 'supervisor.json') -Raw | ConvertFrom-Json
  if($state.version -ne 2){throw 'Expected managed supervisor'}
  $all=@(Get-CimInstance Win32_Process)
  $family=@($all | Where-Object {$_.ProcessId -in @($state.pid,$state.childPid) -or ($_.Name -eq 'ssh.exe' -and $_.ParentProcessId -eq $state.childPid)})
  if($family.Count -ne 3){throw 'Expected supervisor, runner and SSH process'}
  Stop-MobileVoiceTunnel $repo
  $stopped=$true
  $deadline=[datetime]::UtcNow.AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 200
    $remaining=@(foreach($expected in $family){
      $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.ProcessId)
      if($current -and $current.CreationDate -eq $expected.CreationDate){$current.ProcessId}
    })
  } while($remaining.Count -gt 0 -and [datetime]::UtcNow -lt $deadline)
  if($remaining.Count){throw 'Task stop left a managed descendant alive'}
  Ensure-MobileVoiceTunnel $repo
  $stopped=$false
  $deadline=[datetime]::UtcNow.AddSeconds(35)
  do {Start-Sleep -Milliseconds 800;$status=Get-MobileVoiceTunnelStatus $repo} while(-not $status.running -and [datetime]::UtcNow -lt $deadline)
  if(-not $status.running){throw 'Forwarding not confirmed after task restart'}
  $next=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $config.ScriptPath) 'supervisor.json') -Raw | ConvertFrom-Json
  [pscustomobject]@{checkedAt=[datetime]::UtcNow.ToString('o');terminatedProcessCount=$family.Count;orphanCount=$remaining.Count;newSupervisorPid=$next.pid;newRunnerPid=$next.childPid;forwarding=$status.running} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'work/voice-supervisor-lifecycle-20261010.json')
  [pscustomobject]@{terminatedProcessCount=$family.Count;orphanCount=$remaining.Count;forwarding=$status.running}|ConvertTo-Json -Compress
} finally {
  if($stopped){Ensure-MobileVoiceTunnel $repo}
  if($owns){$gate.ReleaseMutex()}
  $gate.Dispose()
}
