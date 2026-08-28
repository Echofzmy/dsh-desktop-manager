# Agent Note: Workspace browse backend

Status: implemented

English | [中文](2026-08-26-workspace-browse-backend.zh.md)

## Problem

`workspace.browse` reached the wire as a plumbing placeholder: the schema, the client rows, and the README contract described a real one-level workspace file-browser listing, but the host answered every call with `internal` ("not implemented"). The backend had to land with the containment, scan, sort, and bound-truncation policy the contract already promised, and the bound had to be a deployment tunable rather than a constant buried in the implementation.

## Decision

The backend is a set of module-level helpers in `api-proxy.ts` plus one RPC row. Runtime path validation runs at the wire boundary and is independent of the zod schema, so a direct or alternate caller cannot bypass it: `relativePath` must be a POSIX-style workspace-rooted relative path — absolute POSIX (`/`-prefixed), absolute Windows (`X:` drive prefix), UNC (`\`-prefixed), NUL, and `.`/`..`/empty segments are all rejected, while `''` and an absent path both mean the workspace root and echo back as the response's `relativePath: ''`.

The target is canonicalized with `fs.realpath` and enforced to stay inside the canonical workspace root, which is itself re-realpath'd per call: containment compares canonical-to-canonical, so a symlinked parent (or a workspace root replaced by a symlink) cannot smuggle a listing out of the workspace, and a target that does not resolve to a directory is refused. The scan is one direct level via an `opendir` read loop; symlink entries and unusual node types (FIFO, socket, device) are never rows. Rows are directories first, then files, each name-sorted, with dot-prefixed names flagged `hidden`, and every row carries the workspace-rooted `relativePath` (the client passes it back verbatim) plus the absolute host path.

The combined file+directory row bound is `ApiProxyService` config `workspaceBrowseMaxEntries` (schemastery `z.natural()`, default 1000, the exported `DEFAULT_WORKSPACE_BROWSE_MAX_ENTRIES` constant) and flows through `ApiProxyDefaults.workspaceBrowseMaxEntries` into `createApiProxy`. The scan still reads every dirent — `truncated` must be truthful, and the total count is only known at the end — but rows are held through a name-sorted capped insertion per kind, so memory stays bounded by twice the bound no matter how large the directory is.

The carrier's request signal stops the scan: it is checked at every await and every loop iteration via `throwIfAborted`, and an already-aborted call answers `cancelled` before touching the registry or the filesystem. Error mapping: an unknown workspace answers `workspace-not-found`; every other failure — invalid path syntax, containment escape, missing, unreadable, or non-directory target — answers `directory-unreadable` with the attempted absolute path in `details.path`.

## Alternatives considered

**Collect every dirent row, then sort and slice.** Simpler, but memory scales with the directory size; a single huge directory would hold an unbounded listing. The capped insertion keeps the same truthful result (the kept prefix always equals the full name-sorted prefix) with bounded memory and a single pass.

**Two passes: count first, then read only the needed prefix.** The truthful `truncated` flag already requires a full pass, so the second pass buys nothing; one pass with per-kind capped insertion reads each dirent exactly once.

**Lexical containment on the joined path without realpath.** A symlinked parent or a replaced workspace root would bypass it; canonical-to-canonical comparison is the only check that survives both.

**Treat `''` as an empty segment and reject it.** The response contract already uses `''` as the root marker, the client echoes the request path verbatim, and an absent path is the common case; accepting `''` as the root keeps the round trip consistent.

**Enforce the path rules in the zod schema alone.** The schema governs the fetch carrier, not direct callers of `ctx.apiProxy`; the containment rule cannot live in a schema at all, so runtime enforcement owns both.

## Consequences

The gateway config surface grows by one natural-number key with a documented default; deployments with huge workspace directories can raise the bound from cordis.yml, and the listing never forces the host to hold or ship more than the bound. Symlink children are deliberately invisible to the browser, so no UI row can navigate out of the workspace through a link; a `relativePath` that is itself a symlink is still followed when its canonical target stays inside. Because the root is re-realpath'd per call, a workspace whose directory was deleted or replaced reads as `directory-unreadable` rather than serving stale rows.
