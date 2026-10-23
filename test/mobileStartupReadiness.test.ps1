$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
function Import-Function([string]$Path,[string]$Name) {
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw $errors[0]}
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name},$true)
  if(-not $fn){throw "Missing function $Name"}
  & ([scriptblock]::Create($fn.Extent.Text.Replace("function $Name", "function script:$Name")))
}
$controller=Join-Path $repo 'tools/windows/mobile-link-control.ps1'
foreach($name in @('Get-LinkValue','Invoke-DesktopSafeRecovery','Start-MissingDesktop','Get-LinkStartupOutcome')) { Import-Function $controller $name }
$script:desktopRecovery=$null
$status=[pscustomobject]@{diagnostics=[pscustomobject]@{checks=@(
  [pscustomobject]@{id='bridge';state='ready'},
  [pscustomobject]@{id='desktop';state='ready'},
  [pscustomobject]@{id='sessions';state='ready'},
  [pscustomobject]@{id='companion';state='ready'}
)}}
Assert ((Get-LinkStartupOutcome $status).exitCode -eq 0) 'Ready requires desktop and sessions as well as bridge'
$status.diagnostics.checks[3].state='error'
Assert ((Get-LinkStartupOutcome $status).state -eq 'partial') 'Every startup must reject unreadable personal assistant content'
Assert ((Get-LinkStartupOutcome $status -RequireAssistant $true).state -eq 'partial') 'Normal and restart startup must use the same assistant acceptance'
$status.diagnostics.checks[3].state='ready'
$status.diagnostics.checks += [pscustomobject]@{id='voice';state='error'}
Assert ((Get-LinkStartupOutcome $status).state -eq 'partial') 'Known voice failure must be reported alongside ready conversations'
$status.diagnostics.checks=$status.diagnostics.checks[0..3]
$status.diagnostics.checks[2].state='error'
Assert ((Get-LinkStartupOutcome $status).exitCode -eq 2) 'Session HTTP failure must fail startup despite healthy bridge and desktop'
$status.diagnostics.checks[1].state='blocked'
Assert ((Get-LinkStartupOutcome $status).state -eq 'blocked') 'Blocked desktop needs an actionable outcome'
$script:desktopRecovery=[pscustomobject]@{state='pending';message='waiting'}
Assert ((Get-LinkStartupOutcome $status).state -eq 'pending') 'In-flight launch must be distinguished from failure'
$status.diagnostics.checks=@()
$script:desktopRecovery=$null
Assert ((Get-LinkStartupOutcome $status).exitCode -eq 2) 'Missing diagnostic checks must fail closed'

$bridgeUrl='http://127.0.0.1:1'
$script:desktop=[pscustomobject]@{desktopLive=$true;desktopProcessMode='remote_debug';cdpPort=12345}
$script:launchCount=0;$script:softCount=0;$script:launchCode=0;$script:waitResult=$true
function Get-LinkApi { param($Path) [pscustomobject]@{desktop=$script:desktop} }
function Get-LinkHeaders { @{} }
function Invoke-RestMethod { param($Uri,$Method,$ContentType,$Body,$Headers,$TimeoutSec)
  Assert (($Body | ConvertFrom-Json).mode -eq 'soft') 'Recovery must never request a hard restart'
  $script:softCount++
  [pscustomobject]@{desktop=[pscustomobject]@{desktopLive=$true}}
}
function Start-MobileLinkDetached {
  param($HostPath,$ScriptPath,$Arguments,$LogPath,$WorkingDirectory)
  Assert ('-StartOnly' -in $Arguments -and '-RefusePlainCodex' -in $Arguments) 'Missing-desktop launch must protect any newly started desktop'
  $script:launchCount++
  $process=[pscustomobject]@{ExitCode=$script:launchCode}
  $process | Add-Member ScriptMethod WaitForExit {param($ms) $script:waitResult}
  $process | Add-Member ScriptMethod Dispose {}
  $process
}
Assert ((Invoke-DesktopSafeRecovery).state -eq 'not-needed') 'Already connected desktop must not be relaunched'
Assert ($launchCount -eq 0 -and $softCount -eq 0) 'Ready state must be read-only'
$script:desktop.desktopLive=$false;$script:desktop.desktopProcessMode='plain'
Assert ((Invoke-DesktopSafeRecovery).state -eq 'blocked') 'Plain desktop must be retained'
Assert ($launchCount -eq 0 -and $softCount -eq 0) 'Plain desktop must not trigger restart or recovery POST'
$script:desktop.desktopProcessMode='remote_debug'
Assert ((Invoke-DesktopSafeRecovery).state -eq 'recovered') 'Remote debug desktop should recover softly'
$script:desktop.desktopProcessMode='missing';$script:waitResult=$false
Assert ((Invoke-DesktopSafeRecovery).state -eq 'pending') 'Slow launcher must not report ready'
$script:waitResult=$true;$script:launchCode=11
Assert ((Invoke-DesktopSafeRecovery).state -eq 'blocked') 'A desktop started concurrently must be protected'
$script:launchCode=1
Assert ((Invoke-DesktopSafeRecovery).state -eq 'failed') 'Failed desktop launcher must not report ready'
$script:launchCode=0
Assert ((Invoke-DesktopSafeRecovery).state -eq 'failed') 'Launcher exit zero without desktop connection is not readiness'
$script:desktop.desktopLive=$true
Assert ((Start-MissingDesktop).state -eq 'recovered') 'Successful launcher requires a connected desktop readback'

