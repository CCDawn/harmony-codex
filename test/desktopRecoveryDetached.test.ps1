$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot=Join-Path ([IO.Path]::GetTempPath()) ('desktop-recovery-detached-'+[guid]::NewGuid().ToString('N'))
$powerShellHostPath=(Get-Process -Id $PID).Path
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools\harmony\watch-desktop-live.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-DesktopRecoveryScript'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
$leaf=$null;$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  New-Item -ItemType Directory -Force -Path $repoRoot|Out-Null
  $launcher=Join-Path $repoRoot 'mock-launcher.ps1'
  @'
$hostPath=(Get-Process -Id $PID).Path
$leaf=Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
$leaf.Id|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'leaf.pid')
Write-Output 'launcher-finished'
'@|Set-Content -LiteralPath $launcher -Encoding utf8
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $code=Invoke-DesktopRecoveryScript -ScriptPath $launcher -Arguments @() -LogName 'mock-launch.log'
  $clock.Stop()
  $leaf=Get-Process -Id ([int](Get-Content -LiteralPath (Join-Path $repoRoot 'leaf.pid'))) -ErrorAction SilentlyContinue
  Assert ($code -eq 0) 'Detached launcher should finish successfully'
  Assert ($clock.Elapsed.TotalSeconds -lt 10 -and $null -ne $leaf) 'A live service child must not delay launcher completion'
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'logs\startup\mock-launch.log')) -match 'launcher-finished') 'Launcher output must reach its log'
  'exit 7'|Set-Content -LiteralPath $launcher
  $code=Invoke-DesktopRecoveryScript -ScriptPath $launcher -Arguments @() -LogName 'failed-launch.log'
  Assert ($code -eq 7) 'Launcher failure must propagate its exit code'
  [pscustomobject]@{passed=$checks;launcherSeconds=$clock.Elapsed.TotalSeconds;childDidNotBlock=$true}|ConvertTo-Json -Compress
} finally {
  if($null -ne $leaf){$current=Get-Process -Id $leaf.Id -ErrorAction SilentlyContinue;if($current -and $current.StartTime -eq $leaf.StartTime){Stop-Process -Id $leaf.Id -Force}}
  $target=[IO.Path]::GetFullPath($repoRoot)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if($target.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $target -Recurse -Force}
}
