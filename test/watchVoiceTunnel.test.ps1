$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Extract only the helper functions from the voice watchdog (the script itself
# runs an endless loop, so it cannot be dot-sourced whole).
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools\harmony\watch-voice-tunnel.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw ('watch-voice-tunnel.ps1 parse errors: '+$errors[0].Message) }
foreach($name in @('Get-MobileVoiceTunnelForwardPort','Test-MobileVoiceTunnelForwardListening','Test-MobileVoiceTunnelRecentStart','Update-MobileVoiceTunnelForwardHealth')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if ($null -eq $fn) { throw ("function not found in watchdog: $name") }
  . ([scriptblock]::Create($fn.Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('watch-voice-tunnel-test-'+[guid]::NewGuid().ToString('N'))
$installedScript=Join-Path $root 'installed\keep-tunnel.ps1'
$config=[pscustomobject]@{TaskName='CodexHarmonyVoiceTunnelTest';ScriptPath=$installedScript}
$script:forwardProbeFailures=0
$script:checks=0
$script:stops=0
$script:ensures=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
# Mocks for the shared library: these never touch the user's installed task.
function Get-MobileVoiceTunnelConfig { param([string]$Repo) $config }
function Get-MobileVoiceTunnelProcessEvidence { param([object]$Config,[string]$Repo,[switch]$OwnersOnly) [pscustomobject]@{ownerRunning=$script:ownerRunning;owners=@();transportConnected=$false;observed=$script:observed} }
function Stop-MobileVoiceTunnel { param([string]$Repo,[scriptblock]$CanStop=$null) $script:stops++ }
function Ensure-MobileVoiceTunnel { param([string]$Repo,[scriptblock]$CanStart=$null) $script:ensures++ }
function Write-TunnelPortConfig([int]$Port) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installedScript) | Out-Null
  ('@{{LocalPort={0}}}' -f $Port) | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $installedScript) 'tunnel.local.psd1') -Encoding Ascii
}
function Write-SupervisorState([int]$Port,[string]$ChildStartedAt) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installedScript) | Out-Null
  @{version=2;pid=111;startedAt=$ChildStartedAt;updatedAt=$ChildStartedAt;remotePort=18787;localPort=$Port;status='connecting';childPid=222;childStartedAt=$ChildStartedAt} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $installedScript) 'supervisor.json') -Encoding utf8
}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'tools\harmony') | Out-Null

  # 1. Port resolution: tunnel.local.psd1 wins, supervisor.json is fallback,
  #    and an unknown port yields $null (no hardcoded port anywhere).
  Write-TunnelPortConfig 48765
  Write-SupervisorState 48611 ([datetime]::UtcNow.AddHours(-1).ToString('o'))
  Assert ((Get-MobileVoiceTunnelForwardPort $config) -eq 48765) 'configured LocalPort must win over supervisor state'
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $installedScript) 'tunnel.local.psd1') -Force
  Assert ((Get-MobileVoiceTunnelForwardPort $config) -eq 48611) 'supervisor state localPort must be the fallback'
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $installedScript) 'supervisor.json') -Force
  Assert ($null -eq (Get-MobileVoiceTunnelForwardPort $config)) 'missing port sources must resolve to null, never a hardcoded port'

  # 2. TCP probe: a live listener passes, a refused port fails quickly.
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $listener.Start()
  $livePort=([Net.IPEndPoint]$listener.LocalEndpoint).Port
  Assert (Test-MobileVoiceTunnelForwardListening -Port $livePort -TimeoutMs 3000) 'live local listener must pass the forward probe'
  $listener.Stop()
  $deadPort=([Net.IPEndPoint]([Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0).LocalEndpoint)).Port
  Assert (-not (Test-MobileVoiceTunnelForwardListening -Port $deadPort -TimeoutMs 3000)) 'refused local port must fail the forward probe'

  # 3. Failure counting: owner alive but forward dead. Second consecutive
  #    failure crosses the threshold and restarts the tunnel; the counter
  #    resets so the next single failure cannot trigger alone.
  Write-TunnelPortConfig 48765
  Write-SupervisorState 48611 ([datetime]::UtcNow.AddHours(-1).ToString('o'))
  $script:ownerRunning=$true;$script:observed=$true
  $script:stops=0;$script:ensures=0
  $out=@(Update-MobileVoiceTunnelForwardHealth $root)
  Assert ($script:forwardProbeFailures -eq 1) 'first forward failure must count without restart'
  Assert ($script:stops -eq 0) 'first forward failure must not restart the tunnel'
  Assert (($out -join ' ') -match 'voice-forward-probe-failed port=48765 count=1') 'first forward failure must be logged'
  $out=@(Update-MobileVoiceTunnelForwardHealth $root)
  Assert ($script:stops -eq 1 -and $script:ensures -ge 1) 'second consecutive forward failure must restart the tunnel'
  Assert ($script:forwardProbeFailures -eq 0) 'restart must reset the forward failure counter'
  Assert (($out -join ' ') -match 'voice-forward-restart-triggered') 'restart action must be logged'
  $out=@(Update-MobileVoiceTunnelForwardHealth $root)
  Assert ($script:forwardProbeFailures -eq 1 -and $script:stops -eq 1) 'post-restart single failure must not restart again'

  # 4. Healthy forward resets the counter and never restarts.
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,48765)
  $listener.Start()
  try {
    Update-MobileVoiceTunnelForwardHealth $root
    Assert ($script:forwardProbeFailures -eq 0) 'healthy forward must reset the failure counter'
    Assert ($script:stops -eq 1) 'healthy forward must not restart the tunnel'
  } finally { $listener.Stop() }

  # 5. Owner not running: no forward counting, no restart. The main loop's
  #    trailing Ensure-MobileVoiceTunnel call handles the dead-owner repair.
  $script:ownerRunning=$false
  $script:forwardProbeFailures=1
  $out=@(Update-MobileVoiceTunnelForwardHealth $root)
  Assert ($script:forwardProbeFailures -eq 0 -and $script:stops -eq 1) 'dead owner must reset forward counting without restarting'
  Assert (($out -join ' ') -notmatch 'voice-forward-probe-failed') 'dead owner must not produce forward failure logs'

  # 6. Warm-up grace: freshly spawned supervisor is not punished for its own
  #    connect retries, and never restarted during the grace window.
  $script:ownerRunning=$true
  Write-SupervisorState 48611 ([datetime]::UtcNow.ToString('o'))
  $out=@(Update-MobileVoiceTunnelForwardHealth $root)
  Assert ($script:forwardProbeFailures -eq 0 -and $script:stops -eq 1) 'warming supervisor must not count forward failures'
  Assert (($out -join ' ') -match 'voice-forward-probe-warming') 'warm-up must be logged'

  # 7. Unobservable process state keeps the counter untouched (mirrors the
  #    library's own conservatism when CIM inspection fails).
  $script:observed=$false
  $script:forwardProbeFailures=2
  $stopsBefore=$script:stops
  Update-MobileVoiceTunnelForwardHealth $root
  Assert ($script:forwardProbeFailures -eq 2 -and $script:stops -eq $stopsBefore) 'unobservable evidence must neither count nor restart'

  @{passed=$checks;forwardProbeWiredToThreshold=$true;portFromConfig=$true} | ConvertTo-Json -Compress
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  if ($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'watch-voice-tunnel-test-*' -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
}
