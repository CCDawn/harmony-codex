[CmdletBinding()]
param(
  [string]$ConfigPath = '',
  [int]$IntervalSeconds = 5
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

$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$relayHost = if ($config.RelayHost) { [string]$config.RelayHost } else { '<your-relay-server>' }
$relayPort = if ($config.RelayPort) { [int]$config.RelayPort } else { 19078 }
$relayToken = if ($config.Token) { [string]$config.Token } else { '' }
$deviceId = if ($config.DeviceId) { [string]$config.DeviceId } else { 'default' }
$proxyHost = if ($config.ProxyHost) { [string]$config.ProxyHost } else { '127.0.0.1' }
$proxyPort = if ($config.ProxyPort) { [int]$config.ProxyPort } else { 11078 }
$hdcPath = if ($config.HdcPath) { [string]$config.HdcPath } else { 'C:\openHarmony\20\toolchains\hdc.exe' }
$target = "${proxyHost}:$proxyPort"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$startupLogRoot = Join-Path $repoRoot 'logs\startup'

if (-not (Test-Path -LiteralPath $hdcPath)) {
  throw "HDC 不存在: $hdcPath"
}

function Get-RelayState {
  $url = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
  return (Invoke-RestMethod -UseBasicParsing -Uri $url -TimeoutSec 5).state
}

function Get-StateArray {
  param(
    [object]$State,
    [string]$Name
  )
  $property = $State.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return @()
  }
  return @($property.Value)
}

function Test-HdcConnected {
  $targets = @(& $hdcPath list targets -v 2>&1)
  foreach ($line in $targets) {
    if ($line -match [regex]::Escape($target) -and $line -match '\bConnected\b') {
      return $true
    }
  }
  return $false
}

function Test-HdcShellReady {
  if (-not (Test-HdcConnected)) {
    return $false
  }
  $probe = @(& $hdcPath -t $target shell echo codex-hdc-ready 2>&1)
  return ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'codex-hdc-ready'))
}

function Test-HdcOffline {
  $targets = @(& $hdcPath list targets -v 2>&1)
  foreach ($line in $targets) {
    if ($line -match [regex]::Escape($target) -and $line -match '\bOffline\b') {
      return $true
    }
  }
  return $false
}

$reconnectFailures = 0
$pendingPcSince = $null

function Test-LocalProxyListening {
  try {
    $listeners = @(Get-NetTCPConnection -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $address = [string]$listener.LocalAddress
      if (
        $address -eq $proxyHost -or
        $address -eq '0.0.0.0' -or
        $address -eq '::' -or
        ($proxyHost -eq '127.0.0.1' -and ($address -eq 'localhost' -or $address -eq '::1'))
      ) {
        return $true
      }
    }
  } catch {
  }
  return $false
}

function Wait-LocalProxyListening {
  param([int]$TimeoutSeconds = 10)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalProxyListening) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return (Test-LocalProxyListening)
}

function Stop-LocalProxyProcesses {
  Stop-MobileLinkOwnedProcesses -Repo ([string]$repoRoot) -Roles @('hdc-proxy') | Out-Null
}
function Restart-LocalProxy {
  New-Item -ItemType Directory -Force -Path $startupLogRoot | Out-Null
  Stop-LocalProxyProcesses
  Start-Sleep -Seconds 1

  $relayScript = Join-Path $PSScriptRoot 'start-hdc-relay.ps1'
  if (-not (Test-Path -LiteralPath $relayScript)) {
    Write-Host "$(Get-Date -Format o) cannot restart local proxy, script missing: $relayScript" -ForegroundColor Yellow
    return $false
  }

  $stdout = Join-Path $startupLogRoot 'hdc-proxy-watchdog.stdout.log'
  $stderr = Join-Path $startupLogRoot 'hdc-proxy-watchdog.stderr.log'
  Write-Host "$(Get-Date -Format o) restart local proxy through config: $ConfigPath" -ForegroundColor Yellow
  $proc = Start-Process -FilePath $powerShellHostPath -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $relayScript,
      '-Mode', 'Proxy',
      '-ConfigPath', $ConfigPath
    ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-Host "$(Get-Date -Format o) local proxy process PID=$($proc.Id)" -ForegroundColor DarkGray

  if (Wait-LocalProxyListening -TimeoutSeconds 12) {
    Write-Host "$(Get-Date -Format o) local proxy listening: $target" -ForegroundColor Green
    return $true
  }

  Write-Host "$(Get-Date -Format o) local proxy did not start listening: $target; see $stderr" -ForegroundColor Yellow
  return $false
}

