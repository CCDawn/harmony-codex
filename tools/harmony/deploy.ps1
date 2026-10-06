[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$SkipInstall,
  [switch]$SkipLaunch,
  [switch]$StartBridge,
  [switch]$UseLanBridge,
  [switch]$RelayHostedByHelper,
  [string]$BridgeUrl = '',
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeTotpSecret = $env:CODEX_BRIDGE_TOTP_SECRET,
  [string[]]$DeviceId = @(),
  [string]$ConfigPath = '',
  [string]$ProjectPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Join-ProcessArguments {
  param([string[]]$Values)
  $parts = @()
  foreach ($value in $Values) {
    $text = [string]$value
    if ($text.Contains('"')) {
      $text = $text.Replace('"', '\"')
    }
    if ($text -match '\s|"') {
      $parts += ('"{0}"' -f $text)
    } else {
      $parts += $text
    }
  }
  return ($parts -join ' ')
}

function Sanitize-LogFilePart {
  param([string]$Value)
  $text = if ([string]::IsNullOrWhiteSpace($Value)) { 'unknown' } else { $Value }
  return ($text -replace '[^A-Za-z0-9._-]', '_')
}

function Resolve-RepoRoot {
  param([string]$ScriptRoot)
  return [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..'))
}

function Stop-HilogCaptureForDevice {
  param(
    [string]$HdcExe,
    [string]$DeviceId
  )

  $hdcName = [System.IO.Path]::GetFileName($HdcExe)
  try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = '$hdcName'" -ErrorAction SilentlyContinue)
    foreach ($proc in $processes) {
      $commandLine = [string]$proc.CommandLine
      if (
        $commandLine.IndexOf($DeviceId, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine.IndexOf('shell hilog', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      ) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
  }
}

function Remove-FileWithRetry {
  param([string]$Path)

  for ($i = 0; $i -lt 10; $i++) {
    try {
      if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
      }
      return
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
}

function Start-HilogCapture {
  param(
    [string]$HdcExe,
    [string]$DeviceId,
    [string]$RepoRoot
  )

  $logDir = Join-Path $RepoRoot 'logs\current-run'
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null

  $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $safeId = Sanitize-LogFilePart -Value $DeviceId
  $hilogLatestPath = Join-Path $logDir "device_${safeId}_hilog_latest.log"
  $hilogLatestErrPath = Join-Path $logDir "device_${safeId}_hilog_latest.stderr.log"
  $hilogPath = Join-Path $logDir "device_${safeId}_hilog_$timestamp.log"
  $hilogErrPath = Join-Path $logDir "device_${safeId}_hilog_$timestamp.stderr.log"

  Write-Step "启动设备 Hilog 自动采集 [$DeviceId]"
  Stop-HilogCaptureForDevice -HdcExe $HdcExe -DeviceId $DeviceId
  Start-Sleep -Milliseconds 500

  Remove-FileWithRetry -Path $hilogLatestPath
  Remove-FileWithRetry -Path $hilogLatestErrPath
  Remove-FileWithRetry -Path $hilogPath
  Remove-FileWithRetry -Path $hilogErrPath

  $proc = Start-Process -FilePath $HdcExe `
    -ArgumentList @('-t', $DeviceId, 'shell', 'hilog') `
    -WorkingDirectory $logDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $hilogLatestPath `
    -RedirectStandardError $hilogLatestErrPath `
    -PassThru

  Start-Sleep -Milliseconds 500
  if ((Test-Path -LiteralPath $hilogLatestPath) -and -not (Test-Path -LiteralPath $hilogPath)) {
    cmd /c mklink /H "$hilogPath" "$hilogLatestPath" | Out-Null
  }
  if ((Test-Path -LiteralPath $hilogLatestErrPath) -and -not (Test-Path -LiteralPath $hilogErrPath)) {
    cmd /c mklink /H "$hilogErrPath" "$hilogLatestErrPath" | Out-Null
  }

  $pidFile = Join-Path $logDir "device_${safeId}_hilog.pid"
  Set-Content -LiteralPath $pidFile -Value ([string]$proc.Id) -Encoding UTF8
  Write-Info "Hilog PID=$($proc.Id)"
  Write-Info "Hilog: $hilogLatestPath"
}

function Test-IsRelayHdcDevice {
  param([string]$DeviceId)

  return $DeviceId -match '^(127\.0\.0\.1|localhost|\[::1\]|::1):\d+$'
}

function Split-RelayHdcDevice {
  param([string]$DeviceId)

  if ($DeviceId -match '^\[::1\]:(\d+)$') {
    return @{ Host = '::1'; Port = [int]$Matches[1] }
  }
  if ($DeviceId -match '^(127\.0\.0\.1|localhost|::1):(\d+)$') {
    return @{ Host = [string]$Matches[1]; Port = [int]$Matches[2] }
  }
  return @{ Host = ''; Port = 0 }
}

function Resolve-HdcRelayConfigPath {
  $candidate = Join-Path $scriptRoot 'hdc-relay.local.psd1'
  if (Test-Path -LiteralPath $candidate) {
    return $candidate
  }
  return ''
}

function Test-LocalProxyListening {
  param([string]$DeviceId)

  $endpoint = Split-RelayHdcDevice -DeviceId $DeviceId
  if ([int]$endpoint.Port -le 0) {
    return $false
  }

  try {
    $listeners = @(Get-NetTCPConnection -LocalPort ([int]$endpoint.Port) -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $address = [string]$listener.LocalAddress
      if (
        $address -eq [string]$endpoint.Host -or
        $address -eq '0.0.0.0' -or
        $address -eq '::' -or
        (([string]$endpoint.Host -eq '127.0.0.1' -or [string]$endpoint.Host -eq 'localhost') -and ($address -eq '127.0.0.1' -or $address -eq 'localhost' -or $address -eq '::1')) -or
        ([string]$endpoint.Host -eq '::1' -and ($address -eq '::1' -or $address -eq '::'))
      ) {
        return $true
      }
    }
  } catch {
  }
  return $false
}

function Wait-LocalProxyListening {
  param(
    [string]$DeviceId,
    [int]$TimeoutSeconds = 12
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalProxyListening -DeviceId $DeviceId) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return (Test-LocalProxyListening -DeviceId $DeviceId)
}

function Stop-LocalProxyProcesses {
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
      $commandLine = [string]$_.CommandLine
      $_.ProcessId -ne $PID -and
      -not [string]::IsNullOrWhiteSpace($commandLine) -and
      (
        $commandLine -match 'scripts[\\/]hdc-relay[\\/]start-local-proxy\.mjs' -or
        $commandLine -match 'start-local-proxy\.mjs' -or
        ($commandLine -match 'start-hdc-relay\.ps1' -and $commandLine -match '\bProxy\b')
      )
    })
  foreach ($process in $processes) {
    Write-Info "停止旧 HDC proxy PID=$($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Restart-LocalProxy {
  param([string]$DeviceId)

  $relayConfigPath = Resolve-HdcRelayConfigPath
  $relayScript = Join-Path $scriptRoot 'start-hdc-relay.ps1'
  if ([string]::IsNullOrWhiteSpace($relayConfigPath) -or -not (Test-Path -LiteralPath $relayScript)) {
    Write-Info "无法自动启动 HDC proxy：缺少 hdc-relay.local.psd1 或 start-hdc-relay.ps1"
    return $false
  }

  $logRoot = Join-Path $repoRoot 'logs\startup'
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Stop-LocalProxyProcesses
  Start-Sleep -Seconds 1

  $stdout = Join-Path $logRoot 'hdc-proxy-deploy.stdout.log'
  $stderr = Join-Path $logRoot 'hdc-proxy-deploy.stderr.log'
  Write-Info "启动 HDC proxy: $relayConfigPath"
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $relayScript,
      '-Mode', 'Proxy',
      '-ConfigPath', $relayConfigPath
    ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-Info "HDC proxy PID=$($proc.Id)"
  if (Wait-LocalProxyListening -DeviceId $DeviceId -TimeoutSeconds 12) {
    return $true
  }
  Write-Info "HDC proxy 未监听 $DeviceId，查看: $stderr"
  return $false
}

function Ensure-LocalProxyListening {
  param([string]$DeviceId)

  if (-not (Test-IsRelayHdcDevice -DeviceId $DeviceId)) {
    return $true
  }
  if (Test-LocalProxyListening -DeviceId $DeviceId) {
    return $true
  }
  return (Restart-LocalProxy -DeviceId $DeviceId)
}

function Stop-ProjectHilogCaptures {
  param([string]$RepoRoot)

  $logDir = Join-Path $RepoRoot 'logs\current-run'
  if (-not (Test-Path -LiteralPath $logDir)) {
    return
  }

  Get-ChildItem -File -LiteralPath $logDir -Filter 'device_*_hilog.pid' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $processIdText = (Get-Content -LiteralPath $_.FullName -Raw).Trim()
      if ($processIdText -match '^\d+$') {
        Stop-Process -Id ([int]$processIdText) -Force -ErrorAction SilentlyContinue
      }
    } catch {
    }
  }
  Start-Sleep -Milliseconds 500
}

function Show-LogSummary {
  param([string]$BridgeUrl)

  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    return
  }

  try {
    $uri = [Uri]$BridgeUrl
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 8787 }
    $summaryResponse = Invoke-RestMethod -Uri "http://127.0.0.1:$port/logs/summary" -TimeoutSec 5
    $summary = $summaryResponse.summary
    Write-Step "日志自动诊断摘要"
    Write-Host "Health: $($summary.health.status) - $($summary.health.reason)" -ForegroundColor Green
    Write-Host "Entries: $($summary.totals.entries)" -ForegroundColor DarkGray
    Write-Host "Summary: $(Join-Path $repoRoot 'logs\current-run\summary.md')" -ForegroundColor DarkGray
  } catch {
    Write-Info "暂时无法生成日志摘要: $($_.Exception.Message)"
  }
}

