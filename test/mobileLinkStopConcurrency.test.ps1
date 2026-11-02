$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-stop-test-'+[guid]::NewGuid().ToString('N'))
$children=@();$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Wait-Marker([string]$Name){
  $deadline=[datetime]::UtcNow.AddSeconds(10)
  while(-not(Test-Path (Join-Path $fixture $Name))){if([datetime]::UtcNow -gt $deadline){throw ('Barrier timeout: '+$Name)};Start-Sleep -Milliseconds 25}
}
function Start-Fixture([string[]]$Arguments){
  $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  foreach($arg in @('-NoProfile')+$Arguments){[void]$info.ArgumentList.Add($arg)}
  [Diagnostics.Process]::Start($info)
}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'tools\windows') | Out-Null
  foreach($name in @('mobile-link-lifecycle.ps1','mobile-link-operation.ps1')){Copy-Item (Join-Path $sourceRepo ('tools\windows\'+$name)) (Join-Path $fixture ('tools\windows\'+$name))}
  @'
function Stop-MobileLinkOwnedProcesses {
  param($Repo)
  [IO.File]::WriteAllText((Join-Path $Repo 'services-cleaned'),'yes')
  [pscustomobject]@{remaining=@()}
}
'@ | Add-Content (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  'function Stop-MobileVoiceTunnel {param($Repo)}' | Set-Content (Join-Path $fixture 'tools\windows\mobile-voice-tunnel.ps1')
  $path=Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'
  $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$null,[ref]$null)
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-LinkStatus'},$true)
  $controller=Get-Content -LiteralPath $path -Raw
  $controller=$controller.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,'function Get-LinkStatus { [pscustomobject]@{paused=(Test-MobileLinkPaused $repo)} }')
  [IO.File]::WriteAllText((Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),$controller,[Text.UTF8Encoding]::new($false))
  @'
param($Repo)
. (Join-Path $Repo 'tools\windows\mobile-link-lifecycle.ps1')
$gate=New-MobileLinkMutex $Repo
[void]$gate.WaitOne()
try {
  [IO.File]::WriteAllText((Join-Path $Repo 'holder-entered'),'yes')
  $deadline=[datetime]::UtcNow.AddSeconds(45)
  while(-not(Test-Path (Join-Path $Repo 'release-holder'))){if([datetime]::UtcNow -gt $deadline){throw 'Fixture holder timeout'};Start-Sleep -Milliseconds 25}
} finally {$gate.ReleaseMutex();$gate.Dispose()}
'@ | Set-Content (Join-Path $fixture 'holder.ps1')
  $holder=Start-Fixture @('-File',(Join-Path $fixture 'holder.ps1'),'-Repo',$fixture);$children+=$holder
  Wait-Marker 'holder-entered'
  $stop=Start-Fixture @('-File',(Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),'-Action','Stop');$children+=$stop
  Wait-Marker 'logs\state\mobile-link-control.json'
  . (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  Assert (Test-MobileLinkPaused $fixture) 'Stop intent must be published before waiting for the in-flight operation'
  # Exceed the old 15-second mutation wait without touching any real service.
  Start-Sleep -Seconds 16
  Assert (-not $stop.HasExited) 'Stop must not abandon cleanup while the cancelled launcher still owns the lifecycle gate'
  [IO.File]::WriteAllText((Join-Path $fixture 'release-holder'),'go')
  Assert ($stop.WaitForExit(12000)) 'Stop must finish after the in-flight operation releases its gate'
  Assert ($stop.ExitCode -eq 0) ('Stop failed: '+$stop.StandardError.ReadToEnd()+$stop.StandardOutput.ReadToEnd())
  Assert (Test-Path (Join-Path $fixture 'services-cleaned')) 'Stop must clean up after acquiring the lifecycle gate'
  Assert (Test-MobileLinkPaused $fixture) 'Cleanup must retain the persisted stopped state'
  Assert ($holder.WaitForExit(3000) -and $holder.ExitCode -eq 0) 'Isolated lock holder must exit cleanly'
  @{passed=$checks;stopSurvivesOldTimeout=$true;realServicesTouched=$false}|ConvertTo-Json -Compress
} finally {
  foreach($child in $children){if(-not $child.HasExited){$child.Kill()};$child.Dispose()}
  $full=[IO.Path]::GetFullPath($fixture)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'mobile-link-stop-test-*'){Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue}
}
