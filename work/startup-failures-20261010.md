# 2026-10-10 启动失败排查

后续更正：10:00 后已确认语音新任务转发失败源于本机旧 SSH 脱管并占用远端端口。旧连接实际仍可承载公网语音 WebSocket，不能把新任务失败等同于语音入口断开。现已迁移到可回收子进程的 supervisor，真实任务停止/恢复及公网握手验证通过。详见 work/voice-supervisor-repair-20261010.md。

排查方式：只读运行日志、进程和源码；未重启官方 Codex、未改业务代码。时间均为北京时间。

## 已确认

- manager.events.log 记录 09:29:29 Start、09:30:00 Repair、09:32:09 Start、09:33:09 Start，各次启动子脚本均退出 0。09:32:45 有 Stop。
- 手机 hilog 的 09:31:55、09:32:28、09:33:32 等记录反复出现 `connect ECONNREFUSED 127.0.0.1:9229`。current-run/bridge.jsonl 也记录会话、项目和 runtime-snapshot HTTP 500。
- 最新 manager-start.log 明确写了“按参数跳过 Codex 桌面检查”“桌面实时通道 online=False”“会话 API 500”“整体状态：不可用”。
- tools/windows/mobile-link-control.ps1:173 为启动入口传入 `-SkipCodexDesktop -KeepExistingCodex`；Repair 的安全恢复在没有可用 CDP 时返回 blocked。scripts/start-codex-mobile-stack.ps1:1525 固定 exit 0，故不能把子进程退出 0 当作业务可用。
- watchdog 仅在 Codex 桌面不存在时启动带 CDP 的桌面，已有普通桌面且无 CDP 时保留现有工作。desktop-relaunch.log 显示后来启动了带 CDP 的桌面，端口 59682；desktop-live-status.json 于 09:34:02 记录 injected/online。
- 手机 09:34:10 runtime.snapshot.synced，7 个会话；随后本次用户请求成功提交。当前会话读取及任务通路已恢复。

## 结论和边界

直接故障是电脑桥接无法连接 Codex 桌面接口；重复启动没有同步解决该依赖，而且退出码没有表达整体失败。尚不能从保留日志确定更早的桌面接口为何消失；不能将其归因于 VPN、阿里云、静音补丁或官方封禁。

附带发现：本地 CodexHarmonyVoice/tunnel.log 在 09:37–09:38 反复出现 `remote port forwarding failed for listen port 18787` 和 exit 255，而状态页只检查计划任务 Running。该隧道异常需独立核查远端监听归属，不能直接解释上述本机 9229 错误，也不能单凭该日志断言当前通话失败。

8790 当前未监听不能独立证明语音故障：src/voiceProcess.js 明确为首个 /voice 请求懒启动。今天保留日志未显示新的 voice 会话，因此本次不宣称语音已通过验收。

## 建议修复顺序

1. 启动前识别桌面依赖状态：已有 CDP 就安全重连；桌面不存在就按既有授权启动；普通桌面缺少 CDP 时准确提示需要的恢复操作，保护活跃工作。
2. 启动结束以会话 API 和桌面连接结果返回可用、等待、失败状态，避免固定成功退出和重复无效重试。
3. 隧道状态增加实际转发可用性检查，区分任务进程运行和隧道建立成功。

手机现场快照：work/startup-failures-20261010-hilog.log。current-run 与 startup 日志会被后续运行更新，本报告记录的是本次查验结果。

## 后续修复

- Start 与 Repair 均同步执行桌面安全恢复，已有可用连接只读取；缺失桌面使用 StartOnly；普通桌面缺少接口返回 blocked。
- StartOnly 不调用停止 Codex 的逻辑，并在实际启动前再次检查是否已有桌面。现场对已运行的 Codex 执行 StartOnly 返回 11，PID 16964 保持不变。
- 栈及 agent 包装入口传递依赖未就绪退出码 2；管理器最终以实际桌面和会话读取检查生成结构化结果，托盘能展示 blocked/pending/partial 的具体原因。
- 隧道任务恢复异常不再阻断其他通道状态采集。会话可用而已确认隧道故障时显示 partial，不能宣称整条链路正常。
- 09:48 替换托盘程序并运行，旧托盘 PID 40468、新托盘 PID 56952。官方 Codex PID 16964、桥接 PID 42964 的启动时间没有变化。备份保留在 bin。
- 现场 Repair 回读桌面、会话、个人助手均可读取；没有进行冷启动官方桌面、真人通话或锁屏验收。

验证：mobileStartupReadiness 25 项断言、mobileLinkControl 25 项隔离断言、startupScripts/desktopSupervisor 27 项 Node 测试通过；生命周期 19 项、detached recovery 4 项、heartbeat 8 项验证通过，托盘构建成功。

证据：work/startup-control-tests.log、work/startup-node-tests.log、work/startup-live-repair-20261010.json、work/startup-tray-deployment-20261010.json、work/start-only-existing-desktop-20261010.log。

隧道检测最终版本验证：mobileVoiceTunnel/mobileLinkDiagnostics 的 14 项 Node 测试通过，包括真实 CLI 参数传递和隔离 PowerShell 用例；结果保存 work/startup-tunnel-tests.log。现场确认 taskRunning=true、running=false、forward-failed，未停止或修改远端隧道。最终 Repair 回读保存 work/startup-live-repair-final-20261010.json。
