// @vitest-environment jsdom
/**
 * Workspace view store: the mode action and the v6 persistence key (the
 * region's Sessions/Files mode survives reloads like the group/order
 * preferences, and the old v5 key is no longer written).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

beforeEach(() => { localStorage.clear() })

describe('createWorkspaceViewStore', () => {
  it('defaults to the Sessions mode with the existing view preferences', () => {
    const store = createWorkspaceViewStore().create()
    expect(store.getSnapshot()).toMatchObject({
      mode: 'sessions',
      groupBy: 'workspace',
      orderBy: 'updated',
    })
  })

  it('switches the mode through the declared action', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.setMode('files')
    expect(store.getSnapshot().mode).toBe('files')
    store.actions.setMode('sessions')
    expect(store.getSnapshot().mode).toBe('sessions')
  })

  it('persists the mode under the v6 key and stops writing the v5 key', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.setMode('files')
    const raw = localStorage.getItem('dsh.workspace.view.v6')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({ mode: 'files', groupBy: 'workspace' })
    expect(localStorage.getItem('dsh.workspace.view.v5')).toBeNull()
  })

  it('rehydrates the persisted mode into a fresh instance', () => {
    createWorkspaceViewStore().create().actions.setMode('files')
    const restored = createWorkspaceViewStore().create()
    expect(restored.getSnapshot().mode).toBe('files')
  })
})
