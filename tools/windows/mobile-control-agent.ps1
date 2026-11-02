[CmdletBinding()]
param([ValidateSet('Ensure','Run','Status')][string]$Action='Status')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\','/')
$scriptPath=$PSCommandPath
$statePath=Join-Path $repo 'logs\state\mobile-control-agent-status.json'

function Get-ControlIdentity {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($repo.TrimEnd('\','/').ToLowerInvariant()))).Replace('-','').ToLowerInvariant().Substring(0,16) }
  finally {$sha.Dispose()}
}
function New-ControlMutex([string]$Suffix) {
  [Threading.Mutex]::new($false,('Local\CodexHarmonyControl-'+(Get-ControlIdentity)+'-'+$Suffix))
}
function Write-ControlStatus([string]$Phase,[int]$Failures=0) {
  if($Phase -notin @('starting','running','backoff','unavailable')) {throw 'Invalid control phase'}
  $status=@{version=1;phase=$Phase;heartbeatAt=[datetime]::UtcNow.ToString('o');failures=$Failures}
  $directory=Split-Path -Parent $statePath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary=$statePath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temporary,($status|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    if([IO.File]::Exists($statePath)){[IO.File]::Replace($temporary,$statePath,[NullString]::Value)}
    else{[IO.File]::Move($temporary,$statePath)}
  } finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
function Get-ControlStatus {
  $phase='unavailable';$heartbeat=$null;$failures=0
  try {
    $saved=Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    if($saved.phase -in @('starting','running','backoff','unavailable')){$phase=[string]$saved.phase}
    $instant=if($saved.heartbeatAt -is [datetime]){[datetimeoffset]$saved.heartbeatAt}else{[datetimeoffset]::Parse([string]$saved.heartbeatAt)}
    $heartbeat=$instant.ToUniversalTime().ToString('o')
    if(([datetimeoffset]::UtcNow-$instant).TotalSeconds -gt 90 -or $instant -gt [datetimeoffset]::UtcNow.AddSeconds(10)){$phase='unavailable'}
    $failures=[Math]::Max(0,[int]$saved.failures)
  }catch{$phase='unavailable'}
  # Never echo arbitrary persisted fields, task arguments, exceptions or config.
  [pscustomobject]@{version=1;phase=$phase;heartbeatAt=$heartbeat;failures=$failures}
}
function Read-ControlConfiguration {
  $settings=Import-PowerShellDataFile -LiteralPath (Join-Path $repo 'tools\harmony\control-agent.local.psd1')
  $relay=Import-PowerShellDataFile -LiteralPath (Join-Path $repo 'tools\harmony\hdc-relay.local.psd1')
  if([string]::IsNullOrWhiteSpace([string]$settings.SshDestination) -or [string]$settings.SshDestination -notmatch '^[a-zA-Z0-9_.@-]+$' -or [string]$settings.SshDestination -like '-*'){throw 'Control configuration unavailable'}
  if([string]::IsNullOrWhiteSpace([string]$settings.IdentityPath) -or -not [IO.File]::Exists([string]$settings.IdentityPath)){throw 'Control configuration unavailable'}
  if([int]$settings.RelayPort -lt 1 -or [int]$settings.RelayPort -gt 65535 -or [int]$settings.LocalForwardPort -ne 11978 -or [int]$settings.ControlPort -ne 8788){throw 'Control configuration unavailable'}
  $config=[IO.File]::ReadAllText((Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets'))
  $token=[regex]::Match($config,'DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*[''"]([^''"]+)[''"]')
  $secret=[regex]::Match($config,'DEFAULT_BRIDGE_TOTP_SECRET:\s*string\s*=\s*[''"]([^''"]+)[''"]')
  if(-not $token.Success -or -not $secret.Success -or [string]::IsNullOrWhiteSpace([string]$relay.Token)){throw 'Control configuration unavailable'}
  if([string]::IsNullOrWhiteSpace($token.Groups[1].Value) -or $secret.Groups[1].Value -notmatch '^[A-Za-z2-7= -]+$' -or $secret.Groups[1].Value -notmatch '[A-Za-z2-7]'){throw 'Control configuration unavailable'}
  @{SshDestination=[string]$settings.SshDestination;IdentityPath=[string]$settings.IdentityPath;RelayPort=[int]$settings.RelayPort
    RelayToken=[string]$relay.Token;BridgeToken=$token.Groups[1].Value;TotpSecret=$secret.Groups[1].Value}
}
function Get-ControlSshArguments($Config) {
  @('-N','-T','-E','NUL','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no',
    '-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
    '-i',$Config.IdentityPath,'-L',('127.0.0.1:11978:127.0.0.1:{0}' -f $Config.RelayPort),$Config.SshDestination)
}
function Start-ControlTunnel($Config) {
  . (Join-Path $repo 'tools\windows\managed-child-job.ps1')
  # Inputs are fixed options, a validated destination/port, and an existing
  # Windows key file (no quotes or trailing slash). This is a native command
  # line passed to CreateProcess, never a shell command. SSH diagnostics go to
  # NUL; -N emits no session output. The existing helper creates SSH suspended
  # in its own kill-on-close job, eliminating orphaned forwards on worker exit.
  $arguments=(@(Get-ControlSshArguments $Config | ForEach-Object {'"'+$_+'"'}) -join ' ')
  Start-ManagedChildProcess -FilePath (Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe') -Arguments $arguments -WorkingDirectory $repo
}
function Start-ControlChild([string]$Executable,[string[]]$Arguments,[hashtable]$Environment=@{}) {
  $info=[Diagnostics.ProcessStartInfo]::new($Executable)
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory=$repo
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  # pwsh is required for this worker, so ArgumentList passes every path/value as
  # one native argument without shell interpolation or quoting reconstruction.
  foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
  foreach($key in $Environment.Keys){$info.Environment[$key]=[string]$Environment[$key]}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  try {
    [void]$process.Start()
    # Drain and discard: SSH diagnostics may contain destinations and Node's
    # descendants may print authentication data. Neither goes to state/logs.
    $process.BeginOutputReadLine();$process.BeginErrorReadLine()
    $process
  }catch{$process.Dispose();throw 'Control child unavailable'}
}
function Stop-ControlChild($Process) {
  if($null -eq $Process){return}
  try {if(-not $Process.HasExited){$Process.Kill();[void]$Process.WaitForExit(5000)}}catch{}finally{$Process.Dispose()}
}
function Test-ControlForward {
  $client=[Net.Sockets.TcpClient]::new()
  try {$connection=$client.ConnectAsync('127.0.0.1',11978);$connection.Wait(250) -and $client.Connected}catch{$false}finally{$client.Dispose()}
}
function Ensure-ControlAgent {
  # Missing/invalid encryption or credentials is a visible unavailable state;
  # never register/start a plaintext or partially authenticated fallback.
  try {$null=Read-ControlConfiguration}catch{Write-ControlStatus unavailable;return}
  $gate=New-ControlMutex 'launch';$owns=$false
  try {
    try{$owns=$gate.WaitOne(1000)}catch [Threading.AbandonedMutexException]{$owns=$true}
    if(-not $owns){return}
    $name='CodexHarmonyMobileControl-'+(Get-ControlIdentity)
    $existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if($existing -and [string]$existing.State -eq 'Running'){return}
    $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments='--headless "'+$pwsh+'" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$scriptPath+'" -Action Run'
    $taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $repo
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    Register-ScheduledTask -TaskName $name -Action $taskAction -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
    Start-ScheduledTask -TaskName $name
  }finally{if($owns){$gate.ReleaseMutex()};$gate.Dispose()}
}
function Run-ControlAgent {
  $gate=New-ControlMutex 'worker';$owns=$false;$ssh=$null;$tunnel=$null;$node=$null;$failures=0
  try {
    try{$owns=$gate.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owns=$true}
    if(-not $owns){return}
    while($true){
      $started=[datetime]::UtcNow
      $configured=$false
      try {
        $config=Read-ControlConfiguration
        $configured=$true
        Write-ControlStatus starting $failures
        $nodeExe=(Get-Command node.exe -ErrorAction Stop).Source
        $tunnel=Start-ControlTunnel $config
        $ssh=$tunnel.Process
        $deadline=[datetime]::UtcNow.AddSeconds(15)
        do {
          if($ssh.HasExited){throw 'Control tunnel unavailable'}
          if(Test-ControlForward){break}
          Write-ControlStatus starting $failures
          Start-Sleep -Milliseconds 500
        }while([datetime]::UtcNow -lt $deadline)
        Start-Sleep -Seconds 1
        if($ssh.HasExited -or -not (Test-ControlForward)){throw 'Control tunnel unavailable'}
        $childEnvironment=@{HDC_RELAY_TOKEN=$config.RelayToken;CODEX_BRIDGE_TOKEN=$config.BridgeToken;CODEX_BRIDGE_TOTP_SECRET=$config.TotpSecret;MOBILE_CONTROL_OWNER_PID=[string]$PID}
        $node=Start-ControlChild $nodeExe @((Join-Path $repo 'scripts\hdc-relay\start-control-agent.mjs')) $childEnvironment
        $config=$null;$childEnvironment=$null
        while(-not $ssh.HasExited -and -not $node.HasExited){
          if(([datetime]::UtcNow-$started).TotalSeconds -gt 60){$failures=0}
          Write-ControlStatus running $failures
          Start-Sleep -Seconds 5
        }
        throw 'Control child unavailable'
      }catch{
        $failures=[Math]::Min(20,$failures+1)
        Write-ControlStatus $(if($configured){'backoff'}else{'unavailable'}) $failures
      }finally{
        # Only handles created in this round are terminated. No process lookup,
        # business Stop, Codex shutdown, or shared voice tunnel operations.
        Stop-ControlChild $node;if($tunnel){$tunnel.Dispose()};$node=$null;$ssh=$null;$tunnel=$null
        $config=$null;$childEnvironment=$null
      }
      $delay=[int][Math]::Min(60,[Math]::Pow(2,[Math]::Min(6,$failures)))
      for($second=0;$second -lt $delay;$second+=5){Write-ControlStatus $(if($configured){'backoff'}else{'unavailable'}) $failures;Start-Sleep -Seconds ([Math]::Min(5,$delay-$second))}
    }
  }finally{Stop-ControlChild $node;if($tunnel){$tunnel.Dispose()};if($owns){$gate.ReleaseMutex()};$gate.Dispose()}
}
try {
  switch($Action){
    'Ensure'{Ensure-ControlAgent;@{controlAgent=(Get-ControlStatus)}|ConvertTo-Json -Depth 3 -Compress}
    'Run'{Run-ControlAgent}
    'Status'{@{controlAgent=(Get-ControlStatus)}|ConvertTo-Json -Depth 3 -Compress}
  }
}catch{
  if($Action -ne 'Status'){try{Write-ControlStatus unavailable}catch{}}
  @{controlAgent=@{version=1;phase='unavailable';heartbeatAt=$null;failures=0}}|ConvertTo-Json -Depth 3 -Compress
  exit 1
}
