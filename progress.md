## 2026-09-24 - Task: 手机刷新恢复的 bridge 隔离与生命周期修复
### What was done
建立三条先失败后通过的隔离回归；关闭旧 scope 的出站并等待清理，校验入站 bridge，清残留分片，初始化重试有界，断开释放资源，认证后错误和心跳超时触发重连。保留官方安装与业务数据。
### Testing
18 项中继套件通过（包括外层既存脚本和本机10次刷新）；外层 relay/server 基础测试通过。pnpm typecheck 通过；architecture check 0 violations；主进程守卫4个文件通过；更新下载/安装2个脚本通过。全仓 lint 前后同为3104 warnings / 1 error，既存未跟踪 index.js max-lines；改动文件0 error / 1既存warning。Node24.18.0运行，仓库固定24.14.0尚待发布环境复验。真实Safari、生成中的恢复、线上联调、真实数据兼容、安装未验证。
### Notes
- packages/desktop/src/host/relayDeviceSocket.ts：校验身份、切桥清分片、停止匿名出站、释放事件监听。
- packages/desktop/src/host/relayChannelServer.ts：异步清理scope并同步关闭旧出站。
- packages/desktop/src/host/relayBridgeLifecycle.ts：页面scope所有者、幂等open、10秒初始化截止及清理。
- packages/desktop/src/host/relayDeviceClient.ts：串行prepare/ready、断开页面释放、心跳和致命错误处理。
- packages/desktop/src/host/relayDeviceBootstrap.ts：接入生命周期，物理连接之间等待清理并避免旧close覆盖新连接。
- packages/desktop/tests/selfhost/relay-refresh.test.ts：旧帧、回包、分片、scope换代和delivery语义回归。
- packages/desktop/tests/selfhost/relay-lifecycle.test.ts：初始化、幂等及断开定时器测试。
- packages/desktop/tests/selfhost/relay-reconnect.test.ts：本机端到端刷新接替与心跳回归；依赖外层relay/server.mjs。
- docs/selfhost-relay-refresh.md：记录状态时序、验证入口和发布门禁。
- progress.md：追加本次证据和回滚方式。
回滚：对本条所在提交执行 git revert；配套外层中继单terminal策略须一起回滚。原始源码基线为 abd72de。未部署或安装，不需要回滚生产。
