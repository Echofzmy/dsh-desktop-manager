import {
  Activity,
  Boxes,
  CircleStop,
  Copy,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  LayoutDashboard,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Sparkles,
  TerminalSquare,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { EnvironmentRecord, InstanceRecord, ManagerSnapshot, RuntimeRecord } from '../../shared/types'

const EMPTY: ManagerSnapshot = { runtimes: [], environments: [], instances: [] }
type Page = { kind: 'home' } | { kind: 'settings' } | { kind: 'instance'; id: string }
type Modal = 'runtime' | 'environment' | 'instance' | null

const STATUS_LABEL: Record<InstanceRecord['status'], string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '失败',
}
const CHECK_LABEL: Record<string, string> = {
  directory: '运行时目录',
  manifest: 'DSH 清单',
  node: 'Node.js',
  pnpm: 'pnpm',
  dependencies: '依赖',
  build: '启动程序',
  'web-build': 'Web 界面',
  git: 'Git 版本',
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/u)?.[0]
  return home ? path.replace(home, '~') : path
}

function instanceStatusLabel(instance: InstanceRecord): string {
  return instance.interrupted || instance.portModeReviewRequired ? '需要确认' : STATUS_LABEL[instance.status]
}

function StatusDot({ status }: { status: InstanceRecord['status'] }): ReactNode {
  return <span className={`status-dot status-${status}`} aria-label={STATUS_LABEL[status]} />
}

function IconButton({ label, children, onClick, disabled = false }: {
  label: string
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}): ReactNode {
  return <button className="icon-button" type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }): ReactNode {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      {children}
    </section>
  </div>
}

function DirectoryField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactNode {
  const choose = async (): Promise<void> => {
    const selected = await window.manager.chooseDirectory()
    if (selected) onChange(selected)
  }
  return <label className="field">
    <span>{label}</span>
    <span className="field-with-action"><input value={value} onChange={event => onChange(event.target.value)} required /><IconButton label={`选择${label}`} onClick={() => void choose()}><FolderOpen size={17} /></IconButton></span>
  </label>
}

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState(EMPTY)
  const [page, setPage] = useState<Page>({ kind: 'home' })
  const [modal, setModal] = useState<Modal>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<{ name: string; path: string; content: string; truncated: boolean } | null>(null)

  useEffect(() => {
    void window.manager.getSnapshot().then(setSnapshot).catch(reason => setError(errorText(reason)))
    return window.manager.onSnapshotChanged(setSnapshot)
  }, [])

  const selectedInstance = page.kind === 'instance' ? snapshot.instances.find(instance => instance.id === page.id) : undefined
  const navigate = (next: Page): void => {
    if (next.kind !== 'instance') void window.manager.hideInstanceView()
    setPage(next)
  }
  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await action()
      setSnapshot(await window.manager.getSnapshot())
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(null)
    }
  }
  const showLog = async (instance: InstanceRecord): Promise<void> => {
    await run(`log:${instance.id}`, async () => {
      const result = await window.manager.readInstanceLog(instance.id)
      setLog({ name: instance.name, ...result })
    })
  }

  return <div className={`app-shell ${log ? 'with-details' : ''}`}>
    <aside className="sidebar">
      <div className="drag-region" />
      <div className="brand-row"><span className="brand-mark"><Sparkles size={18} /></span><span><strong>DeepSeek</strong><small>DSH 管理器</small></span></div>
      <button className="new-instance" onClick={() => setModal('instance')} disabled={!snapshot.runtimes.length}><Plus size={17} />新建实例</button>
      <nav className="sidebar-nav" aria-label="主导航">
        <button className={page.kind === 'home' ? 'active' : ''} onClick={() => navigate({ kind: 'home' })}><LayoutDashboard size={17} />概览</button>
        <button className={page.kind === 'settings' ? 'active' : ''} onClick={() => navigate({ kind: 'settings' })}><Boxes size={17} />运行时</button>
      </nav>
      <div className="sidebar-section">
        <div className="sidebar-section-title"><span>实例</span><span>{snapshot.instances.length}</span></div>
        <div className="sidebar-instances">
          {snapshot.instances.length === 0 && <p>暂无实例</p>}
          {snapshot.instances.map(instance => <button key={instance.id} className={page.kind === 'instance' && page.id === instance.id ? 'active' : ''} onClick={() => navigate({ kind: 'instance', id: instance.id })}><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{instanceStatusLabel(instance)}</small></span></button>)}
        </div>
      </div>
      <button className="sidebar-settings" onClick={() => navigate({ kind: 'settings' })}><Settings size={17} /><span>设置</span></button>
    </aside>

    <section className="workspace-shell">
      {error && <div className="error-banner"><span>{error}</span><IconButton label="关闭提示" onClick={() => setError(null)}><X size={16} /></IconButton></div>}
      <main className="main-content">
        {page.kind === 'home' && <HomePage snapshot={snapshot} busy={busy} onModal={setModal} onOpen={id => navigate({ kind: 'instance', id })} onRun={run} onLog={showLog} />}
        {page.kind === 'settings' && <SettingsPage snapshot={snapshot} busy={busy} onModal={setModal} onRun={run} />}
        {page.kind === 'instance' && selectedInstance && <InstancePage instance={selectedInstance} snapshot={snapshot} busy={busy} obscured={modal !== null} onRun={run} onLog={showLog} onError={setError} />}
      </main>
    </section>

    {modal === 'runtime' && <RuntimeDialog onClose={() => setModal(null)} onCreated={() => run('runtime:create', async () => { setModal(null) })} setError={setError} />}
    {modal === 'environment' && <EnvironmentDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {modal === 'instance' && <InstanceDialog snapshot={snapshot} onClose={() => setModal(null)} onCreated={() => { setModal(null); void window.manager.getSnapshot().then(setSnapshot) }} setError={setError} />}
    {log && <LogPanel log={log} onClose={() => setLog(null)} />}
  </div>
}

