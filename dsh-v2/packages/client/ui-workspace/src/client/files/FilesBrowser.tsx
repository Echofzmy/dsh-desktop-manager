/**
 * The Workspace file tree: one lazily cached level of the current Workspace's
 * directory. Root loads when Files is selected; directories load only on
 * first expansion and keep their level cached, so collapsing and reopening
 * never re-fetches; refresh clears the cache and reloads the root. Rows keep
 * the server's directories-first order and activate on click, Enter, or Space.
 * All data and callbacks arrive via props; the level cache is component-local
 * (it does not survive a mode switch, which is exactly the "loads when
 * selected" contract).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserInjected, WorkspaceBrowserProps } from '../contract/slots.ts'
import { FILES_ROOT, projectFilesTree, type FilesLevel } from './tree.ts'
import css from './FilesBrowser.module.css'

/** One indentation step per tree depth (stable row geometry). */
const INDENT_STEP_PX = 20
/** Base horizontal row padding matching the tree list inset. */
const ROW_PAD_PX = 8

/** Row style carries the CSS depth variable (React custom-property seat). */
type FilesRowStyle = CSSProperties & { '--dsh-files-indent': string }

/** Depth-scaled row inset, injected once per row. */
function rowStyle(depth: number): FilesRowStyle {
  return { '--dsh-files-indent': `${ROW_PAD_PX + depth * INDENT_STEP_PX}px` }
}

