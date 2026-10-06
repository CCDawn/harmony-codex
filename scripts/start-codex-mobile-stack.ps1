[CmdletBinding()]
param(
  [int]$BridgePort = 8787,
  [string]$BridgeToken = $env:CODEX_BRIDGE_TOKEN,
  [string]$BridgeTotpSecret = $env:CODEX_BRIDGE_TOTP_SECRET,
  [string]$BridgePublicUrl = $env:CODEX_BRIDGE_PUBLIC_URL,
  [string]$BridgeUrl = '',
  [string]$RuntimeMode = $env:CODEX_BRIDGE_RUNTIME_MODE,
  [string]$CanaryThreadIds = $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS,
  [string]$ConfigPath = '',
  [string]$SessionId = '',
  [switch]$SkipHdcRelay,
  [switch]$SkipCodexDesktop,
  [switch]$KeepExistingCodex,
  [switch]$ForceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
  $RuntimeMode = 'desktop'
}
$RuntimeMode = $RuntimeMode.Trim().ToLowerInvariant()
if ($RuntimeMode -notin @('desktop', 'desktop-primary', 'app-server-shadow', 'app-server-new-only', 'app-server-canary', 'app-server-primary')) {
  throw "未知运行模式: $RuntimeMode"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'tools\windows\mobile-link-lifecycle.ps1')
if (Test-MobileLinkPaused $repoRoot) { throw '链路已在管理应用中停止，请使用启动链路恢复。' }
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) {
  $BridgeUrl = "http://127.0.0.1:$BridgePort"
}
$BridgeUrl = $BridgeUrl.TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $repoRoot 'tools\harmony\hdc-relay.local.psd1'
}

$logRoot = Join-Path $repoRoot 'logs\startup'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

# Voice link (M2): only enable the managed voice server when voice\voice_server.py exists,
# so open-source users without the voice feature keep the bridge voice-free by default.
$voiceServerPath = Join-Path $repoRoot 'voice\voice_server.py'
$voiceEnabledText = '0'
$voiceCommand = ''
if (Test-Path -LiteralPath $voiceServerPath) {
  $voiceEnabledText = '1'
  $voicePython = Join-Path $repoRoot '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $voicePython)) {
    $voicePython = 'python'
  }
  $voiceCommand = '"{0}" "{1}" --port 8790' -f $voicePython, $voiceServerPath
}

function Resolve-CompatiblePowerShellHost {
  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not [string]::IsNullOrWhiteSpace([string]$pwsh.Source) -and (Test-Path -LiteralPath ([string]$pwsh.Source))) {
    return [string]$pwsh.Source
  }

  $currentHost = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentHost -and -not [string]::IsNullOrWhiteSpace([string]$currentHost.Path) -and (Test-Path -LiteralPath ([string]$currentHost.Path))) {
    return [string]$currentHost.Path
  }

  $legacyHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $legacyHost) {
    return $legacyHost
  }

  throw '未找到可用的 PowerShell 主机'
}

$script:PowerShellHostPath = Resolve-CompatiblePowerShellHost
$script:StartupStatus = [ordered]@{}
$script:CodexFrontendRepairRestarted = $false

function Set-StartupStatus {
  param(
    [string]$Name,
    [string]$State,
    [string]$Message
  )
  $script:StartupStatus[$Name] = [pscustomobject]@{
    State = $State
    Message = $Message
  }
}

function Get-StartupStatus {
  param([string]$Name)
  if ($script:StartupStatus.Contains($Name)) {
    return $script:StartupStatus[$Name]
  }
  return [pscustomobject]@{
    State = 'unknown'
    Message = '未检查'
  }
}

function Write-StartupStatusLine {
  param(
    [string]$Label,
    [string]$Name
  )
  $status = Get-StartupStatus -Name $Name
  $state = [string]$status.State
  $message = [string]$status.Message
  $color = switch ($state) {
    'ok' { 'Green' }
    'skipped' { 'DarkGray' }
    'degraded' { 'Yellow' }
    'failed' { 'Red' }
    default { 'Yellow' }
  }
  $prefix = switch ($state) {
    'ok' { '正常' }
    'skipped' { '跳过' }
    'degraded' { '降级' }
    'failed' { '失败' }
    default { '未知' }
  }
  Write-Host ("    {0}: {1} - {2}" -f $Label, $prefix, $message) -ForegroundColor $color
}

function Write-FinalStartupSummary {
  Write-Step "一键状态总览"
  Write-StartupStatusLine -Label '手机会话 bridge' -Name 'LocalBridge'
  Write-StartupStatusLine -Label 'App Server 运行模式' -Name 'AppServerRuntime'
  Write-StartupStatusLine -Label 'bridge 自动恢复' -Name 'LocalBridgeWatchdog'
  Write-StartupStatusLine -Label '桌面实时自动恢复' -Name 'DesktopLiveWatchdog'
  Write-StartupStatusLine -Label '公网 bridge 代理' -Name 'PublicBridge'
  Write-StartupStatusLine -Label 'Codex 桌面实时通道' -Name 'CodexDesktop'
  Write-StartupStatusLine -Label 'Codex 前端窗口' -Name 'CodexFrontend'
  Write-StartupStatusLine -Label 'Codex 前端状态条' -Name 'CodexStatusBadge'
  Write-StartupStatusLine -Label 'Codex 重启保护' -Name 'CodexRestartGuard'
  Write-StartupStatusLine -Label '桌面脚本桥' -Name 'DesktopScript'
  Write-StartupStatusLine -Label '会话 API' -Name 'SessionApi'
  Write-StartupStatusLine -Label 'HDC 本地代理' -Name 'HdcProxy'
  Write-StartupStatusLine -Label 'HDC 自动恢复' -Name 'HdcWatchdog'
  Write-StartupStatusLine -Label 'HDC 目标' -Name 'HdcTarget'

  $hardNames = switch ($RuntimeMode) {
    'app-server-primary' { @('LocalBridge', 'AppServerRuntime', 'SessionApi') }
    'desktop-primary' { @('LocalBridge', 'AppServerRuntime', 'CodexDesktop', 'DesktopScript', 'SessionApi') }
    default { @('LocalBridge', 'CodexDesktop', 'DesktopScript', 'SessionApi') }
  }
  $hardFailed = $false
  foreach ($name in $hardNames) {
    $state = [string](Get-StartupStatus -Name $name).State
    if ($state -eq 'failed' -or $state -eq 'degraded' -or $state -eq 'unknown') {
      $hardFailed = $true
    }
  }
  $hdcState = [string](Get-StartupStatus -Name 'HdcTarget').State
  if ($hardFailed) {
    $unavailableMessage = if ($RuntimeMode -eq 'app-server-primary') {
      '整体状态：不可用，需要先修复 bridge / App Server 主链路。'
    } elseif ($RuntimeMode -eq 'desktop-primary') {
      '整体状态：不可用，需要先修复 bridge / App Server 兜底 / Codex 桌面实时通道。'
    } else {
      '整体状态：不可用，需要先修复 bridge / Codex 桌面实时通道。'
    }
    Write-Host "    $unavailableMessage" -ForegroundColor Red
  } elseif ($hdcState -eq 'ok' -or $hdcState -eq 'skipped') {
    $readyMessage = if ($RuntimeMode -eq 'app-server-primary') {
      '整体状态：正常。App Server 主链路可用；桌面 CDP 仅作为回退能力。'
    } elseif ($RuntimeMode -eq 'desktop-primary') {
      '整体状态：正常。桌面实时主链路已启用，App Server 仅在发送前预检失败时兜底。'
    } else {
      '整体状态：正常。'
    }
    Write-Host "    $readyMessage" -ForegroundColor Green
  } else {
    $partialMessage = if ($RuntimeMode -eq 'app-server-primary') {
      '整体状态：部分可用。App Server 主链路可用，HDC 部署/抓日志链路正在等待手机中继恢复。'
    } elseif ($RuntimeMode -eq 'desktop-primary') {
      '整体状态：部分可用。桌面实时主链路和 App Server 兜底均已就绪，HDC 部署/抓日志链路正在等待手机中继恢复。'
    } else {
      '整体状态：部分可用。手机会话可用，HDC 部署/抓日志链路正在等待手机中继恢复。'
    }
    Write-Host "    $partialMessage" -ForegroundColor Yellow
  }
}

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

