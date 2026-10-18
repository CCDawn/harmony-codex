# 自动守护实施契约（2026-10-18）

用户已确认自动检测、分段恢复、15秒周期、连续两次失败、每类故障最多三轮。用户明确允许必要时强制重启 Codex，即使任务或通话正在进行。首次安装默认关闭；用户开启后持久保存，电脑启动管理应用时继续守护。

## 所属与依赖

- 核心：独立 PowerShell worker + 可离线测试的 Node 决策模块；复用现有进程归属、mutex、修复计划任务和脚本。工作进程不依赖 bridge 或 Codex 存活。
- 接口与检测：认证 GET/PUT /system/guardian；配置和状态只存 logs/state；新增错误分类，公网读取与语音待机状态检测，不向助手自动发送探针消息。
- 手机与托盘：现有设置/托盘增加单一开关与共享状态；手机只在前台轮询，不承载守护执行。
- 集成：核心和界面各自测试后，主 Agent 统一编译、鉴权接口测试、隔离故障注入及部署。线上开启或强制重启演练不得以测试脚本代替明确验证记录。

## 共享文件

`mobile-link-guardian-config.json`：version、enabled、allowForceRestart、updatedAt。
`mobile-link-guardian-status.json`：version、enabled、phase、summary、checkedAt、heartbeatAt、lastSuccessAt、lastRepairAt、attempts、nextCheckAt、faults、history。
`mobile-link-guardian-phone.json`：version、lastSeenAt；手机 GET 的认证心跳，过期只标未知。

## 保护与验收

人工停止优先于自动修复；排队修复拿到锁后重新检查开关和停止状态。各 watcher 和 guardian 不能并发重复修复。只有已确认的本机服务/连接故障可以升级重启；认证、账号、接口兼容、上游错误和未知故障不进入盲目重启。HDC 离线不表示普通会话离线；空闲语音服务不要求一直监听。正常模型工作、等待审批、静音和锁屏都不是故障。

状态明确区分连接/读取检测与实际发送或通话验收；不重发不确定消息、不代答审批、不更改代理或登录。默认关闭的构建、接口鉴权、模式保存/恢复、故障重试预算和手动停止竞态均须验证。所有历史 dirty 保留，本次不提交或推送。

## 本轮交付与验收

- 托盘已替换为新版统一入口，桥接已加载认证守护 API；只重载本仓库归属桥接，未重启 Codex。手机 HAP 两轮构建成功，最终补丁安装后通过设备包 updateTime 确认。
- Node 定向集成 56 项通过；PowerShell 隔离 worker 15 项、手动停止竞态 5 项、控制器与旧 watcher 交接 17 项通过。竞态和交接同时覆盖 Windows PowerShell 5.1 与 pwsh。
- 独立审查发现并修正：Guardian 启动不得覆盖途中手动停止；升级前驻留旧 watcher 必须交接后才能启用。检测信号损坏不能判健康，也不能授权自动修复。
- 真机已读到共享开关和状态，并打开守护详情；补丁将时间转为手机本地时间，将历史动作/结果转为中文。最后运行快照为 enabled=true、healthy、attempts=0，独立计划任务 Running。
- 本机 bridge、桌面、普通会话、个人助手、公网读取、本机与公网语音 WebSocket 握手均通过；云电脑未启动时的 waiting 不算链路故障。个人助手探针偶有未知故障，守护按约定暂停升级并继续检测，随后恢复健康。
- 真实记录中一次 reconnect 结果为 unconfirmed，后续独立检测恢复健康；不能据此声称自动修复是恢复的原因。强制重启仅有隔离测试，本轮未执行真实 Codex 强重启；语音握手不代表实际通话听感、锁屏或插话验收。
