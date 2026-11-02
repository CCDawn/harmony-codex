# 鸿蒙后台提醒与前台恢复

本方案由用户于 2026-11-01 确认：电脑继续执行，手机后台通过华为系统推送接收完成、失败和待处理提醒；回到前台后恢复会话订阅并补齐官方对话历史。推送消息不承载回答正文、工具参数、选择题内容或答案。

## 实测依据

Pura X Max 实测中，普通 PC TCP/HTTPS 连接申请 `multiDeviceConnection` 后，系统在退后台约 60 秒时记录 `multi device detect fail ... not use MultiDevice`，随后撤销任务并冻结进程。启动申请成功和查询到未挂起只证明当时状态，不能当作持续后台运行的验收。该类型已经从本应用配置移除。

普通聊天不再主动申请持续后台任务。原有 `dataTransfer` 仅保留给已开启的调试中继，语音继续使用其已有的系统通话资源；两者都不是聊天推送的前提。

## 直接复用的能力

- 客户端使用 API 24 原生 `@kit.PushKit` 的 `getToken`、`tokenUpdate` 和 `deleteToken`，沿用官方 ArkTS 示例的 Ability 生命周期。
- 通知点击直接使用本项目既有四个 `codexRemoteNotification*` 参数，由 `EntryAbility.onCreate/onNewWant` 导航到原会话。首页使用官方 home action、singleton 和独立 push listener skill。
- 桥接观察使用现有 Desktop adapter 的共享通知订阅、官方 `thread/turns/list`，待处理请求使用现有 DesktopInteractionClient 的只读模式。不会初始化答题面板、选择选项、提交答案或控制回合。
- Node 使用标准 `node:crypto` 生成 PS256 JWT，按华为 V3 REST 结构发送通知，无第三方推送依赖。官方 Java 示例仅参考协议和签名字段，没有引入 Java 运行时或复制其代码。