function Resolve-ProjectRoot {
  param([string]$RepoRoot)
  return Join-Path $RepoRoot 'HarmonyCodexRemote'
}

function Resolve-HarmonyProjectRoot {
  param(
    [string]$RepoRoot,
    [string]$ProjectPath
  )
  if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    return Resolve-ProjectRoot -RepoRoot $RepoRoot
  }
  if ([System.IO.Path]::IsPathRooted($ProjectPath)) {
    return [System.IO.Path]::GetFullPath($ProjectPath)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $ProjectPath))
}

function Load-Config {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "配置文件不存在: $Path"
  }
  return Import-PowerShellDataFile -LiteralPath $Path
}

function Test-ExistingPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  try {
    return Test-Path -LiteralPath $Path
  } catch {
    return $false
  }
}

function Join-ExistingPath {
  param(
    [string]$Path,
    [string]$ChildPath
  )
  if (-not (Test-ExistingPath -Path $Path)) {
    return ''
  }
  return Join-Path $Path $ChildPath
}

function Resolve-DevEcoSdkSourceRoot {
  param(
    [hashtable]$Config,
    [string]$ProjectRoot
  )

  $candidates = @()
  if ($Config.ContainsKey('DevEcoSdkHome') -and -not [string]::IsNullOrWhiteSpace([string]$Config.DevEcoSdkHome)) {
    $candidates += [string]$Config.DevEcoSdkHome
  }
  $localProperties = Join-Path $ProjectRoot 'local.properties'
  if (Test-Path -LiteralPath $localProperties) {
    $line = Get-Content -LiteralPath $localProperties | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
    if ($line) {
      $candidates += ($line -replace '^sdk\.dir=', '')
    }
  }
  $candidates += @(
    'D:\DevEco Studio\sdk\default',
    'D:\DevEco Studio\sdk',
    'C:\Program Files\DevEco Studio\sdk\default',
    'C:\Program Files\Huawei\DevEco Studio\sdk\default',
    'C:\Program Files\Huawei\DevEco Studio Next\sdk\default'
  )

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    try {
      $fullPath = [System.IO.Path]::GetFullPath($candidate)
    } catch {
      continue
    }
    if (-not (Test-ExistingPath -Path $fullPath)) {
      continue
    }
    $defaultPath = Join-Path $fullPath 'default'
    if (Test-ExistingPath -Path (Join-Path $defaultPath 'sdk-pkg.json')) {
      $fullPath = $defaultPath
    }
    if (
      (Test-ExistingPath -Path $fullPath) -and
      (Test-ExistingPath -Path (Join-Path $fullPath 'sdk-pkg.json')) -and
      (Test-ExistingPath -Path (Join-Path $fullPath 'openharmony')) -and
      (Test-ExistingPath -Path (Join-Path $fullPath 'hms'))
    ) {
      return $fullPath
    }
  }

  return ''
}

