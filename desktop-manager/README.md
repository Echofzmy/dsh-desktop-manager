# DSH 管理器

用于在同一台电脑上管理多个 DeepSeek Harness 运行版本、实例、DSH_HOME 和共享模型服务的 Electron 桌面应用。界面使用中文 DSH 工作台结构；实例可以并行运行，并保持运行时、环境和端口相互独立。新实例使用管理器内部启动目录和自动端口，真正的项目工作区在 DSH 新建会话时选择。模型与 API Key 在管理器的“模型”页面通过 DSH 原生界面配置一次。

## 开发

源码开发需要 Node.js 22.19 或更高版本及 pnpm 11：

```bash
pnpm install
pnpm dev
```

验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:electron
```

`pnpm test:electron` 使用带随机 UUID sentinel 的临时 Application Support；只有规范化路径是系统临时目录下的单层 `dsh-manager-electron-*` 目录时，测试才会在 Electron 启动前创建一次性模型与 credential fixture。启动后只调用 DSH 的只读 `settings.describe`、`credentials.describe` 和 `llm.models` 等 API，不调用 `credentials.set/unset` 或 settings mutation API。测试验证内置官方运行时、本地源码运行时、原生 Models 页面、自定义 OpenAI-compatible provider、共享 Key 的目标解析、DeepSeek 有效默认、目标模型目录、API Key onboarding 抑制、owner-only credential overlay、自动端口重选、运行中环境克隆、嵌入式 Web GUI、菜单切换停止内部 Host、单实例锁、原生视图弹窗隔离和两种窗口尺寸。截图写入已忽略的 `.artifacts/`，不会停止、接管或修改现有 `127.0.0.1:3080` 服务及其凭据。

## 发布

```bash
pnpm package:dir
pnpm package
```

`prepare:bundled-runtime` 根据 `package.json` 中固定的 `dshBundledVersion` 安装完整官方 npm 依赖闭包，生成 package-lock、安装收据、SHA-256 文件清单和 READY 标记。生成目录位于已忽略的 `build/bundled-runtime/`，打包时复制到应用 Resources。

`package:dir` 生成可直接运行的 `dist/mac-arm64/DSH 管理器.app`。`package` 另外生成 DMG、ZIP 与 blockmap，并在返回成功前对最终 `.app` 再运行一次完整 Electron workflow smoke。应用使用 DSH 图标；macOS 签名和公证需要本机提供有效的 Apple Developer ID，仓库不包含或读取签名凭据。

## 产品能力

- 内置一份完整官方 DSH 作为离线兜底；检查固定 npm registry 的官方版本，校验精确包名、版本、根包 `sha512` integrity 与 package-lock 依赖闭包后原子安装。
- 官方运行时通过 Electron 自带 Node 启动，不依赖系统 Node。pnpm workspace 本地源码使用其声明的系统 Node 与 pnpm，保持 workspace symlink 解析语义。
- 注册本地 DSH 源码，显示 Git commit 与工作树状态；可执行受限的依赖安装、类型检查、测试和构建任务，持久化任务日志，失败或中断时保持启动门禁。
- 从任意本地 Git runtime 创建管理器受管 worktree，自动注册并要求完成安装和构建；不预设任何候选版本目录名称。
- 设置默认运行时；创建独立、生产和克隆 DSH_HOME。运行中的克隆来源会先停止，复制完成后立即恢复。
- 在侧栏“模型”中使用经过完整性验证的官方运行时启动管理器专属 DSH Web Host，复用 DSH 原生提供方目录、自定义 provider、Base URL、协议、模型发现、凭据与默认模型界面，不在管理器中维护另一套 provider 表单。共享配置只投影 `llm-deepseek`、`llm-pi-ai` 和 `agent-default-model`；共享源没有显式默认时清除实例旧默认并回到 DSH 内置 DeepSeek 默认。主题、权限、会话及其他环境设置继续隔离；运行中的实例在重启后应用 provider 与默认模型变更。
- 创建、启动、停止、强制停止、重启和删除实例。新建实例只选择名称、运行时和环境；管理器为进程创建独立的内部启动目录，项目工作区由用户在 DSH 新建会话时选择。删除隔离环境需要明确选择；生产 DSH_HOME 永不由管理器删除。
- 每次启动均通过 DSH `--port 0` 自动分配端口。管理器解析 readiness URL、执行 HTTP 确认、持久化日志，并在隔离的 `WebContentsView` 中打开 GUI。
- 停止以整个 detached 进程组消失为完成条件。管理器异常退出后的活动实例、任务和长操作进入恢复隔离，不会直接复用旧 PID 或端口。
- 创建带 SHA-256 清单的完整环境备份；生产提升要求健康候选、真实对话确认、完整可执行依赖闭包指纹和干净 commit，先备份再切换。本地候选会复制到管理器私有、不可构建的 immutable production snapshot，生产进程不再从可变 checkout 启动。生产确认后仍保留显式回退点，直到用户主动放弃；回退会同时恢复运行版本和完整 DSH_HOME，并保留故障后诊断目录。内置 DSH 随应用升级而无法保留旧二进制时，旧回退点会明确标记为不可用，绝不静默改写成新版本。
- 管理目录/工作树删除和 DSH_HOME restore 使用持久化阶段 journal，并对状态文件 `.bak` 恢复场景做启动对账：崩溃后只会恢复原对象或幂等完成已提交删除，不会留下状态指向缺失目录。
- 保存实例模板并快速创建新实例；非生产模板默认创建新的隔离环境，避免模板实例共享可写 DSH_HOME。
- 设置默认嵌入或外部浏览器打开方式、启动更新检查；提供中文原生应用菜单和快捷键。
- 管理器渲染进程使用窄 IPC。嵌入的 DSH 页面无法访问管理器 IPC，跨 origin 导航、弹窗、下载和权限请求均被拒绝。

## 持久化与安全

状态格式为 version 3，包含设置、运行时、环境、实例、任务、备份、提升记录、模板和长操作阶段。每次更新经过完整字段与引用校验，再使用临时文件、文件及目录 `fsync`、上一版本备份和原子替换提交；损坏 primary 只从严格有效 backup 恢复，未来版本拒绝降级读取。

官方安装器固定 `https://registry.npmjs.org`，renderer 不能提交 registry、tarball、可执行文件或目标路径。安装使用临时 HOME、独立 cache 和空 userconfig，不继承 API key、token、凭据或 Node 注入环境，并使用 `--ignore-scripts` 禁止未验证 npm lifecycle 代码；完整 lockfile 闭包必须来自固定 registry 且具备 sha512 integrity。完成包身份、CLI、真实 Web readiness/HTTP 探针和文件清单后才写 READY 并发布目录。应用在发现、复用和每次启动官方 runtime 前都会重新核对 receipt、READY、清单摘要与实际文件。

共享 API Key 由模型配置 Host 通过 DSH 原生 `credentials.set` 写入 `<应用数据目录>/model-configuration/home/.credentials.yaml`；目录为 owner-only，文件由 DSH 以 `0600`、跨进程锁和原子替换维护。管理器 state、renderer snapshot、IPC 响应和日志均不保存或返回 Key。实例通过管理器生成的固定 `--patch` overlay 让自己的 `credentials-local` provider 引用该文件，并从同一次 provider settings 投影快照提取、删除实际 `apiKeyEnv` 继承变量；无关的工具 Token 保持可用。模型定义和默认模型在实例停止状态下使用 DSH 兼容 writer lock 结构化合并进各自 `settings.yaml`，其他 namespace 保持不变。

所有由同一用户启动的受管 DSH runtime 属于同一本机信任域：业务实例可通过 DSH 原生 credential API 更新共享 Key，同一 UID 下的恶意 runtime 也能主动读取用户文件。`WebContentsView` partition、窄 IPC 和脱敏 API 防止页面意外越权或明文回传，但不是针对恶意本机 runtime 的密钥隔离；只应注册和启动可信代码。

详细事务、数据和信任模型见 `DESKTOP_MANAGER_DESIGN.zh.md`。
