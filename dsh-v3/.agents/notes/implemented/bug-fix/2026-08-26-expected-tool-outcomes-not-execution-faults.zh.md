# Agent Note: Expected tool outcomes are not execution faults

Status: implemented

[English](2026-08-26-expected-tool-outcomes-not-execution-faults.md) | 中文

## 问题

若干缺陷共享同一个根源：预期中的工具结果被当作执行框架故障处理。工具结果是契约在说话——schema 参数被拒、审批策略拦截、人类拒绝、沙箱拒绝、冗余的升级字段、权限受限的部分搜索结果、携带了其 action 并不拥有的字段的 goal 更新——这些都是正常、可重试的结果，而不是执行框架或循环已损坏的证据。失败类别原先从英文 `message` 文本读取，措辞变化和本地化都会破坏分类；严格填充的模型用现行沙箱模式填充可选键，会触发调用从未请求过的审批弹窗；宽泛 glob 会暴露每一个 `node_modules` 文件，或让不可读路径看似不存在；goal 更新会因小数 revision 和误填的条件字段而以泛化消息失败；确定性的 `'never'` 审批策略未被与人类拒绝区分开；已收束的调用只有一种无差别的失败呈现，因此策略拦截和取消看起来和真实错误一样。

## 决策

**已收束的工具结果是四种 kind 之一，依据稳定 code 分类；只有 `error` 渲染为失败。** 客户端运行时分类器定义 `ToolOutcomeKind = 'success' | 'stopped' | 'blocked' | 'error'`：调用不是错误时为 `success`；取消或中断类 code（`ABORTED`、`TOOL_NOT_STARTED`、`ASK_CANCELLED`、`TOOL_APPROVAL_CANCELLED`、`SANDBOX_ESCALATION_CANCELLED`、`interrupted` 等）为 `stopped`；拒绝与模型可纠正条件（`TOOL_POLICY_DENIED`、`TOOL_APPROVAL_BLOCKED`/`REJECTED`/`UNAVAILABLE`、`TOOL_POST_BLOCKED`、`SANDBOX_ESCALATION_BLOCKED`/`REJECTED`/`UNAVAILABLE`、`INVALID_ARGS`、`UNKNOWN_TOOL`、点名列出的 `FS_*`/`SEARCH_*` 条件，以及 `GOAL_TOOL_*` 家族）为 `blocked`；一切未知或无 code 的失败为 `error`。分类器只读取 `isError` 与 `error.code`——绝不读取面向模型的文本。轨迹与工具行把 kind 用于呈现：只有 `error` 携带失败状态（`data-error`），`stopped` 与 `blocked` 在行状态词汇 `running | ok | error | stopped | blocked` 下以非红色渲染。通用工具行模型、其按工具名的 keyed 视图（bash、read、search、todo、web、ask-question、file-mutation）与 skill 行都通过同一个 `toolOutcomeKind` 分类器推导状态。在轨迹中，assistant 请求被用户或父级停止——被中断的消息，或没有可视结果的中断轮次——收束为 `stopped`，绝不是失败；而重试或非 abort 的边界保持 `error`，因此真实 provider 失败永不被降级。blocked 行的折叠拒绝摘要会去掉注册表写入的 `Error: ` 前缀；这只是展示层——持久结果文本不变，`error` 行保留该前缀，因为消息本身就是失败。

**认可的预期失败 code 带 `TOOL_`/`SANDBOX_` 前缀。** 共享词汇以 `error.info.code` 呈现在 `isError` 结果上：`TOOL_POLICY_DENIED`（无更具体 code 的 pre-execute 策略或守卫拒绝）、`TOOL_APPROVAL_BLOCKED`/`REJECTED`/`CANCELLED`/`UNAVAILABLE`（审批 seam 结果）、`TOOL_POST_BLOCKED`（post-execute `block` 决策）、以及 `SANDBOX_ESCALATION_BLOCKED`/`REJECTED`/`CANCELLED`/`UNAVAILABLE`（升级解析）。`INVALID_ARGS` 是共享的：schema 参数被拒与升级参数配对——`sandbox_permissions` 与 `justification` 必须成对出现且 justification 必须非空——都抛出它，因此客户端把未配对的升级字段分类为可纠正的 `blocked` 调用。没有 code 的失败保持 `error`；绝不会被静默降级。

