# 语音 502 诊断记录（2026-10-09）

## 最新结论：旧清理关卡造成持续阻塞，已修复并验证

以下早期不可用结论仅代表当时观测，不代表当前状态。用户确认官方桌面已恢复且已挂断后，`work/probe-new-call-isolated.mjs` 独立创建新通话成功，WebRTC connected，stop 成功。此前部分探针仅请求旧 call 的 stop；其 502 不能推断新建接口失败，也不能证明封禁。

本次确认本项目 recovery 在旧 stop 502 时直接抛错，阻止新 call 创建。现保留失败旧记录并标记延后清理，清空临时旧 call 引用，允许用户发起新通话；仍提前检查全部匹配记录的活跃 owner，禁止竞争。新通话创建不自动重试。

修复后通过运行中的 8790 服务执行 `work/call-cleanup-live-probe.mjs`，真实 Python/helper/媒体路径返回 assistant → media → ready → closed。pendingBefore=1、pendingAfter=1、oldReceiptsRetained=true；旧记录保留，新通话完成清理。Node 17 项、Python 16 项测试全部通过。无麦克风输入，未验证真机可听回复或官方全文同步。

## 已验证

- 最后成功通话 2026-10-08 23:59:29 建立；00:03:20 断线，00:03:25 stop 超时，00:03:27 辅助进程被终止。时间为 Asia/Shanghai。
- 该异常先于 sniff 展示修复安装。成功通话与首次失败使用同一语音服务进程。
- 收尾归属丢失已修复；32 项针对性测试通过。现场 502 后持久记录保留。此修复不证明 502 根因已消除。
- 原音频参数与浏览器生成的音频参数均遇到创建接口 502。
- 显式 expectedIdentity 与 ChatGPT-Account-ID 对照仍能读取同一助手，但 stop 返回 502。
- 从当前登录凭据发起独立、新建 HTTP 连接，访问在官方客户端代码中核实的 https://chatgpt.com/backend-api：同一助手 GET 200，精确的已知自有通话 stop POST 502。凭据只在进程内使用，未输出或复制至报告。
- 经用户授权临时使用美国 01 出口后，同一独立探针重复得到 GET 200、stop POST 502。显式代理未被 NO_PROXY 绕过，使用新连接、不复用桌面连接。测试后恢复原配置及选择器；规则数回读 8534。
- 502 响应由 Cloudflare 返回，Content-Type 为 text/plain; charset=UTF-8；未返回可定位服务内部原因的结构化错误。

## 证据文件

- work/probe-official-identity-stop.mjs：显式账号身份对照。
- work/probe-fresh-http-voice.py：独立新连接，同一助手校验后才操作该自有通话。
- work/voice-route-fresh-comparison.log：备用出口对照和恢复回读。
- work/call-cleanup-live-probe.log：实际运行进程中待清理记录未丢失。
- work/call-cleanup-node-tests.log、work/call-cleanup-python-tests.log：回归结果。

## 判断边界

证据已排除手机、中继、桌面连接复用作为此次 502 的必要条件，也未支持原出口独有故障。当前更符合官方语音路径对本助手/账号的处理异常，但无法区分账号级、助手级、区域或整个语音服务故障。官方状态页无事故不代表此内部功能必然正常。仅凭 Cloudflare 标记不能断言 Cloudflare 自身故障。

## 官方入口对照已完成

用户于本轮确认官方 Codex 桌面同一助手的自带语音也连接失败。官方桌面日志 2026-10-08T17:24:40.131Z（北京时间 2026-10-09 01:24:40）记录 `Orbit voice call failed`，同时包含 HTTP 502 与 `error code: 502`。诊断脚本只提取时间、事件和状态，不输出原始错误正文或账号信息。

因此已确认故障同样发生于官方客户端，并非本项目手机接入独有。多个独立客户端路径以及新连接出口对照均复现语音路径 502；当前登录及助手查询仍成功。最窄结论是官方个人助手语音路径对当前助手/账号不可用，尚无法从外部判定是账号、助手实例、区域路由还是全局服务故障，也不能证明旧通话残留是其根因。
