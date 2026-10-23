# Bind an existing, explicitly configured task to this checkout's lifecycle.
# Task settings alone do not recover every terminated console process.
function Get-MobileVoiceTunnelConfig {
  param([string]$Repo)
  $path=Join-Path $Repo 'tools\harmony\voice-tunnel.local.psd1'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $config=Import-PowerShellDataFile -LiteralPath $path
  if (-not $config.ContainsKey('TaskName') -or [string]::IsNullOrWhiteSpace([string]$config.TaskName)) { return $null }
  if (-not $config.ContainsKey('ScriptPath') -or [string]::IsNullOrWhiteSpace([string]$config.ScriptPath)) { throw 'Voice tunnel task binding has no script path.' }
  [pscustomobject]@{ TaskName=[string]$config.TaskName; ScriptPath=[IO.Path]::GetFullPath([string]$config.ScriptPath) }
}

function Get-MobileVoiceTunnelTask {
  param([object]$Config)
  $task=Get-ScheduledTask -TaskName $Config.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $null }
  $actions=@($task.Actions)
  if ($actions.Count -ne 1) { throw 'Voice tunnel task action ownership mismatch.' }
  $action=$actions[0]
  $execute=[string]$action.Execute
  $arguments=[string]$action.Arguments
  $hostName=[IO.Path]::GetFileName($execute)
  $scriptPath=$null
  $validAction=$false

  # Scheduled Tasks created through the Windows compatibility path may use
  # conhost --headless as the executable and put the real PowerShell command
  # in Arguments. Accept only that exact, known wrapper shape; arbitrary
  # conhost commands must never inherit ownership of this task.
  if ($hostName -ieq 'conhost.exe') {
    $expectedConhost=[IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32\conhost.exe'))
    $wrapper=[regex]::Match($arguments,'(?i)^--headless\s+"([^"]+)"\s+-NoProfile\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass\s+-File\s+"([^"]+)"\s*$')
    if ([IO.Path]::GetFullPath($execute) -ieq $expectedConhost -and $wrapper.Success) {
      $interpreter=[IO.Path]::GetFullPath($wrapper.Groups[1].Value)
      $expectedPowerShell=[IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'))
      if ($interpreter -ieq $expectedPowerShell) {
        $scriptPath=$wrapper.Groups[2].Value
        $validAction=$true
      }
    }
  } elseif ($hostName -in @('powershell.exe','pwsh.exe')) {
    # Preserve the legacy direct form while accepting the supported switches
    # in any order. Every accepted form is enumerated so no command or script
    # arguments can be smuggled beside the owned -File path.
    $directPrefixes=@(
      '',
      '-NoProfile',
      '-WindowStyle\s+Hidden',
      '-ExecutionPolicy\s+Bypass',
      '-NoProfile\s+-WindowStyle\s+Hidden',
      '-WindowStyle\s+Hidden\s+-NoProfile',
      '-NoProfile\s+-ExecutionPolicy\s+Bypass',
      '-ExecutionPolicy\s+Bypass\s+-NoProfile',
      '-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass',
      '-ExecutionPolicy\s+Bypass\s+-WindowStyle\s+Hidden',
      '-NoProfile\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass',
      '-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-WindowStyle\s+Hidden',
      '-WindowStyle\s+Hidden\s+-NoProfile\s+-ExecutionPolicy\s+Bypass',
      '-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass\s+-NoProfile',
      '-ExecutionPolicy\s+Bypass\s+-NoProfile\s+-WindowStyle\s+Hidden',
      '-ExecutionPolicy\s+Bypass\s+-WindowStyle\s+Hidden\s+-NoProfile'
    )
    foreach ($prefix in $directPrefixes) {
      $prefixPattern=if ([string]::IsNullOrEmpty($prefix)) { '' } else { $prefix+'\s+' }
      $directPattern='(?i)^'+$prefixPattern+'-File\s+(?:"([^"]+)"|(\S+))\s*$'
      $direct=[regex]::Match($arguments,$directPattern)
      if ($direct.Success) {
        $scriptPath=$direct.Groups[1].Value
        if (-not $scriptPath) { $scriptPath=$direct.Groups[2].Value }
        $validAction=$true
        break
      }
    }
  }
  if (-not $validAction -or [string]::IsNullOrWhiteSpace([string]$scriptPath) -or
      [IO.Path]::GetFullPath($scriptPath) -ine $Config.ScriptPath) {
    throw 'Voice tunnel task action ownership mismatch.'
  }
  $task
}

function Get-MobileVoiceTunnelProcessEvidence {
  param([object]$Config,[string]$Repo,[switch]$OwnersOnly)
  $ownerRunning=$false
  $transportConnected=$false
  $owners=@()
  try {
    $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    # Match the real -File argument, including the quoted switches emitted by
    # the managed runner. A path mentioned inside -Command is not ownership.
    $switches='(?:\s+"?-(?:NoProfile|NonInteractive|NoLogo)"?|\s+"?-ExecutionPolicy"?\s+"?Bypass"?|\s+"?-WindowStyle"?\s+"?Hidden"?)*'
    $invocation='(?i)^\s*(?:"[^"]+"|\S+)'+$switches+'\s+"?-File"?\s+(?:"([^"]+)"|(\S+))'
    $owners=@(foreach ($process in $processes) {
      if ([string]$process.Name -notin @('powershell.exe','pwsh.exe')) { continue }
      $file=[regex]::Match([string]$process.CommandLine,$invocation+'\s*$')
      $scriptPath=$file.Groups[1].Value
      if (-not $scriptPath) { $scriptPath=$file.Groups[2].Value }
      if ($file.Success -and $scriptPath -and
          [IO.Path]::GetFullPath($scriptPath) -ieq $Config.ScriptPath) {
        $creationDate=$null
        if ($null -ne $process.PSObject.Properties['CreationDate']) { $creationDate=$process.CreationDate }
        # Copy identity fields: callers must not rely on a mutable/live CIM view
        # when they later re-read a PID before terminating an owned supervisor.
        [pscustomobject]@{ProcessId=[int]$process.ProcessId;CreationDate=$creationDate;Name=[string]$process.Name;CommandLine=[string]$process.CommandLine}
      }
    })
    $supervisorIds=@($owners | ForEach-Object { $_.ProcessId })
    $ownerRunning=$supervisorIds.Count -gt 0
    if ($OwnersOnly) { return [pscustomobject]@{ownerRunning=$ownerRunning;owners=$owners;transportConnected=$false;observed=$true} }
    # The installed wrapper can live outside this checkout. The runner belongs
    # to this repository and must be a direct child of that exact wrapper.
    $runnerPath=[IO.Path]::GetFullPath((Join-Path $Repo 'tools\harmony\run-voice-tunnel.ps1'))
    $runnerArguments='(?:\s+"?-(?:ConfigPath|LogPath)"?\s+(?:"[^"]+"|\S+))*\s*$'
    $runnerIds=@(foreach ($process in $processes) {
      if ([int]$process.ParentProcessId -notin $supervisorIds -or
          [string]$process.Name -notin @('powershell.exe','pwsh.exe')) { continue }
      $file=[regex]::Match([string]$process.CommandLine,$invocation+$runnerArguments)
      $scriptPath=$file.Groups[1].Value
      if (-not $scriptPath) { $scriptPath=$file.Groups[2].Value }
      if ($file.Success -and $scriptPath -and
          [IO.Path]::GetFullPath($scriptPath) -ieq $runnerPath) { [int]$process.ProcessId }
    })
    foreach ($ssh in $processes) {
      if ([string]$ssh.Name -ine 'ssh.exe' -or
          [int]$ssh.ParentProcessId -notin (@($supervisorIds)+@($runnerIds))) { continue }
      $connections=@(Get-NetTCPConnection -State Established -OwningProcess ([int]$ssh.ProcessId) -ErrorAction Stop)
      if ($connections.Count -gt 0) { $transportConnected=$true;break }
    }
    [pscustomobject]@{ownerRunning=$ownerRunning;owners=$owners;transportConnected=$transportConnected;observed=$true}
  } catch {
    # Retain a verified owner even when socket inspection fails. Starting the
    # task again would duplicate that supervisor rather than repair transport.
    [pscustomobject]@{ownerRunning=$ownerRunning;owners=$owners;transportConnected=$false;observed=$false}
  }
}

function Get-MobileVoiceTunnelForwardEvidence {
  param([object]$Config,[string]$Repo)
  $processEvidence=Get-MobileVoiceTunnelProcessEvidence $Config $Repo
  $logPath=Join-Path (Split-Path -Parent $Config.ScriptPath) 'tunnel.log'
  $stream=$null
  $lastConnect=$false
  $lastExitAfterConnect=$false
  $lastExitCode=0
  $lastForwardEvent=$null
  try {
    if (-not (Test-Path -LiteralPath $logPath)) { return [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$processEvidence.transportConnected;state='unverified';message='隧道日志不可用，无法确认 SSH 转发状态'} }
    $stream=[IO.FileStream]::new($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    # Read line by line with bounded memory. A fixed tail can drop the
    # supervisor's connect and OpenSSH's forward-success lines during a long
    # healthy session, incorrectly downgrading it to unverified.
    $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$false,4096,$true)
    try {
      while ($null -ne ($rawLine=$reader.ReadLine())) {
        # Older PowerShell append modes can leave UTF-16 NUL bytes in a log
        # later appended as UTF-8. Lifecycle and OpenSSH markers are ASCII.
        $line=$rawLine.Replace([string][char]0,'').Replace([string][char]0xFEFF,'').Trim()
        $marker=[regex]::Match($line,'(?i)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s+(connect|exit=(-?\d+))$')
        if ($marker.Success) {
          if ($marker.Groups[1].Value -eq 'connect') {
            $lastConnect=$true
            $lastExitAfterConnect=$false
            $lastExitCode=0
            $lastForwardEvent=$null
          } elseif ($lastConnect) {
            $lastExitAfterConnect=$true
            $lastExitCode=[int]$marker.Groups[2].Value
          }
          continue
        }
        if (-not $lastConnect) { continue }
        if ([regex]::IsMatch($line,'(?i)remote port forwarding failed(?: for listen port \d+)?')) {
          $lastForwardEvent='failed'
        } elseif ([regex]::IsMatch($line,'(?i)remote forward success for:\s*listen\s+(?:127\.0\.0\.1|localhost):18787\b')) {
          $lastForwardEvent='success'
        }
      }
    } finally { $reader.Dispose() }
  } catch {
    return [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$processEvidence.transportConnected;state='unverified';message='隧道日志不可读取，无法确认 SSH 转发状态'}
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  if ($lastForwardEvent -eq 'failed') {
    return [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$processEvidence.transportConnected;state='forward-failed';message='受管 SSH 远端端口转发被拒绝，可能有已有隧道占用；公网语音可用性需另行验证'}
  }
  if ($lastExitAfterConnect -and $lastExitCode -ne 0) {
    return [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$processEvidence.transportConnected;state='connection-failed';message='SSH 隧道连接或转发失败，请检查隧道日志'}
  }
  $forwardConfirmed=$lastConnect -and -not $lastExitAfterConnect -and $lastForwardEvent -eq 'success'

  # A live task or SSH socket alone is insufficient. Only an explicit OpenSSH remote
  # forward success record for port 18787, paired with the bound supervisor's active
  # SSH transport, verifies forwarding.
  if ($processEvidence.transportConnected) {
    if ($forwardConfirmed) { return [pscustomobject]@{running=$true;ownerRunning=$processEvidence.ownerRunning;transportConnected=$true;state='Running';message='远端 SSH 转发已确认建立；实际通话尚未验证'} }
    return [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$true;state='unverified';message='SSH 连接已建立，但远端端口转发尚未验证'}
  }
  [pscustomobject]@{running=$false;ownerRunning=$processEvidence.ownerRunning;transportConnected=$false;state='unverified';message='没有可确认的 SSH 转发连接'}
}

function Get-MobileVoiceTunnelStatus {
  param([string]$Repo)
  try {
    $config=Get-MobileVoiceTunnelConfig $Repo
    if ($null -eq $config) { return [pscustomobject]@{configured=$false;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='not-configured';message='未配置独立语音隧道'} }
    $task=Get-MobileVoiceTunnelTask $config
    if ($null -eq $task) { return [pscustomobject]@{configured=$true;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='Missing';taskState='Missing';taskName=$config.TaskName;message='已配置的语音隧道任务不存在'} }
    $taskState=[string]$task.State
    if ($taskState -in @('Running','Ready')) {
      $evidence=Get-MobileVoiceTunnelForwardEvidence $config $Repo
      if ($taskState -eq 'Running' -or $evidence.ownerRunning) {
        return [pscustomobject]@{configured=$true;available=$true;running=$evidence.running;taskRunning=($taskState -eq 'Running');transportConnected=$evidence.transportConnected;state=$evidence.state;taskState=$taskState;taskName=$config.TaskName;message=$evidence.message}
      }
    }
    [pscustomobject]@{configured=$true;available=$true;running=$false;taskRunning=$false;transportConnected=$false;state=$taskState;taskState=$taskState;taskName=$config.TaskName;message="语音隧道任务未运行（$taskState）"}
  } catch {
    [pscustomobject]@{configured=$true;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='binding-error';message='语音隧道任务绑定无效'}
  }
}

function Ensure-MobileVoiceTunnel {
  param([string]$Repo,[scriptblock]$CanStart=$null)
  if (Test-MobileLinkPaused $Repo) { return }
  if ($null -ne $CanStart -and -not (& $CanStart)) { return }
  $config=Get-MobileVoiceTunnelConfig $Repo
  if ($null -eq $config) { return }
  $task=Get-MobileVoiceTunnelTask $config
  if ($null -eq $task) { throw 'Configured voice tunnel task is missing.' }
  if ([string]$task.State -eq 'Disabled') {
    if (Test-MobileLinkPaused $Repo) { return }
    if ($null -ne $CanStart -and -not (& $CanStart)) { return }
    Enable-ScheduledTask -TaskName $config.TaskName -TaskPath '\' | Out-Null
  }
  if ([string]$task.State -ne 'Running') {
    $processEvidence=Get-MobileVoiceTunnelProcessEvidence $config $Repo -OwnersOnly
    if ($processEvidence.ownerRunning -or -not $processEvidence.observed) { return }
    if (Test-MobileLinkPaused $Repo) { return }
    if ($null -ne $CanStart -and -not (& $CanStart)) { return }
    Start-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    $path=Join-Path $Repo 'logs\state\voice-tunnel-recovery.json'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    $count=0
    if (Test-Path -LiteralPath $path) {
      try { $count=[int](Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).recoveries } catch { }
    }
    @{taskName=$config.TaskName;recoveries=($count+1);recoveredAt=[datetime]::UtcNow.ToString('o')} |
      ConvertTo-Json | Set-Content -LiteralPath $path -Encoding utf8
  }
}

function Test-MobileVoiceTunnelSameOwner {
  param([object]$Expected,[object]$Current)
  if ($null -eq $Current -or $null -eq $Expected.CreationDate -or
      $null -eq $Current.PSObject.Properties['CreationDate'] -or $null -eq $Current.CreationDate) { return $false }
  try {
    return [int]$Expected.ProcessId -eq [int]$Current.ProcessId -and
      ([datetime]$Expected.CreationDate).ToUniversalTime() -eq ([datetime]$Current.CreationDate).ToUniversalTime() -and
      [string]$Expected.Name -ieq [string]$Current.Name -and
      [string]$Expected.CommandLine -ceq [string]$Current.CommandLine
  } catch { return $false }
}

function Stop-MobileVoiceTunnel {
  param([string]$Repo,[scriptblock]$CanStop=$null)
  $config=Get-MobileVoiceTunnelConfig $Repo
  if ($null -eq $config) { return }
  $task=Get-MobileVoiceTunnelTask $config
  if ($null -eq $task) { return }
  $evidence=Get-MobileVoiceTunnelProcessEvidence $config $Repo -OwnersOnly
  $wasRunning=[string]$task.State -eq 'Running'
  if ($null -ne $CanStop -and -not (& $CanStop)) { return }
  Disable-ScheduledTask -TaskName $config.TaskName -TaskPath '\' | Out-Null
  if ($wasRunning) {
    if ($null -ne $CanStop -and -not (& $CanStop)) { return }
    Stop-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
  }
  if (-not $evidence.observed) { throw 'Unable to inspect the bound voice tunnel supervisor.' }
  foreach ($expected in $evidence.owners) {
    if ($null -eq $expected.CreationDate) { throw 'Bound voice tunnel supervisor has no verifiable creation time.' }
    $current=@(Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.ProcessId)" -ErrorAction Stop)
    if ($current.Count -eq 0) { continue }
    if ($current.Count -ne 1 -or -not (Test-MobileVoiceTunnelSameOwner $expected $current[0])) {
      throw 'Bound voice tunnel supervisor identity changed; refusing to stop the replacement process.'
    }
    if ($null -ne $CanStop -and -not (& $CanStop)) { return }
    try {
      # The managed kill-on-close job reaps the runner and SSH. Only the exact
      # supervisor is stopped here; no name-based or broad child termination.
      Stop-Process -Id ([int]$expected.ProcessId) -Force -ErrorAction Stop
    } catch {
      $afterStop=@(Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.ProcessId)" -ErrorAction Stop)
      if ($afterStop.Count -gt 0 -and (Test-MobileVoiceTunnelSameOwner $expected $afterStop[0])) { throw }
    }
  }
  $deadline=[datetime]::UtcNow.AddSeconds(5)
  do {
    $current=Get-MobileVoiceTunnelTask $config
    $remaining=Get-MobileVoiceTunnelProcessEvidence $config $Repo -OwnersOnly
    if (-not $remaining.observed) { throw 'Unable to verify that the bound voice tunnel supervisor stopped.' }
    if (($null -eq $current -or [string]$current.State -ne 'Running') -and -not $remaining.ownerRunning) { return }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw 'Voice tunnel task or bound supervisor did not stop.'
}
