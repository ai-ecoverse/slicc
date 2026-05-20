# Sliccstart

Native macOS launcher for SLICC. Detects Chromium browsers and Electron apps,
launches them with SLICC attached.

## Requirements

- macOS 14+
- Node.js 22+ (LTS, for development bootstrap/build tasks)
- Swift 5.10+ (Command Line Tools or Xcode)

## Quick Start

### Prerequisites

Before building the launcher, ensure these are built from the repo root:

- `npm run build -w @slicc/webapp` (produces `dist/ui`)
- `cd packages/swift-server && swift build -c release` (produces the server binary)

Or simply run `npm run build` from the repo root, which builds everything in the correct order.

```bash
# Build the .app bundle
cd packages/swift-launcher
npm run build

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
cd packages/swift-launcher
swift build           # Build
swift run Sliccstart  # Run from terminal (no .app bundle)
```

## First Launch

If Sliccstart is run from outside the SLICC repo, it clones the repository
to `~/.slicc/slicc/` and builds it on first run (2-3 minutes).

If run from inside the SLICC repo (e.g., `packages/swift-launcher/build/Sliccstart.app`),
it auto-detects the local checkout and uses it directly — no clone needed.
You still need to build SLICC first: `npm install && npm run build && npm run build:extension`
and build the native server: `cd packages/swift-server && swift build`

## Features

- **Launch browser**: Click any Chromium browser to start SLICC CLI server
  with that browser (standalone mode, temporary profile).
  Supported bundle IDs include Chrome stable/beta/dev/canary, Chrome for
  Testing, Edge stable/beta/dev/canary, Brave stable/beta/nightly, Vivaldi,
  Arc, Dia, ChatGPT Atlas, Opera, and Chromium.
- **Launch Electron app**: Click any Electron app to attach SLICC as a
  side panel overlay. Multiple apps can run simultaneously on separate ports.
  If the app is already running without a known SLICC debug port, Sliccstart
  offers to restart it with remote debugging enabled. If a previously launched
  Electron app exits, Sliccstart clears the stale running state on the next
  refresh/click so it can be started again. Status dots are refreshed
  periodically while Sliccstart is open and again whenever Sliccstart regains
  focus, so quitting an Electron app externally updates the row promptly.
- **Get extension**: Opens the Chrome Web Store listing to install the
  SLICC extension directly — no Developer Mode required.
- **Update**: Pulls latest SLICC changes and rebuilds with one click.

## Architecture

Sliccstart is a thin GUI. All SLICC intelligence stays in TypeScript:

| Action          | What Sliccstart runs                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| Launch browser  | `node dist/node-server/index.js --cdp-port=9222` with `CHROME_PATH` env (port 5710) |
| Launch Electron | `node dist/node-server/index.js --electron /path/to/app --kill` (port 5711+)        |
| Get extension   | Opens Chrome Web Store listing in Chrome                                            |
| Update          | `git pull && npm install && npm run build`                                          |

Each browser/Electron instance gets its own port (5710 for browser, 5711+ for
Electron apps), so you can run multiple apps simultaneously.

## Ports

| Port  | Purpose                                |
| ----- | -------------------------------------- |
| 5710  | Browser standalone mode                |
| 5711+ | Electron app instances (auto-assigned) |
| 9222  | Chrome CDP (browser mode)              |
| 9223+ | Electron CDP (auto-assigned)           |

## Smooth Updates

Sliccstart applies releases without killing the browsers/Electron apps it
launched:

1. **Detach** — on quit-to-update, Sliccstart sends `SIGUSR1` to every
   `slicc-server` it spawned. Each server shuts down its HTTP listener but
   **leaves the browser/Electron CDP session open**. The serve port, CDP
   port, target name/type, optional Electron app path, and optional UI
   overlay path are persisted to
   `~/Library/Application Support/Sliccstart/launch-records.json`.
2. **Reattach** — on next launch, Sliccstart probes the persisted CDP
   ports via `/json/version`. For ports that are still live it respawns
   `slicc-server --serve-only` on the original `PORT`, so the browser
   reconnects to the same overlay it was using.
3. **Webapp-only updates** — releases ship a `manifest-<v>.json` listing
   sha256 hashes of `Sliccstart`, `slicc-server`, and the webapp bundle.
   If the running binaries already match, Sliccstart downloads
   `webapp-<v>.zip`, unpacks it into a versioned overlay, flips the
   active pointer, and respawns `slicc-server` with `--static-root=<overlay>`
   — Sliccstart itself never restarts.

### `--update-host` (testing / staging)

Both the release-asset resolver and the underlying `AppUpdater` look up
releases under a configurable host. By default that's
`https://api.github.com`, but you can redirect every updater HTTP call to
any base URL:

```bash
# CLI argument (preferred for local repro)
open build/Sliccstart.app --args --update-host=http://127.0.0.1:9999

# Or via environment variable
SLICC_UPDATE_HOST=http://127.0.0.1:9999 open build/Sliccstart.app
```

The host must expose the same three shapes the production endpoint does:

| Path                                      | Returns                              |
| ----------------------------------------- | ------------------------------------ |
| `/repos/<owner>/<repo>/releases`          | JSON array of GitHub release objects |
| `<asset.browser_download_url>` (manifest) | `manifest-<v>.json` body             |
| `<asset.browser_download_url>` (webapp)   | `webapp-<v>.zip` body                |

The release JSON's `tag_name` must start with `Sliccstart-` (e.g.
`Sliccstart-2.54.0`). The test target ships `FakeUpdateServer` (POSIX
sockets, loopback) and `UpdateTestFixtures` for end-to-end coverage; see
`SliccstartTests/EndToEndUpdateTests.swift` for a reference fixture layout.

### `--probe-update` (headless update driver)

The `Sliccstart` binary also accepts `--probe-update`, which skips the
SwiftUI entry point and instead drives the same updater pipeline that
the GUI would, writing a JSON summary to stdout and exiting. This is
what `SliccstartTests/UpdaterIntegrationTests.swift` uses to drive the
shipping binary against `FakeUpdateServer` from `swift test` — so the
**same binary** users launch is exercised end-to-end in CI rather than
just the modules in isolation.

```bash
.build/debug/Sliccstart --probe-update \
  --update-host=http://127.0.0.1:9999 \
  --overlay-root=/tmp/sliccstart-overlays \
  --running-sliccstart-hash=<sha256 of running Sliccstart binary> \
  --running-server-hash=<sha256 of running slicc-server binary> \
  --running-webapp-hash=<sha256 of running dist/ui tree> \
  --mode=apply
# {"state":"applied","version":"9.9.9","overlayPath":"...","respawnCount":1}
```

`--mode=detect` stops after the manifest comparison; `--mode=apply`
continues through download → hash check → overlay activation. Exit
codes: `0` for any terminal state the coordinator reaches (including
`failed`, so the test can assert on the JSON instead of guessing), `2`
for argument errors.