function Resolve-DevEcoJavaHome {
  $candidates = @(
    'D:\DevEco Studio\jbr',
    'C:\Program Files\DevEco Studio\jbr',
    'C:\Program Files\Huawei\DevEco Studio\jbr',
    'C:\Program Files\Huawei\DevEco Studio Next\jbr'
  )
  foreach ($candidate in $candidates) {
    $javaExe = Join-ExistingPath -Path $candidate -ChildPath 'bin\java.exe'
    if ($javaExe -and (Test-ExistingPath -Path $javaExe)) {
      return $candidate
    }
  }
  return ''
}

function Find-DevEcoNodeExe {
  $candidates = @(
    'D:\DevEco Studio\tools\node\node.exe',
    'C:\Program Files\DevEco Studio\tools\node\node.exe',
    'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe',
    'C:\Program Files\Huawei\DevEco Studio Next\tools\node\node.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-ExistingPath -Path $candidate) {
      return $candidate
    }
  }
  return ''
}

function Find-DevEcoHvigorJs {
  $candidates = @(
    (Join-Path $script:ScriptRoot 'local-hvigor\bin\hvigorw.js'),
    'D:\DevEco Studio\tools\hvigor\bin\hvigorw.js',
    'C:\Program Files\DevEco Studio\tools\hvigor\bin\hvigorw.js',
    'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js',
    'C:\Program Files\Huawei\DevEco Studio Next\tools\hvigor\bin\hvigorw.js'
  )
  foreach ($candidate in $candidates) {
    if (Test-ExistingPath -Path $candidate) {
      return $candidate
    }
  }
  return ''
}

function Set-JunctionTarget {
  param(
    [string]$LinkPath,
    [string]$TargetPath,
    [string]$ProbeRelativePath = ''
  )

  $desiredTarget = [System.IO.Path]::GetFullPath($TargetPath)
  if (-not (Test-Path -LiteralPath $desiredTarget)) {
    throw "链接目标不存在: $desiredTarget"
  }

  $needsLink = $true
  $existing = Get-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      $currentTarget = ''
      $existingTargets = @($existing.Target)
      if ($existingTargets.Count -gt 0) {
        $currentTarget = [System.IO.Path]::GetFullPath([string]$existingTargets[0])
      }
      $probeOk = $true
      if (-not [string]::IsNullOrWhiteSpace($ProbeRelativePath)) {
        $probeOk = Test-Path -LiteralPath (Join-Path $LinkPath $ProbeRelativePath)
      }
      $needsLink = (
        [string]::IsNullOrWhiteSpace($currentTarget) -or
        -not $currentTarget.Equals($desiredTarget, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $probeOk
      )
    } else {
      throw "已有非链接路径，不能自动替换: $LinkPath"
    }

      if ($needsLink) {
        Write-Info "修复链接: $LinkPath -> $desiredTarget"
        [System.IO.Directory]::Delete($LinkPath, $false)
      }
    }

  if ($needsLink) {
    New-Item -ItemType Junction -Path $LinkPath -Target $desiredTarget | Out-Null
  }
}