/** Untranslated wire error text for inline surfaces (same policy as the picker). */
function failureText(reason: unknown): string {
  if (reason instanceof DirectoryBrowseError) return reason.rpcError.message
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Activate a tree row from the keyboard: Enter and Space run the row's action
 * with the browser's default Space scroll suppressed; other keys pass through.
 * @param event - the row's keydown event.
 * @param activate - the row's activation action.
 */
function activateOnEnterOrSpace(event: KeyboardEvent<HTMLDivElement>, activate: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

/* v8 ignore next 3 -- closed-union backstop; only reached if a row kind is forged */
function assertNeverFilesRow(row: never): never {
  throw new Error(`unknown files row kind: ${String(row)}`)
}

/**
 * Render the file tree of one Workspace.
 * @param props.workspace - the Workspace whose directory is browsed.
 * @param props.browse - the injected workspace-rooted listing callback.
 * @param props.openFile - the injected Host open-path callback.
 * @param props.showHidden - reveal host-hidden entries.
 * @param props.refreshKey - bump to clear the cache and reload the root.
 * @param props.t - the browser root's locale seat.
 * @returns the tree element.
 */
export function FilesBrowser({ workspace, browse, openFile, showHidden, refreshKey, t }: {
  workspace: WorkspaceView
  browse: WorkspaceBrowserInjected['browse']
  openFile: (path: string) => Promise<void>
  showHidden: boolean
  refreshKey: number
  t: WorkspaceBrowserProps['t']
}) {
  const [levels, setLevels] = useState<ReadonlyMap<string, FilesLevel>>(new Map())
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [loading, setLoading] = useState<readonly string[]>([])
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [fileError, setFileError] = useState<string | null>(null)
  // In-flight level scans keyed by relativePath, so a workspace switch,
  // refresh, or unmount aborts every pending wire request.
  const inflight = useRef(new Map<string, AbortController>())

  // Root load: mount (Files selected), workspace switch, and refresh all land
  // here; each pass resets the cache and aborts any superseded scan.
  useEffect(() => {
    for (const controller of inflight.current.values()) controller.abort()
    inflight.current.clear()
    setLevels(new Map())
    setExpanded([])
    setErrors(new Map())
    setFileError(null)
    const controller = new AbortController()
    inflight.current.set(FILES_ROOT, controller)
    setLoading([FILES_ROOT])
    browse(workspace.workspaceId, undefined, controller.signal).then((listing) => {
      if (controller.signal.aborted) return
      inflight.current.delete(FILES_ROOT)
      setLevels(new Map([[FILES_ROOT, listing]]))
      setLoading([])
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      inflight.current.delete(FILES_ROOT)
      setLoading([])
      setErrors(new Map([[FILES_ROOT, failureText(reason)]]))
    })
    return () => { controller.abort() }
  }, [browse, refreshKey, workspace.workspaceId])

  // Unmount: stop every level scan with the component.
  useEffect(() => {
    return () => {
      for (const controller of inflight.current.values()) controller.abort()
      inflight.current.clear()
    }
  }, [])

  const loadLevel = (relativePath: string): void => {
    // A scan for this level is already in flight (e.g. a rapid re-activation):
    // reuse it instead of replacing its controller with a duplicate request.
    if (inflight.current.has(relativePath)) return
    const controller = new AbortController()
    inflight.current.set(relativePath, controller)
    setLoading(list => [...list, relativePath])
    browse(workspace.workspaceId, relativePath, controller.signal).then((listing) => {
      if (controller.signal.aborted) return
      inflight.current.delete(relativePath)
      setLevels(map => new Map([...map, [relativePath, listing]]))
      setLoading(list => list.filter(level => level !== relativePath))
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      inflight.current.delete(relativePath)
      setLoading(list => list.filter(level => level !== relativePath))
      setErrors(map => new Map([...map, [relativePath, failureText(reason)]]))
    })
  }

  const toggleDirectory = (relativePath: string): void => {
    setFileError(null)
    if (expanded.includes(relativePath)) {
      setExpanded(expanded.filter(level => level !== relativePath))
      return
    }
    setExpanded([...expanded, relativePath])
    // First expansion fetches; a cached level is reused on reopen.
    if (!levels.has(relativePath)) loadLevel(relativePath)
  }

  const onFileClick = (path: string): void => {
    setFileError(null)
    openFile(path).catch((reason: unknown) => {
      setFileError(failureText(reason))
    })
  }

  const projection = useMemo(
    () => projectFilesTree(levels, new Set(expanded), new Set(loading), errors, showHidden),
    [errors, expanded, levels, loading, showHidden],
  )

  if (projection.rootLoading) {
    return (
      <div className={clsx(css.treeBody, css.wide)}>
        <div className={css.status} role="status">{t('files.loading')}</div>
        <span className={css.fade} />
      </div>
    )
  }
  if (projection.rootError !== undefined) {
    return (
      <div className={clsx(css.treeBody, css.wide)}>
        <div className={css.statusError} role="alert">{projection.rootError}</div>
        <span className={css.fade} />
      </div>
    )
  }
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list} role="tree" aria-label={t('files.aria')}>
        {fileError !== null && <div className={css.statusError} role="alert">{fileError}</div>}
        {projection.rows.map((row) => {
          switch (row.kind) {
            case 'directory':
              return (
                <div
                  key={row.key}
                  className={css.row}
                  role="treeitem"
                  aria-expanded={row.expanded}
                  style={rowStyle(row.depth)}
                  tabIndex={0}
                  onClick={() => { toggleDirectory(row.relativePath) }}
                  onKeyDown={(event) => { activateOnEnterOrSpace(event, () => { toggleDirectory(row.relativePath) }) }}
                >
                  <span className={css.chevron}>
                    <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
                  </span>
                  <span className={css.folder}>
                    {row.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
                  </span>
                  <span className={css.name}>{row.name}</span>
                </div>
              )
            case 'file':
              return (
                <div
                  key={row.key}
                  className={css.row}
                  role="treeitem"
                  style={rowStyle(row.depth)}
                  tabIndex={0}
                  onClick={() => { onFileClick(row.path) }}
                  onKeyDown={(event) => { activateOnEnterOrSpace(event, () => { onFileClick(row.path) }) }}
                >
                  <span className={css.chevron} />
                  <span className={css.folder}><IconCodeOutline16 /></span>
                  <span className={css.name}>{row.name}</span>
                </div>
              )
            case 'status':
              return row.status === 'error'
                ? <div key={row.key} className={css.statusError} role="alert">{row.message}</div>
                : (
                  <div
                    key={row.key}
                    className={row.status === 'empty' ? css.empty : css.status}
                    role={row.status === 'loading' ? 'status' : undefined}
                  >
                    {row.status === 'loading' ? t('files.loading')
                      : row.status === 'empty' ? t('files.empty')
                        : t('files.truncated')}
                  </div>
                )
            /* v8 ignore next -- closed FilesRow union; only a forged row reaches here */
            default: return assertNeverFilesRow(row)
          }
        })}
      </div>
      <span className={css.fade} />
    </div>
  )
}
