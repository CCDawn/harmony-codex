param(
  [switch]$ParentProbe,
  [string]$ProbeChildScript,
  [string]$ProbeMarkerPath
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\windows\managed-child-job.ps1'

function Quote-TestArgument([string]$Value) {
  $builder=New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $slashes=0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * ($slashes*2+1)))
      [void]$builder.Append('"')
      $slashes=0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes=0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes*2))) }
  [void]$builder.Append('"')
  $builder.ToString()
}

if ($ParentProbe) {
  . $helper
  $managedChild=$null
  try {
    $parentShellName=if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $parentShell=Join-Path $PSHOME $parentShellName
    $childArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
      (Quote-TestArgument $ProbeChildScript)
    $managedChild=Start-ManagedChildProcess -FilePath $parentShell `
      -Arguments $childArguments -WorkingDirectory $env:TEMP
    [IO.File]::WriteAllText($ProbeMarkerPath,[string]$managedChild.Process.Id,[Text.Encoding]::ASCII)
    Start-Sleep -Seconds 300
  } catch {
    $errorPath=Join-Path (Split-Path -Parent $ProbeMarkerPath) 'parent-error.txt'
    [IO.File]::WriteAllText($errorPath,[string]$_.Exception.Message,[Text.Encoding]::UTF8)
    exit 7
  } finally {
    if ($null -ne $managedChild) { $managedChild.Dispose() }
  }
  exit 0
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This integration test requires Windows.'
}

. $helper
$root=Join-Path ([IO.Path]::GetTempPath()) ('managed-child-job-test-'+[guid]::NewGuid().ToString('N'))
$checks=0
$parent=$null
$ownedChildPid=0

function Assert([bool]$Condition,[string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:checks++
}

function Test-ProcessAlive([int]$ProcessId) {
  $process=$null
  try {
    $process=[Diagnostics.Process]::GetProcessById($ProcessId)
    return -not $process.HasExited
  } catch {
    return $false
  } finally {
    if ($null -ne $process) { $process.Dispose() }
  }
}

function Wait-ProcessExit([int]$ProcessId,[int]$TimeoutMilliseconds) {
  $until=[DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while ([DateTime]::UtcNow -lt $until) {
    if (-not (Test-ProcessAlive $ProcessId)) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return -not (Test-ProcessAlive $ProcessId)
}

try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $shellName=if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
  $shell=Join-Path $PSHOME $shellName
  if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { throw 'Could not locate the current PowerShell executable.' }

  $sleepScript=Join-Path $root 'sleep-child.ps1'
  [IO.File]::WriteAllText($sleepScript,'Start-Sleep -Seconds 300',[Text.Encoding]::UTF8)
  $sleepArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    (Quote-TestArgument $sleepScript)

  $direct=Start-ManagedChildProcess -FilePath $shell -Arguments $sleepArguments -WorkingDirectory $root
  $directPid=$direct.Process.Id
  Assert (Test-ProcessAlive $directPid) 'The isolated child did not start.'
  $direct.Dispose()
  Assert (Wait-ProcessExit $directPid 8000) 'Disposing the managed child did not terminate it.'

  $shortScript=Join-Path $root 'short-child.ps1'
  [IO.File]::WriteAllText($shortScript,'exit 23',[Text.Encoding]::UTF8)
  $shortArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    (Quote-TestArgument $shortScript)
  $short=Start-ManagedChildProcess -FilePath $shell -Arguments $shortArguments -WorkingDirectory $root
  try {
    Assert ($short.Process.WaitForExit(10000)) 'The isolated short-lived child did not exit.'
    Assert ($short.Process.ExitCode -eq 23) 'The short-lived child exit code was not retained.'
  } finally {
    $short.Dispose()
  }

  $marker=Join-Path $root 'parent-child.pid'
  $parentArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' +
    (Quote-TestArgument $PSCommandPath) +
    ' -ParentProbe -ProbeChildScript ' + (Quote-TestArgument $sleepScript) +
    ' -ProbeMarkerPath ' + (Quote-TestArgument $marker)
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=$shell
  $startInfo.Arguments=$parentArguments
  $startInfo.WorkingDirectory=$root
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $parent=[Diagnostics.Process]::Start($startInfo)

  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $marker) -and [DateTime]::UtcNow -lt $deadline -and -not $parent.HasExited) {
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $marker)) {
    $detail=''
    $parentError=Join-Path $root 'parent-error.txt'
    if (Test-Path -LiteralPath $parentError) { $detail=[IO.File]::ReadAllText($parentError) }
    throw ('Parent probe did not create its child marker. ' + $detail)
  }
  $ownedChildPid=[int]([IO.File]::ReadAllText($marker).Trim())
  Assert (Test-ProcessAlive $ownedChildPid) 'The parent-owned isolated child exited before the parent was terminated.'

  $parent.Kill()
  [void]$parent.WaitForExit(8000)
  Assert (-not (Test-ProcessAlive $parent.Id)) 'The isolated parent did not terminate.'
  Assert (Wait-ProcessExit $ownedChildPid 8000) 'The child survived abrupt termination of its parent.'

  $badExecutableFailed=$false
  try {
    $ignored=Start-ManagedChildProcess -FilePath (Join-Path $root 'missing-executable.exe') `
      -Arguments '' -WorkingDirectory $root
  } catch {
    $badExecutableFailed=$true
    Assert ($_.Exception.Message -notmatch '(?i)missing-executable|Arguments|commandLine') 'A process launch error exposed its executable or raw arguments.'
  }
  Assert $badExecutableFailed 'A nonexistent executable must fail cleanly.'

  [pscustomobject]@{passed=$checks;disposeTerminatesChild=$true;parentTerminationReapsChild=$true;badExecutableHandled=$true} |
    ConvertTo-Json -Compress
} finally {
  if ($null -ne $parent) {
    try { if (-not $parent.HasExited) { $parent.Kill(); [void]$parent.WaitForExit(3000) } } catch { }
    $parent.Dispose()
  }
  if ($ownedChildPid -gt 0 -and (Test-ProcessAlive $ownedChildPid)) {
    try { $orphan=[Diagnostics.Process]::GetProcessById($ownedChildPid); $orphan.Kill(); $orphan.Dispose() } catch { }
  }
  $resolved=[IO.Path]::GetFullPath($root)
  $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolved) -like 'managed-child-job-test-*' -and
      (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