function Ensure-LocalProxyListening {
  param([string]$Reason)

  if (Test-LocalProxyListening) {
    return $true
  }

  Write-Host "$(Get-Date -Format o) local proxy not listening ($Reason), restart it" -ForegroundColor Yellow
  return (Restart-LocalProxy)
}

function Connect-HdcTarget {
  param([string]$Reason)

  Ensure-LocalProxyListening -Reason $Reason | Out-Null

  if (Test-HdcOffline) {
    Write-Host "$(Get-Date -Format o) target is offline, restart hdc server before reconnect" -ForegroundColor Yellow
    & $hdcPath kill -r | Out-Host
    Start-Sleep -Seconds 1
  }

  Write-Host "$(Get-Date -Format o) $Reason, tconn $target" -ForegroundColor Cyan
  $output = @(& $hdcPath tconn $target 2>&1)
  $output | Out-Host
  if (($output -join "`n") -match 'Connect OK|Target is connected') {
    Start-Sleep -Milliseconds 500
    if (-not (Test-HdcShellReady)) {
      Write-Host "$(Get-Date -Format o) tconn returned ok but shell probe failed" -ForegroundColor Yellow
      $script:reconnectFailures += 1
    } else {
      $script:reconnectFailures = 0
    }
    return
  }

  $script:reconnectFailures += 1
  if ($script:reconnectFailures -ge 3) {
    Write-Host "$(Get-Date -Format o) repeated tconn/shell failure, restart hdc server and local proxy" -ForegroundColor Yellow
    & $hdcPath kill -r | Out-Host
    Restart-LocalProxy
    $script:reconnectFailures = 0
    return
  }
}

Write-Host "HDC watchdog started: target=$target relay=${relayHost}:$relayPort device=$deviceId" -ForegroundColor Green

. (Join-Path ([string]$repoRoot) 'tools\windows\mobile-link-lifecycle.ps1')

while ($true) {
  $cycleGate = Enter-MobileLinkCycle ([string]$repoRoot)
  if ($null -eq $cycleGate) { Start-Sleep -Seconds $IntervalSeconds; continue }
  try {
  try {
    $state = Get-RelayState
    $hasPhone = (Get-StateArray -State $state -Name 'phones') -contains $deviceId
    $hasPendingPc = (Get-StateArray -State $state -Name 'pendingPc') -contains $deviceId
    $activeHdc = Get-StateArray -State $state -Name 'activeHdc'
    $hasActiveHdc = $activeHdc -contains $deviceId
    $connected = Test-HdcShellReady
    if (-not $connected -and (Test-HdcConnected)) {
      $reconnectFailures += 1
      Write-Host "$(Get-Date -Format o) hdc target listed connected but shell probe failed: count=$reconnectFailures" -ForegroundColor Yellow
      if ($reconnectFailures -ge 2) {
        & $hdcPath kill -r | Out-Host
        Restart-LocalProxy
        Connect-HdcTarget -Reason 'stale connected target'
      }
    }

    if (($hasPhone -or $hasPendingPc -or $hasActiveHdc) -and -not (Test-LocalProxyListening)) {
      Ensure-LocalProxyListening -Reason 'relay has phone, pending pc, or active hdc' | Out-Null
    }

    if ($hasActiveHdc -and $connected) {
      $reconnectFailures = 0
      $pendingPcSince = $null
    } elseif ($hasPhone -and -not $connected) {
      $pendingPcSince = $null
      Connect-HdcTarget -Reason 'phone waiting'
    } elseif ($hasPendingPc -and -not $connected) {
      if ($null -eq $pendingPcSince) {
        $pendingPcSince = Get-Date
      }
      if (((Get-Date) - $pendingPcSince).TotalSeconds -gt 25) {
        Write-Host "$(Get-Date -Format o) pc pending too long, restart local proxy and hdc server" -ForegroundColor Yellow
        & $hdcPath kill -r | Out-Host
        Restart-LocalProxy
        $pendingPcSince = Get-Date
      }
      Connect-HdcTarget -Reason 'pc pending'
    } elseif ($connected) {
      $reconnectFailures = 0
      $pendingPcSince = $null
    } else {
      $pendingPcSince = $null
    }
  } catch {
    Write-Host "$(Get-Date -Format o) watchdog check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  } finally { Exit-MobileLinkCycle $cycleGate }
  Start-Sleep -Seconds $IntervalSeconds
}