function Get-BridgeOtpCode {
  param([string]$Secret)
  # RFC 6238 TOTP（HMAC-SHA1、30 秒、6 位），与服务端 CODEX_BRIDGE_TOTP_SECRET 对应。
  if ([string]::IsNullOrWhiteSpace($Secret)) { return '' }
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $bits = New-Object System.Text.StringBuilder
  foreach ($ch in $Secret.Trim().ToUpper().ToCharArray()) {
    $idx = $alphabet.IndexOf($ch)
    if ($idx -ge 0) { [void]$bits.Append([Convert]::ToString($idx, 2).PadLeft(5, '0')) }
  }
  $keyBytes = New-Object System.Collections.Generic.List[byte]
  $bitText = $bits.ToString()
  for ($i = 0; ($i + 8) -le $bitText.Length; $i += 8) {
    $keyBytes.Add([Convert]::ToByte($bitText.Substring($i, 8), 2))
  }
  if ($keyBytes.Count -eq 0) { return '' }
  $counter = [UInt64][Math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 30)
  $counterBytes = New-Object byte[] 8
  for ($i = 7; $i -ge 0; $i -= 1) {
    $counterBytes[$i] = [byte]($counter % 256)
    $counter = [UInt64][Math]::Floor($counter / 256)
  }
  $hmac = New-Object System.Security.Cryptography.HMACSHA1 (, $keyBytes.ToArray())
  $digest = $hmac.ComputeHash($counterBytes)
  $offset = $digest[19] -band 15
  $value = ([UInt32]($digest[$offset] -band 127) * 16777216) + ([UInt32]($digest[$offset + 1]) * 65536) + ([UInt32]($digest[$offset + 2]) * 256) + [UInt32]($digest[$offset + 3])
  return ('{0:D6}' -f ($value % 1000000))
}

function Get-BridgeHeaders {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($BridgeToken)) {
    $headers['X-Codex-Bridge-Token'] = $BridgeToken
  }
  $otpCode = Get-BridgeOtpCode -Secret $BridgeTotpSecret
  if (-not [string]::IsNullOrWhiteSpace($otpCode)) {
    $headers['X-Codex-Bridge-OTP'] = $otpCode
  }
  return $headers
}

function Add-OptionalStringArgument {
  param(
    [string[]]$Arguments,
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Arguments
  }
  return @($Arguments + @($Name, $Value))
}

function Get-ConfigValue {
  param(
    [hashtable]$Config,
    [string]$Name,
    $Fallback
  )

  if ($Config.ContainsKey($Name) -and $null -ne $Config[$Name] -and "$($Config[$Name])".Trim().Length -gt 0) {
    return $Config[$Name]
  }
  return $Fallback
}

function Get-ObjectValue {
  param(
    [object]$Object,
    [string]$Name,
    $Fallback
  )

  if ($null -eq $Object) {
    return $Fallback
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Fallback
  }
  return $property.Value
}

function Invoke-JsonSafe {
  param(
    [string]$Uri,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 5
  )

  try {
    $value = Invoke-RestMethod -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    return [pscustomobject]@{
      Ok = $true
      Value = $value
      Error = ''
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Value = $null
      Error = $_.Exception.Message
    }
  }
}

function Stop-ProcessTree {
  param(
    [int]$ProcessId,
    [object[]]$AllProcesses
  )

  $children = @($AllProcesses | Where-Object { $_.ParentProcessId -eq $ProcessId })
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId) -AllProcesses $AllProcesses
  }
  if ($ProcessId -ne $PID) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-MatchingProcesses {
  param(
    [string]$Pattern,
    [switch]$RequireRepoPath
  )

  $escapedRepo = [Regex]::Escape($repoRoot)
  return @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if ($_.ProcessId -eq $PID -or [string]::IsNullOrWhiteSpace($commandLine)) {
      $false
    } elseif ($RequireRepoPath -and $commandLine -notmatch $escapedRepo) {
      $false
    } else {
      $commandLine -match $Pattern
    }
  })
}

function Test-ProjectProcess {
  param([string]$Pattern)

  return (@(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath).Count -gt 0)
}

function Stop-MatchingProcessTree {
  param(
    [string]$Pattern,
    [switch]$RequireRepoPath
  )

  $allProcesses = @(Get-CimInstance Win32_Process)
  $targets = @(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath:$RequireRepoPath)
  foreach ($target in $targets) {
    Write-Info "停止旧进程树 PID=$($target.ProcessId): $Pattern"
    Stop-ProcessTree -ProcessId ([int]$target.ProcessId) -AllProcesses $allProcesses
  }
}

function Stop-StaleLauncherWindows {
  Write-Step "整理一键启动窗口"
  $allProcesses = @(Get-CimInstance Win32_Process)
  $protectedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  $currentId = [int]$PID
  while ($currentId -gt 0 -and $protectedProcessIds.Add($currentId)) {
    $current = $allProcesses | Where-Object { [int]$_.ProcessId -eq $currentId } | Select-Object -First 1
    if ($null -eq $current -or $null -eq $current.ParentProcessId) {
      break
    }
    $currentId = [int]$current.ParentProcessId
  }

  $launchers = @(Get-MatchingProcesses -Pattern 'start-codex-mobile-stack\.ps1' -RequireRepoPath | Where-Object {
    -not $protectedProcessIds.Contains([int]$_.ProcessId)
  })
  if ($launchers.Count -eq 0) {
    Write-Info "没有旧的一键启动窗口"
    return
  }
  foreach ($launcher in $launchers) {
    Write-Info "关闭旧的一键启动窗口 PID=$($launcher.ProcessId)"
    Stop-Process -Id ([int]$launcher.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ProjectProcess {
  param([string]$Pattern)

  Stop-MatchingProcessTree -Pattern $Pattern -RequireRepoPath
}

function Stop-BridgePortOwner {
  param([int]$Port)

  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne $PID })
  if ($owners.Count -eq 0) {
    return
  }

  $allProcesses = @(Get-CimInstance Win32_Process)
  foreach ($owner in $owners) {
    $processInfo = $allProcesses | Where-Object { [int]$_.ProcessId -eq [int]$owner } | Select-Object -First 1
    $commandLine = [string]$processInfo.CommandLine
    if ($commandLine -notmatch 'src[\\/]server\.js') {
      Write-Warn "端口 $Port 被非 bridge 进程占用，未自动停止 PID=$owner"
      continue
    }
    Write-Info "释放本地 bridge 端口 $Port PID=$owner"
    Stop-ProcessTree -ProcessId ([int]$owner) -AllProcesses $allProcesses
  }
}

function Test-LocalAddressMatch {
  param(
    [string]$ActualAddress,
    [string]$ExpectedAddress
  )

  if ($ActualAddress -eq $ExpectedAddress -or $ActualAddress -eq '0.0.0.0' -or $ActualAddress -eq '::') {
    return $true
  }
  if ($ExpectedAddress -eq '127.0.0.1' -and ($ActualAddress -eq 'localhost' -or $ActualAddress -eq '::1')) {
    return $true
  }
  return $false
}

function Test-LocalPortListening {
  param(
    [string]$HostAddress,
    [int]$Port
  )

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if (Test-LocalAddressMatch -ActualAddress ([string]$listener.LocalAddress) -ExpectedAddress $HostAddress) {
      return $true
    }
  }
  return $false
}

