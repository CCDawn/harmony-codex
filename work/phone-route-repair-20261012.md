# 2026-10-12 手机会话连接恢复

手机真机日志22:09报sessions.load.failed/Internal error，仍使用旧Tailscale Funnel地址；同期本机与电脑经配置域名读取均200，但手机请求未出现在桥接日志中。桌面可用不证明手机公网路径可用。

在既有阿里云HTTPS语音入口补充/bridge/反向代理，经已建立的18787隧道转到本机8787；保留原/voice与根目录404，nginx -t通过后reload。服务器配置原件有备份。

通过手机配对页高级设置将连接地址改为https://cdawn.xyz/bridge，保留原deviceId/token/TOTP；保存后下拉刷新。

真机22:19:46日志sessions.loaded，count=7；截图logs/screenshots/session-after-aliyun.jpeg确认7个会话、个人助手名称和头像正常，原错误消失。

本地ignored BridgeConfig.ets默认地址同步；托盘Pair显式读取当前配置publicUrl，以免运行中桥接旧环境变量生成旧入口二维码。配对生成实际调用通过。

未重启Codex，未清除手机会话或配对数据，未安装新手机包。此次确认会话列表读取及助手资料显示，未发送消息或创建语音通话。
