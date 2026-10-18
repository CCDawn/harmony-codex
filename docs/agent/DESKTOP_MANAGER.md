# Codex 手机链路桌面管理

日常入口为桌面上的“Codex 手机链路”。托盘使用链环图标；重复启动会显示统一状态，不会再开一个实例。

| 入口 | 行为 |
| --- | --- |
| 查看统一状态 | 桥接健康、桌面连接、会话读取、个人助手、云环境、语音与调试安装通道，以及组件归属 |
| 启动链路 | 恢复持久停止状态，补齐桥接、中继和监控，同步检查并安全恢复桌面连接 |
| 安全修复 / 补齐服务 | 与启动采用同一依赖检查：已有可用端口时软恢复；Codex 未运行时仅启动；运行中却缺少端口时保留工作并报告阻塞原因 |
| 手机配对二维码 | 创建五分钟有效的配对码，浏览器展示二维码；文件不包含主控 token |
| 打开日志目录 | 打开本仓库 logs，管理事件在 startup/manager.events.log，启动结果在 startup/manager-start.log |
| 停止链路（保留 Codex） | 持久停止、撤销桌面拉起授权，再停已确认归属的监控、桥接、代理和语音子进程 |
| 退出管理应用（链路继续运行） | 退出托盘并撤销桌面拉起授权；后台连接仍继续 |

停止链路会断开手机连接和通话，因此菜单执行前有提示。关闭状态窗口不会停服务。
停止状态在应用退出和电脑重启后保留；再次启动应用不自动恢复，需点击“启动链路”。

## 管理职责

`tools/windows/mobile-link-control.ps1` 负责管理操作，各个 watch 脚本继续执行各自的检测逻辑，但它们的恢复周期与管理操作共享仓库级互斥锁，并遵守 `logs/state/mobile-link-control.json`。
托盘每 30 秒汇总状态并补齐缺失监控；状态快照在 `logs/state/mobile-link-status.json`。

启动与修复的 `startupOutcome` 区分 ready、partial、pending、blocked、failed；本地桥接、桌面连接和普通会话列表读取全部通过，且没有已确认的语音隧道错误时，才返回退出码 0。会话就绪但隧道故障时返回 partial；依赖未就绪或部分可用均返回退出码 2 和完整诊断，托盘显示具体原因。致命配置或归属错误返回 1。底层 stack 和 agent 包装入口也保留依赖未就绪的退出码 2。语音和云电脑验收单独列示，不由启动成功推断。

当桌面不存在时，管理器通过 `-StartOnly -RefusePlainCodex` 启动并等待连接结果。启动器再次检查进程，拒绝操作并发出现的桌面，且该模式不调用停止 Codex 的逻辑。慢启动返回等待提示，避免用户反复点击；已有桌面仅执行 soft 恢复。

语音状态区分计划任务运行、SSH 传输连接和远端转发证据。检测器共享读取绑定脚本旁 `tunnel.log` 的最近 64 KiB；当前尝试出现转发拒绝或非零退出时报告故障。仅有计划任务或 TCP 连接不能证明转发成功；缺少明确转发成功记录时显示未验证。即使转发确认成功，真实通话和锁屏语音仍需单独验收。

受管隧道的实现位于 `tools/harmony/keep-voice-tunnel.ps1`，其本地配置格式参见 `voice-tunnel-supervisor.example.psd1`。原计划任务可保留原 ScriptPath，由该本地入口调用仓库中的 supervisor 并传入本地 ConfigPath。目的地址和密钥文件路径只写入 ignored 的本地配置。

Supervisor 用 `tools/windows/managed-child-job.ps1` 在 Windows Job Object 内创建日志 runner；runner 和 SSH 子进程都受 kill-on-close 约束。停止任务或管理进程异常退出时，Windows 一并回收整个进程组，避免遗留 SSH 占用远端端口。要求 Windows 10 / Windows Server 2016 及以上。SSH 诊断由 runner 逐行写入 UTF-8 日志，避免 Windows OpenSSH `-E` 独占文件导致状态检查无法读取。

发现远端转发被拒绝时，应核对是否有旧连接仍在服务。新任务失败不等于公网语音入口不可用；不得按端口号盲目终止服务器进程。迁移前检查活跃通话和本机 SSH 的目的地址、密钥路径、父进程及创建时间，只回收确认属于本链路的遗留进程。

状态快照的 `diagnostics` 分别展示桥接、桌面连接、普通会话读取、个人助手会话读取、云环境、语音和手机调试安装结果。读接口采用当前本地配置和动态验证码；只执行 GET，不发送消息、不发起通话、不创建云电脑控制会话，也不保留服务响应正文或助手标识。
检测失败会让托盘显示“连接异常”；只有读取正常时，仍明确标注发送、通话和远程操作未验收。管理应用运行或语音计划任务运行均不作为业务成功证据。HDC 是独立安装调试通道，设备为空不代表手机会话离线。

