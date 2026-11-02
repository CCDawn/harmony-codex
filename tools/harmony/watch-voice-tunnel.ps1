[CmdletBinding()]
param([ValidateRange(2,120)][int]$IntervalSeconds=10, [switch]$Once)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
. (Join-Path $repo 'tools\windows\mobile-voice-tunnel.ps1')

# Forward-health bookkeeping. Task liveness alone misses "process alive but
# forwarding dead", so the loop below also TCP-probes the tunnel's local leg.
# Guardian-open mode never reaches any of this: Enter-MobileLinkCycle returns
# $null there and the whole cycle body is skipped.
$script:forwardProbeFailures=0

function Get-MobileVoiceTunnelForwardPort {
  param([object]$Config)
  # The tunnel's local leg is owned by the installed supervisor's state next to
  # ScriptPath; never hardcode the port here. Config file first, then the
  # supervisor's own state file as fallback.
  try {
    $stateDirectory=Split-Path -Parent ([IO.Path]::GetFullPath([string]$Config.ScriptPath))
    $tunnelConfigPath=Join-Path $stateDirectory 'tunnel.local.psd1'
    if (Test-Path -LiteralPath $tunnelConfigPath) {
      $settings=Import-PowerShellDataFile -LiteralPath $tunnelConfigPath
      if ($null -ne $settings -and $settings.ContainsKey('LocalPort')) {
        $port=[int]$settings.LocalPort
        if ($port -ge 1 -and $port -le 65535) { return $port }
      }
    }
    $supervisorStatePath=Join-Path $stateDirectory 'supervisor.json'
    if (Test-Path -LiteralPath $supervisorStatePath) {
      $state=Get-Content -LiteralPath $supervisorStatePath -Raw | ConvertFrom-Json
      $localPortProperty=$state.PSObject.Properties['localPort']
      if ($null -ne $localPortProperty -and $null -ne $localPortProperty.Value) {
        $port=[int]$localPortProperty.Value
        if ($port -ge 1 -and $port -le 65535) { return $port }
      }
    }
  } catch { }
  return $null
}

function Test-MobileVoiceTunnelForwardListening {
  param([int]$Port,[int]$TimeoutMs=4000)
  $client=[Net.Sockets.TcpClient]::new()
  try {
    $connectTask=$client.ConnectAsync('127.0.0.1',$Port)
    if (-not $connectTask.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Dispose() }
}

function Test-MobileVoiceTunnelRecentStart {
  param([object]$Config,[int]$GraceSeconds=40)
  # A freshly spawned supervisor runs its own SSH connect retries before the
  # forward binds; do not let the probe restart-loop over that warm-up window.
  try {
    $supervisorStatePath=Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath([string]$Config.ScriptPath))) 'supervisor.json'
    if (-not (Test-Path -LiteralPath $supervisorStatePath)) { return $false }
    $state=Get-Content -LiteralPath $supervisorStatePath -Raw | ConvertFrom-Json
    $childStartedProperty=$state.PSObject.Properties['childStartedAt']
    $startedText=$null
    if ($null -ne $childStartedProperty -and $null -ne $childStartedProperty.Value) { $startedText=$childStartedProperty.Value }
    if ([string]::IsNullOrWhiteSpace([string]$startedText)) {
      $startedProperty=$state.PSObject.Properties['startedAt']
      if ($null -ne $startedProperty) { $startedText=$startedProperty.Value }
    }
    if ([string]::IsNullOrWhiteSpace([string]$startedText)) { return $false }
    $startedAt=[datetime]::Parse([string]$startedText,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
    return (((Get-Date).ToUniversalTime()-$startedAt.ToUniversalTime()).TotalSeconds -lt $GraceSeconds)
  } catch { return $false }
}

function Update-MobileVoiceTunnelForwardHealth {
  param([string]$Repo)
  $config=Get-MobileVoiceTunnelConfig $Repo
  if ($null -eq $config) { $script:forwardProbeFailures=0; return }
  $evidence=Get-MobileVoiceTunnelProcessEvidence $config $Repo -OwnersOnly
  if (-not $evidence.observed) { return }
  if (-not $evidence.ownerRunning) { $script:forwardProbeFailures=0; return }
  $port=Get-MobileVoiceTunnelForwardPort $config
  if ($null -eq $port) { return }
  if (Test-MobileVoiceTunnelForwardListening -Port $port) {
    $script:forwardProbeFailures=0
    return
  }
  if (Test-MobileVoiceTunnelRecentStart $config) {
    Write-Output ([datetime]::UtcNow.ToString('o')+' voice-forward-probe-warming port='+$port)
    return
  }
  $script:forwardProbeFailures+=1
  Write-Output ([datetime]::UtcNow.ToString('o')+' voice-forward-probe-failed port='+$port+' count='+$script:forwardProbeFailures)
  if ($script:forwardProbeFailures -lt 2) { return }
  Write-Output ([datetime]::UtcNow.ToString('o')+' voice-forward-restart-triggered port='+$port)
  $script:forwardProbeFailures=0
  try {
    Stop-MobileVoiceTunnel $Repo
  } catch {
    Write-Output ([datetime]::UtcNow.ToString('o')+' voice-forward-stop-failed type='+$_.Exception.GetType().Name)
  }
  Ensure-MobileVoiceTunnel $Repo
}

do {
  $gate=Enter-MobileLinkCycle $repo
  if ($null -ne $gate) {
    try {
      Update-MobileVoiceTunnelForwardHealth $repo
      Ensure-MobileVoiceTunnel $repo
    } catch {
      # Do not record raw task arguments, credentials, or authenticated URLs.
      Write-Output ([datetime]::UtcNow.ToString('o')+' voice-tunnel-check-failed type='+$_.Exception.GetType().Name)
    } finally { Exit-MobileLinkCycle $gate }
  }
  if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
