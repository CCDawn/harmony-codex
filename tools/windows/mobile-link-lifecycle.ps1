# Shared lifecycle primitives. No credentials or raw command lines in the catalog.
function Start-MobileLinkDetached {
  param([string]$HostPath,[string]$ScriptPath,[string[]]$Arguments,[string]$LogPath,[string]$WorkingDirectory)
  if (-not ('MobileLinkNativeProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MobileLinkNativeProcess {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
  public int cb; public string reserved,desktop,title; public int x,y,width,height,xChars,yChars,fill,flags;
  public short show,reservedSize; public IntPtr reservedData,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,int flags,IntPtr environment,string cwd,ref StartupInfo startup,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static int Start(string app,string arguments,string cwd) {
  var startup=new StartupInfo(); startup.cb=Marshal.SizeOf(startup); ProcessInfo info;
  // Never let long-lived services inherit the manager's redirected output pipes.
  if(!CreateProcessW(app,new StringBuilder("\""+app+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,cwd,ref startup,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
  CloseHandle(info.thread); CloseHandle(info.process); return info.pid;
 }
}
'@ | Out-Null
  }
  $scriptLiteral="'"+$ScriptPath.Replace("'","''")+"'"
  $logLiteral="'"+$LogPath.Replace("'","''")+"'"
  $quoted=@($Arguments | ForEach-Object {
    if ([string]$_ -match '^-[a-zA-Z][a-zA-Z0-9-]*$') { [string]$_ }
    else { "'"+([string]$_).Replace("'","''")+"'" }
  })
  $command="& $scriptLiteral "+($quoted -join ' ')+" *> $logLiteral; if (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE }"
  # Literal paths contain no double quote on Windows; arguments here are only switches and ports.
  $childId=[MobileLinkNativeProcess]::Start($HostPath,('-NoProfile -ExecutionPolicy Bypass -Command "'+$command+'"'),$WorkingDirectory)
  $process=[Diagnostics.Process]::GetProcessById($childId)
  $null=$process.Handle # Retain a query handle before exit so ExitCode remains available.
  $process
}

function New-MobileLinkMutex {
  param([string]$Repo)
  $root=[IO.Path]::GetFullPath($Repo).TrimEnd('\','/').ToLowerInvariant()
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hash=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','') }
  finally { $sha.Dispose() }
  [Threading.Mutex]::new($false, ('Local\CodexMobileLink-' + $hash.Substring(0,16)))
}

function Enter-MobileLinkCycle {
  param([string]$Repo)
  $gate=New-MobileLinkMutex $Repo
  $owns=$false
  try { $owns=$gate.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owns=$true }
  if (-not $owns) { $gate.Dispose(); return $null }
  if (Test-MobileLinkPaused $Repo) { $gate.ReleaseMutex(); $gate.Dispose(); return $null }
  return $gate
}

function Exit-MobileLinkCycle {
  param([Threading.Mutex]$Gate)
  if ($null -ne $Gate) { $Gate.ReleaseMutex(); $Gate.Dispose() }
}

function Get-MobileLinkRole {
  param([object]$Process)
  $command = [string]$Process.CommandLine
  $name = [string]$Process.Name
  if ($name -notmatch '^(pwsh|powershell|node|python|pythonw|cmd)\.exe$') { return '' }
  if ($name -match '^(pwsh|powershell)\.exe$') {
    foreach ($role in @('watch-local-bridge','watch-desktop-live','watch-bridge-proxy','watch-hdc-connection','start-hdc-relay')) {
      if ($command -match ([regex]::Escape($role) + '\.ps1(?:[''"]|\s|$)')) { return $role }
    }
    if ($command -match 'node\s+src[\\/]server\.js' -and $command -match 'CODEX_BRIDGE_WORKSPACE') { return 'bridge-host' }
  }
  if ($name -eq 'node.exe' -and $command -match 'src[\\/]server\.js(?:"|\s|$)') { return 'bridge' }
  if ($name -match '^(node|cmd)\.exe$' -and $command -match '(start-local-proxy\.mjs|hdc:proxy)') { return 'hdc-proxy' }
  if ($name -match '^(node|cmd)\.exe$' -and $command -match '(start-bridge-proxy\.mjs|bridge:relay-proxy)') { return 'public-proxy' }
  if ($name -match '^pythonw?\.exe$' -and $command -match 'voice_server\.py(?:"|\s|$)') { return 'voice' }
  return ''
}

function Get-MobileLinkOwnedProcesses {
  param([string]$Repo, [object[]]$Processes)
  $root = [IO.Path]::GetFullPath($Repo).TrimEnd('\','/')
  $owned = @{}
  foreach ($process in $Processes) {
    $role = Get-MobileLinkRole $process
    # A separator prevents matching another checkout whose name shares a prefix.
    $hasRoot = ([string]$process.CommandLine).IndexOf($root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ([string]$process.CommandLine).IndexOf($root.Replace('\','/') + '/', [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($role -and $hasRoot) { $owned[[int]$process.ProcessId] = $process }
  }
  do {
    $changed = $false
    foreach ($process in $Processes) {
      if ($owned.ContainsKey([int]$process.ProcessId)) { continue }
      $parent = $owned[[int]$process.ParentProcessId]
      if ($parent -and (Get-MobileLinkRole $process) -and
          ([datetime]$process.CreationDate -ge [datetime]$parent.CreationDate)) {
        $owned[[int]$process.ProcessId] = $process
        $changed = $true
      }
    }
  } while ($changed)
  @($owned.Values)
}

function Test-MobileLinkSameProcess {
  param([object]$Expected, [object]$Current)
  return $null -ne $Current -and [int]$Expected.ProcessId -eq [int]$Current.ProcessId -and
    [datetime]$Expected.CreationDate -eq [datetime]$Current.CreationDate -and
    (Get-MobileLinkRole $Expected) -eq (Get-MobileLinkRole $Current)
}

function Get-MobileLinkStatePath {
  param([string]$Repo)
  Join-Path $Repo 'logs\state\mobile-link-control.json'
}

function Test-MobileLinkPaused {
  param([string]$Repo)
  $path = Get-MobileLinkStatePath $Repo
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try { return (Get-Content -Raw -LiteralPath $path | ConvertFrom-Json).desiredState -eq 'stopped' }
  catch { return $true } # Corrupt control state must not trigger automatic recovery.
}

function Set-MobileLinkDesiredState {
  param([string]$Repo, [ValidateSet('running','stopped')][string]$State)
  $path = Get-MobileLinkStatePath $Repo
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  $temp = $path + '.' + $PID + '.tmp'
  @{ version=1; desiredState=$State; updatedAt=[datetime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding utf8
  [IO.File]::Move($temp, $path, $true)
}

function Stop-MobileLinkOwnedProcesses {
  param([string]$Repo, [string[]]$Roles=@())
  $snapshot = @(Get-CimInstance Win32_Process)
  $owned = @(Get-MobileLinkOwnedProcesses -Repo $Repo -Processes $snapshot)
  if ($Roles.Count -gt 0) { $owned=@($owned | Where-Object { (Get-MobileLinkRole $_) -in $Roles }) }
  # Monitors first, then leaf services, then launch wrappers. Official Codex is never a candidate.
  $ordered = @($owned | Sort-Object @{Expression={
    $role = Get-MobileLinkRole $_
    if ($role -like 'watch-*') { 0 } elseif ($_.Name -match '^(node|python|pythonw)\.exe$') { 1 } else { 2 }
  }})
  $stopped = @()
  foreach ($expected in $ordered) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.ProcessId)" -ErrorAction SilentlyContinue
    if (Test-MobileLinkSameProcess $expected $current) {
      Stop-Process -Id ([int]$current.ProcessId) -Force -ErrorAction Stop
      $stopped += [int]$current.ProcessId
    }
  }
  $remaining = @()
  foreach ($expected in $owned) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.ProcessId)" -ErrorAction SilentlyContinue
    if (Test-MobileLinkSameProcess $expected $current) { $remaining += [int]$current.ProcessId }
  }
  [pscustomobject]@{ stopped=$stopped; remaining=$remaining }
}
