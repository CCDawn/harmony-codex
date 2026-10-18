$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repo=Join-Path ([IO.Path]::GetTempPath()) ('guardian-launcher-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Parse-Script([string]$Path) {
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw $errors[0] }
  $ast
}
$controller=Parse-Script (Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1')
foreach ($name in @('Get-LinkValue','Get-DesktopLauncherArguments','Invoke-DesktopRepair','Start-MissingDesktop','Test-GuardianRepairAllowed')) {
  $fn=$controller.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($fn.Extent.Text))
}
. (Join-Path $sourceRepo 'tools\windows\mobile-link-lifecycle.ps1')
$bridgeUrl='http://127.0.0.1:1'
$GuardianRepair=$true;$RestartDesktop=$true
function Write-LinkEvent { param($Event) }
function Invoke-DesktopSafeRecovery { [pscustomobject]@{state='blocked'} }
function Get-LinkApi { param($Path) [pscustomobject]@{desktop=[pscustomobject]@{desktopLive=$true}} }
function Start-MobileLinkDetached {
  param($HostPath,$ScriptPath,[string[]]$Arguments,$LogPath,$WorkingDirectory)
  Assert ((Split-Path $ScriptPath -Leaf) -eq 'restart-codex-desktop-live.ps1') 'Controller must use the real launcher entrypoint'
  Assert (('-GuardianRepair' -in $Arguments) -eq [bool]$GuardianRepair) 'Guardian context must cross the detached launcher boundary only for guardian requests'
  if ($script:packaged) { $Arguments+='-UsePackagedActivation' }
  $script:launcherArguments=$Arguments
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$HostPath
  $quoted=@($Arguments | ForEach-Object { '"'+$_.Replace('"','\"')+'"' })
  $info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $repo 'scripts\restart-codex-desktop-live.ps1')+'" '+($quoted -join ' ')
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $p=[Diagnostics.Process]::Start($info)
  if (-not $p.WaitForExit(15000)) { $p.Kill(); throw 'Isolated launcher timed out' }
  $output=$p.StandardOutput.ReadToEnd();$errorOutput=$p.StandardError.ReadToEnd()
  $script:launcherExit=$p.ExitCode
  if ($p.ExitCode -notin @(0,12)) { throw ('Isolated launcher failed: '+$errorOutput+$output) }
  $p
}
try {
  foreach ($dir in @('scripts','tools\windows','logs\state','fake-app')) { New-Item -ItemType Directory -Force (Join-Path $repo $dir) | Out-Null }
  Copy-Item -LiteralPath (Join-Path $sourceRepo 'tools\windows\mobile-link-lifecycle.ps1') -Destination (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
  New-Item -ItemType File (Join-Path $repo 'fake-app\ChatGPT.exe') | Out-Null
  $launcherPath=Join-Path $sourceRepo 'scripts\restart-codex-desktop-live.ps1'
  $launcherAst=Parse-Script $launcherPath
  $launcher=Get-Content -Raw -LiteralPath $launcherPath
  # Run the original launcher body and cancellation guard. Every machine-facing
  # callback is replaced in this temporary checkout before the child is started.
  $mocks=@{
    'Resolve-CompatiblePowerShellHost'='function Resolve-CompatiblePowerShellHost { (Get-Process -Id $PID).Path }'
    'Resolve-CodexAppDir'=@'
function Resolve-CodexAppDir {
  param($ExplicitPath)
  $scenario=Get-Content -Raw (Join-Path $repoRoot 'scenario.txt')
  if ($scenario -in @('stop','stop-start')) {
    Set-MobileLinkDesiredState -Repo $repoRoot -State stopped
    if ($scenario -eq 'stop-start') { Set-MobileLinkDesiredState -Repo $repoRoot -State running }
  }
  if ($scenario -in @('disable','disable-enable','version')) {
    $path=Join-Path $repoRoot 'logs\state\mobile-link-guardian-config.json'
    @{version=1;enabled=($scenario -eq 'version');allowForceRestart=$true;updatedAt='new-version'} | ConvertTo-Json | Set-Content $path -Encoding utf8
    if ($scenario -eq 'disable-enable') { @{version=1;enabled=$true;allowForceRestart=$true;updatedAt='re-enabled'} | ConvertTo-Json | Set-Content $path -Encoding utf8 }
  }
  Join-Path $repoRoot 'fake-app'
}
'@
    'Get-AppUserModelIdFromAppDir'="function Get-AppUserModelIdFromAppDir { param(`$AppDir) 'fake-aumid' }"
    'Get-CodexDesktopProcesses'='function Get-CodexDesktopProcesses { @() }'
    'Stop-DesktopLiveHost'=@'
function Stop-DesktopLiveHost {
  Add-Content (Join-Path $repoRoot 'callbacks.txt') 'stop-host'
  if ((Get-Content -Raw (Join-Path $repoRoot 'scenario.txt')) -eq 'stop-between-stops') { Set-MobileLinkDesiredState -Repo $repoRoot -State stopped }
}
'@
    'Stop-CodexDesktopShell'="function Stop-CodexDesktopShell { Add-Content (Join-Path `$repoRoot 'callbacks.txt') 'stop-desktop' }"
    'Select-LoopbackPort'=@'
function Select-LoopbackPort {
  param($Requested)
  if ((Get-Content -Raw (Join-Path $repoRoot 'scenario.txt')) -like 'stop-before-start*') { Set-MobileLinkDesiredState -Repo $repoRoot -State stopped }
  $Requested
}
'@
    'Save-DesktopLiveStatus'='function Save-DesktopLiveStatus { param($Status) }'
    'Start-PackagedCodex'="function Start-PackagedCodex { param(`$AppUserModelId,`$Arguments) Add-Content (Join-Path `$repoRoot 'callbacks.txt') 'start-packaged'; 123 }"
    'Wait-Cdp'=@'
function Wait-Cdp {
  param($Port)
  if ((Get-Content -Raw (Join-Path $repoRoot 'scenario.txt')) -eq 'disable-before-host') { @{enabled=$false;allowForceRestart=$true;updatedAt='disabled'} | ConvertTo-Json | Set-Content (Join-Path $repoRoot 'logs\state\mobile-link-guardian-config.json') -Encoding utf8 }
  [pscustomobject]@{type='page'}
}
'@
    'Wait-DesktopScriptOnline'='function Wait-DesktopScriptOnline { param($Url,$Token) @{ok=$true} }'
  }
  foreach ($fn in @($launcherAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $mocks.ContainsKey($n.Name)},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)) {
    $launcher=$launcher.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,$mocks[$fn.Name])
  }
  $launcher=$launcher.Replace('Local\CodexHarmonyDesktopRelaunch',('Local\'+(Split-Path $repo -Leaf)))
  $mockStart=@'
function Start-Process {
  param($WindowStyle,$FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError)
  $event=if ($FilePath -like '*ChatGPT.exe') { 'start-desktop' } else { 'start-host' }
  Add-Content (Join-Path $repoRoot 'callbacks.txt') $event
}
'@
  $launcher=$launcher.Replace('$relaunchMutex = New-Object',($mockStart+"`n"+'$relaunchMutex = New-Object'))
  $fixturePath=Join-Path $repo 'scripts\restart-codex-desktop-live.ps1'
  [IO.File]::WriteAllText($fixturePath,$launcher,[Text.UTF8Encoding]::new($true))
  $null=Parse-Script $fixturePath
  foreach ($scenario in @('stop','disable','version','stop-start','disable-enable','stop-between-stops','stop-before-start','stop-before-start-packaged','disable-before-host','unchanged','unchanged-packaged','manual')) {
    $GuardianRepair=$scenario -ne 'manual'
    $script:packaged=$scenario -like '*-packaged'
    $scenario | Set-Content -NoNewline (Join-Path $repo 'scenario.txt')
    Set-MobileLinkDesiredState -Repo $repo -State running
    @{version=1;enabled=$GuardianRepair;allowForceRestart=$GuardianRepair;updatedAt='original'} | ConvertTo-Json | Set-Content (Join-Path $repo 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
    if (-not $GuardianRepair) { Set-MobileLinkDesiredState -Repo $repo -State stopped }
    $callbacksPath=Join-Path $repo 'callbacks.txt'
    if (Test-Path $callbacksPath) { Remove-Item -LiteralPath $callbacksPath }
    $result=Invoke-DesktopRepair
    $callbacks=@(if(Test-Path $callbacksPath){Get-Content $callbacksPath})
    if ($scenario -in @('stop','disable','version','stop-start','disable-enable')) {
      Assert ($script:launcherExit -eq 12 -and $result.state -eq 'cancelled') ('Launcher must report cancellation after '+$scenario)
      Assert ($callbacks.Count -eq 0) ('No destructive callbacks permitted after cancellation during discovery: '+$scenario)
    } elseif ($scenario -eq 'stop-between-stops') {
      Assert ($result.state -eq 'cancelled') 'Stop between the two shutdown boundaries must cancel the desktop shutdown'
      Assert (($callbacks -join ',') -eq 'stop-host') 'Stop after host shutdown must prevent desktop shutdown and both starts'
    } elseif ($scenario -like 'stop-before-start*') {
      Assert ($result.state -eq 'cancelled') 'Stop after shutdown must cancel the pending desktop start'
      Assert (@($callbacks | Where-Object { $_ -like 'start-*' }).Count -eq 0) 'Stop at port discovery must prevent both starts'
    } elseif ($scenario -eq 'disable-before-host') {
      Assert ($result.state -eq 'cancelled') 'Disable while waiting for CDP must cancel live-host replacement'
      Assert (($callbacks -join ',') -eq 'stop-host,stop-desktop,start-desktop') 'CDP cancellation must prevent the later host stop and start'
    } else {
      Assert ($script:launcherExit -eq 0 -and $result.state -eq 'restarted') ('Authorized repair must finish: '+$scenario)
      $expectedStart=if($script:packaged){'start-packaged'}else{'start-desktop'}
      Assert (($callbacks -join ',') -eq ('stop-host,stop-desktop,'+$expectedStart+',stop-host,start-host')) ('Authorized repair callbacks must be preserved: '+$scenario)
    }
  }
  $GuardianRepair=$true;$RestartDesktop=$false
  $script:packaged=$false
  Set-MobileLinkDesiredState -Repo $repo -State running
  @{version=1;enabled=$true;allowForceRestart=$false;updatedAt='start-only'} | ConvertTo-Json | Set-Content (Join-Path $repo 'logs\state\mobile-link-guardian-config.json') -Encoding utf8
  'disable' | Set-Content -NoNewline (Join-Path $repo 'scenario.txt')
  Remove-Item -LiteralPath (Join-Path $repo 'callbacks.txt')
  Assert ((Start-MissingDesktop).state -eq 'cancelled') 'Missing desktop launch must also carry guardian cancellation'
  Assert (-not (Test-Path (Join-Path $repo 'callbacks.txt'))) 'Cancelled StartOnly must invoke no destructive callback'
  [pscustomobject]@{passed=$checks;realDesktopRestarted=$false;realServicesTouched=$false} | ConvertTo-Json -Compress
} finally {
  $resolved=[IO.Path]::GetFullPath($repo)
  if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'guardian-launcher-test-*') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
