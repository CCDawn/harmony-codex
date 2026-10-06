$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-control-test-'+[guid]::NewGuid().ToString('N'))
$foreign=$root+'-foreign'
$hostPath=(Get-Process -Id $PID).Path
$checks=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
function Control([string]$Action) {
  $output=& $hostPath -NoProfile -File (Join-Path $root 'tools\windows\mobile-link-control.ps1') -Action $Action -BridgePort $script:port
  $script:controlExit=$LASTEXITCODE
  ($output -join "`n") | ConvertFrom-Json
}
try {
  foreach($dir in @('tools\windows','tools\harmony','scripts','src','HarmonyCodexRemote\entry\src\main\ets\config')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $dir)|Out-Null }
  foreach($file in @('mobile-link-control.ps1','mobile-link-lifecycle.ps1')) { Copy-Item -LiteralPath (Join-Path $repo ('tools\windows\'+$file)) -Destination (Join-Path $root ('tools\windows\'+$file)) }
  @'
export const DEFAULT_BRIDGE_TOKEN: string = 'isolated-master-token';
export const DEFAULT_BRIDGE_TOTP_SECRET: string = 'isolated-secret';
export const DEFAULT_BRIDGE_URL: string = 'http://example.invalid';
'@ | Set-Content (Join-Path $root 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets')
  @'
const http=require('http');
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  let result={ok:true,runtime:{mode:'desktop'}};
  if(req.url==='/desktop/live/status') result={desktop:{desktopLive:false}};
  if(req.url==='/desktop/pair/create') result={pairingCode:'ABCDE-FGHJK',expiresAt:new Date(Date.now()+300000).toISOString(),qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'};
  res.end(JSON.stringify(result));
});
server.listen(Number(process.argv[2]),'127.0.0.1');
'@ | Set-Content (Join-Path $root 'src\server.js')
  @'
param([int]$BridgePort,[switch]$SkipCodexDesktop,[switch]$KeepExistingCodex)
$ErrorActionPreference='Stop'
if(-not $SkipCodexDesktop -or -not $KeepExistingCodex) { throw 'Official Codex lifecycle was not protected' }
if($env:CODEX_BRIDGE_TOKEN -ne 'isolated-master-token') { throw 'Credentials were not passed through the environment' }
$root=Split-Path -Parent $PSScriptRoot
if(-not @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue).Count) {
  Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"'+(Join-Path $root 'src\server.js')+'"'),"$BridgePort") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'mock.stdout.log') -RedirectStandardError (Join-Path $root 'mock.stderr.log') | Out-Null
  $deadline=(Get-Date).AddSeconds(5)
  while((Get-Date) -lt $deadline -and -not @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue).Count) { Start-Sleep -Milliseconds 100 }
}
'@ | Set-Content (Join-Path $root 'scripts\start-codex-mobile-stack.ps1')
  @'
param([int]$BridgePort)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $root 'tools\windows\mobile-link-lifecycle.ps1')
while($true) { $gate=Enter-MobileLinkCycle $root; if($null -ne $gate) { try { [IO.File]::WriteAllText((Join-Path $root 'watch-alive.txt'),'alive') } finally { Exit-MobileLinkCycle $gate } }; Start-Sleep -Seconds 1 }
'@ | Set-Content (Join-Path $root 'tools\harmony\watch-desktop-live.ps1')
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $reservation.Start();$script:port=$reservation.LocalEndpoint.Port;$reservation.Stop()
  $start=Control Start
  Assert ($controlExit -eq 0 -and $start.bridgeHealthy) 'Isolated controller start failed'
  Assert (-not $start.desktopLive) 'Mock health must not imply real desktop availability'
  $bridgePid=@($start.services|Where-Object role -eq 'bridge')[0].pid
  $watchPid=@($start.services|Where-Object role -eq 'watch-desktop-live')[0].pid
  $again=Control Start
  Assert ($controlExit -eq 0) 'Repeated start failed'
  Assert (@($again.services|Where-Object role -eq 'bridge').Count -eq 1) 'Repeated start duplicated the bridge'
  Assert (@($again.services|Where-Object role -eq 'bridge')[0].pid -eq $bridgePid) 'Repeated start replaced the bridge'
  Assert (@($again.services|Where-Object role -eq 'watch-desktop-live')[0].pid -eq $watchPid) 'Repeated start replaced its monitor'
  $repair=Control Repair
  Assert ($controlExit -eq 0 -and @($repair.services|Where-Object role -eq 'bridge')[0].pid -eq $bridgePid) 'Safe repair must preserve an existing healthy bridge'
  $pair=Control Pair
  Assert ($controlExit -eq 0 -and (Test-Path $pair.pairingFile)) 'Pairing display was not created'
  $html=Get-Content -Raw $pair.pairingFile
  Assert ($html.Contains('ABCDE-FGHJK') -and -not $html.Contains('isolated-master-token')) 'Pairing display leaked the master token or omitted the code'
  $stop=Control Stop
  Assert ($controlExit -eq 0 -and $stop.paused -and -not $stop.bridgeHealthy) 'Controller stop did not persist its state'
  Assert (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) 'Controller stop did not release the bridge port'
  $resume=Control Start
  Assert ($controlExit -eq 0 -and -not $resume.paused -and $resume.bridgeHealthy) 'Controller resume failed'
  Assert (@($resume.services|Where-Object role -eq 'bridge')[0].pid -ne $bridgePid) 'Resume did not start a new bridge'
  Control Stop | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $foreign 'src') | Out-Null
  Copy-Item (Join-Path $root 'src\server.js') (Join-Path $foreign 'src\server.js')
  $foreignProcess=Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"'+(Join-Path $foreign 'src\server.js')+'"'),"$port") -WindowStyle Hidden -PassThru
  $foreignIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($foreignProcess.Id)"
  Start-Sleep -Milliseconds 300
  $rejected=Control Start
  Assert ($controlExit -ne 0 -and $null -ne $rejected.error) 'Unknown port owner must block repair'
  Assert (-not $foreignProcess.HasExited) 'Unknown port owner was stopped'
  [pscustomobject]@{passed=$checks;startStopResume=$true;repeatStartPreservedPid=$true;pairingSecretSafe=$true;externalOwnerProtected=$true}|ConvertTo-Json -Compress
} catch {
  foreach($log in @('manager.events.log','manager-start.log')) {
    $path=Join-Path $root ('logs\startup\'+$log)
    if(Test-Path $path) { Get-Content $path | ForEach-Object { $_ -replace 'isolated-master-token|isolated-secret','[test-value]' } | Write-Output }
  }
  throw
} finally {
  if(Test-Path $root) { Stop-MobileLinkOwnedProcesses $root|Out-Null }
  if(Get-Variable foreignIdentity -ErrorAction SilentlyContinue) {
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($foreignIdentity.ProcessId)" -ErrorAction SilentlyContinue
    if(Test-MobileLinkSameProcess $foreignIdentity $current) { Stop-Process -Id $current.ProcessId -Force }
  }
  foreach($dir in @($root,$foreign)) {
    $resolved=[IO.Path]::GetFullPath($dir)
    if($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'mobile-link-control-test-*' -and (Test-Path $resolved)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
