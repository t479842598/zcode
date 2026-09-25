# 移动远控入口的位置

基于已安装官方3.14.3只读包的WorkspaceSidebarFooter：桌面且有工作区时，紧凑手机图标在侧栏footer操作区、设置按钮左侧。自托管版将原头像下拉“移动端远程控制”入口迁到同一位置，仍使用原有WebRemoteControlDialog和本地Host服务，不另建中继连接状态。

验收：`node --import ./node_modules/tsx/dist/loader.mjs --test packages/ui/test/webRemoteTriggerPlacement.test.ts`；typecheck与架构检查通过。实际渲染/点击和手机二维码功能须在隔离构建/安装后观察，不把静态测试当实机验收。