function Get-LocalPortOwnerIds {
  param(
    [string]$HostAddress,
    [int]$Port
  )

  $owners = @()
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    if (Test-LocalAddressMatch -ActualAddress ([string]$listener.LocalAddress) -ExpectedAddress $HostAddress) {
      $owners += [int]$listener.OwningProcess
    }
  }
  return @($owners | Where-Object { $_ -and $_ -ne $PID } | Select-Object -Unique)
}

function Get-RepoAncestorProcessId {
  param(
    [int]$ProcessId,
    [object[]]$AllProcesses
  )

  $escapedRepo = [Regex]::Escape($repoRoot)
  $seen = @{}
  $currentId = $ProcessId
  while ($currentId -gt 0 -and -not $seen.ContainsKey("$currentId")) {
    $seen["$currentId"] = $true
    $process = $AllProcesses | Where-Object { [int]$_.ProcessId -eq [int]$currentId } | Select-Object -First 1
    if ($null -eq $process) {
      return 0
    }

    $commandLine = [string]$process.CommandLine
    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match $escapedRepo) {
      return [int]$process.ProcessId
    }

    $parentId = [int]$process.ParentProcessId
    if ($parentId -eq $currentId) {
      return 0
    }
    $currentId = $parentId
  }
  return 0
}

function Get-LocalBridgeHealth {
  Invoke-JsonSafe -Uri "$BridgeUrl/health" -Headers (Get-BridgeHeaders) -TimeoutSec 4
}

function Wait-BridgeHealth {
  param([int]$TimeoutSeconds = 25)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = ''
  while ((Get-Date) -lt $deadline) {
    $probe = Get-LocalBridgeHealth
    if ($probe.Ok) {
      return $probe.Value
    }
    $lastError = $probe.Error
    Start-Sleep -Milliseconds 700
  }
  throw "Bridge 健康检查失败: $BridgeUrl/health; $lastError"
}

function Set-AppServerRuntimeStartupStatus {
  param([object]$Runtime)

  if ($RuntimeMode -eq 'desktop') {
    Set-StartupStatus -Name 'AppServerRuntime' -State 'ok' -Message '桌面内嵌 App Server 为唯一所有者；独立 App Server 已禁用'
    return $true
  }

  $appServer = Get-ObjectValue -Object $Runtime -Name 'appServer' -Fallback $null
  $state = [string](Get-ObjectValue -Object $appServer -Name 'state' -Fallback 'unknown')
  if ($state -ne 'ready') {
    Set-StartupStatus -Name 'AppServerRuntime' -State 'failed' -Message "运行模式=$RuntimeMode; App Server 状态=$state"
    return $false
  }

  Set-StartupStatus -Name 'AppServerRuntime' -State 'ok' -Message "运行模式=$RuntimeMode; App Server 已就绪"
  return $true
}

function Start-LocalBridgeProcess {
  $stdout = Join-Path $logRoot 'bridge.stdout.log'
  $stderr = Join-Path $logRoot 'bridge.stderr.log'
  $command = @"
`$env:CODEX_BRIDGE_HOST='0.0.0.0'
`$env:CODEX_BRIDGE_PORT='$BridgePort'
`$env:CODEX_BRIDGE_WORKSPACE='$repoRoot'
`$env:CODEX_BRIDGE_TOKEN='$BridgeToken'
`$env:CODEX_BRIDGE_TOTP_SECRET='$BridgeTotpSecret'
`$env:CODEX_BRIDGE_PUBLIC_URL='$BridgePublicUrl'
`$env:CODEX_BRIDGE_ADAPTER='codex'
`$env:CODEX_BRIDGE_RUNTIME_MODE='$RuntimeMode'
`$env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS='$CanaryThreadIds'
`$env:CODEX_BRIDGE_VOICE_ENABLED='$VoiceEnabledText'
`$env:CODEX_BRIDGE_VOICE_COMMAND='$VoiceCommand'
node src/server.js
"@
  Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $command
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

function Ensure-LocalBridge {
  Write-Step "检查本地 Codex bridge"
  if (-not $ForceRestart) {
    $probe = Get-LocalBridgeHealth
    if ($probe.Ok) {
      $run = Get-ObjectValue -Object $probe.Value -Name 'run' -Fallback $null
      $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
      $runtime = Get-ObjectValue -Object $probe.Value -Name 'runtime' -Fallback $null
      $actualMode = [string](Get-ObjectValue -Object $runtime -Name 'mode' -Fallback '')
      if ($actualMode -eq $RuntimeMode) {
        if (-not (Set-AppServerRuntimeStartupStatus -Runtime $runtime)) {
          throw "App Server 未就绪: 运行模式=$RuntimeMode"
        }
        Write-Info "已在线: $BridgeUrl run=$runId; 运行模式=$actualMode"
        Set-StartupStatus -Name 'LocalBridge' -State 'ok' -Message "已在线 run=$runId"
        return
      }
      Write-Warn "当前 bridge 运行模式=$actualMode，目标=$RuntimeMode，将重启本地 bridge"
    }
    Write-Warn "未在线，将启动: $($probe.Error)"
  } else {
    Write-Warn "已指定 -ForceRestart，将重启本地 bridge"
  }

  Stop-ProjectProcess -Pattern 'src[\\/]server\.js'
  Stop-BridgePortOwner -Port $BridgePort
  Start-Sleep -Milliseconds 500
  Start-LocalBridgeProcess
  $health = Wait-BridgeHealth -TimeoutSeconds 25
  $run = Get-ObjectValue -Object $health -Name 'run' -Fallback $null
  $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
  $runtime = Get-ObjectValue -Object $health -Name 'runtime' -Fallback $null
  $actualMode = [string](Get-ObjectValue -Object $runtime -Name 'mode' -Fallback '')
  if ($actualMode -ne $RuntimeMode) {
    throw "Bridge 运行模式未生效: expected=$RuntimeMode; actual=$actualMode"
  }
  if (-not (Set-AppServerRuntimeStartupStatus -Runtime $runtime)) {
    throw "App Server 未就绪: 运行模式=$RuntimeMode"
  }
  Write-Info "Bridge 已就绪: $BridgeUrl run=$runId; 运行模式=$actualMode"
  Set-StartupStatus -Name 'LocalBridge' -State 'ok' -Message "已启动 run=$runId"
}

function Ensure-BackgroundScript {
  param(
    [string]$DisplayName,
    [string]$Pattern,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$StdoutName,
    [string]$StderrName
  )

  if ($ForceRestart) {
    Stop-ProjectProcess -Pattern $Pattern
  }
  if (Test-ProjectProcess -Pattern $Pattern) {
    Write-Info "$DisplayName 已运行"
    return
  }

  $stdout = Join-Path $logRoot $StdoutName
  $stderr = Join-Path $logRoot $StderrName
  $argumentList = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $ScriptPath
  ) + $Arguments
  Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList $argumentList -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  Write-Info "$DisplayName 已启动"
}

function Ensure-LocalBridgeWatchdog {
  Write-Step "检查本地 bridge 自动恢复"
  $expectedArgument = '-RuntimeMode\s+[''" ]?' + [regex]::Escape($RuntimeMode) + '(?:[''"]|\s|$)'
  $allProcesses = @(Get-CimInstance Win32_Process)
  $staleWatchdogs = @(Get-MatchingProcesses -Pattern 'watch-local-bridge\.ps1' -RequireRepoPath | Where-Object {
    [string]$_.CommandLine -notmatch $expectedArgument
  })
  foreach ($stale in $staleWatchdogs) {
    Write-Warn "检测到旧本地 bridge watchdog 模式，切换为 ${RuntimeMode}: PID=$($stale.ProcessId)"
    Stop-ProcessTree -ProcessId ([int]$stale.ProcessId) -AllProcesses $allProcesses
  }
  $watchdogArguments = @('-BridgePort', "$BridgePort")
  $watchdogArguments = Add-OptionalStringArgument -Arguments $watchdogArguments -Name '-RuntimeMode' -Value $RuntimeMode
  $watchdogArguments = Add-OptionalStringArgument -Arguments $watchdogArguments -Name '-CanaryThreadIds' -Value $CanaryThreadIds
  Ensure-BackgroundScript `
    -DisplayName '本地 bridge watchdog' `
    -Pattern 'watch-local-bridge\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-local-bridge.ps1') `
    -Arguments $watchdogArguments `
    -StdoutName 'local-bridge-watchdog.stdout.log' `
    -StderrName 'local-bridge-watchdog.stderr.log'
  Set-StartupStatus -Name 'LocalBridgeWatchdog' -State 'ok' -Message 'watchdog 已就绪'
}