function HomePage({ snapshot, busy, onModal, onOpen, onRun, onLog }: {
  snapshot: ManagerSnapshot
  busy: string | null
  onModal: (modal: Modal) => void
  onOpen: (id: string) => void
  onRun: (key: string, action: () => Promise<unknown>) => Promise<void>
  onLog: (instance: InstanceRecord) => Promise<void>
}): ReactNode {
  const running = snapshot.instances.filter(instance => instance.status === 'running').length
  return <div className="page">
    <header className="page-heading"><div><h1>概览</h1><p>{running} 个实例正在运行，{snapshot.environments.length} 个环境可用</p></div><button className="button primary" onClick={() => onModal('instance')} disabled={!snapshot.runtimes.length}><Plus size={16} />新建实例</button></header>
    <section className="content-section">
      <div className="section-heading"><div><h2>实例</h2><p>管理本机 DSH 进程与工作区</p></div></div>
      {snapshot.instances.length === 0 ? <EmptyState icon={<TerminalSquare size={22} />} title="暂无实例" detail="先注册运行时并创建独立环境。" action={<button className="button primary" onClick={() => onModal(snapshot.runtimes.length ? 'instance' : 'runtime')}><Plus size={16} />{snapshot.runtimes.length ? '新建实例' : '注册运行时'}</button>} /> : <div className="row-list">{snapshot.instances.map(instance => <InstanceRow key={instance.id} instance={instance} snapshot={snapshot} busy={busy} onOpen={onOpen} onRun={onRun} onLog={onLog} />)}</div>}
    </section>
    <div className="overview-grid">
      <section className="content-section"><div className="section-heading"><div><h2>运行时</h2><p>本地 DSH 版本与预检状态</p></div><IconButton label="注册运行时" onClick={() => onModal('runtime')}><Plus size={17} /></IconButton></div><RuntimeRows runtimes={snapshot.runtimes} busy={busy} onRun={onRun} /></section>
      <section className="content-section"><div className="section-heading"><div><h2>环境</h2><p>相互独立的 DSH_HOME</p></div><IconButton label="创建环境" onClick={() => onModal('environment')}><Plus size={17} /></IconButton></div><EnvironmentRows environments={snapshot.environments} snapshot={snapshot} /></section>
    </div>
  </div>
}