启动和后台巡检保留运行中的 Codex。用户点击“修复链路（必要时重启 Codex）”时，管理器传入 `Repair -RestartDesktop`，先尝试软恢复；仍未恢复则使用既有启动器重启桌面并重新连接。该明确操作会中断桌面中的进行中工作，不再停在另行确认提示。脚本不带 `-RestartDesktop` 时保留原来的安全恢复行为。重启后的成功判定要求桌面在线、普通会话和个人助手会话均读取成功；进程启动或端口监听不等于修复成功。

独立国内语音隧道通过 ignored 的 `tools/harmony/voice-tunnel.local.psd1` 绑定已有计划任务及其脚本路径；不复制 SSH 凭据。任务名称和实际执行脚本必须同时匹配才允许启动、启用或停止。统一状态显示任务运行状态，不将它当作语音端到端验证。
`watch-voice-tunnel.ps1` 每 10 秒检查任务，退出后恢复，避免只依赖 Windows 的失败重试策略。它在托盘退出后继续运行。停止链路会禁用隧道的登录触发并停止任务；持久停止状态阻止监控恢复，显式启动时重新启用。恢复记录位于 `logs/state/voice-tunnel-recovery.json`。

进程归属要求：已知组件的命令行具有当前仓库目录，或是这些组件的已知服务子进程。相似目录前缀、早于父进程创建的进程、官方 Codex、未知子进程都不纳入管理。停止前再次核对 PID、创建时间和组件角色，停止后检查剩余进程。

长期后台任务使用不继承输出管道的隐藏进程启动，防止管理操作因为子进程持有管道而一直等待。菜单操作在工作线程执行，状态刷新不会阻塞托盘 UI。
管理脚本显式使用 UTF-8 输出，确保隐藏 PowerShell 调用不会用系统代码页解码 Node 的 JSON。桌面监控保留 JSON 日期的时区，兼容 PowerShell 5 的字符串和 PowerShell 7 的 DateTime 解析。
桌面监控调用启动与软恢复脚本时，复用不继承输出管道的启动器并等待启动器进程退出，避免长期 live-host 持有管道导致管理互斥锁一直不释放。恢复输出写入 startup/desktop-relaunch.log 或 startup/desktop-soft-recovery.log。

官方 Codex 保持独立宿主；手机助手的云电脑仍是平台提供的云电脑，桌面管理应用负责接入链路，不将云电脑迁移到本地。

## 配置与构建

沿用 ignored 的 `HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets` 和 `tools/harmony/hdc-relay.local.psd1`，不复制一份新凭据配置。主控凭据通过进程环境传递，不进入管理菜单、状态快照或配对展示文件。

构建：`pwsh -File scripts/windows-launcher/build-tray.ps1`。
输出：`bin/CodexMobileRemoteTray-unified-v1.exe`。
运行需要仓库中的脚本、服务与已有依赖；本改动不提供独立 MSI 安装包或增加 Windows 开机启动。

定向验证：`test/mobileLinkLifecycle.test.ps1`、`test/mobileLinkControl.test.ps1`、`test/mobileVoiceTunnel.test.ps1`，以及 `test/startupScripts.test.js`、`test/desktopSupervisor.test.js`。
业务状态与保密边界回归位于 `test/mobileLinkDiagnostics.test.js`。
统一状态的桌面在线标记与详细诊断使用同一次探测；端口记录若没有存活的所属进程则不展示。本机桌面接口未开放时，会话的 HTTP 500/502 同时提示先恢复桌面连接，不能据此归因为公网或官方服务故障。
显式重启修复由按需 Windows 计划任务 `CodexHarmonyExplicitDesktopRepair` 执行，而非 Codex 子进程直接承担。任务没有自动触发器，使用当前用户交互会话、普通权限和隐藏窗口；关闭 Codex 不会中断执行器。运行记录写入 `logs/startup/desktop-repair-worker.json`，带运行标识的结果写入 `logs/state/desktop-repair-result.json`。桌面上线后最多补两次会话读取验证，不为首次超时重复重启。可用 `Start-MobileLinkRepairTask -ProbeOnly` 只验证独立执行与结果回传，不重启桌面。
语音任务支持经系统 `conhost.exe --headless` 隐藏启动 Windows PowerShell 的绑定方式，仍校验解释器、参数和脚本归属。转发日志逐行读取，避免长时间运行后成功记录被挤出固定尾部窗口而误报未知；这仍不替代真实通话验证。
链路期望状态使用原子文件替换，兼容 Windows PowerShell 5.1 和 PowerShell 7。
隐藏调用的中文状态回归包含在 `test/mobileLinkControl.test.ps1`；心跳新鲜度、进程存活与异常数据回归位于 `test/desktopSupervisorHeartbeat.test.ps1`。
`test/desktopRecoveryDetached.test.ps1` 验证启动器在长期子服务仍存活时及时返回，并保留失败退出码。
隔离测试的启停与配对不代表手机真机语音或锁屏验收通过。
`test/mobileStartupReadiness.test.ps1` 验证桌面恢复分支、会话读取失败、等待状态与公共包装入口的退出码传递。
