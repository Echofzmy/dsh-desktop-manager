# @deepseek-ai/dsh-repeat-tool-reminder

[English](README.md) | 中文

这是一个仅提供建议的循环中断器，而非面向模型的工具：它不会出现在工具列表中，不会否决或改写调用，只增加一种行为。它监视每个 agent（智能体）的工具调用流，统计以完全相同的规范化参数连续调用同一工具的次数；达到所配置的连续次数时，它会注入逐级增强的提示，要求模型停止重复、重新阅读上一次结果，并改用其他方案或结束任务。究竟是换一种方式重试、收集更多证据还是完成任务，仍完全由模型决定：合理的重复调用既不会延迟，也不会受阻。决策记录见 [repeat-tool-reminder Agent Note](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md)。

## 配置

```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # default; consecutive counts that trigger a reminder
    failureRetryThreshold: 2     # default; retry-after-failed-result reminder count
    include: []                  # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]        # tool-name patterns transparent to the chain
    argumentsPreviewChars: 500   # default; cap on arguments quoted in the detailed reminder
```

插件加载时，`thresholds` 会对错误配置快速失败：空列表、非整数、小于 2 的值或重复值都会抛出错误，绝不静默回退到默认值；`argumentsPreviewChars` 同样只接受大于等于 1 的整数。系统会将列表按升序规范化；第一个阈值只发送简短的通用提醒，后续每个阈值都会发送详细版本，列出工具、连续次数和规范参数。参数内容截取前 `argumentsPreviewChars` 个字符，并附带省略字符数标记，避免循环中的 `write`／`edit` 载荷无限制进入下一次请求（链键始终比较完整的规范字符串；此上限只约束提醒，不影响检测）。

`failureRetryThreshold`（默认 `2`，必须是大于等于 2 的整数）是一个独立的、感知失败的档位：当同一链键的**上一次**结果是规范的工具结果失败（`isError`），或该调用被下游 `tools/post-execute` 监听器阻止（block）时，达到此次数的一次重试会直接收到纠正性提醒，而不再等待 `thresholds`——这样反复重试失败调用的模型能提前一步听到提醒。成功路径不受影响：上一次结果正常时此档位绝不触发，普通重复仍完全遵循 `thresholds`。只有小于 `thresholds[0]` 的值才比通用第一档更早；次数相同时失败提醒优先。

`include`／`exclude` 条目支持 `*` 通配符，并针对调用时实际存在的工具执行谓词判断，而不是引用注册表条目。因此，与当前任何已注册工具都不匹配的模式并非错误（未加载 MCP 工具的部署中，`exclude: [mcp_*]` 仍然有效）；这与 `toolOrder` 的引用目标检查不同。

## 链语义

链键为「`(tool name, canonical arguments)`」：规范化过程会对键进行深度排序，然后执行 `JSON.stringify`，因此仅属性顺序不同的参数对象会视为相同。若某次调用与上一条受跟踪调用相同，该 agent 的连续计数器递增；换成另一条受跟踪调用则重置为 1。

- **不受跟踪的调用对链透明。** 被 `include`／`exclude` 排除的调用既不递增计数器，也不重置计数器；因此，`grep X → todo_write → grep X` 仍算作连续两次 `grep X`，即使 `todo_write` 已被排除。这正是排除机制的价值：循环中穿插的记录类工具不能掩盖循环。
- **被拒绝的调用也计数。** 检测位于 `tools/post-execute`；即便调用被 `tools/pre-execute` 监听器拒绝，该事件也会运行。模型反复尝试被拒绝的调用，恰恰是需要打断的循环。被拒绝的调用同样会被记为失败，参与 `failureRetryThreshold` 档位，因为其规范结果就是 `isError` 结果。
- **失败信号是规范的工具结果 `isError`，外加下游 block。** 非零退出的 bash 命令以 `isError: false` 结算（退出状态是结果数据，符合 harness 的终端卡片语义），因此既不会触发也不会刷新失败档位——只有失败或受阻的**结果**才会。该关联以精确的 `(tool, canonical arguments)` 连续段为作用域：换成其他受跟踪调用即清除。
- **忽略没有 agent 的调用。** 直接调用 `ctx.tools.execute()` 的调用方没有需要提醒的模型，也没有可作为键的活跃 agent 对象。
- **按 agent 分键。** 工具注册表位于上下文层级，subagent 会交错通过同一个 waterfall（瀑布式事件），因此每条链使用 `WeakMap<Agent, Chain>`，以活跃 agent 对象为键。一个 agent 的重复调用绝不会触发另一个 agent 的提醒。用户提示词（`agent/pre-step`）会重置提交该提示词的 agent 链；对象生命周期会自然限制弱引用条目的寿命，无需 dispose（资源释放）监听器。
- **仅驻留内存。** 从持久化恢复的会话会从一条全新的链开始：guard 是启发式提醒，并非有日志记录的不变量；提醒会延后，这是可接受的代价。

