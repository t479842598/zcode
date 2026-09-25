# 在设置中只读查看官方更新

“通用设置 → 官方版本动态”打开时通过本地 Host 的 `systemService` 查询官方桌面稳定版公开清单；手动“检查官方版本”可重新查询。显示当前自托管版号、官方版号、发布日期、中文/英文更新内容、官方更新说明链接和上次成功检查时间。远端文本以 React 文本节点显示，不执行 HTML 或 Markdown 中的脚本。

只读查询直接使用匿名 `fetch`，不经过带账号/设备头的 `ApiClient`，不提供下载、安装、重启入口，不调用自托管安装更新器，也不修改已有独立 GitHub 更新源。相同版本号仅说明版本标识相同，不能推断构建内容相同。查询失败时保留上次成功的内容和检查时间，同时标明本次失败，不误报“已是最新”。

来源：官方桌面稳定版公开 YAML 清单 `https://zcode.z.ai/api/v1/releases/electron/manifest`，按当前运行平台/架构选择 platform，channel 固定为 1。2026-09-25 只读核查 macOS arm64 清单返回 3.14.3、releaseDate、releaseNotesByLocale.zh-CN；GitHub 开源仓库 tag 发布时刻与官方页面不同，因此不使用其 tag 作为桌面发布权威来源。

验证：`node --import ./node_modules/tsx/dist/loader.mjs --test packages/services/tests/official-release-info.test.ts`；正常响应、离线/错误响应、无说明、平台映射和英文说明覆盖。实际设置交互在独立自托管应用可运行后仍需可视检查；当前 `/Applications/ZCode.app` 不作改动。回滚对应提交即可，不涉及用户数据迁移。
