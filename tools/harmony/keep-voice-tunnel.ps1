[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repo 'tools\windows\managed-child-job.ps1')
$settings=Import-PowerShellDataFile -LiteralPath $ConfigPath
foreach($key in @('SshDestination','IdentityPath','RemotePort','LocalPort')) {
  if(-not $settings.ContainsKey($key)){throw "Missing tunnel setting: $key"}
}
$identity=[IO.Path]::GetFullPath([string]$settings.IdentityPath)
if(-not (Test-Path -LiteralPath $identity -PathType Leaf)){throw 'Configured tunnel identity is missing'}
$destination=[string]$settings.SshDestination
if($destination -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$'){throw 'Invalid SSH destination'}
$remotePort=[int]$settings.RemotePort
$localPort=[int]$settings.LocalPort
if($remotePort -lt 1 -or $remotePort -gt 65535 -or $localPort -lt 1 -or $localPort -gt 65535){throw 'Invalid tunnel port'}
$stateDirectory=Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))
$logPath=Join-Path $stateDirectory 'tunnel.log'
$statePath=Join-Path $stateDirectory 'supervisor.json'
$runner=Join-Path $PSScriptRoot 'run-voice-tunnel.ps1'
$hostExecutable=(Get-Process -Id $PID).Path
$hash=[Security.Cryptography.SHA256]::Create()
try {$key=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($stateDirectory.ToLowerInvariant()))).Replace('-','').Substring(0,24)}
finally {$hash.Dispose()}
$mutex=[Threading.Mutex]::new($false,('Local\CodexVoiceTunnel_'+$key))
$owns=$false
$child=$null
function Save-TunnelState([string]$Status,[object]$Process=$null) {
  $state=[ordered]@{version=2;pid=$PID;startedAt=$script:startedAt;updatedAt=[datetime]::UtcNow.ToString('o');remotePort=$remotePort;localPort=$localPort;status=$Status;childPid=$null;childStartedAt=$null}
  if($null -ne $Process){$state.childPid=$Process.Id;$state.childStartedAt=$Process.StartTime.ToUniversalTime().ToString('o')}
  $temporary=$statePath+'.'+$PID+'.tmp'
  $state | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
try {
  try {$owns=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owns=$true}
  if(-not $owns){exit 10}
  $script:startedAt=[datetime]::UtcNow.ToString('o')
  while($true) {
    if((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 262144) {
      # Rotate only between attempts, so a live SSH process never writes a moved file.
      Move-Item -LiteralPath $logPath -Destination ($logPath+'.previous') -Force
    }
    Add-Content -LiteralPath $logPath -Value ([datetime]::UtcNow.ToString('o')+' connect') -Encoding utf8
    Save-TunnelState 'connecting'
    # The runner streams SSH diagnostics into a readable UTF-8 log. Its SSH child
    # inherits the same kill-on-close job, so task termination reaps both.
    $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$runner,'-ConfigPath',[IO.Path]::GetFullPath($ConfigPath),'-LogPath',$logPath)
    $quoted=@(foreach($argument in $arguments){
      if($argument -match '["\r\n\x00]' -or $argument.EndsWith('\')){throw 'Invalid SSH argument'}
      '"'+$argument+'"'
    })
    try {
      $child=Start-ManagedChildProcess -FilePath $hostExecutable -Arguments ($quoted -join ' ') -WorkingDirectory $stateDirectory
      Save-TunnelState 'connecting' $child.Process
      $child.Process.WaitForExit()
      $code=$child.Process.ExitCode
      Add-Content -LiteralPath $logPath -Value ([datetime]::UtcNow.ToString('o')+' exit='+$code) -Encoding utf8
    } catch {
      Add-Content -LiteralPath $logPath -Value ([datetime]::UtcNow.ToString('o')+' exit=-1') -Encoding utf8
    } finally {
      if($null -ne $child){$child.Dispose();$child=$null}
    }
    Save-TunnelState 'retrying'
    Start-Sleep -Seconds 5
  }
} finally {
  if($null -ne $child){$child.Dispose()}
  if($owns){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
