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
  [switch]$ForceRestart,
  [string]$LinkControlVersion = '',
  [string]$GuardianConfigVersion = '',
  [switch]$GuardianRepair,
  # 并行启动：All=主流程（默认，重活全部转后台轨道）；CodexDesktop=桌面子轨道；
  # Background=后台服务轨道（watchdog/语音/HDC/会话尾探，由主流程 fork，不 join）。
  [ValidateSet('All', 'CodexDesktop', 'Background')]
  [string]$Phase = 'All',
  # 桌面子轨道把状态/退出码写回该 JSON，供主流程 join 合并。
  [string]$TrackResultFile = '',
  # 一键回退旧的纯串行执行路径（也可设环境变量 CODEX_MOBILE_STACK_SERIAL=1）。
  [switch]$Serial
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
# 兜底诊断：terminating error 在 `& script *> log` 包装下不会进重定向（实验证实），
# 导致 exit 1 时看不到任何错误文本。任何未捕获 terminating error 都先把完整错误记录
# （含位置信息）追加写入固定文件 logs\startup\stack-fatal.log，再以 exit 1 退出；
# 并把错误首行写 stdout（*> 可捕获），使 manager-start.log 同样可见。
trap {
  try {
    $fatalDir = if (Get-Variable logRoot -ErrorAction SilentlyContinue) { $logRoot } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\startup' }
    New-Item -ItemType Directory -Force -Path $fatalDir -ErrorAction SilentlyContinue | Out-Null
    $detail = "=== $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff') PID=$PID phase=$Phase ===`r`n" +
      ($_ | Out-String) + "`r`n" +
      [string]$_.InvocationInfo.PositionMessage + "`r`n" +
      [string]$_.ScriptStackTrace + "`r`n"
    Add-Content -LiteralPath (Join-Path $fatalDir 'stack-fatal.log') -Value $detail -Encoding utf8
  } catch { }
  Write-Host ("一键启动遇到未处理错误: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
trap [OperationCanceledException] {
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  try {
    $fatalDir = if (Get-Variable logRoot -ErrorAction SilentlyContinue) { $logRoot } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\startup' }
    New-Item -ItemType Directory -Force -Path $fatalDir -ErrorAction SilentlyContinue | Out-Null
    $detail = "=== $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff') PID=$PID phase=$Phase kind=canceled ===`r`n" +
      ($_ | Out-String) + "`r`n" +
      [string]$_.ScriptStackTrace + "`r`n"
    Add-Content -LiteralPath (Join-Path $fatalDir 'stack-fatal.log') -Value $detail -Encoding utf8
  } catch { }
  # 桌面子轨道模式下，取消也必须把结果写回主流程（Write-DesktopTrackResult 在函数区定义，
  # 顶部 Assert 抛出时可能尚未定义，因此先探测再调用）。
  if (Get-Command Write-DesktopTrackResult -ErrorAction SilentlyContinue) {
    Write-DesktopTrackResult -ExitCode 12 -ErrorText ([string]$_.Exception.Message)
  }
  exit 12
}
function Assert-LinkBootstrapAllowed {
  Assert-MobileLinkLaunchIntent -Repo $repoRoot -LinkControlVersion $LinkControlVersion -GuardianConfigVersion $GuardianConfigVersion -GuardianRepair:$GuardianRepair
}
Assert-LinkBootstrapAllowed
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
# -Serial 或环境变量 CODEX_MOBILE_STACK_SERIAL=1 时完全回退旧的纯串行执行路径。
$script:UseSerialStartup = [bool]$Serial -or ("$env:CODEX_MOBILE_STACK_SERIAL" -eq '1')
$script:StackStartedAt = Get-Date
# 桌面实时通道最近一次在线探测结果（桌面子轨道用它回填 DesktopScript 状态）。
$script:LastDesktopLiveOnline = $false

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

function Get-StartupStatusState {
  param([string]$Name)
  # StrictMode 安全的状态读取：即使返回对象缺少 State 属性也按 'unknown' 处理。
  $status = Get-StartupStatus -Name $Name
  return [string](Get-ObjectValue -Object $status -Name 'State' -Fallback 'unknown')
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
  Write-StartupStatusLine -Label '语音隧道任务' -Name 'VoiceTunnel'

  $hardNames = switch ($RuntimeMode) {
    'app-server-primary' { @('LocalBridge', 'AppServerRuntime', 'SessionApi') }
    'desktop-primary' { @('LocalBridge', 'AppServerRuntime', 'CodexDesktop', 'DesktopScript', 'SessionApi') }
    default { @('LocalBridge', 'CodexDesktop', 'DesktopScript', 'SessionApi') }
  }
  $hardFailed = $false
  $hardDeferred = $false
  foreach ($name in $hardNames) {
    $state = [string](Get-StartupStatus -Name $name).State
    if ($state -eq 'failed' -or $state -eq 'degraded') {
      $hardFailed = $true
    } elseif ($state -eq 'unknown') {
      # 关键路径极简后，桌面/会话等状态由后台轨道确认中：不算失败，但退出码仍为 2
      # （控制脚本对 0/2 同样接受并继续其桌面恢复与状态收集）。
      $hardDeferred = $true
    }
  }
  $hdcState = [string](Get-StartupStatus -Name 'HdcTarget').State
  $voiceFailed = [string](Get-StartupStatus -Name 'VoiceTunnel').State -eq 'failed'
  $script:StartupExitCode = if ($hardFailed -or $hardDeferred -or $voiceFailed) { 2 } else { 0 }
  if ($hardFailed) {
    $unavailableMessage = if ($RuntimeMode -eq 'app-server-primary') {
      '整体状态：不可用，需要先修复 bridge / App Server 主链路。'
    } elseif ($RuntimeMode -eq 'desktop-primary') {
      '整体状态：不可用，需要先修复 bridge / App Server 兜底 / Codex 桌面实时通道。'
    } else {
      '整体状态：不可用，需要先修复 bridge / Codex 桌面实时通道。'
    }
    Write-Host "    $unavailableMessage" -ForegroundColor Red
  } elseif ($voiceFailed) {
    Write-Host '    整体状态：会话通道就绪，语音隧道任务异常，请查看统一状态。' -ForegroundColor Yellow
  } elseif ($hardDeferred) {
    Write-Host '    整体状态：关键链路已就绪；桌面/会话等状态已转后台轨道确认中，请稍后查看统一状态或日志。' -ForegroundColor Yellow
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
    Assert-LinkBootstrapAllowed
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-MatchingProcesses {
  param(
    [string]$Pattern,
    [switch]$RequireRepoPath,
    # 调用方已持有 Win32_Process 快照时可传入复用，避免一次运行内重复全量枚举。
    [object[]]$AllProcesses = @()
  )

  if ($AllProcesses.Count -eq 0) {
    $AllProcesses = @(Get-CimInstance Win32_Process)
  }
  $escapedRepo = [Regex]::Escape($repoRoot)
  return @($AllProcesses | Where-Object {
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
  $targets = @(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath:$RequireRepoPath -AllProcesses $allProcesses)
  foreach ($target in $targets) {
    Write-Info "停止旧进程树 PID=$($target.ProcessId): $Pattern"
    Stop-ProcessTree -ProcessId ([int]$target.ProcessId) -AllProcesses $allProcesses
  }
}

function Stop-StaleLauncherWindows {
  Write-Step "整理一键启动窗口"
  # 关键路径条件化：桥端口空闲说明当前没有旧实例占着链路（残留引导窗口自身也会随
  # Wait-BridgeHealth 超时退出），跳过整套 WMI 全量扫描；端口被占或 -Serial 时才跑
  # 原完整清理（保持原语义：有旧窗口/旧进程时仍要清理）。
  if (-not $script:UseSerialStartup -and -not (Test-LocalPortListening -HostAddress '127.0.0.1' -Port $BridgePort)) {
    Write-Info "桥端口 $BridgePort 空闲，跳过旧启动窗口扫描"
    return
  }
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

  $launchers = @(Get-MatchingProcesses -Pattern 'start-codex-mobile-stack\.ps1' -RequireRepoPath -AllProcesses $allProcesses | Where-Object {
    -not $protectedProcessIds.Contains([int]$_.ProcessId)
  })
  if ($launchers.Count -eq 0) {
    Write-Info "没有旧的一键启动窗口"
    return
  }
  foreach ($launcher in $launchers) {
    Write-Info "关闭旧的一键启动窗口 PID=$($launcher.ProcessId)"
    Assert-LinkBootstrapAllowed
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
  param(
    [int]$TimeoutSeconds = 25,
    [int]$IntervalMilliseconds = 700
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = ''
  while ((Get-Date) -lt $deadline) {
    $probe = Get-LocalBridgeHealth
    if ($probe.Ok) {
      return $probe.Value
    }
    $lastError = $probe.Error
    Start-Sleep -Milliseconds $IntervalMilliseconds
  }
  throw "Bridge 健康检查失败: $BridgeUrl/health; $lastError"
}

# 以下三个条件等待把「停止旧进程后的固定 sleep」改成「等到可检查条件满足或超时」；
# -Serial 模式下不做条件等待，直接复现旧的固定 sleep。
function Wait-PortFreeOrFixedSleep {
  param(
    [string]$HostAddress,
    [int]$Port,
    [int]$LegacyMilliseconds,
    [int]$TimeoutSeconds = 3
  )

  if ($script:UseSerialStartup) {
    Start-Sleep -Milliseconds $LegacyMilliseconds
    return
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and (Test-LocalPortListening -HostAddress $HostAddress -Port $Port)) {
    Start-Sleep -Milliseconds 100
  }
}

function Wait-MatchingProcessGoneOrFixedSleep {
  param(
    [string]$Pattern,
    [int]$LegacyMilliseconds,
    [int]$TimeoutSeconds = 3
  )

  if ($script:UseSerialStartup) {
    Start-Sleep -Milliseconds $LegacyMilliseconds
    return
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and @(Get-MatchingProcesses -Pattern $Pattern -RequireRepoPath).Count -gt 0) {
    Start-Sleep -Milliseconds 200
  }
}

function Wait-RelayStateOrFixedSleep {
  param(
    [hashtable]$Config,
    [int]$LegacySeconds,
    [int]$TimeoutSeconds = 3
  )

  if ($script:UseSerialStartup) {
    Start-Sleep -Seconds $LegacySeconds
    return
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $probe = Get-RelayStateSafe -Config $Config
    if ($probe.Ok) {
      return
    }
    Start-Sleep -Milliseconds 400
  }
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
  # 直接以本进程环境拉起 node，省去 pwsh 包装层的启动开销（冷启动关键路径）。
  # 注入的变量与原包装层逐项一致；voice 变量由顶部 voice\voice_server.py 存在性守卫。
  # 这些变量仅用于 bridge 子进程；其余轨道子进程均以显式参数接收自己的凭据。
  $env:CODEX_BRIDGE_HOST='0.0.0.0'
  $env:CODEX_BRIDGE_PORT="$BridgePort"
  $env:CODEX_BRIDGE_WORKSPACE="$repoRoot"
  $env:CODEX_BRIDGE_TOKEN="$BridgeToken"
  $env:CODEX_BRIDGE_TOTP_SECRET="$BridgeTotpSecret"
  $env:CODEX_BRIDGE_PUBLIC_URL="$BridgePublicUrl"
  $env:CODEX_BRIDGE_ADAPTER='codex'
  $env:CODEX_BRIDGE_RUNTIME_MODE="$RuntimeMode"
  $env:CODEX_BRIDGE_APP_SERVER_CANARY_THREADS="$CanaryThreadIds"
  $env:CODEX_BRIDGE_VOICE_ENABLED="$VoiceEnabledText"
  $env:CODEX_BRIDGE_VOICE_COMMAND="$VoiceCommand"
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Assert-LinkBootstrapAllowed
  # 直接拉起 node 后命令行不再包含 repo 根路径，lifecycle 的归属判定
  # （Get-MobileLinkOwnedProcesses 按 $root\ 或 $root/ 匹配）会把 bridge 当外部
  # 进程：Stop 杀不掉、Start 因端口属主未知而拒绝。附加一个脚本不解析的
  # argv 标记（正斜杠形式，避免结尾反斜杠+引号的转义歧义）恢复归属可见性。
  $workspaceMarker = '--codex-bridge-workspace=' + $repoRoot.Replace('\','/') + '/'
  Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList @('src/server.js', $workspaceMarker) -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
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

  # 起桥前清理条件化：探活已确认离线且端口空闲时，不存在需要停止的占用者，
  # 跳过两轮 WMI 全量扫描（-Serial 保持原无条件清理路径）。
  if ($script:UseSerialStartup -or (Test-LocalPortListening -HostAddress '127.0.0.1' -Port $BridgePort)) {
    Stop-ProjectProcess -Pattern 'src[\\/]server\.js'
    Stop-BridgePortOwner -Port $BridgePort
    Wait-PortFreeOrFixedSleep -HostAddress '127.0.0.1' -Port $BridgePort -LegacyMilliseconds 500
  }
  Start-LocalBridgeProcess
  $health = Wait-BridgeHealth -TimeoutSeconds 25 -IntervalMilliseconds 250
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
  Assert-LinkBootstrapAllowed
  Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList $argumentList -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  Write-Info "$DisplayName 已启动"
}

function Ensure-LocalBridgeWatchdog {
  Write-Step "检查本地 bridge 自动恢复"
  $expectedArgument = '-RuntimeMode\s+[''" ]?' + [regex]::Escape($RuntimeMode) + '(?:[''"]|\s|$)'
  $allProcesses = @(Get-CimInstance Win32_Process)
  $staleWatchdogs = @(Get-MatchingProcesses -Pattern 'watch-local-bridge\.ps1' -RequireRepoPath -AllProcesses $allProcesses | Where-Object {
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
  Assert-LinkBootstrapAllowed
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
    Wait-MatchingProcessGoneOrFixedSleep -Pattern 'start-hdc-relay\.ps1.*\bBridgeProxy\b|bridge:relay-proxy|start-bridge-proxy\.mjs' -LegacyMilliseconds 500
    Start-RelayProcess -Mode 'BridgeProxy' -Name 'bridge-proxy'
    Wait-RelayStateOrFixedSleep -Config $Config -LegacySeconds 2

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
  Wait-MatchingProcessGoneOrFixedSleep -Pattern 'start-hdc-relay\.ps1.*\bProxy\b|hdc:proxy|start-local-proxy\.mjs|HDC_PROXY_PORT' -LegacyMilliseconds 500
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
      Assert-LinkBootstrapAllowed
      & $hdcPath kill -r 2>&1 | Out-Null
      Start-Sleep -Milliseconds 700
    }
    Write-Info "执行 hdc tconn $target"
    Assert-LinkBootstrapAllowed
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
        Assert-LinkBootstrapAllowed
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
    Wait-MatchingProcessGoneOrFixedSleep -Pattern 'watch-hdc-connection\.ps1|watch-bridge-proxy\.ps1|start-hdc-relay\.ps1' -LegacyMilliseconds 600
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
  $script:LastDesktopLiveOnline = $false
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
  $script:LastDesktopLiveOnline = $true
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
    Assert-LinkBootstrapAllowed
    Start-Process -FilePath $codexExe -WorkingDirectory (Split-Path -Parent $codexExe) | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 500
      if (Update-CodexFrontendWindowStatus) {
        return $true
      }
    }
  } catch [OperationCanceledException] {
    throw
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
  Assert-LinkBootstrapAllowed
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

  Assert-LinkBootstrapAllowed
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

# ---------- 并行轨道（默认并行模式；-Serial 不经过这些函数） ----------
# 桌面轨道 = 本脚本以 -Phase CodexDesktop 子进程再次运行，只跑 Codex 桌面段；
# 主流程同时在本进程内跑 HDC 链路段，最后通过结果文件 join 并合并退出码语义。
function Write-DesktopTrackResult {
  param(
    [int]$ExitCode,
    [string]$ErrorText
  )

  if ([string]::IsNullOrWhiteSpace($TrackResultFile)) {
    return
  }
  try {
    $statuses = @()
    foreach ($key in @($script:StartupStatus.Keys)) {
      $status = $script:StartupStatus[$key]
      $statuses += [pscustomobject]@{
        name = [string]$key
        state = [string]$status.State
        message = [string]$status.Message
      }
    }
    [pscustomobject]@{
      pid = $PID
      exitCode = $ExitCode
      error = $ErrorText
      finishedAt = [datetime]::UtcNow.ToString('o')
      statuses = $statuses
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TrackResultFile -Encoding utf8
  } catch {
    # 顶层 trap 可能在 Write-Warn 等函数定义前调用本函数，这里只用 Write-Host。
    Write-Host "    写入桌面轨道结果失败: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Start-DesktopTrackProcess {
  $resultFile = Join-Path $logRoot ("desktop-track.{0}.result.json" -f $PID)
  Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
  $trackArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $PSCommandPath,
    '-Phase', 'CodexDesktop',
    '-TrackResultFile', $resultFile,
    '-BridgePort', "$BridgePort"
  )
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeToken' -Value $BridgeToken
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeTotpSecret' -Value $BridgeTotpSecret
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgePublicUrl' -Value $BridgePublicUrl
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeUrl' -Value $BridgeUrl
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-RuntimeMode' -Value $RuntimeMode
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-CanaryThreadIds' -Value $CanaryThreadIds
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-ConfigPath' -Value $ConfigPath
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-SessionId' -Value $SessionId
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-LinkControlVersion' -Value $LinkControlVersion
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-GuardianConfigVersion' -Value $GuardianConfigVersion
  if ($KeepExistingCodex) { $trackArgs += '-KeepExistingCodex' }
  if ($ForceRestart) { $trackArgs += '-ForceRestart' }
  if ($GuardianRepair) { $trackArgs += '-GuardianRepair' }
  Assert-LinkBootstrapAllowed
  $process = Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList $trackArgs -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $logRoot 'desktop-track.stdout.log') -RedirectStandardError (Join-Path $logRoot 'desktop-track.stderr.log') -PassThru
  return [pscustomobject]@{
    Process = $process
    ResultFile = $resultFile
  }
}

# 后台服务轨道：watchdog + 语音 + HDC 全家 + 会话链路收尾探测。fork 后不 join、
# 不阻塞主流程退出；状态快照写结果文件供诊断，watchdog/guardian 负责兜底恢复。
function Start-ServicesTrackProcess {
  $resultFile = Join-Path $logRoot ("background-track.{0}.result.json" -f $PID)
  Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
  $trackArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $PSCommandPath,
    '-Phase', 'Background',
    '-TrackResultFile', $resultFile,
    '-BridgePort', "$BridgePort"
  )
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeToken' -Value $BridgeToken
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeTotpSecret' -Value $BridgeTotpSecret
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgePublicUrl' -Value $BridgePublicUrl
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-BridgeUrl' -Value $BridgeUrl
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-RuntimeMode' -Value $RuntimeMode
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-CanaryThreadIds' -Value $CanaryThreadIds
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-ConfigPath' -Value $ConfigPath
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-SessionId' -Value $SessionId
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-LinkControlVersion' -Value $LinkControlVersion
  $trackArgs = Add-OptionalStringArgument -Arguments $trackArgs -Name '-GuardianConfigVersion' -Value $GuardianConfigVersion
  if ($KeepExistingCodex) { $trackArgs += '-KeepExistingCodex' }
  if ($ForceRestart) { $trackArgs += '-ForceRestart' }
  if ($GuardianRepair) { $trackArgs += '-GuardianRepair' }
  if ($SkipHdcRelay) { $trackArgs += '-SkipHdcRelay' }
  if ($SkipCodexDesktop) { $trackArgs += '-SkipCodexDesktop' }
  Assert-LinkBootstrapAllowed
  return Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList $trackArgs -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $logRoot 'background-track.stdout.log') -RedirectStandardError (Join-Path $logRoot 'background-track.stderr.log') -PassThru
}

# Show-RelayState 是纯展示步骤：fork 成后台进程与桌面/HDC 轨道并行，末尾只做有界等待。
function Start-RelayStateTrack {
  $relayArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $repoRoot 'tools\harmony\check-relay-state.ps1'),
    '-ConfigPath', $ConfigPath,
    '-SkipDesktopScreenshot'
  )
  $relayArgs = Add-OptionalStringArgument -Arguments $relayArgs -Name '-BridgeToken' -Value $BridgeToken
  Assert-LinkBootstrapAllowed
  return Start-Process -WindowStyle Hidden -FilePath $script:PowerShellHostPath -ArgumentList $relayArgs -WorkingDirectory $repoRoot -RedirectStandardOutput (Join-Path $logRoot 'relay-state.stdout.log') -RedirectStandardError (Join-Path $logRoot 'relay-state.stderr.log') -PassThru
}

function Test-BridgeApi {
  if (-not $script:UseSerialStartup) {
    # 关键路径收尾只保留一次 /health 快速确认（Ensure-LocalBridge 刚以 10s 预算验证过；
    # 此处再失败说明 bridge 在数秒内真正死亡，按原语义抛错 exit 1，不再重试等待）。
    # DesktopScript/SessionApi 探测整体移入后台服务轨道收尾：冷启动时桌面恢复
    # （由控制脚本在栈退出后执行）完成前 sessions 探测必然超时，且密集轮询
    # /codex/sessions 会触发按源 429 限流连累 /health。
    Write-Step "验证手机会话 API"
    $probe = Get-LocalBridgeHealth
    if (-not $probe.Ok) {
      throw "Bridge 健康检查失败: $BridgeUrl/health; $($probe.Error)"
    }
    $run = Get-ObjectValue -Object $probe.Value -Name 'run' -Fallback $null
    $runId = Get-ObjectValue -Object $run -Name 'runId' -Fallback 'unknown'
    Write-Info "Bridge health: run=$runId（桌面/会话状态由后台轨道确认）"
    return
  }

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

# ---------- 主入口拓扑 ----------
if ($Phase -eq 'CodexDesktop') {
  # 桌面子轨道：由主流程以子进程调用（bridge 已由主流程拉起），只跑 Codex 桌面段，
  # 结束时把状态快照与退出码写回 -TrackResultFile 供主流程 join。
  $trackErrorText = ''
  try {
    Ensure-CodexDesktopLive
    Ensure-DesktopLiveWatchdog
    if ((Get-StartupStatusState -Name 'CodexDesktop') -eq 'skipped') {
      Set-StartupStatus -Name 'DesktopScript' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'
    } elseif ($script:LastDesktopLiveOnline) {
      Set-StartupStatus -Name 'DesktopScript' -State 'ok' -Message '脚本桥在线'
    } else {
      Set-StartupStatus -Name 'DesktopScript' -State 'degraded' -Message '脚本桥未在线'
    }
  } catch [OperationCanceledException] {
    throw
  } catch {
    $trackErrorText = $_.Exception.Message
    Write-Warn "Codex 桌面轨道失败: $trackErrorText"
  }
  if ([string]::IsNullOrWhiteSpace($trackErrorText)) {
    Write-DesktopTrackResult -ExitCode 0 -ErrorText ''
    exit 0
  }
  Write-DesktopTrackResult -ExitCode 1 -ErrorText $trackErrorText
  exit 1
}

if ($Phase -eq 'Background') {
  # 后台服务轨道：watchdog + 语音 + HDC 全家 + 会话链路收尾探测。主流程不 join 本
  # 轨道；状态快照与退出码写 -TrackResultFile 供诊断，watchdog/guardian 兜底恢复。
  # 会话探测刻意温和（尝试 2 次、间隔 ≥3s），避免 /codex/sessions 按源 429 限流连累 /health。
  $trackErrorText = ''
  try {
    Ensure-LocalBridgeWatchdog
    Ensure-DesktopLiveWatchdog
    . (Join-Path $repoRoot 'tools\windows\mobile-voice-tunnel.ps1')
    try {
      Assert-LinkBootstrapAllowed
      Ensure-MobileVoiceTunnel $repoRoot -CanStart { Assert-LinkBootstrapAllowed; $true }
      Set-StartupStatus -Name 'VoiceTunnel' -State 'ok' -Message '任务检查完成；实际转发与通话请查看统一状态'
    } catch [OperationCanceledException] {
      throw
    } catch {
      Set-StartupStatus -Name 'VoiceTunnel' -State 'failed' -Message '语音隧道配置、绑定或任务恢复失败；其他通道继续检测'
    }
    Ensure-HdcRelay
    if ((Get-StartupStatusState -Name 'DesktopScript') -eq 'unknown') {
      $desktopOnline = $false
      foreach ($attempt in 1..2) {
        if (Test-DesktopLiveOnline) {
          $desktopOnline = $true
          break
        }
        if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
      }
      if ($desktopOnline) {
        Set-StartupStatus -Name 'DesktopScript' -State 'ok' -Message '脚本桥在线（后台确认）'
      } else {
        Set-StartupStatus -Name 'DesktopScript' -State 'degraded' -Message '脚本桥未在线（后台确认，可稍后在统一状态重试）'
      }
    }
    $sessionOnline = $false
    $threadCount = 0
    $threadError = ''
    foreach ($attempt in 1..2) {
      $threads = Invoke-JsonSafe -Uri "$BridgeUrl/api/codex/threads" -Headers (Get-BridgeHeaders) -TimeoutSec 8
      if ($threads.Ok) {
        $sessionOnline = $true
        $threadItems = Get-ObjectValue -Object $threads.Value -Name 'threads' -Fallback $null
        if ($null -eq $threadItems) {
          $threadItems = Get-ObjectValue -Object $threads.Value -Name 'items' -Fallback $threads.Value
        }
        $threadCount = @($threadItems).Count
        break
      }
      $threadError = [string]$threads.Error
      if ($attempt -lt 2) { Start-Sleep -Seconds 4 }
    }
    if ($sessionOnline) {
      Write-Info "会话 API 已响应: count=$threadCount（后台确认）"
      Set-StartupStatus -Name 'SessionApi' -State 'ok' -Message "已响应 count=$threadCount（后台确认）"
    } else {
      Write-Warn "会话 API 暂不可读（后台确认）: $threadError"
      Set-StartupStatus -Name 'SessionApi' -State 'degraded' -Message "暂不可读（后台确认，可稍后在统一状态重试）: $threadError"
    }
  } catch [OperationCanceledException] {
    throw
  } catch {
    $trackErrorText = $_.Exception.Message
    Write-Warn "后台服务轨道失败: $trackErrorText"
  }
  if ([string]::IsNullOrWhiteSpace($trackErrorText)) {
    Write-DesktopTrackResult -ExitCode 0 -ErrorText ''
    exit 0
  }
  Write-DesktopTrackResult -ExitCode 1 -ErrorText $trackErrorText
  exit 1
}

if ($script:UseSerialStartup) {
  # 旧纯串行路径（-Serial / CODEX_MOBILE_STACK_SERIAL=1），逐行复现改造前执行顺序。
  Stop-StaleLauncherWindows
  Ensure-LocalBridge
  Ensure-LocalBridgeWatchdog
  Ensure-HdcRelay
  Show-RelayState
  Ensure-CodexDesktopLive
  Ensure-DesktopLiveWatchdog
  . (Join-Path $repoRoot 'tools\windows\mobile-voice-tunnel.ps1')
  try {
    Assert-LinkBootstrapAllowed
    Ensure-MobileVoiceTunnel $repoRoot -CanStart { Assert-LinkBootstrapAllowed; $true }
    Set-StartupStatus -Name 'VoiceTunnel' -State 'ok' -Message '任务检查完成；实际转发与通话请查看统一状态'
  } catch [OperationCanceledException] {
    throw
  } catch {
    Set-StartupStatus -Name 'VoiceTunnel' -State 'failed' -Message '语音隧道配置、绑定或任务恢复失败；其他通道继续检测'
  }
} else {
  # 关键路径极简（默认）：条件化清场 → bridge → 单次 /health → 退出。
  # 其余全部转后台轨道，fork 后不 join、不阻塞退出；退出码 2 表示关键链路已就绪、
  # 其余状态由后台轨道确认中，bridge 失败仍按原语义抛错 exit 1。
  Stop-StaleLauncherWindows
  Ensure-LocalBridge
  if (-not $SkipHdcRelay) {
    try {
      Start-RelayStateTrack | Out-Null
      Write-Info '公网 bridge/HDC 状态检查已在后台启动'
    } catch [OperationCanceledException] {
      throw
    } catch {
      Write-Warn "公网 bridge/HDC 状态检查启动失败: $($_.Exception.Message)"
    }
  }
  if (-not $SkipCodexDesktop) {
    try {
      Start-DesktopTrackProcess | Out-Null
      Write-Info 'Codex 桌面轨道已在后台启动（不等待）'
    } catch [OperationCanceledException] {
      throw
    } catch {
      Write-Warn "Codex 桌面轨道启动失败: $($_.Exception.Message)"
      Set-StartupStatus -Name 'CodexDesktop' -State 'degraded' -Message '桌面轨道未能启动'
    }
  } else {
    Ensure-CodexDesktopLive
    Ensure-DesktopLiveWatchdog
  }
  try {
    Start-ServicesTrackProcess | Out-Null
    Write-Info '后台服务轨道已在启动（watchdog/语音/HDC/会话确认）'
  } catch [OperationCanceledException] {
    throw
  } catch {
    Write-Warn "后台服务轨道启动失败: $($_.Exception.Message)"
  }
}
Test-BridgeApi

Assert-LinkBootstrapAllowed
Write-FinalStartupSummary

Write-Step "一键状态补齐完成"
Write-Host "手机端 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "本地 bridge: $BridgeUrl" -ForegroundColor Green
Write-Host "日志目录: $logRoot" -ForegroundColor DarkGray
Write-Host "强制重建整条链路可追加参数: -ForceRestart" -ForegroundColor DarkGray
exit $script:StartupExitCode