## 提醒传递

提醒通过 post-execute 决策中的 `additionalContexts`（来源为 `{kind: 'plugin', plugin: 'repeat-tool-reminder'}`）传递，绝不替换 `content`；用于审计的 `tool/result` 事件仍保留工具自己的输出。循环会缓冲这段上下文，并在该步骤的工具结果之后将其作为注入的 `user/message` 追加；会话会将它渲染为普通的合成用户消息。因此，提醒对模型可见、带有来源归属，并且无需增加会话事件即可从会话日志重建。guard 始终通过 `next()` 委派，并将自己的提醒放在下游决策的上下文数组之前（两种结果都适用：被阻止的调用也会收到提醒）；每个条目保留自己的来源和元数据。

## 模型体验

### 首个阈值的上下文消息

#### 模型看到的内容

达到第一个配置的连续重复阈值时，对应 agent 会收到以下提醒。系统不会添加工具 schema 或正常调用文本。

##### 首个阈值提醒

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token 影响

达到阈值前为零 token。提醒会作为该 agent 的历史记录保留。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后续阈值的上下文消息

#### 模型看到的内容

达到后续阈值时，agent 会收到以下详细提醒模板。受上限约束的参数预览严格以 `… (+<omitted> more chars)` 结尾。

##### 后续阈值提醒

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token 影响

每条提醒都会作为历史记录保留；`argumentsPreviewChars` 会限制随数据变化的参数文本长度，而各 agent 仍使用独立计数器。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 失败重试的上下文消息

#### 模型看到的内容

当一次调用在 `failureRetryThreshold` 次数上重复了上一次结果失败（`isError`）或受阻（block）的链键时，该 agent 会收到下面的纠正性提醒，而不是通用档位（次数相同时失败提醒优先）。`previous_error_code` 行仅在上一结果携带结构化错误码（`ToolFailure.info.code`）时出现；guard 从不解析上一结果的自由文本消息。

##### 失败重试提醒

```markdown
Previous attempt with these exact arguments failed:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
- previous_error_code: <code>   (only when the previous result carried a structured code)
Retrying the identical call is unlikely to progress the task. Inspect the failed result, change the arguments or approach, or conclude the task instead of repeating the call unchanged.
```

#### Token 影响

每条失败提醒都会作为历史记录保留，并像详细版一样受 `argumentsPreviewChars` 约束；各 agent 仍使用独立计数器。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **仅检测精确匹配**：规范化过程会对键进行深度排序，因此近似变体（稍作修改的路径、值内增加的空白）可以绕过链；在没有需求证据前，不采用模糊匹配。
- **压缩（compaction）不会重置链**：跨越压缩检查点的链会继续计数。
- **仅提供建议**：尚未实现达到较高阈值后升级为 `block`，但 `PostToolDecision` 已支持阻止调用。
- **subagent 之间不共享链**：链始终按 agent 隔离；即使父 agent 与其 subagent 重复相同调用，也不会合并计数。
- **合理的幂等轮询超过阈值后仍会收到提醒**：可通过 `thresholds`／`exclude` 配置释放压力。
- **超过最高阈值后链不再提醒**：提醒只在精确达到所配置的次数时触发，超过后不会继续发送。
