![slicc - Browser-Based Coding Agent](hero-banner.jpg)

# slicc — Self-Licking Ice Cream Cone

[![Vibe Coded](https://img.shields.io/badge/vibe--coded-62%25_AI-blue?style=for-the-badge&logo=github)](https://github.com/trieloff/vibe-coded-badge-action)

> *An AI coding agent that builds itself. The snake that eats its own tail, but productive.*

A browser-based coding agent with a thin CLI server. Runs Claude directly in the browser with full filesystem access, a WebAssembly shell, browser automation via CDP, and a complete suite of code editing tools — all without leaving your browser tab.

---

Part of the **[AI Ecoverse](https://github.com/trieloff/ai-ecoverse)** — a comprehensive ecosystem of tools for AI-assisted development:
- [ai-aligned-git](https://github.com/trieloff/ai-aligned-git) — Git wrapper for safe AI commit practices
- [ai-aligned-gh](https://github.com/trieloff/ai-aligned-gh) — GitHub CLI wrapper for proper AI attribution
- [yolo](https://github.com/trieloff/yolo) — AI CLI launcher with worktree isolation
- [vibe-coded-badge-action](https://github.com/trieloff/vibe-coded-badge-action) — Badge showing AI-generated code percentage
- [gh-workflow-peek](https://github.com/trieloff/gh-workflow-peek) — Smarter GitHub Actions log filtering
- [upskill](https://github.com/trieloff/upskill) — Install Claude/Agent skills from other repositories
- [as-a-bot](https://github.com/trieloff/as-a-bot) — GitHub App token broker for proper AI attribution
- **slicc** — Browser-based coding agent (you are here)

---

## Features

- :globe_with_meridians: **Browser-Native** — runs entirely in the browser, no Electron, no desktop app
- :satellite: **CLI Server** — thin Node.js/Express server launches Chrome and proxies CDP connections
- :file_folder: **Virtual Filesystem** — OPFS + IndexedDB-backed filesystem right in the browser
- :shell: **WebAssembly Bash Shell** — real Bash via [just-bash](https://github.com/nicolo-ribaudo/just-bash) compiled to WASM
- :robot: **Browser Automation** — screenshots, navigation, JS eval, element clicking via Chrome DevTools Protocol
- :pencil2: **File Operations** — read, write, edit files with syntax-aware tools
- :mag: **Search Tools** — grep and find across your virtual codebase
- :zap: **Real-Time Streaming** — responses stream token-by-token as Claude thinks
- :floppy_disk: **Session Persistence** — conversations and files survive page reloads via IndexedDB
- :window: **Split-Pane UI** — chat panel + terminal + browser preview, all in one view
- :crescent_moon: **Dark Theme** — syntax-highlighted code with a dark-first design

## Why "slicc"?

**Self-Licking Ice Cream Cone** — a system that exists to justify its own existence.

In this case: an AI coding agent that was *built by* AI coding agents, creating tools *for* AI coding agents. 62% of the commits in this repo were authored by Claude. The tool that builds itself, so you don't have to.

The ultimate recursive dev tool.

## Architecture

slicc is a dual-process system: a thin CLI server and a rich browser application.

**CLI Server** (Node.js/Express) — launches a headless Chrome instance, establishes a CDP (Chrome DevTools Protocol) WebSocket proxy, provides a CORS proxy for LLM API calls, and serves the UI assets.

**Browser App** (Vite/TypeScript) — the agent loop (powered by [pi-mono](https://github.com/badlogic/pi-mono)), tool execution, chat UI, integrated terminal, and embedded browser preview all run client-side.

```
┌─────────────────────────────────────────────────────┐
│                   Browser Window                     │
│                                                      │
│  ┌──────────────┬──────────────┬──────────────────┐  │
│  │              │              │                  │  │
│  │    Chat      │   Terminal   │  Browser Preview │  │
│  │    Panel     │   (xterm)    │  (CDP-driven)    │  │
│  │              │              │                  │  │
│  │  Claude AI   │  WASM Bash   │  Live page view  │  │
│  │  responses   │  shell       │  + screenshots   │  │
│  │              │              │                  │  │
│  └──────────────┴──────────────┴──────────────────┘  │
│                                                      │
└──────────────┬──────────────────────────────────────┘
               │ WebSocket (CDP proxy)
┌──────────────▼──────────────────────────────────────┐
│           CLI Server (Node.js/Express)               │
│  Chrome launcher  ·  CDP proxy  ·  CORS proxy  ·  Static server  │
└─────────────────────────────────────────────────────┘
```

Source layout:

| Directory | Purpose |
|-----------|---------|
| `src/cli/` | CLI server — Chrome launch, CDP proxy, Express |
| `src/ui/` | Browser UI — chat, terminal, browser panels |
| `src/core/` | Agent types, tool registry, session management (core loop provided by pi-mono) |
| `src/tools/` | Tool implementations (file ops, search, browser) |
| `src/fs/` | Virtual filesystem (OPFS/IndexedDB) |
| `src/shell/` | WebAssembly Bash shell integration |
| `src/cdp/` | Chrome DevTools Protocol client |

## Getting Started

```bash
# Install dependencies
npm install

# Start the dev server (launches Chrome + Vite)
npm run dev:full

# Open the URL printed in the terminal
```

The `dev:full` command starts both the CLI server and Vite dev server, launches Chrome, and opens the agent UI.

## Tech Stack

| Dependency | Role |
|-----------|------|
| [@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono) | Agent loop, tool execution, event system |
| [@mariozechner/pi-ai](https://github.com/badlogic/pi-mono) | Unified LLM API (Anthropic provider) |
| [express](https://expressjs.com/) | CLI server framework |
| [just-bash](https://github.com/nicolo-ribaudo/just-bash) | WebAssembly Bash shell |
| [ws](https://github.com/websockets/ws) | WebSocket for CDP proxy |
| [@xterm/xterm](https://xtermjs.org/) | Terminal emulator in the browser |
| [vite](https://vitejs.dev/) | Build tool and dev server |
| [vitest](https://vitest.dev/) | Test runner |
| [TypeScript](https://typescriptlang.org/) | Type safety across CLI and browser |

## Development

```bash
# Run the full dev environment (CLI server + Vite HMR)
npm run dev:full

# Run just the Vite dev server (no CLI/Chrome)
npm run dev

# Build everything (UI + CLI)
npm run build

# Type-check both CLI and browser code
npm run typecheck

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```