$stack=Join-Path $repo 'scripts/start-codex-mobile-stack.ps1'
Import-Function $stack 'Write-FinalStartupSummary'
$RuntimeMode='desktop'
$script:badSession=$true
function Get-StartupStatus { param($Name) [pscustomobject]@{State=$(if($Name -eq 'SessionApi' -and $script:badSession){'degraded'}else{'ok'})} }
function Write-Step {}
function Write-StartupStatusLine {}
Write-FinalStartupSummary 6>$null
Assert ($script:StartupExitCode -eq 2) 'Stack must return incomplete when session API fails'
$script:badSession=$false
Write-FinalStartupSummary 6>$null
Assert ($script:StartupExitCode -eq 0) 'Stack should return success after required dependencies pass'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('startup-wrapper-'+[guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts/agent') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'scripts/agent/start-stack.ps1') -Destination (Join-Path $fixture 'scripts/agent/start-stack.ps1')
  'param($BridgePort,$BridgeToken,$BridgeTotpSecret,$BridgePublicUrl,$BridgeUrl,$RuntimeMode,$CanaryThreadIds); exit 2' |
    Set-Content -LiteralPath (Join-Path $fixture 'scripts/start-codex-mobile-stack.ps1')
  & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $fixture 'scripts/agent/start-stack.ps1')
  Assert ($LASTEXITCODE -eq 2) 'Public startup wrapper must preserve incomplete exit code'
} finally {
  $resolved=[IO.Path]::GetFullPath($fixture)
  if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolved -Leaf) -like 'startup-wrapper-*') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Import-Function $controller 'Get-LinkStatus'
$BridgePort=8787
function Get-CimInstance { @() }
function Get-MobileLinkOwnedProcesses { param($Repo,$Processes) @() }
function Get-LinkApi { param($Path) [pscustomobject]@{ok=$true;runtime=[pscustomobject]@{mode='desktop'};desktop=[pscustomobject]@{desktopLive=$true}} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction)
  if ($LocalPort -eq 9229) { [pscustomobject]@{OwningProcess=999999} }
  if ($LocalPort -eq 8787) { [pscustomobject]@{OwningProcess=12345} }
}
function Get-Process { param($Id,$ErrorAction) if ($Id -eq 12345) { [pscustomobject]@{Id=$Id} } }
function Test-MobileLinkPaused { param($Repo) $false }
function Get-MobileVoiceTunnelStatus { param($Repo) [pscustomobject]@{state='unverified'} }
function Get-LinkDiagnostics { param($Paused,$VoiceTunnel)
  [pscustomobject]@{checks=@([pscustomobject]@{id='desktop';state='blocked'})}
}
function Get-LinkHdcStatus { [pscustomobject]@{id='phone_debug';state='waiting'} }
function New-Item { param($ItemType,[switch]$Force,$Path) }
function Set-Content { param($LiteralPath,$Encoding,[Parameter(ValueFromPipeline=$true)]$Value) process {} }
$snapshot=Get-LinkStatus
Assert (-not $snapshot.desktopLive) 'Summary must use the same desktop probe as detailed diagnostics'
Assert ($snapshot.ports.Count -eq 1 -and $snapshot.ports[0].pid -eq 12345) 'Stale listeners without a live owner must not be reported'
[pscustomobject]@{passed=$checks;desktopProtected=$true;readinessRequired=$true}|ConvertTo-Json -Compress
