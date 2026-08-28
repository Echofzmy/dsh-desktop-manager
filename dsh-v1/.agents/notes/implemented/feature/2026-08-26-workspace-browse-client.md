# Agent Note: Workspace browse client — object layer and sidebar file tree

Status: implemented

English | [中文](2026-08-26-workspace-browse-client.zh.md)

## Problem

The workspace-rooted file browser reached the wire backend real ([workspace-browse-backend](2026-08-26-workspace-browse-backend.md)), but the client had no consumption: `IWorkspaces` and `WorkspaceRuntime` exposed only the Host-wide picker (`listDirectory`/`createDirectory`), so a feature package could not list one level of a Workspace's own directory — the listing the browser contract distinguishes from the picker by its file/directory rows, workspace-rooted relative paths, and escape-free containment — and the sidebar offered no in-app view of a Workspace's directory.

## Decision

`IWorkspaces.browse(workspaceId, relativePath?, signal?)` is the new face, returning `WorkspaceDirectoryListing`. `WorkspaceRuntime.browse` forwards the exact payload and signal: an absent `relativePath` is omitted from the payload (never sent as `undefined` — the `listDirectory` precedent), the caller's `AbortSignal` reaches `api.workspace.browse` untouched so the Host's scan stops with the caller, and every business failure (`workspace-not-found`, `directory-unreadable`, `cancelled`) is mapped through the existing `DirectoryBrowseError` the browse-capability actions already throw. The wire types (`WorkspaceDirectoryListing`, `WorkspaceFileEntry`) flow out through the connection `/client` contract, `dsh-api-remotes/client`, and the runtime client index next to the picker types.

The sidebar Files mode (ui-workspace) consumes the face. `WorkspaceBrowserInjected.browse`/`openFile` wrap `ctx.workspaces.browse`/`openPath`; the region's Sessions/Files switch replaces the old section label and persists the mode in the viewing store (`dsh.workspace.view.v6`). The file tree resolves its Workspace as the one containing the current Session, else the recent-Workspace projection, else the first registered Workspace (an empty state with none). The tree is lazy: the root loads when Files is selected, directories load only on their first expansion and keep that level cached (collapsing and reopening never refetches), Refresh clears the cache and reloads the root, and every scan runs on an abortable controller the component cancels on workspace switch or unmount. Rows keep the server's directories-first order; hidden entries hide by default until the Show hidden files toggle reveals them; file clicks hand the row's absolute path to `host.openPath`, with loading, empty, truncated, browse-failure, and open-failure states rendered inline. The collapsed rail gains a Files icon that expands the sidebar into Files mode, while search and add stay Sessions-mode entries that return to Sessions before acting.

The test surfaces keep the same face: `TestWorkspaces.browse` records the call (signal included), serves a deterministic root with one file and one directory row so feature tests see both kinds, and honors the `stub('browse', …)` seat like every sibling method. The connection fixture's `workspace.browse` now returns both row kinds: file rows come from a fixture `fileTree` (the picker's `DirectoryEntry` has no kind, so `host.listDirectory` keeps serving directories from `directoryTree`), directory rows from the shared tree, merged directories-first then by name exactly like the Host backend, with `relativePath` echoed verbatim and dot-prefixed names flagged `hidden`.

## Alternatives considered

**Rename or generalize `DirectoryBrowseError`.** It already names the directory-browse domain shared by `listDirectory`, `createDirectory`, and now `browse`; a rename churns consumers without improving the contract, so the error class is kept as the single structured failure carrier.

**Default `TestWorkspaces.browse` to an empty listing.** Inert like `listDirectory`'s default, but a workspace-browser feature test would have to stub before it can render a single row; serving one row of each kind demonstrates the protocol without inventing a tree.

**Eager full-tree load in the Files mode.** The workspace-rooted contract is level-scoped (one `relativePath` per request), and a full tree would need an unbounded request chain; the per-level lazy cache matches that contract and keeps collapse/reopen and Refresh behavior local to the tree component.

## Consequences

Feature packages can drive the workspace-rooted browser through `ctx.workspaces.browse` with the same error vocabulary as the picker, and the sidebar's Files mode gives every Workspace an in-app file tree that opens rows through `host.openPath`. The fixture distinguishes picker directories from browse files, so assembled Web tests exercise the file/directory split and the directories-first order without a Host. The runtime spec pins payload omission, signal forwarding, and error mapping; the fixture spec pins the row kinds and sort; the component spec pins the lazy-cache lifecycle, hidden filtering, and inline failure states.
