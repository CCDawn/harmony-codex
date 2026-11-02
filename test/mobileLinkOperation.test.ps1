$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('mobile-link-operation-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
$children=@()
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message};$script:checks++}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'tools\windows') | Out-Null
  foreach($name in @('mobile-link-operation.ps1','mobile-link-repair-task.ps1','run-mobile-link-repair.ps1')){
    Copy-Item -LiteralPath (Join-Path $sourceRepo ('tools\windows\'+$name)) -Destination (Join-Path $fixture ('tools\windows\'+$name))
  }
  foreach($name in @('mobile-link-operation.ps1','mobile-link-repair-task.ps1','run-mobile-link-repair.ps1','mobile-link-control.ps1')){
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceRepo ('tools\windows\'+$name)),[ref]$tokens,[ref]$errors)
    Assert ($errors.Count -eq 0) ($name+' must parse')
  }
  . (Join-Path $fixture 'tools\windows\mobile-link-operation.ps1')
  $mock=Join-Path $fixture 'request.ps1'
@'
param([string]$Repo,[string]$Request)
$ErrorActionPreference='Stop'
. (Join-Path $Repo 'tools\windows\mobile-link-repair-task.ps1')
function Get-ScheduledTask {param($TaskName) if(Test-Path (Join-Path $Repo 'running')){[pscustomobject]@{State='Running'}}}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{Arguments=$Argument}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) @{}}
function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) @{}}
function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings,[switch]$Force) [IO.File]::AppendAllText((Join-Path $Repo 'registrations'),$Action.Arguments+"`n"); Start-Sleep -Milliseconds 300}
function Start-ScheduledTask {param($TaskName) [IO.File]::AppendAllText((Join-Path $Repo 'starts'),$TaskName+"`n"); [IO.File]::WriteAllText((Join-Path $Repo 'running'),'yes')}
[IO.File]::WriteAllText((Join-Path $Repo ('waiting-'+$Request)),'yes')
while(-not(Test-Path (Join-Path $Repo 'release'))){Start-Sleep -Milliseconds 20}
Start-MobileLinkRepairTask -Repo $Repo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Repo ('response-'+$Request+'.json'))
'@ | Set-Content -LiteralPath $mock -Encoding utf8
  foreach($request in @('a','b')){
    $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh.exe).Source)
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    foreach($arg in @('-NoProfile','-File',$mock,'-Repo',$fixture,'-Request',$request)){[void]$info.ArgumentList.Add($arg)}
    $children+= [Diagnostics.Process]::Start($info)
  }
  $deadline=[datetime]::UtcNow.AddSeconds(20)
  while(@('a','b' | Where-Object {Test-Path (Join-Path $fixture ('waiting-'+$_))}).Count -lt 2){if([datetime]::UtcNow -gt $deadline){throw 'Barrier timeout'};Start-Sleep -Milliseconds 20}
  [IO.File]::WriteAllText((Join-Path $fixture 'release'),'go')
  foreach($child in $children){Assert ($child.WaitForExit(20000)) 'Concurrent request timed out';Assert ($child.ExitCode -eq 0) ($child.StandardError.ReadToEnd()+(Get-Content (Join-Path $fixture 'logs\state\mobile-link-operation.json') -Raw))}
  $a=Get-Content (Join-Path $fixture 'response-a.json') -Raw | ConvertFrom-Json
  $b=Get-Content (Join-Path $fixture 'response-b.json') -Raw | ConvertFrom-Json
  Assert ($a.runId -eq $b.runId) 'Concurrent requests must receive one operation id'
  Assert (@(Get-Content (Join-Path $fixture 'registrations')).Count -eq 1) 'Exactly one task registration expected'
  Assert (@(Get-Content (Join-Path $fixture 'starts')).Count -eq 1) 'Exactly one task start expected'
  Assert ($a.joined -ne $b.joined) 'One caller owns launch and the other joins'
  Assert ($a.resultPath -eq $b.resultPath -and $a.resultPath.EndsWith($a.runId+'.json')) 'Each run owns its immutable result path'
  $old=Get-MobileLinkOperation $fixture
  Assert ($old.active -and $old.phase -eq 'checking' -and $null -eq $old.completedAt) 'Initial public state must be active'
  foreach($phase in @('starting_services','connecting_desktop','restarting_desktop','verifying','pending')){
    Assert (Set-MobileLinkOperation $fixture $old.operationId $phase) 'Current operation must advance'
    $snapshot=Get-MobileLinkOperation $fixture
    Assert ($snapshot.active -and $snapshot.phase -eq $phase -and $null -eq $snapshot.completedAt) 'Nonterminal stages remain active'
  }
  Assert (Set-MobileLinkOperation $fixture $old.operationId 'partial') 'Partial completion accepted'
  $completed=Get-MobileLinkOperation $fixture
  Assert (-not $completed.active -and $null -ne $completed.completedAt) 'Partial is a completed operation'
  $fresh=New-MobileLinkOperation $fixture Start
  Assert ($fresh.operation.operationId -ne $old.operationId) 'Completed work allows a fresh id'
  Assert (-not (Set-MobileLinkOperation $fixture $old.operationId ready)) 'An old completion cannot overwrite new progress'
  Assert ((Get-MobileLinkOperation $fixture).operationId -eq $fresh.operation.operationId) 'New owner must survive late completion'
  $snapshot=Get-MobileLinkOperation $fixture
  $snapshot.deadlineAt=[datetime]::UtcNow.AddSeconds(-1).ToString('o')
  Write-MobileLinkAtomicJson (Join-Path $fixture 'logs\state\mobile-link-operation.json') $snapshot
  Set-MobileLinkOperation $fixture $snapshot.operationId ready | Out-Null
  $expired=Get-MobileLinkOperation $fixture
  Assert ($expired.phase -eq 'failed' -and -not $expired.active) 'Expired operation cannot report ready'
  $snapshot=New-MobileLinkOperation $fixture Repair
  $runId=$snapshot.operation.operationId
  # The scheduled runner invokes this fixture controller without any service calls.
  '@{startupOutcome=@{state="ready";exitCode=0}} | ConvertTo-Json -Compress; exit 0' | Set-Content (Join-Path $fixture 'tools\windows\mobile-link-control.ps1') -Encoding utf8
  & (Get-Command pwsh.exe).Source -NoProfile -File (Join-Path $fixture 'tools\windows\run-mobile-link-repair.ps1') -RunId $runId
  Assert ($LASTEXITCODE -eq 0) 'Detached worker fixture must exit successfully'
  $resultPath=Join-Path $fixture ('logs\state\desktop-repair-results\'+$runId+'.json')
  Assert ((Get-Content $resultPath -Raw | ConvertFrom-Json).runId -eq $runId) 'Worker persists result by id'
  Assert ((Get-Content (Join-Path $fixture 'logs\state\desktop-repair-result.json') -Raw | ConvertFrom-Json).runId -eq $runId) 'Latest result stays compatible'
  $new=New-MobileLinkOperation $fixture Start
  & (Get-Command pwsh.exe).Source -NoProfile -File (Join-Path $fixture 'tools\windows\run-mobile-link-repair.ps1') -RunId $old.operationId
  Assert ($LASTEXITCODE -eq 1) 'Stale worker must refuse execution'
  Assert ((Get-MobileLinkOperation $fixture).operationId -eq $new.operation.operationId) 'Stale worker cannot replace progress'
  Assert ((Get-Content (Join-Path $fixture 'logs\state\desktop-repair-result.json') -Raw | ConvertFrom-Json).runId -eq $runId) 'Stale worker cannot replace latest result'
  Set-MobileLinkOperation $fixture $new.operation.operationId failed | Out-Null
  . (Join-Path $fixture 'tools\windows\mobile-link-repair-task.ps1')
  function Get-ScheduledTask {param($TaskName)}
  function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) @{}}
  function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) @{}}
  function New-ScheduledTaskSettingsSet {param($ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) @{}}
  function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings,[switch]$Force) throw 'https://secret/?token=never-public'}
  function Start-ScheduledTask {param($TaskName) throw 'Must not run'}
  $threw=$false
  try { Start-MobileLinkRepairTask -Repo $fixture | Out-Null } catch { $threw=$true }
  $failed=Get-MobileLinkOperation $fixture
  Assert ($threw -and -not $failed.active -and $failed.phase -eq 'failed') 'Registration failure completes operation'
  Assert ((Get-Content (Join-Path $fixture 'logs\state\mobile-link-operation.json') -Raw) -notmatch 'secret|token|https') 'Public snapshot must not expose exceptions'
  function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings,[switch]$Force)}
  $threw=$false
  try { Start-MobileLinkRepairTask -Repo $fixture | Out-Null } catch { $threw=$true }
  Assert ($threw -and -not (Get-MobileLinkOperation $fixture).active) 'Task start failure completes operation'
  @{passed=$checks;concurrentRegistrations=1;concurrentStarts=1;sameRunId=$true;realServicesTouched=$false} | ConvertTo-Json -Compress
} finally {
  foreach($child in $children){if(-not $child.HasExited){$child.Kill()};$child.Dispose()}
  $full=[IO.Path]::GetFullPath($fixture)
  if($full.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $full) -like 'mobile-link-operation-test-*'){
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
}
