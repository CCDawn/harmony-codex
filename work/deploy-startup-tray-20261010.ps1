$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target=Join-Path $repo 'bin/CodexMobileRemoteTray-unified-v1.exe'
$candidate=Join-Path $repo 'bin/CodexMobileRemoteTray-unified-20261010.exe'
$arm=Get-Content -LiteralPath (Join-Path $repo 'logs/state/desktop-supervisor.json') -Raw | ConvertFrom-Json
$old=Get-Process -Id $arm.pid -ErrorAction Stop
if($old.Path -ne $target){throw 'Unexpected active tray path; not replacing'}
$oldId=$old.Id
$protected=@(Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '\s--type=') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\/]server\.js' -and $_.CommandLine.Contains($repo))
} | Select-Object ProcessId,CreationDate,Name)
$signal=[Threading.EventWaitHandle]::OpenExisting('Local\CodexMobileRemoteTrayExit')
try { [void]$signal.Set() } finally { $signal.Dispose() }
if(-not $old.WaitForExit(45000)){throw 'Tray is still busy; preserving executable and services'}
Copy-Item -LiteralPath $target -Destination (Join-Path $repo 'bin/CodexMobileRemoteTray-unified-v1.pre-20261010.exe') -Force
try {
  Copy-Item -LiteralPath $candidate -Destination $target -Force
  $fresh=Start-Process -FilePath $target -WorkingDirectory $repo -WindowStyle Hidden -PassThru
} catch {
  Copy-Item -LiteralPath (Join-Path $repo 'bin/CodexMobileRemoteTray-unified-v1.pre-20261010.exe') -Destination $target -Force
  Start-Process -FilePath $target -WorkingDirectory $repo -WindowStyle Hidden
  throw
}
Start-Sleep -Seconds 3
$changed=@(foreach($expected in $protected){
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$expected.ProcessId)
  if(-not $current -or $current.CreationDate -ne $expected.CreationDate){$expected.ProcessId}
})
$record=[pscustomobject]@{checkedAt=[datetime]::UtcNow.ToString('o');oldTrayPid=$oldId;newTrayPid=$fresh.Id;trayRunning=(-not $fresh.HasExited);protectedCount=$protected.Count;protectedProcessesPreserved=($changed.Count -eq 0)}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repo 'work/startup-tray-deployment-20261010.json')
$record | ConvertTo-Json -Compress
