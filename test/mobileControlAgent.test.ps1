$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath=Join-Path $sourceRepo 'tools\windows\mobile-control-agent.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Control agent syntax failed'}
$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
# Import function ASTs only. The real script's action dispatcher is never run.
$functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false))
foreach($function in $functions){Invoke-Expression $function.Extent.Text}
$repo=Join-Path ([IO.Path]::GetTempPath()) ('mobile-control-agent-test-'+[guid]::NewGuid().ToString('N'))
$scriptPath=Join-Path $repo 'tools\windows\mobile-control-agent.ps1'
$statePath=Join-Path $repo 'logs\state\mobile-control-agent-status.json'
$script:recorded=[Collections.Generic.List[object]]::new()
# These mocks are installed before Ensure is invoked; task registration/start
# never reaches the real ScheduledTasks cmdlets.
function Get-ScheduledTask {param($TaskName,$ErrorAction) if($script:taskRunning){[pscustomobject]@{State='Running'}}}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) $script:recorded.Add(@{kind='action';execute=$Execute;argument=$Argument;directory=$WorkingDirectory});@{mock=$true}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) @{mock=$true}}
function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$RestartCount,$RestartInterval) @{mock=$true}}
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User) $script:recorded.Add(@{kind='trigger';atLogOn=$AtLogOn.IsPresent});@{mock=$true}}
function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings,$Trigger,[switch]$Force) $script:recorded.Add(@{kind='register';name=$TaskName})}
function Start-ScheduledTask {param($TaskName) $script:recorded.Add(@{kind='start';name=$TaskName})}
$script:taskRunning=$false
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'tools\harmony'),(Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config')|Out-Null
  $before=Get-ControlStatus
  Assert ($before.phase -eq 'unavailable') 'Missing status must fail closed'
  Assert (-not (Test-Path -LiteralPath $statePath)) 'Status must not write a file'
  Ensure-ControlAgent
  Assert ($script:recorded.Count -eq 0) 'Missing config must not register or start a task'
  Assert ((Get-ControlStatus).phase -eq 'unavailable') 'Missing encryption config must explicitly report unavailable'
  $key=Join-Path $repo 'fake-key'
  Set-Content -LiteralPath $key -Value 'fixture-only'
  $settingsPath=Join-Path $repo 'tools\harmony\control-agent.local.psd1'
  ("@{SshDestination='fixture@relay.invalid';IdentityPath='"+$key.Replace("'","''")+"';RelayPort=19078;LocalForwardPort=11978;ControlPort=8788}")|Set-Content -LiteralPath $settingsPath
  "@{Token='test-only-relay-secret'}"|Set-Content -LiteralPath (Join-Path $repo 'tools\harmony\hdc-relay.local.psd1')
  @'
export const DEFAULT_BRIDGE_TOKEN: string = 'test-only-bridge-secret';
export const DEFAULT_BRIDGE_TOTP_SECRET: string = 'JBSWY3DPEHPK3PXP';
'@|Set-Content -LiteralPath (Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets')
  $config=Read-ControlConfiguration
  Assert ($config.BridgeToken -eq 'test-only-bridge-secret' -and $config.RelayToken -eq 'test-only-relay-secret') 'Credentials must come from local configs'
  $arguments=@(Get-ControlSshArguments $config)
  foreach($option in @('-N','-T','BatchMode=yes','IdentitiesOnly=yes','ControlMaster=no','ControlPath=none','ControlPersist=no','ExitOnForwardFailure=yes','StrictHostKeyChecking=yes','ServerAliveInterval=15','ServerAliveCountMax=3')){
    Assert ($arguments -contains $option) ('Required SSH option missing: '+$option)
  }
  Assert ($arguments -contains '127.0.0.1:11978:127.0.0.1:19078') 'Control forward must use its isolated local port'
  Assert (-not (($arguments -join ' ') -match 'test-only-.*secret|StrictHostKeyChecking=no')) 'SSH argv must not contain authentication tokens or disable host verification'
  Ensure-ControlAgent
  Assert (@($script:recorded|Where-Object kind -eq register).Count -eq 1) 'Ensure must register a mock independent task'
  Assert (@($script:recorded|Where-Object kind -eq start).Count -eq 1) 'Ensure must start only that mock task'
  $taskAction=@($script:recorded|Where-Object kind -eq action)[0]
  Assert ($taskAction.execute -like '*\conhost.exe' -and $taskAction.argument -match '^--headless ' -and $taskAction.argument -match '-WindowStyle Hidden') 'Task must use the established hidden conhost supervisor pattern'
  Assert ($taskAction.argument -match '-Action Run$' -and $taskAction.argument -notmatch 'secret|RestartDesktop|mobile-link-control') 'Task must launch only the independent Run action without credentials'
  Assert (@($script:recorded|Where-Object kind -eq trigger)[0].atLogOn) 'Task must resume at user logon'
  $taskName=@($script:recorded|Where-Object kind -eq register)[0].name
  Assert ($taskName -match '^CodexHarmonyMobileControl-[a-f0-9]{16}$') 'Task name must be isolated by repo identity'
  $before=$script:recorded.Count;$script:taskRunning=$true;Ensure-ControlAgent
  Assert ($script:recorded.Count -eq $before) 'Running task must not be re-registered or restarted'
  Write-ControlStatus running 3
  $raw=Get-Content -LiteralPath $statePath -Raw
  Assert ($raw -notmatch 'secret|relay.invalid|IdentityPath|SshDestination|127\.0\.0\.1') 'Persisted heartbeat must not contain credentials or addresses'
  Assert ((Get-ControlStatus).phase -eq 'running') 'Fresh heartbeat phase must remain readable'
  @{version=1;phase='running';heartbeatAt=[datetime]::UtcNow.AddMinutes(-5).ToString('o');failures=0;extraSecret='must-not-echo'}|ConvertTo-Json|Set-Content -LiteralPath $statePath
  $status=Get-ControlStatus
  Assert ($status.phase -eq 'unavailable') 'Stale heartbeat must not claim running'
  Assert (($status|ConvertTo-Json) -notmatch 'extraSecret|must-not-echo') 'Status must project a fixed safe shape'
  $settings=Get-Content -LiteralPath $settingsPath -Raw
  $settings.Replace('LocalForwardPort=11978','LocalForwardPort=19078')|Set-Content -LiteralPath $settingsPath
  $rejected=$false;try{$null=Read-ControlConfiguration}catch{$rejected=$true}
  Assert $rejected 'Config cannot silently switch to the plaintext relay port'
  $source=[IO.File]::ReadAllText($sourcePath)
  Assert ($source -match 'UseShellExecute=\$false' -and $source -match 'CreateNoWindow=\$true') 'Child startup must hide native process windows'
  Assert ($source -match 'ArgumentList.Add' -and $source -match '\$info.Environment\[') 'Secrets must travel only through child environment and paths via argv arrays'
  Assert ($source -match 'managed-child-job\.ps1' -and $source -match '\$tunnel=Start-ControlTunnel' -and $source -match '\$tunnel.Dispose\(\)') 'SSH must use the existing kill-on-close job and be disposed by its owning worker'
  Assert ($source -notmatch 'Stop-Process|Stop-MobileLink|Stop-MobileVoice|mobile-link-control\.ps1|start-codex') 'Agent must not own or start/stop business services'
  $lifecycleTokens=$null;$lifecycleErrors=$null
  $lifecycle=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRepo 'tools\windows\mobile-link-lifecycle.ps1'),[ref]$lifecycleTokens,[ref]$lifecycleErrors)
  $role=$lifecycle.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-MobileLinkRole'},$false)
  Invoke-Expression $role.Extent.Text
  foreach($process in @(@{Name='pwsh.exe';CommandLine='pwsh -File "'+$scriptPath+'" -Action Run'},@{Name='node.exe';CommandLine='node "'+$repo+'\scripts\hdc-relay\start-control-agent.mjs"'},@{Name='ssh.exe';CommandLine='ssh -N -T -L 127.0.0.1:11978:127.0.0.1:19078'})){
    Assert ((Get-MobileLinkRole ([pscustomobject]$process)) -eq '') 'Business Stop must not recognize control-agent processes'
  }
  $entry=[IO.File]::ReadAllText((Join-Path $sourceRepo 'scripts\hdc-relay\start-control-agent.mjs'))
  Assert ($entry -match "role: 'control-pc'" -and $entry -match "relayHost: '127.0.0.1'" -and $entry -match 'const relayPort = 11978') 'Node entry must relay only over the encrypted loopback forward'
  Assert ($entry -match "server.listen\(controlPort, '127.0.0.1'" -and $entry -match 'const controlPort = 8788') 'Independent API listener must stay on loopback control port'
  $tray=[IO.File]::ReadAllText((Join-Path $sourceRepo 'scripts\windows-launcher\UnifiedTrayContext.cs'))
  Assert (@([regex]::Matches($tray,'EnsureControlAgent\(\);')).Count -eq 2) 'Tray must Ensure on initialization and its 30 second tick'
  Assert ($tray -match 'if \(controlAgentBusy \|\| exiting\) return;') 'Ensure needs an independent reentrancy guard'
  # Exercise just the owned hard-repair function with a mock launcher. Importing
  # AST functions avoids its CLI dispatcher, operation claims and real services.
  $controlAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'),[ref]$null,[ref]$null)
  foreach($name in @('Invoke-DesktopRepair','Get-LinkValue')){
    $definition=$controlAst.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    Invoke-Expression $definition.Extent.Text
  }
  $GuardianRepair=$false;$bridgeUrl='http://127.0.0.1:8787'
  $script:launchCount=0;$script:softCount=0;$script:softState='not-needed';$script:desktopLive=$true;$script:launcherExit=0;$script:launcherFinished=$true
  function Invoke-DesktopSafeRecovery{$script:softCount++;[pscustomobject]@{state=$script:softState}}
  function Test-GuardianRepairAllowed{$true}
  function Write-LinkEvent([string]$Message){}
  function Set-LinkOperationPhase([string]$Phase){}
  function Get-DesktopLauncherArguments([string[]]$Arguments){$Arguments}
  function Get-LinkApi([string]$Path){[pscustomobject]@{desktop=[pscustomobject]@{desktopLive=$script:desktopLive}}}
  function Start-MobileLinkDetached {
    param($HostPath,$ScriptPath,$Arguments,$LogPath,$WorkingDirectory)
    Assert ($ScriptPath -like '*\scripts\restart-codex-desktop-live.ps1') 'Hard recovery must use the existing desktop restart launcher'
    $script:launchCount++
    $process=[pscustomobject]@{ExitCode=$script:launcherExit}
    $process|Add-Member ScriptMethod WaitForExit {param($Timeout)$script:launcherFinished}
    $process|Add-Member ScriptMethod Dispose {}
    $process
  }
  $result=Invoke-DesktopRepair -ForceRestart
  Assert ($result.state -eq 'restarted' -and $script:launchCount -eq 1 -and $script:softCount -eq 0) 'Explicit healthy hard repair must execute one real restart path, never a healthy soft no-op'
  $GuardianRepair=$true;$script:softState='recovered'
  $result=Invoke-DesktopRepair -ForceRestart
  Assert ($result.state -eq 'recovered' -and $script:launchCount -eq 1) 'Guardian must retain soft recovery protection even if passed ForceRestart'
  $script:softState='pending';$result=Invoke-DesktopRepair
  Assert ($result.state -eq 'pending' -and $script:launchCount -eq 1) 'Guardian must not duplicate a pending recovery'
  $GuardianRepair=$false;$script:desktopLive=$false
  $result=Invoke-DesktopRepair -ForceRestart
  Assert ($result.state -eq 'failed' -and $script:launchCount -eq 2) 'Launcher exit zero without current desktop verification must fail'
  $script:desktopLive=$true;$script:launcherExit=1
  $result=Invoke-DesktopRepair -ForceRestart
  Assert ($result.state -eq 'failed' -and $script:launchCount -eq 3) 'Healthy readback must not hide a failed restart process'
  $script:launcherExit=0;$script:launcherFinished=$false
  $result=Invoke-DesktopRepair -ForceRestart
  Assert ($result.state -eq 'pending' -and $script:launchCount -eq 4) 'A bounded launcher wait must report pending instead of completed restart'
  $startLink=$controlAst.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-Link'},$true).Extent.Text
  Assert ($startLink -match 'Invoke-DesktopRepair -ForceRestart:\(-not \$GuardianRepair\)') 'Only explicit non-Guardian hard Start-Link path may force the restart'
  Write-Output ('PASS mobile control agent: '+$checks+' AST/mock assertions; no real task or service actions')
}finally{
  # The test owns this freshly generated absolute temp directory only.
  $resolved=[IO.Path]::GetFullPath($repo)
  $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if($resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -like 'mobile-control-agent-test-*'){
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
