# Sliccstart

Native macOS launcher for SLICC. Detects Chromium browsers and Electron apps,
launches them with SLICC attached.

## Requirements

- macOS 14+
- Node.js 22+ (LTS)
- Swift 5.9+ (Command Line Tools or Xcode)

## Quick Start

```bash
# Build the .app bundle
cd sliccstart
./build-app.sh

# Strip quarantine (unsigned app)
xattr -cr build/Sliccstart.app

# Run it
open build/Sliccstart.app
```

Optionally install to Applications:
```bash
cp -r build/Sliccstart.app /Applications/
```

## Development

```bash
cd sliccstart
swift build           # Build
swift run Sliccstart  # Run from terminal (no .app bundle)
```

## First Launch

If Sliccstart is run from outside the SLICC repo, it clones the repository
to `~/.slicc/slicc/` and builds it on first run (2-3 minutes).

If run from inside the SLICC repo (e.g., `sliccstart/build/Sliccstart.app`),
it auto-detects the local checkout and uses it directly — no clone needed.
You still need to build SLICC first: `npm install && npm run build`

## Features

- **Launch browser**: Click any Chromium browser to start SLICC CLI server
  with that browser (standalone mode, temporary profile).
- **Launch Electron app**: Click any Electron app to attach SLICC as a
  side panel overlay. Multiple apps can run simultaneously on separate ports.
- **Get extension**: Opens the Chrome Web Store listing to install the
  SLICC extension directly — no Developer Mode required.
- **Update**: Pulls latest SLICC changes and rebuilds with one click.

## Architecture

Sliccstart is a thin GUI. All SLICC intelligence stays in TypeScript:

| Action | What Sliccstart runs |
|--------|---------------------|
| Launch browser | `node dist/cli/index.js --cdp-port=9222` with `CHROME_PATH` env (port 5710) |
| Launch Electron | `node dist/cli/index.js --electron /path/to/app --kill` (port 5711+) |
| Get extension | Opens Chrome Web Store listing in Chrome |
| Update | `git pull && npm install && npm run build` |

Each browser/Electron instance gets its own port (5710 for browser, 5711+ for
Electron apps), so you can run multiple apps simultaneously.

## Ports

| Port | Purpose |
|------|---------|
| 5710 | Browser standalone mode |
| 5711+ | Electron app instances (auto-assigned) |
| 9222 | Chrome CDP (browser mode) |
| 9223+ | Electron CDP (auto-assigned) |
