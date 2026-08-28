// @vitest-environment jsdom
/**
 * FilesBrowser: the lazily cached Workspace file tree. Root loads on mount,
 * directories load on first expansion only (collapse/reopen reuse the cache),
 * refresh clears the cache and reloads the root, hidden entries hide by
 * default, file clicks dispatch the injected openFile with the absolute
 * path — failures surface inline. Rows activate on click, Enter, or Space;
 * a scan that settles after its controller was aborted (workspace switch,
 * refresh, unmount) is ignored, and a re-activated directory reuses an
 * in-flight scan instead of duplicating the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  WorkspaceDirectoryListing, WorkspaceFileEntry, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { FilesBrowser } from '../src/client/files/FilesBrowser.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
const workspace = (id: string): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title: id,
  sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const entry = (name: string, kind: 'file' | 'directory', parent = ''): WorkspaceFileEntry => ({
  name,
  relativePath: parent === '' ? name : `${parent}/${name}`,
  path: `/ws/${parent === '' ? name : `${parent}/${name}`}`,
  kind,
  hidden: name.startsWith('.'),
})
const listing = (relativePath: string, entries: WorkspaceFileEntry[], truncated = false): WorkspaceDirectoryListing => ({
  relativePath,
  entries,
  truncated,
})

/** Root level: a directory, a file, and a hidden dotfile. */
const ROOT = listing('', [entry('src', 'directory'), entry('README.md', 'file'), entry('.env', 'file')])
const SRC = listing('src', [entry('lib', 'directory', 'src'), entry('index.ts', 'file', 'src')])

function mount(overrides: Partial<Parameters<typeof FilesBrowser>[0]> = {}) {
  const browse = vi.fn(async (_workspaceId: WorkspaceId, relativePath?: string): Promise<WorkspaceDirectoryListing> => {
    return relativePath === 'src' ? SRC : ROOT
  })
  const openFile = vi.fn(async () => {})
  const props = {
    workspace: workspace('alpha'),
    browse,
    openFile,
    showHidden: false,
    refreshKey: 0,
    t,
    ...overrides,
  }
  const view = render(<FilesBrowser {...props} />)
  return { view, props }
}

/** Re-render with changed props. */
function rerender(m: ReturnType<typeof mount>, overrides: Partial<Parameters<typeof FilesBrowser>[0]>): void {
  Object.assign(m.props, overrides)
  m.view.rerender(<FilesBrowser {...m.props} />)
}

