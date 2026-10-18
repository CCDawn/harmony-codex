[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeUrl = $env:CODEX_BRIDGE_URL,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$HdcPath = $env:CODEX_HDC_PATH,
  [string]$HdcTarget = '',
  [string]$ConfigPath = '',
  [int]$TimeoutSec = 3,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$checks = @()
$bridgeConfigPath = Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'

if (Test-Path -LiteralPath $bridgeConfigPath) {
  $bridgeConfigText = Get-Content -Raw -LiteralPath $bridgeConfigPath
  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    $urlMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_URL:\s*string\s*=\s*'([^']*)'")
    if ($urlMatch.Success) {
      $BridgeUrl = $urlMatch.Groups[1].Value
    }
  }
  if ([string]::IsNullOrWhiteSpace($BridgeToken)) {
    $tokenMatch = [regex]::Match($bridgeConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
    if ($tokenMatch.Success) {
      $BridgeToken = $tokenMatch.Groups[1].Value
    }
  }
}

function Add-Check {
  param(
    [string]$Id,
    [string]$Status,
    [string]$Message,
    [object]$Details = $null
  )

  $script:checks += [pscustomobject]@{
    id = $Id
    status = $Status
    message = $Message
    details = $Details
  }
}

function Read-DataFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return @{}
  }
  try {
    return Import-PowerShellDataFile -LiteralPath $Path
  } catch {
    return @{ __error = $_.Exception.Message }
  }
}

function Invoke-HttpJson {
  param(
    [string]$Uri,
    [hashtable]$Headers = @{}
  )

  try {
    $value = Invoke-RestMethod -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    return [pscustomobject]@{ ok = $true; value = $value; error = '' }
  } catch {
    return [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message }
  }
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @()
  )

  try {
    $output = & $FilePath @Arguments 2>&1
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    return [pscustomobject]@{
      ok = $exitCode -eq 0
      exitCode = $exitCode
      output = ($output -join "`n")
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      exitCode = -1
      output = $_.Exception.Message
    }
  }
}

if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = "http://127.0.0.1:$BridgePort"
}
$BridgeUrl = $BridgeUrl.TrimEnd('/')

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $repoRoot 'tools\harmony\hdc-relay.local.psd1'
}

$relayConfig = Read-DataFile -Path $ConfigPath
$deployConfig = Read-DataFile -Path (Join-Path $repoRoot 'tools\harmony\codex-remote.config.psd1')

if ([string]::IsNullOrWhiteSpace($HdcPath)) {
  if ($relayConfig.ContainsKey('HdcPath')) {
    $HdcPath = [string]$relayConfig.HdcPath
  } elseif ($deployConfig.ContainsKey('HdcPath')) {
    $HdcPath = [string]$deployConfig.HdcPath
  }
}

if ([string]::IsNullOrWhiteSpace($HdcTarget) -and $relayConfig.ContainsKey('DeviceId')) {
  $HdcTarget = [string]$relayConfig.DeviceId
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nodeVersion = (& node --version 2>$null)
  Add-Check -Id 'node' -Status 'ok' -Message "node $nodeVersion" -Details @{ path = $node.Source }
} else {
  Add-Check -Id 'node' -Status 'fail' -Message 'node executable not found'
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
  $npmVersion = (& npm --version 2>$null)
  Add-Check -Id 'npm' -Status 'ok' -Message "npm $npmVersion" -Details @{ path = $npm.Source }
} else {
  Add-Check -Id 'npm' -Status 'warn' -Message 'npm executable not found'
}

if (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json')) {
  Add-Check -Id 'package' -Status 'ok' -Message 'package.json found'
} else {
  Add-Check -Id 'package' -Status 'fail' -Message 'package.json missing'
}

$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
  $headers['X-Codex-Bridge-Token'] = $BridgeToken
}

$health = Invoke-HttpJson -Uri "$BridgeUrl/health" -Headers $headers
if ($health.ok) {
  Add-Check -Id 'bridge' -Status 'ok' -Message "bridge health ok at $BridgeUrl" -Details $health.value
} else {
  Add-Check -Id 'bridge' -Status 'warn' -Message "bridge health unavailable: $($health.error)" -Details @{ url = "$BridgeUrl/health" }
}

