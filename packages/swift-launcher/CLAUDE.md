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

The `appID` is sourced from `Bundle.main.bundleIdentifier` (`com.slicc.sliccstart`); RUM beacons land in `helix-225321.helix_rum.cluster` filtered by that hostname. The opt-in per-view modifiers (`.optelView`, `.optelTap`, `OptelButton`) remain available for finer-grained `source` quality.

`.optelAutoInstrument`'s `error` hook only catches Objective-C `NSException`s — Swift errors are values and cannot be intercepted globally — so the launcher's `do/catch` boundaries report through **`Models/LauncherErrorReport.swift`**:

- `LauncherErrorReport.report(.<operation>, error)` emits an `error` checkpoint with `source = sliccstart:<operation>` (see the `Operation` enum: `update-check`, `update-detach`, `bootstrap`, `bootstrap-update`, `launch-standalone`, `launch-electron`, `auto-launch`, `debug-build`, `terminal-follower`, `reattach`, `secrets-unlock`, `secrets-persist`). Dashboards filter on these strings, so treat them as a wire contract.
- `target` is the bridged error domain plus its description, **redacted** before it leaves the machine: URLs collapse to `<url>` (a join URL carries the session secret), absolute paths to `<path>` (home reveals the user name), `token`/`secret`/`password`/`key` values to `<redacted>`, whitespace collapses, and the result truncates to `maxTargetLength`.
- Add a new call site together with an `Operation` case and a `log.error` line; never report the up-to-date outcome of an update check (`AUError.cancelled`), which is a normal result rather than a fault.
- `Optel.sample` no-ops until `.optelAutoInstrument` has configured a session, so reporting from a failure that happens before instrumentation mounts (or from a unit test) is safe.

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

## iCloud Sync (Tray Sessions)

Cross-device discovery of active tray join URLs, so a leader started on one
Mac can be joined from another device without hand-copying its join URL. The
data model is Foundation-only and platform-agnostic so the iOS follower
(`packages/ios-app`) can reuse it verbatim when it gains sync.

- `Models/SyncedTraySession.swift` — one advertised session: `id` (the
  **SHA-256 of the join URL** — stable for upsert/dedup but opaque, so it is
  safe in accessibility identifiers / telemetry `source`; the raw `joinUrl`
  carries the secret and is never surfaced to telemetry), `joinUrl`, `label`,
  `deviceId` (stable per-device UUID for ownership), `deviceName` (display
  only), `createdAt`, `lastSeenAt`, plus `isStale(ttl:now:)`. `CryptoKit` +
  Foundation only; no AppKit/UIKit. Legacy payloads without `deviceId` decode
  (empty).
- `Models/TraySessionSyncStore.swift` — `@Observable` store over a
  `KeyValueSyncBackend`. Default backend is `UbiquitousKeyValueBackend`
  (`NSUbiquitousKeyValueStore`); tests inject `InMemoryKeyValueBackend` so no
  unit test touches iCloud. **Each device writes its own sessions under a
  per-device key `storageKeyPrefix + deviceId` and reads the union of all such
  keys** (`keys(withPrefix:)`), so two devices publishing at once never
  clobber each other's advertisement and same-host-name Macs stay distinct.
  Ownership (local vs remote) keys on `deviceId`, not host name;
  `withdrawLocalSessions()` clears only this device's key. Prunes stale entries
  by `defaultTTL` (12h) on every load, caps the merged view at `maxSessions`
  (64, newest first), and registers a `didChangeExternallyNotification`
  observer so the UI redraws when another device pushes a change. Pure logic
  (`active(from:)`, `upsert(_:into:)`) is static and unit-tested.
- **Producer** — `SliccstartApp` publishes on `sliccProcess.leaderJoinUrl`
  becoming non-nil (label = `SliccProcess.leaderTargetName`) and withdraws
  when it clears. A 4-hour timer re-publishes a still-running leader so it
  never ages out of the 12h TTL. `SliccstartAppDelegate.applicationWillTerminate`
  withdraws local sessions on the clean-quit path but **not** on the
  update/detach path (the browser survives, so the relaunched Sliccstart
  republishes after reattach).
- **Consumer** — `AppListView`'s "iCloud Sessions" section lists remote
  sessions (device + age) with three actions: Copy-join-URL,
  Attach-a-browser-as-follower, and Follow-in-Terminal. This device's own
  sessions are read-only (copy only). Each row's icon overlays the matching
  local browser's icon (matched by `label`/name) over an `icloud` badge when
  that browser is installed. Follow reuses the terminal follower flow via
  `SliccProcess.launchTerminalFollower(_:joinURLOverride:)`, which skips the
  local-leader readiness gate when an override is supplied so it can attach to
  a **remote** leader. Attach-browser launches the **top** browser via
  `SliccProcess.launchBrowserFollower(_:joinUrl:)`.

