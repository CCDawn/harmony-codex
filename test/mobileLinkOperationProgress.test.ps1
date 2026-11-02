$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-progress-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'tools\windows') | Out-Null
  Copy-Item (Join-Path $sourceRepo 'tools\windows\mobile-link-operation.ps1') (Join-Path $fixture 'tools\windows\mobile-link-operation.ps1')
  '' | Set-Content (Join-Path $fixture 'tools\windows\mobile-voice-tunnel.ps1')
@'
function New-MobileLinkMutex {param($Repo) [Threading.Mutex]::new($false)}
function Test-MobileLinkPaused {param($Repo) Test-Path (Join-Path $Repo 'paused')}
function Set-MobileLinkDesiredState {param($Repo,$State) if($State -eq 'stopped'){[IO.File]::WriteAllText((Join-Path $Repo 'paused'),'yes')}}
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction) @()}
function Start-MobileLinkDetached {
  param($HostPath,$ScriptPath,$Arguments,$LogPath,$WorkingDirectory)
  if((Split-Path -Leaf $ScriptPath) -ne 'start-codex-mobile-stack.ps1'){throw 'Unexpected desktop restart'}
  Add-Content (Join-Path $repo 'phases') (Get-MobileLinkOperation $repo).phase
  [pscustomobject]@{ExitCode=0} | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($Timeout) $true} -PassThru | Add-Member -MemberType ScriptMethod -Name Dispose -Value {} -PassThru
}
'@ | Set-Content (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  $path=Join-Path $sourceRepo 'tools\windows\mobile-link-control.ps1'
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
  $controller=Get-Content $path -Raw
  $mocks=@{
    'Set-LinkEnvironment'='function Set-LinkEnvironment {}'
    'Ensure-LinkMonitors'='function Ensure-LinkMonitors {}'
    'Invoke-DesktopSafeRecovery'=@'
function Invoke-DesktopSafeRecovery {
  Add-Content (Join-Path $repo 'phases') (Get-MobileLinkOperation $repo).phase
  $scenario=Get-Content (Join-Path $repo 'scenario') -Raw
  if($scenario.Trim() -in @('pending','timeout')){return [pscustomobject]@{state='pending';message='正在等待桌面连接'}}
  if($scenario.Trim() -eq 'stop'){
    Set-MobileLinkDesiredState -Repo $repo -State stopped
    $current=Get-MobileLinkOperation $repo
    Set-MobileLinkOperation $repo $current.operationId failed | Out-Null
    return [pscustomobject]@{state='pending';message='正在等待桌面连接'}
  }
  [pscustomobject]@{state='not-needed'}
}
'@
    'Get-LinkStatus'=@'
function Get-LinkStatus {
  $count=if(Test-Path (Join-Path $repo 'count')){[int](Get-Content (Join-Path $repo 'count'))}else{0}
  $count++;[IO.File]::WriteAllText((Join-Path $repo 'count'),[string]$count)
  Add-Content (Join-Path $repo 'phases') (Get-MobileLinkOperation $repo).phase
  $scenario=(Get-Content (Join-Path $repo 'scenario') -Raw).Trim()
  if($scenario -eq 'timeout'){
    $current=Get-MobileLinkOperation $repo
    $current.deadlineAt=[datetime]::UtcNow.AddSeconds(-1).ToString('o')
    Write-MobileLinkAtomicJson (Join-Path $repo 'logs\state\mobile-link-operation.json') $current
  }
  $state=if(($scenario -eq 'pending' -and $count -eq 1) -or $scenario -eq 'failed'){'error'}else{'ready'}
  [pscustomobject]@{desktopLive=($state -eq 'ready');diagnostics=[pscustomobject]@{checks=@(
    [pscustomobject]@{id='bridge';state='ready'},[pscustomobject]@{id='desktop';state=$state},
    [pscustomobject]@{id='sessions';state=$state},[pscustomobject]@{id='companion';state=$state})}}
}
'@
  }
  foreach($fn in @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $mocks.ContainsKey($node.Name)},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)){
    $controller=$controller.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,$mocks[$fn.Name])
  }
  # Fixture-only diagnostics for failures in entirely mocked controller callbacks.
  $controller=$controller.Replace("  Write-LinkEvent ('failed type='", "  [Console]::Error.WriteLine(`$_.ToString()+`$_.ScriptStackTrace)`n  Write-LinkEvent ('failed type='")
  [IO.File]::WriteAllText((Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),$controller,[Text.UTF8Encoding]::new($false))
  foreach($scenario in @('pending','failed','healthy','stop','timeout')){
    $scenario | Set-Content (Join-Path $fixture 'scenario')
    foreach($file in @('count','phases','paused')){Remove-Item (Join-Path $fixture $file) -ErrorAction SilentlyContinue}
    $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',(Join-Path $fixture 'tools\windows\mobile-link-control.ps1'),'-Action','Start')){[void]$info.ArgumentList.Add($arg)}
    $child=[Diagnostics.Process]::Start($info)
    try {
      Assert ($child.WaitForExit(30000)) ('Isolated controller timed out: '+$scenario)
      $output=$child.StandardOutput.ReadToEnd();$stderr=$child.StandardError.ReadToEnd()
      $result=$output | ConvertFrom-Json
      $operation=Get-Content (Join-Path $fixture 'logs\state\mobile-link-operation.json') -Raw | ConvertFrom-Json
      $phases=@(Get-Content (Join-Path $fixture 'phases'))
      Assert ('starting_services' -in $phases -and 'connecting_desktop' -in $phases) 'Controller must publish phases before callbacks'
      Assert (-not $operation.active -and $null -ne $operation.completedAt) 'Every finished controller must publish terminal state'
      if($scenario -in @('pending','healthy')){
        Assert ($child.ExitCode -eq 0 -and $operation.phase -eq 'ready') ('Verified startup should succeed: '+$stderr+$output)
        Assert ($result.startupOutcome.state -eq 'ready') 'Controller result must agree with progress'
      }else{
        Assert ($child.ExitCode -ne 0 -and $operation.phase -eq 'failed') 'Failed acceptance or Stop must never publish ready'
      }
      if($scenario -eq 'pending'){
        Assert ('pending' -in $phases -and 'verifying' -in $phases) 'Pending must continue read-only verification'
        Assert ([int](Get-Content (Join-Path $fixture 'count')) -ge 2) 'Pending must read status again without restart'
      }
    } finally {if(-not $child.HasExited){$child.Kill()};$child.Dispose()}
  }
  @{passed=$checks;pendingResumed=$true;unverifiedReadyRejected=$true;stopPreserved=$true;realServicesTouched=$false} | ConvertTo-Json -Compress
} finally {
  $full=[IO.Path]::GetFullPath($fixture)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'mobile-link-progress-test-*'){
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
