$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
. (Join-Path $repo 'tools\windows\mobile-voice-tunnel.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-voice-test-'+[guid]::NewGuid().ToString('N'))
$script:checks=0
$script:starts=0
$script:stops=0
$script:enables=0
$script:disables=0
$script:mockProcesses=@()
$script:mockConnections=@()
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
# These providers never operate the user's installed task.
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) $script:mockTask }
function Get-CimInstance { param($ClassName,$ErrorAction) $script:mockProcesses }
function Get-NetTCPConnection { param($State,$OwningProcess,$ErrorAction) @($script:mockConnections | Where-Object { $_.State -eq $State -and $_.OwningProcess -eq $OwningProcess }) }
function Start-ScheduledTask { param($TaskName,$TaskPath) $script:starts++;$script:mockTask.State='Running' }
function Stop-ScheduledTask { param($TaskName,$TaskPath) $script:stops++;$script:mockTask.State='Disabled' }
function Enable-ScheduledTask { param($TaskName,$TaskPath) $script:enables++;$script:mockTask.State='Ready' }
function Disable-ScheduledTask { param($TaskName,$TaskPath) $script:disables++ }
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'tools\harmony') | Out-Null
  $script:mockTask=$null
  $unconfigured=Get-MobileVoiceTunnelStatus $root
  Assert (-not $unconfigured.configured -and $unconfigured.message -eq '未配置独立语音隧道') 'Unconfigured checkouts must not adopt a shared task'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 0) 'Unconfigured checkouts must not start a task'
  $installedScript=Join-Path $root 'installed\keep-tunnel.ps1'
  $binding=Join-Path $root 'tools\harmony\voice-tunnel.local.psd1'
  @('@{',"TaskName='IsolatedVoiceTest'",("ScriptPath='"+$installedScript.Replace("'","''")+"'"),'}') | Set-Content -LiteralPath $binding
  $script:mockTask=[pscustomobject]@{State='Ready';Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=('-NoProfile -WindowStyle Hidden -File "'+$installedScript+'"')})}
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'Terminated task must be visible as not running'
  Ensure-MobileVoiceTunnel $root
  $starting=Get-MobileVoiceTunnelStatus $root
  Assert ($starts -eq 1 -and -not $starting.running -and $starting.taskRunning -and $starting.state -eq 'unverified') 'A Running scheduled task must not imply that SSH forwarding is healthy'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'Running task must not be duplicated or restarted'

  $tunnelLog=Join-Path (Split-Path -Parent $installedScript) 'tunnel.log'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tunnelLog) | Out-Null
  @('2026-10-10T09:30:00.0000000+08:00 connect') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  $script:mockProcesses=@(
    [pscustomobject]@{Name='powershell.exe';ProcessId=501;ParentProcessId=1;CommandLine=('powershell.exe -NoProfile -File "'+$installedScript+'"')},
    [pscustomobject]@{Name='ssh.exe';ProcessId=502;ParentProcessId=501;CommandLine='ssh.exe -N -T'}
  )
  $script:mockConnections=@([pscustomobject]@{OwningProcess=502;State='Established'})
  $connected=Get-MobileVoiceTunnelStatus $root
  Assert (-not $connected.running -and $connected.transportConnected -and $connected.state -eq 'unverified') 'An established SSH socket without forward success evidence must remain unverified'
  Add-Content -LiteralPath $tunnelLog -Value 'debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787' -Encoding utf8
  $healthy=Get-MobileVoiceTunnelStatus $root
  Assert ($healthy.running -and $healthy.state -eq 'Running' -and $healthy.taskRunning -and $healthy.message -like '远端 SSH 转发已确认建立*') 'Only explicit remote forward success plus the bound live SSH transport verifies forwarding'
  @('2026-10-10T09:30:00.0000000+08:00 connect','debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787','2026-10-10T09:30:02.0000000+08:00 exit=0') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  $stale=Get-MobileVoiceTunnelStatus $root
  Assert (-not $stale.running -and $stale.transportConnected -and $stale.state -eq 'unverified') 'A successful old attempt must not verify forwarding after its exit marker'
  @('2026-10-10T09:30:00.0000000+08:00 connect','debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  [IO.File]::AppendAllText($tunnelLog,('diagnostic padding ' + ('x' * 70000) + [Environment]::NewLine))
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'A long-running log must retain the connect and forward-success evidence beyond the old 64 KiB tail'

  $windowsPowerShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $conhost=Join-Path $env:WINDIR 'System32\conhost.exe'
  $wrapperArguments='--headless "'+$windowsPowerShell+'" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$installedScript+'"'
  $script:mockTask.Actions[0].Execute=$conhost
  $script:mockTask.Actions[0].Arguments=$wrapperArguments
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'The exact supported conhost headless wrapper must retain task ownership'
  $script:mockTask.Actions[0].Arguments=$wrapperArguments+' -EncodedCommand ZQ=='
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'Extra or injected wrapper arguments must be rejected'
  $script:mockTask.Actions[0].Arguments='--headless "C:\Windows\System32\cmd.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$installedScript+'"'
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'A conhost wrapper around an unapproved interpreter must be rejected'
  $script:mockTask.Actions[0].Execute=Join-Path $root 'foreign\conhost.exe'
  $script:mockTask.Actions[0].Arguments=$wrapperArguments
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'A conhost executable outside the Windows system path must be rejected'
  $script:mockTask.Actions[0].Execute='cmd.exe'
  $script:mockTask.Actions[0].Arguments='-NoProfile -WindowStyle Hidden -File "'+$installedScript+'"'
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'A non-PowerShell task host must be rejected'
  $script:mockTask.Actions[0].Execute='powershell.exe'
  $script:mockTask.Actions[0].Arguments='-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "'+$installedScript+'"'
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'Supported direct PowerShell options must remain valid in a different order'
  $script:mockTask.Actions[0].Arguments='-NoProfile -WindowStyle Hidden -Command "Get-Process" -File "'+$installedScript+'"'
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'Extra or injected direct PowerShell arguments must be rejected'
  $script:mockTask.Actions[0].Arguments='-NoProfile -WindowStyle Hidden -File "'+$installedScript+'"'
  $script:mockProcesses += [pscustomobject]@{Name='powershell.exe';ProcessId=503;ParentProcessId=501;CommandLine='powershell.exe -File "C:\repo\tools\harmony\run-voice-tunnel.ps1"'}
  $script:mockProcesses[1].ParentProcessId=503
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'The managed runner SSH child must remain associated with the supervisor'
  $script:mockProcesses[2].ParentProcessId=999
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'An unrelated runner must not be adopted'

  @('2026-10-10T09:31:00.0000000+08:00 connect','ssh.exe : Error: remote port forwarding failed for listen port 18787','2026-10-10T09:31:00.1000000+08:00 exit=255') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  $script:mockProcesses=@()
  $script:mockConnections=@()
  $failed=Get-MobileVoiceTunnelStatus $root
  Assert (-not $failed.running -and $failed.taskRunning -and $failed.state -eq 'forward-failed' -and $failed.message -like '*远端端口转发被拒绝*') 'Recent remote bind failure must override the ScheduledTask Running state'

  $script:mockTask.State='Ready'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 2) 'Later console termination must also recover'
  $record=Get-Content -Raw -LiteralPath (Join-Path $root 'logs\state\voice-tunnel-recovery.json') | ConvertFrom-Json
  Assert ($record.recoveries -eq 2) 'Recoveries must be recorded without task arguments'
  Set-MobileLinkDesiredState $root stopped
  $script:mockTask.State='Ready'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 2) 'Persistent stop must suppress recovery'
  $script:mockTask.State='Running'
  Stop-MobileVoiceTunnel $root
  Assert ($stops -eq 1 -and $disables -eq 1) 'Stop must stop the task and disable its logon trigger'
  Set-MobileLinkDesiredState $root running
  Ensure-MobileVoiceTunnel $root
  Assert ($enables -eq 1 -and $starts -eq 3) 'Explicit resume must enable and restart the task'
  $script:mockTask.Actions[0].Arguments='-File "C:\isolated\foreign-tunnel.ps1"'
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'binding-error') 'Foreign task action must fail ownership validation'
  $rejected=$false
  try { Stop-MobileVoiceTunnel $root } catch { $rejected=$true }
  Assert ($rejected -and $stops -eq 1) 'Foreign action must never be stopped'
  $script:mockTask=$null
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'Missing') 'Missing task must be shown as missing'
  [pscustomobject]@{passed=$checks;terminationRecovery=$true;pauseResume=$true;foreignTaskProtected=$true;forwardHealthVerified=$true} | ConvertTo-Json -Compress
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if ($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'mobile-voice-test-*' -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
