[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$SessionId = '',
  [int]$IntervalSeconds = 12,
  [int]$FailureThreshold = 2,
  [int]$RecoveryCooldownSeconds = 45
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

function Get-ObjectValue {
  param(
    [object]$Object,
    [string]$Name,
    $Fallback
  )
  if ($null -eq $Object) {
    return $Fallback
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Fallback
  }
  return $property.Value
}

$powerShellHostPath = Resolve-CompatiblePowerShellHost
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$bridgeConfigPath = Join-Path ([string]$repoRoot) 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'
if ([string]::IsNullOrWhiteSpace($BridgeToken) -and (Test-Path -LiteralPath $bridgeConfigPath)) {
  $bridgeConfigText = Get-Content -Raw -LiteralPath $bridgeConfigPath
  $bridgeTokenMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
  if ($bridgeTokenMatch.Success) {
    $BridgeToken = $bridgeTokenMatch.Groups[1].Value
  }
}
$env:CODEX_BRIDGE_TOKEN = $BridgeToken
$bridgeUrl = "http://127.0.0.1:$BridgePort"
$missingCount = 0
$nextRecoveryAt = [datetime]::MinValue

function Write-WatchLog {
  param([string]$Message)
  Write-Host "$(Get-Date -Format o) $Message"
}

function Get-BridgeHeaders {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $headers['X-Codex-Bridge-Token'] = $BridgeToken
  }
  return $headers
}

function Get-DesktopLiveStatus {
  try {
    $suffix = ''
    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
      $suffix = "?sessionId=$([uri]::EscapeDataString($SessionId))"
    }
    $response = Invoke-RestMethod -UseBasicParsing -Uri "$bridgeUrl/desktop/live/status$suffix" -Headers (Get-BridgeHeaders) -TimeoutSec 6
    $desktop = Get-ObjectValue -Object $response -Name 'desktop' -Fallback $response
    return [pscustomobject]@{
      Reachable = $true
      DesktopLive = [bool](Get-ObjectValue -Object $desktop -Name 'desktopLive' -Fallback $false)
      Status = [string](Get-ObjectValue -Object $desktop -Name 'status' -Fallback 'unknown')
      ProcessMode = [string](Get-ObjectValue -Object $desktop -Name 'desktopProcessMode' -Fallback '')
      CdpPort = [int](Get-ObjectValue -Object $desktop -Name 'cdpPort' -Fallback 0)
      Reason = [string](Get-ObjectValue -Object $desktop -Name 'reason' -Fallback '')
    }
  } catch {
    return [pscustomobject]@{
      Reachable = $false
      DesktopLive = $false
      Status = 'bridge_unreachable'
      ProcessMode = ''
      CdpPort = 0
      Reason = $_.Exception.Message
    }
  }
}

function Get-CodexDesktopShellProcesses {
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $path = [string]$_.ExecutablePath
    $command = [string]$_.CommandLine
    $isPackagedChatGpt = $path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or
      $command -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe'
    $isLegacyCodex = $path.EndsWith('\app\Codex.exe', [System.StringComparison]::OrdinalIgnoreCase) -or
      ($command -match '\\app\\Codex\.exe"?(?:\s|$)')
    ($isPackagedChatGpt -or $isLegacyCodex) -and $command -notmatch '\s--type='
  })
}

function Invoke-SoftRecovery {
  Write-WatchLog '桌面 CDP 仍在，尝试只恢复 live-host（不会停止 Codex）'
  $script = Join-Path ([string]$repoRoot) 'scripts\recover-codex-desktop-live-soft.ps1'
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-BridgeUrl', $bridgeUrl
  )
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $arguments += @('-SessionId', $SessionId)
  }
  & $powerShellHostPath @arguments
  return $LASTEXITCODE -eq 0
}

function Test-DesktopSupervisorArmed {
  $armPath = Join-Path ([string]$repoRoot) 'logs\state\desktop-supervisor.json'
  if (-not (Test-Path -LiteralPath $armPath)) {
    return $false
  }
  try {
    $arm = Get-Content -Raw -LiteralPath $armPath | ConvertFrom-Json
    $heartbeat = [datetimeoffset]::Parse([string]$arm.heartbeatAt).UtcDateTime
    $ageSeconds = ([datetime]::UtcNow - $heartbeat).TotalSeconds
    if ($ageSeconds -gt 20 -or $ageSeconds -lt -5) {
      return $false
    }
    $armPid = [int]$arm.pid
    return $null -ne (Get-Process -Id $armPid -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Invoke-StartRemoteDesktop {
  Write-WatchLog '未检测到 Codex 桌面进程，启动带 CDP 的受控远程模式'
  $script = Join-Path ([string]$repoRoot) 'scripts\restart-codex-desktop-live.ps1'
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-BridgeUrl', $bridgeUrl,
    '-RefusePlainCodex'
  )
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $arguments += @('-SessionId', $SessionId)
  }
  & $powerShellHostPath @arguments
  return $LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 10
}

Write-WatchLog "desktop live watchdog started: bridge=$bridgeUrl; interval=${IntervalSeconds}s"

. (Join-Path ([string]$repoRoot) 'tools\windows\mobile-link-lifecycle.ps1')

while ($true) {
  $cycleGate = Enter-MobileLinkCycle ([string]$repoRoot)
  if ($null -eq $cycleGate) { Start-Sleep -Seconds $IntervalSeconds; continue }
  try {
  $status = Get-DesktopLiveStatus
  if ($status.Reachable -and $status.DesktopLive) {
    if ($missingCount -gt 0) {
      Write-WatchLog '桌面实时通道已恢复'
    }
    $missingCount = 0
  } elseif (-not $status.Reachable) {
    $missingCount = 0
    Write-WatchLog "bridge 不可用，交给 bridge watchdog 恢复: $($status.Reason)"
  } else {
    $missingCount += 1
    Write-WatchLog "桌面实时通道不可用: count=$missingCount status=$($status.Status) mode=$($status.ProcessMode)"
    if ($missingCount -ge $FailureThreshold -and (Get-Date) -ge $nextRecoveryAt) {
      $shells = @(Get-CodexDesktopShellProcesses)
      $recovered = $false
      if ($shells.Count -eq 0) {
        if (Test-DesktopSupervisorArmed) {
          $recovered = Invoke-StartRemoteDesktop
        } else {
          Write-WatchLog '未检测到 Codex，桌面应用未开，不自动拉起'
        }
      } elseif ($status.CdpPort -gt 0 -or $status.ProcessMode -eq 'remote_debug') {
        $recovered = Invoke-SoftRecovery
      } else {
        Write-WatchLog '检测到普通 Codex 正在运行且没有 CDP；为保护当前桌面工作，不自动关闭它。请用一键启动入口恢复远程模式。'
      }
      $nextRecoveryAt = (Get-Date).AddSeconds([Math]::Max(15, $RecoveryCooldownSeconds))
      $missingCount = 0
      if ($recovered) {
        Write-WatchLog '已触发桌面实时通道恢复，等待下一轮确认'
      }
    }
  }
  } finally { Exit-MobileLinkCycle $cycleGate }
  Start-Sleep -Seconds ([Math]::Max(3, $IntervalSeconds))
}