function Ensure-DesktopLiveWatchdog {
  if ($SkipCodexDesktop) {
    Set-StartupStatus -Name 'DesktopLiveWatchdog' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    return
  }
  if ($RuntimeMode -notin @('desktop', 'desktop-primary')) {
    Set-StartupStatus -Name 'DesktopLiveWatchdog' -State 'skipped' -Message "运行模式=$RuntimeMode 不要求桌面实时守护"
    return
  }

  Write-Step "检查桌面实时自动恢复"
  $watchdogArguments = @('-BridgePort', "$BridgePort")
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $watchdogArguments += @('-SessionId', $SessionId)
  }
  Ensure-BackgroundScript `
    -DisplayName '桌面实时 watchdog' `
    -Pattern 'watch-desktop-live\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-desktop-live.ps1') `
    -Arguments $watchdogArguments `
    -StdoutName 'desktop-live-watchdog.stdout.log' `
    -StderrName 'desktop-live-watchdog.stderr.log'
  Set-StartupStatus -Name 'DesktopLiveWatchdog' -State 'ok' -Message 'watchdog 已就绪；仅在 Codex 退出时自动拉起带 CDP 的桌面'
}

function Start-RelayProcess {
  param(
    [string]$Mode,
    [string]$Name
  )

  $stdout = Join-Path $logRoot "$Name.stdout.log"
  $stderr = Join-Path $logRoot "$Name.stderr.log"
  $script = Join-Path $repoRoot 'tools\harmony\start-hdc-relay.ps1'
  Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-Mode', $Mode,
    '-ConfigPath', $ConfigPath
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

function Stop-BridgeProxyProcesses {
  Stop-ProjectProcess -Pattern 'start-hdc-relay\.ps1.*\bBridgeProxy\b'
  Stop-ProjectProcess -Pattern 'bridge:relay-proxy|start-bridge-proxy\.mjs'
}

function Stop-HdcProxyProcesses {
  Stop-ProjectProcess -Pattern 'start-hdc-relay\.ps1.*\bProxy\b'
  Stop-ProjectProcess -Pattern 'hdc:proxy|start-local-proxy\.mjs|HDC_PROXY_PORT'
}

function Stop-RelayProcesses {
  param([hashtable]$Config)

  Stop-ProjectProcess -Pattern 'watch-hdc-connection\.ps1'
  Stop-ProjectProcess -Pattern 'watch-bridge-proxy\.ps1'
  Stop-BridgeProxyProcesses
  Stop-HdcProxyProcesses

  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $allProcesses = @(Get-CimInstance Win32_Process)
  foreach ($owner in (Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)) {
    $repoAncestorId = Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses
    if ($repoAncestorId -gt 0) {
      Write-Info "释放本项目 HDC proxy 端口 ${proxyHost}:$proxyPort PID=$owner"
      Stop-ProcessTree -ProcessId $repoAncestorId -AllProcesses $allProcesses
    } else {
      Write-Info "HDC proxy 由外部工具接管，保持运行: ${proxyHost}:$proxyPort PID=$owner"
    }
  }
}

function Get-RelayStateSafe {
  param([hashtable]$Config)

  $relayHost = [string](Get-ConfigValue -Config $Config -Name 'RelayHost' -Fallback '<your-relay-server>')
  $relayPort = [int](Get-ConfigValue -Config $Config -Name 'RelayPort' -Fallback 19078)
  $relayToken = [string](Get-ConfigValue -Config $Config -Name 'Token' -Fallback '')
  $url = "http://${relayHost}:${relayPort}/__relay/state?token=$([uri]::EscapeDataString($relayToken))"
  Invoke-JsonSafe -Uri $url -TimeoutSec 5
}

function Ensure-BridgeProxy {
  param([hashtable]$Config)

  Write-Step "检查公网 bridge 代理"
  $stateProbe = Get-RelayStateSafe -Config $Config
  $bridgePc = 0
  if ($stateProbe.Ok) {
    $bridgePc = [int](Get-ObjectValue -Object $stateProbe.Value.state -Name 'bridgePc' -Fallback 0)
  }

  if (-not $ForceRestart -and $stateProbe.Ok -and $bridgePc -gt 0) {
    Write-Info "公网 bridge 代理已在线: bridgePc=$bridgePc"
    Set-StartupStatus -Name 'PublicBridge' -State 'ok' -Message "bridgePc=$bridgePc"
  } else {
    if (-not $stateProbe.Ok) {
      Write-Warn "公网 relay 状态暂不可读，将尝试补齐 bridge 代理: $($stateProbe.Error)"
    } elseif ($ForceRestart) {
      Write-Warn "已指定 -ForceRestart，将重启 bridge 代理"
    } else {
      Write-Warn "公网 bridge 代理池为空，将启动 bridge 代理"
    }
    Stop-BridgeProxyProcesses
    Start-Sleep -Milliseconds 500
    Start-RelayProcess -Mode 'BridgeProxy' -Name 'bridge-proxy'
    Start-Sleep -Seconds 2

    $after = Get-RelayStateSafe -Config $Config
    if ($after.Ok) {
      $afterBridgePc = [int](Get-ObjectValue -Object $after.Value.state -Name 'bridgePc' -Fallback 0)
      Write-Info "公网 bridge 状态: bridgePc=$afterBridgePc"
      if ($afterBridgePc -gt 0) {
        Set-StartupStatus -Name 'PublicBridge' -State 'ok' -Message "bridgePc=$afterBridgePc"
      } else {
        Set-StartupStatus -Name 'PublicBridge' -State 'degraded' -Message '代理已启动，但公网池仍为空'
      }
    } else {
      Write-Warn "bridge 代理已启动，但公网状态仍不可读: $($after.Error)"
      Set-StartupStatus -Name 'PublicBridge' -State 'degraded' -Message "公网状态不可读: $($after.Error)"
    }
  }

  Ensure-BackgroundScript `
    -DisplayName '公网 bridge watchdog' `
    -Pattern 'watch-bridge-proxy\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-bridge-proxy.ps1') `
    -Arguments @('-ConfigPath', $ConfigPath) `
    -StdoutName 'bridge-proxy-watchdog.stdout.log' `
    -StderrName 'bridge-proxy-watchdog.stderr.log'
}