function Resolve-FastBuildFallbackRoot {
  param([string]$ScriptRoot)

  $candidates = @(
    (Join-Path $ScriptRoot 'sdk-fast-build-fallback\fast_build'),
    'C:\openHarmony\20\ets\build-tools\ets-loader\lib\fast_build'
  )

  foreach ($candidate in $candidates) {
    $probe = Join-Path $candidate 'common\init_config.js'
    if (Test-Path -LiteralPath $probe) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  return ''
}

function Ensure-OpenHarmonyOverlay {
  param(
    [string]$ScriptRoot,
    [string]$SourceOpenHarmonyRoot
  )

  $sourceEtsRoot = Join-Path $SourceOpenHarmonyRoot 'ets'
  $sourceMetaPath = Join-Path $sourceEtsRoot 'oh-uni-package.json'
  if (-not (Test-Path -LiteralPath $sourceMetaPath)) {
    throw "OpenHarmony ETS 组件不存在: $sourceEtsRoot"
  }

  $fallbackFastBuild = Resolve-FastBuildFallbackRoot -ScriptRoot $ScriptRoot
  if ([string]::IsNullOrWhiteSpace($fallbackFastBuild)) {
    throw "ArkTS fast_build 缺失，且未找到可用 fallback。请在 DevEco SDK Manager 中重新安装 HarmonyOS/OpenHarmony ETS 组件。"
  }

  $overlayRoot = Join-Path $ScriptRoot 'sdk-overlay\openharmony'
  $overlayEtsRoot = Join-Path $overlayRoot 'ets'
  $overlayMetaPath = Join-Path $overlayEtsRoot 'oh-uni-package.json'
  $overlayProbe = Join-Path $overlayEtsRoot 'build-tools\ets-loader\lib\fast_build\common\init_config.js'
  $sourceMeta = Get-Content -LiteralPath $sourceMetaPath -Raw
  $overlayMeta = ''
  if (Test-Path -LiteralPath $overlayMetaPath) {
    $overlayMeta = Get-Content -LiteralPath $overlayMetaPath -Raw
  }

  if ((-not (Test-Path -LiteralPath $overlayProbe)) -or ($overlayMeta -ne $sourceMeta)) {
    Write-Info "构建 OpenHarmony ETS overlay，补齐 ArkTS fast_build。"
    if (Test-Path -LiteralPath $overlayEtsRoot) {
      Remove-Item -LiteralPath $overlayEtsRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $overlayRoot -Force | Out-Null
    Copy-Item -LiteralPath $sourceEtsRoot -Destination $overlayEtsRoot -Recurse -Force

    $overlayFastBuild = Join-Path $overlayEtsRoot 'build-tools\ets-loader\lib\fast_build'
    if (Test-Path -LiteralPath $overlayFastBuild) {
      Remove-Item -LiteralPath $overlayFastBuild -Recurse -Force
    }
    Copy-Item -LiteralPath $fallbackFastBuild -Destination $overlayFastBuild -Recurse -Force
  }

  foreach ($component in @('js', 'native', 'previewer', 'toolchains')) {
    $target = Join-Path $SourceOpenHarmonyRoot $component
    if (Test-Path -LiteralPath $target) {
      Set-JunctionTarget -LinkPath (Join-Path $overlayRoot $component) -TargetPath $target -ProbeRelativePath 'oh-uni-package.json'
    }
  }

  return [System.IO.Path]::GetFullPath($overlayRoot)
}

function Ensure-HvigorSdkShim {
  param(
    [string]$ScriptRoot,
    [string]$SourceSdkRoot
  )

  if ([string]::IsNullOrWhiteSpace($SourceSdkRoot)) {
    return ''
  }

  $sourceMetaPath = Join-Path $SourceSdkRoot 'sdk-pkg.json'
  if (-not (Test-Path -LiteralPath $sourceMetaPath)) {
    return ''
  }

  $sourceMeta = Get-Content -LiteralPath $sourceMetaPath -Raw | ConvertFrom-Json
  $sdkPathName = [string]$sourceMeta.data.path
  if ([string]::IsNullOrWhiteSpace($sdkPathName)) {
    return ''
  }

  $shimRoot = Join-Path $ScriptRoot 'sdk-shim-cli'
  $shimSdkRoot = Join-Path $shimRoot $sdkPathName
  if (-not (Test-Path -LiteralPath $shimSdkRoot)) {
    New-Item -ItemType Directory -Path $shimSdkRoot -Force | Out-Null
  }

  $shimMetaPath = Join-Path $shimSdkRoot 'sdk-pkg.json'
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $sourceMeta | ConvertTo-Json -Depth 10 | ForEach-Object {
    [System.IO.File]::WriteAllText($shimMetaPath, $_, $utf8NoBom)
  }

  $openHarmonyTarget = Join-Path $SourceSdkRoot 'openharmony'
  $arkTsFastBuildProbe = Join-Path $openHarmonyTarget 'ets\build-tools\ets-loader\lib\fast_build\common\init_config.js'
  if (-not (Test-Path -LiteralPath $arkTsFastBuildProbe)) {
    $openHarmonyTarget = Ensure-OpenHarmonyOverlay -ScriptRoot $ScriptRoot -SourceOpenHarmonyRoot $openHarmonyTarget
  }

  $linkPairs = @(
    @{ Name = 'openharmony'; Target = $openHarmonyTarget; Probe = 'toolchains\oh-uni-package.json' },
    @{ Name = 'hms'; Target = (Join-Path $SourceSdkRoot 'hms'); Probe = 'toolchains\uni-package.json' }
  )
  foreach ($pair in $linkPairs) {
    $linkPath = Join-Path $shimSdkRoot $pair.Name
    Set-JunctionTarget -LinkPath $linkPath -TargetPath ([string]$pair.Target) -ProbeRelativePath ([string]$pair.Probe)
  }

  return $shimRoot
}

function Ensure-HvigorNodeModules {
  param([string]$ProjectRoot)

  $target = Join-Path $ProjectRoot 'node_modules'
  $devEcoHvigorRoot = ''
  $candidates = @(
    (Join-Path $script:ScriptRoot 'local-hvigor'),
    'D:\DevEco Studio\tools\hvigor',
    'C:\Program Files\DevEco Studio\tools\hvigor',
    'C:\Program Files\Huawei\DevEco Studio\tools\hvigor',
    'C:\Program Files\Huawei\DevEco Studio Next\tools\hvigor'
  )
  foreach ($candidate in $candidates) {
    if (-not (Test-ExistingPath -Path $candidate)) {
      continue
    }
    if (
      (Test-ExistingPath -Path (Join-Path $candidate 'hvigor')) -and
      (Test-ExistingPath -Path (Join-Path $candidate 'hvigor-ohos-plugin'))
    ) {
      $devEcoHvigorRoot = $candidate
      break
    }
  }

  if ($devEcoHvigorRoot.Length -eq 0) {
    Write-Info "未找到 DevEco hvigor 依赖目录，若构建失败请在 DevEco Studio 中 Sync Project。"
    return
  }

  $ohosDir = Join-Path $target '@ohos'
  New-Item -ItemType Directory -Path $ohosDir -Force | Out-Null
  $links = @(
    @{ Name = 'hvigor'; Target = (Join-Path $devEcoHvigorRoot 'hvigor') },
    @{ Name = 'hvigor-ohos-plugin'; Target = (Join-Path $devEcoHvigorRoot 'hvigor-ohos-plugin') }
  )
  foreach ($link in $links) {
    $linkPath = Join-Path $ohosDir $link.Name
    $desiredTarget = [System.IO.Path]::GetFullPath([string]$link.Target)
    $needsLink = $true
    if (Test-Path -LiteralPath $linkPath) {
      $existing = Get-Item -LiteralPath $linkPath -Force
      if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $existing.Target) {
        $currentTarget = [System.IO.Path]::GetFullPath([string]$existing.Target[0])
        $needsLink = -not $currentTarget.Equals($desiredTarget, [System.StringComparison]::OrdinalIgnoreCase)
      }
      if ($needsLink) {
        if (-not ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
          throw "node_modules 中已有非链接路径，不能自动替换: $linkPath"
        }
        Remove-Item -LiteralPath $linkPath -Force
      }
    }
    if ($needsLink) {
      Write-Info "链接 hvigor 依赖: $linkPath -> $desiredTarget"
      New-Item -ItemType Junction -Path $linkPath -Target $desiredTarget | Out-Null
    }
  }
}

function Find-HdcPath {
  param(
    [hashtable]$Config,
    [string]$RepoRoot
  )

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Config.ContainsKey('HdcPath') -and -not [string]::IsNullOrWhiteSpace([string]$Config.HdcPath)) {
    $candidates.Add([string]$Config.HdcPath)
  }
  if ($env:HDC_PATH) {
    $candidates.Add($env:HDC_PATH)
  }
  $cmd = Get-Command hdc -ErrorAction SilentlyContinue
  if ($cmd) {
    $candidates.Add($cmd.Source)
  }
  $candidates.Add('C:\openHarmony\20\toolchains\hdc.exe')
  $candidates.Add('D:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe')
  $candidates.Add('C:\Program Files\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe')
  $candidates.Add('C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe')

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-ExistingPath -Path $candidate)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  throw "未找到 hdc.exe。请把 hdc 加入 PATH，或在配置中填写 HdcPath。"
}

