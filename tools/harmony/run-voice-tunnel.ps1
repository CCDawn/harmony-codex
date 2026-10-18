[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$LogPath)
# Runs inside the supervisor's kill-on-close job. Windows OpenSSH -E keeps the
# log exclusively open, so stream diagnostics through PowerShell instead.
$ErrorActionPreference='Continue'
$settings=Import-PowerShellDataFile -LiteralPath $ConfigPath -ErrorAction Stop
$sshExe=Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$sshArguments=@('-N','-T','-v','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',[string]$settings.IdentityPath,'-R',
  ("127.0.0.1:{0}:127.0.0.1:{1}" -f [int]$settings.RemotePort,[int]$settings.LocalPort),[string]$settings.SshDestination)
& $sshExe @sshArguments 2>&1 | ForEach-Object {
  Add-Content -LiteralPath $LogPath -Value ([string]$_) -Encoding utf8
}
exit $LASTEXITCODE
