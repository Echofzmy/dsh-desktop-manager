# Agent Note: Workspace 浏览客户端——对象层与侧边栏文件树

Status: implemented

[English](2026-08-26-workspace-browse-client.md) | 中文

## Problem

以 workspace 为根的文件浏览器已在线路后端真实落地（[workspace-browse-backend](2026-08-26-workspace-browse-backend.zh.md)），但客户端仍没有消费入口：`IWorkspaces` 与 `WorkspaceRuntime` 只暴露宿主级选择器（`listDirectory`／`createDirectory`），特性包无法列出某个 Workspace 自己目录的一个层级——而浏览器契约正是以文件／目录行、workspace 根相对路径和无逃逸包含性与选择器区分开来的——侧边栏也没有查看某个 Workspace 目录的应用内入口。

## Decision

`IWorkspaces.browse(workspaceId, relativePath?, signal?)` 是新的对外方法，返回 `WorkspaceDirectoryListing`。`WorkspaceRuntime.browse` 原样转发载荷与信号：缺省的 `relativePath` 从载荷中省略（绝不发送为 `undefined`——沿袭 `listDirectory` 的先例），调用方的 `AbortSignal` 原样到达 `api.workspace.browse`，使宿主的扫描随调用方一起停止；所有业务失败（`workspace-not-found`、`directory-unreadable`、`cancelled`）都映射为现有的 `DirectoryBrowseError`——浏览能力动作已经在抛的结构化错误。线路类型（`WorkspaceDirectoryListing`、`WorkspaceFileEntry`）经由 connection 的 `/client` 契约、`dsh-api-remotes/client` 与 runtime 客户端 index，与选择器类型并列导出。

侧边栏的文件模式（ui-workspace）消费该对外方法。`WorkspaceBrowserInjected.browse`／`openFile` 包装 `ctx.workspaces.browse`／`openPath`；区域顶部的会话／文件开关取代了原先的区头标签，并把模式持久化到查看 store（`dsh.workspace.view.v6`）。文件树把目标 Workspace 解析为包含当前 Session 的那个，否则为最近活跃 Workspace 投影，再否则为注册顺序中的第一个 Workspace（一个都没有时显示空状态）。树是懒加载的：选中文件模式时加载根目录，目录只在首次展开时加载并把该层级缓存起来（收起再展开不会重新拉取），**刷新**清空缓存并重载根目录；每次扫描都挂在一个可中止的 controller 上，组件在切换 Workspace 或卸载时取消它。行保持服务端返回的目录优先顺序；隐藏条目默认隐藏，**显示隐藏文件**开关可揭示；点击文件把该行的绝对路径交给 `host.openPath`，加载中、空目录、条目过多、浏览失败与打开失败等状态都内联渲染。折叠轨道新增一枚文件图标，展开侧边栏并进入文件模式；搜索与添加控件则保持为会话模式入口，执行前先把区域切回会话模式。

测试面保持同一方法签名：`TestWorkspaces.browse` 记录调用（含 signal），默认提供根层一条目录行加一条文件行的确定性列表，让特性测试能同时看到两种行；`stub('browse', …)` 与其他所有方法一样可替换默认行为。connection fixture 的 `workspace.browse` 现在返回两种行：文件行来自 fixture 的 `fileTree`（选择器的 `DirectoryEntry` 没有 kind，因此 `host.listDirectory` 继续从 `directoryTree` 只提供目录），目录行来自共享树，按目录在前、文件在后、各组内按名称排序合并——与宿主后端完全一致，`relativePath` 原样回显，点前缀名称标记为 `hidden`。

## Alternatives considered

**重命名或泛化 `DirectoryBrowseError`。** 它已经命名了 `listDirectory`、`createDirectory` 以及现在的 `browse` 共享的目录浏览域；重命名只会搅动消费者而不会改善契约，因此保留该类作为唯一的结构化失败载体。

**让 `TestWorkspaces.browse` 默认返回空列表。** 与 `listDirectory` 的默认同样惰性，但 workspace 浏览器特性测试必须先 stub 才能渲染一行；各提供一行的默认既演示了协议，又不需要虚构一棵树。

**文件模式一次加载整棵树。** workspace 根契约按层级限定（每次请求一个 `relativePath`），整棵树需要无界的请求链；按层级的懒缓存与该契约一致，并把收起再展开与刷新的行为限定在树组件内部。

## Consequences

特性包可以通过 `ctx.workspaces.browse` 驱动以 workspace 为根的浏览器，错误词汇与选择器一致；侧边栏的文件模式让每个 Workspace 都有应用内文件树，并可通过 `host.openPath` 打开行。fixture 区分选择器目录与浏览文件，因此组装式 Web 测试无需 Host 即可演练文件／目录拆分与目录优先的顺序。runtime 测试钉住载荷省略、signal 转发与错误映射；fixture 测试钉住行种类与排序；组件测试钉住懒缓存生命周期、隐藏过滤与内联失败状态。
