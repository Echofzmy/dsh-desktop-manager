import {
  Activity,
  Archive,
  ArchiveRestore,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  Globe2,
  LayoutDashboard,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import appIcon from '../../../build/icon-source/dsh-1024.png'
import type { EnvironmentRecord, InstanceRecord, ManagerSnapshot, OfficialUpdateInfo, RuntimeRecord, RuntimeTaskKind, SaveUnifiedConfigurationInput, UnifiedConfiguration, UnifiedModelProfile, UnifiedProviderProfile } from '../../shared/types'

const EMPTY: ManagerSnapshot = {
  settings: { openMode: 'embedded', checkUpdatesOnStartup: true },
  runtimes: [], environments: [], instances: [], tasks: [], backups: [], promotions: [], operations: [], templates: [],
}
type Page = { kind: 'home' } | { kind: 'runtimes' } | { kind: 'models' } | { kind: 'settings' } | { kind: 'instance'; id: string }
type Modal = 'runtime' | 'worktree' | 'environment' | 'instance' | 'promotion' | null
interface Confirmation { title: string; detail: string; actionLabel: string; action: () => Promise<unknown> }
interface LogState { name: string; path: string; content: string; truncated: boolean }

const STATUS_LABEL: Record<InstanceRecord['status'], string> = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', failed: '失败' }
const TASK_LABEL: Record<RuntimeTaskKind, string> = { install: '安装依赖', typecheck: '类型检查', test: '运行测试', build: '完整构建' }
const CHECK_LABEL: Record<string, string> = { directory: '运行时目录', manifest: 'DSH 清单', node: '内置 Node.js', pnpm: 'pnpm', dependencies: '依赖', build: '启动程序', 'web-build': 'Web 界面', git: 'Git 版本' }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function shortPath(path: string): string { const home = path.match(/^\/Users\/[^/]+/u)?.[0]; return home ? path.replace(home, '~') : path }
function instanceStatusLabel(instance: InstanceRecord): string { return instance.interrupted || instance.portModeReviewRequired ? '需要确认' : STATUS_LABEL[instance.status] }
function StatusDot({ status }: { status: InstanceRecord['status'] }): ReactNode { return <span className={`status-dot status-${status}`} aria-label={STATUS_LABEL[status]} /> }

function IconButton({ label, children, onClick, disabled = false, danger = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }): ReactNode {
  return <button className={`icon-button${danger ? ' danger-icon' : ''}`} type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>
}
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }): ReactNode {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>{children}</section></div>
}
function DirectoryField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  const choose = async (): Promise<void> => { const selected = await window.manager.chooseDirectory(); if (selected) onChange(selected) }
  return <label className="field"><span>{label}</span><span className="field-with-action"><input value={value} onChange={event => onChange(event.target.value)} required /><IconButton label={`选择${label}`} onClick={() => void choose()}><FolderOpen size={17} /></IconButton></span></label>
}

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState(EMPTY)
  const [page, setPage] = useState<Page>({ kind: 'home' })
  const [modal, setModal] = useState<Modal>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [templateSource, setTemplateSource] = useState<string | null>(null)
  const [templateUse, setTemplateUse] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogState | null>(null)
  const configurationDirty = useRef(false)
  const currentPage = useRef<Page>(page)

  const commitNavigation = (next: Page): void => { configurationDirty.current = false; currentPage.current = next; void window.manager.hideInstanceView(); setPage(next) }
  const navigate = (next: Page): void => {
    if (currentPage.current.kind === 'models' && next.kind !== 'models' && configurationDirty.current) {
      setConfirmation({ title: '放弃未保存的更改？', detail: '统一配置中的修改和尚未保存的 API Key 将被丢弃。', actionLabel: '放弃更改', action: async () => commitNavigation(next) })
      return
    }
    commitNavigation(next)
  }
  useEffect(() => { void window.manager.getSnapshot().then(setSnapshot).catch(reason => setError(errorText(reason))); return window.manager.onSnapshotChanged(setSnapshot) }, [])
  useEffect(() => window.manager.onMenuCommand(command => {
    if (command === 'new-instance') setModal('instance')
    else navigate({ kind: command })
  }), [])
  const selectedInstance = page.kind === 'instance' ? snapshot.instances.find(instance => instance.id === page.id) : undefined
  const obscured = modal !== null || confirmation !== null || templateSource !== null || templateUse !== null
  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError(null)
    try { await action(); setSnapshot(await window.manager.getSnapshot()) } catch (reason) { setError(errorText(reason)) } finally { setBusy(null) }
  }
  const confirm = (value: Confirmation): void => setConfirmation(value)
  const showInstanceLog = async (instance: InstanceRecord): Promise<void> => {
    await run(`log:${instance.id}`, async () => { const result = await window.manager.readInstanceLog(instance.id); setLog({ name: instance.name, ...result }) })
  }
  const showTaskLog = async (taskId: string, name: string): Promise<void> => {
    await run(`task-log:${taskId}`, async () => { const result = await window.manager.readRuntimeTaskLog(taskId); setLog({ name, ...result }) })
  }

  return <div className={`app-shell ${log ? 'with-details' : ''}`}>
    <aside className="sidebar">
      <div className="drag-region" />
      <div className="brand-row"><img className="brand-icon" src={appIcon} alt="" aria-hidden="true" /><span><strong>DeepSeek</strong><small>DSH 管理器</small></span></div>
      <button className="new-instance" onClick={() => setModal('instance')} disabled={!snapshot.runtimes.length || !snapshot.environments.length}><Plus size={17} />新建实例</button>
      <nav className="sidebar-nav" aria-label="主导航">
        <button className={page.kind === 'home' ? 'active' : ''} onClick={() => navigate({ kind: 'home' })}><LayoutDashboard size={17} />概览</button>
        <button className={page.kind === 'runtimes' ? 'active' : ''} onClick={() => navigate({ kind: 'runtimes' })}><Boxes size={17} />运行时</button>
        <button className={page.kind === 'models' ? 'active' : ''} onClick={() => navigate({ kind: 'models' })}><SlidersHorizontal size={17} />统一配置</button>
      </nav>
      <div className="sidebar-section"><div className="sidebar-section-title"><span>实例</span><span>{snapshot.instances.length}</span></div><div className="sidebar-instances">
        {!snapshot.instances.length && <p>暂无实例</p>}
        {snapshot.instances.map(instance => <button key={instance.id} className={page.kind === 'instance' && page.id === instance.id ? 'active' : ''} onClick={() => navigate({ kind: 'instance', id: instance.id })}><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{instanceStatusLabel(instance)}</small></span></button>)}
      </div></div>
      <button className={`sidebar-settings${page.kind === 'settings' ? ' active' : ''}`} onClick={() => navigate({ kind: 'settings' })}><SettingsIcon size={17} /><span>设置</span></button>
    </aside>

    <section className="workspace-shell">
      {error && <div className="error-banner"><span>{error}</span><IconButton label="关闭提示" onClick={() => setError(null)}><X size={16} /></IconButton></div>}
      <main className="main-content">
        {page.kind === 'home' && <HomePage snapshot={snapshot} busy={busy} onModal={setModal} onOpen={id => navigate({ kind: 'instance', id })} onRun={run} onLog={showInstanceLog} onConfirm={confirm} onUseTemplate={setTemplateUse} />}
        {page.kind === 'runtimes' && <RuntimesPage snapshot={snapshot} busy={busy} onModal={setModal} onRun={run} onLog={showTaskLog} onConfirm={confirm} onError={setError} />}
        {page.kind === 'models' && <ModelsPage runningCount={snapshot.instances.filter(instance => instance.status === 'running').length} onDirtyChange={value => { configurationDirty.current = value }} onError={setError} />}
        {page.kind === 'settings' && <SettingsPage snapshot={snapshot} busy={busy} onModal={setModal} onRun={run} onConfirm={confirm} />}
        {page.kind === 'instance' && selectedInstance && <InstancePage instance={selectedInstance} snapshot={snapshot} busy={busy} obscured={obscured} onRun={run} onLog={showInstanceLog} onError={setError} onDelete={() => confirm({ title: '删除实例', detail: `删除“${selectedInstance.name}”的元数据和日志。生产环境数据不会被删除。`, actionLabel: '删除实例', action: async () => { await window.manager.deleteInstance(selectedInstance.id, false); navigate({ kind: 'home' }) } })} onSaveTemplate={() => setTemplateSource(selectedInstance.id)} />}
      </main>
    </section>

    {modal === 'runtime' && <RuntimeDialog onClose={() => setModal(null)} onCreated={() => run('runtime:create', async () => setModal(null))} setError={setError} />}
    {modal === 'worktree' && <WorktreeDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {modal === 'environment' && <EnvironmentDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {modal === 'instance' && <InstanceDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {modal === 'promotion' && <PromotionDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {templateSource && <TemplateNameDialog title="保存实例模板" initialName={`${snapshot.instances.find(instance => instance.id === templateSource)?.name ?? '实例'} 模板`} submitLabel="保存模板" onClose={() => setTemplateSource(null)} onSubmit={name => window.manager.saveInstanceTemplate(templateSource, name)} onDone={() => setTemplateSource(null)} setError={setError} />}
    {templateUse && <TemplateNameDialog title="从模板新建实例" initialName={snapshot.templates.find(template => template.id === templateUse)?.name ?? '新实例'} submitLabel="创建实例" onClose={() => setTemplateUse(null)} onSubmit={name => window.manager.createInstanceFromTemplate(templateUse, name)} onDone={() => setTemplateUse(null)} setError={setError} />}
    {confirmation && <Dialog title={confirmation.title} onClose={() => setConfirmation(null)}><div className="confirm-content"><p>{confirmation.detail}</p><footer><button className="button outline" onClick={() => setConfirmation(null)}>取消</button><button className="button danger" disabled={busy !== null} onClick={() => void run('confirm', async () => { await confirmation.action(); setConfirmation(null) })}>{confirmation.actionLabel}</button></footer></div></Dialog>}
    {log && <LogPanel log={log} onClose={() => setLog(null)} />}
  </div>
}

type UnifiedSection = 'general' | 'models'
type UnifiedModelPatch = { id?: string; name?: string | undefined; contextWindow?: number | undefined; maxTokens?: number | undefined }

function timeoutMinutes(value: number | null | undefined): string { return typeof value === 'number' ? String(value / 60_000) : '' }
function timeoutMilliseconds(value: string): number | undefined {
  if (!value.trim()) return undefined
  return Math.round(Number(value) * 60_000)
}

function configurationDraftError(value: UnifiedConfiguration): string | undefined {
  const ids = new Set<string>()
  for (const provider of value.providers) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(provider.id)) return '提供方 ID 只能使用小写字母、数字和连字符。'
    if (ids.has(provider.id)) return `提供方 ID 已存在：${provider.id}`
    ids.add(provider.id)
    if (provider.displayName.trim().length > 100) return `提供方 ${provider.id} 的显示名称过长。`
    if (provider.kind !== 'catalog' && !provider.baseURL?.trim()) return `提供方 ${provider.displayName.trim() || provider.id} 需要 Base URL。`
    if (provider.kind === 'custom' && provider.models.length === 0) return `提供方 ${provider.displayName.trim() || provider.id} 至少需要一个模型。`
    const modelIds = new Set<string>()
    for (const model of provider.models) {
      if (!model.id.trim()) return `提供方 ${provider.displayName.trim() || provider.id} 存在空模型 ID。`
      if (modelIds.has(model.id.trim())) return `模型 ID 重复：${model.id.trim()}`
      modelIds.add(model.id.trim())
    }
  }
  return undefined
}

function configurationInput(value: UnifiedConfiguration): SaveUnifiedConfigurationInput {
  return {
    ...value,
    providers: value.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
  }
}

function ModelsPage({ runningCount, onDirtyChange, onError }: { runningCount: number; onDirtyChange: (value: boolean) => void; onError: (message: string) => void }): ReactNode {
  const [section, setSection] = useState<UnifiedSection>('general')
  const [configuration, setConfiguration] = useState<UnifiedConfiguration | null>(null)
  const [draft, setDraft] = useState<UnifiedConfiguration | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [clearingKey, setClearingKey] = useState<UnifiedProviderProfile | null>(null)
  const [creatingProviderId, setCreatingProviderId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<UnifiedProviderProfile | null>(null)
  const [riskOpen, setRiskOpen] = useState(false)
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<{ providerId: string; candidates: UnifiedModelProfile[]; picked: Set<string> } | null>(null)

  const load = async (): Promise<void> => {
    try {
      const next = await window.manager.getUnifiedConfiguration()
      setConfiguration(next)
      setDraft(structuredClone(next))
      setKeyDrafts({})
      setCreatingProviderId(null)
    } catch (error) { onError(errorText(error)) }
  }
  useEffect(() => { void load() }, [])

  const patchProvider = (id: string, mutate: (provider: UnifiedProviderProfile) => UnifiedProviderProfile): void => {
    setDraft(current => current ? { ...current, providers: current.providers.map(provider => provider.id === id ? mutate(provider) : provider) } : current)
  }
  const patchModel = (providerId: string, index: number, patch: UnifiedModelPatch): void => {
    setDraft(current => {
      if (!current) return current
      const provider = current.providers.find(candidate => candidate.id === providerId)
      const previousId = provider?.models[index]?.id
      const providers = current.providers.map(candidate => candidate.id !== providerId ? candidate : { ...candidate, models: candidate.models.map((model, at) => {
        if (at !== index) return model
        const next: UnifiedModelProfile = { ...model }
        if (patch.id !== undefined) next.id = patch.id
        if ('name' in patch) {
          if (patch.name === undefined) delete next.name
          else next.name = patch.name
        }
        if ('contextWindow' in patch) {
          if (patch.contextWindow === undefined) delete next.contextWindow
          else next.contextWindow = patch.contextWindow
        }
        if ('maxTokens' in patch) {
          if (patch.maxTokens === undefined) delete next.maxTokens
          else next.maxTokens = patch.maxTokens
        }
        return next
      }) })
      const defaultModel = current.defaultModel?.provider === providerId && current.defaultModel.model === previousId && patch.id !== undefined
        ? { provider: providerId, model: patch.id }
        : current.defaultModel
      const { defaultModel: _previousDefault, ...rest } = current
      return { ...rest, providers, ...(defaultModel ? { defaultModel } : {}) }
    })
  }
  const deleteModel = (providerId: string, index: number): void => {
    setDraft(current => {
      if (!current) return current
      const removedId = current.providers.find(provider => provider.id === providerId)?.models[index]?.id
      const providers = current.providers.map(provider => provider.id === providerId ? { ...provider, models: provider.models.filter((_model, at) => at !== index) } : provider)
      if (current.defaultModel?.provider === providerId && current.defaultModel.model === removedId) {
        const { defaultModel: _defaultModel, ...rest } = current
        return { ...rest, providers }
      }
      return { ...current, providers }
    })
  }
  const addProvider = (): void => {
    if (creatingProviderId !== null) { setExpanded(creatingProviderId); return }
    const ids = new Set(draft?.providers.map(provider => provider.id) ?? [])
    let id = 'new-provider'
    for (let suffix = 2; ids.has(id); suffix += 1) id = `new-provider-${suffix}`
    const provider: UnifiedProviderProfile = { id, kind: 'custom', displayName: '', protocol: 'openai-completions', apiKeyRef: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`, hasApiKey: false, baseURL: '', models: [] }
    setDraft(current => current ? { ...current, providers: [...current.providers, provider] } : current)
    setCreatingProviderId(id)
    setExpanded(id)
  }
  const renameCreatingProvider = (previousId: string, id: string): void => {
    if (draft?.providers.some(provider => provider.id !== previousId && provider.id === id)) { onError(`提供方 ID 已存在：${id}`); return }
    setDraft(current => current ? { ...current, providers: current.providers.map(provider => provider.id === previousId ? { ...provider, id, apiKeyRef: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY` } : provider) } : current)
    setKeyDrafts(current => { const next = { ...current }; if (previousId in next) { next[id] = next[previousId]!; delete next[previousId] } return next })
    setCreatingProviderId(id)
    setExpanded(id)
  }
  const cancelCreatingProvider = (id: string): void => {
    setDraft(current => current ? { ...current, providers: current.providers.filter(provider => provider.id !== id) } : current)
    setKeyDrafts(current => { const next = { ...current }; delete next[id]; return next })
    setCreatingProviderId(null)
    setExpanded(null)
  }
  const discoverModels = async (provider: UnifiedProviderProfile): Promise<void> => {
    if (discovering) return
    setDiscovering(provider.id)
    try {
      const apiKey = keyDrafts[provider.id]?.trim()
      const candidates = await window.manager.discoverUnifiedModels({
        providerId: provider.id,
        protocol: provider.protocol,
        ...(provider.baseURL?.trim() ? { baseURL: provider.baseURL.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
      })
      if (candidates.length === 0) { onError('提供方没有返回可用模型。'); return }
      const known = new Set(provider.models.map(model => model.id))
      const room = Math.max(0, 100 - provider.models.length)
      const picked = new Set(candidates.filter(model => !known.has(model.id)).slice(0, room).map(model => model.id))
      setDiscovery({ providerId: provider.id, candidates, picked })
    } catch (error) { onError(errorText(error)) } finally { setDiscovering(null) }
  }
  const adoptDiscoveredModels = (): void => {
    if (!discovery) return
    patchProvider(discovery.providerId, provider => {
      const models = new Map(provider.models.map(model => [model.id, model]))
      for (const candidate of discovery.candidates) if (discovery.picked.has(candidate.id) && !models.has(candidate.id)) models.set(candidate.id, candidate)
      return { ...provider, models: [...models.values()] }
    })
    setDiscovery(null)
  }
  const toggleDiscoveredModel = (id: string): void => {
    setDiscovery(current => {
      if (!current) return current
      const provider = draft?.providers.find(candidate => candidate.id === current.providerId)
      if (!provider || provider.models.some(model => model.id === id)) return current
      const picked = new Set(current.picked)
      if (!picked.delete(id)) {
        if (provider.models.length + picked.size >= 100) { onError('每个提供方最多配置 100 个模型。'); return current }
        picked.add(id)
      }
      return { ...current, picked }
    })
  }
  const toggleAllDiscoveredModels = (): void => {
    setDiscovery(current => {
      if (!current) return current
      const provider = draft?.providers.find(candidate => candidate.id === current.providerId)
      if (!provider) return current
      const known = new Set(provider.models.map(model => model.id))
      const available = current.candidates.filter(model => !known.has(model.id)).slice(0, Math.max(0, 100 - provider.models.length))
      return { ...current, picked: current.picked.size === available.length ? new Set() : new Set(available.map(model => model.id)) }
    })
  }
  const save = async (): Promise<void> => {
    if (!draft || saving) return
    const validation = configurationDraftError(draft)
    if (validation) { onError(validation); return }
    setSaving(true)
    try {
      let next = await window.manager.saveUnifiedConfiguration(configurationInput(draft))
      let credentialChanged = false
      for (const provider of draft.providers) {
        const key = keyDrafts[provider.id]?.trim()
        if (key) {
          next = await window.manager.setUnifiedCredential({ ref: provider.apiKeyRef, value: key })
          credentialChanged = true
        }
      }
      if (credentialChanged) next = await window.manager.saveUnifiedConfiguration(configurationInput(draft))
      setConfiguration(next)
      setDraft(structuredClone(next))
      setKeyDrafts({})
      setCreatingProviderId(null)
    } catch (error) {
      onError(`${errorText(error)} 配置已重新加载，请确认后重试。`)
      await load()
    } finally { setSaving(false) }
  }
  const generalDirty = configuration !== null && draft !== null && (
    configuration.locale !== draft.locale || configuration.theme !== draft.theme || configuration.defaultPermission !== draft.defaultPermission || configuration.busyEnter !== draft.busyEnter
  )
  const modelsDirty = configuration !== null && draft !== null && (
    JSON.stringify(configuration.providers) !== JSON.stringify(draft.providers) || JSON.stringify(configuration.defaultModel) !== JSON.stringify(draft.defaultModel) || Object.values(keyDrafts).some(value => value.trim())
  )
  const dirty = generalDirty || modelsDirty
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])

  if (!draft) return <div className="configuration-loading"><RefreshCw size={22} className="spin" /><span>正在读取统一配置…</span></div>
  const modelGroups = draft.providers.map(provider => ({
    id: provider.id,
    label: provider.displayName.trim() || provider.id,
    models: provider.models.map(model => ({ value: `${provider.id}\u0000${model.id}`, label: model.name || model.id })),
  })).filter(group => group.models.length > 0)
  const defaultModelValue = draft.defaultModel ? `${draft.defaultModel.provider}\u0000${draft.defaultModel.model}` : ''

  return <div className="configuration-page">
    <header className="configuration-header"><div><h1>统一配置</h1><p>{runningCount ? `${runningCount} 个运行中实例将在重启后应用更改` : '新实例和以后创建的会话会复用这里的设置'}</p></div></header>
    <div className="configuration-shell">
      <nav className="configuration-nav" aria-label="统一配置分类"><button className={section === 'general' ? 'active' : ''} onClick={() => setSection('general')}>通用</button><button className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}>模型</button></nav>
      <div className="configuration-content">
        {section === 'general' ? <section className="configuration-section"><h2>通用设置</h2>
          <ConfigRow title="语言" detail="管理器写入 DSH 的默认界面语言"><select aria-label="语言" value={draft.locale} onChange={event => setDraft({ ...draft, locale: event.target.value as UnifiedConfiguration['locale'] })}><option value="system">跟随系统</option><option value="zh">中文</option><option value="en">English</option></select></ConfigRow>
          <ConfigRow title="外观" detail="新启动实例使用的主题偏好"><div className="segmented-control">{(['light', 'dark', 'system'] as const).map(value => <button key={value} aria-pressed={draft.theme === value} className={draft.theme === value ? 'active' : ''} onClick={() => setDraft({ ...draft, theme: value })}>{value === 'light' ? '浅色' : value === 'dark' ? '深色' : '跟随系统'}</button>)}</div></ConfigRow>
          <ConfigRow title="默认权限" detail="只影响以后创建的会话"><select aria-label="默认权限" value={draft.defaultPermission} onChange={event => { const value = event.target.value as UnifiedConfiguration['defaultPermission']; if (value === 'danger-full-access') setRiskOpen(true); else setDraft({ ...draft, defaultPermission: value }) }}><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问</option></select></ConfigRow>
          <ConfigRow title="忙碌时按 Enter" detail="选择追加排队或立即引导当前回复"><select aria-label="忙碌时按 Enter" value={draft.busyEnter} onChange={event => setDraft({ ...draft, busyEnter: event.target.value as UnifiedConfiguration['busyEnter'] })}><option value="steer">立即引导</option><option value="queue">加入队列</option></select></ConfigRow>
          {generalDirty && <footer className="configuration-save-bar"><span>通用设置有未保存的更改</span><button className="button primary" disabled={saving} onClick={() => void save()}><Save size={16} />{saving ? '正在保存…' : '保存通用设置'}</button></footer>}
        </section> : <section className="configuration-section models-section"><div className="configuration-section-heading"><div><h2>模型</h2><p>API Key 仅写入共享凭据文件，不会回显</p></div><button className="button outline small" disabled={creatingProviderId !== null} onClick={addProvider}><Plus size={15} />添加自定义提供方</button></div>
          <ConfigRow title="新会话默认模型" detail="选择一个具体提供方下的模型；思考深度使用该模型的默认值"><select aria-label="新会话默认模型" value={defaultModelValue} onChange={event => { const [provider, model] = event.target.value.split('\u0000'); const { defaultModel: _previousModel, defaultReasoningEffort: _previousEffort, ...rest } = draft; setDraft(provider && model ? { ...rest, defaultModel: { provider, model } } : rest) }}><option value="">使用 DSH 默认值</option>{modelGroups.map(group => <optgroup key={group.id} label={group.label}>{group.models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</optgroup>)}</select></ConfigRow>
          <div className="provider-list">{draft.providers.map((provider, index) => <article className={`provider-profile${expanded === provider.id ? ' expanded' : ''}`} key={`${provider.kind}:${index}`}>
            <button className="provider-summary" aria-expanded={expanded === provider.id} onClick={() => setExpanded(current => current === provider.id ? null : provider.id)}><span className={`credential-dot ${provider.hasApiKey || keyDrafts[provider.id]?.trim() ? 'configured' : ''}`} /><span className="grow"><strong>{provider.displayName.trim() || provider.id || '新的提供方'}</strong><small>{provider.id || '尚未填写 ID'} · {provider.protocol === 'deepseek' ? 'DeepSeek API' : provider.protocol}</small></span><span className="provider-key-state">{provider.hasApiKey ? 'API Key 已配置' : 'API Key 未配置'}</span>{expanded === provider.id ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
            {expanded === provider.id && <div className="provider-editor">
              {creatingProviderId === provider.id && <label className="field"><span>提供方 ID</span><input autoFocus value={provider.id} onFocus={event => event.currentTarget.select()} onChange={event => renameCreatingProvider(provider.id, event.target.value)} /></label>}
              <div className="credential-field-row"><label className="field"><span>API Key</span><span className="key-field"><KeyRound size={16} /><input type="password" autoComplete="new-password" value={keyDrafts[provider.id] ?? ''} placeholder={provider.hasApiKey ? '已配置；留空保持不变' : '输入 API Key'} onChange={event => setKeyDrafts(current => ({ ...current, [provider.id]: event.target.value }))} /></span></label>{provider.hasApiKey && <button className="button outline small" onClick={() => setClearingKey(provider)}>清除 Key</button>}</div>
              {provider.kind === 'custom' && <div className="provider-grid"><label className="field"><span>显示名称（可选）</span><input value={provider.displayName} placeholder="留空时使用提供方 ID" onChange={event => patchProvider(provider.id, current => ({ ...current, displayName: event.target.value }))} /></label><label className="field"><span>API 协议</span><select value={provider.protocol} onChange={event => patchProvider(provider.id, current => ({ ...current, protocol: event.target.value as UnifiedProviderProfile['protocol'] }))}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label></div>}
              <label className="field"><span>Base URL</span><input value={provider.baseURL ?? ''} placeholder={provider.kind === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.example.com/v1'} onChange={event => patchProvider(provider.id, current => ({ ...current, baseURL: event.target.value }))} /></label>
              <div className="provider-grid"><label className="field"><span>请求超时（分钟）</span><input type="number" min="0.1" step="0.1" value={timeoutMinutes(provider.timeoutMs)} placeholder="使用提供方默认值" onChange={event => patchProvider(provider.id, current => { const next = { ...current }; const value = timeoutMilliseconds(event.target.value); if (value === undefined) next.timeoutMs = null; else next.timeoutMs = value; return next })} /></label><label className="field"><span>流空闲超时（分钟）</span><input type="number" min="0.1" step="0.1" value={timeoutMinutes(provider.streamIdleTimeoutMs)} placeholder="DSH 默认 5 分钟" onChange={event => patchProvider(provider.id, current => { const next = { ...current }; const value = timeoutMilliseconds(event.target.value); if (value === undefined) next.streamIdleTimeoutMs = null; else next.streamIdleTimeoutMs = value; return next })} /></label></div>
              <div className="model-editor"><div className="model-editor-heading"><span>模型</span><span className="model-editor-actions"><button className="button outline small" disabled={!['deepseek', 'openai-completions', 'openai-responses'].includes(provider.protocol) || discovering !== null || !provider.baseURL?.trim()} title={!['deepseek', 'openai-completions', 'openai-responses'].includes(provider.protocol) ? '当前协议没有可读取的模型列表接口' : !provider.baseURL?.trim() ? '请先填写 Base URL' : undefined} onClick={() => void discoverModels(provider)}><RefreshCw size={14} className={discovering === provider.id ? 'spin' : ''} />{discovering === provider.id ? '正在发现…' : '发现可用模型'}</button><button className="button outline small" onClick={() => patchProvider(provider.id, current => ({ ...current, models: [...current.models, { id: '' }] }))}><Plus size={14} />添加模型</button></span></div>{provider.models.map((model, index) => <div className="model-row" key={`${provider.id}:${index}`}><input aria-label={`模型 ID ${index + 1}`} placeholder="模型 ID" value={model.id} onChange={event => patchModel(provider.id, index, { id: event.target.value })} /><input aria-label={`模型名称 ${index + 1}`} placeholder="显示名称（可选）" value={model.name ?? ''} onChange={event => patchModel(provider.id, index, { name: event.target.value || undefined })} /><input aria-label={`上下文窗口 ${index + 1}`} inputMode="numeric" placeholder="上下文窗口" value={model.contextWindow ?? ''} onChange={event => patchModel(provider.id, index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })} /><input aria-label={`最大输出 ${index + 1}`} inputMode="numeric" placeholder="最大输出" value={model.maxTokens ?? ''} onChange={event => patchModel(provider.id, index, { maxTokens: event.target.value ? Number(event.target.value) : undefined })} /><IconButton danger label="删除模型" onClick={() => deleteModel(provider.id, index)}><Trash2 size={15} /></IconButton></div>)}</div>
              {provider.kind !== 'deepseek' && <footer className="provider-footer">{creatingProviderId === provider.id ? <button className="button outline small" onClick={() => cancelCreatingProvider(provider.id)}>取消新增</button> : <button className="button danger small" onClick={() => setRemoving(provider)}><Trash2 size={14} />删除提供方</button>}</footer>}
            </div>}
          </article>)}</div>
        {modelsDirty && <footer className="configuration-save-bar"><span>模型配置有未保存的更改</span><button className="button primary" disabled={saving} onClick={() => void save()}><Save size={16} />{saving ? '正在保存…' : '保存模型配置'}</button></footer>}
         </section>}
              </div>
    </div>
    {removing && <Dialog title="删除提供方" onClose={() => setRemoving(null)}><div className="confirm-content"><p>将删除“{removing.displayName.trim() || removing.id}”的共享模型配置。已保存的 API Key 会保留，可在删除前单独清除。</p><footer><button className="button outline" onClick={() => setRemoving(null)}>取消</button><button className="button danger" onClick={() => { const providers = draft.providers.filter(provider => provider.id !== removing.id); const { defaultModel, ...rest } = draft; setDraft(defaultModel?.provider === removing.id ? { ...rest, providers } : { ...draft, providers }); setRemoving(null) }}>删除提供方</button></footer></div></Dialog>}
    {clearingKey && <Dialog title="清除 API Key" onClose={() => setClearingKey(null)}><div className="confirm-content"><p>将从共享凭据文件中清除“{clearingKey.displayName.trim() || clearingKey.id}”使用的 API Key。引用同一 Key 的其他提供方也会受到影响。</p><footer><button className="button outline" onClick={() => setClearingKey(null)}>取消</button><button className="button danger" onClick={() => { setSaving(true); void window.manager.setUnifiedCredential({ ref: clearingKey.apiKeyRef, value: null }).then(next => { setConfiguration(next); setDraft(current => current ? { ...current, providers: current.providers.map(provider => provider.apiKeyRef === clearingKey.apiKeyRef ? { ...provider, hasApiKey: false } : provider) } : structuredClone(next)); setKeyDrafts(current => { const changed = { ...current }; for (const provider of next.providers) if (provider.apiKeyRef === clearingKey.apiKeyRef) delete changed[provider.id]; return changed }); setClearingKey(null) }).catch(error => onError(errorText(error))).finally(() => setSaving(false)) }}>清除 Key</button></footer></div></Dialog>}
    {discovery && <DiscoveryModelsDialog candidates={discovery.candidates} configured={draft.providers.find(provider => provider.id === discovery.providerId)?.models ?? []} picked={discovery.picked} onToggle={toggleDiscoveredModel} onToggleAll={toggleAllDiscoveredModels} onClose={() => setDiscovery(null)} onAdopt={adoptDiscoveredModels} />}
    {riskOpen && <Dialog title="启用完全访问" onClose={() => { setRiskOpen(false); setRiskAcknowledged(false) }}><div className="confirm-content"><p>以后创建的会话将可以访问工作区之外的文件，并且不会请求批准。</p><label className="check-row"><input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />我了解这会扩大新会话的系统访问范围</label><footer><button className="button outline" onClick={() => { setRiskOpen(false); setRiskAcknowledged(false) }}>取消</button><button className="button danger" disabled={!riskAcknowledged} onClick={() => { setDraft({ ...draft, defaultPermission: 'danger-full-access' }); setRiskOpen(false); setRiskAcknowledged(false) }}>启用完全访问</button></footer></div></Dialog>}
  </div>
}

function DiscoveryModelsDialog({ candidates, configured, picked, onToggle, onToggleAll, onClose, onAdopt }: { candidates: UnifiedModelProfile[]; configured: UnifiedModelProfile[]; picked: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void; onClose: () => void; onAdopt: () => void }): ReactNode {
  const known = new Set(configured.map(model => model.id))
  const selectable = new Set(candidates.filter(model => !known.has(model.id)).slice(0, Math.max(0, 100 - configured.length)).map(model => model.id))
  const allPicked = selectable.size > 0 && [...selectable].every(id => picked.has(id))
  return <Dialog title="发现可用模型" onClose={onClose}><div className="discovery-dialog"><header><p>选择要加入当前提供方的模型。已配置模型不会被覆盖。</p><button className="button outline small" onClick={onToggleAll}>{allPicked ? '取消全选' : '全选新模型'}</button></header><ul className="discovery-list">{candidates.map(model => { const existing = known.has(model.id); const unavailable = !existing && !selectable.has(model.id); return <li key={model.id}><label><input type="checkbox" disabled={existing || unavailable} checked={!existing && picked.has(model.id)} onChange={() => onToggle(model.id)} /><span><strong>{model.name || model.id}</strong><small>{model.id}{model.contextWindow ? ` · 上下文 ${model.contextWindow.toLocaleString()}` : ''}{model.maxTokens ? ` · 最大输出 ${model.maxTokens.toLocaleString()}` : ''}</small></span>{(existing || unavailable) && <em>{existing ? '已配置' : '已达上限'}</em>}</label></li> })}</ul><footer><span>已选择 {picked.size} 个</span><div><button className="button outline" onClick={onClose}>取消</button><button className="button primary" disabled={picked.size === 0} onClick={onAdopt}>添加所选模型</button></div></footer></div></Dialog>
}

function ConfigRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }): ReactNode {
  return <div className="configuration-row"><span><strong>{title}</strong><small>{detail}</small></span><div>{children}</div></div>
}

