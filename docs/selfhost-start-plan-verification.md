# 已领取 Start Plan 的请求级正常验证

2026-09-25 源码接线：桌面 `desktop-continuous` 连接承接当前模型请求的官方配置与正常SDK验证；`web-remote-replayable` 不可订阅验证事件或提交回执。验证参数只在当前请求的 Host pending 中等待，响应时 Host 重读当前账号访问与JWT，不接收 Renderer 指定的身份材料；CLI收到的回执是当次的两项验证头和对应账号鉴权。

```text
CLI请求(model-request/captcha-retry)
 → Host按workspace identity/session/requestId登记pending
 → 桌面窗口读取官方client/configs → SDK完成无感或交互验证
 → Host重读配置与账号 → 校验pending → 仅当前请求回传
 → CLI发送官方模型请求；CLI取消/超时或窗口关闭则移除pending
```

- 服务端显式返回 `enabled: false` 时才不要求验证码。配置缺失、结构不全、SDK未能加载、认证失败和无桌面窗口均明确失败，不发送仅带JWT的Start Plan模型请求。
- 验证回执不存磁盘、不复用；成功后清除DOM，取消或超时不回传。手机端只通过已有Host运行任务，不获得验证码/JWT；如果桌面不在线会收到明确失败。
- 现有余额桶、套餐/模型白名单及账本规则未改；未重复领取用户已领活动，也未调用真实模型/余额接口。
- 本轮离线测试覆盖配置结构/禁用态、官方配置读取、正常/取消/重复SDK回调、请求级identity隔离和desktop/replayable连接边界。真实SDK行为、官方服务端活动准入和模型扣减仍未验证，不把离线通过当作3亿额度可用。

本次不包含活动预览与再次领取入口；那是不同业务动作，须在当前已领取权益实机验收后另行处理。若官方服务返回安全校验错误，应保留原始业务码并停止，不尝试绕开验证。

## 排队取消回归（2026-09-25）

同一桌面窗口内同时等待多轮验证时，取消排队中的第二轮不能立即释放它占有的队列位置；必须等第一轮结束后再移交给第三轮。新测试先复现第三轮越过第一轮、随后修复并通过。官方配置没有显式 `enabled` 但包含完整 `region/prefix/sceneId` 时视为需要验证；只有服务端明确 `enabled: false` 才跳过，不把缺字段误判为关闭。

## 连接角色补充（2026-09-25）

`desktop-continuous` 也可能表示远程 trusted-host-relay，并不必然是本机UI。安全验证事件与应答仅开放给 `desktop-continuous + terminal-client` 的当前桌面窗口；`web-remote-replayable` 和 `trusted-host-relay` 均不能取得或提交验证码回执。已增加两类负向测试，正常本机桌面正向测试保留。

## 配置变化与隔离编译（2026-09-25）

Host在发送前重新读取官方配置；Renderer回执的`verificationNotRequired`必须与当前`enabled:false`一致，若其间启用/关闭状态改变则当前请求失败，不会退化成JWT-only。纯假数据检查覆盖关闭、缺失与启用但无回执。Host及Renderer分别以esbuild隔离构建到`/private/tmp`通过；第一次renderer直接esbuild缺少SVG/PNG loader后补资源loader通过。此检查不代替完整Electron打包、真实官方SDK和服务器验收。
