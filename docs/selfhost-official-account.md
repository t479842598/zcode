# 自托管基础设施与官方账号通道

## 已实现的边界

2026-09-24 用户明确要求恢复官方登录和权益通道。代码已恢复原有 OAuth state 注册、轮询以及浏览器授权跳转；没有执行真实登录，没有读取、迁移或上传当前账号令牌。

| 用途 | 路由 |
|---|---|
| OAuth 初始化、轮询、token交换、网页回跳 | 官方 ZCode 账号服务 |
| 账号套餐、Start Plan余额、官方模型网关、MCP权益/配额、闲时业务 | 官方业务地址 |
| Host/Agent业务origin | 官方ZCode地址，不继承中继/更新站的通用origin |
| 内嵌套餐页 | 官方来源，不把登录凭据交给自建网页 |
| 自建relay与手机页面 | 保留原来的ZCODE_SELFHOST_RELAY_WS_URL / ZCODE_SELFHOST_WEB_REMOTE_URL配置 |
| 更新清单与强制更新检查 | 自建更新站；优先ZCODE_SELFHOST_UPDATE_ORIGIN，其次既有自建设置/构建origin，官方origin不会作为默认更新回退 |
| 安装包 | 保留现有独立GitHub Releases发布仓库，不指向官方产物 |
| BYOK | 保持自定义提供商直连，不强制使用官方账号 |

Host显式把官方模型网关禁用开关置为0；独立CLI中的显式禁用开关仍保留供用户自配BYOK使用。源代码没有复制官方闭源实现，也不伪造服务端权益。

## 登录状态和凭据

继续使用原有CredentialService、OAuthCredentialRepo、credentials.json路径、oauth:<provider>:access_token、oauth:active_provider、zcodejwttoken及enc:v1 AES-GCM格式。没有创建第二份令牌存储或数据同步服务。已只读核实官方3.14.3包包含相同的格式、键名和加密方案标记；假凭据读写测试通过。

真实兼容尚未验证：同机同用户、加密secret和数据路径一致时才有复用基础；不得把Mac本地密文复制到不同用户/服务器后直接宣称可解密。到替换阶段先验证一致性备份副本；过期令牌通过正常官方登录重新获取，不修改JWT有效期或设备身份。

## 测试及剩余门禁

`node patches/tools/test-relay.mjs`（外层项目根）包含官方账号回归：自建origin不能改变OAuth token/callback域名，模型网关走官方，BYOK不变，原凭据格式兼容，更新源不回退官方，OAuth init/poll使用假HTTP响应。

当前登录hook验证包含静态调用契约，服务层init/poll为运行测试；浏览器授权、深链回跳、真实账号余额和模型扣减仍需实机验证，不能把假响应测试当作活动可用证明。

根typecheck通过；完整main类型检查有83个既存错误，本轮基于HEAD虚拟源码对比确认新增0。新增代码检查通过。版本3.14.3只是对齐已安装官方版本，并非宣称已合并全部上游发布。

实机、线上及替换按用户要求延后，不自动运行。relay注册密钥保护和日志秘密治理属于另一安全任务，未因本次恢复OAuth而自动获准修改。