function HomePage({ snapshot, busy, onModal, onOpen, onRun, onLog, onConfirm, onUseTemplate }: { snapshot: ManagerSnapshot; busy: string | null; onModal: (modal: Modal) => void; onOpen: (id: string) => void; onRun: Runner; onLog: (instance: InstanceRecord) => Promise<void>; onConfirm: (confirmation: Confirmation) => void; onUseTemplate: (id: string) => void }): ReactNode {
  const running = snapshot.instances.filter(instance => instance.status === 'running').length
  const production = snapshot.instances.find(instance => instance.id === snapshot.settings.productionInstanceId) ?? snapshot.instances.find(instance => snapshot.environments.find(environment => environment.id === instance.environmentId)?.kind === 'production')
  const activePromotion = snapshot.promotions.find(item => item.status === 'awaiting-confirmation' && item.productionInstanceId === production?.id)
  const rollbackPoint = activePromotion ?? [...snapshot.promotions].reverse().find(item => item.status === 'committed' && item.productionInstanceId === production?.id)
  return <div className="page"><header className="page-heading"><div><h1>概览</h1><p>{running} 个实例正在运行，{snapshot.environments.length} 个环境可用</p></div><button className="button primary" onClick={() => onModal('instance')} disabled={!snapshot.runtimes.length || !snapshot.environments.length}><Plus size={16} />新建实例</button></header>
    {(production || rollbackPoint) && <section className="content-section production-section"><div className="section-heading"><div><h2>生产</h2><p>运行版本与完整环境同步提升或回退</p></div><button className="button outline small" onClick={() => onModal('promotion')}><ShieldCheck size={15} />提升候选版本</button></div>{production && <div className="production-row"><span className="environment-icon"><ShieldCheck size={17} /></span><span className="grow"><strong>{production.name}</strong><small>{snapshot.runtimes.find(runtime => runtime.id === production.runtimeId)?.name} · {instanceStatusLabel(production)}</small></span>{activePromotion && <button className="button primary small" disabled={busy !== null} onClick={() => void onRun(`confirm:${activePromotion.id}`, () => window.manager.confirmPromotion(activePromotion.id))}><Check size={15} />确认生产正常</button>}{rollbackPoint && <button className="button outline small" disabled={busy !== null} onClick={() => onConfirm({ title: '回退生产版本', detail: '将停止生产实例，同时恢复上一运行版本与提升前的完整 DSH_HOME。当前故障环境会保留在诊断目录。', actionLabel: '执行回退', action: () => window.manager.rollbackPromotion(rollbackPoint.id) })}><ArchiveRestore size={15} />回退</button>}{rollbackPoint?.status === 'committed' && <IconButton danger label="放弃回退点" onClick={() => onConfirm({ title: '放弃生产回退点', detail: '此操作不会删除备份，但会解除旧运行时和生产实例的回退保护，且不能撤销。', actionLabel: '放弃回退点', action: () => window.manager.dismissPromotion(rollbackPoint.id) })}><Trash2 size={15} /></IconButton>}</div>}</section>}
    <section className="content-section"><div className="section-heading"><div><h2>实例</h2><p>管理本机 DSH 进程与工作区</p></div></div>{!snapshot.instances.length ? <EmptyState icon={<TerminalSquare size={22} />} title="暂无实例" detail="先准备运行时与独立环境。" action={<button className="button primary" onClick={() => onModal(snapshot.runtimes.length ? 'environment' : 'runtime')}><Plus size={16} />{snapshot.runtimes.length ? '创建环境' : '注册运行时'}</button>} /> : <div className="row-list">{snapshot.instances.map(instance => <InstanceRow key={instance.id} instance={instance} snapshot={snapshot} busy={busy} onOpen={onOpen} onRun={onRun} onLog={onLog} />)}</div>}</section>
    {!!snapshot.templates.length && <section className="content-section"><div className="section-heading"><div><h2>实例模板</h2><p>用固定运行时与环境模式快速创建实例</p></div></div><div className="compact-list">{snapshot.templates.map(template => <div className="compact-row" key={template.id}><span className="environment-icon"><Copy size={16} /></span><span className="grow"><strong>{template.name}</strong><small>{snapshot.runtimes.find(runtime => runtime.id === template.runtimeId)?.name ?? '运行时缺失'} · {template.environmentMode === 'new-isolated' ? '创建新环境' : '使用生产环境'}</small></span><button className="button outline small" onClick={() => onUseTemplate(template.id)}><Plus size={14} />创建实例</button><IconButton danger label="删除模板" onClick={() => onConfirm({ title: '删除实例模板', detail: '只删除模板，不影响已创建的实例、运行时或环境。', actionLabel: '删除模板', action: () => window.manager.deleteInstanceTemplate(template.id) })}><Trash2 size={15} /></IconButton></div>)}</div></section>}
    <div className="overview-grid"><section className="content-section"><div className="section-heading"><div><h2>运行时</h2><p>官方与本地 DSH 版本</p></div></div><RuntimeRows snapshot={snapshot} busy={busy} onRun={onRun} /></section><section className="content-section"><div className="section-heading"><div><h2>环境</h2><p>相互独立的 DSH_HOME</p></div><IconButton label="创建环境" onClick={() => onModal('environment')}><Plus size={17} /></IconButton></div><EnvironmentRows environments={snapshot.environments} snapshot={snapshot} /></section></div>
  </div>
}
type Runner = (key: string, action: () => Promise<unknown>) => Promise<void>
function InstanceRow({ instance, snapshot, busy, onOpen, onRun, onLog }: { instance: InstanceRecord; snapshot: ManagerSnapshot; busy: string | null; onOpen: (id: string) => void; onRun: Runner; onLog: (instance: InstanceRecord) => Promise<void> }): ReactNode {
  const runtime = snapshot.runtimes.find(item => item.id === instance.runtimeId); const environment = snapshot.environments.find(item => item.id === instance.environmentId); const active = ['starting', 'running', 'stopping'].includes(instance.status); const recovery = instance.interrupted || instance.portModeReviewRequired
  return <article className="instance-row"><button className="instance-main" onClick={() => onOpen(instance.id)}><span className="instance-identity"><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{runtime?.name ?? '运行时缺失'} · {environment?.name ?? '环境缺失'}</small></span></span><span className="instance-meta"><span>{instance.port ? `${instance.automaticPort ? '自动 · ' : ''}:${instance.port}` : '自动端口'}</span></span></button><div className="row-actions">{recovery ? <button className="button outline small" onClick={() => onOpen(instance.id)}>确认恢复</button> : active ? <IconButton label={instance.status === 'stopping' ? '强制停止' : '停止'} disabled={busy !== null} onClick={() => void onRun(`stop:${instance.id}`, () => window.manager.stopInstance(instance.id, instance.status === 'stopping'))}><CircleStop size={17} /></IconButton> : <IconButton label="启动" disabled={busy !== null} onClick={() => void onRun(`start:${instance.id}`, () => window.manager.startInstance(instance.id))}><Play size={17} /></IconButton>}<IconButton label="重新启动" disabled={busy !== null || instance.status !== 'running' || Boolean(recovery)} onClick={() => void onRun(`restart:${instance.id}`, () => window.manager.restartInstance(instance.id))}><RotateCw size={17} /></IconButton><IconButton label="查看日志" onClick={() => void onLog(instance)}><FileText size={17} /></IconButton></div></article>
}
function RuntimeRows({ snapshot, busy, onRun }: { snapshot: ManagerSnapshot; busy: string | null; onRun: Runner }): ReactNode {
  if (!snapshot.runtimes.length) return <p className="empty-inline">暂无已注册的运行时</p>
  return <div className="compact-list">{snapshot.runtimes.map(runtime => <div className="compact-row" key={runtime.id}><span className={`check-mark ${runtime.preflight.ready && !runtime.taskBlocked ? 'pass' : 'failure'}`}><Gauge size={16} /></span><span className="grow"><strong>{runtime.name}{snapshot.settings.defaultRuntimeId === runtime.id ? ' · 默认' : ''}</strong><small>{runtime.version ?? runtime.preflight.packageVersion ?? '版本未知'} · {runtime.preflight.ready && !runtime.taskBlocked ? '可启动' : '受阻'}</small></span><IconButton label="重新预检" disabled={busy === `refresh:${runtime.id}`} onClick={() => void onRun(`refresh:${runtime.id}`, () => window.manager.refreshRuntime(runtime.id))}><RefreshCw size={16} /></IconButton></div>)}</div>
}
function EnvironmentRows({ environments, snapshot }: { environments: EnvironmentRecord[]; snapshot: ManagerSnapshot }): ReactNode {
  if (!environments.length) return <p className="empty-inline">暂无环境</p>
  return <div className="compact-list">{environments.map(environment => { const occupant = snapshot.instances.find(instance => instance.environmentId === environment.id && instance.status === 'running'); return <div className="compact-row" key={environment.id}><span className="environment-icon"><Database size={16} /></span><span className="grow"><strong>{environment.name}</strong><small>{environment.kind === 'production' ? '生产环境' : environment.kind === 'clone' ? '克隆环境' : '独立环境'}{environment.lineage ? ' · 已记录来源' : ''}</small></span><span className={`availability ${occupant ? 'occupied' : ''}`}>{occupant ? occupant.name : '可用'}</span></div> })}</div>
}

