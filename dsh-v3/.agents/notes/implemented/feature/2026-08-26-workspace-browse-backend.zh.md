# Agent Note: Workspace 浏览后端

Status: implemented

[English](2026-08-26-workspace-browse-backend.md) | 中文

## Problem

`workspace.browse` 以管道占位的形式到达线路层：schema、客户端行结构与 README 契约描述的是一份真实的一级 workspace 文件浏览器列表，但宿主对每次调用都以 `internal`（"not implemented"）应答。后端必须按照契约已经承诺的包含性、扫描、排序与界内截断策略落地，而且该界必须是部署可调项，不能是埋在实现里的常量。

## Decision

后端由 `api-proxy.ts` 中的一组模块级 helper 加一个 RPC 方法组成。运行时路径校验在线路边界执行，且独立于 zod schema，因此直接调用方或替代调用方都无法绕过：`relativePath` 必须是 POSIX 风格的 workspace 根相对路径——绝对 POSIX 路径（`/` 前缀）、绝对 Windows 路径（`X:` 盘符前缀）、UNC 路径（`\` 前缀）、NUL 以及 `.`／`..`／空段全部被拒绝；而 `''` 与缺省路径都表示 workspace 根目录，并回显为响应的 `relativePath: ''`。

目标路径用 `fs.realpath` 规范化，并被强制保持在规范化的 workspace 根目录之内；根目录本身每次调用也会重新 realpath，因此包含性比较是规范对规范的：符号链接父级（或被符号链接替换的 workspace 根目录）无法把列表偷运到 workspace 之外；未解析为目录的目标会被拒绝。扫描只针对一个直属层级，使用 `opendir` 读取循环；符号链接条目与特殊节点类型（FIFO、socket、设备）绝不成为行。行按目录在前、文件在后排列，各自按名称排序，点前缀名称标记为 `hidden`，每行都携带 workspace 根相对 `relativePath`（客户端原样回传）与绝对宿主路径。

文件＋目录组合行上限是 `ApiProxyService` 配置项 `workspaceBrowseMaxEntries`（schemastery `z.natural()`，默认 1000，即导出的 `DEFAULT_WORKSPACE_BROWSE_MAX_ENTRIES` 常量），并通过 `ApiProxyDefaults.workspaceBrowseMaxEntries` 流入 `createApiProxy`。扫描仍会读取每一个 dirent——`truncated` 必须真实，总数只有到末尾才知道——但行通过每种类型的按名称排序的有界插入来持有，因此无论目录多大，内存都保持在界的两倍以内。

载体的请求信号会停止扫描：每次 await 与每次循环迭代都通过 `throwIfAborted` 检查，已中止的调用在触碰注册表或文件系统之前就应答 `cancelled`。错误映射：未知 workspace 应答 `workspace-not-found`；其余所有失败——路径语法无效、越出包含性、缺失、不可读或非目录目标——都应答 `directory-unreadable`，`details.path` 携带尝试访问的绝对路径。

## Alternatives considered

**收集全部 dirent 行后排序再切片。** 更简单，但内存随目录规模增长；单个超大目录会持有无界列表。有界插入在保持相同真实结果（保留前缀永远等于完整名称排序前缀）的前提下，以有界内存和单次遍历完成。

**两遍扫描：先计数，再只读所需前缀。** 真实的 `truncated` 标志本就要求完整遍历，第二遍没有任何收益；单遍加每类型有界插入让每个 dirent 恰好被读一次。

**对拼接后的路径做词法包含性检查而不 realpath。** 符号链接父级或被替换的 workspace 根目录会绕过它；只有规范对规范的比较才能同时抵御两者。

**把 `''` 当作空段拒绝。** 响应契约已用 `''` 作为根标记，客户端原样回传请求路径，而缺省路径是常见情形；接受 `''` 作为根目录让往返保持一致。

**仅用 zod schema 强制路径规则。** schema 只约束 fetch 载体，约束不了 `ctx.apiProxy` 的直接调用方；包含性规则根本无法放进 schema，因此由运行时强制统一承担。

## Consequences

网关配置面新增一个带文档默认值的自然数键；拥有超大 workspace 目录的部署可以从 cordis.yml 调高上限，列表也绝不会迫使宿主持有或发送超过上限的行。符号链接子项对浏览器刻意不可见，因此任何 UI 行都无法通过链接导航到 workspace 之外；本身是符号链接的 `relativePath` 只要规范目标仍在界内，就仍会被跟随。由于根目录每次调用都会重新 realpath，目录被删除或被替换的 workspace 会读作 `directory-unreadable`，而不是提供过期的行。
