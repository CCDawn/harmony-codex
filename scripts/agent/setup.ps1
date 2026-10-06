[CmdletBinding()]
param(
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$results = @()

function Add-Result {
  param(
    [string]$Id,
    [string]$Status,
    [string]$Message,
    [string]$Path = ''
  )

  $script:results += [pscustomobject]@{
    id = $Id
    status = $Status
    message = $Message
    path = $Path
  }
}

function Ensure-FromExample {
  param(
    [string]$Id,
    [string]$ExamplePath,
    [string]$LocalPath
  )

  if (Test-Path -LiteralPath $LocalPath) {
    Add-Result -Id $Id -Status 'exists' -Message 'local config already exists' -Path $LocalPath
    return
  }

  if (-not (Test-Path -LiteralPath $ExamplePath)) {
    Add-Result -Id $Id -Status 'missing-example' -Message 'example config is missing' -Path $ExamplePath
    return
  }

  $parent = Split-Path -Parent $LocalPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $ExamplePath -Destination $LocalPath -Force
  Add-Result -Id $Id -Status 'created' -Message 'created local config from example' -Path $LocalPath
}

Ensure-FromExample `
  -Id 'hdc-relay-config' `
  -ExamplePath (Join-Path $repoRoot 'tools\harmony\hdc-relay.example.psd1') `
  -LocalPath (Join-Path $repoRoot 'tools\harmony\hdc-relay.local.psd1')

Ensure-FromExample `
  -Id 'virtual-hdc-config' `
  -ExamplePath (Join-Path $repoRoot 'tools\harmony\virtual-hdc.example.psd1') `
  -LocalPath (Join-Path $repoRoot 'tools\harmony\virtual-hdc.local.psd1')

Ensure-FromExample `
  -Id 'bridge-config' `
  -ExamplePath (Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.example.ets') `
  -LocalPath (Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets')

Ensure-FromExample `
  -Id 'voice-route-config' `
  -ExamplePath (Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\VoiceRouteConfig.example.ets') `
  -LocalPath (Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\VoiceRouteConfig.ets')

Ensure-FromExample `
  -Id 'helper-bridge-config' `
  -ExamplePath (Join-Path $repoRoot 'HarmonyHdcRelayHelper\entry\src\main\ets\config\BridgeConfig.example.ets') `
  -LocalPath (Join-Path $repoRoot 'HarmonyHdcRelayHelper\entry\src\main\ets\config\BridgeConfig.ets')

Ensure-FromExample `
  -Id 'helper-relay-config' `
  -ExamplePath (Join-Path $repoRoot 'HarmonyHdcRelayHelper\entry\src\main\ets\config\RelayConfig.example.ets') `
  -LocalPath (Join-Path $repoRoot 'HarmonyHdcRelayHelper\entry\src\main\ets\config\RelayConfig.ets')

$summary = [pscustomobject]@{
  ok = (@($results | Where-Object { $_.status -eq 'missing-example' }).Count -eq 0)
  repoRoot = $repoRoot
  results = @($results)
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 8
} else {
  Write-Host "Agent setup complete: $repoRoot" -ForegroundColor Cyan
  $results | Format-Table -AutoSize
}
