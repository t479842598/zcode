# 官方 3.14.3 工作流与自托管版差异（待用户选择）

只读对比已备份官方 3.14.3 `app.asar` 与本仓公开源码；**不把功能名称出现等同实际可用**。用户选择后才实施新增功能。

| 功能 | 自托管当前证据 | 官方/发布证据 | 判断与优先级 |
|---|---|---|---|
| 保存/列表/详情、项目与全局分组 | `packages/services/src/zcode-agent/zcodeAgent.ts` 有 list/get/updateMeta/move/delete 接口；`packages/ui/src/settings/saved-workflows/` 有中枢与历史页 | 官方包有对应入口 | **已有，先实测** |
| 工作流实例图、阶段/参与者状态、暂停后续跑 | `packages/ui/src/components/workflow-timeline`、`v4/ConversationStatusPanel.tsx`、CLI dynamic-workflow-runtime | 官方3.14.3有相关能力 | **已有核心**，异常恢复体验待实测 |
| 运行中调整并发上限 | 当前CLI有启动时 ceiling/governor，未发现运行中用户设置入口 | 官方3.14.3 release notes 明确新增 | **确认差异，P1**；需命令、运行时权限及状态同步 |
| 修改后重启复用、卡片布局/崩溃 | 有 amend/resume 与卡片组件，不能仅静态判断是否含官方修复 | 官方3.14.3 release notes 提及优化/修复 | **待差分与回归，P1** |
| 大型工作流状态、脚本提交效率/token | 已有 graph/timeline 与脚本提交路径 | 官方3.14.3发布说明有改进 | **待性能基线，P2** |
| 官方营销/手动领取和远控平台扩展 | 已接官方登录与请求级验证但额度尚未实机通过；平台请求部分 unsupported | 官方包有相应入口 | **分别选，P2**；已领活动不自动重领 |

建议先选择“运行中调整并发”及“修改重启/卡片稳定性回归”，再决定是否做性能优化。选定后沿 lrnev 新任务实现、测试并打包。
