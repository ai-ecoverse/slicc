# Sliccstart

Native macOS launcher for SLICC. Detects Chromium browsers and Electron apps,
launches them with SLICC attached.

## Requirements

- macOS 14+
- Node.js 22+ (LTS)
- Xcode 15+ or Swift 5.9+ (to build from source)

## Build & Run

```bash
cd sliccstart
swift build
swift run Sliccstart
```

## First Launch

On first run, Sliccstart clones the SLICC repository to `~/.slicc/slicc/`
and builds it. This takes 2-3 minutes. Subsequent launches are instant.

## Features

- **Launch browser**: Click any Chromium browser to start SLICC CLI server
  with that browser (like `npm run dev:full` but with browser choice).
- **Launch Electron app**: Click any Electron app to attach SLICC as an
  overlay (like `npm run dev:electron`).
- **Install extension**: Click the puzzle piece icon next to Chrome to
  permanently install the SLICC extension via CDP pipe.
- **Update**: Click "Update SLICC" to pull latest changes and rebuild.

## Architecture

Sliccstart is a thin GUI. All intelligence lives in SLICC's TypeScript code:

| Action | What Sliccstart runs |
|--------|---------------------|
| Launch browser | `node dist/cli/index.js --cdp-port=9222` with `CHROME_PATH` env |
| Launch Electron | `node dist/cli/index.js --electron /path/to/app --kill` |
| Install extension | `node dist/cli/install-extension.js --chrome-path=... --extension-path=...` |
| Update | `git pull && npm install && npm run build && npm run build:extension` |

The extension install strategy is in TypeScript (`src/cli/install-extension.ts`)
so it can be updated via `git pull` without rebuilding the native app.
