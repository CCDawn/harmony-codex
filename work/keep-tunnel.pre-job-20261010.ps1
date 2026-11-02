$ErrorActionPreference = 'Continue'
$logPath = Join-Path $PSScriptRoot 'tunnel.log'
$statePath = Join-Path $PSScriptRoot 'supervisor.json'
$sshExe = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$identityPath = 'C:\Users\Administrator\.ssh\aliyun_4798_tunnel_ed25519'
if (!(Test-Path -LiteralPath $identityPath)) { throw 'Configured voice tunnel identity is missing' }
[ordered]@{ pid=$PID; startedAt=(Get-Date).ToString('o'); remotePort=18787; localPort=8787 } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
$sshArguments = @('-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',$identityPath,'-R','127.0.0.1:18787:127.0.0.1:8787','root@47.98.197.156')
while ($true) {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 262144) {
        $tail = Get-Content -LiteralPath $logPath -Tail 100
        Set-Content -LiteralPath $logPath -Value $tail -Encoding utf8
    }
    Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' connect')
    & $sshExe @sshArguments >> $logPath 2>&1
    Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' exit=' + $LASTEXITCODE)
    Start-Sleep -Seconds 5
}