function Get-OnlineTargets {
  param([string]$HdcExe)
  $raw = & $HdcExe list targets 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "执行 hdc list targets 失败:`n$raw"
  }
  return @($raw | Where-Object { $_ -and $_ -notmatch 'Empty' } | ForEach-Object { ($_ -split '\s+')[0] })
}

function Invoke-Hdc {
  param(
    [string]$HdcExe,
    [string[]]$HdcArgs,
    [int]$TimeoutSeconds = 120
  )
  Write-Info ("执行: {0} {1}" -f $HdcExe, ($HdcArgs -join ' '))
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $HdcExe
  $startInfo.Arguments = Join-ProcessArguments -Values $HdcArgs
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "执行 hdc 超时（${TimeoutSeconds}s）: $($HdcArgs -join ' ')"
  }
  $output = @($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd()) -join "`n"
  return @{ ExitCode = $process.ExitCode; Output = $output }
}

function Test-HdcOutputFailed {
  param([string]$Output)
  return $Output -match '(?i)(\[Fail\]|failed|failure|error|exception|E\d{6})'
}

function Test-HdcLaunchBlockedByLockedScreen {
  param([string]$Output)
  return $Output -match '(?i)(10106102|device screen is locked|screen is locked|unlock screen failed)'
}

function Wait-HdcTargetReady {
  param(
    [string]$HdcExe,
    [string]$DeviceId,
    [int]$TimeoutSeconds = 90
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $failedTconnCount = 0
  while ((Get-Date) -lt $deadline) {
    try {
      if (Test-IsRelayHdcDevice -DeviceId $DeviceId) {
        Ensure-LocalProxyListening -DeviceId $DeviceId | Out-Null
        $verboseTargets = @(& $HdcExe list targets -v 2>&1)
        if (($verboseTargets -join "`n") -match ([Regex]::Escape($DeviceId) + '.*\bOffline\b')) {
          & $HdcExe kill -r 2>&1 | Out-Null
          Start-Sleep -Seconds 1
        }
        $tconnOutput = @(& $HdcExe tconn $DeviceId 2>&1)
        if (($tconnOutput -join "`n") -match 'Connect OK|Target is connected') {
          $failedTconnCount = 0
        } else {
          $failedTconnCount += 1
          if ($failedTconnCount -ge 3) {
            & $HdcExe kill -r 2>&1 | Out-Null
            $failedTconnCount = 0
            Start-Sleep -Seconds 1
          }
        }
      }
      $targets = @(Get-OnlineTargets -HdcExe $HdcExe)
      if (($targets -join "`n") -match [Regex]::Escape($DeviceId)) {
        $probe = Invoke-Hdc -HdcExe $HdcExe -HdcArgs @('-t', $DeviceId, 'shell', 'echo', 'relay-ready') -TimeoutSeconds 15
        if ($probe.ExitCode -eq 0 -and -not (Test-HdcOutputFailed -Output $probe.Output) -and $probe.Output -match 'relay-ready') {
          return
        }
      }
    } catch {
    }
    Start-Sleep -Seconds 2
  }
  throw "等待 HDC 目标恢复超时: $DeviceId"
}

function Invoke-Build {
  param(
    [hashtable]$Config,
    [string]$ProjectRoot,
    [string]$ScriptRoot
  )

  Ensure-HvigorNodeModules -ProjectRoot $ProjectRoot
  $sdkSourceRoot = Resolve-DevEcoSdkSourceRoot -Config $Config -ProjectRoot $ProjectRoot
  $sdkHome = Ensure-HvigorSdkShim -ScriptRoot $ScriptRoot -SourceSdkRoot $sdkSourceRoot
  if ($sdkHome.Length -eq 0) {
    $sdkHome = $sdkSourceRoot
  }
  if ($sdkHome.Length -gt 0) {
    $env:DEVECO_SDK_HOME = $sdkHome
    $env:OHOS_BASE_SDK_HOME = $sdkHome
    Write-Info "使用 SDK: $sdkHome"
  }
  $javaHome = Resolve-DevEcoJavaHome
  if ($javaHome.Length -gt 0) {
    $env:JAVA_HOME = $javaHome
    $env:JDK_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"
    Write-Info "使用 Java: $javaHome"
  }

  $moduleName = [string]$Config.ModuleName
  $productName = [string]$Config.ProductName
  $buildTask = [string]$Config.BuildTask
  $devEcoNode = Find-DevEcoNodeExe
  $devEcoHvigor = Find-DevEcoHvigorJs
  if ($devEcoNode.Length -eq 0 -or $devEcoHvigor.Length -eq 0) {
    throw "未找到 DevEco node/hvigor，请确认 DevEco Studio 已安装。"
  }

  Write-Step "开始构建 HAP"
  Push-Location $ProjectRoot
  try {
    $args = @('--mode', 'module', '-p', "module=$moduleName@default", '-p', "product=$productName", '-p', 'requiredDeviceType=phone', $buildTask, '--analyze=normal', '--parallel', '--incremental', '--daemon')
    & $devEcoNode $devEcoHvigor @args
    if ($LASTEXITCODE -ne 0) {
      throw "hvigor 构建失败，退出码: $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Set-BridgeUrl {
  param(
    [string]$ProjectRoot,
    [string]$BridgeUrl,
    [string]$BridgeToken,
    [string]$BridgeTotpSecret,
    [switch]$RelayHostedByHelper,
    [string]$BundleName = ''
  )

  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    return
  }

  $configPath = Join-Path $ProjectRoot 'entry\src\main\ets\config\BridgeConfig.ets'
  $escaped = $BridgeUrl.Trim().Replace('\', '\\').Replace("'", "\'")
  $bridgeTokenValue = if ([string]::IsNullOrWhiteSpace($BridgeToken)) { [string]$env:CODEX_BRIDGE_TOKEN } else { $BridgeToken }
  if ([string]::IsNullOrWhiteSpace($bridgeTokenValue) -and (Test-Path -LiteralPath $configPath)) {
    $tokenConfigText = Get-Content -Raw -LiteralPath $configPath
    $tokenMatch = [regex]::Match($tokenConfigText, "DEFAULT_BRIDGE_TOKEN:\s*string\s*=\s*'([^']*)'")
    if ($tokenMatch.Success) {
      $bridgeTokenValue = $tokenMatch.Groups[1].Value
    }
  }
  $escapedBridgeToken = $bridgeTokenValue.Trim().Replace('\', '\\').Replace("'", "\'")
  $bridgeTotpSecretValue = if ([string]::IsNullOrWhiteSpace($BridgeTotpSecret)) { [string]$env:CODEX_BRIDGE_TOTP_SECRET } else { $BridgeTotpSecret }
  if ([string]::IsNullOrWhiteSpace($bridgeTotpSecretValue) -and (Test-Path -LiteralPath $configPath)) {
    $configText = Get-Content -Raw -LiteralPath $configPath
    $totpMatch = [regex]::Match($configText, "DEFAULT_BRIDGE_TOTP_SECRET:\s*string\s*=\s*'([^']*)'")
    if ($totpMatch.Success) {
      $bridgeTotpSecretValue = $totpMatch.Groups[1].Value
    }
  }
  $escapedBridgeTotpSecret = $bridgeTotpSecretValue.Trim().Replace('\', '\\').Replace("'", "\'")
  $repoRootForProject = Split-Path -Parent $ProjectRoot
  $relayConfigPath = Join-Path $repoRootForProject 'tools\harmony\hdc-relay.local.psd1'
  $relayConfig = @{}
  if (Test-Path -LiteralPath $relayConfigPath) {
    $relayConfig = Import-PowerShellDataFile -LiteralPath $relayConfigPath
  }
  function Read-RelayConfigValue([string]$Name, [string]$DefaultValue) {
    if ($relayConfig.ContainsKey($Name) -and $null -ne $relayConfig[$Name]) {
      return [string]$relayConfig[$Name]
    }
    return $DefaultValue
  }
  function Escape-ArkString([string]$Value) {
    return $Value.Replace('\', '\\').Replace("'", "\'")
  }
  $relayHost = Escape-ArkString (Read-RelayConfigValue 'RelayHost' '')
  $relayPort = Escape-ArkString (Read-RelayConfigValue 'RelayPort' '19078')
  $deviceIdValue = Escape-ArkString (Read-RelayConfigValue 'DeviceId' 'default')
  $token = Escape-ArkString (Read-RelayConfigValue 'Token' '')
  $hdcdHost = Escape-ArkString (Read-RelayConfigValue 'HdcdHost' '127.0.0.1')
  $hdcdPort = Escape-ArkString (Read-RelayConfigValue 'HdcdPort' '10178')
  $embeddedRelayEnabled = if ($RelayHostedByHelper -and $BundleName -ne 'com.codex.remote.hdc.helper') { 'false' } else { 'true' }
  $content = @"
export const DEFAULT_BRIDGE_URL: string = '$escaped';
export const DEFAULT_BRIDGE_TOKEN: string = '$escapedBridgeToken';
export const DEFAULT_BRIDGE_TOTP_SECRET: string = '$escapedBridgeTotpSecret';
export const DEFAULT_RELAY_HOST: string = '$relayHost';
export const DEFAULT_RELAY_PORT: string = '$relayPort';
export const DEFAULT_DEVICE_ID: string = '$deviceIdValue';
export const DEFAULT_RELAY_TOKEN: string = '$token';
export const DEFAULT_HDCD_HOST: string = '$hdcdHost';
export const DEFAULT_HDCD_PORT: string = '$hdcdPort';
export const DEFAULT_EMBEDDED_RELAY_ENABLED: boolean = $embeddedRelayEnabled;
"@
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($configPath, $content, $utf8NoBom)
  Write-Info "已写入默认 Bridge URL: $BridgeUrl"
  if ($bridgeTokenValue.Trim().Length -gt 0) {
    Write-Info "已写入默认 Bridge Token: [REDACTED]"
  }
  if ($bridgeTotpSecretValue.Trim().Length -gt 0) {
    Write-Info "已写入默认 Bridge TOTP Secret: [REDACTED]"
  }
  if (Test-Path -LiteralPath $relayConfigPath) {
    Write-Info "已写入 HDC Relay 配置: $relayConfigPath; embeddedRelay=$embeddedRelayEnabled"
  }
}

function Start-LocalBridge {
  param(
    [string]$RepoRoot,
    [string]$BridgeUrl
  )

  $uri = [Uri]$BridgeUrl
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 8787 }
  Stop-ProjectHilogCaptures -RepoRoot $RepoRoot
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1

  $processLogDir = Join-Path $RepoRoot 'logs\bridge-process'
  New-Item -ItemType Directory -Path $processLogDir -Force | Out-Null
  $stdoutPath = Join-Path $processLogDir 'latest.stdout.log'
  $stderrPath = Join-Path $processLogDir 'latest.stderr.log'
  Remove-FileWithRetry -Path $stdoutPath
  Remove-FileWithRetry -Path $stderrPath

  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'scripts\start-bridge-lan.ps1'), '-Port', [string]$port, '-Workspace', $RepoRoot, '-Adapter', 'codex') `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru | Out-Null

  $health = $null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      break
    } catch {
    }
  }

  if ($null -eq $health) {
    $stderr = ''
    if (Test-Path -LiteralPath $stderrPath) {
      $stderr = Get-Content -LiteralPath $stderrPath -Raw
    }
    throw "Bridge 启动后健康检查失败。stdout=$stdoutPath stderr=$stderrPath`n$stderr"
  }
  Write-Info "Bridge 已启动: run=$($health.run.runId)"
}

function Convert-ToUsbBridgeUrl {
  param([string]$BridgeUrl)

  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    return $BridgeUrl
  }

  $uri = [Uri]$BridgeUrl
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 8787 }
  return "http://127.0.0.1:$port"
}

