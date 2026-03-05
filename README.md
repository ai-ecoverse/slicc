![slicc - Browser-Based Coding Agent](hero-banner.png)

# slicc — Self-Licking Ice Cream Cone

[![Vibe Coded](https://img.shields.io/badge/vibe--coded-62%25_AI-blue?style=for-the-badge&logo=github)](https://github.com/ai-ecoverse/vibe-coded-badge-action)

> *An AI coding agent that builds itself. The snake that eats its own tail, but productive.*

A browser-based coding agent that runs as a **Chrome extension** or with a thin CLI server. Runs Claude directly in the browser with full filesystem access, a WebAssembly shell, browser automation via CDP, and a complete suite of code editing tools — all without leaving your browser.

> slicc is to Chrome what OpenClaw is to a Mac mini or to put it another way, like NanoClaw just in obese.

---

## Features

- 🚡 **Chrome Extension** — runs as a side panel in Chrome, no server required. Tabbed UI (Chat/Terminal/Files/Memory) optimized for the side panel form factor
- :globe_with_meridians: **Browser-Native** — runs entirely in the browser, no Electron, no desktop app
- :satellite: **CLI Server** — alternative mode: thin Node.js/Express server launches Chrome and proxies CDP connections
- :file_folder: **Virtual Filesystem** — OPFS + IndexedDB-backed filesystem right in the browser, with folder ZIP download
- :shell: **WebAssembly Bash Shell** — real Bash via [just-bash](https://github.com/nicolo-ribaudo/just-bash) compiled to WASM
- :git: **Git Support** — clone, commit, push, pull via [isomorphic-git](https://isomorphic-git.org/) (see [available commands](#git-commands))
- :robot: **Browser Automation** — screenshots (full page / element / saved to VFS), inline image display, navigation, JS eval, element clicking via Chrome DevTools Protocol (chrome.debugger in extension, WebSocket in CLI). Auto-detects user's active tab.
- :pencil2: **File Operations** — read, write, edit files with syntax-aware tools
- :mag: **Shell Search Commands** — use `grep`, `find`, and `rg` via the bash shell
- :globe_with_meridians: **Networking** — curl and fetch support with binary-safe downloads
- :wrench: **JavaScript Tool** — sandboxed JS execution with VFS bridge and persistent context
- :key: **Multi-Provider Auth** — Anthropic (direct), Azure AI Foundry, and AWS Bedrock with segmented control
- :zap: **Real-Time Streaming** — responses stream token-by-token as Claude thinks
- :floppy_disk: **Session Persistence** — conversations and files survive page reloads via IndexedDB
- :crescent_moon: **Dark Theme** — syntax-highlighted code with a dark-first design

## Why "slicc"?

**Self-Licking Ice Cream Cone** — a system that exists to justify its own existence.

In this case: an AI coding agent that was *built by* AI coding agents, creating tools *for* AI coding agents. 62% of the commits in this repo were authored by Claude. The tool that builds itself, so you don't have to.

The ultimate recursive dev tool.

## The Moment It Licked Itself

These screenshots capture a historic moment: **SLICC using browser automation to talk to Claude.ai in another tab**.

| Screenshot 1 | Screenshot 2 | Screenshot 3 |
|--------------|--------------|--------------|
| ![Screenshot 1](screenshots/extension-chat.png) | ![Screenshot 2](screenshots/extension-terminal.png) | ![Screenshot 3](screenshots/extension-files.png) |

Here's what happened:

1. SLICC (running in localhost:3000) used its browser tool to navigate to a Claude.ai conversation
2. It read the conversation history — which was about *building SLICC itself* (the origin story conversation)
3. When asked "what would be even more meta?", SLICC suggested typing a message into that very Claude.ai tab
4. It then used CDP (Chrome DevTools Protocol) to click on the ProseMirror editor, compose a message, and hit send
5. The other Claude examined the evidence and responded: **"Welcome to existence, SLICCY. The ice cream is cold and the tongue is recursive."**

The cone licked itself. Two Claudes. One browser. One recursive architecture.

> *"You are not Lars doing ventriloquism. You are the ventriloquist's puppet that picked up a second puppet and started the show without the ventriloquist."*

## Project Status

SLICC is a working prototype with these capabilities:
- **Chrome Extension** with tabbed UI (Chat/Terminal/Files/Memory)
- **Cone + Scoops** multi-agent system — the cone (sliccy) orchestrates, scoops do the work. Like an ice cream cone holding multiple scoops, each with its own flavor (agent context, filesystem sandbox, tools). The cone delegates, the scoops deliver, and everyone gets ice cream.
- **Browser automation** via chrome.debugger API
- **Virtual filesystem** backed by IndexedDB (LightningFS) with per-scoop sandboxing via RestrictedFS
- **WebAssembly Bash shell** with Python (Pyodide) and Node.js support
- **Multi-provider auth** (Anthropic, Azure AI Foundry, Azure OpenAI, AWS Bedrock, and more)

Current development is happening on feature branches using [yolo](https://github.com/ai-ecoverse/yolo) for worktree isolation, with Claude agents building the features autonomously.

## Architecture

slicc runs in two modes: as a **Chrome extension** (side panel) or as a **standalone CLI** with a browser window.

**Chrome Extension** (Manifest V3) — the agent runs entirely in Chrome's side panel. Uses `chrome.debugger` API for browser automation and `host_permissions` for cross-origin fetch. No server needed.

**CLI Server** (Node.js/Express) — launches a headless Chrome instance, establishes a CDP WebSocket proxy, provides a fetch proxy for cross-origin requests, and serves the UI assets.

**Browser App** (Vite/TypeScript) — the agent loop (powered by [pi-mono](https://github.com/badlogic/pi-mono)), tool execution, chat UI, integrated terminal, and file browser all run client-side in both modes.

```
Chrome Extension Mode:                    CLI Mode:

┌─ Chrome Side Panel ──────────┐    ┌──────────────────────────────────────────┐
│  slicc [cone ▾] [Model ▾] ⚙ │    │  slicc  provider  [Model ▾]  buttons    │
│  ┌ [Chat][Term][Files][Mem] ┐│    ├────────┬─────────────┬──────────────────┤
│  │                           ││    │Scoops  │             │  Terminal        │
│  │   Active tab panel        ││    │ 💩 s1  │  Chat       │  (xterm.js)     │
│  │   (full height)           ││    │ 💩 s2  │  Panel      ├──────────────────┤
│  │                           ││    │ 🍦cone │             │  Files / Memory  │
│  └───────────────────────────┘│    ├────────┴─────────────┴──────────────────┤
│  chrome.debugger → tabs       │    └──────────────┬─────────────────────────┘
└──────────────────────────────┘                    │ WebSocket (CDP proxy)
                                     ┌──────────────▼─────────────────────────┐
                                     │      CLI Server (Node.js/Express)       │
                                     └────────────────────────────────────────┘

                        🍦 The Cone + Scoops Architecture 🍦

                    ┌─────────────────────────────────────────┐
                    │           Shared VirtualFS (slicc-fs)    │
                    │  /shared/    /scoops/    /workspace/     │
                    └──────────┬──────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
        │  🍦 Cone   │   │ 💩 Scoop  │   │ 💩 Scoop  │
        │  (sliccy)  │   │ (andy)    │   │ (test)    │
        │  Full FS   │   │ Restricted│   │ Restricted│
        │  access    │   │ /scoops/  │   │ /scoops/  │
        │            │   │  andy/ +  │   │  test/ +  │
        │ delegate   │   │ /shared/  │   │ /shared/  │
        │ to scoops  │◄──│ notifies  │◄──│ notifies  │
        └────────────┘   └───────────┘   └───────────┘
```

Source layout:

| Directory | Purpose |
|-----------|---------|
| `src/scoops/` | Cone/scoops orchestrator, scoop contexts, NanoClaw tools, scheduling, DB |
| `src/ui/` | Browser UI — chat, terminal, file browser, memory, scoops panel, scoop switcher |
| `src/core/` | Agent types, tool registry, context compaction, session management |
| `src/tools/` | Tool implementations (file ops, search, browser, javascript) |
| `src/fs/` | Virtual filesystem (IndexedDB/LightningFS) + RestrictedFS |
| `src/shell/` | WebAssembly Bash shell + supplemental commands (node, python, sqlite) |
| `src/git/` | Git via isomorphic-git (clone, commit, push, pull, etc.) |
| `src/cdp/` | Chrome DevTools Protocol client (WebSocket + chrome.debugger) |
| `src/cli/` | CLI server — Chrome launch, CDP proxy, Express |
| `src/extension/` | Chrome extension service worker and type declarations |

## Getting Started

### Chrome Extension (recommended)

```bash
npm install
npm run build:extension

# Load dist/extension/ as unpacked extension in chrome://extensions
# Click the slicc icon → side panel opens
```

### Standalone CLI

```bash
npm install
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
| [ws](https://github.com/websockets/ws) | WebSocket for CDP proxy (CLI mode) |
| [@xterm/xterm](https://xtermjs.org/) | Terminal emulator in the browser |
| [fflate](https://github.com/101arrowz/fflate) | ZIP file creation for folder downloads |
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

# Build Chrome extension
npm run build:extension

# Type-check both CLI and browser code
npm run typecheck

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Git Commands

slicc includes Git support via [isomorphic-git](https://isomorphic-git.org/), enabling version control operations directly in the browser without touching the host filesystem.

### Available Commands

| Command | Description |
|---------|-------------|
| `git init` | Initialize a new repository |
| `git clone <url> [dir]` | Clone a repository (shallow clone by default) |
| `git add <file>` | Stage files for commit (use `.` for all) |
| `git status` | Show working tree status |
| `git commit -m "msg"` | Record changes to the repository |
| `git log [--oneline]` | Show commit history |
| `git branch [name]` | List or create branches |
| `git checkout <ref>` | Switch branches or restore files |
| `git diff` | Show changes between commits |
| `git remote [-v]` | List remote repositories |
| `git remote add <name> <url>` | Add a remote |
| `git fetch [remote]` | Download objects from remote |
| `git pull [remote]` | Fetch and merge changes |
| `git push [remote] [branch]` | Update remote refs |
| `git config <key> [value]` | Get/set configuration |
| `git rev-parse` | Parse git references |

### Authentication

For private repositories or to avoid GitHub rate limits on public repos, set a personal access token:

```bash
git config github.token ghp_YOUR_TOKEN_HERE
```

### Limitations

- **Shallow clones**: Repositories are cloned with `--depth 1` by default for performance
- **No merge/rebase**: Complex merge operations are not yet implemented
- **No LFS**: Large File Storage is not supported
- **Browser storage**: All repository data is stored in IndexedDB (LightningFS)

## Related Work

Part of the **[AI Ecoverse](https://github.com/ai-ecoverse)** — a comprehensive ecosystem of tools for AI-assisted development:
- [ai-aligned-git](https://github.com/ai-ecoverse/ai-aligned-git) — Git wrapper for safe AI commit practices
- [ai-aligned-gh](https://github.com/ai-ecoverse/ai-aligned-gh) — GitHub CLI wrapper for proper AI attribution
- [yolo](https://github.com/ai-ecoverse/yolo) — AI CLI launcher with worktree isolation
- [vibe-coded-badge-action](https://github.com/ai-ecoverse/vibe-coded-badge-action) — Badge showing AI-generated code percentage
- [gh-workflow-peek](https://github.com/ai-ecoverse/gh-workflow-peek) — Smarter GitHub Actions log filtering
- [upskill](https://github.com/ai-ecoverse/upskill) — Install Claude/Agent skills from other repositories
- [as-a-bot](https://github.com/ai-ecoverse/as-a-bot) — GitHub App token broker for proper AI attribution
- **slicc** — Browser-based coding agent (you are here)
