# 2026-10-10 语音隧道管理修复

## 已确认的根因

本机 SSH PID 40120 于 01:16 启动，父进程 42424 已不存在。它持有指向本项目桥接的反向转发；阿里云的 loopback 18787 由对应旧 sshd 会话监听。新计划任务无法绑定同一端口，反复退出 255。

需要纠正前一轮的范围：受管任务转发失败，不等于公网语音入口已经断开。修复前，用手机配置的 HTTPS 语音地址测试，TLS 校验、鉴权、WebSocket upgrade 和 ping/pong 均通过。旧的脱管连接仍然承载入口。

## 修复及部署

- 新 supervisor 保留原计划任务入口，本地 wrapper 调用仓库脚本，本地连接设置保存为 ignored psd1。
- Windows Job Object 在创建 runner 时原子绑定 kill-on-close，runner 的 SSH 子进程继承同一 job；父进程终止会回收整个进程组。
- 单实例互斥阻止同一配置运行多个 supervisor。
- 使用逐行 UTF-8 诊断日志，确认当前连接的远端转发成功后才标记受管隧道可用。
- 首次迁移发现 Windows OpenSSH -E 独占日志，无法回读确认，于是自动回退；调整日志方式后第二次迁移成功。备份保存在 work/keep-tunnel.pre-job-20261010.ps1。
- 只回收经过目的地址、密钥路径、创建时间和父进程核对的本地旧 SSH；没有终止远端未知服务。

## 验证

- managedChildJob 隔离测试在 Windows PowerShell 5.1、pwsh 7 下各通过 9 项，包括强杀父进程回收子进程、Dispose 回收、短进程退出码。
- 诊断和 CLI 的 14 项 Node 测试通过，包含 18 项隔离 PowerShell 断言；覆盖新 runner 的进程归属和拒绝无关 runner。
- 真实计划任务停止/恢复：supervisor、runner、SSH 共 3 个进程全部退出，遗留进程 0；恢复后远端转发重新确认成功。
- 修复前、回退后、迁移后、任务重启后，公网语音地址均通过鉴权 WebSocket upgrade 和双向 ping/pong。
- 官方 Codex PID 16964、桥接 PID 42964、托盘 PID 56952 及其启动时间保持不变。

本轮没有创建模型通话，没有上传麦克风音频；不替代真人语音、转写同步或锁屏通话验收。

证据：
- work/voice-tunnel-probe-before.json
- work/voice-tunnel-probe-after.json
- work/voice-tunnel-probe-after-restart.json
- work/voice-supervisor-migration-20261010.json
- work/voice-supervisor-lifecycle-20261010.json
- work/tunnel-supervisor-diagnostics-tests.log