function Enable-UsbReversePort {
  param(
    [string]$HdcExe,
    [string]$DeviceId,
    [string]$BridgeUrl
  )

  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    return
  }

  $uri = [Uri]$BridgeUrl
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 8787 }
  Write-Step "启用 USB Bridge 反向端口 [$DeviceId]"

  $existing = & $HdcExe -t $DeviceId fport ls 2>&1
  if (($existing -join "`n") -match "tcp:$port\s+tcp:$port" -and ($existing -join "`n") -match '\[Reverse\]') {
    Write-Info "USB Bridge 反向端口已存在: tcp:$port -> tcp:$port"
    return
  }

  $result = Invoke-Hdc -HdcExe $HdcExe -HdcArgs @('-t', $DeviceId, 'rport', "tcp:$port", "tcp:$port") -TimeoutSeconds 30
  $result.Output | ForEach-Object { Write-Host $_ }
  if ($result.ExitCode -ne 0 -or (Test-HdcOutputFailed -Output $result.Output)) {
    $after = & $HdcExe -t $DeviceId fport ls 2>&1
    if (($after -join "`n") -match "tcp:$port\s+tcp:$port" -and ($after -join "`n") -match '\[Reverse\]') {
      Write-Info "USB Bridge 反向端口已存在: tcp:$port -> tcp:$port"
      return
    }
    throw "USB Bridge 反向端口失败: $DeviceId"
  }
  Write-Info "手机访问 http://127.0.0.1:$port 会转发到电脑 bridge。"
}

