/**
 * Files-view derivation: workspace resolution and the cached-level row
 * projection. The component owns the cache lifecycle; these specs pin the
 * pure facts (workspace fallback order, hidden filtering, per-level states,
 * depth-first directories-first walk).
 */
import { describe, expect, it } from 'vitest'
import type {
  SessionId, WorkspaceFileEntry, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  FILES_ROOT, projectFilesTree, resolveFilesWorkspace, type FilesLevel,
} from '../src/client/files/tree.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const entry = (
  name: string,
  kind: 'file' | 'directory',
  parent = '',
  hidden = false,
): WorkspaceFileEntry => ({
  name,
  relativePath: parent === '' ? name : `${parent}/${name}`,
  path: `/ws/${parent === '' ? name : `${parent}/${name}`}`,
  kind,
  hidden,
})
const level = (relativePath: string, entries: WorkspaceFileEntry[], truncated = false): FilesLevel => ({
  relativePath,
  entries,
  truncated,
})

describe('resolveFilesWorkspace', () => {
  const workspaces = [workspace('alpha', ['s1']), workspace('beta', ['s2'])]

  it('prefers the Workspace containing the current Session', () => {
    expect(resolveFilesWorkspace(workspaces, sid('s2'), wid('alpha'))).toBe(workspaces[1])
  })

  it('falls back to the recent Workspace when no Session is current or accounted', () => {
    expect(resolveFilesWorkspace(workspaces, undefined, wid('beta'))).toBe(workspaces[1])
    expect(resolveFilesWorkspace(workspaces, sid('loose'), wid('alpha'))).toBe(workspaces[0])
  })

  it('falls back to the first Workspace when the recency projection is stale or absent', () => {
    expect(resolveFilesWorkspace(workspaces, sid('loose'), wid('gone'))).toBe(workspaces[0])
    expect(resolveFilesWorkspace(workspaces, undefined, undefined)).toBe(workspaces[0])
  })

  it('answers undefined with no Workspaces at all', () => {
    expect(resolveFilesWorkspace([], undefined, undefined)).toBeUndefined()
  })
})

describe('projectFilesTree', () => {
  const root = level('', [entry('src', 'directory'), entry('README.md', 'file'), entry('.env', 'file', '', true)])
  const src = level('src', [entry('lib', 'directory', 'src'), entry('index.ts', 'file', 'src')])

  it('reports the first paint as a root load before the root level exists', () => {
    expect(projectFilesTree(new Map(), new Set(), new Set(), new Map(), false))
      .toEqual({ rows: [], rootLoading: true, rootError: undefined })
  })

  it('reports a failed root listing without rows', () => {
    expect(projectFilesTree(new Map(), new Set(), new Set(), new Map([[FILES_ROOT, 'denied']]), false))
      .toEqual({ rows: [], rootLoading: false, rootError: 'denied' })
  })

  it('walks the root directories-first as the server sorts, hiding hidden entries by default', () => {
    const projection = projectFilesTree(new Map([[FILES_ROOT, root]]), new Set(), new Set(), new Map(), false)
    expect(projection.rootLoading).toBe(false)
    expect(projection.rows).toEqual([
      { key: '/ws/src', depth: 0, kind: 'directory', name: 'src', path: '/ws/src', relativePath: 'src', expanded: false },
      { key: '/ws/README.md', depth: 0, kind: 'file', name: 'README.md', path: '/ws/README.md' },
    ])
  })

  it('reveals hidden entries only when showHidden is on', () => {
    const hidden = projectFilesTree(new Map([[FILES_ROOT, root]]), new Set(), new Set(), new Map(), true)
    expect(hidden.rows.map(row => row.kind === 'file' ? row.name : null)).toContain('.env')
  })

  it('renders an empty level as an empty status row', () => {
    const empty = level('', [])
    const projection = projectFilesTree(new Map([[FILES_ROOT, empty]]), new Set(), new Set(), new Map(), false)
    expect(projection.rows).toEqual([
      { key: '::empty', depth: 0, kind: 'status', status: 'empty' },
    ])
  })

  it('recurses into an expanded cached directory at depth + 1', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root], ['src', src]]),
      new Set(['src']),
      new Set(),
      new Map(),
      false,
    )
    expect(projection.rows).toEqual([
      { key: '/ws/src', depth: 0, kind: 'directory', name: 'src', path: '/ws/src', relativePath: 'src', expanded: true },
      { key: '/ws/src/lib', depth: 1, kind: 'directory', name: 'lib', path: '/ws/src/lib', relativePath: 'src/lib', expanded: false },
      { key: '/ws/src/index.ts', depth: 1, kind: 'file', name: 'index.ts', path: '/ws/src/index.ts' },
      { key: '/ws/README.md', depth: 0, kind: 'file', name: 'README.md', path: '/ws/README.md' },
    ])
  })

  it('renders a loading status row under an expanded directory whose level is in flight', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root]]),
      new Set(['src']),
      new Set(['src']),
      new Map(),
      false,
    )
    expect(projection.rows[1]).toEqual({ key: 'src::loading', depth: 1, kind: 'status', status: 'loading' })
  })

  it('renders a failed level as an inline error under the expanded directory', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root]]),
      new Set(['src']),
      new Set(),
      new Map([['src', 'cannot browse']]),
      false,
    )
    expect(projection.rows[1]).toEqual({ key: 'src::error', depth: 1, kind: 'status', status: 'error', message: 'cannot browse' })
  })

  it('treats an expanded directory without a cached level as loading (component invariant backstop)', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root]]),
      new Set(['src']),
      new Set(),
      new Map(),
      false,
    )
    expect(projection.rows[1]).toEqual({ key: 'src::loading', depth: 1, kind: 'status', status: 'loading' })
  })

  it('notes a truncated child level after its children and a truncated root after the walk', () => {
    const truncatedSrc = { ...src, truncated: true }
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root], ['src', truncatedSrc]]),
      new Set(['src']),
      new Set(),
      new Map(),
      false,
    )
    expect(projection.rows.filter(row => row.kind === 'status')).toEqual([
      { key: 'src::truncated', depth: 1, kind: 'status', status: 'truncated' },
    ])

    const truncatedRoot = { ...root, truncated: true }
    const rootProjection = projectFilesTree(
      new Map([[FILES_ROOT, truncatedRoot]]),
      new Set(),
      new Set(),
      new Map(),
      false,
    )
    expect(rootProjection.rows.at(-1)).toEqual({
      key: '::truncated', depth: 0, kind: 'status', status: 'truncated',
    })
  })

  it('keeps a collapsed directory closed without children', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root], ['src', src]]),
      new Set(),
      new Set(),
      new Map(),
      false,
    )
    expect(projection.rows).toHaveLength(2)
    expect(projection.rows[0]?.kind).toBe('directory')
    expect((projection.rows[0] as { expanded: boolean }).expanded).toBe(false)
  })

  it('keeps reporting a cached root while a redundant root load is in flight', () => {
    const projection = projectFilesTree(
      new Map([[FILES_ROOT, root]]),
      new Set(),
      new Set([FILES_ROOT]),
      new Map(),
      false,
    )
    expect(projection.rootLoading).toBe(true)
    expect(projection.rows.length).toBeGreaterThan(0)
  })
})
