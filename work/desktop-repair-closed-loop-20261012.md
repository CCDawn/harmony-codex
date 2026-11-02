# 2026-10-12 桌面重启修复闭环

- 用户明确要求应用能够修复链路、重启Codex并连接成功。
- 首次恢复失败：由Codex内部启动的执行器在关闭桌面时连带退出，日志止于停止进程，未进入启动阶段。没有将此结果报为成功。
- 修复：Repair -RestartDesktop改由当前用户、普通权限、按需且无触发器的Windows计划任务执行；后台Maintain和普通Start不请求重启。独立执行器统一UTF-8读取子进程输出，记录runId和结果。
- 托盘已安装新版，菜单为“修复链路（必要时重启Codex）”，传入显式重启参数。脚本现场更新生效。
- 独立执行器先经过ProbeOnly只读运行验证，再执行真实恢复。
- 22:02:07 Codex新桌面PID11848启动；独立任务继续执行，桌面和普通会话正常，首次个人助手读取超时。
- 随后个人助手与云电脑读取恢复。补充最多两次读取重试，不因此反复重启桌面。
- 22:05:15再次走完整修复入口：exitCode=0、startupOutcome=ready、desktopRecovery=not-needed；桥接、桌面、普通会话、助手历史、云电脑状态全部ready。
- 复跑后Codex仍为PID11848，启动时间保持22:02:07，未二次重启。
- 22:05:46公网TLS/auth/WebSocket/ping-pong通过，未创建模型通话。
- 已触发托盘刷新统一状态。

验证：desktop repair 18断言、startup readiness 27断言、diagnostics 14测试通过。未验收真实语音、手机发送、锁屏通话和远程画面操作。

证据：logs/state/desktop-repair-result.json、work/desktop-repair-final-20261012.json、logs/startup/desktop-repair.log、work/voice-tunnel-probe-independent-repair.json。
