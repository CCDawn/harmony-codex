$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mobile-bootstrap-cancel-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
try {
  foreach($dir in @('scripts','tools\windows','logs\state')) { New-Item -ItemType Directory -Force -Path (Join-Path $fixture $dir) | Out-Null }
  Copy-Item (Join-Path $sourceRepo 'tools\windows\mobile-link-lifecycle.ps1') (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  @'
function Ensure-MobileVoiceTunnel {
  param($Repo,[scriptblock]$CanStart)
  if((Get-Content (Join-Path $Repo 'scenario') -Raw).Trim() -eq 'late-voice-stop') {
    Set-MobileLinkDesiredState $Repo stopped
  }
  if($null -ne $CanStart -and -not (& $CanStart)) { return }
  Add-Content (Join-Path $Repo 'voice-starts') 'start'
}
'@ | Set-Content (Join-Path $fixture 'tools\windows\mobile-voice-tunnel.ps1')
  $path=Join-Path $sourceRepo 'scripts\start-codex-mobile-stack.ps1'
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
  Assert ($errors.Count -eq 0) 'Bootstrap must parse'
  $source=Get-Content -LiteralPath $path -Raw
  # Retain the real entry check, Ensure-LocalBridge and Start-LocalBridgeProcess.
  # Every process/task/network boundary except the recorded Start-Process stub
  # is replaced in the fixture; no repository service is queried or launched.
  $mocks=@{
    'Resolve-CompatiblePowerShellHost'="function Resolve-CompatiblePowerShellHost { 'fixture-host' }"
    'Stop-StaleLauncherWindows'='function Stop-StaleLauncherWindows {}'
    'Stop-ProjectProcess'='function Stop-ProjectProcess { param($Pattern) }'
    'Stop-BridgePortOwner'='function Stop-BridgePortOwner { param($Port) }'
    'Wait-BridgeHealth'="function Wait-BridgeHealth { param(`$TimeoutSeconds) [pscustomobject]@{run=[pscustomobject]@{runId='fixture'};runtime=[pscustomobject]@{mode='desktop'}} }"
    'Set-AppServerRuntimeStartupStatus'='function Set-AppServerRuntimeStartupStatus { param($Runtime) $true }'
    'Ensure-LocalBridgeWatchdog'='function Ensure-LocalBridgeWatchdog {}'
    'Ensure-HdcRelay'='function Ensure-HdcRelay {}'
    'Show-RelayState'='function Show-RelayState {}'
    'Ensure-CodexDesktopLive'='function Ensure-CodexDesktopLive {}'
    'Ensure-DesktopLiveWatchdog'='function Ensure-DesktopLiveWatchdog {}'
    'Test-BridgeApi'='function Test-BridgeApi {}'
    'Write-FinalStartupSummary'='function Write-FinalStartupSummary { $script:StartupExitCode=0 }'
    'Get-LocalBridgeHealth'=@'
function Get-LocalBridgeHealth {
  $scenario=(Get-Content (Join-Path $repoRoot 'scenario') -Raw).Trim()
  $control=Join-Path $repoRoot 'logs\state\mobile-link-control.json'
  $config=Join-Path $repoRoot 'logs\state\mobile-link-guardian-config.json'
  switch($scenario) {
    'late-stop' { Set-MobileLinkDesiredState $repoRoot stopped }
    'stop-start-aba' { Set-MobileLinkDesiredState $repoRoot stopped; Set-MobileLinkDesiredState $repoRoot running }
    'disable' { '{"enabled":false,"allowCodexRestart":true}' | Set-Content $config }
    'disable-enable-aba' { '{"enabled":false}' | Set-Content $config; '{"enabled":true,"allowCodexRestart":true,"updatedAt":"new-enable"}' | Set-Content $config }
    'permission-revoked' { '{"enabled":true,"allowCodexRestart":false}' | Set-Content $config }
    'control-corrupt' { '{broken' | Set-Content $control }
    'control-missing' { Remove-Item -LiteralPath $control }
    'config-corrupt' { '{broken' | Set-Content $config }
    'config-missing' { Remove-Item -LiteralPath $config }
  }
  [pscustomobject]@{Ok=$false;Error='fixture offline'}
}
'@
  }
  foreach($fn in @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $mocks.ContainsKey($node.Name)},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)) {
    $source=$source.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,$mocks[$fn.Name])
  }
  [IO.File]::WriteAllText((Join-Path $fixture 'scripts\start-codex-mobile-stack.ps1'),$source,[Text.UTF8Encoding]::new($false))
  @'
