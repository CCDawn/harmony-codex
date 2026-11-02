$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-maintain-test-'+[guid]::NewGuid().ToString('N'))
$checks=0;$children=@()
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
function Wait-Marker([string]$Name){
  $deadline=[datetime]::UtcNow.AddSeconds(20)
  while(-not(Test-Path (Join-Path $fixture $Name))){if([datetime]::UtcNow -gt $deadline){throw ('Barrier timeout: '+$Name)};Start-Sleep -Milliseconds 20}
}
function Start-Controller([string]$Action){
  $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  foreach($arg in @('-NoProfile','-File',(Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),'-Action',$Action)){[void]$info.ArgumentList.Add($arg)}
  [Diagnostics.Process]::Start($info)
}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'tools\windows') | Out-Null
  foreach($file in @('mobile-link-lifecycle.ps1','mobile-link-operation.ps1')){
    Copy-Item (Join-Path $sourceRepo ('tools\windows\'+$file)) (Join-Path $fixture ('tools\windows\'+$file))
  }
  '' | Set-Content (Join-Path $fixture 'tools\windows\mobile-voice-tunnel.ps1')
  . (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  $path=Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
  Assert ($errors.Count -eq 0) 'Controller must parse'
  $controller=Get-Content $path -Raw
  $mocks=@{
    'Ensure-LinkMonitors'=@'
function Ensure-LinkMonitors {
  [IO.File]::WriteAllText((Join-Path $repo 'monitors-entered'),'yes')
  $deadline=[datetime]::UtcNow.AddSeconds(30)
  while(-not(Test-Path (Join-Path $repo 'allow-monitors'))){if([datetime]::UtcNow -gt $deadline){throw 'Monitor fixture timeout'};Start-Sleep -Milliseconds 20}
  [IO.File]::WriteAllText((Join-Path $repo 'monitors-completed'),'yes')
}
'@
    'Start-Link'=@'
function Start-Link {
  [IO.File]::WriteAllText((Join-Path $repo 'foreground-acquired'),'yes')
}
'@
    'Get-LinkStatus'=@'
function Get-LinkStatus {
  if($Action -eq 'Maintain'){
    if(-not(Test-Path (Join-Path $repo 'monitors-completed'))){throw 'Status cannot precede monitor maintenance'}
    [IO.File]::WriteAllText((Join-Path $repo 'diagnostics-entered'),'yes')
    $deadline=[datetime]::UtcNow.AddSeconds(30)
    while(-not(Test-Path (Join-Path $repo 'allow-diagnostics'))){if([datetime]::UtcNow -gt $deadline){throw 'Diagnostic fixture timeout'};Start-Sleep -Milliseconds 20}
  }
  [pscustomobject]@{desktopLive=$true;diagnostics=[pscustomobject]@{checks=@(
    [pscustomobject]@{id='bridge';state='ready'},[pscustomobject]@{id='desktop';state='ready'},
    [pscustomobject]@{id='sessions';state='ready'},[pscustomobject]@{id='companion';state='ready'})}}
}
'@
  }
  foreach($fn in @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $mocks.ContainsKey($node.Name)},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)){
    $controller=$controller.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,$mocks[$fn.Name])
  }
  [IO.File]::WriteAllText((Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),$controller,[Text.UTF8Encoding]::new($false))
  $maintain=Start-Controller Maintain;$children+= $maintain
  Wait-Marker 'monitors-entered'
  $gate=New-MobileLinkMutex $fixture
  $probeOwns=$false
  try {
    $probeOwns=$gate.WaitOne(0)
    Assert (-not $probeOwns) 'Monitor mutations must still hold the lifecycle mutex'
    [IO.File]::WriteAllText((Join-Path $fixture 'allow-monitors'),'go')
    Wait-Marker 'diagnostics-entered'
    $probeOwns=$gate.WaitOne(0)
    Assert $probeOwns 'Maintain must release the gate before slow diagnostics'
    $gate.ReleaseMutex();$probeOwns=$false
    $start=Start-Controller Start;$children+= $start
    Assert ($start.WaitForExit(8000)) 'Foreground Start must complete while Maintain diagnostics remain blocked'
    Assert ($start.ExitCode -eq 0) ('Foreground Start failed: '+$start.StandardError.ReadToEnd()+$start.StandardOutput.ReadToEnd())
    Assert (Test-Path (Join-Path $fixture 'foreground-acquired')) 'Foreground controller must enter its mutating branch'
    Assert (-not $maintain.HasExited) 'Slow Maintain diagnostic barrier must still be active during Start'
    $operation=Get-Content (Join-Path $fixture 'logs\state\mobile-link-operation.json') -Raw | ConvertFrom-Json
    Assert ($operation.phase -eq 'ready' -and -not $operation.active) 'Foreground operation must not fail at checking'
    [IO.File]::WriteAllText((Join-Path $fixture 'allow-diagnostics'),'go')
    Assert ($maintain.WaitForExit(10000)) 'Maintain must finish after diagnostics are released'
    Assert ($maintain.ExitCode -eq 0) ('Maintain must not double-release its mutex: '+$maintain.StandardError.ReadToEnd())
  } finally {if($probeOwns){$gate.ReleaseMutex()};$gate.Dispose()}
  @{passed=$checks;monitorMutationsLocked=$true;slowDiagnosticsUnlocked=$true;foregroundStartCompleted=$true;realServicesTouched=$false} | ConvertTo-Json -Compress
} finally {
  foreach($child in $children){if(-not $child.HasExited){$child.Kill()};$child.Dispose()}
  $full=[IO.Path]::GetFullPath($fixture)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'mobile-link-maintain-test-*'){
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
