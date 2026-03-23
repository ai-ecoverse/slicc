# CLAUDE.md

This root file is the repo navigation hub. Keep package-specific architecture and implementation detail in the nearest package `CLAUDE.md`, and keep fast-changing how-to material in `docs/`.

## Module Map

### Packages

| Path | Purpose |
| --- | --- |
| `packages/webapp/` | Browser app core: UI, VFS, shell, CDP, tools, providers, skills, scoops |
| `packages/chrome-extension/` | Manifest V3 extension entry points, HTML shells, and message bridges |
| `packages/cloudflare-worker/` | Tray hub worker for session coordination, signaling, and TURN credentials |
| `packages/node-server/` | Node.js CLI/Electron server: Chrome launch, CDP proxy, dev serving |
| `packages/vfs-root/` | Default VFS content copied into the app on init/reset |
| `packages/swift-launcher/` | Native macOS SwiftUI launcher app (`Sliccstart`) |
| `packages/swift-server/` | Native macOS Hummingbird server (`slicc-server`) |
| `packages/dev-tools/` | Repo-level tooling guidance for build helpers, QA setup, configs, and test utilities |

### Other Top-Level Directories

| Path | Purpose |
| --- | --- |
| `docs/` | Long-form developer and agent reference docs |
| `tests/` | TypeScript/Vitest and integration tests mirrored by subsystem |
| `providers/` | External provider configs used by the repo's tooling surface |
| `tools/` | Standalone repo utilities such as prompt extraction |
| `public/` | Static assets served by the web build |
| `dist/` | Generated build output; do not hand-edit |
| `logos/`, `screenshots/` | Brand and documentation assets |

## Top-Level Commands

```bash
npm run build           # Production build (UI + CLI/Electron)
npm run test            # Vitest run
npm run typecheck       # Browser + Node typecheck
npm run build:extension # Chrome extension build into dist/extension/
```

For runtime-specific commands, use the nearest guide:

- [`packages/webapp/CLAUDE.md`](packages/webapp/CLAUDE.md)
- [`packages/chrome-extension/CLAUDE.md`](packages/chrome-extension/CLAUDE.md)
- [`packages/cloudflare-worker/CLAUDE.md`](packages/cloudflare-worker/CLAUDE.md)
- [`packages/node-server/CLAUDE.md`](packages/node-server/CLAUDE.md)
- [`packages/vfs-root/CLAUDE.md`](packages/vfs-root/CLAUDE.md)
- [`packages/swift-launcher/CLAUDE.md`](packages/swift-launcher/CLAUDE.md)
- [`packages/swift-server/CLAUDE.md`](packages/swift-server/CLAUDE.md)
- [`packages/dev-tools/CLAUDE.md`](packages/dev-tools/CLAUDE.md)
- [`docs/CLAUDE.md`](docs/CLAUDE.md)

## Cross-Cutting Principles

### Philosophy

1. **The Claw Pattern**: SLICC is a persistent orchestration layer over LLM agents, centered in the browser.
2. **Agents Love the CLI**: Prefer shell commands and composable command surfaces over bespoke tools.
3. **The Browser is the OS**: Keep state client-side and use server code only for work browsers cannot do themselves.

### Ice Cream Vocabulary

- **Cone**: the main agent.
- **Scoops**: isolated sub-agents with sandboxed filesystems.
- **Licks**: external events such as webhooks or cron tasks.
- **Floats**: runtime environments such as CLI, extension, Electron, and cloud.

Use the ice cream terms in code review comments and docs when they match the domain.

## Git Conventions

- Keep commits focused and package-local when possible.
- Do not hand-edit generated output in `dist/`.
- Webapp git behavior is implemented with `isomorphic-git` over LightningFS.
- Auth uses `git config github.token <PAT>`.
- Network behavior differs by runtime: CLI routes git/fetch traffic through `/api/fetch-proxy`; the extension uses direct fetch.

## Change Requirements

Every change must satisfy **tests**, **docs**, and **verification**.

### Tests

- Add or update tests for behavior changes.
- TypeScript tests live in `tests/`, mirrored by subsystem.
- See `docs/testing.md` for patterns and command selection.

### Documentation

| Tier | File | Update when... |
| --- | --- | --- |
| Public | `README.md` | User-facing behavior changes |
| Development | `CLAUDE.md` files | Developer conventions, package architecture, build workflows |
| Agent reference | `docs/` | Detailed tools, commands, and patterns |

### Verification

These are the repo's CI gates and the default full verification pass before commit:

```bash
npm run typecheck
npm run test
npm run build
npm run build:extension
```

CI runs the same four gates in `.github/workflows/ci.yml`.
