# SLICC Documentation

**SLICC is a browser-based AI coding agent** — a self-contained development environment where Claude writes code, runs shell commands, and automates browser tabs entirely within Chrome. Runs as a Chrome extension (side panel), standalone CLI server, or Electron float.

For architecture philosophy and principles, see the project's `CLAUDE.md` file.

## Task Routing


| I need to...                           | Read this                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Understand the architecture            | [architecture.md](./architecture.md)                                                    |
| Add a shell command                    | [shell-reference.md](./shell-reference.md) + [adding-features.md](./adding-features.md) |
| Add an agent tool                      | [tools-reference.md](./tools-reference.md) + [adding-features.md](./adding-features.md) |
| Write tests                            | [testing.md](./testing.md)                                                              |
| Build, run, or debug                   | [development.md](./development.md)                                                      |
| Run or debug Electron mode             | [electron.md](./electron.md) + [development.md](./development.md)                       |
| Avoid breaking the extension           | [pitfalls.md](./pitfalls.md)                                                            |
| Add a UI panel or skill                | [adding-features.md](./adding-features.md)                                              |
| Add a provider (API key or OAuth)      | [adding-features.md](./adding-features.md)                                              |


## Layer Quick Reference


| Layer               | Directory        | Key File            | Purpose                                                |
| ------------------- | ---------------- | ------------------- | ------------------------------------------------------ |
| Virtual Filesystem  | `src/fs/`        | `virtual-fs.ts`     | POSIX-like FS backed by LightningFS (IndexedDB)        |
| Shell               | `src/shell/`     | `wasm-shell.ts`     | just-bash WASM interpreter + xterm.js terminal         |
| CDP                 | `src/cdp/`       | `browser-api.ts`    | Chrome DevTools Protocol client (Playwright-style API) |
| Tools               | `src/tools/`     | `bash-tool.ts`      | Tool factories; active scoop surface is file + bash + javascript |
| Core Agent          | `src/core/`      | `index.ts`          | pi-mono agent loop, streaming, context compaction      |
| Scoops Orchestrator | `src/scoops/`    | `orchestrator.ts`   | Multi-agent system (cone + scoops), message routing    |
| UI                  | `src/ui/`        | `main.ts`           | Vanilla TS layout: Chat + Terminal + Browser Preview   |
| CLI Server          | `packages/node-server/src/` | `index.ts`          | Express + CDP WebSocket proxy, Chrome launcher         |
| Extension           | `src/extension/` | `service-worker.ts` | Chrome Manifest V3 extension (side panel)              |
| Sprinkles           | `src/ui/sprinkle-*.ts` | `sprinkle-manager.ts` | Composable `.shtml` panels with agent bridge API  |


## Active Scoop Tool Surface

The active tool surface wired in `src/scoops/scoop-context.ts` is:

- File tools: `read_file`, `write_file`, `edit_file`
- Execution tools: `bash`, `javascript`
- NanoClaw tools: `send_message` for all scoops, plus cone-only scoop-management tools

Browser automation and search for agents run through shell commands via `bash` (`playwright-cli` / `playwright` / `puppeteer` for browser automation, `grep` / `find` / `rg` for search), with `serve <dir>` for previewing VFS app directories and `open` for single files or URLs.

## Ice Cream Vocabulary

SLICC uses ice cream terminology to describe its multi-agent system:

- **Cone**: The main agent ("sliccy"). Human's point of interaction. Full filesystem and tool access. Orchestrates scoops. Type: `RegisteredScoop` with `isCone: true`.
- **Scoops**: Isolated sub-agents. Each has sandboxed filesystem (`/scoops/{name}/` + `/shared/`), own shell, own conversation. Created via `scoop_scoop`, fed via `feed_scoop`, removed via `drop_scoop`.
- **Licks**: External events (webhooks, cron tasks) that trigger scoops. Unified under `LickManager` and `LickEvent`. Shell commands: `webhook`, `crontask`. A lick arrives, the scoop reacts — no human in the loop.
- **Floats**: Runtime environments. Four are tracked:
  - **CLI float**: Node.js/Express + Chrome. Code: `packages/node-server/src/`.
  - **Extension float**: Chrome extension side panel, zero server. Code: `src/extension/`.
  - **Electron float**: Electron BrowserWindow + injected overlay shell + serve-only CLI reuse. Code: `packages/node-server/src/electron-main.ts` + `src/ui/electron-overlay.ts`.
  - **Cloud float**: Planned — Cloudflare Containers or E2B sandboxes.

