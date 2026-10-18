$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\tools\windows\mobile-link-lifecycle.ps1')
$script:expected=[pscustomobject]@{ProcessId=123456;Name='node.exe'}
$script:remains=$false
$script:queries=0
function Get-CimInstance {
  param($ClassName,$Filter,$ErrorAction)
  if (-not $Filter) { return $script:expected }
  $script:queries++
  if ($script:queries -eq 1 -or $script:remains) { return $script:expected }
  return $null
}
function Get-MobileLinkOwnedProcesses { param($Repo,$Processes) return $script:expected }
function Get-MobileLinkRole { param($Process) return 'bridge' }
function Test-MobileLinkSameProcess { param($Expected,$Current) return $null -ne $Current -and $Expected.ProcessId -eq $Current.ProcessId }
function Stop-Process { param($Id,$Force,$ErrorAction) throw 'Process vanished before stop' }
$result=Stop-MobileLinkOwnedProcesses -Repo 'fixture'
if ($result.remaining.Count -ne 0 -or $result.stopped.Count -ne 1) { throw 'A raced process exit must count as stopped' }
$script:queries=0
$script:remains=$true
$failed=$false
try { $null=Stop-MobileLinkOwnedProcesses -Repo 'fixture' } catch { $failed=$true }
if (-not $failed) { throw 'Failure to stop a still-live owner must propagate' }
Write-Output 'PASS: 2 owned-process stop race checks'