function RuntimesPage({ snapshot, busy, onModal, onRun, onLog, onConfirm, onError }: { snapshot: ManagerSnapshot; busy: string | null; onModal: (modal: Modal) => void; onRun: Runner; onLog: (taskId: string, name: string) => Promise<void>; onConfirm: (confirmation: Confirmation) => void; onError: (value: string | null) => void }): ReactNode {
  const [update, setUpdate] = useState<OfficialUpdateInfo | null>(null)
  const check = async (): Promise<void> => { try { onError(null); setUpdate(await window.manager.checkOfficialUpdate('stable')) } catch (error) { onError(errorText(error)) } }
  useEffect(() => { if (snapshot.settings.checkUpdatesOnStartup) void check() }, [])
  const installing = snapshot.operations.find(operation => operation.type === 'runtime-install' && (operation.status === 'prepared' || operation.status === 'running'))
  return <div className="page narrow-page"><header className="page-heading"><div><h1>运行时</h1><p>官方版本、源码构建与启动门禁</p></div><div className="heading-actions"><button className="button outline" onClick={() => void check()}><RefreshCw size={16} />检查更新</button><button className="button outline" disabled={!snapshot.runtimes.some(runtime => runtime.source === 'local')} onClick={() => onModal('worktree')}><Copy size={16} />创建工作树</button><button className="button primary" onClick={() => onModal('runtime')}><Plus size={16} />注册本地运行时</button></div></header>
    <section className="content-section official-update"><div className="section-heading"><div><h2>官方 DSH</h2><p>固定来源 registry.npmjs.org，安装完整依赖并校验 integrity</p></div></div>{update ? <div className="official-row"><span className="brand-mark"><Download size={17} /></span><span className="grow"><strong>DSH {update.version}</strong><small>{update.installed ? '已安装' : `可安装${update.unpackedSize ? ` · 入口包 ${Math.ceil(update.unpackedSize / 1024)} KiB` : ''}`}</small></span>{!update.installed && <button className="button primary small" disabled={Boolean(installing)} onClick={() => void onRun(`install:${update.version}`, () => window.manager.installOfficialRuntime({ version: update.version }))}><Download size={15} />安装</button>}</div> : <p className="empty-inline">点击“检查更新”获取官方版本信息</p>}{installing && <div className="operation-progress"><Activity size={16} /><span><strong>正在安装 {String(installing.input.version)}</strong><small>{String(installing.input.detail ?? installing.phase)}</small></span><button className="button outline small" onClick={() => void onRun(`cancel:${installing.id}`, () => window.manager.cancelRuntimeInstall(installing.id))}>取消</button></div>}</section>
    <section className="content-section">{!snapshot.runtimes.length ? <EmptyState icon={<Boxes size={22} />} title="暂无运行时" detail="可以安装官方版本，或注册本地 DSH 源码目录。" action={<button className="button primary" onClick={() => onModal('runtime')}><Plus size={16} />注册运行时</button>} /> : <div className="runtime-list">{snapshot.runtimes.map(runtime => {
      const tasks = snapshot.tasks.filter(task => task.runtimeId === runtime.id).slice(-3).reverse(); const activeTask = tasks.find(task => task.status === 'prepared' || task.status === 'running')
      return <article className="runtime-detail" key={runtime.id}><header><div><h3>{runtime.name}{snapshot.settings.defaultRuntimeId === runtime.id && <span className="inline-badge">默认</span>}</h3><p>{shortPath(runtime.path)}</p></div><span className={`preflight-badge ${runtime.preflight.ready && !runtime.taskBlocked ? 'ready' : 'blocked'}`}>{runtime.preflight.ready && !runtime.taskBlocked ? '可以启动' : '启动受阻'}</span></header>
        <div className="runtime-meta"><span>{runtime.source === 'bundled' ? '内置官方' : runtime.source === 'downloaded' ? '已下载官方' : '本地源码'}</span><span>{runtime.version ?? runtime.preflight.packageVersion ?? '版本未知'}</span>{runtime.preflight.gitCommit && <span>{runtime.preflight.gitCommit.slice(0, 10)}{runtime.preflight.gitDirty ? ' · 有修改' : ' · 干净'}</span>}</div>
        {runtime.taskBlocked && <p className="validation-note">{runtime.taskBlocked}</p>}
        <div className="checks">{runtime.preflight.checks.map(check => <div className="check-row" key={check.id}><span className={`check-dot ${check.level}`} /><span><strong>{CHECK_LABEL[check.id] ?? check.label}</strong><small>{check.detail}</small>{check.remediation && <em>{check.remediation}</em>}</span></div>)}</div>
        {runtime.source === 'local' && !runtime.immutable && <div className="task-toolbar">{(['install', 'typecheck', 'test', 'build'] as const).map(kind => <button className="button outline small" key={kind} disabled={Boolean(activeTask) || busy !== null} onClick={() => void onRun(`task:${runtime.id}:${kind}`, () => window.manager.startRuntimeTask(runtime.id, kind))}><Wrench size={14} />{TASK_LABEL[kind]}</button>)}</div>}
        {!!tasks.length && <div className="task-list">{tasks.map(task => <div key={task.id}><span className={`task-status ${task.status}`}>{TASK_LABEL[task.kind]} · {task.status === 'succeeded' ? '成功' : task.status === 'running' ? '运行中' : task.status === 'prepared' ? '准备中' : task.status === 'cancelled' ? '已取消' : task.status === 'interrupted' ? '已中断' : '失败'}</span><span className="row-actions"><IconButton label="任务日志" onClick={() => void onLog(task.id, `${runtime.name} · ${TASK_LABEL[task.kind]}`)}><FileText size={15} /></IconButton>{(task.status === 'prepared' || task.status === 'running') && <button className="button outline small" onClick={() => void onRun(`task-cancel:${task.id}`, () => window.manager.cancelRuntimeTask(task.id))}>取消</button>}</span></div>)}</div>}
        <footer><span>检查于 {new Date(runtime.preflight.checkedAt).toLocaleString('zh-CN')}</span><div className="row-actions">{snapshot.settings.defaultRuntimeId !== runtime.id && <button className="button outline small" onClick={() => void onRun(`default:${runtime.id}`, () => window.manager.setDefaultRuntime(runtime.id))}><Check size={15} />设为默认</button>}<button className="button outline small" onClick={() => void onRun(`refresh:${runtime.id}`, () => window.manager.refreshRuntime(runtime.id))}><RefreshCw size={15} />重新预检</button>{runtime.source !== 'bundled' && <IconButton danger label={runtime.source === 'local' ? '注销运行时' : '删除运行时'} onClick={() => onConfirm({ title: runtime.source === 'local' ? '注销本地运行时' : '删除官方运行时', detail: runtime.source === 'local' ? '只移除管理器记录，不会删除源码目录。仍被实例或回退记录引用时会拒绝操作。' : '删除管理器下载的完整运行时目录。仍被实例或回退记录引用时会拒绝操作。', actionLabel: runtime.source === 'local' ? '注销' : '删除', action: () => window.manager.deleteRuntime(runtime.id) })}><Trash2 size={16} /></IconButton>}</div></footer>
      </article> })}</div>}</section>
  </div>
}

