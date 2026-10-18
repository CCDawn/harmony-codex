function Start-MobileLinkRepairTask {
  param([string]$Repo,[int]$BridgePort=8787,[switch]$ProbeOnly,[switch]$GuardianRepair)
  $name='CodexHarmonyExplicitDesktopRepair'
  $existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($existing -and [string]$existing.State -eq 'Running') { throw 'Desktop repair already running.' }
  $runId=[guid]::NewGuid().ToString('N')
  $runner=Join-Path $Repo 'tools\windows\run-mobile-link-repair.ps1'
  $hostPath=(Get-Command pwsh.exe -ErrorAction Stop).Source
  $arguments='--headless "'+$hostPath+'" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$runner+'" -BridgePort '+$BridgePort+' -RunId '+$runId
  if ($ProbeOnly) { $arguments+=' -ProbeOnly' }
  if ($GuardianRepair) { $arguments+=' -GuardianRepair' }
  $action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $Repo
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 6) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  [pscustomobject]@{runId=$runId;taskName=$name;resultPath=(Join-Path $Repo 'logs\state\desktop-repair-result.json')}
}
