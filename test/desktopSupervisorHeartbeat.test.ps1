$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot=Join-Path ([IO.Path]::GetTempPath()) ('desktop-heartbeat-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
# Load only the predicate. Never start the real watchdog or call recovery.
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools\harmony\watch-desktop-live.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-DesktopSupervisorArmed'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
try {
  $stateDir=Join-Path $repoRoot 'logs\state'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $armPath=Join-Path $stateDir 'desktop-supervisor.json'
  Assert (-not (Test-DesktopSupervisorArmed)) 'Missing heartbeat must not arm recovery'
  $fresh=[pscustomobject]@{heartbeatAt=[datetime]::UtcNow.ToString('o');pid=$PID}
  $fresh | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8
  Assert (Test-DesktopSupervisorArmed) 'Fresh UTC heartbeat must stay armed after JSON deserialization'
  $fresh.heartbeatAt=[datetimeoffset]::Now.ToString('o')
  $fresh | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8
  Assert (Test-DesktopSupervisorArmed) 'Fresh offset heartbeat must remain armed'
  $fresh.heartbeatAt=[datetime]::UtcNow.AddSeconds(-60).ToString('o')
  $fresh | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8
  Assert (-not (Test-DesktopSupervisorArmed)) 'Expired heartbeat must not arm recovery'
  $fresh.heartbeatAt=[datetime]::UtcNow.AddMinutes(1).ToString('o')
  $fresh | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8
  Assert (-not (Test-DesktopSupervisorArmed)) 'Future heartbeat must not arm recovery'
  $fresh.heartbeatAt=[datetime]::UtcNow.ToString('o')
  $absent=2147483647
  Assert ($null -eq (Get-Process -Id $absent -ErrorAction SilentlyContinue)) 'Absent PID fixture must be absent'
  $fresh.pid=$absent
  $fresh | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8
  Assert (-not (Test-DesktopSupervisorArmed)) 'Dead supervisor process must not arm recovery'
  '{invalid' | Set-Content -LiteralPath $armPath
  Assert (-not (Test-DesktopSupervisorArmed)) 'Malformed heartbeat must not arm recovery'
  Write-Output ('PASS: '+$checks+' desktop supervisor heartbeat checks')
} finally {
  $target=[IO.Path]::GetFullPath($repoRoot)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($target.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $target -Recurse -Force }
}
