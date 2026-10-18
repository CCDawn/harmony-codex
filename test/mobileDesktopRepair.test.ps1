$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools/windows/mobile-link-control.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw $errors[0]}
foreach($name in @('Get-LinkValue','Invoke-DesktopRepair','Get-LinkStartupOutcome')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
$checks=0
function Assert($condition,$message){if(-not $condition){throw $message};$script:checks++}
$bridgeUrl='http://127.0.0.1:1'
$script:safeState='blocked';$script:exitCode=0;$script:finished=$true;$script:live=$true;$script:launches=0
function Invoke-DesktopSafeRecovery {[pscustomobject]@{state=$script:safeState}}
function Write-LinkEvent {param($Event)}
function Get-LinkApi {param($Path) [pscustomobject]@{desktop=[pscustomobject]@{desktopLive=$script:live}}}
function Start-MobileLinkDetached {
  param($HostPath,$ScriptPath,$Arguments,$LogPath,$WorkingDirectory)
  Assert ((Split-Path $ScriptPath -Leaf) -eq 'restart-codex-desktop-live.ps1') 'Must use existing restart launcher'
  Assert ('-StartOnly' -notin $Arguments -and '-RefusePlainCodex' -notin $Arguments) 'Authorized repair must permit restarting plain desktop'
  $script:launches++
  $p=[pscustomobject]@{ExitCode=$script:exitCode}
  $p|Add-Member ScriptMethod WaitForExit {param($ms) $script:finished}
  $p|Add-Member ScriptMethod Dispose {}
  $p
}
foreach($state in @('not-needed','recovered','pending')) {
  $script:safeState=$state
  Assert ((Invoke-DesktopRepair).state -eq $state) 'Do not restart ready or in-flight desktop'
}
Assert ($script:launches -eq 0) 'Soft recovery should avoid hard restart'
$script:safeState='blocked'
Assert ((Invoke-DesktopRepair).state -eq 'restarted') 'Blocked plain desktop must restart and read back'
$script:live=$false
Assert ((Invoke-DesktopRepair).state -eq 'failed') 'Exit zero without live interface must fail'
$script:live=$true;$script:exitCode=1
Assert ((Invoke-DesktopRepair).state -eq 'failed') 'Failed launcher must not claim recovery'
$script:exitCode=0;$script:finished=$false
Assert ((Invoke-DesktopRepair).state -eq 'pending') 'Slow restart must remain pending'
$script:desktopRecovery=[pscustomobject]@{state='restarted'}
$status=[pscustomobject]@{diagnostics=[pscustomobject]@{checks=@('bridge','desktop','sessions'|ForEach-Object{[pscustomobject]@{id=$_;state='ready'}})}}
Assert ((Get-LinkStartupOutcome $status).exitCode -eq 2) 'Assistant readback required after restart'
$status.diagnostics.checks += [pscustomobject]@{id='companion';state='ready'}
Assert ((Get-LinkStartupOutcome $status).exitCode -eq 0) 'Desktop and both conversation reads permit success'
[pscustomobject]@{passed=$checks;realDesktopRestarted=$false}|ConvertTo-Json -Compress
