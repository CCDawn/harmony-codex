$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Extract only the helper functions from the hdc watchdog (the script itself
# runs an endless loop, so it cannot be dot-sourced whole).
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools\harmony\watch-hdc-connection.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw ('watch-hdc-connection.ps1 parse errors: '+$errors[0].Message) }
foreach($name in @('Stop-HdcProcessTree','Invoke-HdcCommand','Test-HdcConnected','Test-HdcShellReady','Test-HdcOffline')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if ($null -eq $fn) { throw ("function not found in watchdog: $name") }
  . ([scriptblock]::Create($fn.Extent.Text))
}
# Keep probe-level tests fast: cap the production 15s default at 1.5s here.
$script:realInvokeHdcCommand=${function:Invoke-HdcCommand}
function Invoke-HdcCommand {
  param([string]$HdcPath,[string[]]$Arguments,[int]$TimeoutMs=15000)
  & $script:realInvokeHdcCommand -HdcPath $HdcPath -Arguments $Arguments -TimeoutMs ([math]::Min($TimeoutMs,1500))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('watch-hdc-test-'+[guid]::NewGuid().ToString('N'))
$target='127.0.0.1:19753'
$script:hdcLastTimedOut=$false
$script:hdcLastExitCode=$null
$script:hdcLastProcessId=$null
$script:checks=0
function Assert([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:checks++ }
function Wait-ProcessGone([int]$ProcessId,[int]$TimeoutMs=10000) {
  $deadline=[datetime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([datetime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  # Fake hdc: honors `list targets -v` and the shell probe; the hang variant
  # sleeps long past the probe timeout so the watchdog must kill it.
  $okHdc=Join-Path $root 'fake-hdc.cmd'
  @'
@echo off
if /i "%~1"=="list" (
  if defined HDC_FAKE_LIST_OFFLINE (
    echo 127.0.0.1:19753 Offline
  ) else (
    echo 127.0.0.1:19753 Connected localhost
  )
  exit /b 0
)
if defined HDC_FAKE_SHELL_FAIL (
  echo unexpected-output
  exit /b 1
)
echo codex-hdc-ready
exit /b 0
'@ | Set-Content -LiteralPath $okHdc -Encoding Ascii
  $hangHdc=Join-Path $root 'fake-hdc-hang.cmd'
  @'
@echo off
ping -n 31 127.0.0.1 > nul
'@ | Set-Content -LiteralPath $hangHdc -Encoding Ascii

  # 1. Fast path: output captured, exit code recorded, no timeout flag.
  $hdcPath=$okHdc
  $lines=@(Invoke-HdcCommand -HdcPath $hdcPath -Arguments @('list','targets','-v'))
  Assert (($lines -join "`n") -match 'Connected') 'fast hdc invocation must return its output lines'
  Assert ($script:hdcLastTimedOut -eq $false) 'fast hdc invocation must not set the timeout flag'
  Assert ($script:hdcLastExitCode -eq 0) 'fast hdc invocation must record exit code 0'

  # 2. Probes over the fast fake.
  Assert (Test-HdcConnected) 'connected target must be detected'
  $env:HDC_FAKE_LIST_OFFLINE='1'
  Assert (Test-HdcOffline) 'offline target must be detected'
  Remove-Item Env:\HDC_FAKE_LIST_OFFLINE -ErrorAction SilentlyContinue
  Assert (Test-HdcShellReady) 'healthy shell probe must pass'

  # 3. Shell content failure: probe fails without claiming a timeout.
  $env:HDC_FAKE_SHELL_FAIL='1'
  Assert (-not (Test-HdcShellReady)) 'bad shell probe output must fail'
  Assert ($script:hdcLastTimedOut -eq $false) 'content failure must not be reported as a timeout'
  Remove-Item Env:\HDC_FAKE_SHELL_FAIL -ErrorAction SilentlyContinue

  # 4. Timeout: probe call is cut, flagged as failure, and the hung process
  #    tree is killed (no orphan left behind).
  $hdcPath=$hangHdc
  $result=@(Invoke-HdcCommand -HdcPath $hangHdc -Arguments @('list','targets','-v') -TimeoutMs 1500)
  Assert ($result.Count -eq 0) 'timed out hdc invocation must return no output'
  Assert ($script:hdcLastTimedOut -eq $true) 'timed out hdc invocation must set the timeout failure flag'
  Assert ($script:hdcLastProcessId -ne $null -and $script:hdcLastProcessId -gt 0) 'timed out invocation must record the spawned process id'
  Assert (Wait-ProcessGone -ProcessId ([int]$script:hdcLastProcessId)) 'hung hdc process must be killed after timeout'
  Assert ($null -eq $script:hdcLastExitCode) 'timed out invocation must not report an exit code'

  # 5. Probe-level failure mapping: a hung hdc makes every probe fail while
  #    the timeout flag stays set for the caller's failure counting.
  $hdcPath=$hangHdc
  Assert (-not (Test-HdcShellReady)) 'hung hdc must fail the shell probe'
  Assert ($script:hdcLastTimedOut -eq $true) 'hung hdc shell probe must be recorded as a timeout failure'
  Assert (-not (Test-HdcOffline)) 'hung hdc must not claim the target is offline'
  $hdcPath=$okHdc

  @{passed=$checks;hdcTimeoutKill=$true;probeFailureFlag=$true} | ConvertTo-Json -Compress
} finally {
  Remove-Item Env:\HDC_FAKE_LIST_OFFLINE,Env:\HDC_FAKE_SHELL_FAIL -ErrorAction SilentlyContinue
  $resolved=[IO.Path]::GetFullPath($root)
  if ($resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'watch-hdc-test-*' -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
  }
}
