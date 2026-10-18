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
  foreach($file in @('mobile-link-control.ps1','mobile-link-lifecycle.ps1','mobile-voice-tunnel.ps1','mobile-link-diagnostics.mjs')) { Copy-Item -LiteralPath (Join-Path $repo ('tools\windows\'+$file)) -Destination (Join-Path $root ('tools\windows\'+$file)) }
  Copy-Item -LiteralPath (Join-Path $repo 'src\totp.js') -Destination (Join-Path $root 'src\totp.js')
  @'
export const DEFAULT_BRIDGE_TOKEN: string = 'isolated-master-token';
export const DEFAULT_BRIDGE_TOTP_SECRET: string = 'JBSWY3DPEHPK3PXP';
export const DEFAULT_BRIDGE_URL: string = 'http://example.invalid';
'@ | Set-Content (Join-Path $root 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets')
  @'
const http=require('http');
const fs=require('fs'),path=require('path');
const root=path.dirname(__dirname),modeFile=path.join(root,'desktop-mode.txt');
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  let result={ok:true,runtime:{mode:'desktop'}};
  const mode=fs.existsSync(modeFile)?fs.readFileSync(modeFile,'utf8').trim():'plain';
  // The API can report a configured CDP port even when plain Codex has no listener.
  if(req.url==='/desktop/live/status') result={desktop:{desktopLive:mode==='ready',failureClass:mode==='plain'?'codex_plain_no_cdp':'none',desktopProcessMode:mode==='plain'?'plain':'remote_debug',cdpPort:12345}};
  if(req.url.startsWith('/codex/sessions')) result={sessions:[]};
  if(req.url==='/companion/profile') result={profile:{id:'bear',roomId:'room'}};
  if(req.url.startsWith('/companion/messages')) result={entries:[]};
  if(req.url.startsWith('/companion/computer/status')) result={assistantId:'bear',roomId:'room',ready:false};
  if(req.url==='/desktop/live/recover') {
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      fs.writeFileSync(path.join(root,'recovery-called.txt'),body);
      fs.writeFileSync(modeFile,'ready');res.end(JSON.stringify({desktop:{desktopLive:true}}));
    });return;
  }
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
# Simulate the real stack's intermediate readiness failure before the controller
# has performed synchronous desktop recovery.
exit 2
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
  Assert ($controlExit -eq 2 -and $start.bridgeHealthy -and $start.startupOutcome.state -eq 'blocked') 'Unavailable desktop must return a structured blocked startup, not success'
  Assert (-not $start.desktopLive) 'Mock health must not imply real desktop availability'
  Assert ($start.diagnostics.severity -eq 'degraded' -and $start.diagnostics.nextAction -eq 'desktop_restart_required') 'Healthy bridge must not mask a blocked desktop connection'
  # Match the tray: no console, both streams redirected, UTF-8 reader.
  $info=[Diagnostics.ProcessStartInfo]::new($hostPath)
  $info.Arguments='-NoProfile -File "'+(Join-Path $root 'tools\windows\mobile-link-control.ps1')+'" -Action Status -BridgePort '+$port
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.Encoding]::UTF8; $info.StandardErrorEncoding=[Text.Encoding]::UTF8
  $hidden=[Diagnostics.Process]::Start($info)
  try {
    $stdout=$hidden.StandardOutput.ReadToEndAsync(); $stderr=$hidden.StandardError.ReadToEndAsync()
    Assert ($hidden.WaitForExit(20000)) 'Hidden status collection timed out'
    $hiddenStatus=$stdout.Result | ConvertFrom-Json
    Assert ($hidden.ExitCode -eq 0 -and $hiddenStatus.diagnostics.severity -eq 'degraded') ('Hidden native output must be valid diagnostic JSON: exit='+$hidden.ExitCode+' severity='+$hiddenStatus.diagnostics.severity+' checks='+$hiddenStatus.diagnostics.checks.Count)
    Assert ($hiddenStatus.diagnostics.checks[0].title -eq '本地桥接') 'Hidden status must preserve UTF-8 Chinese text'
  } finally { $hidden.Dispose() }
  $bridgePid=@($start.services|Where-Object role -eq 'bridge')[0].pid
  $watchPid=@($start.services|Where-Object role -eq 'watch-desktop-live')[0].pid
  $again=Control Start
  Assert ($controlExit -eq 2) 'Repeated start must keep reporting the blocked desktop'
  Assert (@($again.services|Where-Object role -eq 'bridge').Count -eq 1) 'Repeated start duplicated the bridge'
  Assert (@($again.services|Where-Object role -eq 'bridge')[0].pid -eq $bridgePid) 'Repeated start replaced the bridge'
  Assert (@($again.services|Where-Object role -eq 'watch-desktop-live')[0].pid -eq $watchPid) 'Repeated start replaced its monitor'
  $repair=Control Repair
  Assert ($controlExit -eq 2 -and @($repair.services|Where-Object role -eq 'bridge')[0].pid -eq $bridgePid) 'Blocked repair must preserve an existing healthy bridge'
  Assert ($repair.desktopRecovery.state -eq 'blocked') 'Plain Codex must be retained without a restart'
  Assert (-not (Test-Path (Join-Path $root 'recovery-called.txt'))) 'Plain Codex must not trigger a desktop recovery POST'
  Set-Content -LiteralPath (Join-Path $root 'desktop-mode.txt') -Value 'remote'
  $soft=Control Start
  Assert ($controlExit -eq 0 -and $soft.startupOutcome.state -eq 'ready') 'Start must recover an available desktop channel synchronously'
  Assert ($soft.desktopRecovery.state -eq 'recovered' -and $soft.desktopLive) 'A recoverable desktop connection must use soft recovery'
  $request=Get-Content -Raw -LiteralPath (Join-Path $root 'recovery-called.txt') | ConvertFrom-Json
  Assert ($request.mode -eq 'soft') 'Safe recovery must never request hard mode'
  Assert ($soft.diagnostics.severity -eq 'unverified') 'Read checks must not claim end-to-end voice verification'
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