describe('FilesBrowser', () => {
  it('loads the root on mount and renders directories first', async () => {
    const m = mount()
    expect(m.props.browse).toHaveBeenCalledWith(wid('alpha'), undefined, expect.any(AbortSignal))
    expect(screen.getByText('正在加载文件…')).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    const rows = screen.getAllByRole('treeitem')
    expect(rows.map(row => row.textContent)).toEqual(['src', 'README.md'])
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('false')
    // Hidden entries stay hidden by default.
    expect(screen.queryByText('.env')).toBeNull()
  })

  it('reveals hidden entries when showHidden turns on', async () => {
    const m = mount()
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    expect(screen.queryByText('.env')).toBeNull()
    rerender(m, { showHidden: true })
    expect(screen.getByText('.env')).toBeTruthy()
  })

  it('loads a directory on first expansion and reuses the cache on reopen', async () => {
    const m = mount()
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => {
      expect(m.props.browse).toHaveBeenCalledWith(wid('alpha'), 'src', expect.any(AbortSignal))
      expect(screen.getByText('index.ts')).toBeTruthy()
      expect(screen.getByText('lib')).toBeTruthy()
    })
    expect(screen.getByText('src').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')

    // Collapse hides the children; reopen renders from the cache with no new
    // browse call (still exactly the root + one src call).
    fireEvent.click(screen.getByText('src'))
    expect(screen.queryByText('index.ts')).toBeNull()
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.getByText('index.ts')).toBeTruthy() })
    expect(m.props.browse).toHaveBeenCalledTimes(2)
  })

  it('opens a file through the injected callback with its absolute path', async () => {
    const openFile = vi.fn(async () => {})
    mount({ openFile })
    await waitFor(() => { expect(screen.getByText('README.md')).toBeTruthy() })
    fireEvent.click(screen.getByText('README.md'))
    expect(openFile).toHaveBeenCalledWith('/ws/README.md')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a file-open failure inline', async () => {
    const openFile = vi.fn(async () => { throw new Error('no default app') })
    mount({ openFile })
    await waitFor(() => { expect(screen.getByText('README.md')).toBeTruthy() })
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('no default app') })
  })

  it('renders non-Error open failures as text', async () => {
    const openFile = vi.fn(async () => { throw 'denied' })
    mount({ openFile })
    await waitFor(() => { expect(screen.getByText('README.md')).toBeTruthy() })
    fireEvent.click(screen.getByText('README.md'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('shows a root browse failure inline', async () => {
    const browse = vi.fn(async () => { throw new Error('directory unreadable') })
    mount({ browse })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('directory unreadable') })
  })

  it('shows the wire error message for a structured DirectoryBrowseError', async () => {
    const browse = vi.fn(async () => {
      throw new DirectoryBrowseError({
        code: 'directory-unreadable', message: 'cannot browse "/ws/alpha"', details: { path: '/ws/alpha' },
      })
    })
    mount({ browse })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('cannot browse "/ws/alpha"') })
  })

  it('shows a directory-level browse failure under the expanded row', async () => {
    const browse = vi.fn(async (_workspaceId: WorkspaceId, relativePath?: string): Promise<WorkspaceDirectoryListing> => {
      if (relativePath === 'src') throw new Error('cannot browse "src"')
      return ROOT
    })
    mount({ browse })
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('cannot browse "src"') })
  })

  it('shows the empty state for an empty root and the truncated note for a cut listing', async () => {
    const m = mount({
      browse: vi.fn(async () => listing('', [], true)),
    })
    await waitFor(() => { expect(screen.getByText('此文件夹为空')).toBeTruthy() })
    expect(screen.queryByRole('treeitem')).toBeNull()
    rerender(m, {
      browse: vi.fn(async () => listing('', [entry('a.txt', 'file')], true)),
    })
    await waitFor(() => { expect(screen.getByText('a.txt')).toBeTruthy() })
    expect(screen.getByText('条目过多，仅显示开头部分。')).toBeTruthy()
  })

  it('refresh clears the cache and reloads the root', async () => {
    const m = mount()
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => { expect(screen.getByText('index.ts')).toBeTruthy() })
    rerender(m, { refreshKey: 1 })
    await waitFor(() => {
      expect(m.props.browse).toHaveBeenCalledWith(wid('alpha'), undefined, expect.any(AbortSignal))
    })
    // The cache cleared with the refresh: expansion state resets to the root
    // and the children are gone until expanded again.
    expect(screen.queryByText('index.ts')).toBeNull()
    expect(screen.queryByText('src')).toBeTruthy()
  })

  it('reloads the root when the Workspace changes and aborts the superseded scan', async () => {
    const abortSpies: AbortSignal[] = []
    let resolveRoot!: (value: WorkspaceDirectoryListing) => void
    const m = mount({
      browse: vi.fn((_workspaceId: WorkspaceId, _relativePath?: string, signal?: AbortSignal) => {
        abortSpies.push(signal as AbortSignal)
        return new Promise<WorkspaceDirectoryListing>((resolve) => { resolveRoot = resolve })
      }),
    })
    rerender(m, { workspace: workspace('beta') })
    expect(m.props.browse).toHaveBeenCalledWith(wid('beta'), undefined, expect.any(AbortSignal))
    expect(abortSpies[0]?.aborted).toBe(true)
    await act(async () => {
      resolveRoot(ROOT)
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
  })

  it('aborts in-flight level scans on unmount', async () => {
    const signals: AbortSignal[] = []
    const rejects: ((reason: Error) => void)[] = []
    const m = mount({
      browse: vi.fn((_workspaceId: WorkspaceId, relativePath?: string, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        if (relativePath === undefined) return Promise.resolve(ROOT)
        return new Promise<WorkspaceDirectoryListing>((_resolve, reject) => { rejects.push(reject) })
      }),
    })
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    // A child level scan hangs in flight; unmounting aborts it, and its late
    // rejection lands on the aborted controller without a state write.
    fireEvent.click(screen.getByText('src'))
    m.view.unmount()
    expect(signals[1]?.aborted).toBe(true)
    await act(async () => {
      rejects[0]?.(new Error('late child failure'))
      await Promise.resolve()
    })
  })

  it('ignores a scan that rejects after its controller was aborted', async () => {
    const rejects: ((reason: Error) => void)[] = []
    const m = mount({
      browse: vi.fn(() => new Promise<WorkspaceDirectoryListing>((_resolve, reject) => { rejects.push(reject) })),
    })
    // A Workspace switch supersedes the first root scan; its late rejection
    // must not surface an inline error for the new Workspace.
    rerender(m, { workspace: workspace('beta') })
    expect(m.props.browse).toHaveBeenCalledWith(wid('beta'), undefined, expect.any(AbortSignal))
    await act(async () => {
      rejects[0]?.(new Error('late failure'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    // The replacement root load is still in flight.
    expect(screen.getByText('正在加载文件…')).toBeTruthy()
  })

  it('a superseded root scan that resolves late does not replace the new root', async () => {
    const resolvers: ((value: WorkspaceDirectoryListing) => void)[] = []
    const m = mount({
      browse: vi.fn(() => new Promise<WorkspaceDirectoryListing>((resolve) => { resolvers.push(resolve) })),
    })
    // Switch Workspaces while the first root scan is in flight; the second
    // scan owns the root now.
    rerender(m, { workspace: workspace('beta') })
    expect(m.props.browse).toHaveBeenCalledWith(wid('beta'), undefined, expect.any(AbortSignal))
    // The superseded scan resolves late with alpha's stale listing: it must
    // not replace the root the beta scan is about to deliver.
    await act(async () => {
      resolvers[0]?.(listing('', [entry('stale.txt', 'file')]))
      await Promise.resolve()
    })
    expect(screen.queryByText('stale.txt')).toBeNull()
    expect(screen.getByText('正在加载文件…')).toBeTruthy()
    await act(async () => {
      resolvers[1]?.(listing('', [entry('fresh.txt', 'file')]))
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('fresh.txt')).toBeTruthy() })
    expect(screen.queryByText('stale.txt')).toBeNull()
  })

  it('a child scan that resolves after refresh does not cache its stale level', async () => {
    const rootResolvers: ((value: WorkspaceDirectoryListing) => void)[] = []
    const srcResolvers: ((value: WorkspaceDirectoryListing) => void)[] = []
    const m = mount({
      browse: vi.fn((_workspaceId: WorkspaceId, relativePath?: string): Promise<WorkspaceDirectoryListing> => {
        if (relativePath === 'src') return new Promise((resolve) => { srcResolvers.push(resolve) })
        return new Promise((resolve) => { rootResolvers.push(resolve) })
      }),
    })
    await act(async () => {
      rootResolvers[0]?.(ROOT)
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    fireEvent.click(screen.getByText('src')) // child scan in flight
    rerender(m, { refreshKey: 1 }) // clears every level and starts a new root scan
    await act(async () => {
      rootResolvers[1]?.(listing('', [entry('src', 'directory'), entry('fresh.txt', 'file')]))
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('fresh.txt')).toBeTruthy() })
    // The superseded child scan resolves late; its stale level must not be
    // cached, so re-expanding src fetches the level again.
    await act(async () => {
      srcResolvers[0]?.(SRC)
      await Promise.resolve()
    })
    // Calls so far: the first root, the superseded src scan, the refresh root.
    expect(m.props.browse).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByText('src'))
    expect(m.props.browse).toHaveBeenCalledTimes(4)
    expect(m.props.browse).toHaveBeenLastCalledWith(wid('alpha'), 'src', expect.any(AbortSignal))
    await act(async () => {
      srcResolvers[1]?.(SRC)
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('index.ts')).toBeTruthy() })
  })

  it('a directory re-activated while its scan is in flight starts one browse call', async () => {
    let resolveSrc!: (value: WorkspaceDirectoryListing) => void
    const m = mount({
      browse: vi.fn((_workspaceId: WorkspaceId, relativePath?: string): Promise<WorkspaceDirectoryListing> => {
        if (relativePath === 'src') return new Promise((resolve) => { resolveSrc = resolve })
        return Promise.resolve(ROOT)
      }),
    })
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    // Expand, collapse, and re-expand before the first scan settles: the
    // in-flight controller must be reused, not replaced with a second call.
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(screen.getByText('src'))
    expect(m.props.browse).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveSrc(SRC)
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByText('index.ts')).toBeTruthy() })
  })

  it('activates a directory with Enter and Space', async () => {
    const m = mount()
    await waitFor(() => { expect(screen.getByText('src')).toBeTruthy() })
    const row = () => screen.getByText('src').closest('[role="treeitem"]') as HTMLElement
    expect(row().tabIndex).toBe(0)
    // Non-activation keys leave the row alone.
    fireEvent.keyDown(row(), { key: 'ArrowDown' })
    expect(m.props.browse).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(row(), { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('index.ts')).toBeTruthy() })
    expect(m.props.browse).toHaveBeenCalledWith(wid('alpha'), 'src', expect.any(AbortSignal))
    // Space toggles the now-expanded row closed again.
    fireEvent.keyDown(row(), { key: ' ' })
    await waitFor(() => { expect(screen.queryByText('index.ts')).toBeNull() })
    expect(m.props.browse).toHaveBeenCalledTimes(2)
  })

  it('activates a file with Enter and Space', async () => {
    const openFile = vi.fn(async () => {})
    mount({ openFile })
    await waitFor(() => { expect(screen.getByText('README.md')).toBeTruthy() })
    const row = screen.getByText('README.md').closest('[role="treeitem"]') as HTMLElement
    expect(row.tabIndex).toBe(0)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(openFile).toHaveBeenCalledWith('/ws/README.md')
    fireEvent.keyDown(row, { key: ' ' })
    expect(openFile).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
