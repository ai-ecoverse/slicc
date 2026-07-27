# CLAUDE.md

This file covers the native macOS launcher in `packages/swift-launcher/`.

## Scope

`Sliccstart` is a SwiftUI launcher that finds supported browsers, Electron apps, and terminal emulators, starts the right SLICC runtime, and helps create debug-friendly Electron builds when needed.

## Build and Test Commands

```bash
cd packages/swift-launcher
swift build
swift test
swift run Sliccstart
npm run build
npm run lint -w @slicc/swift-launcher   # SwiftLint
./sign-and-package.sh
```

## Linting

`packages/swift-launcher/.swiftlint.yml` inherits the shared rule set from the
repo-root `.swiftlint.yml` (via `parent_config`) and excludes this package's
`.build`. Warnings surface code-quality issues; only `error`-severity violations
fail CI. Run `npm run lint:fix -w @slicc/swift-launcher` to auto-correct fixable
violations.

## Formatting

SwiftLint is a linter, not a formatter. Formatting is `swift format` (bundled with
the Swift 6+ toolchain) against the single repo-root `.swift-format`; swift-format
resolves its config by walking up from each input file, so there is no per-package
copy to keep in sync.

```bash
npm run lint:format -w @slicc/swift-launcher   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-launcher        # swift format --in-place
```

## Main Package Layout

- `Sliccstart/` — SwiftUI app entry, models, and views
- `SliccstartTests/` — package tests
- `assemble-app.mjs` — assembles the `.app` bundle from compiled binaries
- `sign-and-package.sh` — signing/packaging helper

## App Overview

- `SliccstartApp.swift` boots the launcher UI.
- `Models/AppScanner.swift` finds Chromium browsers and CDP-capable desktop apps.
- `Models/SliccBootstrapper.swift` and `Models/SliccProcess.swift` handle runtime launch and lifecycle.
- `Views/` contains the launcher UI and setup/progress views.

## Operational Telemetry (OpTel)

Sliccstart depends on `@slicc/swift-optel` and wires `.optelAutoInstrument(appID:)` once on the `WindowGroup` root in `SliccstartApp.swift`. On macOS that single call activates the full RUM surface: `enter` (launch + foreground), global `click` (app-level `NSEvent` monitor → `NSAccessibility`-derived `source`), `navigate` (key/main-window changes + new Settings window), and `error` (uncaught `NSException`). No per-control plumbing is needed in the launcher views.

The `appID` is sourced from `Bundle.main.bundleIdentifier` (`com.slicc.sliccstart`); RUM beacons land in `helix-225321.helix_rum.cluster` filtered by that hostname. The opt-in per-view modifiers (`.optelView`, `.optelTap`, `OptelButton`) and `Optel.reportError(_:)` remain available for finer-grained `source` quality or Swift-`Error` boundaries.

Key launcher controls carry stable `.accessibilityIdentifier` values (`get-extension`, `rescan`, `check-for-updates`, `restart-to-update`, `update`, `app-row-<Name>`) so RUM `click` sources stay readable across releases.

## App Scanning

- Known Chromium browsers are discovered by bundle ID.
- `/Applications` is scanned for Electron or WebView2-style app bundles with CDP-capable frameworks.
- `~/Applications` is scanned first for `* Debug.app` builds so patched debug builds win over originals.
- Terminal.app, iTerm2, Ghostty, WezTerm, kitty, and Alacritty are discovered by bundle ID. Installed terminals appear in a **Terminals** category between **Desktop Apps** and **Extension**.

## Terminal Followers

Terminal rows attach the selected terminal to the current leader through `slicc <join-url> follow`. They remain disabled until `leaderJoinUrl` is known and never auto-start a leader. The first launch warns that the leader can run commands on this machine; the user can persist suppression or reset it in Settings.

The **Terminals** Settings tab persists these `UserDefaults` keys:

- `terminalFollowCommand` — user-editable template with `{slicc}`, `{joinUrl}`, and `{shell}` placeholders; the default is `{slicc} {joinUrl} follow {shell} -c`.
- `suppressTerminalWarning` — one-time access-warning suppression.

`{shell}` is the login shell from the password database (`getpwuid`), falling back to `/bin/zsh`. The Settings preview always redacts the join URL.

`SliccCliLocator` resolves an executable in this order: the managed `~/Library/Application Support/Sliccstart/bin/slicc`, the repository's local `make build` output, its architecture-specific `make dist` output, then `/usr/local/bin`, `~/.local/bin`, and `/opt/homebrew/bin`. The CLI is never bundled in `Sliccstart.app`. If none is found, the launcher asks before downloading the current Darwin release from `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`, validates its Developer ID Application signature and release team identifier (`S8LB56P782`) before making it executable or running `--version`, then atomically installs it in the managed location. A successful terminal launch exposes that managed binary through `~/.local/bin/slicc`; the best-effort symlink step preserves regular files and unrelated user symlinks, and only re-points stale links under Sliccstart's own Application Support root.

Release Darwin binaries are Developer ID-signed with hardened runtime and notarized by `packages/slicc-cli/sign-and-package.sh`. A bare Mach-O executable cannot have a notarization ticket stapled, so a quarantined copy may require Apple's online Gatekeeper lookup on first execution. The launcher's `URLSession` data download followed by `Data.write` does not create or propagate `com.apple.quarantine`, so Sliccstart does not need to remove that attribute. Verification against the release channel also confirmed that a manually quarantined signed release binary runs `--version` without a Gatekeeper override. (`spctl --assess --type execute` is not a useful check here because it rejects bare CLI executables as “not an app.”)

