[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$LogPath)
# Runs inside the supervisor's kill-on-close job. Windows OpenSSH -E keeps the
# log exclusively open, so stream diagnostics through PowerShell instead.
$ErrorActionPreference='Continue'
$settings=Import-PowerShellDataFile -LiteralPath $ConfigPath -ErrorAction Stop
$sshExe=Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$remotePort=[int]$settings.RemotePort
$localPort=[int]$settings.LocalPort
if($remotePort -lt 1 -or $remotePort -gt 65535 -or $localPort -lt 1 -or $localPort -gt 65535){throw 'Invalid tunnel port'}
$watchdogPath=Join-Path $PSScriptRoot 'voice_tunnel_watchdog.py'
try {$watchdog=[IO.File]::ReadAllText($watchdogPath)}
catch {throw 'Bundled tunnel watchdog is unavailable'}
# exec makes sshd the watchdog's direct parent. The bundled code accepts a port,
# never a PID, and can only signal that captured parent through its own pidfd.
# Python reads the bundled source to EOF, then keeps its own watchdog loop alive.
# The remote shell receives only fixed words and a validated numeric port.
$remoteCommand="exec python3 -u - --port $remotePort"
# A multiplexed master could carry unrelated sessions. Keep proxy/host settings
# while ensuring the watchdog's parent belongs only to this dedicated transport.
$sshArguments=@('-T','-v','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',[string]$settings.IdentityPath,'-R',
  ("127.0.0.1:{0}:127.0.0.1:{1}" -f $remotePort,$localPort),[string]$settings.SshDestination,$remoteCommand)
$watchdog | & $sshExe @sshArguments 2>&1 | ForEach-Object {
  Add-Content -LiteralPath $LogPath -Value ([string]$_) -Encoding utf8
}
exit $LASTEXITCODE