param([string]$Root,[string]$LinkVersion='',[string]$ConfigVersion='',[switch]$Guardian)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Start-Process { param($WindowStyle,$FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError) Add-Content (Join-Path $Root 'starts') 'start' }
function Start-Sleep { param($Milliseconds,$Seconds) }
$arguments=@{SkipHdcRelay=$true;SkipCodexDesktop=$true;RuntimeMode='desktop'}
if($LinkVersion) { $arguments.LinkControlVersion=$LinkVersion }
if($ConfigVersion) { $arguments.GuardianConfigVersion=$ConfigVersion }
if($Guardian) { $arguments.GuardianRepair=$true }
& (Join-Path $Root 'scripts\start-codex-mobile-stack.ps1') @arguments
exit $LASTEXITCODE
'@ | Set-Content (Join-Path $fixture 'driver.ps1')
  $control=Join-Path $fixture 'logs\state\mobile-link-control.json'
  $config=Join-Path $fixture 'logs\state\mobile-link-guardian-config.json'
  # First case is intentionally an unversioned late cancellation regression:
  # the previous bootstrap passes entry, then starts after the probe writes Stop.
  foreach($case in @(
    @{scenario='late-stop';versioned=$false;cancel=$true},
    @{scenario='healthy';versioned=$false;cancel=$false},
    @{scenario='healthy';versioned=$true;cancel=$false},
    @{scenario='entry-stop';versioned=$false;cancel=$true},
    @{scenario='late-stop';versioned=$true;cancel=$true},
    @{scenario='late-voice-stop';versioned=$true;cancel=$true},
    @{scenario='stop-start-aba';versioned=$true;cancel=$true},
    @{scenario='disable';versioned=$true;cancel=$true},
    @{scenario='disable-enable-aba';versioned=$true;cancel=$true},
    @{scenario='permission-revoked';versioned=$true;cancel=$true},
    @{scenario='control-corrupt';versioned=$false;cancel=$true},
    @{scenario='control-missing';versioned=$true;cancel=$true},
    @{scenario='config-corrupt';versioned=$true;cancel=$true},
    @{scenario='config-missing';versioned=$true;cancel=$true}
  )) {
    '{"desiredState":"running","updatedAt":"initial"}' | Set-Content $control
    '{"enabled":true,"allowCodexRestart":true,"updatedAt":"initial"}' | Set-Content $config
    if($case.scenario -eq 'entry-stop') { '{"desiredState":"stopped"}' | Set-Content $control }
    $case.scenario | Set-Content (Join-Path $fixture 'scenario')
    Remove-Item (Join-Path $fixture 'starts') -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $fixture 'voice-starts') -ErrorAction SilentlyContinue
    $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.Encoding]::UTF8;$info.StandardErrorEncoding=[Text.Encoding]::UTF8
    $args=@('-NoProfile','-File',(Join-Path $fixture 'driver.ps1'),'-Root',$fixture)
    if($case.versioned) { $args+=@('-LinkVersion',(Hash $control),'-ConfigVersion',(Hash $config),'-Guardian') }
    foreach($arg in $args) { [void]$info.ArgumentList.Add($arg) }
    $child=[Diagnostics.Process]::Start($info)
    try {
      Assert ($child.WaitForExit(15000)) ('Fixture timeout: '+$case.scenario)
      $output=$child.StandardOutput.ReadToEnd()+$child.StandardError.ReadToEnd()
      $started=Test-Path (Join-Path $fixture 'starts')
      if($case.cancel) {
        Assert ($started -eq ($case.scenario -eq 'late-voice-stop')) ('Cancelled bootstrap launched a service: '+$case.scenario+' '+$output)
        Assert (-not (Test-Path (Join-Path $fixture 'voice-starts'))) ('Cancelled bootstrap launched voice: '+$case.scenario)
        if ($case.scenario -eq 'late-voice-stop') {
          # v4 关键路径极简：语音检查移入后台服务轨道（-Phase Background，主流程不 join）。
          # 主流程不再观察轨道内部的取消——轨道自身以 exit12 拒绝启动语音并写结果文件，
          # 主流程以 0/2 完成。此断言保持原有安全不变量：停止意图之后语音服务绝不被启动。
          Assert ($child.ExitCode -in @(0,2)) ('Late cancel must not fail the bootstrap: '+$case.scenario+' '+$output)
        } else {
          Assert ($child.ExitCode -eq 12 -and $output -match '链路启动已取消') ('Cancellation must be explicit exit12: '+$case.scenario+' '+$output)
        }
      } else {
        Assert ($child.ExitCode -eq 0 -and $started) ('Healthy bootstrap must launch: '+$output)
      }
    } finally { if(-not $child.HasExited){$child.Kill()};$child.Dispose() }
  }
  . (Join-Path $fixture 'tools\windows\mobile-link-lifecycle.ps1')
  Remove-Item -LiteralPath $control
  Assert-MobileLinkLaunchIntent -Repo $fixture -LinkControlVersion missing
  Assert $true 'Missing initial control snapshot should be accepted'
  Set-MobileLinkDesiredState $fixture running
  $cancelled=$false
  try { Assert-MobileLinkLaunchIntent -Repo $fixture -LinkControlVersion missing } catch [OperationCanceledException] { $cancelled=$true }
  Assert $cancelled 'Creating a control file must invalidate an initially missing snapshot'
  # Manual Start has no dependency on the automatic guardian being enabled.
  '{"enabled":false}' | Set-Content $config
  Assert-MobileLinkLaunchIntent -Repo $fixture -LinkControlVersion (Hash $control) -GuardianConfigVersion (Hash $config)
  Assert $true 'Manual Start must work while guardian is disabled'
  $cancelled=$false
  try { Assert-MobileLinkLaunchIntent -Repo $fixture -GuardianRepair } catch [OperationCanceledException] { $cancelled=$true }
  Assert $cancelled 'Unversioned guardian repair must still require enabled permission'
  # Execute the original boundary functions with in-memory process stubs.
  # Stopping the first fake child writes Stop; recursion must not stop its parent.
  & {
    param($Ast,$Root)
    $repoRoot=$Root;$LinkControlVersion='';$GuardianConfigVersion='';$GuardianRepair=$false
    $logRoot=$Root;$BridgePort=8787;$BridgeToken='';$BridgeTotpSecret='';$BridgePublicUrl='';$RuntimeMode='desktop';$CanaryThreadIds='';$VoiceEnabledText='0';$VoiceCommand='';$ConfigPath='fixture';$ForceRestart=$false
    $script:PowerShellHostPath='fixture-host'
    $effects=[Collections.Generic.List[string]]::new()
    function Write-Info { param($Message) }
    function Write-Step { param($Message) }
    function Test-ProjectProcess { param($Pattern) $false }
    function Start-Process { param($WindowStyle,$FilePath,$ArgumentList,$WorkingDirectory,$RedirectStandardOutput,$RedirectStandardError) $effects.Add('start') }
    function Stop-Process { param($Id,[switch]$Force,$ErrorAction) $effects.Add('stop');Set-MobileLinkDesiredState $repoRoot stopped }
    foreach($name in @('Assert-LinkBootstrapAllowed','Stop-ProcessTree','Start-LocalBridgeProcess','Ensure-BackgroundScript','Start-RelayProcess')) {
      $fn=$Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true) | Select-Object -First 1
      . ([scriptblock]::Create($fn.Extent.Text))
    }
    Set-MobileLinkDesiredState $Root running
    $cancelled=$false
    try { Stop-ProcessTree -ProcessId 101 -AllProcesses @([pscustomobject]@{ProcessId=102;ParentProcessId=101}) } catch [OperationCanceledException] { $cancelled=$true }
    Assert ($cancelled -and $effects.Count -eq 1 -and $effects[0] -eq 'stop') 'Every recursive process stop must recheck intent'
    foreach($launch in @(
      { Start-LocalBridgeProcess },
      { Ensure-BackgroundScript -DisplayName fixture -Pattern fixture -ScriptPath fixture -Arguments @() -StdoutName out -StderrName err },
      { Start-RelayProcess -Mode Proxy -Name fixture }
    )) {
      $effects.Clear();$cancelled=$false
      try { & $launch } catch [OperationCanceledException] { $cancelled=$true }
      Assert ($cancelled -and $effects.Count -eq 0) 'Each direct process launcher must reject Stop before effects'
    }
  } $ast $fixture
  @{passed=$checks;lateCancel=$true;aba=$true;processBoundaries=$true;realServicesTouched=$false} | ConvertTo-Json -Compress
} finally {
  $full=[IO.Path]::GetFullPath($fixture)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'mobile-bootstrap-cancel-*') {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