function SettingsPage({ snapshot, busy, onModal, onRun, onConfirm }: { snapshot: ManagerSnapshot; busy: string | null; onModal: (modal: Modal) => void; onRun: Runner; onConfirm: (confirmation: Confirmation) => void }): ReactNode {
  return <div className="page settings-page"><header className="page-heading"><div><h1>设置</h1><p>管理器偏好、环境数据与备份</p></div></header><div className="settings-layout"><nav className="settings-index"><a href="#general">通用</a><a href="#environments">环境</a><a href="#backups">备份</a></nav><div className="settings-content">
    <section id="general" className="settings-section"><h2>通用</h2><label className="setting-row"><span><strong>实例打开方式</strong><small>默认嵌入管理器或在系统浏览器中打开</small></span><select value={snapshot.settings.openMode} onChange={event => void onRun('setting:open', () => window.manager.updateSettings({ openMode: event.target.value as 'embedded' | 'external' }))}><option value="embedded">嵌入管理器</option><option value="external">系统浏览器</option></select></label><label className="setting-row"><span><strong>启动时检查官方更新</strong><small>只读取固定 npm registry 的版本元数据</small></span><input type="checkbox" checked={snapshot.settings.checkUpdatesOnStartup} onChange={event => void onRun('setting:update', () => window.manager.updateSettings({ checkUpdatesOnStartup: event.target.checked }))} /></label><div className="setting-row"><span><strong>默认运行时</strong><small>只影响新建实例，不改动已有实例</small></span><select value={snapshot.settings.defaultRuntimeId ?? ''} onChange={event => void onRun('setting:default', () => window.manager.setDefaultRuntime(event.target.value))}><option value="" disabled>未设置</option>{snapshot.runtimes.map(runtime => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></div></section>
    <section id="environments" className="settings-section"><div className="section-heading"><div><h2>环境</h2><p>生产数据只允许注销，绝不由管理器删除</p></div><button className="button outline small" onClick={() => onModal('environment')}><Plus size={15} />创建环境</button></div><div className="management-list">{snapshot.environments.map(environment => { const references = snapshot.instances.filter(instance => instance.environmentId === environment.id).length; return <div className="management-row" key={environment.id}><span className="environment-icon"><Database size={16} /></span><span className="grow"><strong>{environment.name}</strong><small>{shortPath(environment.path)} · {references} 个实例引用</small></span><IconButton label="创建完整备份" disabled={busy !== null} onClick={() => void onRun(`backup:${environment.id}`, () => window.manager.createEnvironmentBackup(environment.id))}><Archive size={16} /></IconButton><IconButton danger label={environment.kind === 'production' ? '注销环境' : '删除环境'} disabled={references > 0} onClick={() => onConfirm({ title: environment.kind === 'production' ? '注销生产环境' : '删除环境', detail: environment.kind === 'production' ? '只移除管理器记录，不会删除磁盘上的 DSH_HOME。' : '删除管理器记录以及受管环境目录。此操作不会删除备份。', actionLabel: environment.kind === 'production' ? '注销' : '删除', action: () => window.manager.deleteEnvironment(environment.id, true) })}><Trash2 size={16} /></IconButton></div> })}</div></section>
    <section id="backups" className="settings-section"><h2>备份</h2>{!snapshot.backups.length ? <p className="empty-inline">暂无完整环境备份</p> : <div className="management-list">{snapshot.backups.slice().reverse().map(backup => <div className="management-row" key={backup.id}><span className="environment-icon"><Archive size={16} /></span><span className="grow"><strong>{snapshot.environments.find(environment => environment.id === backup.environmentId)?.name ?? '历史环境'}</strong><small>{new Date(backup.createdAt).toLocaleString('zh-CN')} · 已生成 SHA-256 清单</small></span><span className="availability">{backup.status === 'ready' ? '可用' : '失败'}</span></div>)}</div>}</section>
  </div></div></div>
}

function InstancePage({ instance, snapshot, busy, obscured, onRun, onLog, onError, onDelete, onSaveTemplate }: { instance: InstanceRecord; snapshot: ManagerSnapshot; busy: string | null; obscured: boolean; onRun: Runner; onLog: (instance: InstanceRecord) => Promise<void>; onError: (error: string | null) => void; onDelete: () => void; onSaveTemplate: () => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null); const externalOpened = useRef(''); const runtime = snapshot.runtimes.find(item => item.id === instance.runtimeId); const environment = snapshot.environments.find(item => item.id === instance.environmentId)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || instance.status !== 'running' || obscured || snapshot.settings.openMode === 'external') {
      void window.manager.hideInstanceView()
      if (instance.status === 'running' && snapshot.settings.openMode === 'external') { const key = `${instance.id}:${instance.port}`; if (externalOpened.current !== key) { externalOpened.current = key; void window.manager.openExternal(instance.id).catch(reason => onError(errorText(reason))) } }
      return
    }
    const update = (): void => { const rect = element.getBoundingClientRect(); void window.manager.showInstanceView(instance.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(reason => onError(errorText(reason))) }
    update(); const observer = new ResizeObserver(update); observer.observe(element); window.addEventListener('resize', update); return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.manager.hideInstanceView() }
  }, [instance.id, instance.status, instance.port, obscured, snapshot.settings.openMode, onError])
  const active = ['starting', 'running', 'stopping'].includes(instance.status); const recovery = Boolean(instance.interrupted || instance.portModeReviewRequired); const recover = (automaticPort: boolean): void => { void onRun(`recover:${instance.id}`, () => window.manager.recoverInstance(instance.id, automaticPort)) }
  return <div className="instance-page"><header className="instance-toolbar"><div className="instance-title"><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{runtime?.name} · {environment?.name} · {instance.port ? `127.0.0.1:${instance.port}` : '自动端口'}</small></span></div><div className="toolbar-actions"><IconButton label="查看日志" onClick={() => void onLog(instance)}><FileText size={17} /></IconButton><IconButton label="保存为模板" onClick={onSaveTemplate}><Copy size={17} /></IconButton><IconButton danger label="删除实例" disabled={active} onClick={onDelete}><Trash2 size={17} /></IconButton>{!recovery && <><IconButton label="在浏览器中打开" disabled={instance.status !== 'running'} onClick={() => void window.manager.openExternal(instance.id)}><ExternalLink size={17} /></IconButton><IconButton label="重新启动" disabled={instance.status !== 'running' || busy !== null} onClick={() => void onRun(`restart:${instance.id}`, () => window.manager.restartInstance(instance.id))}><RotateCw size={17} /></IconButton>{active ? <button className="button outline danger" onClick={() => void onRun(`stop:${instance.id}`, () => window.manager.stopInstance(instance.id, instance.status === 'stopping'))}><CircleStop size={16} />{instance.status === 'stopping' ? '强制停止' : '停止'}</button> : <button className="button primary" onClick={() => void onRun(`start:${instance.id}`, () => window.manager.startInstance(instance.id))}><Play size={16} />启动</button>}</>}</div></header><div className={`web-host ${instance.status !== 'running' || snapshot.settings.openMode === 'external' ? 'inactive' : ''}`} ref={host}>{(instance.status !== 'running' || snapshot.settings.openMode === 'external') && <div><TerminalSquare size={28} /><strong>{snapshot.settings.openMode === 'external' && instance.status === 'running' ? '已在浏览器打开' : instanceStatusLabel(instance)}</strong><span>{instance.lastError ?? (snapshot.settings.openMode === 'external' ? '可以使用右上角浏览器按钮再次打开。' : '启动实例后将在这里打开 DSH 界面。')}</span>{recovery && <div className="recovery-actions"><button className="button primary" disabled={busy !== null} onClick={() => recover(true)}>确认已停止，使用自动端口</button><button className="button outline" disabled={busy !== null || instance.port <= 0} onClick={() => recover(false)}>确认已停止，保留端口 {instance.port || ''}</button></div>}</div>}</div></div>
}

