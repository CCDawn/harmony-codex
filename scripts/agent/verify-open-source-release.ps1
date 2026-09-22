[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [switch]$SkipTests,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stageScript = Join-Path $PSScriptRoot 'create-open-source-staging.ps1'
$scanScript = Join-Path $PSScriptRoot 'scan-open-source.ps1'

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $OutputPath = Join-Path $desktop 'harmony-codex-open-source'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Script
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Script
}

function Assert-NoForbiddenFiles {
  param([string]$Root)

  $forbiddenExtensions = @('.hap', '.app', '.p12', '.p7b', '.cer', '.rdp', '.log', '.jsonl')
  $forbiddenNames = @('BridgeConfig.ets', 'RelayConfig.ets', 'bootstrap.js', 'preload.js')
  $forbiddenDirs = @('.git', 'node_modules')

  $findings = @()
  Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
    if ($_.PSIsContainer) {
      if ($forbiddenDirs -contains $_.Name) {
        $findings += $relative
      }
      return
    }

    if ($forbiddenExtensions -contains $_.Extension -or $forbiddenNames -contains $_.Name) {
      $findings += $relative
    }
  }

  if ($findings.Count -gt 0) {
    $findings | ForEach-Object { Write-Host "forbidden: $_" -ForegroundColor Red }
    throw "Open-source staging contains forbidden files."
  }
}

Invoke-Step -Name 'Create clean open-source staging' -Script {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stageScript -OutputPath $OutputPath -ForceClean | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "create-open-source-staging.ps1 failed with exit code $LASTEXITCODE"
  }
}

Invoke-Step -Name 'Run privacy scanner on staging' -Script {
  $stagedScanScript = Join-Path $OutputPath 'scripts\agent\scan-open-source.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stagedScanScript | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "scan-open-source.ps1 failed with exit code $LASTEXITCODE"
  }
}

Invoke-Step -Name 'Check forbidden file classes' -Script {
  Assert-NoForbiddenFiles -Root $OutputPath
  Write-Host "Forbidden file check passed." -ForegroundColor Green
}

if (-not $SkipTests) {
  Invoke-Step -Name 'Run tests in staging' -Script {
    Push-Location $OutputPath
    try {
      npm test
      if ($LASTEXITCODE -ne 0) {
        throw "npm test failed with exit code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  }
}

$summary = [pscustomobject]@{
  ok = $true
  source = $repoRoot
  output = $OutputPath
  tests = if ($SkipTests) { 'skipped' } else { 'passed' }
  generatedAt = (Get-Date).ToString('o')
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 6
} else {
  Write-Host ""
  Write-Host "Open-source release verification passed." -ForegroundColor Green
  Write-Host "Staging directory: $OutputPath" -ForegroundColor DarkGray
}
