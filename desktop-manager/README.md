# DSH 管理器

用于在同一台电脑上运行多个 DeepSeek Harness 版本的 Electron 桌面管理器。每个实例可以选择独立的运行时、工作区和 DSH_HOME 环境。

## 开发

需要 Node.js 22.19 或更高版本，以及 pnpm 11。

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

`pnpm test:electron` 使用临时 Application Support 目录，注册当前 `dsh-v1`，启动真实独立实例，验证自动端口、嵌入式 Web GUI、重启换端口、单实例锁和两种窗口尺寸。测试截图写入已忽略的 `.artifacts/`。

`pnpm package` 在 `dist/mac-arm64/DSH 管理器.app` 生成可直接运行的 macOS 应用目录，不生成 DMG。MVP 产物尚未签名，当前使用 Electron 默认应用图标。

## 当前 MVP

- 注册本地 DSH 源码目录或已发布的 `@deepseek-ai/dsh` 包，并执行预检。
- 创建独立、生产和克隆 DSH_HOME 环境。
- 运行中的来源实例先优雅停止，完成 APFS copy-on-write 或普通复制后立即重新启动；克隆后删除旧运行时的 Profile 依赖链接。
- 创建、启动、停止、强制停止和重新启动实例；每个实例独立选择运行时、工作区、环境和端口模式。
- 自动端口每次通过 DSH `--port 0` 原子分配；管理器解析 readiness URL、保存日志，并在隔离的 `WebContentsView` 中打开 GUI。
- 停止以整个 detached 进程组消失为完成条件；状态采用文件与目录 `fsync`、原子替换和上一版本备份。管理器异常退出后的活动实例先进入隔离，确认旧进程与端口释放后才能恢复。
- 嵌入的 DSH 页面无法访问管理器 IPC；跨 origin 导航、弹窗、下载和权限请求均被拒绝。
- 界面沿用 DSH Web 的中文侧栏工作台、系统中文字体、近黑主操作与 DeepSeek 蓝业务强调。

产品行为和后续发布阶段见 `DESKTOP_MANAGER_DESIGN.zh.md`。
