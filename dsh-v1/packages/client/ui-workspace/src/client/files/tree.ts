/**
 * Files-view derivation: resolves the Workspace the file tree browses and
 * projects the cached directory levels into display rows. The component owns
 * the cache lifecycle (load on first expansion, keep on collapse, clear on
 * refresh); this module owns pure derivation only.
 */
import type {
  SessionId, WorkspaceDirectoryListing, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Root-level cache key: the workspace root is one cached level like any other. */
export const FILES_ROOT = ''

/** One cached directory level: the listing the Host returned, verbatim. */
export type FilesLevel = WorkspaceDirectoryListing

/** One display row of the workspace-rooted file tree. */
export type FilesRow =
  | {
    /** Absolute Host path; unique across the whole tree. */
    key: string
    depth: number
    kind: 'directory'
    name: string
    path: string
    /** Workspace-rooted key passed back to `browse` for this directory. */
    relativePath: string
    expanded: boolean
  }
  | {
    key: string
    depth: number
    kind: 'file'
    name: string
    /** Absolute Host path handed to `openFile` verbatim. */
    path: string
  }
  | {
    key: string
    depth: number
    kind: 'status'
    status: 'loading' | 'error' | 'empty' | 'truncated'
    /** Untranslated wire error text; present for the error status only. */
    message?: string
  }

/** The projected tree plus the two whole-view states (first paint and root failure). */
export interface FilesProjection {
  rows: readonly FilesRow[]
  /** True while the root listing is in flight (no rows render yet). */
  rootLoading: boolean
  /** Root browse failure message, or undefined while loading or resolved. */
  rootError: string | undefined
}

/**
 * Resolve the Workspace the file tree browses: the Workspace containing the
 * current Session, else the most recently active Workspace, else the first
 * Workspace in the registry order; absent with no Workspace at all.
 * @param workspaces - real Workspaces in stable Host order.
 * @param currentSessionId - selected Session, if any.
 * @param recentWorkspaceId - the recency projection, if any.
 * @returns the target Workspace, or undefined when none exists.
 */
export function resolveFilesWorkspace(
  workspaces: readonly WorkspaceView[],
  currentSessionId: SessionId | undefined,
  recentWorkspaceId: WorkspaceId | undefined,
): WorkspaceView | undefined {
  if (currentSessionId !== undefined) {
    const containing = workspaces.find(workspace => workspace.sessionIds.includes(currentSessionId))
    if (containing !== undefined) return containing
  }
  if (recentWorkspaceId !== undefined) {
    const recent = workspaces.find(workspace => workspace.workspaceId === recentWorkspaceId)
    if (recent !== undefined) return recent
  }
  return workspaces[0]
}

/** One per-level status row key: a level emits at most one status of each kind. */
function statusKey(relativePath: string, kind: string): string {
  return `${relativePath}::${kind}`
}

/**
 * Append one level's rows depth-first. Directories come first as the server
 * sorts them; an expanded directory's children follow at depth + 1. The
 * component loads on first expansion, so an expanded directory always has a
 * cached, in-flight, or failed level — a missing cache renders as loading.
 */
function walkLevel(
  level: FilesLevel,
  depth: number,
  levels: ReadonlyMap<string, FilesLevel>,
  expanded: ReadonlySet<string>,
  loading: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  showHidden: boolean,
  rows: FilesRow[],
): void {
  const visible = level.entries.filter(entry => showHidden || !entry.hidden)
  if (visible.length === 0) {
    rows.push({ key: statusKey(level.relativePath, 'empty'), depth, kind: 'status', status: 'empty' })
    return
  }
  for (const entry of visible) {
    if (entry.kind === 'file') {
      rows.push({ key: entry.path, depth, kind: 'file', name: entry.name, path: entry.path })
      continue
    }
    const isExpanded = expanded.has(entry.relativePath)
    rows.push({
      key: entry.path,
      depth,
      kind: 'directory',
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      expanded: isExpanded,
    })
    if (!isExpanded) continue
    if (loading.has(entry.relativePath)) {
      rows.push({ key: statusKey(entry.relativePath, 'loading'), depth: depth + 1, kind: 'status', status: 'loading' })
      continue
    }
    const error = errors.get(entry.relativePath)
    if (error !== undefined) {
      rows.push({ key: statusKey(entry.relativePath, 'error'), depth: depth + 1, kind: 'status', status: 'error', message: error })
      continue
    }
    const child = levels.get(entry.relativePath)
    if (child === undefined) {
      rows.push({ key: statusKey(entry.relativePath, 'loading'), depth: depth + 1, kind: 'status', status: 'loading' })
      continue
    }
    walkLevel(child, depth + 1, levels, expanded, loading, errors, showHidden, rows)
    if (child.truncated) {
      rows.push({ key: statusKey(entry.relativePath, 'truncated'), depth: depth + 1, kind: 'status', status: 'truncated' })
    }
  }
}

/**
 * Project the cached levels into render rows for the current expansion,
 * loading, and failure state, filtering hidden entries unless revealed.
 * @param levels - cached levels keyed by workspace-rooted relativePath.
 * @param expanded - expanded directory relativePaths.
 * @param loading - levels with an in-flight browse.
 * @param errors - level browse failures (untranslated wire text).
 * @param showHidden - reveal host-hidden entries.
 * @returns the visible rows and the two whole-view states.
 */
export function projectFilesTree(
  levels: ReadonlyMap<string, FilesLevel>,
  expanded: ReadonlySet<string>,
  loading: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  showHidden: boolean,
): FilesProjection {
  const root = levels.get(FILES_ROOT)
  if (root === undefined) {
    // First paint: the root is loading unless it already failed.
    return { rows: [], rootLoading: !errors.has(FILES_ROOT), rootError: errors.get(FILES_ROOT) }
  }
  const rows: FilesRow[] = []
  walkLevel(root, 0, levels, expanded, loading, errors, showHidden, rows)
  if (root.truncated) {
    rows.push({ key: statusKey(FILES_ROOT, 'truncated'), depth: 0, kind: 'status', status: 'truncated' })
  }
  return { rows, rootLoading: loading.has(FILES_ROOT), rootError: errors.get(FILES_ROOT) }
}