**审批策略结果与人类拒绝保持分离。** 封闭的结果词汇 `'allowed-once' | 'rejected' | 'blocked' | 'cancelled' | 'unavailable'` 在[审批 seam](../feature/2026-07-06-approval-seam.zh.md) 与沙箱升级模块之间结构共享。`'blocked'` 是确定性的策略结果——`'never'` 策略在分发时、任何应答者看到之前就解析每一次询问——与人类或应答者的 `'rejected'` 不同。拒绝 code 保持这一区分（`TOOL_APPROVAL_BLOCKED` 对 `TOOL_APPROVAL_REJECTED`，`SANDBOX_ESCALATION_BLOCKED` 对 `SANDBOX_ESCALATION_REJECTED`），因此策略拦截与用户拒绝永远不会混为一谈。

**冗余沙箱请求不触发审批；真正的升级在执行期强制；按 agent 的 schema 不广告该 agent 无法获得的升级。** 不严格宽于调用有效模式的 `sandbox_permissions` 请求是严格 schema 下的冗余字段：调用在有效模式下运行，无审批、无错误。严格加宽是对每次调用的有效模式（会话覆盖或组合默认）通过 `WIDER_MODES` 阶梯做的执行期检查——刻意不做成 schema 约束，因为 schema 是注册表全局的，而有效模式是每次调用的真相。按 agent 投影（`projectSchema`，经 `schemasFor(agent)` 用于提示词组装与 Code Mode SDK）与同轮次拒绝提示共用同一个谓词：有效审批策略为 `'never'`、或有效模式已是 `danger-full-access` 的 agent，看不到任何升级字段，也看不到升级描述子句——没有可升级的目标。静态参数保持组合级，用于诊断与 `schemas(scope)`。执行期强制不变：schema 省略只是广告，不是绕过守卫。

**glob 发现默认限制规模并标注部分结果。** `globExcludeNodeModules` 是默认为 `true` 的配置键：`node_modules` 与 VCS 元数据目录一起进入 `GLOB_DEFAULT_EXCLUDES`，按名称以两条取反的 ripgrep glob 实施。必须检查依赖源码的部署把它设为 `false`，工具描述与指引随即停止广告该排除（`node_modules` 像其他目录一样被搜索）——部署永远不会广告它并不实施的排除。权限受限的运行读不到某些路径时，会返回已找到的路径并携带显式的 `warnings` 数组，同时在面向模型的文本中追加部分结果依据，因此模型绝不会把不可读路径误认为不存在；超上限页面遵循[采样决策](../bug-fix/2026-07-27-glob-sampling.zh.md)。

**goal 更新契约保留扁平判别式。** `update_goal` 保留扁平的 `action` enum，其按 action 区分的可选字段在 `execute` 中强制，误填以精确的 omit 风格错误被拒绝（`omit "<field>" when action is "<action>": "<field>" is valid only with action "<owner>"`，code `GOAL_TOOL_INVALID_UPDATE`）。`revision` 在 schema 中固定为 `integer`，因此小数 revision 在任何权限检查之前就在 schema 层失败（`INVALID_ARGS`），而该 action 未使用的字段中的空字符串和零填充值仍然视为省略。[面向模型的 goal 工具注记](../feature/2026-07-19-model-facing-goal-tools.zh.md)负责权限拆分；本注记负责参数契约。

**重复的相同失败只是 advisory（建议性），失败后的重试在第 2 次尝试时提醒。** 按 agent 的重复调用守卫以模型可见的提醒（`additionalContexts` 通知）丰富 post-execute 决策，绝不否决或改写调用；用户插话会重置链。其失败感知层在先前相同结果失败且运行达到 `failureRetryThreshold`（默认 2）——即失败后的第 2 次尝试——时触发，并引用结构化的 `previous_error_code`，同样是稳定 code 而非解析出的 message 文本。

## 考虑过的替代方案