Terminal.app and iTerm2 launch through Apple Events. `assemble-app.mjs` supplies the user-facing usage description, and `sign-and-package.sh` signs the outer app with `Sliccstart.entitlements`, including `com.apple.security.automation.apple-events`. A TCC denial is surfaced with a direct path to the Sliccstart controls in System Settings → Privacy & Security → Automation.

## Debug Build Creation

`Models/DebugBuildCreator.swift` creates Electron debug builds by:

1. copying the app into `~/Applications/<Name> Debug.app`
2. patching Electron fuses to allow remote debugging
3. unpacking and patching `app.asar` JavaScript checks that block CDP
4. ad-hoc signing the copied app
5. removing quarantine attributes

Use this path when an Electron app disables remote debugging in production builds.

## Packaging Notes

- `npm run build` assembles the `.app` bundle for manual testing from already-built artifacts.
- `sign-and-package.sh` is the packaging path for distributable artifacts.
- When running from inside the repo, the launcher expects the Swift server binary (`packages/swift-server/.build/release/slicc-server`) to already be built by the root-level tooling. The webapp is **not** bundled — the UI loads from the hosted origin, so `assemble-app.mjs` creates an empty `Contents/Resources/slicc` marker dir (which `SliccBootstrapper.resolveBundledSliccDir` still keys bundled-mode detection off of) instead of copying `dist/ui`.
- The **one** web artifact still embedded is the Electron overlay bootstrap. `copy-overlay-entry.mjs` copies `dist/ui/electron-overlay-entry.js` into `Contents/Resources/slicc/dist/ui/` so packaged `slicc-server --electron` loads the real overlay instead of its inline fallback. That file is produced by **`@ai-ecoverse/spoon`** (`npm run build -w @ai-ecoverse/spoon`), so it must be built before `assemble-app.mjs` runs — and a `packages/spoon/**` change is what re-triggers this job in CI (not a general webapp change).
- Packaging emits only the full `Sliccstart-<v>.zip`. There is no webapp-only smooth-update pair anymore.

## Updates

Updates are **full-app-only**, driven by the external `AppUpdater` SPM package (`import AppUpdater`). The launcher no longer ships a webapp-only "smooth update" path — with local UI serving removed (the UI loads from the hosted origin), there is nothing to hot-swap, so `UpdateManifest`, `RunningAppHashes`, `WebappOverlayStore`, `SmoothUpdateCoordinator`, and the `--probe-update` probe were all removed.

- `SliccstartApp.swift` owns an `AppUpdater` `@StateObject` and calls `appUpdater.check()`. When a newer release is downloaded, `appUpdater.downloadedAppBundle` is set and `AppListView.fullUpdateButton` surfaces the `restart-to-update` action that calls `appUpdater.install(bundle)`.
- `Models/UpdateHostConfiguration.swift` — parses `--update-host=<url>` argument or `SLICC_UPDATE_HOST` env, defaulting to `https://api.github.com`. `AppUpdater`'s releases listing routes through it.
- `Models/TolerantGithubReleaseProvider.swift` — the release provider used by `AppUpdater`; tolerates release-naming drift in the `ai-ecoverse/slicc` release history. It also filters out releases lacking an installable macOS asset (`Sliccstart-<version>.zip`/`.tar`), so `AppUpdater` falls back to the newest release that actually ships a binary (needed now that native artifacts are conditionally built).
- `Models/LaunchRecordStore.swift` — persisted `PersistedLaunchRecord` JSON (servePort, CDP port, electronAppPath, target name, target type, joinUrl, bridgeToken) at `~/Library/Application Support/Sliccstart/launch-records.json`, plus `CDPLiveProbe` for liveness checks via `/json/version`. No PID is stored — process identity isn't needed for reattach because the CDP port answering `/json/version` is what we use to decide whether the previous browser is still alive. The `bridgeToken` is persisted because the surviving browser tab carries it in its launch URL (`?bridgeToken=<token>`); reattach re-forwards the SAME token so the re-spawned `--serve-only` slicc-server keeps gating `/cdp` against the secret the tab already has, instead of a freshly-minted static one. (Legacy records carrying a `staticRoot` key still decode; the extra key is ignored, and a missing `bridgeToken`/`joinUrl` key loads as nil.)
- `Models/SliccProcess.swift` extensions: `detachAll()` and `reattachPersistedRecords()`. The launcher only ever spawns thin-bridge `slicc-server` processes — no `--static-root` / overlay plumbing.

## Update Tests

- `SliccstartTests/UpdateHostConfigurationTests.swift` — unit coverage for `--update-host` / `SLICC_UPDATE_HOST` parsing and defaulting.
- `SliccstartTests/UpdateCheckIntegrationTests.swift` — integration tests that hit the **real GitHub API** (via `TolerantGithubReleaseProvider`) to catch release-naming drift a frozen fixture could not. They share a single authenticated call (`GH_TOKEN`, set by `ci.yml` from `${{ github.token }}`) to stay inside the rate budget; without a token they fall back to the unauthenticated path and may flake under contention.
