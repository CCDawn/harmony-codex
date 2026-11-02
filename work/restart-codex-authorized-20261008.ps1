$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools\windows\mobile-link-lifecycle.ps1')
$receiptPath=Join-Path $PSScriptRoot 'codex-authorized-restart-20261008.json'
$receipt=[ordered]@{Authorized=$true;StartedAt=[datetime]::UtcNow.ToString('o');Stage='scheduled';Completed=$false}
function Save-Receipt { $receipt|ConvertTo-Json -Depth 7|Set-Content -LiteralPath $receiptPath -Encoding utf8 }
Save-Receipt
Start-Sleep -Seconds 4
$gate=New-MobileLinkMutex $repo
$owns=$false
try {
  try { $owns=$gate.WaitOne(20000) } catch [Threading.AbandonedMutexException] { $owns=$true }
  if(-not $owns){throw 'Manager busy'}
  $all=@(Get-CimInstance Win32_Process)
  $protected=@(Get-MobileLinkOwnedProcesses $repo $all)
  $official=@($all|Where-Object{[string]$_.ExecutablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$|\\app\\Codex\.exe$'})
  $receipt.BeforeOfficial=@($official|Select-Object ProcessId,Name,CreationDate)
  $receipt.ProtectedProcessCount=$protected.Count
  $receipt.Stage='restarting'
  Save-Receipt
  $config=Get-Content -Raw -LiteralPath (Join-Path $repo 'HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets')
  $env:CODEX_BRIDGE_TOKEN=[regex]::Match($config,'DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*[''"]([^''"]+)[''"]').Groups[1].Value
  if(-not $env:CODEX_BRIDGE_TOKEN){throw 'Local authentication missing'}
  & (Join-Path $repo 'scripts\restart-codex-desktop-live.ps1') -BridgeUrl 'http://127.0.0.1:8787' -CdpPort 9229 *> (Join-Path $repo 'logs\startup\codex-authorized-restart-20261008.log')
  $receipt.Stage='verifying'
  Save-Receipt
  $gate.ReleaseMutex();$owns=$false
  Start-Sleep -Seconds 5
  $statusOutput=& (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $repo 'tools\windows\mobile-link-control.ps1') -Action Status
  $status=($statusOutput -join "`n")|ConvertFrom-Json
  $receipt.Diagnostics=$status.diagnostics
  $receipt.DesktopLive=$status.desktopLive
  $after=@(Get-CimInstance Win32_Process)
  $receipt.AfterOfficial=@($after|Where-Object{[string]$_.ExecutablePath -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$|\\app\\Codex\.exe$'}|Select-Object ProcessId,Name,CreationDate)
  $changed=@(foreach($expected in $protected){$current=@($after|Where-Object ProcessId -eq $expected.ProcessId);if($current.Count -ne 1 -or [datetime]$current[0].CreationDate -ne [datetime]$expected.CreationDate){[pscustomobject]@{Role=(Get-MobileLinkRole $expected);PID=[int]$expected.ProcessId}}})
  $receipt.ProtectedProcessesPreserved=($changed.Count -eq 0)
  $receipt.ChangedProtected=$changed
  $receipt.CdpListening=@(Get-NetTCPConnection -State Listen -LocalPort 9229 -ErrorAction SilentlyContinue).Count -gt 0
  $receipt.Completed=$true;$receipt.Stage='completed';$receipt.CompletedAt=[datetime]::UtcNow.ToString('o')
  Save-Receipt
} catch {
  $receipt.Stage='failed';$receipt.ErrorType=$_.Exception.GetType().Name;$receipt.ErrorLine=$_.InvocationInfo.ScriptLineNumber
  Save-Receipt
} finally {if($owns){$gate.ReleaseMutex()};$gate.Dispose()}
