[CmdletBinding()]
param([ValidateRange(2,120)][int]$IntervalSeconds=10, [switch]$Once)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
. (Join-Path $repo 'tools\windows\mobile-voice-tunnel.ps1')
do {
  $gate=Enter-MobileLinkCycle $repo
  if ($null -ne $gate) {
    try {
      Ensure-MobileVoiceTunnel $repo
    } catch {
      # Do not record raw task arguments, credentials, or authenticated URLs.
      Write-Output ([datetime]::UtcNow.ToString('o')+' voice-tunnel-check-failed type='+$_.Exception.GetType().Name)
    } finally { Exit-MobileLinkCycle $gate }
  }
  if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
