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

## 2026-09-25 - Task: 修复验证排队取消导致下一轮并发进入SDK
### What was done
修复排队中的验证被取消后过早放行第三轮的问题；保留先后顺序直到前一轮真正完成。官方配置未声明enabled但具备完整参数时视为启用，显式false才关闭。
### Testing
新增排队取消用例先失败（第三轮越过第一轮），修复后4个SDK模拟用例通过；配置解析2项测试通过。最终完整类型、lint与架构检查见交付汇总，真实官方SDK与额度仍待T-005验收。
### Notes
- packages/ui/src/root/startPlanCaptcha.ts：取消排队时延后释放队列位置。
- packages/ui/src/root/startPlanCaptcha.test.ts：复现并验证第三轮不得越过第一轮。
- packages/services/src/coding-plan-subscription/captchaConfig.ts：完整配置缺省启用。
- packages/services/tests/captcha-config.test.ts：回归缺省启用与显式关闭。
- docs/selfhost-start-plan-verification.md：补排队时序与配置语义。
- progress.md：追加测试证据及回滚点。
回滚：对本条提交执行git revert；上一轮源码提交c9ac81e。未部署，不影响官方客户端。

## 2026-09-25 - Task: 收紧验证码交互的桌面连接角色
### What was done
按实际连接角色区分本机desktop-continuous terminal-client与远程trusted-host-relay，后者不得获取或提交验证信息。保留手机replayable的拒绝边界。
### Testing
角色边界8项测试通过，typecheck通过，改动文件oxlint 0 warnings/0 errors，diff --check通过。真实活动额度仍待实机验证。
### Notes
- packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts：增加terminal-client角色校验。
- packages/services/tests/start-plan-verification.test.ts：补trusted-host-relay负向回归。
- docs/selfhost-start-plan-verification.md：记录本机UI与远端Host角色差异。
- progress.md：追加测试和回滚点。
回滚：对本条提交执行git revert，前一源码提交0c04e70；未安装或部署。

## 2026-09-25 - Task: 收紧验证码配置变化门禁并完成隔离编译
### What was done
Host要求Renderer关于“本次不需要验证”的回执与发送前最新官方配置完全一致；状态变化时报错，不仅阻断从关闭切到启用，也阻断从启用切到关闭时使用旧证明。避免任何仅带JWT的意外降级。
### Testing
本轮验证/更新测试18项通过；Host bundle及Renderer含资源loader的隔离esbuild输出到/private/tmp成功；typecheck和architecture check通过。真实SDK与模型余额仍未验收。
### Notes
- packages/services/src/zcode-agent/zcodeAgentService.ts：配置状态一致性门禁。
- packages/services/tests/start-plan-verification.test.ts：启用/缺失/关闭差异回归。
- docs/selfhost-start-plan-verification.md：配置变化与隔离编译证据。
- progress.md：追加证据和回滚点。
回滚：对此条提交执行git revert；上一轮32a3001。无部署或官方应用修改。

## 2026-09-25 - Task: 移动远控按钮与官方侧栏位置对齐
### What was done
将入口从头像菜单迁至桌面工作区侧栏footer设置按钮左侧，保持原二维码弹窗、Host和连接身份；没有在手机端和无工作区页面添加空按钮。
### Testing
入口布局静态测试1项通过；pnpm typecheck与architecture检查通过，真实UI点击及二维码需打包后检查。官方已安装包只读确认触发器在footer设置按钮左侧。
### Notes
- packages/ui/src/WorkspaceSidebarFooter.tsx：移除下拉入口，增加紧凑手机图标按钮。
- packages/ui/test/webRemoteTriggerPlacement.test.ts：确认按钮顺序、desktop/workspace条件及无重复入口。
- docs/selfhost-remote-entry.md：记录官方来源、复用原弹窗及实际UI待验。
- progress.md：追加本轮证据和回滚点。
回滚：本条提交执行git revert；无安装或部署时无需生产回滚。

