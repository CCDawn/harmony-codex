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
$script:processProbeFails=$false
$script:socketProbeFails=$false
$script:killedProcessIds=@()
$script:onProcessReread=$null
$script:onProcessSnapshot=$null
$script:stopProcessFails=$false
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
# These providers never operate the user's installed task.
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) $script:mockTask }
function Get-CimInstance {
  param($ClassName,$ErrorAction,$Filter)
  if ($script:processProbeFails) { throw 'Isolated process probe failure' }
  if ($Filter) {
    if ($null -ne $script:onProcessReread) { $callback=$script:onProcessReread;$script:onProcessReread=$null;& $callback }
    if ($Filter -notmatch '^ProcessId\s*=\s*(\d+)$') { throw 'Unexpected isolated process filter' }
    $selectedId=[int]$Matches[1]
    return @($script:mockProcesses | Where-Object { $_.ProcessId -eq $selectedId })
  }
  if ($null -ne $script:onProcessSnapshot) { $callback=$script:onProcessSnapshot;$script:onProcessSnapshot=$null;& $callback }
  $script:mockProcesses
}
function Get-NetTCPConnection { param($State,$OwningProcess,$ErrorAction) if ($script:socketProbeFails) { throw 'Isolated socket probe failure' };@($script:mockConnections | Where-Object { $_.State -eq $State -and $_.OwningProcess -eq $OwningProcess }) }
function Start-ScheduledTask { param($TaskName,$TaskPath) $script:starts++;$script:mockTask.State='Running' }
function Stop-ScheduledTask { param($TaskName,$TaskPath) $script:stops++;$script:mockTask.State='Disabled' }
function Enable-ScheduledTask { param($TaskName,$TaskPath) $script:enables++;$script:mockTask.State='Ready' }
function Disable-ScheduledTask { param($TaskName,$TaskPath) $script:disables++;if ($script:mockTask.State -ne 'Running') { $script:mockTask.State='Disabled' } }
function Stop-Process {
  param($Id,[switch]$Force,$ErrorAction)
  if ($script:stopProcessFails) { throw 'Isolated stop denied' }
  $script:killedProcessIds+= [int]$Id
  # Model the supervisor's kill-on-close job; production stops only its owner.
  $removed=@([int]$Id)
  do {
    $children=@($script:mockProcesses | Where-Object { $_.ParentProcessId -in $removed -and $_.ProcessId -notin $removed } | ForEach-Object { [int]$_.ProcessId })
    $removed+= $children
  } while ($children.Count -gt 0)
  $script:mockProcesses=@($script:mockProcesses | Where-Object { $_.ProcessId -notin $removed })
}
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
  $script:mockTask.State='Ready'
  $detached=Get-MobileVoiceTunnelStatus $root
  Assert ($detached.running -and -not $detached.taskRunning -and $detached.taskState -eq 'Ready' -and $detached.transportConnected) 'A Ready task with its bound live SSH forward must report healthy without falsifying taskRunning'
  Assert ($null -eq $detached.PSObject.Properties['owners']) 'Public tunnel status must not expose internal process identity snapshots'
  Ensure-MobileVoiceTunnel $root
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'A Ready task with its bound live forward must never be started again'
  Remove-Item -LiteralPath $tunnelLog
  $withoutLog=Get-MobileVoiceTunnelStatus $root
  Assert (-not $withoutLog.running -and $withoutLog.state -eq 'unverified') 'A live owner without a readable log must remain unverified'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'Missing logs must not cause a second task start while the bound owner is alive'
  @('2026-10-10T09:30:00.0000000+08:00 connect') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  $script:mockConnections=@()
  $withoutSocket=Get-MobileVoiceTunnelStatus $root
  Assert (-not $withoutSocket.running -and -not $withoutSocket.transportConnected -and $withoutSocket.state -eq 'unverified') 'A Ready task with only its bound supervisor must remain unverified'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'A connecting bound supervisor without an SSH socket must not be duplicated'
  $script:mockConnections=@([pscustomobject]@{OwningProcess=502;State='Established'})
  $withoutForward=Get-MobileVoiceTunnelStatus $root
  Assert (-not $withoutForward.running -and $withoutForward.transportConnected -and -not $withoutForward.taskRunning) 'A Ready task with a socket but no forward success must remain unverified'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'An unverified forward owned by the configured supervisor must not be duplicated'
  $script:socketProbeFails=$true
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'A socket probe failure must not claim a healthy forward'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'Socket inspection failure must retain the verified owner and suppress duplicate starts'
  $script:socketProbeFails=$false
  $script:processProbeFails=$true
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'A process probe failure must not claim a healthy forward'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'An unknown process snapshot must defer starting rather than risk duplicating an unobserved owner'
  $script:processProbeFails=$false
  Set-MobileLinkDesiredState $root stopped
  $script:mockTask.State='Disabled'
  $disabled=Get-MobileVoiceTunnelStatus $root
  Assert (-not $disabled.running -and -not $disabled.taskRunning -and $disabled.state -eq 'Disabled') 'A disabled task must preserve its explicit disabled status even when its owner lingers'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1 -and $enables -eq 0) 'Persistent stop must suppress enabling and starting even when a bound owner lingers'
  Set-MobileLinkDesiredState $root running
  $script:mockTask.State='Running'
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
  $runnerScript=Join-Path $root 'tools\harmony\run-voice-tunnel.ps1'
  $script:mockProcesses += [pscustomobject]@{Name='powershell.exe';ProcessId=503;ParentProcessId=501;CommandLine=('powershell.exe "-NoProfile" "-NonInteractive" "-ExecutionPolicy" "Bypass" "-File" "'+$runnerScript+'" "-ConfigPath" "'+(Join-Path $root 'installed\tunnel.local.psd1')+'" "-LogPath" "'+$tunnelLog+'"')}
  $script:mockProcesses[1].ParentProcessId=503
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'The managed runner SSH child must remain associated with the supervisor'
  $script:mockTask.State='Ready'
  Assert ((Get-MobileVoiceTunnelStatus $root).running) 'A Ready task must also recognize the exact managed runner and its SSH child'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq 1) 'A Ready task with a live managed runner must not be duplicated'
  $runnerCommand=$script:mockProcesses[2].CommandLine
  $script:mockProcesses[2].CommandLine='powershell.exe -File "C:\foreign\run-voice-tunnel.ps1"'
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'A same-named runner outside the bound repository must not be adopted'
  $script:mockProcesses[2].CommandLine=$runnerCommand
  $script:mockProcesses[2].ParentProcessId=999
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'An unrelated runner must not be adopted'
  $script:mockTask.State='Running'

  @('2026-10-10T09:31:00.0000000+08:00 connect','ssh.exe : Error: remote port forwarding failed for listen port 18787','2026-10-10T09:31:00.1000000+08:00 exit=255') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  $script:mockProcesses=@()
  $script:mockConnections=@()
  $failed=Get-MobileVoiceTunnelStatus $root
  Assert (-not $failed.running -and $failed.taskRunning -and $failed.state -eq 'forward-failed' -and $failed.message -like '*远端端口转发被拒绝*') 'Recent remote bind failure must override the ScheduledTask Running state'

  $script:mockTask.State='Ready'
  @('2026-10-10T09:30:00.0000000+08:00 connect','debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8787') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'A residual successful log without a live bound owner must not imply health'
  $script:mockProcesses=@(
    [pscustomobject]@{Name='powershell.exe';ProcessId=601;ParentProcessId=1;CommandLine='powershell.exe -File "C:\foreign\keep-tunnel.ps1"'},
    [pscustomobject]@{Name='ssh.exe';ProcessId=602;ParentProcessId=601;CommandLine='ssh.exe -N -T'}
  )
  $script:mockConnections=@([pscustomobject]@{OwningProcess=602;State='Established'})
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'Foreign PowerShell and SSH processes must not be adopted from a residual log'
  $script:mockProcesses[0].CommandLine='powershell.exe -Command "Write-Host -File '+$installedScript+'"'
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'Mentioning the bound script inside a PowerShell command must never establish ownership'
  $script:mockProcesses[0].CommandLine='powershell.exe -File "'+$installedScript+'" -UnexpectedArgument'
  Assert (-not (Get-MobileVoiceTunnelStatus $root).running) 'A process with unapproved script arguments must not inherit the task binding'
  $script:mockProcesses=@()
  $script:mockConnections=@()

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

  $script:mockTask=[pscustomobject]@{State='Ready';Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=('-NoProfile -WindowStyle Hidden -File "'+$installedScript+'"')})}
  $ownerCommand='powershell.exe -NoProfile -File "'+$installedScript+'"'
  $ownerCreated=[datetime]'2026-10-10T01:29:00Z'
  $script:mockProcesses=@(
    [pscustomobject]@{Name='powershell.exe';ProcessId=701;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated},
    [pscustomobject]@{Name='powershell.exe';ProcessId=702;ParentProcessId=701;CommandLine=('powershell.exe -File "'+$runnerScript+'"');CreationDate=$ownerCreated.AddSeconds(1)},
    [pscustomobject]@{Name='ssh.exe';ProcessId=703;ParentProcessId=702;CommandLine='ssh.exe -N -T';CreationDate=$ownerCreated.AddSeconds(2)},
    [pscustomobject]@{Name='powershell.exe';ProcessId=801;ParentProcessId=1;CommandLine='powershell.exe -File "C:\foreign\keep-tunnel.ps1"';CreationDate=$ownerCreated},
    [pscustomobject]@{Name='ssh.exe';ProcessId=802;ParentProcessId=801;CommandLine='ssh.exe -N -T';CreationDate=$ownerCreated.AddSeconds(1)}
  )
  $script:mockConnections=@([pscustomobject]@{OwningProcess=703;State='Established'})
  @('2026-10-10T09:31:00.0000000+08:00 connect','ssh.exe : Error: remote port forwarding failed for listen port 18787','2026-10-10T09:31:00.1000000+08:00 exit=255') | Set-Content -LiteralPath $tunnelLog -Encoding utf8
  Assert ((Get-MobileVoiceTunnelStatus $root).state -eq 'forward-failed') 'The repair fixture must reproduce a confirmed forward failure under a Ready task'
  $beforeRepair=$starts
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq $beforeRepair) 'Ensure must preserve the existing owner until the explicit repair stop'
  $script:socketProbeFails=$true
  Stop-MobileVoiceTunnel $root
  $script:socketProbeFails=$false
  Assert ($script:killedProcessIds.Count -eq 1 -and $script:killedProcessIds[0] -eq 701) 'Stopping a Ready task must terminate its exact live supervisor'
  Assert (@($script:mockProcesses | Where-Object { $_.ProcessId -in @(701,702,703) }).Count -eq 0) 'The managed job must reap runner and SSH without separate broad child kills'
  Assert (@($script:mockProcesses | Where-Object { $_.ProcessId -in @(801,802) }).Count -eq 2) 'Repair stop must preserve foreign supervisors and SSH processes'
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq ($beforeRepair+1)) 'A stopped Ready owner must allow the failed tunnel task to be rebuilt'

  Set-MobileLinkDesiredState $root stopped
  $script:mockTask.State='Ready'
  $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=711;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated})
  Stop-MobileVoiceTunnel $root
  $manualStarts=$starts
  $manualEnables=$enables
  Ensure-MobileVoiceTunnel $root
  Assert ($script:killedProcessIds -contains 711 -and $starts -eq $manualStarts -and $enables -eq $manualEnables) 'Manual stop must terminate a detached owner and keep recovery paused'
  Set-MobileLinkDesiredState $root running

  foreach ($change in @('creation','command','name')) {
    $script:mockTask.State='Ready'
    $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=721;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated})
    $script:onProcessReread={
      switch ($change) {
        'creation' { $script:mockProcesses[0].CreationDate=$ownerCreated.AddMinutes(1) }
        'command' { $script:mockProcesses[0].CommandLine='powershell.exe -File "C:\foreign\keep-tunnel.ps1"' }
        'name' { $script:mockProcesses[0].Name='foreign.exe' }
      }
    }
    $killsBefore=$script:killedProcessIds.Count
    $identityRejected=$false
    try { Stop-MobileVoiceTunnel $root } catch { $identityRejected=$true }
    Assert ($script:killedProcessIds.Count -eq $killsBefore) "A changed $change identity must never be stopped after snapshot reread"
    if ($change -eq 'creation') { Assert ($identityRejected) 'A reused PID still naming the bound script must abort rather than kill the replacement owner' }
  }
  $script:mockTask.State='Ready'
  $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=731;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated})
  $script:onProcessReread={ $script:mockProcesses=@() }
  $killsBefore=$script:killedProcessIds.Count
  Stop-MobileVoiceTunnel $root
  Assert ($script:killedProcessIds.Count -eq $killsBefore) 'A supervisor that exits before the identity reread must not trigger another process kill'

  $script:mockTask.State='Ready'
  $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=741;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated})
  $script:stopProcessFails=$true
  $stopRejected=$false
  try { Stop-MobileVoiceTunnel $root } catch { $stopRejected=$true }
  $script:stopProcessFails=$false
  $startsBeforeFailedStop=$starts
  Ensure-MobileVoiceTunnel $root
  Assert ($stopRejected -and $starts -eq $startsBeforeFailedStop) 'A stop failure must remain visible and must not start another task over the surviving owner'

  $script:mockTask.State='Ready'
  $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=751;ParentProcessId=1;CommandLine=$ownerCommand})
  $killsBefore=$script:killedProcessIds.Count
  $creationRejected=$false
  try { Stop-MobileVoiceTunnel $root } catch { $creationRejected=$true }
  Assert ($creationRejected -and $script:killedProcessIds.Count -eq $killsBefore) 'A bound process without a creation timestamp must not be killed'
  $script:mockTask.State='Ready'
  $script:processProbeFails=$true
  $probeRejected=$false
  try { Stop-MobileVoiceTunnel $root } catch { $probeRejected=$true }
  $script:processProbeFails=$false
  Assert ($probeRejected -and $script:killedProcessIds.Count -eq $killsBefore -and $script:mockTask.State -eq 'Disabled') 'An unavailable ownership snapshot must disable relaunch and fail without killing any process'

  $script:mockTask.State='Ready'
  $script:mockProcesses=@([pscustomobject]@{Name='powershell.exe';ProcessId=761;ParentProcessId=1;CommandLine=$ownerCommand;CreationDate=$ownerCreated})
  $script:guardianAllowed=$true
  $script:onProcessSnapshot={ $script:guardianAllowed=$false }
  $disableBefore=$disables
  $stopsBefore=$stops
  $killsBefore=$script:killedProcessIds.Count
  Stop-MobileVoiceTunnel $root -CanStop { $script:guardianAllowed }
  Assert ($disables -eq $disableBefore -and $stops -eq $stopsBefore -and $script:killedProcessIds.Count -eq $killsBefore) 'Revocation during the process snapshot must prevent every stop mutation'

  $script:mockTask.State='Running'
  $script:gateChecks=0
  Stop-MobileVoiceTunnel $root -CanStop { $script:gateChecks++;return $script:gateChecks -eq 1 }
  Assert ($disables -eq ($disableBefore+1) -and $stops -eq $stopsBefore -and $script:killedProcessIds.Count -eq $killsBefore) 'Revocation after disabling must prevent Stop-ScheduledTask and process termination'

  $script:mockTask.State='Ready'
  $script:guardianAllowed=$true
  $script:onProcessReread={ $script:guardianAllowed=$false }
  $disableBefore=$disables
  Stop-MobileVoiceTunnel $root -CanStop { $script:guardianAllowed }
  Assert ($disables -eq ($disableBefore+1) -and $script:killedProcessIds.Count -eq $killsBefore -and $script:mockProcesses.Count -eq 1) 'Revocation during the final identity reread must prevent Stop-Process'
  Stop-MobileVoiceTunnel $root -CanStop { $true }
  Assert ($script:killedProcessIds.Count -eq ($killsBefore+1) -and $script:killedProcessIds[-1] -eq 761) 'A continuously allowed guardian stop must still terminate the verified supervisor'
  $script:mockTask.State='Ready';$script:mockProcesses=@()
  Set-MobileLinkDesiredState -Repo $root -State running
  $startsBefore=$starts
  $script:onProcessSnapshot={Set-MobileLinkDesiredState -Repo $root -State stopped}
  Ensure-MobileVoiceTunnel $root
  Assert ($starts -eq $startsBefore) 'Stop during tunnel ownership discovery must prevent starting the task'
  Set-MobileLinkDesiredState -Repo $root -State running
  $script:mockTask.State='Disabled'
  $enablesBefore=$enables
  Ensure-MobileVoiceTunnel $root -CanStart { $false }
  Assert ($enables -eq $enablesBefore -and $starts -eq $startsBefore) 'Revoked launch intent must prevent both enabling and starting a tunnel'
  $script:mockTask.State='Ready';$script:guardianAllowed=$true
  $script:onProcessSnapshot={$script:guardianAllowed=$false}
  Ensure-MobileVoiceTunnel $root -CanStart { $script:guardianAllowed }
  Assert ($starts -eq $startsBefore) 'Guardian revocation during ownership discovery must prevent starting the tunnel'
  [pscustomobject]@{passed=$checks;terminationRecovery=$true;pauseResume=$true;foreignTaskProtected=$true;forwardHealthVerified=$true} | ConvertTo-Json -Compress
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if ($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'mobile-voice-test-*' -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