$sessions = Invoke-HttpJson -Uri "$BridgeUrl/codex/sessions?limit=1" -Headers $headers
if ($sessions.ok) {
  $count = 0
  if ($sessions.value.PSObject.Properties['sessions'] -and $sessions.value.sessions) {
    $count = @($sessions.value.sessions).Count
  }
  Add-Check -Id 'sessions' -Status 'ok' -Message "session API ok, sample count=$count" -Details $sessions.value
} else {
  Add-Check -Id 'sessions' -Status 'warn' -Message "session API unavailable: $($sessions.error)"
}

$desktopLive = Invoke-HttpJson -Uri "$BridgeUrl/desktop/live/status" -Headers $headers
if ($desktopLive.ok) {
  $desktopReady = $false
  if ($desktopLive.value -and $desktopLive.value.PSObject.Properties['desktop']) {
    $desktop = $desktopLive.value.desktop
    $desktopReady = $null -ne $desktop -and $null -ne $desktop.PSObject.Properties['desktopLive'] -and $desktop.desktopLive -eq $true
  }
  if ($desktopReady) {
    Add-Check -Id 'cdp' -Status 'ok' -Message 'desktop live channel ready through bridge' -Details $desktopLive.value
  } else {
    Add-Check -Id 'cdp' -Status 'warn' -Message 'desktop status API reachable, but desktop live channel is not ready' -Details $desktopLive.value
  }
} else {
  $directCdp = Invoke-HttpJson -Uri 'http://127.0.0.1:9229/json/version'
  if ($directCdp.ok) {
    Add-Check -Id 'cdp' -Status 'ok' -Message 'direct CDP endpoint reachable on 127.0.0.1:9229' -Details $directCdp.value
  } else {
    Add-Check -Id 'cdp' -Status 'warn' -Message "CDP not reachable through bridge or direct probe: $($desktopLive.error)"
  }
}

if ([string]::IsNullOrWhiteSpace($HdcPath) -or $HdcPath.StartsWith('<')) {
  Add-Check -Id 'hdc' -Status 'warn' -Message 'HdcPath is not configured'
} elseif (-not (Test-Path -LiteralPath $HdcPath)) {
  Add-Check -Id 'hdc' -Status 'fail' -Message "hdc.exe not found: $HdcPath"
} else {
  $hdc = Invoke-External -FilePath $HdcPath -Arguments @('list', 'targets')
  $status = if ($hdc.ok -and $hdc.output.Trim().Length -gt 0 -and $hdc.output -notmatch '\[Empty\]') { 'ok' } else { 'warn' }
  Add-Check -Id 'hdc' -Status $status -Message 'hdc list targets completed' -Details @{ target = $HdcTarget; output = $hdc.output; exitCode = $hdc.exitCode }
}

if ($relayConfig.ContainsKey('__error')) {
  Add-Check -Id 'relay-config' -Status 'fail' -Message "relay config parse failed: $($relayConfig.__error)"
} elseif ($relayConfig.Count -eq 0) {
  Add-Check -Id 'relay-config' -Status 'warn' -Message 'relay local config is missing'
} elseif ([string]$relayConfig.RelayHost -match '^<|your-relay-server') {
  Add-Check -Id 'relay-config' -Status 'warn' -Message 'relay config still uses placeholder values'
} else {
  Add-Check -Id 'relay-config' -Status 'ok' -Message "relay config present for $($relayConfig.RelayHost):$($relayConfig.RelayPort)"
}

$failedRequired = @($checks | Where-Object { $_.id -in @('node', 'package', 'bridge', 'sessions') -and $_.status -ne 'ok' })
$summary = [pscustomobject]@{
  ok = $failedRequired.Count -eq 0
  generatedAt = (Get-Date).ToString('o')
  repoRoot = $repoRoot
  bridgeUrl = $BridgeUrl
  checks = @($checks)
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 10
} else {
  Write-Host "Agent doctor: $repoRoot" -ForegroundColor Cyan
  $checks | Select-Object id,status,message | Format-Table -AutoSize
}