- **工具参数根级 `oneOf`。** 被否决：参数 DSL 把每个工具根编译为隐式对象属性表，根级 `oneOf` 需要扩展 tools API，而且严格 provider 在线上要求 object 根参数 schema。
- **每个 goal action 一个工具。** 被否决：按 action 拆工具会拆分共享的比较并设置 ref（`goal_id`/`revision`）、放大已发布工具清单及其指引，并扰动工具名单与回放门禁。
- **通过解析英文 message 分类失败。** 被否决：措辞与本地化脆弱；分类器以 `error.code` 为依据，把未知或无 code 的失败降级为 `error` 而不是静默降级。
- **升级的 schema 层加宽约束。** 被否决：schema 是注册表全局的，有效模式是每次调用的真相；执行期检查在保留封闭目标 enum 的同时逐调用判定，按 agent 的 schema 投影只塑造广告。
- **拒绝冗余升级字段。** 被否决：严格填充的模型可能合理地用现行模式填充可选键；这必须是 no-op，绝不能成为失败调用或审批弹窗。
- **完全从静态参数移除升级。** 被否决：组合级广告为诊断与 `schemas(scope)` 保留；按 agent 的 `projectSchema` 在无法授予处隐藏它。
- **重复提醒否决或拦截重复。** 被否决：advisory 让模型保持控制——提醒是上下文，不是强制；被拦截的调用仍会通过 `additionalContexts` 收到提示。

## 后果

失败面现在可以按 code 路由：循环、守卫、UI 和测试都不再解析散文文本即可把结果分类为 `success`/`stopped`/`blocked`/`error`，未知失败保持为 `error` 而不是被静默降级。UI 只把真实失败显示为错误；策略拦截与取消以非红色渲染。严格填充的模型不会受到惩罚——冗余可选字段（现行沙箱模式、空的 goal 填充值）是无害的 no-op，用户也绝不会因非事件被弹窗打扰：只有真正更宽的沙箱请求才会触发审批，且在执行期强制。按 agent 的 schema 投影把不可获得的升级移出模型视野，同时不削弱强制。代价：放弃 schema 级互斥（`update_goal` 的按 action 必填与条件加宽都位于各工具的执行路径中，配以精确错误，因为受强制的 JSON Schema 子集无法表达 if/then 或 dependent-required）；`node_modules` 排除是配置默认而不是法则；code 词汇表按失败家族增加一个稳定前缀。

## 测试

`packages/client/runtime/tests/tool-outcome.client.spec.ts` 钉住分类器：每个稳定 code 映射到 `success`、`stopped`、`blocked` 或 `error`，未知或无 code 的失败保持 `error`。`packages/client/ui-tool/tests/tool-row.client.spec.tsx` 与 `tool-row-styles.client.spec.ts` 钉住通用行及其 keyed 视图经 `toolOutcomeKind` 的共享行状态推导，`packages/client/ui-skill/tests/skill-row.client.spec.tsx` 钉住同样的推导与 blocked skill 行去掉 `Error: ` 前缀，轨迹 `table`/`layout`/`conversation-definitions` 客户端 spec 钉住只有 `error` 渲染失败状态、用户或父级停止收束为 `stopped`、provider 失败保持 `error`。真实的 bash-abort 行快照（`apps/web/tests/snapshots/bash-abort-row`）在 refresh 与 replay 中均通过：Chat 显示 stopped Bash 行，折叠时显示参数摘要，展开后显示一份完整的持久化中止输出且没有红色标记；Trajectory 显示两条 stopped Bash 行且没有失败标记。`packages/extensions/ui-cordis/tests/card-model.client.spec.ts` 也钉住了 Cordis keyed 行使用同一分类器。`packages/core/tools/tests/tools.spec.ts` 覆盖按 agent 的 schema 投影：`schemasFor(agent)` 以精确的活跃 agent 应用 `projectSchema`，而 `schemas(scope)` 保持静态且绝不调用它。`packages/shell/tool-bash/tests/tools.spec.ts` 与 `integration.spec.ts` 钉住 `'never'` 策略或 `danger-full-access` 模式下的升级广告与投影后 schema。`packages/sandbox/sandbox/tests/escalation.spec.ts` 钉住 `INVALID_ARGS` 参数配对、`SANDBOX_ESCALATION_*` 结果映射，以及冗余非加宽请求（有效模式、无审批、无错误——即使没有审批服务和 agent）。`packages/interaction/user-approval/tests/approval.spec.ts` 钉住 `'never'` 策略把每次询问解析为 `'blocked'`。`packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts` 钉住 advisory 提醒与第 2 次尝试的失败感知层。`packages/fs/tool-fs-search/tests/tools.spec.ts` 与集成套件钉住 `globExcludeNodeModules` 开关、描述适配与部分结果警告。`packages/goal/tool-goal/tests/tool-goal.spec.ts` 钉住整数 revision（小数 → 在任何权限检查之前 `INVALID_ARGS`，整数值接受）、omit 风格错误文本与空填充值接受。