function Stop-RunningAppIfPresent {
  param(
    [hashtable]$Config,
    [string]$RepoRoot
  )

  try {
    $hdcExe = Find-HdcPath -Config $Config -RepoRoot $RepoRoot
    $onlineTargets = @(Get-OnlineTargets -HdcExe $hdcExe)
    if ($onlineTargets.Count -eq 0) {
      return
    }
    $devices = Resolve-Devices -Config $Config -OnlineTargets $onlineTargets
    foreach ($deviceId in $devices) {
      Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $deviceId, 'shell', 'aa', 'force-stop', [string]$Config.BundleName) -TimeoutSeconds 30 | Out-Null
    }
  } catch {
    Write-Info "预停止旧 App 失败，继续部署: $($_.Exception.Message)"
  }
}

function Resolve-HapPath {
  param(
    [hashtable]$Config,
    [string]$ProjectRoot
  )

  if ($Config.ContainsKey('HapPath') -and -not [string]::IsNullOrWhiteSpace([string]$Config.HapPath)) {
    $candidate = [string]$Config.HapPath
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
      $candidate = Join-Path $ProjectRoot $candidate
    }
    if (Test-Path -LiteralPath $candidate) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
    throw "配置中的 HapPath 不存在: $candidate"
  }

  $roots = @((Join-Path $ProjectRoot 'entry\build'), (Join-Path $ProjectRoot '.hvigor'))
  $haps = @()
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      $haps += Get-ChildItem -Path $root -Recurse -Filter *.hap -File -ErrorAction SilentlyContinue
    }
  }
  if ($haps.Count -eq 0) {
    throw "未找到 .hap 文件。请先使用 -Build 构建。"
  }
  return ($haps | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

function Resolve-Devices {
  param(
    [hashtable]$Config,
    [string[]]$OnlineTargets,
    [string[]]$OverrideDeviceIds = @()
  )
  $normalizedOverrideIds = @($OverrideDeviceIds | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
  if ($normalizedOverrideIds.Count -gt 0) {
    return $normalizedOverrideIds
  }
  if ($Config.ContainsKey('Devices') -and $Config.Devices.Count -gt 0) {
    return @($Config.Devices | ForEach-Object { [string]$_.Id })
  }
  return @($OnlineTargets)
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-RepoRoot -ScriptRoot $scriptRoot
$projectRoot = Resolve-HarmonyProjectRoot -RepoRoot $repoRoot -ProjectPath $ProjectPath
if ($ConfigPath.Trim().Length -eq 0) {
  $ConfigPath = Join-Path $scriptRoot 'codex-remote.config.psd1'
}

Write-Step "加载配置"
$config = Load-Config -Path $ConfigPath

if ($StartBridge -and -not $UseLanBridge) {
  $BridgeUrl = Convert-ToUsbBridgeUrl -BridgeUrl $BridgeUrl
  Write-Info "默认启用 USB Bridge URL: $BridgeUrl"
}

Set-BridgeUrl -ProjectRoot $projectRoot -BridgeUrl $BridgeUrl -BridgeToken $BridgeToken -BridgeTotpSecret $BridgeTotpSecret -RelayHostedByHelper:$RelayHostedByHelper -BundleName ([string]$config.BundleName)

if ($StartBridge) {
  if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
    throw "使用 -StartBridge 时必须提供 -BridgeUrl，例如 http://10.249.85.225:8787"
  }
  Stop-RunningAppIfPresent -Config $config -RepoRoot $repoRoot
  Start-LocalBridge -RepoRoot $repoRoot -BridgeUrl $BridgeUrl
}

if ($Build) {
  Invoke-Build -Config $config -ProjectRoot $projectRoot -ScriptRoot $scriptRoot
}

if ($SkipInstall -and $SkipLaunch) {
  $hapPath = Resolve-HapPath -Config $config -ProjectRoot $projectRoot
  Write-Host "HAP: $hapPath" -ForegroundColor DarkGray
  Show-LogSummary -BridgeUrl $BridgeUrl

  Write-Step "完成"
  Write-Host "Codex Remote HAP 已构建，安装和启动步骤已跳过。" -ForegroundColor Green
  return
}

$hdcExe = Find-HdcPath -Config $config -RepoRoot $repoRoot
Write-Host "HDC: $hdcExe" -ForegroundColor DarkGray

$onlineTargets = @(Get-OnlineTargets -HdcExe $hdcExe)
if ($onlineTargets.Count -eq 0) {
  throw "当前没有检测到在线设备。请先连接真机并打开 USB 调试。"
}
Write-Host "在线设备: $($onlineTargets -join ', ')" -ForegroundColor DarkGray

$hapPath = Resolve-HapPath -Config $config -ProjectRoot $projectRoot
Write-Host "HAP: $hapPath" -ForegroundColor DarkGray

$devices = Resolve-Devices -Config $config -OnlineTargets $onlineTargets -OverrideDeviceIds $DeviceId
$deployingRelayHelperItself = $RelayHostedByHelper -and ([string]$config.BundleName -eq 'com.codex.remote.hdc.helper')
if ($StartBridge -and -not $UseLanBridge) {
  foreach ($deviceId in $devices) {
    Enable-UsbReversePort -HdcExe $hdcExe -DeviceId $deviceId -BridgeUrl $BridgeUrl
  }
}

if (-not $SkipInstall) {
  Write-Step "安装 HAP"
  foreach ($deviceId in $devices) {
    $result = Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $deviceId, 'install', '-r', $hapPath) -TimeoutSeconds 180
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0 -or (Test-HdcOutputFailed -Output $result.Output)) {
      throw "安装失败: $deviceId"
    }
    if ($RelayHostedByHelper -and (Test-IsRelayHdcDevice -DeviceId $deviceId) -and -not $deployingRelayHelperItself) {
      Write-Info "安装后等待 Helper 恢复 HDC 通道: $deviceId"
      Wait-HdcTargetReady -HdcExe $hdcExe -DeviceId $deviceId -TimeoutSeconds 90
    } elseif ($RelayHostedByHelper -and (Test-IsRelayHdcDevice -DeviceId $deviceId) -and $deployingRelayHelperItself) {
      Write-Info "已更新 relay helper 自身；安装会关闭当前中继，跳过等待自身恢复。请在手机上打开中继助手完成接续。"
    }
  }
}

