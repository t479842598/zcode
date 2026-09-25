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

## 2026-09-24 - Task: 版本对齐与离开页面时的队列清理补充
### What was done
源码版本对齐本机官方3.14.3，新增根版本/构建元数据/自托管GitHub发布目标一致性回归；补充waiting控制事件执行时再次清掉可能由先前异步prepare恢复的旧身份。活动额度只调研不接入、不复制凭据；实机与生产测试按用户要求延后。
### Testing
新增release-version离线测试通过；完整套件在最终验证阶段重跑。版本读取调用collectBuildMetadata，不生成或安装应用。类型与lint结果在外层progress.md汇总。
### Notes
- package.json：版本3.14.2改为3.14.3，不等同于全量上游升级。
- packages/desktop/tests/selfhost/release-version.test.ts：校验版本与独立发布目标。
- packages/desktop/src/host/relayDeviceClient.ts：排队的waiting事件执行时再次清空bridge身份。
- progress.md：追加本轮说明和回滚点。
回滚：对此条所在提交执行git revert；之前的刷新修复点为99a018e。没有安装或部署，不影响官方客户端。

## 2026-09-24 - Task: 恢复官方登录/权益端点并保持中继与更新独立
### What was done
按用户追加明确授权恢复官方OAuth的state、轮询和浏览器打开；Host/Agent业务origin及账号账单/官方模型网关指向官方；套餐页固定官方；更新站单独解析，不因账号登录改回官方更新。沿用原凭据键名、密文格式及存储，无读取真实令牌、无发起真实登录或模型请求。
### Testing
新账号测试6项通过（包括假HTTP init/poll、假凭据enc:v1读写、OAuth回调/网关/更新分离）。外层完整套件26项通过；更新器2脚本通过。pnpm typecheck通过；architecture 0 violations；主进程守卫通过；main全量83既存错误，与HEAD虚拟源码基线相比新增0。全仓lint由3104 warnings/1 error变为3101 warnings/1 error，既存根index.js max-lines未修改；新增账号测试/helper及关键模块lint 0 warnings/0 errors。真实登录、3亿额度、手机实机、打包发布与安装未执行。
### Notes
- packages/ui/src/hooks/useOAuth.ts：恢复state登记、轮询和打开授权网页。
- packages/ui/src/lib/rendererZCodeEndpoint.ts：套餐页固定官方，防止凭据发往自建网页。
- packages/shared/src/zcodeEndpoint.ts：新增官方业务URL构造函数，不改变通用中继/更新origin解析。
- packages/services/src/oauth/providers/configUtils.ts：OAuth初始化、轮询、交换与callback固定官方。
- packages/services/src/model-provider/zaiStartPlanBilling.ts：余额接口固定官方。
- packages/services/src/node.ts：业务配置/账号/Agent/MCP统一官方origin。
- packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts：账号配置接口官方化。
- packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts：额度查询操作走官方。
- packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts：官方MCP额度路由固定官方。
- packages/services/src/session/offPeakRuntimeModel.ts：真实闲时业务origin固定官方，保留mock模式。
- apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts：官方模型网关不继承自建origin，BYOK不改。
- packages/desktop/src/main/desktopRuntimeEnv.ts：Host继承官方业务origin并恢复官方模型网关。
- packages/desktop/src/main/index.ts：业务配置读取官方，更新与强制更新独立解析自建来源。
- packages/desktop/src/main/selfhostUpdateOrigin.ts：自建更新origin解析，防止回落官方。
- packages/desktop/tests/selfhost/official-account-routing.test.ts：官方路由、登录调用与凭据格式隔离回归。
- docs/selfhost-official-account.md：使用边界、配置与待实机项目。
- progress.md：记录授权、检查结果与回滚点。
回滚：对本条所在提交执行git revert。此前版本与刷新补充提交45a13ec；没有改真实用户数据，因此不需要回滚凭据或官方应用。

