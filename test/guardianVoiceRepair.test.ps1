$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repo=Join-Path ([IO.Path]::GetTempPath()) ('guardian-voice-repair-'+[guid]::NewGuid().ToString('N'))
$checks=0
$BridgePort=1
$GuardianStage='restart_services'
$GuardianComponents='voice'
$allowed=$true
$mediaStops=0;$tunnelStops=0;$tunnelStarts=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Test-GuardianRepairAllowed { $script:allowed }
function Stop-MobileLinkOwnedProcesses {param($Repo,$Roles) if(@($Roles).Count -ne 1 -or $Roles[0] -ne 'voice'){throw 'Unexpected process scope'};$script:mediaStops++}
function Stop-MobileVoiceTunnel {param($Repo) $script:tunnelStops++}
function Ensure-MobileVoiceTunnel {param($Repo) $script:tunnelStarts++}
function Get-MobileVoiceTunnelStatus {param($Repo) [pscustomobject]@{state='Ready'} }
function Write-LinkEvent {param($Message)}
try {
  New-Item -ItemType Directory -Force (Join-Path $repo 'tools\windows') | Out-Null
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'Controller did not parse'}
  foreach($name in @('Get-LinkValue','Get-GuardianVoiceRepairComponents','Invoke-GuardianScopedRepair')){
    $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if($fn){Invoke-Expression $fn.Extent.Text}
  }
  # Real execution-time parser, but a fixture CLI instead of live endpoints.
  $fixture=Join-Path $repo 'tools\windows\mobile-link-diagnostics.mjs'
  function Set-Probe($Faults){
    $payload=@{guardianSignals=@{faults=@($Faults)}} | ConvertTo-Json -Depth 8 -Compress
    [IO.File]::WriteAllText($fixture,('process.stdout.write('+($payload | ConvertTo-Json -Compress)+');'),[Text.UTF8Encoding]::new($false))
  }
  Set-Probe @()
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 0 -and $tunnelStops -eq 0) 'A stale voice recovery must not terminate a now-healthy call'

  Set-Probe @(@{id='voice_tunnel';component='voice_tunnel';kind='transport';repairable=$true})
  $GuardianComponents='voice_tunnel'
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 0 -and $tunnelStops -eq 1 -and $tunnelStarts -eq 1) 'Tunnel recovery must never terminate the local media process'

  $GuardianComponents='voice'
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 0) 'Old queued generic voice actions must not kill media for a tunnel-only fault'

  Set-Probe @(@{id='voice_transport';component='voice';kind='local_service';repairable=$true})
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 1 -and $tunnelStops -eq 1) 'Confirmed media failure must restart only media, preserving SSH'

  foreach($kind in @('auth','unknown','api_compatibility','upstream')){
    Set-Probe @(@{id='voice_transport';component='voice';kind=$kind;repairable=$false})
    Invoke-GuardianScopedRepair
    Assert ($mediaStops -eq 1 -and $tunnelStops -eq 1) 'Unconfirmed failures must never authorize a stop'
  }
  [IO.File]::WriteAllText($fixture,'process.stdout.write("invalid");')
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 1 -and $tunnelStops -eq 1) 'Malformed fresh diagnostics must fail closed'

  Set-Probe @(@{id='voice_transport';component='voice';kind='local_service';repairable=$true})
  $allowed=$false
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 1) 'Disable must take precedence over fresh fault evidence'
  $allowed=$true
  # Simulate Disable arriving while the read-only recheck is in flight.
  function Get-GuardianVoiceRepairComponents {param($Requested) $script:allowed=$false; @('voice')}
  Invoke-GuardianScopedRepair
  Assert ($mediaStops -eq 1) 'Disable after recheck must cancel termination'
  @{passed=$checks;healthyCallPreserved=$true;tunnelScopeIsolated=$true} | ConvertTo-Json -Compress
} finally {
  $full=[IO.Path]::GetFullPath($repo)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'guardian-voice-repair-*'){
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
