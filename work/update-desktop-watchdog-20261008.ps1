$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
$gate=New-MobileLinkMutex $repo
$owns=$false
try {
  $all=@(Get-CimInstance Win32_Process)
  $owned=@(Get-MobileLinkOwnedProcesses $repo $all)
  $watch=@($owned|Where-Object{(Get-MobileLinkRole $_) -eq 'watch-desktop-live'})
  if($watch.Count -ne 1){throw 'Expected one owned desktop watchdog'}
  if([string]$watch[0].CommandLine -match '(?i)-(SessionId|BridgeToken|IntervalSeconds|FailureThreshold|RecoveryCooldownSeconds)'){throw 'Watchdog has custom arguments; preserve them before updating'}
  $hostPath=[string]$watch[0].ExecutablePath
  $protected=@($owned|Where-Object{(Get-MobileLinkRole $_) -ne 'watch-desktop-live'}) + @($all|Where-Object{$_.Name -match '^(ChatGPT|Codex|CodexMobileRemoteTray.*)\.exe$'})
  try { $owns=$gate.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $owns=$true }
  if(-not $owns){
    # A previous read-only probe confirmed this specific watchdog is stalled
    # while holding the mutex. Recheck the kernel owner before replacing it.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopWatchdogMutexOwner {
 [StructLayout(LayoutKind.Sequential)] struct Owner { public IntPtr Process; public IntPtr Thread; }
 [DllImport("ntdll.dll")] static extern int NtQueryMutant(IntPtr handle,int infoClass,out Owner owner,int size,out int length);
 public static long Read(IntPtr handle) { Owner owner; int length; int status=NtQueryMutant(handle,1,out owner,Marshal.SizeOf(typeof(Owner)),out length); return status==0?owner.Process.ToInt64():-1; }
}
'@
    $owner=[DesktopWatchdogMutexOwner]::Read($gate.SafeWaitHandle.DangerousGetHandle())
    $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$watch[0].ProcessId)
    if($owner -ne $watch[0].ProcessId -or -not (Test-MobileLinkSameProcess $watch[0] $current)){throw 'Busy mutex belongs to another operation; preserving it'}
    Stop-Process -Id ([int]$current.ProcessId) -Force
    try { $owns=$gate.WaitOne(20000) } catch [Threading.AbandonedMutexException] { $owns=$true }
    if(-not $owns){throw 'Manager operation remains busy after watchdog exit'}
  }
  $stopped=Stop-MobileLinkOwnedProcesses -Repo $repo -Roles @('watch-desktop-live')
  if($stopped.remaining.Count -gt 0){throw 'Old watchdog did not stop'}
  $child=Start-MobileLinkDetached -HostPath $hostPath -ScriptPath (Join-Path $repo 'tools\harmony\watch-desktop-live.ps1') -Arguments @('-BridgePort','8787') -LogPath (Join-Path $repo 'logs\startup\desktop-live-watchdog-updated.log') -WorkingDirectory $repo
  Start-Sleep -Seconds 2
  $new=Get-CimInstance Win32_Process -Filter ('ProcessId='+$child.Id)
  $after=@(Get-CimInstance Win32_Process)
  $changed=@(foreach($expected in $protected){
    $current=@($after|Where-Object ProcessId -eq $expected.ProcessId)
    if($current.Count -ne 1 -or [datetime]$current[0].CreationDate -ne [datetime]$expected.CreationDate){[int]$expected.ProcessId}
  })
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'tools\harmony\watch-desktop-live.ps1'),[ref]$tokens,[ref]$errors)
  $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-DesktopSupervisorArmed'},$true)
  . ([scriptblock]::Create($fn.Extent.Text))
  $repoRoot=$repo
  $record=[pscustomobject]@{UpdatedAt=[datetime]::UtcNow.ToString('o');OldWatchdogPid=$watch[0].ProcessId;NewWatchdogPid=$child.Id;WatchdogRunning=($null -ne $new -and (Get-MobileLinkRole $new) -eq 'watch-desktop-live');ProtectedProcessCount=$protected.Count;ProtectedProcessesPreserved=($changed.Count -eq 0);SupervisorArmed=(Test-DesktopSupervisorArmed)}
  $record|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-watchdog-update-20261008.json') -Encoding utf8
  $record|ConvertTo-Json
} finally {if($owns){$gate.ReleaseMutex()};$gate.Dispose()}