function Ensure-LocalHdcProxy {
  param([hashtable]$Config)

  Write-Step "检查本地 HDC proxy"
  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $owners = @(Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)

  if ($owners.Count -gt 0) {
    if ($ForceRestart) {
      $allProcesses = @(Get-CimInstance Win32_Process)
      $hasProjectOwner = $false
      foreach ($owner in $owners) {
        if ((Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses) -gt 0) {
          $hasProjectOwner = $true
        }
      }
      if (-not $hasProjectOwner) {
        Write-Info "HDC proxy 已由共享工具监听，复用: ${proxyHost}:$proxyPort PID=$($owners -join ',')"
        Set-StartupStatus -Name 'HdcProxy' -State 'ok' -Message "共享代理监听 ${proxyHost}:$proxyPort"
        return
      }
    } else {
      Write-Info "HDC proxy 已监听: ${proxyHost}:$proxyPort PID=$($owners -join ',')"
      Set-StartupStatus -Name 'HdcProxy' -State 'ok' -Message "已监听 ${proxyHost}:$proxyPort"
      return
    }
  } else {
    Write-Warn "HDC proxy 未监听，将启动: ${proxyHost}:$proxyPort"
  }

  if ($ForceRestart) {
    Write-Warn "已指定 -ForceRestart，将重启本项目本地 HDC proxy"
  }
  Stop-HdcProxyProcesses
  Start-Sleep -Milliseconds 500
  Start-RelayProcess -Mode 'Proxy' -Name 'local-proxy'

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline -and -not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
    Set-StartupStatus -Name 'HdcProxy' -State 'failed' -Message "未监听 ${proxyHost}:$proxyPort"
    throw "本地 HDC proxy 未监听: ${proxyHost}:$proxyPort"
  }
  Write-Info "HDC proxy 已监听: ${proxyHost}:$proxyPort"
  Set-StartupStatus -Name 'HdcProxy' -State 'ok' -Message "已启动并监听 ${proxyHost}:$proxyPort"
}

function Test-HdcTargetConnected {
  param(
    [string]$HdcPath,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $HdcPath)) {
    return $false
  }
  $targets = @(& $HdcPath list targets -v 2>&1)
  foreach ($line in $targets) {
    if ($line -match [regex]::Escape($Target) -and $line -match '\bConnected\b') {
      return $true
    }
  }
  return $false
}

function Test-HdcTargetShellReady {
  param(
    [string]$HdcPath,
    [string]$Target
  )

  if (-not (Test-HdcTargetConnected -HdcPath $HdcPath -Target $Target)) {
    return $false
  }
  $probe = @(& $HdcPath -t $Target shell echo codex-link-ok 2>&1)
  return ($LASTEXITCODE -eq 0 -and (($probe -join "`n") -match 'codex-link-ok'))
}

function Ensure-HdcConnection {
  param([hashtable]$Config)

  Write-Step "检查 HDC 目标连接"
  $proxyHost = [string](Get-ConfigValue -Config $Config -Name 'ProxyHost' -Fallback '127.0.0.1')
  $proxyPort = [int](Get-ConfigValue -Config $Config -Name 'ProxyPort' -Fallback 11078)
  $hdcPath = [string](Get-ConfigValue -Config $Config -Name 'HdcPath' -Fallback 'C:\openHarmony\20\toolchains\hdc.exe')
  $target = "${proxyHost}:$proxyPort"

  if (-not (Test-Path -LiteralPath $hdcPath)) {
    Write-Warn "HDC 不存在，跳过 tconn: $hdcPath"
    Set-StartupStatus -Name 'HdcTarget' -State 'skipped' -Message "HDC 不存在: $hdcPath"
    return
  }

  if (-not $ForceRestart -and (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target)) {
    Write-Info "HDC target 已连接且 shell 可用: $target"
    Set-StartupStatus -Name 'HdcTarget' -State 'ok' -Message "$target shell 可用"
  } else {
    if (Test-HdcTargetConnected -HdcPath $hdcPath -Target $target) {
      Write-Warn "HDC target 列表显示已连接，但 shell 未确认；将重新 tconn: $target"
      & $hdcPath kill -r 2>&1 | Out-Null
      Start-Sleep -Milliseconds 700
    }
    Write-Info "执行 hdc tconn $target"
    $output = @(& $hdcPath tconn $target 2>&1)
    $output | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "HDC tconn 返回码 $LASTEXITCODE；watchdog 会继续重试。"
      $global:LASTEXITCODE = 0
    }
    if (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target) {
      Write-Info "HDC target 已连接且 shell 可用: $target"
      Set-StartupStatus -Name 'HdcTarget' -State 'ok' -Message "$target shell 可用"
    } else {
      Write-Warn "HDC target 暂未真正可用，将重启本项目本地 proxy 后再试一次。"
      $owners = @(Get-LocalPortOwnerIds -HostAddress $proxyHost -Port $proxyPort)
      $allProcesses = @(Get-CimInstance Win32_Process)
      $canRestartLocalProxy = ($owners.Count -eq 0)
      foreach ($owner in $owners) {
        if ((Get-RepoAncestorProcessId -ProcessId ([int]$owner) -AllProcesses $allProcesses) -gt 0) {
          $canRestartLocalProxy = $true
        }
      }
      if ($canRestartLocalProxy) {
        Stop-HdcProxyProcesses
      } else {
        Write-Warn "当前 HDC proxy 由共享工具接管，不在本脚本里强杀；watchdog 会继续自动恢复。"
      }
      Start-Sleep -Milliseconds 700
      if ($canRestartLocalProxy) {
        Start-RelayProcess -Mode 'Proxy' -Name 'local-proxy'
      }

      $deadline = (Get-Date).AddSeconds(12)
      while ((Get-Date) -lt $deadline -and -not (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort)) {
        Start-Sleep -Milliseconds 500
      }
      if (Test-LocalPortListening -HostAddress $proxyHost -Port $proxyPort) {
        $retryOutput = @(& $hdcPath tconn $target 2>&1)
        $retryOutput | Out-Host
        $global:LASTEXITCODE = 0
      }

      if (Test-HdcTargetShellReady -HdcPath $hdcPath -Target $target) {
        Write-Info "HDC target 已恢复且 shell 可用: $target"
        Set-StartupStatus -Name 'HdcTarget' -State 'ok' -Message "$target 已恢复且 shell 可用"
      } else {
        Write-Warn "HDC target 仍未连接，已保留自动重连 watchdog。"
        if (Test-HdcTargetConnected -HdcPath $hdcPath -Target $target) {
          Set-StartupStatus -Name 'HdcTarget' -State 'degraded' -Message "$target 列表已连接但 shell 未确认"
        } else {
          Set-StartupStatus -Name 'HdcTarget' -State 'degraded' -Message "$target 未连接，等待手机中继或 watchdog 恢复"
        }
      }
    }
  }

  & $hdcPath list targets | Out-Host
  $global:LASTEXITCODE = 0
}

function Get-ConfigPathFromCommandLine {
  param([string]$CommandLine)

  if ($CommandLine -match '(?i)-ConfigPath\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))') {
    if ($Matches['quoted']) {
      return [string]$Matches['quoted']
    }
    return [string]$Matches['plain']
  }
  return ''
}