## 2026-09-25 - Task: 发布凭据不再回退源码常量
### What was done
去掉发布脚本中的静态SSH密码回退，缺少环境变量时在上传前明确拒绝。没有上传、登录或更改线上凭据。
### Testing
发布凭据测试1项和语法检查通过；后续仍须发布环境用明确注入的凭据验收。源代码历史已有敏感内容的处置不等同于本次删去当前文件。
### Notes
- scripts/publish-release.mjs：只接受ZCODE_RELEASE_SSH_PASS，不再用仓库硬编码密码。
- scripts/tests/publishReleaseCredential.test.mjs：回归缺失凭据门禁。
- docs/selfhost-publish-credential.md：记录运行条件和历史风险边界。
- progress.md：追加测试与回滚说明。
回滚：对此条提交使用git revert，但不得恢复旧的静态密码；前一提交0a6ea87。无线上操作。

## 2026-09-26 - Task: 修复手机端远控每45秒重连
### What was done
以线上终端连接时序和nginx文档请求区分WebSocket重连与整页刷新；定位桌面没有回rpc-frame-ack使手机45秒重放期限耗尽。完成完整帧ACK、重复帧仅ACK不重放业务、旧桥/坏帧不ACK和切桥清理。
### Testing
新增ACK回归先失败再通过；中继本机28项集成回归、typecheck和architecture检查通过。线上长期连接尚待替换新桌面包后观察；当前已安装包不含此修复，不能认为故障已在生产消失。
### Notes
- packages/desktop/src/host/relayDeviceSocket.ts：验证并交付手机RPC后回当前bridge的ACK，避免重复处理。
- packages/desktop/tests/selfhost/relay-refresh.test.ts：ACK、重复、坏帧和旧bridge负向测试。
- packages/desktop/tests/selfhost/relay-lifecycle.test.ts：初始化测试区分ACK与业务帧。
- docs/selfhost-relay-refresh.md：记录线上时间线、根因、修复和未验项。
- progress.md：追加验证证据与回滚点。
回滚：本条提交执行git revert；已安装候选若升级须按原应用备份回滚。线上中继代码未因本条改动。

## 2026-09-26 - Task: 草稿品牌、手机按钮视觉与工作流差异清单
### What was done
新对话草稿欢迎态展示Zcode_满血_青棠、本地仓库入口和核实的GitHub项目链接；手机中继按钮增大并提高对比度，不改弹窗。按官方3.14.3发布说明/备份安装包与当前源码列出工作流已有、确认缺失和待验证功能。根README移除末尾优惠/声明引用，NOTICE文件保留。
### Testing
品牌与按钮静态测试2项、typecheck与architecture检查通过；改动文件oxlint零错误。实际品牌/图标须新包可视验收；工作流只读差异未经用户选择不做移植。
### Notes
- README.md：移除末尾优惠声明链接。
- packages/ui/src/v4/ConversationDraftAttribution.tsx：品牌、本地仓库及GitHub链接。
- packages/ui/src/v4/ConversationDraftEmptyState.tsx：仅草稿欢迎态嵌入出处行。
- packages/ui/src/WorkspaceSidebarFooter.tsx：中继图标尺寸和颜色对比优化。
- packages/ui/test/draftAttribution.test.ts：草稿品牌和链接回归。
- docs/selfhost-workflow-parity.md：供用户选择的工作流差异清单。
- progress.md：追加本轮验证、范围与回滚点。
回滚：对本条提交执行git revert；已装应用需按备份恢复或后续包替换，源码回滚不会自动更改已装应用。

## 2026-09-26 - Task: 远控运行中任务状态误显示已完成
### What was done
Host的移动列表在持久索引之上只读叠加现有Agent session当前状态，匹配身份和taskId；旧索引completed且runtime running时返回running，不启动Agent，不改变数据库或中继协议。
### Testing
先构造旧完成/当前运行的失败用例，修复后两条状态单测通过；30项本机relay套件、typecheck、architecture 0 violations、改动文件oxlint零警告/错误通过。真实手机列表及后台workflow状态待打包部署后验证。
### Notes
- packages/desktop/src/host/relayLiveTaskStatus.ts：现有runtime状态叠加，身份与错误边界。
- packages/desktop/src/host/index.ts：mobile bootstrap/list任务读端接入。
- packages/desktop/tests/selfhost/relay-live-task-status.test.ts：running覆盖旧completed与跨workspace负向测试。
- docs/selfhost-remote-live-task-status.md：行为和实机待验说明。
- progress.md：追加测试和回滚点。
回滚：本条提交git revert。现有已装客户端在后续替换前不含本修复。

