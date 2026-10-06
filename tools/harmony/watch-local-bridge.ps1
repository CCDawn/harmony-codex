[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeTotpSecret = $env:CODEX_BRIDGE_TOTP_SECRET,
  [string]$BridgePublicUrl = $env:CODEX_BRIDGE_PUBLIC_URL,
  [string]$RuntimeMode = $env:CODEX_BRIDGE_RUNTIME_MODE,
  [string]$CanaryThreadIds = $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS,
  [int]$IntervalSeconds = 6,
  [int]$FailureThreshold = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
  $RuntimeMode = 'desktop'
}
$RuntimeMode = $RuntimeMode.Trim().ToLowerInvariant()

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
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$bridgeConfigPath = Join-Path ([string]$repoRoot) 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
if (([string]::IsNullOrWhiteSpace($BridgeToken) -or [string]::IsNullOrWhiteSpace($BridgeTotpSecret) -or [string]::IsNullOrWhiteSpace($BridgePublicUrl)) -and (Test-Path -LiteralPath $bridgeConfigPath)) {
  $bridgeConfigText = Get-Content -Raw -LiteralPath $bridgeConfigPath
  if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
    $bridgeTokenMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
    if ($bridgeTokenMatch.Success) {
      $BridgeToken = $bridgeTokenMatch.Groups[1].Value
    }
  }
  if ([string]::IsNullOrWhiteSpace($BridgeTotpSecret)) {
    $bridgeTotpSecretMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOTP_SECRET:\s*string\s*=\s*'([^']*)'")
    if ($bridgeTotpSecretMatch.Success) {
      $BridgeTotpSecret = $bridgeTotpSecretMatch.Groups[1].Value
    }
  }
  if ([string]::IsNullOrWhiteSpace($BridgePublicUrl)) {
    $bridgePublicUrlMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_URL:\s*string\s*=\s*'([^']*)'")
    if ($bridgePublicUrlMatch.Success) {
      $BridgePublicUrl = $bridgePublicUrlMatch.Groups[1].Value
    }
  }
}
$logRoot = Join-Path ([string]$repoRoot) 'logs\startup'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$missingCount = 0

# Voice link (M2): only enable the managed voice server when voice\voice_server.py exists,
# so open-source users without the voice feature keep the bridge voice-free by default.
$voiceServerPath = Join-Path ([string]$repoRoot) 'voice\voice_server.py'
$voiceEnabledText = '0'
$voiceCommand = ''
if (Test-Path -LiteralPath $voiceServerPath) {
  $voiceEnabledText = '1'
  $voicePython = Join-Path ([string]$repoRoot) '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $voicePython)) {
    $voicePython = 'python'
  }
  $voiceCommand = '"{0}" "{1}" --port 8790' -f $voicePython, $voiceServerPath
}

function Write-WatchLog {
  param([string]$Message)
  Write-Host "$(Get-Date -Format o) $Message"
}

function Test-LocalBridge {
  try {
    $health = Invoke-RestMethod -UseBasicParsing `
      -Uri "http://127.0.0.1:${BridgePort}/health" `
      -Headers @{ 'X-Codex-Bridge-Token' = $BridgeToken } `
      -TimeoutSec 4
    $actualMode = [string]$health.runtime.mode
    if ($actualMode -ne $RuntimeMode) {
      Write-WatchLog "local bridge runtime mismatch: expected=$RuntimeMode actual=$actualMode"
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

function Stop-LocalBridge {
  Stop-MobileLinkOwnedProcesses -Repo ([string]$repoRoot) -Roles @('bridge','bridge-host') | Out-Null
}

function Stop-BridgePortOwner {
  $all = @(Get-CimInstance Win32_Process)
  $owned = @(Get-MobileLinkOwnedProcesses -Repo ([string]$repoRoot) -Processes $all)
  $ownedIds = @($owned | ForEach-Object { [int]$_.ProcessId })
  foreach ($listener in @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)) {
    if ([int]$listener.OwningProcess -notin $ownedIds) {
      Write-WatchLog "port $BridgePort has an external owner; preserving it"
      return $false
    }
  }
  return $true
}
function Start-LocalBridge {
  $stdout = Join-Path $logRoot 'bridge.stdout.log'
  $stderr = Join-Path $logRoot 'bridge.stderr.log'
  $command = @"
`$env:CODEX_BRIDGE_HOST='0.0.0.0'
`$env:CODEX_BRIDGE_PORT='$BridgePort'
`$env:CODEX_BRIDGE_WORKSPACE='$repoRoot'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_BRIDGE_TOTP_SECRET='$BridgeTotpSecret'
`$env:CODEX_BRIDGE_PUBLIC_URL='$BridgePublicUrl'
`$env:CODEX_BRIDGE_ADAPTER='codex'
`$env:CODEX_BRIDGE_RUNTIME_MODE='$RuntimeMode'
`$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS='$CanaryThreadIds'
`$env:CODEX_BRIDGE_VOICE_ENABLED='$VoiceEnabledText'
`$env:CODEX_BRIDGE_VOICE_COMMAND='$VoiceCommand'
node src/server.js
"@
  Write-WatchLog "start local bridge on 127.0.0.1:${BridgePort}"
  Start-Process -WindowStyle Hidden -FilePath $powerShellHostPath -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $command
  ) -WorkingDirectory ([string]$repoRoot) -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

Write-WatchLog "local bridge watchdog started: http://127.0.0.1:${BridgePort}; mode=$RuntimeMode"

. (Join-Path ([string]$repoRoot) 'tools\windows\mobile-link-lifecycle.ps1')

while ($true) {
  $cycleGate = Enter-MobileLinkCycle ([string]$repoRoot)
  if ($null -eq $cycleGate) { Start-Sleep -Seconds $IntervalSeconds; continue }
  try {
  if (Test-LocalBridge) {
    if ($missingCount -gt 0) {
      Write-WatchLog "local bridge recovered"
    }
    $missingCount = 0
  } else {
    $missingCount += 1
    Write-WatchLog "local bridge is offline: count=$missingCount"
    if ($missingCount -ge $FailureThreshold) {
      Stop-LocalBridge
      if (Stop-BridgePortOwner) {
        Start-Sleep -Milliseconds 800
        Start-LocalBridge
      }
      $missingCount = 0
    }
  }

  } finally { Exit-MobileLinkCycle $cycleGate }
  Start-Sleep -Seconds $IntervalSeconds
}