function Test-RelayConfigEquivalent {
  param(
    [string]$DesiredConfigPath,
    [string]$CandidateConfigPath
  )

  try {
    if ([string]::IsNullOrWhiteSpace($CandidateConfigPath) -or -not (Test-Path -LiteralPath $CandidateConfigPath)) {
      return $false
    }
    $desired = Import-PowerShellDataFile -LiteralPath $DesiredConfigPath
    $candidate = Import-PowerShellDataFile -LiteralPath $CandidateConfigPath
    foreach ($key in @('RelayHost', 'RelayPort', 'Token', 'DeviceId', 'ProxyHost', 'ProxyPort')) {
      $left = [string](Get-ConfigValue -Config $desired -Name $key -Fallback '')
      $right = [string](Get-ConfigValue -Config $candidate -Name $key -Fallback '')
      if ($left -ne $right) {
        return $false
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Test-SharedHdcWatchdogRunning {
  $watchdogs = @(Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.ProcessId -ne $PID -and
    -not [string]::IsNullOrWhiteSpace($commandLine) -and
    $commandLine -match 'watch-hdc-connection\.ps1'
  })
  foreach ($watchdog in $watchdogs) {
    $commandLine = [string]$watchdog.CommandLine
    $candidateConfigPath = Get-ConfigPathFromCommandLine -CommandLine $commandLine
    if (Test-RelayConfigEquivalent -DesiredConfigPath $ConfigPath -CandidateConfigPath $candidateConfigPath) {
      Write-Info "复用共享 HDC watchdog PID=$($watchdog.ProcessId): $candidateConfigPath"
      Set-StartupStatus -Name 'HdcWatchdog' -State 'ok' -Message "复用共享 watchdog PID=$($watchdog.ProcessId)"
      return $true
    }
  }
  return $false
}

function Ensure-HdcWatchdog {
  if ($ForceRestart) {
    Stop-ProjectProcess -Pattern 'watch-hdc-connection\.ps1'
  }
  if (Test-SharedHdcWatchdogRunning) {
    return
  }
  Ensure-BackgroundScript `
    -DisplayName 'HDC 自动重连 watchdog' `
    -Pattern 'watch-hdc-connection\.ps1' `
    -ScriptPath (Join-Path $repoRoot 'tools\harmony\watch-hdc-connection.ps1') `
    -Arguments @('-ConfigPath', $ConfigPath) `
    -StdoutName 'hdc-watchdog.stdout.log' `
    -StderrName 'hdc-watchdog.stderr.log'
  Set-StartupStatus -Name 'HdcWatchdog' -State 'ok' -Message 'watchdog 已就绪'
}

function Ensure-HdcRelay {
  if ($SkipHdcRelay) {
    Set-StartupStatus -Name 'PublicBridge' -State 'skipped' -Message '按参数跳过 HDC relay'
    Set-StartupStatus -Name 'HdcProxy' -State 'skipped' -Message '按参数跳过 HDC relay'
    Set-StartupStatus -Name 'HdcWatchdog' -State 'skipped' -Message '按参数跳过 HDC relay'
    Set-StartupStatus -Name 'HdcTarget' -State 'skipped' -Message '按参数跳过 HDC relay'
    return
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "缺少 HDC Relay 配置: $ConfigPath"
  }

  Write-Step "检查公网 bridge/HDC 代理"
  $config = Import-PowerShellDataFile -LiteralPath $ConfigPath
  if ($ForceRestart) {
    Stop-RelayProcesses -Config $config
    Start-Sleep -Milliseconds 600
  }

  Ensure-BridgeProxy -Config $config
  Ensure-LocalHdcProxy -Config $config
  Ensure-HdcWatchdog
  Ensure-HdcConnection -Config $config
}

function Show-RelayState {
  if ($SkipHdcRelay) {
    return
  }
  Write-Step "检查公网 bridge/HDC 状态"
  $script = Join-Path $repoRoot 'tools\harmony\check-relay-state.ps1'
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-ConfigPath', $ConfigPath,
    '-SkipDesktopScreenshot'
  )
  $args = Add-OptionalStringArgument -Arguments $args -Name '-BridgeToken' -Value $BridgeToken
  & $script:PowerShellHostPath @args
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Relay 状态检查失败，详见上方输出。"
    $global:LASTEXITCODE = 0
  }
}

function Get-DesktopLiveStatus {
  Invoke-JsonSafe -Uri "$BridgeUrl/desktop/script/status" -Headers (Get-BridgeHeaders) -TimeoutSec 6
}

function Test-DesktopLiveOnline {
  $status = Get-DesktopLiveStatus
  if (-not $status.Ok) {
    return $false
  }
  $bridge = Get-ObjectValue -Object $status.Value -Name 'bridge' -Fallback $null
  $online = [bool](Get-ObjectValue -Object $bridge -Name 'online' -Fallback $false)
  if (-not $online) {
    return $false
  }
  $scriptAuth = Get-ObjectValue -Object $bridge -Name 'scriptAuth' -Fallback $null
  $authHealthy = [bool](Get-ObjectValue -Object $scriptAuth -Name 'healthy' -Fallback $true)
  if (-not $authHealthy) {
    Write-Warn "桌面 live-host 在线但脚本桥认证异常，将软恢复 live-host，不重启 Codex"
    return $false
  }
  if (Test-ExistingCdpReady) {
    Set-StartupStatus -Name 'CodexStatusBadge' -State 'ok' -Message 'CDP 可用，前端状态条可注入/校验'
  } else {
    Set-StartupStatus -Name 'CodexStatusBadge' -State 'degraded' -Message '脚本桥在线，但 CDP 不可探测；前端状态条无法校验，下一次注入后会自绘'
  }
  return $true
}

function Test-CdpReady {
  param([int]$Port = 9229)

  foreach ($path in @('/json', '/json/list')) {
    $probe = Invoke-JsonSafe -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 2
    if (-not $probe.Ok) {
      continue
    }
    $targets = @($probe.Value)
    foreach ($target in $targets) {
      $type = Get-ObjectValue -Object $target -Name 'type' -Fallback ''
      $webSocketUrl = Get-ObjectValue -Object $target -Name 'webSocketDebuggerUrl' -Fallback ''
      if ($type -eq 'page' -and -not [string]::IsNullOrWhiteSpace([string]$webSocketUrl)) {
        return $true
      }
    }
  }
  return $false
}

function Add-CandidateCdpPort {
  param(
    [System.Collections.Generic.List[int]]$Ports,
    [int]$Port
  )
  if ($Port -gt 0 -and -not $Ports.Contains($Port)) {
    $Ports.Add($Port) | Out-Null
  }
}

function Get-CandidateCdpPorts {
  $ports = [System.Collections.Generic.List[int]]::new()

  $envPort = 0
  [void][int]::TryParse([string]$env:CODEX_DESKTOP_CDP_PORT, [ref]$envPort)
  Add-CandidateCdpPort -Ports $ports -Port $envPort

  $statusPath = Join-Path $repoRoot 'logs\desktop-live-status.json'
  if (Test-Path -LiteralPath $statusPath) {
    try {
      $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
      $statusPort = 0
      [void][int]::TryParse([string](Get-ObjectValue -Object $status -Name 'cdpPort' -Fallback ''), [ref]$statusPort)
      Add-CandidateCdpPort -Ports $ports -Port $statusPort
    } catch {
      Write-Info "忽略不可读 CDP 状态文件: $($_.Exception.Message)"
    }
  }

  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    [string]$_.CommandLine -match 'remote-debugging-port='
  })
  foreach ($process in $processes) {
    $match = [regex]::Match([string]$process.CommandLine, 'remote-debugging-port=(\d+)')
    if ($match.Success) {
      Add-CandidateCdpPort -Ports $ports -Port ([int]$match.Groups[1].Value)
    }
  }

  Add-CandidateCdpPort -Ports $ports -Port 9229
  return $ports.ToArray()
}

function Test-ExistingCdpReady {
  foreach ($port in Get-CandidateCdpPorts) {
    if (Test-CdpReady -Port $port) {
      return $true
    }
  }
  return $false
}

function Get-CodexDesktopShellProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $path = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    $isPackagedChatGpt = $path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' -or
      $cmd -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe'
    $isLegacyCodex = $path.EndsWith('\app\Codex.exe', [System.StringComparison]::OrdinalIgnoreCase) -or
      ($cmd -match '\\app\\Codex\.exe"?(?:\s|$)')
    $isDesktopShell = $isPackagedChatGpt -or $isLegacyCodex
    $isChildProcess = $cmd -match '\s--type='
    $isDesktopShell -and -not $isChildProcess
  })
}

function Test-CodexDesktopShellRunning {
  $processes = @(Get-CodexDesktopShellProcesses)
  return $processes.Count -gt 0
}

