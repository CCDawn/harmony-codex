$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Import-Function([string]$Path,[string]$Name){
  $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$null,[ref]$null)
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name},$true)
  if(-not $fn){throw ('Missing function '+$Name)}
  & ([scriptblock]::Create($fn.Extent.Text.Replace("function $Name", "function script:$Name")))
}
Import-Function (Join-Path $sourceRepo 'tools/windows/mobile-link-control.ps1') 'Start-Link'
$GuardianRepair=$true;$RestartDesktop=$true;$GuardianComponents='desktop'
$script:allowed=$true;$script:repairs=0;$script:phases=@();$script:environments=0;$script:revokeInEnvironment=$false
function Test-GuardianRepairAllowed{$script:allowed}
function Set-LinkEnvironment{$script:environments++;if($script:revokeInEnvironment){$script:allowed=$false}}
function Set-LinkOperationPhase([string]$Phase){$script:phases+=$Phase}
function Invoke-DesktopRepair{$script:repairs++;[pscustomobject]@{state='restarted'}}
function Get-NetTCPConnection{throw 'Scoped desktop recovery must not enter whole-stack ownership or bootstrap'}
function Start-MobileLinkDetached{throw 'Scoped desktop recovery must not bootstrap any service'}
function Ensure-LinkMonitors{throw 'Scoped desktop recovery must not mutate unrelated monitors'}
Start-Link
Assert ($script:repairs -eq 1) 'Third guardian round must execute desktop recovery'
Assert ($script:desktopRecovery.state -eq 'restarted') 'Desktop recovery result must remain available for readback'
Assert ($script:phases -contains 'connecting_desktop') 'Scoped recovery must retain visible operation progress'
Assert ($script:environments -eq 1) 'Desktop recovery must load its local authentication environment'
$script:allowed=$false
Start-Link
Assert ($script:repairs -eq 1) 'Disabling guardian must cancel scoped desktop recovery'
$script:allowed=$true;$script:revokeInEnvironment=$true
Start-Link
Assert ($script:repairs -eq 1) 'Revocation while preparing the environment must cancel before desktop recovery'
$script:revokeInEnvironment=$false
$script:allowed=$true;$GuardianComponents='public'
$threw=$false;try{Start-Link}catch{$threw=$true}
Assert ($threw -and $script:repairs -eq 1) 'A public-only request must never authorize a desktop restart'

Import-Function (Join-Path $sourceRepo 'tools/windows/mobile-link-repair-task.ps1') 'Start-MobileLinkRepairTask'
function Enter-MobileLinkOperationGate{param($Repo) $m=[Threading.Mutex]::new($false);[void]$m.WaitOne();$m}
function Get-MobileLinkOperationKey{param($Repo) 'mock-checkout'}
function New-MobileLinkOperation{param($Repo,$Action) [pscustomobject]@{joined=$false;operation=[pscustomobject]@{operationId=('a'*32)}}}
function Get-ScheduledTask{param($TaskName,$ErrorAction) $null}
function New-ScheduledTaskAction{param($Execute,$Argument,$WorkingDirectory) $script:taskArguments=$Argument;@{}}
function New-ScheduledTaskPrincipal{param($UserId,$LogonType,$RunLevel) @{}}
function New-ScheduledTaskSettingsSet{param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) @{}}
function Register-ScheduledTask{param($TaskName,$Action,$Principal,$Settings,[switch]$Force)}
function Start-ScheduledTask{param($TaskName)}
$receipt=Start-MobileLinkRepairTask -Repo $sourceRepo -GuardianRepair -GuardianComponents 'desktop,public,desktop'
Assert ($script:taskArguments -match ' -GuardianRepair -GuardianComponents desktop$') 'The independent worker must receive only the selected desktop component'
Assert (-not $receipt.joined -and $receipt.action -eq 'Repair') 'The independent worker must retain the existing operation contract'
$receipt=Start-MobileLinkRepairTask -Repo $sourceRepo
Assert ($script:taskArguments -notmatch 'GuardianRepair|GuardianComponents') 'Manual repair must retain its existing task arguments'
@{passed=$checks;realServicesTouched=$false;wholeStackBootstrapSkipped=$true}|ConvertTo-Json -Compress
