$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repo=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-guardian-race-test-'+[guid]::NewGuid().ToString('N'))
. (Join-Path $sourceRepo 'tools\windows\mobile-link-lifecycle.ps1')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Test-GuardianRepairAllowed','Start-Link')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
$checks=0;$script:launches=0;$script:environmentWrites=0;$script:stopAt='probe'
$GuardianRepair=$true;$RestartDesktop=$true;$Action='Repair';$BridgePort=12345
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Write-LinkEvent {param($Event)}
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction) [pscustomobject]@{OwningProcess=424242}}
function Get-CimInstance {param($ClassName) @()}
function Get-MobileLinkOwnedProcesses {param($Repo,$Processes) [pscustomobject]@{ProcessId=424242}}
function Get-LinkApi {
  param($Path)
  if($script:stopAt -eq 'probe'){Set-MobileLinkDesiredState -Repo $repo -State stopped}
  [pscustomobject]@{ok=$true;runtime=[pscustomobject]@{mode='desktop'}}
}
function Set-LinkEnvironment {
  $script:environmentWrites++
  if($script:stopAt -eq 'environment'){Set-MobileLinkDesiredState -Repo $repo -State stopped}
}
function Start-MobileLinkDetached { $script:launches++;throw 'Recovery must not launch after manual stop' }
try {
  New-Item -ItemType Directory -Force (Join-Path $repo 'logs\state')|Out-Null
  @{version=1;enabled=$true;allowForceRestart=$true}|ConvertTo-Json|Set-Content (Join-Path $repo 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  foreach($boundary in @('probe','environment')){
    Set-MobileLinkDesiredState -Repo $repo -State running
    $script:stopAt=$boundary
    Start-Link
    Assert (Test-MobileLinkPaused $repo) ('Guardian overwrote Stop during '+$boundary)
    Assert ($script:launches -eq 0) ('Guardian launched recovery after Stop during '+$boundary)
  }
  Assert ($script:environmentWrites -eq 1) 'Ownership-probe cancellation must stop before environment preparation'
  Write-Output ('PASS: '+$checks+' guardian Start-Link manual-stop race checks')
}finally{
  $resolved=[IO.Path]::GetFullPath($repo)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'mobile-link-guardian-race-test-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