function InstanceRow({ instance, snapshot, busy, onOpen, onRun, onLog }: {
  instance: InstanceRecord
  snapshot: ManagerSnapshot
  busy: string | null
  onOpen: (id: string) => void
  onRun: (key: string, action: () => Promise<unknown>) => Promise<void>
  onLog: (instance: InstanceRecord) => Promise<void>
}): ReactNode {
  const runtime = snapshot.runtimes.find(item => item.id === instance.runtimeId)
  const environment = snapshot.environments.find(item => item.id === instance.environmentId)
  const working = busy?.endsWith(instance.id) === true
  const active = ['starting', 'running', 'stopping'].includes(instance.status)
  const needsRecovery = instance.interrupted || instance.portModeReviewRequired
  return <article className="instance-row">
    <button className="instance-main" onClick={() => onOpen(instance.id)}><span className="instance-identity"><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{runtime?.name ?? '运行时缺失'} · {environment?.name ?? '环境缺失'}</small></span></span><span className="instance-meta"><span>{instance.port ? `${instance.automaticPort ? '自动 · ' : ''}:${instance.port}` : '自动端口'}</span><span title={instance.workspacePath}>{shortPath(instance.workspacePath)}</span></span></button>
    <div className="row-actions">{needsRecovery ? <button className="button outline small" onClick={() => onOpen(instance.id)}>确认恢复</button> : active ? <IconButton label={instance.status === 'stopping' ? '强制停止' : '停止'} disabled={working} onClick={() => void onRun(`stop:${instance.id}`, () => window.manager.stopInstance(instance.id, instance.status === 'stopping'))}><CircleStop size={17} /></IconButton> : <IconButton label="启动" disabled={working} onClick={() => void onRun(`start:${instance.id}`, () => window.manager.startInstance(instance.id))}><Play size={17} /></IconButton>}<IconButton label="重新启动" disabled={working || instance.status !== 'running' || Boolean(needsRecovery)} onClick={() => void onRun(`restart:${instance.id}`, () => window.manager.restartInstance(instance.id))}><RotateCw size={17} /></IconButton><IconButton label="查看日志" onClick={() => void onLog(instance)}><FileText size={17} /></IconButton></div>
  </article>
}

function RuntimeRows({ runtimes, busy, onRun }: { runtimes: RuntimeRecord[]; busy: string | null; onRun: (key: string, action: () => Promise<unknown>) => Promise<void> }): ReactNode {
  if (!runtimes.length) return <p className="empty-inline">暂无已注册的运行时</p>
  return <div className="compact-list">{runtimes.map(runtime => <div className="compact-row" key={runtime.id}><span className={`check-mark ${runtime.preflight.ready ? 'pass' : 'failure'}`}><Gauge size={16} /></span><span className="grow"><strong>{runtime.name}</strong><small>{runtime.preflight.packageVersion ?? '版本未知'} · {runtime.preflight.ready ? '预检通过' : `${runtime.preflight.checks.filter(check => check.level === 'failure').length} 项受阻`}</small></span><IconButton label="重新预检" disabled={busy === `refresh:${runtime.id}`} onClick={() => void onRun(`refresh:${runtime.id}`, () => window.manager.refreshRuntime(runtime.id))}><RefreshCw size={16} /></IconButton></div>)}</div>
}

function EnvironmentRows({ environments, snapshot }: { environments: EnvironmentRecord[]; snapshot: ManagerSnapshot }): ReactNode {
  if (!environments.length) return <p className="empty-inline">暂无环境</p>
  return <div className="compact-list">{environments.map(environment => {
    const occupant = snapshot.instances.find(instance => instance.environmentId === environment.id && instance.status === 'running')
    return <div className="compact-row" key={environment.id}><span className="environment-icon"><Database size={16} /></span><span className="grow"><strong>{environment.name}</strong><small>{environment.kind === 'production' ? '生产环境' : environment.kind === 'clone' ? '克隆环境' : '独立环境'}{environment.lineage ? ' · 已记录来源' : ''}</small></span><span className={`availability ${occupant ? 'occupied' : ''}`}>{occupant ? occupant.name : '可用'}</span></div>
  })}</div>
}

function SettingsPage({ snapshot, busy, onModal, onRun }: { snapshot: ManagerSnapshot; busy: string | null; onModal: (modal: Modal) => void; onRun: (key: string, action: () => Promise<unknown>) => Promise<void> }): ReactNode {
  return <div className="page narrow-page"><header className="page-heading"><div><h1>运行时</h1><p>注册本地源码目录或已发布的 DSH 包</p></div><button className="button primary" onClick={() => onModal('runtime')}><Plus size={16} />注册运行时</button></header>
    <section className="content-section">{snapshot.runtimes.length === 0 ? <EmptyState icon={<Boxes size={22} />} title="暂无运行时" detail="注册一个 DSH 目录后，管理器会检查工具链与构建产物。" action={<button className="button primary" onClick={() => onModal('runtime')}><Plus size={16} />注册运行时</button>} /> : <div className="runtime-list">{snapshot.runtimes.map(runtime => <article className="runtime-detail" key={runtime.id}><header><div><h3>{runtime.name}</h3><p>{shortPath(runtime.path)}</p></div><span className={`preflight-badge ${runtime.preflight.ready ? 'ready' : 'blocked'}`}>{runtime.preflight.ready ? '预检通过' : '预检受阻'}</span></header><div className="checks">{runtime.preflight.checks.map(check => <div className="check-row" key={check.id}><span className={`check-dot ${check.level}`} /><span><strong>{CHECK_LABEL[check.id] ?? check.label}</strong><small>{check.detail}</small>{check.remediation && <em>{check.remediation}</em>}</span></div>)}</div><footer><span>检查于 {new Date(runtime.preflight.checkedAt).toLocaleString('zh-CN')}</span><button className="button outline small" disabled={busy === `refresh:${runtime.id}`} onClick={() => void onRun(`refresh:${runtime.id}`, () => window.manager.refreshRuntime(runtime.id))}><RefreshCw size={15} />重新预检</button></footer></article>)}</div>}</section>
  </div>
}

