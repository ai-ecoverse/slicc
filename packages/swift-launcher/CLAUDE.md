# CLAUDE.md

This file covers the native macOS launcher in `packages/swift-launcher/`.

## Scope

`Sliccstart` is a SwiftUI launcher that finds supported browsers and Electron apps, starts the right SLICC runtime, and helps create debug-friendly Electron builds when needed.

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

Key launcher controls carry stable `.accessibilityIdentifier` values (`get-extension`, `rescan`, `check-for-updates`, `apply-ui-update`, `restart-to-update`, `update`, `app-row-<Name>`) so RUM `click` sources stay readable across releases.

## App Scanning

- Known Chromium browsers are discovered by bundle ID.
- `/Applications` is scanned for Electron or WebView2-style app bundles with CDP-capable frameworks.
- `~/Applications` is scanned first for `* Debug.app` builds so patched debug builds win over originals.

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
- When running from inside the repo, the launcher expects the webapp and extension artifacts (`dist/ui`) and the Swift server binary (`packages/swift-server/.build/release/slicc-server`) to already be built by the root-level tooling.
- The packaging step also emits a smooth-update pair: `webapp-<v>.zip` (deterministic `ditto -c -k` of `dist/ui`) and `manifest-<v>.json` (sha256s of `Sliccstart`, `slicc-server`, and the webapp tree). Both are uploaded as release assets alongside the full `Sliccstart-<v>.zip`.

## Smooth-Update Modules

- `Models/LaunchRecordStore.swift` — persisted `PersistedLaunchRecord` JSON (servePort, CDP port, electronAppPath, staticRoot, target name, target type) at `~/Library/Application Support/Sliccstart/launch-records.json`, plus `CDPLiveProbe` for liveness checks via `/json/version`. No PID is stored — process identity isn't needed for reattach because the CDP port answering `/json/version` is what we use to decide whether the previous browser is still alive.
- `Models/UpdateManifest.swift` — `UpdateManifest`, `RunningAppHashes`, streaming `sha256File` / deterministic `sha256Directory`, `ReleaseAssetResolver`, `UpdateManifestFetcher`.
- `Models/WebappOverlayStore.swift` — versioned overlays under `~/Library/Application Support/Sliccstart/ui-overlays/` with an `active.json` pointer, atomic activation, and prune.
- `Models/SmoothUpdateCoordinator.swift` — `@Observable` state machine driving the UI-only update flow (`idle / checking / noUpdate / fullUpdateRequired / webappOnlyAvailable / applying / applied / failed`).
- `Models/UpdateHostConfiguration.swift` — parses `--update-host=<url>` argument or `SLICC_UPDATE_HOST` env, defaulting to `https://api.github.com`. All updater HTTP calls (including `AppUpdater` releases listing) route through it.
- `Models/SliccProcess.swift` extensions: `detachAll()`, `reattachPersistedRecords()`, `respawnAllForOverlayChange()`, plus the `isPreparingForUpdate` flag consumed by `applicationWillTerminate`.

The companion `slicc-server` change is a `SIGUSR1` handler (see `packages/swift-server/Sources/Server/GracefulShutdown.swift`) that runs the shutdown sequence with `closeBrowser: false`, so the browser/Electron CDP session survives across the binary swap.

## Test Fixtures

- `SliccstartTests/Support/FakeUpdateServer.swift` — POSIX-socket loopback HTTP/1.1 server (NWListener returned EINVAL under `swift test`, hence the raw-socket path) with route handlers and request recording.
- `SliccstartTests/Support/UpdateTestFixtures.swift` — builds a self-contained "release" on disk (ditto-zipped webapp, real manifest JSON) and registers all three endpoints on the fake server, exposing a pre-configured `UpdateHostConfiguration`.

`SliccstartTests/EndToEndUpdateTests.swift` exercises the resolver, no-update / full-update / webapp-only paths, hash mismatch handling, 5xx failure handling, empty release lists, and forwarded auth headers — all through real `URLSession` traffic.

## `--probe-update` and Integration Tests

The `Sliccstart` binary has a headless probe mode. When invoked with `--probe-update`, control branches into `Sliccstart/Probe/UpdateProbeCommand.swift` before SwiftUI starts, the updater pipeline runs against the configured `UpdateHostConfiguration`, a JSON snapshot is written to stdout, and the process exits. CLI args mirror the modules involved: `--update-host`, `--overlay-root`, `--owner`, `--repo`, `--release-prefix`, `--mode={detect|apply}`, and the three running-app hashes (`--running-sliccstart-hash`, `--running-server-hash`, `--running-webapp-hash`).

`SliccstartTests/UpdaterIntegrationTests.swift` launches the built binary as a subprocess against `FakeUpdateServer` and asserts on the JSON output, the overlay directory on disk, and the request count seen by the server. This is the integration-level coverage for the updater: the **same binary** that ships to users is what runs in CI, not just the modules in isolation.
