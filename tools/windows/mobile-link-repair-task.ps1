. (Join-Path $PSScriptRoot 'mobile-link-operation.ps1')
function Start-MobileLinkRepairTask {
  param([string]$Repo,[int]$BridgePort=8787,[switch]$ProbeOnly,[switch]$GuardianRepair,[string]$GuardianComponents='')
  # The worker takes the separate lifecycle gate; never wait for that gate here.
  $gate=Enter-MobileLinkOperationGate $Repo
  $claim=$null
  try {
    $name='CodexHarmonyExplicitDesktopRepair-'+(Get-MobileLinkOperationKey $Repo)
    $claim=New-MobileLinkOperation -Repo $Repo -Action Repair
    $runId=$claim.operation.operationId
    $resultPath=Join-Path $Repo ('logs\state\desktop-repair-results\'+$runId+'.json')
    if ($claim.joined) {
      return [pscustomobject]@{runId=$runId;taskName=$name;resultPath=$resultPath;joined=$true;action=$claim.operation.action}
    }
    # A worker beyond deadline must exit before its registered task can change.
    $existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing -and [string]$existing.State -eq 'Running') { throw 'Previous repair worker has not exited' }
    $runner=Join-Path $Repo 'tools\windows\run-mobile-link-repair.ps1'
    $hostPath=(Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments='--headless "'+$hostPath+'" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$runner+'" -BridgePort '+$BridgePort+' -RunId '+$runId
    if ($ProbeOnly) { $arguments+=' -ProbeOnly' }
    if ($GuardianRepair) {
      $components=@($GuardianComponents -split ',' | Where-Object { $_ -in @('desktop','sessions','companion') } | Sort-Object -Unique)
      if (-not $components.Count) { throw 'Missing scoped desktop recovery components' }
      $arguments+=' -GuardianRepair -GuardianComponents '+($components -join ',')
    }
    $action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $Repo
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $name
    return [pscustomobject]@{runId=$runId;taskName=$name;resultPath=$resultPath;joined=$false;action='Repair'}
  } catch {
    if ($claim -and -not $claim.joined) {
      Set-MobileLinkOperation -Repo $Repo -OperationId $claim.operation.operationId -Phase failed | Out-Null
      $completion=@{runId=$claim.operation.operationId;exitCode=1;completedAt=[datetime]::UtcNow.ToString('o');result=@{error='独立修复任务未能启动，请查看日志。';action='Repair'}}
      Write-MobileLinkAtomicJson $resultPath $completion -Depth 10
      Write-MobileLinkAtomicJson (Join-Path $Repo 'logs\state\desktop-repair-result.json') $completion -Depth 10
    }
    throw
  } finally { $gate.ReleaseMutex(); $gate.Dispose() }
}