function Update-CodexFrontendWindowStatus {
  try {
    $windowCandidates = @([System.Diagnostics.Process]::GetProcessesByName('ChatGPT')) +
      @([System.Diagnostics.Process]::GetProcessesByName('Codex'))
    $windows = @($windowCandidates | Where-Object {
      $_.MainWindowHandle -ne [IntPtr]::Zero -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
    })
    if ($windows.Count -gt 0) {
      $titles = ($windows | Select-Object -First 3 | ForEach-Object { "$($_.MainWindowTitle) PID=$($_.Id)" }) -join '; '
      Set-StartupStatus -Name 'CodexFrontend' -State 'ok' -Message "前端窗口可见: $titles"
      return $true
    }
    $shellRunning = Test-CodexDesktopShellRunning
    if ($shellRunning) {
      Set-StartupStatus -Name 'CodexFrontend' -State 'degraded' -Message 'Codex 进程存在，但没有可见前端窗口；手机消息链路可继续使用'
    } else {
      Set-StartupStatus -Name 'CodexFrontend' -State 'degraded' -Message '未检测到 Codex 前端窗口'
    }
  } catch {
    Set-StartupStatus -Name 'CodexFrontend' -State 'degraded' -Message "前端窗口状态不可读: $($_.Exception.Message)"
  }
  return $false
}

function Show-CodexFrontendWindow {
  $shell = @(Get-CodexDesktopShellProcesses | Select-Object -First 1)
  if ($shell.Count -eq 0) {
    return $false
  }

  $codexExe = [string]$shell[0].ExecutablePath
  if ([string]::IsNullOrWhiteSpace($codexExe) -or -not (Test-Path -LiteralPath $codexExe)) {
    return $false
  }

  try {
    Write-Info "检测到 Codex 壳进程但无窗口，尝试唤醒前端: PID=$($shell[0].ProcessId)"
    Start-Process -FilePath $codexExe -WorkingDirectory (Split-Path -Parent $codexExe) | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 500
      if (Update-CodexFrontendWindowStatus) {
        return $true
      }
    }
  } catch {
    Write-Warn "唤醒 Codex 前端失败: $($_.Exception.Message)"
  }
  return $false
}

function Repair-CodexFrontendWindowWithLiveRestart {
  param([string]$Reason)

  Report-CodexActiveWorkBeforeRestart -Reason $Reason

  $script = Join-Path $repoRoot 'scripts\restart-codex-desktop-live.ps1'
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-BridgeUrl', $BridgeUrl
  )
  $args = Add-OptionalStringArgument -Arguments $args -Name '-BridgeToken' -Value $BridgeToken
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $args += @('-SessionId', $SessionId)
  }

  Write-Warn "Codex 实时通道在线但前端窗口缺失，将重新拉起带 CDP 的 Codex 前端"
  $script:CodexFrontendRepairRestarted = $true
  Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '实时通道在线但前端缺失，已重新拉起带 CDP 的 Codex'
  & $script:PowerShellHostPath @args
  if ($LASTEXITCODE -ne 0) {
    Set-StartupStatus -Name 'CodexDesktop' -State 'failed' -Message "前端重拉起/CDP 注入失败，退出码: $LASTEXITCODE"
    throw "Codex 前端重拉起/CDP 注入失败，退出码: $LASTEXITCODE"
  }

  if (Test-DesktopLiveOnline) {
    [void](Update-CodexFrontendWindowStatus)
    Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '前端缺失已修复，Codex 已带 CDP 重新在线'
    Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '未发现运行中的 Codex 任务，已允许前端重拉起'
    return $true
  }

  Set-StartupStatus -Name 'CodexDesktop' -State 'degraded' -Message '前端重拉起完成，但桌面实时通道尚未确认在线'
  return $false
}

function Ensure-CodexFrontendVisibleOrRepair {
  if (Update-CodexFrontendWindowStatus) {
    return $true
  }

  if (Show-CodexFrontendWindow) {
    Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '实时通道已在线，已唤醒 Codex 前端窗口'
    return $true
  }

  return Repair-CodexFrontendWindowWithLiveRestart -Reason '桌面实时通道在线但未检测到 Codex 前端窗口'
}

function Get-ActiveCodexWorkGuard {
  param([string]$BridgeBaseUrl)

  $headers = Get-BridgeHeaders
  $activeItems = New-Object System.Collections.Generic.List[string]
  $warnings = New-Object System.Collections.Generic.List[string]

  $taskProbe = Invoke-JsonSafe -Uri "$BridgeBaseUrl/tasks" -Headers $headers -TimeoutSec 6
  if ($taskProbe.Ok) {
    $tasks = Get-ObjectValue -Object $taskProbe.Value -Name 'tasks' -Fallback @()
    foreach ($task in @($tasks)) {
      $status = ([string](Get-ObjectValue -Object $task -Name 'status' -Fallback '')).ToLowerInvariant()
      $interruptState = ([string](Get-ObjectValue -Object $task -Name 'interruptState' -Fallback '')).ToLowerInvariant()
      $interruptDispatching = [bool](Get-ObjectValue -Object $task -Name 'interruptDispatching' -Fallback $false)
      $interruptRecovering = [bool](Get-ObjectValue -Object $task -Name 'interruptRecovering' -Fallback $false)
      if (@('queued', 'running', 'waiting_approval') -contains $status -or
        @('dispatching', 'reconciling') -contains $interruptState -or
        $interruptDispatching -or
        $interruptRecovering) {
        $id = [string](Get-ObjectValue -Object $task -Name 'id' -Fallback '')
        $sessionId = [string](Get-ObjectValue -Object $task -Name 'codexSessionId' -Fallback '')
        $preview = [string](Get-ObjectValue -Object $task -Name 'promptPreview' -Fallback '')
        if ($preview.Length -gt 36) {
          $preview = $preview.Substring(0, 36) + '...'
        }
        $activeItems.Add(("task {0} session={1} status={2} interrupt={3} {4}" -f $id, $sessionId, $status, $interruptState, $preview).Trim())
      }
    }
  } else {
    $warnings.Add("tasks 状态不可读: $($taskProbe.Error)")
  }

  $threadProbe = Invoke-JsonSafe -Uri "$BridgeBaseUrl/api/codex/threads" -Headers $headers -TimeoutSec 8
  if ($threadProbe.Ok) {
    $threads = Get-ObjectValue -Object $threadProbe.Value -Name 'threads' -Fallback $null
    if ($null -eq $threads) {
      $threads = Get-ObjectValue -Object $threadProbe.Value -Name 'items' -Fallback $threadProbe.Value
    }
    foreach ($thread in @($threads)) {
      $runtimeState = ([string](Get-ObjectValue -Object $thread -Name 'runtimeState' -Fallback '')).ToLowerInvariant()
      $activityStatus = ([string](Get-ObjectValue -Object $thread -Name 'activityStatus' -Fallback '')).ToLowerInvariant()
      $status = ([string](Get-ObjectValue -Object $thread -Name 'status' -Fallback '')).ToLowerInvariant()
      $canInterrupt = [bool](Get-ObjectValue -Object $thread -Name 'canInterrupt' -Fallback $false)
      if (@('running', 'waiting_approval', 'in_progress', 'inprogress', 'processing') -contains $runtimeState -or
        @('running', 'waiting_approval', 'in_progress', 'inprogress', 'processing') -contains $activityStatus -or
        @('running', 'waiting_approval', 'in_progress', 'inprogress', 'processing') -contains $status -or
        $canInterrupt) {
        $id = [string](Get-ObjectValue -Object $thread -Name 'id' -Fallback '')
        $title = [string](Get-ObjectValue -Object $thread -Name 'title' -Fallback '')
        if ($title.Length -gt 28) {
          $title = $title.Substring(0, 28) + '...'
        }
        $activeItems.Add(("thread {0} state={1}/{2}/{3} {4}" -f $id, $runtimeState, $activityStatus, $status, $title).Trim())
      }
    }
  } else {
    $warnings.Add("threads 状态不可读: $($threadProbe.Error)")
  }

  return [pscustomobject]@{
    HasActiveWork = $activeItems.Count -gt 0
    ActiveCount = $activeItems.Count
    ActiveItems = @($activeItems)
    Warnings = @($warnings)
  }
}

