# DeepSeek Harness Workspace

This monorepo keeps the DSH desktop manager and the local DSH runtime versions it manages in one history.

## Projects

| Directory | Purpose |
| --- | --- |
| `desktop-manager/` | Electron application for installing runtimes and managing DSH instances and environments. |
| `dsh-v1/` | Preserved v1 runtime checkout. |
| `dsh-v2/` | Preserved v2 runtime checkout. |
| `dsh-v3/` | Preserved v3 runtime checkout. |
| `dsh-v4/` | Active v4 runtime development checkout. |

Each project keeps its own package manager workspace, build scripts, documentation, tests, and ignore rules. Run commands from the project directory rather than from this repository root.

## Development

Build and test the manager:

```bash
cd desktop-manager
pnpm install
pnpm test
pnpm run build
```

Build a local DSH runtime directly:

```bash
cd dsh-v4
pnpm install
pnpm run build
```

A runtime already registered with DSH Manager can instead be updated from the Manager runtime page with **Complete Build**, followed by **Re-run Preflight** and an instance restart.

## Local Data

This repository contains source code only. DSH Manager state, environments, credentials, instance logs, session logs, downloaded runtimes, dependencies, and generated build artifacts remain outside Git through the root and project-specific ignore rules.

On macOS, Manager-owned application data normally lives under:

```text
~/Library/Application Support/dsh-desktop-manager/
```

Do not add that directory or exported credentials to this repository.

## Licenses

The DSH runtime directories retain their own license and third-party notice files. Review the license in the relevant runtime directory before redistribution.
