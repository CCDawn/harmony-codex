param([int]$CdpPort = 0)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $repoRoot 'scripts/recover-codex-desktop-live-soft.ps1'
$checks = 0
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:checks++
}
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$null, [ref]$null)
foreach ($name in @('Get-ObjectValue', 'Invoke-JsonSafe', 'Test-CdpReady', 'Stop-DesktopLiveHost')) {
  $fn = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  & ([scriptblock]::Create($fn.Extent.Text.Replace("function $name", "function script:$name")))
}
function Write-Step { param($Message) }
function Write-Info { param($Message) }
if ($CdpPort -gt 0) {
  $result = Test-CdpReady -Port $CdpPort
  Assert $result.Ok 'An isolated IPv6-only CDP server must be accepted'
  Assert ($result.Port -eq $CdpPort) 'The configured CDP port must be retained'
}
$script:uris = @()
function Invoke-JsonSafe {
  param($Uri, $Headers, $TimeoutSec)
  $script:uris += $Uri
  Assert ($TimeoutSec -gt 0 -and $TimeoutSec -le 2) 'Each request must retain a bounded timeout'
  if ($Uri -like 'http://127.0.0.1:*') { return [pscustomobject]@{Ok=$false;Error='connection refused';Value=$null} }
  $targets = @(
    [pscustomobject]@{type='page';url='app://-/index.html?initialRoute=%2Favatar-overlay';webSocketDebuggerUrl='ws://overlay'},
    [pscustomobject]@{type='page';url='https://example.test/';webSocketDebuggerUrl='ws://unrelated'},
    [pscustomobject]@{type='webview';url='app://-/index.html';webSocketDebuggerUrl='ws://webview'},
    [pscustomobject]@{type='page';url='app://-/index.html';webSocketDebuggerUrl='ws://main'}
  )
  [pscustomobject]@{Ok=$true;Error='';Value=$targets}
}
$result = Test-CdpReady -Port 51413
Assert $result.Ok 'Readiness must fall back to IPv6 loopback'
Assert ($result.Target.webSocketDebuggerUrl -eq 'ws://main') 'Only the main Codex app target may authorize recovery'
Assert ($script:uris[0] -eq 'http://127.0.0.1:51413/json') 'IPv4 must remain the first choice'
Assert ($script:uris -contains 'http://[::1]:51413/json') 'IPv6 fallback must retain the configured port'
function Invoke-JsonSafe { param($Uri, $Headers, $TimeoutSec) [pscustomobject]@{Ok=$true;Error='';Value=@([pscustomobject]@{type='page';url='https://example.test/';webSocketDebuggerUrl='ws://unrelated'})} }
Assert (-not (Test-CdpReady -Port 51413).Ok) 'An unrelated page must never authorize recovery'

$script:stopped = @()
$script:ownedScript = Join-Path $repoRoot 'scripts/start-desktop-cdp-live-host.mjs'
function Get-CimInstance {
  param($ClassName, $ErrorAction)
  @(
    [pscustomobject]@{ProcessId=101;CommandLine=('node "' + $script:ownedScript + '"')},
    [pscustomobject]@{ProcessId=102;CommandLine='node C:\another-project\scripts\start-desktop-cdp-live-host.mjs'},
    [pscustomobject]@{ProcessId=103;CommandLine='node .\scripts\start-desktop-cdp-live-host.mjs'},
    [pscustomobject]@{ProcessId=104;CommandLine=('node "' + $script:ownedScript + '.backup"')},
    [pscustomobject]@{ProcessId=105;CommandLine=('node "' + $script:ownedScript.Replace('\', '/') + '"')},
    [pscustomobject]@{ProcessId=$PID;CommandLine=('node "' + $script:ownedScript + '"')}
  )
}
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += [int]$Id }
Stop-DesktopLiveHost
Assert (($script:stopped -join ',') -eq '101,105') 'Recovery must stop only processes carrying this repository absolute live-host script path'
@{passed=$checks;realServicesTouched=$false} | ConvertTo-Json -Compress
