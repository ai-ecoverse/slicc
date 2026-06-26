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

## Updates

Updates are **full-app-only**, driven by the external `AppUpdater` SPM
package. With local UI serving removed (the UI loads from the hosted
origin) there is nothing to hot-swap, so the previous webapp-only "smooth
update" path — `manifest-<v>.json` + `webapp-<v>.zip` + `--static-root`
overlay hot-swap — was removed along with `UpdateManifest`,
`RunningAppHashes`, `WebappOverlayStore`, `SmoothUpdateCoordinator`, and the
`--probe-update` probe. Releases now emit only the full `Sliccstart-<v>.zip`.

1. **Check** — `SliccstartApp.swift` owns an `AppUpdater` `@StateObject`
   and calls `appUpdater.check()` against the configured update host.
2. **Download** — when a newer release is found, `AppUpdater` downloads the
   full `Sliccstart-<v>.zip` and sets `appUpdater.downloadedAppBundle`.
3. **Install** — `AppListView.fullUpdateButton` surfaces the
   `restart-to-update` action, which calls `appUpdater.install(bundle)` to
   swap in the new app and relaunch. Persisted launch records
   (`~/Library/Application Support/Sliccstart/launch-records.json`) let the
   relaunched app reattach to any browser/Electron CDP sessions that are
   still live (probed via `/json/version`).

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

The host must expose the shapes the production endpoint does:

| Path                             | Returns                              |
| -------------------------------- | ------------------------------------ |
| `/repos/<owner>/<repo>/releases` | JSON array of GitHub release objects |
| `<asset.browser_download_url>`   | `Sliccstart-<v>.zip` (full app) body |

The release JSON's `tag_name` must start with `Sliccstart-` (e.g.
`Sliccstart-2.54.0`). `SliccstartTests/UpdateHostConfigurationTests.swift`
covers `--update-host` / `SLICC_UPDATE_HOST` parsing, and
`SliccstartTests/UpdateCheckIntegrationTests.swift` hits the real GitHub API
through `TolerantGithubReleaseProvider` to catch release-naming drift that a
frozen fixture could not.
