$LegacySshPid=3964
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools/windows/mobile-link-lifecycle.ps1')
. (Join-Path $repo 'tools/windows/mobile-voice-tunnel.ps1')
$config=Get-MobileVoiceTunnelConfig $repo
$task=Get-MobileVoiceTunnelTask $config
if(-not $task -or [string]$task.State -ne 'Running'){throw 'Expected running bound tunnel task'}
$original=Get-Content -LiteralPath $config.ScriptPath -Raw
$identity=[regex]::Match($original,'\$identityPath\s*=\s*''([^'']+)''').Groups[1].Value
$destination=[regex]::Match($original,"'([A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)'").Groups[1].Value
$route=[regex]::Match($original,"'127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)'")
if(-not $identity -or -not $destination -or -not $route.Success){throw 'Existing supervisor format changed; preserve it'}
$forward=$route.Value.Trim("'")
$orphan=Get-CimInstance Win32_Process -Filter ('ProcessId='+$LegacySshPid)
function Assert-Orphan([object]$Expected,[switch]$RequireOrphan) {
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$Expected.ProcessId)
  if(-not $current -or $current.CreationDate -ne $Expected.CreationDate -or $current.Name -ne 'ssh.exe' -or
      -not $current.CommandLine.Contains($identity) -or -not $current.CommandLine.Contains($forward) -or
      -not $current.CommandLine.Contains($destination)){throw 'Orphan SSH identity changed'}
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$current.ParentProcessId)
  if($parent -and ($RequireOrphan -or -not $parent.CommandLine.Contains($config.ScriptPath))){throw 'SSH parent is not the expected supervisor; preserve it'}
}
if(-not $orphan){throw 'Expected legacy SSH orphan is absent; recheck before migrating'}
Assert-Orphan $orphan
$backup=Join-Path $repo 'work/keep-tunnel.pre-job-20261010.ps1'
if(Test-Path -LiteralPath $backup) {
  if((Get-FileHash -LiteralPath $backup).Hash -ne (Get-FileHash -LiteralPath $config.ScriptPath).Hash){throw 'Backup differs from original; preserve both'}
} else { Copy-Item -LiteralPath $config.ScriptPath -Destination $backup }
$localConfig=Join-Path (Split-Path -Parent $config.ScriptPath) 'tunnel.local.psd1'
$newScript=Join-Path $repo 'tools/harmony/keep-voice-tunnel.ps1'
if(-not (Test-Path -LiteralPath (Join-Path $repo 'tools/windows/managed-child-job.ps1'))){throw 'Managed job helper missing'}
$gate=New-MobileLinkMutex $repo
$owns=$false;$changed=$false
try {
  try {$owns=$gate.WaitOne(30000)} catch [Threading.AbandonedMutexException] {$owns=$true}
  if(-not $owns){throw 'Management operation is busy'}
  if(@(Get-NetTCPConnection -LocalPort 8790 -State Established -ErrorAction SilentlyContinue).Count){throw 'Voice connection active; preserve current tunnel'}
  Assert-Orphan $orphan
  Stop-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
  $changed=$true
  $deadline=[datetime]::UtcNow.AddSeconds(10)
  while([string](Get-MobileVoiceTunnelTask $config).State -eq 'Running' -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
  if([string](Get-MobileVoiceTunnelTask $config).State -eq 'Running'){throw 'Old task has not stopped'}
  @('@{',("SshDestination='"+$destination+"'"),("IdentityPath='"+$identity.Replace("'","''")+"'"),
    ('RemotePort='+$route.Groups[1].Value),('LocalPort='+$route.Groups[2].Value),'}') |
    Set-Content -LiteralPath $localConfig -Encoding utf8
  ("& '"+$newScript.Replace("'","''")+"' -ConfigPath '"+$localConfig.Replace("'","''")+"'") |
    Set-Content -LiteralPath $config.ScriptPath -Encoding utf8
  Assert-Orphan $orphan -RequireOrphan
  Stop-Process -Id $orphan.ProcessId -Force
  Start-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
  $deadline=[datetime]::UtcNow.AddSeconds(35)
  do {
    Start-Sleep -Milliseconds 800
    $status=Get-MobileVoiceTunnelStatus $repo
    if($status.running){break}
  } while([datetime]::UtcNow -lt $deadline)
  if(-not $status.running){throw 'New supervisor did not confirm forwarding'}
  $state=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $config.ScriptPath) 'supervisor.json') -Raw | ConvertFrom-Json
  $sshChild=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'ssh.exe' -and $_.ParentProcessId -eq $state.childPid}
  [pscustomobject]@{checkedAt=[datetime]::UtcNow.ToString('o');oldOrphanPid=$orphan.ProcessId;supervisorPid=$state.pid;runnerPid=$state.childPid;sshPid=$sshChild.ProcessId;forwarding=$status.running;state=$status.state;backup=$backup} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'work/voice-supervisor-migration-20261010.json')
  [pscustomobject]@{migrated=$true;oldOrphanRemoved=$true;forwarding=$status.running;supervisorPid=$state.pid;runnerPid=$state.childPid;sshPid=$sshChild.ProcessId}|ConvertTo-Json -Compress
} catch {
  if($changed){
    Stop-ScheduledTask -TaskName $config.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Copy-Item -LiteralPath $backup -Destination $config.ScriptPath -Force
    Start-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
  }
  throw
} finally {
  if($owns){$gate.ReleaseMutex()}
  $gate.Dispose()
}
