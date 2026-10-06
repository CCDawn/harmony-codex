$shells = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $command = [string]$_.CommandLine
  $exePath = [string]$_.ExecutablePath
  $packaged = $exePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or $command -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe'
  $legacy = $exePath -match '\\app\\Codex\.exe$' -or $command -match '\\app\\Codex\.exe"?(?:\s|$)'
  ($packaged -or $legacy) -and $command -notmatch '\s--type='
})
if ($shells.Count -eq 0) {
  Write-Output 'missing'
  exit 0
}
$withCdp = @($shells | Where-Object { [string]$_.CommandLine -match 'remote-debugging-port' })
if ($withCdp.Count -eq 0) {
  Write-Output 'plain'
} else {
  Write-Output 'cdp'
}
