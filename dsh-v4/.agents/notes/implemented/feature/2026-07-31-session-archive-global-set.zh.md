# Agent Note: 会话归档（注册表级全局集合）

Status: implemented

[English](2026-07-31-session-archive-global-set.md) | 中文

## 问题

Sidebar workspace 浏览区的会话行菜单里，「Delete session」一直是纯视觉占位（无 handler）。产品口径定为**归档**而非删除：会话日志与 workspace 记账都不动，只把该会话从所有分组视图（workspace 分组、Ungrouped、搜索、平铺列表）里隐藏。归档记录需要一个落点：Ungrouped 的会话不属于任何 workspace 实体，per-workspace 字段放不下它。

## 决策

**归档集合是 workspace domain 全局单例（`workspaceDomainState.archivedSessionIds`）上的一个新字段，覆盖在 workspace 记账之上；显示过滤全部收敛在 client 的 `tree.ts` 派生层；wire 面走全快照姿态。**

- 存储：`archivedSessionIds: z.array(sessionId).default([])`，domain version 保持 2——纯新增字段，旧介质经 schema default 解析为空集合，无迁移代码。被归档的会话保留其 `sessionIds` slot（未来取消归档恢复原位置），因此与「一个会话只被一个 workspace 记账」不变式零纠缠。
- 注册表：`ctx.workspaceRegistry.archiveSession(id)` 走 `enqueueOperation` 与 create/delete 串行；未知会话（实时与持久化都查不到）抛 `WorkspaceUnknownSessionError`；已归档 id 不写盘不发事件。`archivedSessionIds` getter 暴露只读集合。
- RPC：`workspace.archiveSession({sessionId}) → {archivedSessionIds}`（应答更新后的完整集合）；`workspace.list` 响应携带集合作为重连基线；新 host 帧 `host/archived-sessions-changed` 在每次持久变更后推完整快照（与 `host/workspace-changed` 同姿态，从 `domain/changed` 的 global put 分支比对推帧）。未知会话复用错误码 `session-not-found`。
- client 运行时：`WorkspaceListState.archivedSessionIds`（按 Host 顺序的 `readonly SessionId[]`，成员不变不换引用——公有快照状态保持 store 引擎的纯数据词汇：immer draft 不开 MapSet 插件就不接受 Set；membership 查询在派生函数内自建临时 Set，与 expandedProjects 同款）；list 基线、归档／恢复／删除的一元回声和 changed 帧三路都会用完整集合整体替换现有值。`WorkspaceRuntime.archiveSession(sessionId)` 只为发起该本地操作的 selection 清空当前会话，因此远程归档的 Session 仍保持打开并可查看；`unarchiveSession` 移除归档成员关系但不改变 Workspace 记账，`deleteArchivedSession` 则从客户端投影中移除已永久删除的 id。帧/回声落在 in-flight `workspace.list` 期间时还会屏蔽旧基线对新集合的回滚。
- UI：归档模式从既有列表元数据列出普通归档 Session，并在不恢复的情况下打开其既有历史。每行提供恢复和明确确认后的永久删除；运行中或由外部 owner 持有的实时 Session 禁止删除。普通会话模式继续在分组、单列表和搜索派生中排除归档 id。

## 已考虑的替代方案

**per-workspace archivedSessionIds（最初表述）。** 否决：Ungrouped 会话无落点；用户改口全局。

**SessionSummary 打 archived 标（session.list 层）。** 否决：要把 workspace domain 事实 join 进 sessions domain 投影，summary 无增量帧还得另发通知，跨域耦合大于收益。

**host 侧在 `workspaceView`/`sessionIds` getter 过滤。** 否决：归档 ≠ 改记账，投影过滤会把两个概念搅浑；未来恢复入口也需要 client 拿到全量记账。

**增量帧（archived/removed 单条）。** 否决：集合极小、变更频率低，全快照免去 client 侧合并逻辑与去重状态，与 workspace-changed 现有姿态一致。

## 后果

归档 Session 仍可从专用归档模式访问，并在不恢复的情况下打开既有历史。恢复会保留 Workspace 记账顺序。永久删除通过持久化协调器串行执行，拒绝实时 owner，删除持久会话记录，清理注册表记账并广播 `host/session-removed`；确认后不可逆。`workspace.list` 响应变化属于 pre-release 直接修改（无兼容层）。workspace-management e2e 覆盖完整链路；domain、persistence、host、runtime 和 UI 测试覆盖生命周期及失败行为。