$shouldLaunch = (-not $SkipLaunch) -and [bool]$config.AutoLaunch
if ($shouldLaunch) {
  foreach ($deviceId in $devices) {
    if (Test-IsRelayHdcDevice -DeviceId $deviceId) {
      Write-Info "跳过 relay 目标长期 Hilog 采集，避免占用无线 HDC 通道: $deviceId"
    } else {
      Start-HilogCapture -HdcExe $hdcExe -DeviceId $deviceId -RepoRoot $repoRoot
    }
  }
}

if ($shouldLaunch) {
  Write-Step "启动应用"
  foreach ($deviceId in $devices) {
    $isRelayTarget = Test-IsRelayHdcDevice -DeviceId $deviceId
    if ($isRelayTarget -and -not $RelayHostedByHelper) {
      Write-Info "relay 目标使用 App 内置中继，安装后请保持/手动打开应用，跳过 aa start: $deviceId"
      continue
    }
    if ($isRelayTarget -and $RelayHostedByHelper) {
      Write-Info "relay 目标由独立 Helper 承载，允许启动主应用: $deviceId"
      Wait-HdcTargetReady -HdcExe $hdcExe -DeviceId $deviceId -TimeoutSeconds 90
    }
    $launchingRelayHelperItself = $isRelayTarget -and $deployingRelayHelperItself
    if ($launchingRelayHelperItself) {
      Write-Info "跳过 relay helper 自身 force-stop/aa start，避免关闭承载 HDC 的中继: $deviceId"
      continue
    }
    if ([bool]$config.ForceStopBeforeLaunch -and (-not $isRelayTarget -or $RelayHostedByHelper)) {
      Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $deviceId, 'shell', 'aa', 'force-stop', [string]$config.BundleName) -TimeoutSeconds 30 | Out-Null
      if ($isRelayTarget -and $RelayHostedByHelper) {
        Wait-HdcTargetReady -HdcExe $hdcExe -DeviceId $deviceId -TimeoutSeconds 90
      }
    } elseif ([bool]$config.ForceStopBeforeLaunch) {
      Write-Info "跳过 relay 目标 force-stop，避免关闭 App 内置 HDC 中继: $deviceId"
    }
    $result = Invoke-Hdc -HdcExe $hdcExe -HdcArgs @('-t', $deviceId, 'shell', 'aa', 'start', '-a', [string]$config.AbilityName, '-b', [string]$config.BundleName) -TimeoutSeconds 30
    $result.Output | ForEach-Object { Write-Host $_ }
    if ($result.ExitCode -ne 0 -or (Test-HdcOutputFailed -Output $result.Output)) {
      if (Test-HdcLaunchBlockedByLockedScreen -Output $result.Output) {
        Write-Warn "设备锁屏导致无法远程拉起应用；HAP 已安装成功，解锁手机后手动打开或重新执行启动即可。"
        continue
      }
      throw "启动失败: $deviceId"
    }
  }
}

Show-LogSummary -BridgeUrl $BridgeUrl

Write-Step "完成"
if ($SkipInstall) {
  Write-Host "Codex Remote HAP 已构建，安装步骤已跳过。" -ForegroundColor Green
} else {
  Write-Host "Codex Remote 已推送到设备。" -ForegroundColor Green
}
