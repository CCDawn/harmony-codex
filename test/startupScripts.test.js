import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function readScript(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('direct Windows PowerShell startup entrypoints keep a UTF-8 BOM for Chinese diagnostics', () => {
  for (const filePath of [
    'scripts/agent/start-stack-interactive.ps1',
    'scripts/agent/start-stack.ps1',
    'scripts/start-codex-mobile-stack.ps1',
    'tools/harmony/deploy.ps1'
  ]) {
    const prefix = fs.readFileSync(path.resolve(filePath)).subarray(0, 3);
    assert.deepEqual([...prefix], [0xef, 0xbb, 0xbf], filePath);
  }
});

test('startup stack preserves bridge token for desktop live recovery paths', () => {
  const text = readScript('scripts/start-codex-mobile-stack.ps1');

  assert.match(text, /\[string\]\$BridgeToken = \$env:CODEX_BRIDGE_TOKEN/);
  assert.match(text, /\$env:CODEX_BRIDGE_TOKEN='\$BridgeToken'/);
  assert.match(text, /recover-codex-desktop-live-soft\.ps1/);
  assert.match(text, /restart-codex-desktop-live\.ps1/);
  assert.match(text, /Add-OptionalStringArgument -Arguments \$args -Name '-BridgeToken' -Value \$BridgeToken/);
});

test('startup stack reuses a compatible PowerShell host for child scripts', () => {
  const text = readScript('scripts/start-codex-mobile-stack.ps1');

  assert.match(text, /function Resolve-CompatiblePowerShellHost/);
  assert.match(text, /\$script:PowerShellHostPath = Resolve-CompatiblePowerShellHost/);
  assert.match(text, /-FilePath \$script:PowerShellHostPath/);
  assert.match(text, /& \$script:PowerShellHostPath @args/);
  assert.doesNotMatch(text, /-FilePath 'powershell\.exe'/);
  assert.doesNotMatch(text, /& powershell\.exe @args/);
});

test('startup watchdogs reuse their current PowerShell host when recovering children', () => {
  for (const filePath of [
    'tools/harmony/watch-local-bridge.ps1',
    'tools/harmony/watch-bridge-proxy.ps1',
    'tools/harmony/watch-hdc-connection.ps1'
  ]) {
    const text = readScript(filePath);
    assert.match(text, /\$powerShellHostPath = Resolve-CompatiblePowerShellHost/);
    assert.match(text, /function Resolve-CompatiblePowerShellHost/);
    assert.match(text, /-FilePath \$powerShellHostPath/);
    assert.doesNotMatch(text, /-FilePath 'powershell\.exe'/);
  }
});

test('remote main update reuses a compatible PowerShell host for its watcher and deploy', () => {
  const text = readScript('tools/harmony/remote-update-main.ps1');

  assert.match(text, /function Resolve-CompatiblePowerShellHost/);
  assert.match(text, /\$powerShellHostPath = Resolve-CompatiblePowerShellHost/);
  assert.match(text, /-FilePath \$powerShellHostPath/);
  assert.match(text, /& \$powerShellHostPath @deployArgs/);
  assert.doesNotMatch(text, /-FilePath 'powershell\.exe'/);
  assert.doesNotMatch(text, /& powershell @deployArgs/);
});

test('relay connector reuses a compatible PowerShell host when restarting its local proxy', () => {
  const text = readScript('tools/harmony/connect-relay-hdc.ps1');

  assert.match(text, /function Resolve-CompatiblePowerShellHost/);
  assert.match(text, /\$powerShellHostPath = Resolve-CompatiblePowerShellHost/);
  assert.match(text, /-FilePath \$powerShellHostPath/);
  assert.doesNotMatch(text, /-FilePath 'powershell(?:\.exe)?'/);
});

test('desktop relaunch stays behind the tray switch and refuses a plain Codex window', () => {
  const restart = readScript('scripts/restart-codex-desktop-live.ps1');
  const watchdog = readScript('tools/harmony/watch-desktop-live.ps1');
  assert.match(restart, /Sort-Object -Property @\{ Expression = \{ try \{ \[version\]\$_.Version \}/);
  assert.match(restart, /\[switch\]\$RefusePlainCodex/);
  assert.match(restart, /exit 11/);
  assert.match(restart, /exit 10/);
  assert.match(watchdog, /function Test-DesktopSupervisorArmed/);
  assert.match(watchdog, /桌面应用未开，不自动拉起/);
  assert.match(watchdog, /-RefusePlainCodex/);
});

test('local bridge watchdog derives its token from config instead of a process argument', () => {
  const stackText = readScript('scripts/start-codex-mobile-stack.ps1');
  const watchdogText = readScript('tools/harmony/watch-local-bridge.ps1');
  const start = stackText.indexOf('function Ensure-LocalBridgeWatchdog');
  const end = stackText.indexOf('function Start-RelayProcess', start);
  const watchdogStartBody = stackText.slice(start, end);

  assert.match(watchdogText, /BridgeConfig\.ets/);
  assert.match(watchdogText, /DEFAULT_BRIDGE_TOKEN/);
  assert.doesNotMatch(watchdogStartBody, /-Name '-BridgeToken'/);
});

test('both local bridge launchers inject voice env guarded by the voice server file', () => {
  for (const filePath of [
    'scripts/start-codex-mobile-stack.ps1',
    'tools/harmony/watch-local-bridge.ps1'
  ]) {
    const text = readScript(filePath);
    assert.match(text, /voice\\voice_server\.py/);
    assert.match(text, /Test-Path -LiteralPath \$voiceServerPath/);
    assert.match(text, /CODEX_BRIDGE_VOICE_ENABLED/);
    assert.match(text, /CODEX_BRIDGE_VOICE_COMMAND/);
    assert.match(text, /CODEX_BRIDGE_VOICE_ENABLED='\$VoiceEnabledText'/);
    assert.match(text, /CODEX_BRIDGE_VOICE_COMMAND='\$VoiceCommand'/);
  }
});

test('local bridge watchdog re-derives TOTP secret and public URL from app config on restarts', () => {
  const watchdogText = readScript('tools/harmony/watch-local-bridge.ps1');

  assert.match(watchdogText, /\[string\]\$BridgeTotpSecret = \$env:CODEX_BRIDGE_TOTP_SECRET/);
  assert.match(watchdogText, /\[string\]\$BridgePublicUrl = \$env:CODEX_BRIDGE_PUBLIC_URL/);
  assert.match(watchdogText, /DEFAULT_BRIDGE_TOTP_SECRET/);
  assert.match(watchdogText, /DEFAULT_BRIDGE_URL/);
  assert.match(watchdogText, /\$env:CODEX_BRIDGE_TOTP_SECRET='\$BridgeTotpSecret'/);
  assert.match(watchdogText, /\$env:CODEX_BRIDGE_PUBLIC_URL='\$BridgePublicUrl'/);
});

test('bridge proxy watchdog authenticates its local health probe from app config', () => {
  const watchdogText = readScript('tools/harmony/watch-bridge-proxy.ps1');

  assert.match(watchdogText, /BridgeConfig\.ets/);
  assert.match(watchdogText, /DEFAULT_BRIDGE_TOKEN/);
  assert.match(watchdogText, /X-Codex-Bridge-Token/);
});

test('interactive desktop launcher preserves startup failures for diagnosis', () => {
  const text = readScript('scripts/agent/start-stack-interactive.ps1');

  assert.match(text, /& \$startScript -ForceRestart/);
  assert.match(text, /desktop-launcher-transcript\.log/);
  assert.match(text, /desktop-launcher-error\.log/);
  assert.match(text, /catch \{/);
  assert.match(text, /Read-Host '按 Enter 关闭窗口'/);
  assert.match(text, /Codex 远程模式启动失败，窗口将保留/);
});

test('desktop startup targets the packaged ChatGPT shell instead of the Codex activation wrapper', () => {
  const stackText = readScript('scripts/start-codex-mobile-stack.ps1');
  const restartText = readScript('scripts/restart-codex-desktop-live.ps1');

  assert.match(stackText, /OpenAI\\\.Codex_/);
  assert.match(stackText, /ChatGPT\\\.exe/);
  assert.match(stackText, /GetProcessesByName\('ChatGPT'\)/);
  assert.match(restartText, /\$codexDesktopExe/);
  assert.match(restartText, /Join-Path \$codexAppDir 'ChatGPT\.exe'/);
  assert.match(restartText, /Start-Process -FilePath \$codexDesktopExe/);
  assert.match(restartText, /OpenAI\\\.Codex_/);
});

test('startup stack prints final degraded status instead of hiding HDC failures', () => {
  const text = readScript('scripts/start-codex-mobile-stack.ps1');

  assert.match(text, /\$script:StartupStatus = \[ordered\]@\{\}/);
  assert.match(text, /function Set-StartupStatus/);
  assert.match(text, /function Write-FinalStartupSummary/);
  assert.match(text, /Write-StartupStatusLine -Label 'Codex 重启保护' -Name 'CodexRestartGuard'/);
  assert.match(text, /Write-StartupStatusLine -Label 'Codex 前端窗口' -Name 'CodexFrontend'/);
  assert.match(text, /Write-StartupStatusLine -Label 'Codex 前端状态条' -Name 'CodexStatusBadge'/);
  assert.match(text, /Write-StartupStatusLine -Label 'HDC 目标' -Name 'HdcTarget'/);
  assert.match(text, /手机会话可用，HDC 部署\/抓日志链路正在等待手机中继恢复/);
  assert.match(text, /Set-StartupStatus -Name 'HdcTarget' -State 'degraded'/);
  assert.match(text, /Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '桌面实时通道已在线，复用现有 Codex，未重启'|Set-StartupStatus -Name 'CodexDesktop' -State 'ok' -Message '已在线，复用现有 Codex，未重启'/);
  assert.match(text, /Set-StartupStatus -Name 'CodexRestartGuard' -State 'ok' -Message '实时通道已在线，无需重启 Codex'/);
  assert.match(text, /function Update-CodexFrontendWindowStatus/);
  assert.match(text, /function Ensure-CodexFrontendVisibleOrRepair/);
  assert.match(text, /function Show-CodexFrontendWindow/);
  assert.match(text, /function Repair-CodexFrontendWindowWithLiveRestart/);
  assert.match(text, /MainWindowHandle/);
  assert.match(text, /手机消息链路可继续使用/);
  assert.match(text, /if \(-not \(Ensure-CodexFrontendVisibleOrRepair\)\) \{/);
  assert.match(text, /桌面实时通道在线但未检测到 Codex 前端窗口/);
  assert.match(text, /前端缺失已修复，Codex 已带 CDP 重新在线/);
  assert.match(text, /\$script:CodexFrontendRepairRestarted/);
  assert.match(text, /Set-StartupStatus -Name 'CodexRestartGuard' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'/);
  assert.match(text, /Set-StartupStatus -Name 'CodexFrontend' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'/);
  assert.match(text, /Set-StartupStatus -Name 'CodexStatusBadge' -State 'skipped' -Message '按参数跳过 Codex 桌面检查'/);
  assert.match(text, /软恢复成功，复用现有 Codex，未重启/);
  assert.match(text, /Write-FinalStartupSummary\s*\r?\n\s*Write-Step "一键状态补齐完成"/);
});

test('startup stack reports active Codex work without blocking restart', () => {
  const text = readScript('scripts/start-codex-mobile-stack.ps1');

  assert.match(text, /function Get-ActiveCodexWorkGuard/);
  assert.match(text, /\/tasks/);
  assert.match(text, /\/api\/codex\/threads/);
  assert.match(text, /function Report-CodexActiveWorkBeforeRestart/);
  assert.match(text, /检测到活跃 Codex 状态但不阻塞重启/);
  assert.match(text, /发现 \$\(\$guard\.ActiveCount\) 个活跃状态，但按配置不阻塞 Codex 重启/);
  assert.match(text, /if \(\$codexDesktopRunning -and -not \$useSoftRecover\)/);
  assert.match(text, /Report-CodexActiveWorkBeforeRestart -Reason \$restartReason/);
  assert.doesNotMatch(text, /if \(Block-CodexRestartIfActiveWork -Reason \$restartReason\)/);
  assert.doesNotMatch(text, /已阻塞 Codex 重启/);
});

test('startup stack does not soft-recover ordinary Codex without CDP', () => {
  const text = readScript('scripts/start-codex-mobile-stack.ps1');

  assert.match(text, /function Get-CandidateCdpPorts/);
  assert.match(text, /logs\\desktop-live-status\.json/);
  assert.match(text, /remote-debugging-port=/);
  assert.match(text, /function Test-ExistingCdpReady/);
  assert.match(text, /Set-StartupStatus -Name 'CodexStatusBadge' -State 'degraded' -Message '脚本桥在线，但 CDP 不可探测；前端状态条无法校验，下一次注入后会自绘'/);
  assert.match(text, /\$cdpReady = Test-ExistingCdpReady/);
  assert.match(text, /\$useSoftRecover = \(-not \$ForceRestart\) -and \$cdpReady/);
  assert.doesNotMatch(text, /\$useSoftRecover = \(-not \$ForceRestart\) -and \(\$cdpReady -or \$codexDesktopRunning\)/);
});

test('desktop live host launch scripts export bridge token', () => {
  for (const filePath of [
    'scripts/restart-codex-desktop-live.ps1',
    'scripts/recover-codex-desktop-live-soft.ps1'
  ]) {
    const text = readScript(filePath);
    assert.match(text, /\[string\]\$BridgeToken = \$env:CODEX_BRIDGE_TOKEN/);
    assert.match(text, /\$env:CODEX_BRIDGE_URL='\$BridgeUrl'/);
    assert.match(text, /\$env:CODEX_BRIDGE_TOKEN='\$BridgeToken'/);
    assert.match(text, /node \.\\scripts\\start-desktop-cdp-live-host\.mjs/);
    assert.match(text, /script bridge auth unhealthy|脚本桥认证异常|desktop script bridge auth unhealthy/);
    assert.match(text, /function Resolve-CompatiblePowerShellHost/);
    assert.match(text, /\$powerShellHostPath = Resolve-CompatiblePowerShellHost/);
    assert.match(text, /-FilePath \$powerShellHostPath/);
    assert.doesNotMatch(text, /-FilePath 'powershell\.exe'/);
  }
});

test('desktop live host refuses tokenless auth-required bridge before polling', () => {
  const text = readScript('scripts/start-desktop-cdp-live-host.mjs');

  assert.match(text, /assertBridgeAuthCompatible/);
  assert.match(text, /bridge requires CODEX_BRIDGE_TOKEN/);
  assert.match(text, /tokenPresent: token\.trim\(\)\.length > 0/);
  assert.match(text, /withAuthStatus\(status\)/);
});

test('desktop live host injects a visible remote status badge', () => {
  const text = readScript('scripts/start-desktop-cdp-live-host.mjs');

  assert.match(text, /codex-hramony-remote-status/);
  assert.match(text, /updatePageRemoteStatus/);
  assert.match(text, /updateRemoteStatus\(payload\)/);
  assert.match(text, /会话已校验/);
  assert.match(text, /会话不一致/);
  assert.match(text, /命令通道异常/);
  assert.match(text, /top: max\(10px, env\(safe-area-inset-top, 0px\)\)/);
  assert.match(text, /left: max\(360px, calc\(env\(safe-area-inset-left, 0px\) \+ 360px\)\)/);
  assert.match(text, /max-width: 86px/);
  assert.match(text, /text-overflow: ellipsis/);
  assert.match(text, /position: absolute/);
  assert.match(text, /max-height: min\(240px, calc\(100vh - 54px\)\)/);
  assert.match(text, /#codex-hramony-remote-status:hover \.chr-detail/);
  assert.doesNotMatch(text, /addEventListener\('click'/);
  assert.doesNotMatch(text, /right: max\(24px/);
  assert.doesNotMatch(text, /top: 42px/);
  assert.doesNotMatch(text, /right: 92px/);
  assert.match(text, /function relativeTime/);
  assert.match(text, /手机发送/);
  assert.match(text, /CDP 注入/);
  assert.match(text, /心跳/);
  assert.match(text, /最近错误/);
  assert.doesNotMatch(text, /\['脚本实例'/);
  assert.doesNotMatch(text, /\['检查时间'/);
  assert.match(text, /remote\.status === 'mismatch' \|\| remote\.status === 'unverified'/);
  assert.match(text, /桌面会话/);
  assert.match(text, /手机选择/);
  assert.match(text, /state\.badgeRoot\?\.remove\(\)/);
});

test('desktop live host tracks CDP loop failures per channel', () => {
  const text = readScript('scripts/start-desktop-cdp-live-host.mjs');

  assert.match(text, /loopFailures: new Map\(\)/);
  assert.match(text, /noteLoopSuccess\(state, 'heartbeat'\)/);
  assert.match(text, /noteLoopSuccess\(state, 'drain'\)/);
  assert.match(text, /noteLoopSuccess\(state, 'poll'\)/);
  assert.match(text, /const failures = \(state\.loopFailures\.get\(label\) \?\? 0\) \+ 1/);
  assert.doesNotMatch(text, /const failures = state\.consecutiveCdpFailures/);
});

test('safe deploy reads bridge defaults from app config when environment is empty', () => {
  const text = readScript('tools/harmony/safe-deploy.ps1');

  assert.match(text, /function Read-ArkConst/);
  assert.match(text, /BridgeConfig\.ets/);
  assert.match(text, /DEFAULT_BRIDGE_URL/);
  assert.match(text, /DEFAULT_BRIDGE_TOKEN/);
  assert.match(text, /if \(\[string\]::IsNullOrWhiteSpace\(\$BridgeToken\)\)/);
});

test('startup stack defaults to the desktop-owned runtime and keeps independent App Server modes explicit', () => {
  const stackText = readScript('scripts/start-codex-mobile-stack.ps1');
  const agentText = readScript('scripts/agent/start-stack.ps1');
  const watchdogText = readScript('tools/harmony/watch-local-bridge.ps1');
  const lanText = readScript('scripts/start-bridge-lan.ps1');
  const configText = readScript('src/config.js');
  const appText = readScript('src/app.js');
  const serverText = readScript('src/server.js');

  assert.match(stackText, /\[string\]\$RuntimeMode = \$env:CODEX_BRIDGE_RUNTIME_MODE/);
  assert.match(stackText, /\$RuntimeMode = 'desktop'/);
  assert.match(stackText, /'desktop', 'desktop-primary', 'app-server-shadow', 'app-server-new-only', 'app-server-canary', 'app-server-primary'/);
  assert.match(stackText, /CODEX_BRIDGE_RUNTIME_MODE='\$RuntimeMode'/);
  assert.match(stackText, /Bridge 运行模式未生效: expected=\$RuntimeMode; actual=\$actualMode/);
  assert.match(stackText, /function Set-AppServerRuntimeStartupStatus/);
  assert.match(stackText, /桌面内嵌 App Server 为唯一所有者；独立 App Server 已禁用/);
  assert.match(stackText, /App Server 状态=\$state/);
  assert.match(stackText, /'desktop-primary' \{ @\('LocalBridge', 'AppServerRuntime', 'CodexDesktop', 'DesktopScript', 'SessionApi'\) \}/);
  assert.match(stackText, /桌面实时主链路已启用，App Server 仅在发送前预检失败时兜底/);
  assert.match(stackText, /function Ensure-DesktopLiveWatchdog/);
  assert.match(stackText, /watch-desktop-live\.ps1/);
  assert.match(agentText, /\$args\.RuntimeMode = \$RuntimeMode/);
  assert.match(agentText, /\$RuntimeMode = 'desktop'/);
  assert.match(watchdogText, /\$RuntimeMode = 'desktop'/);
  assert.match(lanText, /\$RuntimeMode = 'desktop'/);
  assert.match(configText, /CODEX_BRIDGE_RUNTIME_MODE \?\? 'desktop'/);
  assert.match(appText, /process\.env\.CODEX_BRIDGE_RUNTIME_MODE[\s\S]*\?\? 'desktop'/);
  assert.match(appText, /\]\.includes\(value\) \? value : 'desktop'/);
  assert.match(serverText, /config\.appServerRuntimeMode \?\? 'desktop'/);
  assert.match(appText, /codex\.thread\.message\.received/);
  assert.match(appText, /submissionId/);
  assert.match(watchdogText, /local bridge runtime mismatch/);
});

test('all desktop CDP helper scripts send the allow-listed websocket Origin', () => {
  for (const relativePath of [
    'scripts/connect-desktop-live.mjs',
    'scripts/start-desktop-cdp-live-host.mjs',
    'scripts/desktop-mcp-request.mjs',
    'scripts/probe-desktop-cdp.mjs'
  ]) {
    const text = readScript(relativePath);
    assert.match(text, /buildDesktopCdpWebSocketOptions/);
    assert.match(text, /new WebSocket\(url, \[\], buildDesktopCdpWebSocketOptions\(cdpPort\)\)/);
  }
});

test('desktop live watchdog only hard-starts Codex after the desktop shell is absent', () => {
  const text = readScript('tools/harmony/watch-desktop-live.ps1');

  assert.match(text, /DEFAULT_BRIDGE_TOKEN/);
  assert.match(text, /recover-codex-desktop-live-soft\.ps1/);
  assert.match(text, /restart-codex-desktop-live\.ps1/);
  assert.match(text, /if \(\$shells\.Count -eq 0\)/);
  assert.match(text, /普通 Codex 正在运行且没有 CDP；为保护当前桌面工作，不自动关闭它/);
  assert.doesNotMatch(text, /Stop-CodexDesktopShell/);
});