官方示例 [ArkTS 客户端](https://gitee.com/harmonyos_samples/push-kit-sample-code-clientdemo-arkts)、[Java 服务端](https://gitee.com/harmonyos_samples/push-kit_-sample-code_-server-demo_-java) 使用 Apache-2.0。参考资料：[Token 生命周期](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-get-token)、[通知与参数](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-send-alert)、[JWT](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-jwt-token)、[V3 请求](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-request-param)、[V3 响应](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/push-scenariozed-api-response)。

## 首次开通

当前用户确认尚未开通 Push Kit；真实推送验收必须在以下配置完成后进行。

1. 在 AppGallery Connect 建立对应包名 `com.codex.remote.app` 的 HarmonyOS 应用，设置项目数据处理位置，在增长/推送服务中开通 Push Kit。
2. 开通后重新生成含 Push 权益的调试 Profile 并签名。现有旧 Profile 不能代替这一步。客户端不需要手填 Client ID，也不需要服务账号私钥。
3. 在同项目 API Console 的 API 服务/凭证/服务账号密钥中下载服务账号 JSON。完整文件只放电脑端：`tools/harmony/huawei-push.service-account.local.json`。该路径已忽略提交，也不进入 HAP。桥接启动时自动读取；也可用 `CODEX_HUAWEI_PUSH_SERVICE_ACCOUNT` 指定电脑端的其他文件。
4. 确认通知分类权益。默认 `WORK`，可用 `CODEX_HUAWEI_PUSH_CATEGORY` 选择已获准类别。测试默认 `testMessage=true`，正式使用前确认权益并设置 `CODEX_HUAWEI_PUSH_TEST_MESSAGE=0`。分类字符串不能代替华为审批。
5. 重启电脑桥接、安装重新签名的 HAP，允许应用通知。在手机设置的“后台提醒”中启用/刷新，状态应变为“已启用”。客户端只在启动、令牌更新和明确启用时获取原生 token，不轮询申请。

身份错误 `1000900010` 对应重新检查 Profile；未开权益 `1000900012` 对应开通服务并重新签 Profile。当前代码把这些状态与网络重连分开，不把未开通显示成推送就绪。

[官方开通与签名说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-config-setting)、[分类权益](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/push-apply-right)。

## 桥接接口契约

这是兼容新增，现有聊天、选择、停止、SSE 接口与客户端行为继续保留。

| 接口 | 说明 |
| --- | --- |
| `GET /api/mobile-push/status` | 返回版本、是否有有效电脑端服务账号配置、配置状态和测试模式，不返回密钥或设备 token |
| `POST /api/mobile-push/registration` | body 为 `installationId`（UUID）、`token`（华为 push token）、`threadIds`（最多 100 个唯一官方会话 UUID） |
| `DELETE /api/mobile-push/registration` | 删除当前身份的登记；legacy master 传本机 installationId，配对身份由服务端派生目标 |
| `DELETE /api/mobile-push/registration/:id` | 配对身份仅可删除自己的派生 ID；master 可管理已知登记 |

所有接口均在既有 Token/OTP 鉴权之后。配对身份使用服务端从 `deviceId` 派生的登记 ID，客户端不能通过换参数覆盖另一设备。撤销设备配对时同时清推送登记，投递前也核对权威设备吊销状态。

响应 `registration.ready` 只表示电脑端配置和登记已就绪，不是设备已展示通知的回执。华为返回 HTTP 成功且业务码为字符串 `80000000` 才记录 accepted；不会把 HTTP 200 或任意响应文本当作成功。

## 订阅、去重和恢复

- 订阅范围来自手机成功同步且仍匹配当前桥接凭据的官方会话列表与已知运行会话，运行会话优先，上限 100。同电脑的分页刷新保留原有监听，较旧但仍运行的会话不会因为排到列表第 51 项而消失。启动中的空 UI、失败刷新或旧电脑迟到的结果不会清掉已保存的订阅。新建桌面会话在手机下一次成功同步后纳入提醒。
- 电脑端订阅独立于手机 SSE，手机冻结或断线不会移除登记；原生事件触发对账，15 秒周期对账补漏。
- 完成/失败必须有官方回合 ID 和明确终态；未知、idle、读取失败或 interrupted 都不能推断完成。每次读取近期 50 个回合的 `notLoaded` 元数据，不加载回答正文；前一回合已完成、后一回合已开始时也能识别前一回合。首次登记原子保存已存在的终态 ID 数组作为基线，不推送旧历史。更长离线间隔的完整对话仍在打开 App 后由官方历史分页恢复。
- 待选择/审批只采用当前活跃回合的原始请求身份，不使用临时 HTTP ticket 或问题正文去重。
- 事件 ID 为稳定身份的 SHA-256，同一安装的发送认领先落盘，再调用华为；云通知同时使用 `appMessageId`。认领持有唯一 `claimId`，安装登记持有续登记不变、删除重建变化的 `instanceId`；旧观察不能释放或结算新观察的发送。已实际发送后的 accepted/failed/uncertain 不自动重发。确认尚未调用发送器时发生 token 变更，才由原持有者释放未发送认领供新 token 投递。
- 每个安装最多保留 1000 条投递收据；sending/uncertain 不淘汰，占满时停止新认领并记录固定诊断码。推送是提醒通道，完整对话以 Codex 官方历史为准。
- 前台云通知 `foregroundShow=false`，仍用现有界面和本地通知。后台只对最近一次成功就绪登记所覆盖且仍在当前订阅中的会话抑制同类本地提醒；同电脑新增会话的登记暂时失败时，原覆盖继续生效，新会话保留本地提醒。移出订阅的会话立即解除抑制；关闭、换电脑或凭据、令牌轮换与注销会清空旧覆盖，新的就绪回执才能重新启用。服务器尚未配置时不缓存就绪登记，后续同步或明确启用/刷新可重新检查配置；健康登记的普通同步不重复注册。
- 点击通知复用原会话导航。目标不在当前侧栏页时，使用既有会话详情接口按原生 ID 读取，不要求先出现在最近列表中。读取期间用户切换会话或电脑，会取消旧通知的跳转；读取失败且目标未变化时，后续前台刷新可以重试。普通回前台只重建已停止的订阅并刷新历史，保留阅读时脱离底部的状态，不重发用户消息。
- 解除配对会在在途注册之后执行最后注销，并撤销设备原生 token；换电脑先退役旧目标。偏好只保存安装 ID、启用开关及 authority 摘要，推送 token 和桥接凭据不写入偏好。

## 验收

Node/ETS VM 测试不能代替实际 Push 到达。开通后用独立验收 A/B 进行：后台超过 60 秒后电脑完成任务和提出选择、设备展示恰好一条通知、点击回原会话、选择/跳过只提交一次、离线重连不重复提醒、停止回合为 interrupted、停止后能发新消息。必须同时记录华为 accepted、手机通知展示和原会话回读，不以其中任一项替代全部结果。