function InstancePage({ instance, snapshot, busy, obscured, onRun, onLog, onError }: { instance: InstanceRecord; snapshot: ManagerSnapshot; busy: string | null; obscured: boolean; onRun: (key: string, action: () => Promise<unknown>) => Promise<void>; onLog: (instance: InstanceRecord) => Promise<void>; onError: (error: string | null) => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const runtime = snapshot.runtimes.find(item => item.id === instance.runtimeId)
  const environment = snapshot.environments.find(item => item.id === instance.environmentId)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || instance.status !== 'running' || obscured) { void window.manager.hideInstanceView(); return }
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      void window.manager.showInstanceView(instance.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(reason => onError(errorText(reason)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.manager.hideInstanceView() }
  }, [instance.id, instance.status, instance.port, obscured, onError])
  const active = ['starting', 'running', 'stopping'].includes(instance.status)
  const needsRecovery = Boolean(instance.interrupted || instance.portModeReviewRequired)
  const recover = (automaticPort: boolean): void => {
    void onRun(`recover:${instance.id}`, () => window.manager.recoverInstance(instance.id, automaticPort))
  }

  return <div className="instance-page">
    <header className="instance-toolbar">
      <div className="instance-title"><StatusDot status={instance.status} /><span><strong>{instance.name}</strong><small>{runtime?.name} · {environment?.name} · {instance.port ? `127.0.0.1:${instance.port}` : '自动端口'}</small></span></div>
      <span className="workspace-label" title={instance.workspacePath}>{shortPath(instance.workspacePath)}</span>
      <div className="toolbar-actions">
        <IconButton label="查看日志" onClick={() => void onLog(instance)}><FileText size={17} /></IconButton>
        {!needsRecovery && <><IconButton label="在浏览器中打开" disabled={instance.status !== 'running'} onClick={() => void window.manager.openExternal(instance.id)}><ExternalLink size={17} /></IconButton><IconButton label="重新启动" disabled={instance.status !== 'running' || busy !== null} onClick={() => void onRun(`restart:${instance.id}`, () => window.manager.restartInstance(instance.id))}><RotateCw size={17} /></IconButton>{active ? <button className="button outline danger" onClick={() => void onRun(`stop:${instance.id}`, () => window.manager.stopInstance(instance.id, instance.status === 'stopping'))}><CircleStop size={16} />{instance.status === 'stopping' ? '强制停止' : '停止'}</button> : <button className="button primary" onClick={() => void onRun(`start:${instance.id}`, () => window.manager.startInstance(instance.id))}><Play size={16} />启动</button>}</>}
      </div>
    </header>
    <div className={`web-host ${instance.status !== 'running' ? 'inactive' : ''}`} ref={host}>
      {instance.status !== 'running' && <div><TerminalSquare size={28} /><strong>{instanceStatusLabel(instance)}</strong><span>{instance.lastError ?? '启动实例后将在这里打开 DSH 界面。'}</span>{needsRecovery && <div className="recovery-actions"><button className="button primary" disabled={busy !== null} onClick={() => recover(true)}>确认已停止，使用自动端口</button><button className="button outline" disabled={busy !== null || instance.port <= 0} onClick={() => recover(false)}>确认已停止，保留端口 {instance.port || ''}</button></div>}</div>}
    </div>
  </div>
}

function RuntimeDialog({ onClose, onCreated, setError }: { onClose: () => void; onCreated: () => Promise<void>; setError: (value: string | null) => void }): ReactNode {
  const [name, setName] = useState('dsh-v1')
  const [path, setPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.registerRuntime({ name, path }); await onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="注册运行时" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><DirectoryField label="运行时目录" value={path} onChange={setPath} /><p className="form-note">即使预检受阻也会保留记录，便于查看缺失的依赖或构建产物。</p><footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? '正在检查…' : '注册'}</button></footer></form></Dialog>
}

function EnvironmentDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const [mode, setMode] = useState<'isolated' | 'clone' | 'production'>('isolated')
  const [name, setName] = useState('开发环境')
  const [path, setPath] = useState('')
  const [source, setSource] = useState(snapshot.environments[0]?.id ?? '')
  const [runtime, setRuntime] = useState(snapshot.runtimes[0]?.id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { if (mode === 'clone') await window.manager.cloneEnvironment({ name, sourceEnvironmentId: source, targetRuntimeId: runtime }); else await window.manager.createEnvironment({ name, kind: mode, ...(mode === 'production' ? { path } : {}) }); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  const modes = [{ id: 'isolated', label: '新环境' }, { id: 'clone', label: '克隆' }, { id: 'production', label: '现有环境' }] as const
  return <Dialog title="创建环境" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><div className="segmented">{modes.map(item => <button type="button" className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)} key={item.id}>{item.label}</button>)}</div><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label>{mode === 'production' && <DirectoryField label="现有 DSH_HOME" value={path} onChange={setPath} />}{mode === 'clone' && <><label className="field"><span>来源环境</span><select value={source} onChange={event => setSource(event.target.value)} required>{snapshot.environments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>目标运行时</span><select value={runtime} onChange={event => setRuntime(event.target.value)} required>{snapshot.runtimes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="form-note">若来源实例正在运行，管理器会先停止实例，完成克隆后立即重新启动。副本随后独立演化。</p></>}<footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || (mode === 'clone' && (!source || !runtime))}>{submitting ? '正在创建…' : '创建'}</button></footer></form></Dialog>
}

function InstanceDialog({ snapshot, onClose, onCreated, setError }: { snapshot: ManagerSnapshot; onClose: () => void; onCreated: () => void; setError: (value: string | null) => void }): ReactNode {
  const [name, setName] = useState('开发实例')
  const [runtime, setRuntime] = useState(snapshot.runtimes[0]?.id ?? '')
  const selectedRuntime = useMemo(() => snapshot.runtimes.find(item => item.id === runtime), [runtime, snapshot.runtimes])
  const [environment, setEnvironment] = useState(snapshot.environments[0]?.id ?? '')
  const [workspace, setWorkspace] = useState(selectedRuntime?.path ?? '')
  const [port, setPort] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => { if (selectedRuntime && !workspace) setWorkspace(selectedRuntime.path) }, [selectedRuntime, workspace])
  const submit = async (event: FormEvent): Promise<void> => { event.preventDefault(); setSubmitting(true); setError(null); try { await window.manager.createInstance({ name, runtimeId: runtime, environmentId: environment, workspacePath: workspace, port: Number(port) }); onCreated() } catch (error) { setError(errorText(error)) } finally { setSubmitting(false) } }
  return <Dialog title="新建实例" onClose={onClose}><form className="form" onSubmit={event => void submit(event)}><label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} required /></label><label className="field"><span>运行时</span><select value={runtime} onChange={event => { setRuntime(event.target.value); const item = snapshot.runtimes.find(candidate => candidate.id === event.target.value); if (item) setWorkspace(item.path) }} required>{snapshot.runtimes.map(item => <option key={item.id} value={item.id}>{item.name}{item.preflight.ready ? '' : '（受阻）'}</option>)}</select></label><DirectoryField label="工作区" value={workspace} onChange={setWorkspace} /><label className="field"><span>环境</span><select value={environment} onChange={event => setEnvironment(event.target.value)} required><option value="" disabled>选择环境</option>{snapshot.environments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>端口</span><input type="number" min="0" max="65535" value={port} onChange={event => setPort(event.target.value)} /><small>填写 0，由系统自动分配可用端口。</small></label>{selectedRuntime && !selectedRuntime.preflight.ready && <p className="validation-note">该运行时有 {selectedRuntime.preflight.checks.filter(check => check.level === 'failure').length} 项预检受阻。实例可以保存，但暂时无法启动。</p>}<footer><button className="button outline" type="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting || !environment}>{submitting ? '正在保存…' : '创建'}</button></footer></form></Dialog>
}

function LogPanel({ log, onClose }: { log: { name: string; path: string; content: string; truncated: boolean }; onClose: () => void }): ReactNode {
  return <aside className="log-panel"><header><div><h2>{log.name}</h2><p>运行日志{log.truncated ? ' · 仅显示最后 256 KiB' : ''}</p></div><IconButton label="关闭日志" onClick={onClose}><X size={18} /></IconButton></header><p className="log-path" title={log.path}>{shortPath(log.path)}</p><pre>{log.content || '暂无日志输出'}</pre></aside>
}

function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action: ReactNode }): ReactNode {
  return <div className="empty-state"><span>{icon}</span><div><strong>{title}</strong><p>{detail}</p></div>{action}</div>
}