function Report-CodexActiveWorkBeforeRestart {
  param([string]$Reason)

  $guard = Get-ActiveCodexWorkGuard -BridgeBaseUrl $BridgeUrl
  foreach ($warning in @($guard.Warnings)) {
    Write-Warn $warning
  }
  if (-not $guard.HasActiveWork) {
    Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '未发现运行中的 Codex 任务，可以按需启动/恢复'
    return
  }

  $examples = @($guard.ActiveItems | Select-Object -First 3)
  foreach ($item in $examples) {
    Write-Warn "检测到活跃 Codex 状态但不阻塞重启: $item"
  }
  Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message "发现 $($guard.ActiveCount) 个活跃状态，但按配置不阻塞 Codex 重启: $Reason"
}

function Ensure-CodexDesktopLive {
  if ($SkipCodexDesktop) {
    Set-StartupStatus -Name 'CodexDesktop' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    Set-StartupStatus -Name 'CodexFrontend' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    Set-StartupStatus -Name 'CodexStatusBadge' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    Set-StartupStatus -Name 'CodexRestartGuard' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    Set-StartupStatus -Name 'DesktopScript' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    return
  }

  Write-Step "检查 Codex 桌面实时通道"
  if (-not $ForceRestart -and (Test-DesktopLiveOnline)) {
    Write-Info "桌面实时通道已在线"
    $script:CodexFrontendRepairRestarted = $false
    if (-not (Ensure-CodexFrontendVisibleOrRepair)) {
      return
    }
    if (-not $script:CodexFrontendRepairRestarted) {
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '已在线，复用现有 Codex，未重启'
      Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '实时通道已在线，无需重启 Codex'
    }
    return
  }

  $cdpReady = Test-ExistingCdpReady
  $codexDesktopRunning = Test-CodexDesktopShellRunning
  $useSoftRecover = (-not $ForceRestart) -and $cdpReady
  if ($codexDesktopRunning -and -not $useSoftRecover) {
    $restartReason = if ($ForceRestart) { '-ForceRestart 请求强制重启' } else { '桌面实时通道缺失，需要重启注入 CDP' }
    Report-CodexActiveWorkBeforeRestart -Reason $restartReason
  } else {
    Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '当前流程不会停止现有 Codex'
  }
  $script = if ($useSoftRecover) {
    Join-Path $repoRoot 'scripts\recover-codex-desktop-live-soft.ps1'
  } else {
    Join-Path $repoRoot 'scripts\restart-codex-desktop-live.ps1'
  }
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $script,
    '-BridgeUrl', $BridgeUrl
  )
  $args = Add-OptionalStringArgument -Arguments $args -Name '-BridgeToken' -Value $BridgeToken
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $args += @('-SessionId', $SessionId)
  }

  if ($useSoftRecover) {
    if ($cdpReady) {
      Write-Info "CDP 已在线，将软恢复桌面实时通道，不重启 Codex"
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message 'CDP 已在线，软恢复 live-host，未重启 Codex'
    } else {
      Write-Warn "检测到 Codex 已运行但默认 CDP 不在线，将只软恢复；不会自动重启普通 Codex"
      Set-StartupStatus -Name 'CodexDesktop' -State 'degraded' -Message 'Codex 已运行但 CDP 不在线，尝试软恢复，默认不强制重启'
    }
  } elseif ($KeepExistingCodex) {
    Write-Info "按参数要求保留现有 Codex"
    Set-StartupStatus -Name 'CodexDesktop' -State 'degraded' -Message '按 -KeepExistingCodex 保留现有 Codex'
    $args += '-KeepExistingCodex'
  } elseif (-not $ForceRestart -and -not $codexDesktopRunning) {
    Write-Warn "未检测到正在运行的 Codex，将启动带 CDP 的 Codex 桌面"
    Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '未检测到 Codex，已启动带 CDP 的 Codex'
  } else {
    Write-Warn "桌面实时通道缺失，将启动/重启 Codex 并注入 CDP"
    Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '按 -ForceRestart 或缺失 live 通道，已启动/重启 Codex 并注入 CDP'
  }

  & $script:PowerShellHostPath @args
  if ($LASTEXITCODE -ne 0) {
    Set-StartupStatus -Name 'CodexDesktop' -State 'failed' -Message "启动/CDP 注入失败，退出码: $LASTEXITCODE"
    if ($useSoftRecover) {
      throw "Codex 桌面 live 软恢复失败，退出码: $LASTEXITCODE。当前检测到 Codex 已运行但没有可用 CDP，本脚本不会偷偷重启它；请关闭普通 Codex 后重试，或确认后使用 -ForceRestart。"
    }
    throw "Codex 桌面启动/CDP 注入失败，退出码: $LASTEXITCODE"
  }
  if (Test-DesktopLiveOnline) {
    [void](Update-CodexFrontendWindowStatus)
    if ($useSoftRecover) {
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '软恢复成功，复用现有 Codex，未重启'
    } elseif ($ForceRestart) {
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '已按 -ForceRestart 重启/启动并注入 CDP'
    } elseif (-not $codexDesktopRunning) {
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '已启动带 CDP 的 Codex'
    } else {
      Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message ([string](Get-StartupStatus -Name 'CodexDesktop').Message)
    }
  } else {
    Set-StartupStatus -Name 'CodexDesktop' -State 'degraded' -Message '脚本执行完成，但桌面实时通道尚未确认在线'
  }
}

function Test-BridgeApi {
  Write-Step "验证手机会话 API"
  $headers = Get-BridgeHeaders
  $health = Wait-BridgeHealth -TimeoutSeconds 10
  $run = Get-ObjectValue -Object $health -Name 'run' -Fallback $null
  $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
  Write-Info "Bridge health: run=$runId"

  $scriptStatus = Invoke-JsonSafe -Uri "$BridgeUrl/desktop/script/status" -Headers $headers -TimeoutSec 8
  if ($scriptStatus.Ok) {
    $bridge = Get-ObjectValue -Object $scriptStatus.Value -Name 'bridge' -Fallback $null
    $online = Get-ObjectValue -Object $bridge -Name 'online' -Fallback $false
    Write-Info "桌面实时通道: online=$online"
    if ([bool]$online) {
      Set-StartupStatus -Name 'DesktopScript' -State 'ok' -Message '脚本桥在线'
    } else {
      Set-StartupStatus -Name 'DesktopScript' -State 'degraded' -Message '脚本桥未在线'
    }
  } else {
    Write-Warn "桌面实时通道状态暂不可读: $($scriptStatus.Error)"
    Set-StartupStatus -Name 'DesktopScript' -State 'degraded' -Message "状态不可读: $($scriptStatus.Error)"
  }

  $threads = Invoke-JsonSafe -Uri "$BridgeUrl/api/codex/threads" -Headers $headers -TimeoutSec 12
  if ($threads.Ok) {
    $threadItems = Get-ObjectValue -Object $threads.Value -Name 'threads' -Fallback $null
    if ($null -eq $threadItems) {
      $threadItems = Get-ObjectValue -Object $threads.Value -Name 'items' -Fallback $threads.Value
    }
    Write-Info "会话 API 已响应: count=$(@($threadItems).Count)"
    Set-StartupStatus -Name 'SessionApi' -State 'ok' -Message "已响应 count=$(@($threadItems).Count)"
  } else {
    Write-Warn "会话 API 暂不可读: $($threads.Error)"
    Set-StartupStatus -Name 'SessionApi' -State 'degraded' -Message "暂不可读: $($threads.Error)"
  }
}

Stop-StaleLauncherWindows
Ensure-LocalBridge
Ensure-LocalBridgeWatchdog
Ensure-HdcRelay
Show-RelayState
Ensure-CodexDesktopLive
Ensure-DesktopLiveWatchdog
Test-BridgeApi

Write-FinalStartupSummary

Write-Step "一键状态补齐完成"
Write-Host "手机端 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "本地 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "日志目录: $logRoot" -ForegroundColor DarkGray
Write-Host "强制重建整条链路可追加参数: -ForceRestart" -ForegroundColor DarkGray
exit 0