## App Ordering, Browser Followers, and Startup

- `Models/AppOrdering.swift` — pure ordering for the Browsers and Terminals
  lists: `browserBundlePriority` (market share, Chrome first) and
  `terminalBundlePriority` (power-user terminals before Terminal.app) supply
  the defaults; a user drag-reorder is persisted by `AppOrderStore` (UserDefaults
  keys `browserOrder`/`terminalOrder`, bundle-id arrays) and wins over the
  default. `AppTarget.bundleId` is the ordering/matching key (populated by
  `AppScanner` for known browsers/terminals/electron apps; `nil` for
  CDP-sniffed electron apps). `AppListView` drag-reorders via the
  `ReorderableRow` modifier (`.onDrag`/`.onDrop`, live reorder on hover).
- **Browser as follower** — `SliccProcess.browserFollowerArgs(cdpPort:joinUrl:)`
  passes `--join=<url>` (vs standalone's `--lead`) so swift-server opens the
  browser attached to a **remote** tray. `launchBrowserFollower` flags the
  `LaunchRecord` `isFollower = true`, which excludes it from `isLeaderReady`,
  `leaderTargetName`, leader-URL clearing, and the smooth-update reattach
  snapshot (a follower is not this device's leader). Clicking a browser row
  with remote sessions present opens a confirmation dialog (lead vs attach);
  with none it launches standalone (unchanged single-Mac flow).
- **Startup** — `Models/StartupPreference.swift` replaces the per-browser
  auto-launch picker with the `launchBrowserAtStartup` boolean (Settings >
  Startup checkbox). `resolveEnabled(defaults:)` migrates the legacy
  `autoLaunchAppId` (non-empty == enabled) once. On launch the app starts the
  **top** browser of the ordered Browsers list.
- Tests: `AppOrderingTests`, `StartupPreferenceTests`,
  `SliccProcessLaunchArgsTests` (browser-follower args), and
  `SliccProcessLeaderGatingTests` (follower does not gate as leader).
- **Security** — join URLs carry the session secret. They sync through the
  user's own iCloud key-value store (encrypted, same-Apple-ID devices only),
  which the user has accepted for this feature.
- Tests: `SliccstartTests/TraySessionSyncTests.swift`.

### iCloud provisioning (Developer ID app)

The code above runs today but **does not sync** until the app is signed with an
iCloud KVS entitlement backed by an _embedded_ provisioning profile. Sliccstart
is Developer ID-signed and notarized (team `S8LB56P782`), distributed outside
the App Store, so Developer ID signing alone does not authorize iCloud.

`sign-and-package.sh` handles this via the optional **`PROVISION_PROFILE`** env
var (path to the downloaded `.provisionprofile`):

- **unset** (default, incl. current CI): signs against `Sliccstart.entitlements`
  only. No iCloud; `NSUbiquitousKeyValueStore` degrades to a local cache, so
  builds stay valid.
- **set**: embeds the profile at `Contents/embedded.provisionprofile` and signs
  against a merged entitlements file (base + `com.apple.developer.ubiquity-kvstore-identifier`).
  The base entitlements file is never mutated.

The KVS bucket namespace (`ubiquity-kvstore-identifier`) defaults to
`${APPLE_TEAM_ID}.com.slicc.sliccstart` and is overridable via the
**`KVSTORE_IDENTIFIER`** env var. This is the value the code actually keys the
sync bucket on and the value the future iOS follower must match to share it, so
a brand-neutral value like `S8LB56P782.ai.sliccy.trays` is preferable — but the
auto-generated Developer ID profile pins the bundle-id form, so a custom value
must be verified at sign time (the outer `codesign` fails if the embedded
profile does not authorize it). The **iCloud container** is separate: it only
matters for CloudKit (unused here), so it can be any `iCloud.<reverse-dns>` you
own (e.g. `iCloud.ai.sliccy`) with no code impact.

One-time portal setup:

1. Enable **iCloud** on the `com.slicc.sliccstart` App ID (attach an iCloud
   container, e.g. `iCloud.ai.sliccy`; key-value storage rides along).
2. Create a **Developer ID** distribution **provisioning profile** (App
   variant) for that App ID + the Developer ID Application cert; download it.

Local signed build with sync:

```bash
APPLE_TEAM_ID=S8LB56P782 APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... \
  PROVISION_PROFILE=/path/to/Sliccstart_DeveloperID_iCloud.provisionprofile \
  ./sign-and-package.sh
```

Then verify sync between two devices on the same Apple ID (both signed into
iCloud). To enable in CI, add the profile as a base64 secret, decode it to a
file in the release job, and export `PROVISION_PROFILE` before the script runs.
Signing contract is covered by `macos-permissions.test.mjs`.

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

- `SliccstartApp.swift` owns an `AppUpdater` `@StateObject` and drives every check through `checkForUpdates()`, which records the outcome in `UpdateCheckStatus` and logs it. When a newer release is downloaded, `appUpdater.downloadedAppBundle` is set and `AppListView.fullUpdateButton` surfaces the `restart-to-update` action that calls `appUpdater.install(bundle)`.
- `Models/UpdateCheckStatus.swift` — the footer's report on the last check (`idle`, `checking`, `upToDate`, `noInstallableRelease`, `failed(message)`). `AppUpdater` hands every failure to a callback and otherwise only publishes a downloaded bundle, so without this a rate-limited or asset-less check was indistinguishable from "never checked" and the footer just kept offering "Check for Updates". `AUError.cancelled` maps to `upToDate` (that is how `findViableUpdate` says "nothing newer"), `AppUpdater.Error.noValidUpdate` to `noInstallableRelease`.
- `Models/UpdateHostConfiguration.swift` — parses `--update-host=<url>` argument or `SLICC_UPDATE_HOST` env, defaulting to `https://api.github.com`. `AppUpdater`'s releases listing routes through it.
- `Models/TolerantGithubReleaseProvider.swift` — the release provider used by `AppUpdater`; tolerates release-naming drift in the `ai-ecoverse/slicc` release history. It also filters out releases lacking an installable macOS asset (`Sliccstart-<version>.zip`/`.tar`), so `AppUpdater` falls back to the newest release that actually ships a binary (needed now that native artifacts are conditionally built). Because the repo releases many times a day while the macOS artifact is built only on `packages/swift-launcher/**` changes, the newest installable release routinely sits beyond the default 30-release page: the provider requests `per_page=100` and follows the RFC 8288 `Link: rel="next"` chain (same host, HTTP(S) only) until a page yields a viable release **or reaches `currentVersion`** — the release the running build came from, since nothing older can ever be an update. "Reached" is not "saw an older tag": `/releases` is creation-ordered, so a backport published after a newer release, or a non-semver tag decoding to `Version.null`, would otherwise stop page one and hide the installable release further back. `hasReached(_:on:)` therefore stops only when the page carries the running build's own version or when every _parsed_ release on it is older, ignoring unparsable tags. `maxReleasePages` is only a loop guard for a host whose `Link` chain never terminates, not the intended stop. `currentVersion` defaults to `Bundle.main.version` (the same value `AppUpdater` compares against) and `fetchPage` injects a stub transport; both are pinned in tests because the XCTest host bundle's version is unrelated to the release history.
- `Models/LaunchRecordStore.swift` — persisted `PersistedLaunchRecord` JSON (servePort, CDP port, electronAppPath, target name, target type, joinUrl, bridgeToken) at `~/Library/Application Support/Sliccstart/launch-records.json`, plus `CDPLiveProbe` for liveness checks via `/json/version`. No PID is stored — process identity isn't needed for reattach because the CDP port answering `/json/version` is what we use to decide whether the previous browser is still alive. The `bridgeToken` is persisted because the surviving browser tab carries it in its launch URL (`?bridgeToken=<token>`); reattach re-forwards the SAME token so the re-spawned `--serve-only` slicc-server keeps gating `/cdp` against the secret the tab already has, instead of a freshly-minted static one. (Legacy records carrying a `staticRoot` key still decode; the extra key is ignored, and a missing `bridgeToken`/`joinUrl` key loads as nil.)
- `Models/SliccProcess.swift` extensions: `detachAll()` and `reattachPersistedRecords()`. The launcher only ever spawns thin-bridge `slicc-server` processes — no `--static-root` / overlay plumbing.

## Update Tests

- `SliccstartTests/UpdateHostConfigurationTests.swift` — unit coverage for `--update-host` / `SLICC_UPDATE_HOST` parsing and defaulting.
- `SliccstartTests/UpdateCheckIntegrationTests.swift` — integration tests that hit the **real GitHub API** (via `TolerantGithubReleaseProvider`) to catch release-naming drift a frozen fixture could not, including a `per_page=1` walk that proves the `Link: rel="next"` pagination reaches an installable release. They share a single authenticated call (`GH_TOKEN`, set by `ci.yml` from `${{ github.token }}`) to stay inside the rate budget; without a token — or with an **empty** one — they fall back to the unauthenticated path and may flake under contention.
- `SliccstartTests/ReleaseFetchPaginationTests.swift` — stubbed-transport coverage for the paginated walk: follows `Link` headers until a viable release appears, stops on the first page that has one, stops at the page holding the running build's release, keeps auth on every page, honours the page budget, and rejects off-host or non-HTTP(S) `rel="next"` targets.
- `SliccstartTests/UpdateCheckStatusTests.swift` — error-to-status mapping so no check outcome can be swallowed silently.
- `SliccstartTests/LauncherErrorReportTests.swift` — RUM beacon contract: stable `source` keys and the redaction/truncation rules applied to `target`.
