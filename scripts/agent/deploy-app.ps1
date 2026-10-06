[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$SkipInstall,
  [switch]$SkipLaunch,
  [switch]$StartBridge,
  [switch]$UseLanBridge,
  [switch]$RelayHostedByHelper,
  [string]$BridgeUrl = $env:CODEX_BRIDGE_URL,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeTotpSecret = $env:CODEX_BRIDGE_TOTP_SECRET,
  [string[]]$DeviceId = @(),
  [string]$ConfigPath = '',
  [string]$ProjectPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script = Join-Path $repoRoot 'tools\harmony\deploy.ps1'
$bridgeConfig = Join-Path $repoRoot 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'

if (-not (Test-Path -LiteralPath $script)) {
  throw "Missing deploy script: $script"
}

if ([string]::IsNullOrWhiteSpace($BridgeToken) -and (Test-Path -LiteralPath $bridgeConfig)) {
  $text = Get-Content -Raw -LiteralPath $bridgeConfig
  $match = [regex]::Match($text, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
  if ($match.Success) {
    $BridgeToken = $match.Groups[1].Value
  }
}

if ([string]::IsNullOrWhiteSpace($BridgeTotpSecret) -and (Test-Path -LiteralPath $bridgeConfig)) {
  $text = Get-Content -Raw -LiteralPath $bridgeConfig
  $match = [regex]::Match($text, "DEFAULT_BRIDGE_TOTP_SECRET:\s*string\s*=\s*'([^']*)'")
  if ($match.Success) {
    $BridgeTotpSecret = $match.Groups[1].Value
  }
}

if ([string]::IsNullOrWhiteSpace($BridgeUrl) -and (Test-Path -LiteralPath $bridgeConfig)) {
  $text = Get-Content -Raw -LiteralPath $bridgeConfig
  $match = [regex]::Match($text, "DEFAULT_BRIDGE_URL:\s*string\s*=\s*'([^']*)'")
  if ($match.Success) {
    $BridgeUrl = $match.Groups[1].Value
  }
}

$args = @{}
if ($Build) {
  $args.Build = $true
}
if ($SkipInstall) {
  $args.SkipInstall = $true
}
if ($SkipLaunch) {
  $args.SkipLaunch = $true
}
if ($StartBridge) {
  $args.StartBridge = $true
}
if ($UseLanBridge) {
  $args.UseLanBridge = $true
}
if ($RelayHostedByHelper) {
  $args.RelayHostedByHelper = $true
}
if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $args.BridgeUrl = $BridgeUrl
}
if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
  $args.BridgeToken = $BridgeToken
}
if (-not [string]::IsNullOrWhiteSpace($BridgeTotpSecret)) {
  $args.BridgeTotpSecret = $BridgeTotpSecret
}
if ($DeviceId.Count -gt 0) {
  $args.DeviceId = $DeviceId
}
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
  $args.ConfigPath = $ConfigPath
}
if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
  $args.ProjectPath = $ProjectPath
}

& $script @args
