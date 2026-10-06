$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
$checks=0
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:checks++
}
function Fake([int]$Id,[int]$Parent,[string]$Name,[string]$Command,[int]$Age=0) {
  [pscustomobject]@{ProcessId=$Id;ParentProcessId=$Parent;Name=$Name;CommandLine=$Command;CreationDate=[datetime]'2026-10-07T00:00:00Z'+[timespan]::FromSeconds($Age)}
}
$root='C:\isolated\mobile-link'
$snapshot=@(
  (Fake 10 0 'pwsh.exe' 'pwsh -File C:\isolated\mobile-link\tools\harmony\watch-local-bridge.ps1'),
  (Fake 11 10 'node.exe' 'node src/server.js' 1),
  (Fake 12 11 'python.exe' 'python voice_server.py --port 8790' 2),
  (Fake 13 10 'Codex.exe' 'Codex --remote-debugging-port=9229' 1),
  (Fake 14 10 'node.exe' 'node unrelated-project.js' 1),
  (Fake 15 10 'node.exe' 'node src/server.js' -1),
  (Fake 20 0 'pwsh.exe' 'pwsh -File C:\isolated\mobile-link-other\tools\harmony\watch-local-bridge.ps1'),
  (Fake 21 20 'node.exe' 'node src/server.js' 1)
)
$owned=@(Get-MobileLinkOwnedProcesses $root $snapshot)
$ids=@($owned|ForEach-Object ProcessId)
Assert ($ids.Count -eq 3) 'Only known service descendants should be managed'
Assert (($ids -contains 10) -and ($ids -contains 11) -and ($ids -contains 12)) 'Bridge and voice descendants were not discovered'
Assert (-not ($ids -contains 13)) 'Official Codex must remain external'
Assert (-not ($ids -contains 14)) 'Unknown child must not be stopped'
Assert (-not ($ids -contains 15)) 'Reused parent PID must not confer ownership'
Assert (-not ($ids -contains 20)) 'Sibling directory must not confer ownership'
Assert (-not (Test-MobileLinkSameProcess $snapshot[0] (Fake 10 0 'pwsh.exe' $snapshot[0].CommandLine 1))) 'PID reuse must fail revalidation'

$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-test-'+[guid]::NewGuid().ToString('N'))
$foreignRoot=$testRoot+'-foreign'
$created=@()
try {
  foreach($dir in @($testRoot,$foreignRoot)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'tools\harmony') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'src') | Out-Null
    @'
const fs=require('fs');
const server=require('net').createServer();
server.listen(0,'127.0.0.1',()=>fs.writeFileSync('port.txt',String(server.address().port)));
'@ | Set-Content -LiteralPath (Join-Path $dir 'src\server.js')
    @'
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node=Start-Process -FilePath (Get-Command node).Source -ArgumentList 'src/server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
$node.WaitForExit()
'@ | Set-Content -LiteralPath (Join-Path $dir 'tools\harmony\watch-local-bridge.ps1')
    $hostPath=(Get-Process -Id $PID).Path
    $process=Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-File',('"'+(Join-Path $dir 'tools\harmony\watch-local-bridge.ps1')+'"')) -WindowStyle Hidden -WorkingDirectory $dir -PassThru
    $created+=$process.Id
  }
  $deadline=(Get-Date).AddSeconds(12)
  while((Get-Date) -lt $deadline -and (-not (Test-Path (Join-Path $testRoot 'port.txt')) -or -not (Test-Path (Join-Path $foreignRoot 'port.txt')))) { Start-Sleep -Milliseconds 100 }
  Assert (Test-Path (Join-Path $testRoot 'port.txt')) 'Managed mock did not listen'
  Assert (Test-Path (Join-Path $foreignRoot 'port.txt')) 'Foreign mock did not listen'
  $testPort=[int](Get-Content (Join-Path $testRoot 'port.txt'))
  $foreignPort=[int](Get-Content (Join-Path $foreignRoot 'port.txt'))
  Set-MobileLinkDesiredState $testRoot stopped
  Assert (Test-MobileLinkPaused $testRoot) 'Pause must persist on disk'
  Assert ($null -eq (Enter-MobileLinkCycle $testRoot)) 'Stopped state must prevent recovery'
  $result=Stop-MobileLinkOwnedProcesses $testRoot
  Assert ($result.stopped.Count -eq 2) 'Stop must terminate actual owned host and relative-path Node child'
  Assert ($result.remaining.Count -eq 0) 'Stop must verify process exit'
  Start-Sleep -Milliseconds 300
  Assert (@(Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Managed listener was not released'
  Assert (@(Get-NetTCPConnection -LocalPort $foreignPort -State Listen -ErrorAction SilentlyContinue).Count -gt 0) 'Foreign listener was incorrectly stopped'
  Set-MobileLinkDesiredState $testRoot running
  $cycle=Enter-MobileLinkCycle $testRoot
  Assert ($null -ne $cycle) 'Resume must allow recovery'
  $module=Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1'
  $probe=Join-Path $testRoot 'lock-probe.ps1'
  $lockOutput=Join-Path $testRoot 'lock.txt'
  @'
param([string]$Module,[string]$Root,[string]$Output)
. $Module
$gate=Enter-MobileLinkCycle $Root
if($null -eq $gate) { 'blocked' | Set-Content $Output }
else { 'entered' | Set-Content $Output; Exit-MobileLinkCycle $gate }
'@ | Set-Content $probe
  $probeProcess=Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-File',('"'+$probe+'"'),'-Module',('"'+$module+'"'),'-Root',('"'+$testRoot+'"'),'-Output',('"'+$lockOutput+'"')) -WindowStyle Hidden -PassThru
  Assert ($probeProcess.WaitForExit(8000)) 'Cross-process lock probe timed out'
  Assert ((Get-Content $lockOutput).Trim() -eq 'blocked') 'Concurrent recovery must not bypass lifecycle mutex'
  Exit-MobileLinkCycle $cycle
  $cycle=$null
  Set-Content -LiteralPath (Get-MobileLinkStatePath $testRoot) -Value '{broken'
  Assert (Test-MobileLinkPaused $testRoot) 'Corrupt state must fail closed'
  [pscustomobject]@{passed=$checks;realProcessStop=$true;foreignListenerPreserved=$true;mutex=$true} | ConvertTo-Json -Compress
} finally {
  if (Get-Variable cycle -ErrorAction SilentlyContinue) { if($null -ne $cycle) { Exit-MobileLinkCycle $cycle } }
  foreach($dir in @($testRoot,$foreignRoot)) { if(Test-Path $dir) { Stop-MobileLinkOwnedProcesses $dir | Out-Null } }
  # These are fresh, verified test directories under the system temp directory.
  foreach($dir in @($testRoot,$foreignRoot)) {
    $resolved=[IO.Path]::GetFullPath($dir)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'mobile-link-test-*') { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
