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

function Get-MobileVoiceTunnelForwardEvidence {
  param([object]$Config)
  $logPath=Join-Path (Split-Path -Parent $Config.ScriptPath) 'tunnel.log'
  $stream=$null
  $lastConnect=$false
  $lastExitAfterConnect=$false
  $lastExitCode=0
  $lastForwardEvent=$null
  try {
    if (-not (Test-Path -LiteralPath $logPath)) { return [pscustomobject]@{running=$false;transportConnected=$false;state='unverified';message='计划任务在运行，但隧道日志不可用，无法确认 SSH 转发状态'} }
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
    return [pscustomobject]@{running=$false;transportConnected=$false;state='unverified';message='隧道日志不可读取，无法确认 SSH 转发状态'}
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  if ($lastForwardEvent -eq 'failed') {
    return [pscustomobject]@{running=$false;transportConnected=$false;state='forward-failed';message='受管 SSH 远端端口转发被拒绝，可能有已有隧道占用；公网语音可用性需另行验证'}
  }
  if ($lastExitAfterConnect -and $lastExitCode -ne 0) {
    return [pscustomobject]@{running=$false;transportConnected=$false;state='connection-failed';message='SSH 隧道连接或转发失败，请检查隧道日志'}
  }
  $forwardConfirmed=$lastConnect -and -not $lastExitAfterConnect -and $lastForwardEvent -eq 'success'

  # A live task or SSH socket alone is insufficient. Only an explicit OpenSSH remote
  # forward success record for port 18787, paired with the bound supervisor's active
  # SSH transport, verifies forwarding.
  try {
    $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    $supervisorIds=@(foreach ($process in $processes) {
      if ([IO.Path]::GetFileName([string]$process.Name) -notin @('powershell.exe','pwsh.exe')) { continue }
      $file=[regex]::Match([string]$process.CommandLine,'(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
      $scriptPath=$file.Groups[1].Value
      if (-not $scriptPath) { $scriptPath=$file.Groups[2].Value }
      if ($file.Success -and $scriptPath -and
          [IO.Path]::GetFullPath($scriptPath) -eq $Config.ScriptPath) { [int]$process.ProcessId }
    })
    # Current supervisors use one managed runner to stream readable SSH logs.
    # Only its direct child is eligible; unrelated SSH processes are not adopted.
    $runnerIds=@(foreach($process in $processes) {
      if ([int]$process.ParentProcessId -in $supervisorIds -and
          [string]$process.Name -in @('powershell.exe','pwsh.exe') -and
          [string]$process.CommandLine -match '(?i)[\\/]run-voice-tunnel\.ps1(?:"|\s|$)') {
        [int]$process.ProcessId
      }
    })
    foreach ($supervisorId in @($supervisorIds)+@($runnerIds)) {
      foreach ($ssh in $processes) {
        if ([IO.Path]::GetFileName([string]$ssh.Name) -ne 'ssh.exe' -or
            [int]$ssh.ParentProcessId -ne $supervisorId) { continue }
        $connections=@(Get-NetTCPConnection -State Established -OwningProcess ([int]$ssh.ProcessId) -ErrorAction Stop)
        if ($connections.Count -gt 0) {
          if ($forwardConfirmed) { return [pscustomobject]@{running=$true;transportConnected=$true;state='Running';message='远端 SSH 转发已确认建立；实际通话尚未验证'} }
          return [pscustomobject]@{running=$false;transportConnected=$true;state='unverified';message='SSH 连接已建立，但远端端口转发尚未验证'}
        }
      }
    }
  } catch {
    return [pscustomobject]@{running=$false;transportConnected=$false;state='unverified';message='计划任务在运行，但无法确认 SSH 转发进程或连接状态'}
  }
  [pscustomobject]@{running=$false;transportConnected=$false;state='unverified';message='计划任务在运行，但没有可确认的 SSH 转发连接'}
}

function Get-MobileVoiceTunnelStatus {
  param([string]$Repo)
  try {
    $config=Get-MobileVoiceTunnelConfig $Repo
    if ($null -eq $config) { return [pscustomobject]@{configured=$false;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='not-configured';message='未配置独立语音隧道'} }
    $task=Get-MobileVoiceTunnelTask $config
    if ($null -eq $task) { return [pscustomobject]@{configured=$true;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='Missing';taskState='Missing';taskName=$config.TaskName;message='已配置的语音隧道任务不存在'} }
    $taskState=[string]$task.State
    if ($taskState -eq 'Running') {
      $evidence=Get-MobileVoiceTunnelForwardEvidence $config
      return [pscustomobject]@{configured=$true;available=$true;running=$evidence.running;taskRunning=$true;transportConnected=$evidence.transportConnected;state=$evidence.state;taskState=$taskState;taskName=$config.TaskName;message=$evidence.message}
    }
    [pscustomobject]@{configured=$true;available=$true;running=$false;taskRunning=$false;transportConnected=$false;state=$taskState;taskState=$taskState;taskName=$config.TaskName;message="语音隧道任务未运行（$taskState）"}
  } catch {
    [pscustomobject]@{configured=$true;available=$false;running=$false;taskRunning=$false;transportConnected=$false;state='binding-error';message='语音隧道任务绑定无效'}
  }
}

function Ensure-MobileVoiceTunnel {
  param([string]$Repo)
  if (Test-MobileLinkPaused $Repo) { return }
  $config=Get-MobileVoiceTunnelConfig $Repo
  if ($null -eq $config) { return }
  $task=Get-MobileVoiceTunnelTask $config
  if ($null -eq $task) { throw 'Configured voice tunnel task is missing.' }
  if ([string]$task.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $config.TaskName -TaskPath '\' | Out-Null
  }
  if ([string]$task.State -ne 'Running') {
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

function Stop-MobileVoiceTunnel {
  param([string]$Repo)
  $config=Get-MobileVoiceTunnelConfig $Repo
  if ($null -eq $config) { return }
  $task=Get-MobileVoiceTunnelTask $config
  if ($null -eq $task) { return }
  $wasRunning=[string]$task.State -eq 'Running'
  Disable-ScheduledTask -TaskName $config.TaskName -TaskPath '\' | Out-Null
  if ($wasRunning) {
    Stop-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
  }
  $deadline=[datetime]::UtcNow.AddSeconds(5)
  do {
    $current=Get-MobileVoiceTunnelTask $config
    if ($null -eq $current -or [string]$current.State -ne 'Running') { return }
    Start-Sleep -Milliseconds 100
  } while ([datetime]::UtcNow -lt $deadline)
  throw 'Voice tunnel task did not stop.'
}