## 2026-09-25 - Task: 在通用设置中只读显示官方版本更新
### What was done
将官方桌面稳定版公开清单与自托管安装更新器分离，通用设置打开时匿名查询版本、日期、中文或英文更新内容，并支持手动刷新；查询失败保留上次成功信息和时间。没有下载、安装、重启、切换自托管 GitHub 更新渠道或操作当前官方应用。
### Testing
三项清单服务测试通过：匿名请求/中文说明、空说明及失败、按平台和英文说明；pnpm typecheck 通过、architecture check 0 violations、改动源码 lint 0 error。全仓 lint 仍是既存3101 warnings/1 error（未跟踪的根index.js）。公开来源只读核查 macOS arm64 3.14.3 清单；实际UI可视检查待隔离运行环境。未运行官方客户端或读取真实账号。
### Notes
- packages/services/src/system/officialReleaseInfo.ts：匿名公开清单请求、限时及说明解析。
- packages/services/src/system/system.ts：System服务增加可选只读方法，兼容旧服务实现。
- packages/services/src/system/systemService.ts：接入官方清单读取。
- packages/services/tests/official-release-info.test.ts：服务端只读请求与错误处理回归。
- packages/ui/src/settings/OfficialReleaseSection.tsx：设置显示与手动刷新，不含安装动作。
- packages/ui/src/SettingsPage.tsx：在通用设置接入本地Host服务组件。
- packages/ui/src/i18n/locales/zh-CN.ts：新增中文提示。
- packages/ui/src/i18n/locales/en-US.ts：新增英文提示。
- docs/selfhost-official-release-view.md：行为、来源、验证与回滚说明。
- progress.md：追加本轮证据与回滚点。
回滚：对本条所在提交执行git revert。未部署、未安装，无需生产回滚。

## 2026-09-25 - Task: 已领取Start Plan请求级正常验证接线
### What was done
按用户批准扩展Host-Agent协议中的请求原因；Host维护当前请求pending和桌面交互事件，由本地桌面读取官方captcha配置、执行正常SDK验证，再由Host读取当前账号JWT并合并白名单验证头。手机replayable不能订阅/应答；不再次领取活动或搬运登录令牌。
### Testing
离线配置/请求身份/桌面与手机权限/SDK模拟回调及取消测试已通过；pnpm typecheck和架构检查通过；全仓lint仍有既存错误。真实官方SDK、Safari、账号额度和模型扣减尚待隔离客户端验收。本轮未使用真实账号、未变更官方安装。
### Notes
- packages/services/src/coding-plan-subscription/captchaConfig.ts：解析官方配置，区分明确关闭与缺失。
- packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts：官方配置读取与新鲜度。
- packages/services/src/coding-plan-subscription/codingPlanSubscription.ts：新增只读配置合同。
- packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts：代理现有服务。
- packages/services/src/index.ts：公开验证配置类型。
- packages/services/src/model-provider/accountProviderRequestAuthService.ts：扩展请求原因类型。
- packages/services/src/node.ts：仅桌面本地Host提供验证交互。
- packages/services/src/zcode-agent/zcodeAgent.ts：新增Host/Renderer验证请求和回执接口。
- packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts：按desktop-continuous/replayable隔离交互权限。
- packages/services/src/zcode-agent/zcodeAgentService.ts：pending生命周期、JWT重读与请求级响应。
- packages/services/src/zcode-agent/startPlanVerification.ts：验证头白名单与请求身份比对。
- packages/shared/src/zcode-protocol/index.ts：新增captcha-retry请求原因。
- packages/ui/src/Root.tsx：仅桌面安装交互订阅。
- packages/ui/src/root/startPlanCaptcha.ts：请求级SDK交互、超时/取消及清理。
- packages/ui/src/root/useStartPlanVerification.ts：桌面验证响应及取消关联。
- packages/services/tests/captcha-config.test.ts：配置读取及结构回归。
- packages/services/tests/start-plan-verification.test.ts：身份、权限及白名单回归。
- packages/ui/src/root/startPlanCaptcha.test.ts：SDK模拟成功、取消、旧回调隔离。
- docs/selfhost-start-plan-verification.md：状态所有者、验收缺口和边界。
- progress.md：本次证据和回滚点。
回滚：对本条提交执行git revert；先前官方版本动态提交14481e3独立不受影响。未安装部署，无生产回滚。
