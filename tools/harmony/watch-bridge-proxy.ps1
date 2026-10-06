[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$IntervalSeconds = 8,
  [int]$FailureThreshold = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-CompatiblePowerShellHost {
  $currentHost = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentHost -and -not [string]::IsNullOrWhiteSpace([string]$currentHost.Path) -and (Test-Path -LiteralPath ([string]$currentHost.Path))) {
    return [string]$currentHost.Path
  }

  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not [string]::IsNullOrWhiteSpace([string]$pwsh.Source) -and (Test-Path -LiteralPath ([string]$pwsh.Source))) {
    return [string]$pwsh.Source
  }

  throw '未找到可用的 PowerShell 主机'
}

$powerShellHostPath = Resolve-CompatiblePowerShellHost
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'hdc-relay.local.psd1'
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "缺少 HDC Relay 配置: $ConfigPath"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$relayHost = if ($config.RelayHost) { [string]$config.RelayHost } else { '<your-relay-server>' }
$relayPort = if ($config.RelayPort) { [int]$config.RelayPort } else { 19078 }
$relayToken = if ($config.Token) { [string]$config.Token } else { '' }
$bridgeToken = [string]$env:CODEX_BRIDGE_TOKEN
$bridgeConfigPath = Join-Path ([string]$repoRoot) 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
if ([string]::IsNullOrWhiteSpace($bridgeToken) -and (Test-Path -LiteralPath $bridgeConfigPath)) {
  $bridgeConfigText = Get-Content -Raw -LiteralPath $bridgeConfigPath
  $bridgeTokenMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
  if ($bridgeTokenMatch.Success) {
    $bridgeToken = $bridgeTokenMatch.Groups[1].Value
  }
}
$bridgePort = 8787
$missingCount = 0

function Get-RelayState {
  $url = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
  return (Invoke-RestMethod -UseBasicParsing -Uri $url -TimeoutSec 5).state
}

function Test-LocalBridge {
  try {
    Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:${bridgePort}/health" -Headers @{ 'X-Codex-Bridge-Token' = $bridgeToken } -TimeoutSec 4 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Stop-BridgeProxy {
  Stop-MobileLinkOwnedProcesses -Repo ([string]$repoRoot) -Roles @('public-proxy') | Out-Null
}
function Start-BridgeProxy {
  $logRoot = Join-Path ([string]$repoRoot) 'logs\startup'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $script = Join-Path $PSScriptRoot 'start-hdc-relay.ps1'
  Start-Process -WindowStyle Hidden -FilePath $powerShellHostPath -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-Mode', 'BridgeProxy',
    '-ConfigPath', $ConfigPath
  ) -WorkingDirectory ([string]$repoRoot) -RedirectStandardOutput (Join-Path $logRoot 'bridge-proxy.stdout.log') -RedirectStandardError (Join-Path $logRoot 'bridge-proxy.stderr.log') | Out-Null
}

Write-Host "Bridge proxy watchdog started: relay=${relayHost}:$relayPort" -ForegroundColor Green

. (Join-Path ([string]$repoRoot) 'tools\windows\mobile-link-lifecycle.ps1')

while ($true) {
  $cycleGate = Enter-MobileLinkCycle ([string]$repoRoot)
  if ($null -eq $cycleGate) { Start-Sleep -Seconds $IntervalSeconds; continue }
  try {
  try {
    $state = Get-RelayState
    $bridgePc = [int]$state.bridgePc
    if ($bridgePc -gt 0) {
      if ($missingCount -gt 0) {
        Write-Host "$(Get-Date -Format o) bridge pool recovered: bridgePc=$bridgePc" -ForegroundColor Green
      }
      $missingCount = 0
    } else {
      $missingCount += 1
      Write-Host "$(Get-Date -Format o) bridge pool empty: count=$missingCount" -ForegroundColor Yellow
      if ($missingCount -ge $FailureThreshold -and (Test-LocalBridge)) {
        Write-Host "$(Get-Date -Format o) restart bridge-proxy because public bridge pool is empty" -ForegroundColor Cyan
        Stop-BridgeProxy
        Start-Sleep -Milliseconds 800
        Start-BridgeProxy
        $missingCount = 0
      }
    }
  } catch {
    Write-Host "$(Get-Date -Format o) bridge watchdog check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  } finally { Exit-MobileLinkCycle $cycleGate }
  Start-Sleep -Seconds $IntervalSeconds
}
