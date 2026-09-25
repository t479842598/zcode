# 自托管手机刷新恢复

## 状态与边界

2026-09-24：源码修复与本机假数据回归完成，尚未打包、部署或完成 iPhone Safari 验收。官方应用与真实业务数据未操作。真实测试按用户要求延后到 2026-09-25 白天或另行确认的时间。

## 状态所有者与时序

Host 的 `relayBridgeLifecycle` 持有单个页面的 RPC scope 和初始化计时器；原有业务 runtime 仍持有任务。relay 只负责连接资格、配对与转发，不拥有业务数据。

```text
terminal 重新认证 → 撤销旧 terminal 转发资格 → workspace-bridge-open
  → 关闭旧 bridge 帧入口、清分片
  → 旧 RPC 出站立即失效 → await 旧 scope 清理
  → 新 scope → 安装身份 → bridge-ready → Initialize
  → 首条校验成功的完整 RPC → 停止初始化重试
```

- 入站按 bridgeSessionId、bridgeGeneration、recoveryId 整体匹配；旧身份及匿名帧不交给 RPC。
- 相同身份重复 open 不清序号、不重建 scope、不延长初始化截止时间。
- Initialize 每 400ms 重发，最多 10 秒；超时关闭设备传输，使用已有重连路径重新接入。
- 心跳一轮未响应后终结半开 WebSocket；AUTH_FAILED/KICKED 在认证之后也会关闭连接。
- 物理断开和最后一个 terminal 离开时释放 scope、订阅及定时器；新物理连接等待旧 scope 清理。
- 旧 scope 的迟到 Promise 不再发送。没有修改通用 ChannelServer、数据库和会话 runtime。
- relay 服务需要配套更新：单个有效 terminal，新认证页面替换旧页面（4001）。旧连接即便处在 close 握手中，也不能再向设备转发控制消息。

## 可重复验证

项目外层根目录执行：

```sh
fnm exec --using=24.18.0 node patches/tools/test-relay.mjs
node relay/test.mjs
```

源码根目录执行：

```sh
fnm exec --using=24.18.0 pnpm typecheck
fnm exec --using=24.18.0 pnpm lint
node scripts/architecture/architecture-check.mjs check --changed
fnm exec --using=24.18.0 node ../patches/tools/check-main-types.mjs
```

仓库要求 Node 24.14.0，本机仅有 24.18.0 和 22.23.1；本轮使用 24.18.0，发布环境仍需按锁定工具链复验。回归只使用内存服务、假身份及临时文件，不连接模型、不读取真实业务数据。

测试覆盖旧帧、残留分片、旧异步回包、重复 open、真实 agent scope 换 clientId、continuous/replayable 边界、初始化截止、断开清理、心跳丢失、认证后错误、本机十次 terminal 刷新和旧 terminal 接替。RPC 测试并未替代真实任务生成、手机后台和网络切换验收。

## 发布门禁

- iPhone Safari：已有对话连续刷新 10 次，每次 10 秒内恢复；生成中刷新不重复提交、不丢最终结果；网络恢复 60 秒内可操作。
- 全仓 lint 基线有 3104 个警告、1 个错误，错误位于既存未跟踪的根 `index.js`（max-lines），本轮未删除或改写该材料。改动文件 lint 0 error、1 个既存 warning；不能称全仓 lint 通过。
- 用户明确确认前，不退出/替换官方应用，不部署服务，不迁移或回写真实数据。
- 同版本官方/自托管包须以来源、commit、hash 区分，不能仅靠版本号判断当前运行的代码。

## 2026-09-26 手机端每45秒重连根因与修复

线上relay的terminal连接在23:39–23:47反复以约45秒间隔关闭/重建，同期nginx的`/remote/v4/`文档请求没有每45秒出现，故不是整页自动reload。手机Web资源的bridge传输把未确认出站RPC保持在replay窗口，45秒达到`remote.rpcFrame.ackGraceExceeded`或`remote.rpcFrame.replayGraceExceeded`会进入降级重连。桌面端旧实现只组装手机RPC帧，**完全没有发`rpc-frame-ack`**，与症状时间完全一致。

修复：完整分片CRC校验并交付RPC后，桌面端按当前bridge identity及messageSeq回`rpc-frame-ack`；重复messageSeq只重发ACK，不重新执行RPC；旧bridge、CRC坏帧或不完整分片不给ACK；身份切换清空已交付窗口。中继仍只负责原样转发。回归覆盖ACK、重复、坏帧和旧桥，既有初始化测试统计业务帧而不把ACK误认为迟到业务回包。28项本机中继集成回归通过，正式包重建和线上超过45秒观察仍待执行。
