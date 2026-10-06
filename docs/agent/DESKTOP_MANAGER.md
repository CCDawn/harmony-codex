# Codex 手机链路桌面管理

日常入口为桌面上的“Codex 手机链路”。托盘使用链环图标；重复启动会显示统一状态，不会再开一个实例。

| 入口 | 行为 |
| --- | --- |
| 查看统一状态 | 桥接健康、桌面实时连接、组件 PID、受管或外部服务归属 |
| 启动链路 | 恢复持久停止状态，启动或复用桥接、中继和监控，保留官方 Codex |
| 安全修复 / 补齐服务 | 补齐缺失组件；不转换已运行的桥接模式、不重启官方 Codex；未知端口归属拒绝操作 |
| 手机配对二维码 | 创建五分钟有效的配对码，浏览器展示二维码；文件不包含主控 token |
| 打开日志目录 | 打开本仓库 logs，管理事件在 startup/manager.events.log，启动结果在 startup/manager-start.log |
| 停止链路（保留 Codex） | 持久停止、撤销桌面拉起授权，再停已确认归属的监控、桥接、代理和语音子进程 |
| 退出管理应用（链路继续运行） | 退出托盘并撤销桌面拉起授权；后台连接仍继续 |

停止链路会断开手机连接和通话，因此菜单执行前有提示。关闭状态窗口不会停服务。
停止状态在应用退出和电脑重启后保留；再次启动应用不自动恢复，需点击“启动链路”。

## 管理职责

`tools/windows/mobile-link-control.ps1` 负责管理操作，四个 watch 脚本继续执行各自的检测逻辑，但它们的恢复周期与管理操作共享仓库级互斥锁，并遵守 `logs/state/mobile-link-control.json`。
托盘每 30 秒汇总状态并补齐缺失监控；状态快照在 `logs/state/mobile-link-status.json`。

进程归属要求：已知组件的命令行具有当前仓库目录，或是这些组件的已知服务子进程。相似目录前缀、早于父进程创建的进程、官方 Codex、未知子进程都不纳入管理。停止前再次核对 PID、创建时间和组件角色，停止后检查剩余进程。

长期后台任务使用不继承输出管道的隐藏进程启动，防止管理操作因为子进程持有管道而一直等待。菜单操作在工作线程执行，状态刷新不会阻塞托盘 UI。

官方 Codex 保持独立宿主；手机助手的云电脑仍是平台提供的云电脑，桌面管理应用负责接入链路，不将云电脑迁移到本地。

## 配置与构建

沿用 ignored 的 `HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets` 和 `tools/harmony/hdc-relay.local.psd1`，不复制一份新凭据配置。主控凭据通过进程环境传递，不进入管理菜单、状态快照或配对展示文件。

构建：`pwsh -File scripts/windows-launcher/build-tray.ps1`。
输出：`bin/CodexMobileRemoteTray-unified-v1.exe`。
运行需要仓库中的脚本、服务与已有依赖；本改动不提供独立 MSI 安装包或增加 Windows 开机启动。

定向验证：`test/mobileLinkLifecycle.test.ps1`、`test/mobileLinkControl.test.ps1`，以及 `test/startupScripts.test.js`、`test/desktopSupervisor.test.js`。
隔离测试的启停与配对不代表手机真机语音或锁屏验收通过。