## 2026-09-26 - Task: 官方3.14.3工作流A/B/C/D同步与远控实时状态修复
### What was done
先在隔离工作树合并官方公开3.14.3源码，解决README和自建远控相关冲突后带回当前分支，保留账号/自建中继/更新/品牌。A运行中并发上限、B修改续跑和卡片修复、C大流程状态/脚本投影、D保存历史图续跑按用户所选完整同步。手机任务列表从旧持久completed叠加当前existing-only Agent session running，避免误报完成。
### Testing
隔离工作树与主分支typecheck通过；CLI packages编译通过；工作流A/B/C/D四项回归、relay30项和远控身份状态2项通过；架构检查0违反。全仓lint仍有原有未跟踪index.js的1项错误，未声称通过。实际工作流执行、手机端运行态、官方服务账号需发布后验收。
### Notes
- 官方同步涉及工作流runtime、共享协议投影、UI卡片及相关依赖，独立提交fa1745d；仍保留自建远控入口和WebRemoteControlDialog。
- packages/desktop/src/host/relayLiveTaskStatus.ts：只合并同身份现有runtime的任务状态。
- packages/desktop/src/host/index.ts：mobile bootstrap/list接入实时叠加。
- packages/desktop/tests/selfhost/relay-live-task-status.test.ts：旧completed/live running及跨identity负向回归。
- packages/ui/test/selfhostWorkflowParity.test.ts：四类能力合同回归。
- docs/selfhost-remote-live-task-status.md：状态源与未验项。
- docs/selfhost-workflow-parity.md：用户已全选的同步证据与真实验收边界。
- progress.md：本轮证据和回滚点。
回滚：独立git revert 8a25957、fa1745d；正式包替换后还需按已有ZCode.app备份回滚，不通过撤销源码代替应用回滚。

## 2026-09-26 - Task: 准备官方工作流完整同步后的正式发布
### What was done
整理自托管3.14.3正式版更新说明，列明官方公开工作流A/B/C/D、ACK与移动状态修复、品牌及中继安全变更；仍以实际正式包hash和实机验证作为最终门禁。
### Testing
upstream typecheck与CLI packages编译通过；工作流合同6项、relay本机30项通过；架构检查零违规。正式包构建、安装验收与GitHub发布另行记录，不把准备文案写成已经上线。
### Notes
- docs/releases/v3.14.3-selfhost.md：本次正式版说明、验证范围和回滚依据。
- progress.md：追加发布准备与测试证据。
回滚：本条提交执行git revert；APP和在线中继不因文档提交而改变。

## 2026-09-26 - Task: 草稿底部移除本地仓库显示
### What was done
按用户追加要求仅移除本地仓库路径及文件管理器入口，保留Zcode_满血_青棠与GitHub仓库链接，不改草稿以外的会话布局。
### Testing
草稿品牌静态回归1项、typecheck与architecture通过；改动文件oxlint零错误零警告，真实已安装UI需随最终包验收。
### Notes
- packages/ui/src/v4/ConversationDraftAttribution.tsx：移除本地路径和跳转，仅保留GitHub。
- packages/ui/test/draftAttribution.test.ts：新增无本地路径断言。
- docs/selfhost-workflow-parity.md：记录最终品牌栏范围。
- progress.md：记录验证与回滚点。
回滚：本条提交git revert；APP须重新打包替换或从备份恢复，不能仅回滚源码。

## 2026-09-26 - Task: 正式发行前核对草稿品牌和版本说明
### What was done
已安装新构建后在真实UI确认草稿只显示Zcode_满血_青棠和GitHub仓库超链接，不含本地路径；同步更正Release说明中旧的本地仓库措辞。
### Testing
已安装正式身份APP为单实例，asar与候选构建哈希一致、SQLite完整性ok，界面可见GitHub入口。更正文档git diff --check通过；最终发行包需按本次提交重新构建。
### Notes
- docs/releases/v3.14.3-selfhost.md：删除过时本地仓库描述。
- progress.md：追加实际UI验证和发行包重建门禁。
回滚：本条提交git revert；已安装APP的回滚仍按备份执行。
