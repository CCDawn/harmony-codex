[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [switch]$ForceClean,
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $OutputPath = Join-Path $desktop 'harmony-codex-open-source'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

function Assert-SafeOutputPath {
  param([string]$Path)

  $desktop = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop'))
  if (-not $Path.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must be under Desktop for safety: $Path"
  }
  if ($Path -eq $repoRoot -or $repoRoot.StartsWith($Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must not contain the source repo: $Path"
  }
}

function Copy-File {
  param([string]$RelativePath)

  $source = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    return
  }
  $dest = Join-Path $OutputPath $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath $source -Destination $dest -Force
}

function Write-SanitizedHarmonyBuildProfile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $text = Get-Content -LiteralPath $Path -Raw
  $text = [regex]::Replace($text, '"certpath"\s*:\s*"[^"]*"', '"certpath": ""')
  $text = [regex]::Replace($text, '"keyPassword"\s*:\s*"[^"]*"', '"keyPassword": ""')
  $text = [regex]::Replace($text, '"profile"\s*:\s*"[^"]*"', '"profile": ""')
  $text = [regex]::Replace($text, '"storeFile"\s*:\s*"[^"]*"', '"storeFile": ""')
  $text = [regex]::Replace($text, '"storePassword"\s*:\s*"[^"]*"', '"storePassword": ""')
  Set-Content -LiteralPath $Path -Value $text -Encoding UTF8
}

function Remove-ForbiddenStagingResidue {
  $forbiddenDirs = @(
    '.git',
    '__pycache__',
    '.hvigor',
    '.idea',
    '.deveco',
    'build',
    'node_modules',
    'logs',
    'tmp',
    'artifacts',
    'bin',
    'diagnostics',
    'local-hvigor',
    'sdk-overlay',
    'sdk-shim-cli',
    'plans'
  )
  foreach ($dirName in $forbiddenDirs) {
    Get-ChildItem -LiteralPath $OutputPath -Recurse -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $dirName } |
      Sort-Object { $_.FullName.Length } -Descending |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }

  $forbiddenExtensions = @('.hap', '.p12', '.p7b', '.cer', '.log', '.jsonl', '.rdp', '.pyc', '.pyo')
  $forbiddenNames = @('BridgeConfig.ets', 'RelayConfig.ets', 'bootstrap.js', 'preload.js')
  Get-ChildItem -LiteralPath $OutputPath -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object {
      $forbiddenExtensions -contains $_.Extension -or
      $forbiddenNames -contains $_.Name -or
      $_.Name -like '*.local.psd1' -or
      $_.Name -like 'tmp-verify*.json'
    } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}

function Test-SkippedPath {
  param(
    [string]$RelativePath,
    [bool]$IsDirectory
  )

  $normalized = $RelativePath -replace '/', '\'
  $parts = $normalized -split '\\'
  $skipDirs = @(
    '.git',
    '__pycache__',
    '.hvigor',
    '.idea',
    '.deveco',
    'build',
    'node_modules',
    'logs',
    'tmp',
    'artifacts',
    'bin',
    'diagnostics',
    'local-hvigor',
    'sdk-overlay',
    'sdk-shim-cli',
    'plans'
  )
  foreach ($part in $parts) {
    if ($skipDirs -contains $part) {
      return $true
    }
  }

  if ($normalized -like '*\entry\build\*') {
    return $true
  }

  if ($IsDirectory) {
    return $false
  }

  $name = Split-Path -Leaf $normalized
  $extension = [System.IO.Path]::GetExtension($name)
  if (@('.hap', '.p12', '.p7b', '.cer', '.log', '.jsonl', '.rdp', '.pyc', '.pyo') -contains $extension) {
    return $true
  }
  if ($name -like '*.local.psd1') {
    return $true
  }
  if ($name -like 'tmp-verify*.json') {
    return $true
  }
  if ($name -in @('BridgeConfig.ets', 'RelayConfig.ets')) {
    return $true
  }
  return $false
}

function Copy-Tree {
  param([string]$RelativePath)

  $sourceRoot = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $sourceRoot)) {
    return
  }

  Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force | ForEach-Object {
    $fullName = [string]$_.FullName
    $relativeToRoot = $fullName.Substring($repoRoot.Length).TrimStart('\', '/')
    if (Test-SkippedPath -RelativePath $relativeToRoot -IsDirectory $_.PSIsContainer) {
      return
    }

    $dest = Join-Path $OutputPath $relativeToRoot
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
  }
}

Assert-SafeOutputPath -Path $OutputPath

if (Test-Path -LiteralPath $OutputPath) {
  if (-not $ForceClean) {
    throw "OutputPath already exists. Pass -ForceClean to replace it: $OutputPath"
  }
  Assert-SafeOutputPath -Path $OutputPath
  Remove-Item -LiteralPath $OutputPath -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null

foreach ($file in @(
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'package.json',
  'project.manifest.json',
  'deploy.manifest.json',
  'config.schema.json'
)) {
  Copy-File -RelativePath $file
}

foreach ($dir in @(
  'src',
  'voice',
  'scripts',
  'tools',
  'docs',
  'assets',
  'test',
  'HarmonyCodexRemote',
  'HarmonyHdcRelayHelper',
  '.github'
)) {
  Copy-Tree -RelativePath $dir
}

Remove-ForbiddenStagingResidue

Get-ChildItem -LiteralPath $OutputPath -Recurse -Force -File -Filter 'build-profile.json5' |
  ForEach-Object { Write-SanitizedHarmonyBuildProfile -Path $_.FullName }

$summary = [pscustomobject]@{
  ok = $true
  source = $repoRoot
  output = $OutputPath
  fileCount = @(Get-ChildItem -LiteralPath $OutputPath -Recurse -File -Force).Count
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 6
} else {
  Write-Host "Open-source staging created: $OutputPath" -ForegroundColor Green
  Write-Host "Files: $($summary.fileCount)" -ForegroundColor DarkGray
}