function TemplateNameDialog({ title, initialName, submitLabel, onClose, onSubmit, onDone, setError }: { title: string; initialName: string; submitLabel: string; onClose: () => void; onSubmit: (name: string) => Promise<unknown>; onDone: () => void; setError: (value: string | null) => void }): ReactNode {
  const [name, setName] = useState(initialName); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await onSubmit(name); onDone() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title={title} onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? '正在保存…' : submitLabel}</button></footer></form></Dialog>
}
function RuntimeDialog({ onClose, onCreated, setError }: { onClose: () => void; onCreated: () => Promise<void>; setError: (value: string | null) => void }): ReactNode {
  const [name, setName] = useState('本地 DSH'); const [path, setPath] = useState(''); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.registerRuntime({ name, path }); await onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="注册运行时" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><DirectoryField label="运行时目录" value={path} onChange={setPath} /><p className="form-note">运行版本与实例工作区相互独立。预检受阻的记录也会保留，便于执行安装或构建任务。</p><footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? '正在检查…' : '注册'}</button></footer></form></Dialog>
}
function WorktreeDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const sources = snapshot.runtimes.filter(runtime => runtime.source === 'local' && !runtime.immutable); const [sourceRuntimeId, setSourceRuntimeId] = useState(sources[0]?.id ?? ''); const [name, setName] = useState('候选工作树'); const [ref, setRef] = useState('HEAD'); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.createWorktree({ sourceRuntimeId, name, ref }); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="创建 Git 工作树" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>来源运行时</span><select value={sourceRuntimeId} onChange={event => setSourceRuntimeId(event.target.value)} required>{sources.map(runtime => <option value={runtime.id} key={runtime.id}>{runtime.name}</option>)}</select></label><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><label className="field"><span>Git ref</span><input value={ref} onChange={event => setRef(event.target.value)} required /><small>例如 HEAD、分支名、tag 或 commit。目标目录由管理器分配。</small></label><p className="form-note">新工作树会自动注册为本地运行时，并保持启动受阻，直到完成依赖安装和完整构建。</p><footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || !sourceRuntimeId}>{submitting ? '正在创建…' : '创建工作树'}</button></footer></form></Dialog>
}
function EnvironmentDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const [mode, setMode] = useState<'isolated' | 'clone' | 'production'>('isolated'); const [name, setName] = useState('开发环境'); const [path, setPath] = useState(''); const [source, setSource] = useState(snapshot.environments[0]?.id ?? ''); const [runtime, setRuntime] = useState(snapshot.settings.defaultRuntimeId ?? snapshot.runtimes[0]?.id ?? ''); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { if (mode === 'clone') await window.manager.cloneEnvironment({ name, sourceEnvironmentId: source, targetRuntimeId: runtime }); else await window.manager.createEnvironment({ name, kind: mode, ...(mode === 'production' ? { path } : {}) }); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="创建环境" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><div className="segmented">{([{ id: 'isolated', label: '新环境' }, { id: 'clone', label: '克隆' }, { id: 'production', label: '现有环境' }] as const).map(item => <button type="button" className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)} key={item.id}>{item.label}</button>)}</div><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label>{mode === 'production' && <DirectoryField label="现有 DSH_HOME" value={path} onChange={setPath} />}{mode === 'clone' && <><label className="field"><span>来源环境</span><select value={source} onChange={event => setSource(event.target.value)} required>{snapshot.environments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>目标运行时</span><select value={runtime} onChange={event => setRuntime(event.target.value)} required>{snapshot.runtimes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="form-note">来源实例会在复制期间停止，完成后立即恢复；副本随后独立演化。</p></>}<footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || (mode === 'clone' && (!source || !runtime))}>{submitting ? '正在创建…' : '创建'}</button></footer></form></Dialog>
}
function InstanceDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const defaultRuntime = snapshot.runtimes.find(item => item.id === snapshot.settings.defaultRuntimeId) ?? snapshot.runtimes[0]; const [name, setName] = useState('开发实例'); const [runtime, setRuntime] = useState(defaultRuntime?.id ?? ''); const selectedRuntime = useMemo(() => snapshot.runtimes.find(item => item.id === runtime), [runtime, snapshot.runtimes]); const [environment, setEnvironment] = useState(snapshot.environments[0]?.id ?? ''); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.createInstance({ name, runtimeId: runtime, environmentId: environment }); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="新建实例" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><label className="field"><span>运行时</span><select value={runtime} onChange={event => setRuntime(event.target.value)} required>{snapshot.runtimes.map(item => <option key={item.id} value={item.id}>{item.name}{item.preflight.ready && !item.taskBlocked ? '' : '（受阻）'}</option>)}</select></label><label className="field"><span>环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)} required><option value="" disabled>选择环境</option>{snapshot.environments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="form-note">工作区在 DSH 新建会话时选择；端口由系统自动分配。</p>{selectedRuntime && (!selectedRuntime.preflight.ready || selectedRuntime.taskBlocked) && <p className="validation-note">该运行时暂时无法启动，请先在运行时页完成预检或构建任务。</p>}<footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || !environment}>{submitting ? '正在保存…' : '创建'}</button></footer></form></Dialog>
}
function PromotionDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const candidates = snapshot.instances.filter(instance => instance.status === 'running' && instance.health?.ok && snapshot.environments.find(environment => environment.id === instance.environmentId)?.kind !== 'production'); const production = snapshot.instances.filter(instance => snapshot.environments.find(environment => environment.id === instance.environmentId)?.kind === 'production'); const boundProductionId = production.some(item => item.id === snapshot.settings.productionInstanceId) ? snapshot.settings.productionInstanceId : undefined; const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? ''); const [productionId, setProductionId] = useState(boundProductionId ?? production[0]?.id ?? ''); const [confirmed, setConfirmed] = useState(false); const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.preparePromotion(candidateId, productionId, confirmed); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="提升到生产" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>候选实例</span><select value={candidateId} onChange={event => setCandidateId(event.target.value)} required><option value="" disabled>选择健康的隔离实例</option>{candidates.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="field"><span>生产实例</span><select value={productionId} disabled={Boolean(boundProductionId)} onChange={event => setProductionId(event.target.value)} required><option value="" disabled>选择生产实例</option>{production.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="check-field"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>已在候选实例完成一次实际测试对话</span></label><p className="form-note">管理器将停止生产实例，创建完整环境备份，以候选运行版本启动生产；确认生产正常前不会改变默认版本。</p><footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || !candidateId || !productionId || !confirmed}>{submitting ? '正在提升…' : '备份并提升'}</button></footer></form></Dialog>
}
function LogPanel({ log, onClose }: { log: LogState; onClose: () => void }): ReactNode { return <aside className="log-panel"><header><div><h2>{log.name}</h2><p>持久化日志{log.truncated ? ' · 仅显示末尾内容' : ''}</p></div><IconButton label="关闭日志" onClick={onClose}><X size={18} /></IconButton></header><p className="log-path" title={log.path}>{shortPath(log.path)}</p><pre>{log.content || '暂无日志输出'}</pre></aside> }
function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action: ReactNode }): ReactNode { return <div className="empty-state"><span>{icon}</span><div><strong>{title}</strong><p>{detail}</p></div>{action}</div> }
