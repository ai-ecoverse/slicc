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

Release Darwin binaries are signed and notarized, but a bare Mach-O gets no stapled ticket: [`docs/pitfalls.md`](../../docs/pitfalls.md) § "Downloaded `slicc` CLI" covers why Sliccstart neither strips quarantine nor trusts `spctl`.

Terminal.app and iTerm2 launch through Apple Events. `assemble-app.mjs` supplies the user-facing usage description, and `sign-and-package.sh` signs the outer app with `Sliccstart.entitlements`, including `com.apple.security.automation.apple-events`. A TCC denial is surfaced with a direct path to the Sliccstart controls in System Settings → Privacy & Security → Automation.

## iCloud Sync (Tray Sessions)

Cross-device discovery of active tray join URLs. Shared models
(`SyncedTraySession`, `TraySessionSyncStore`, `SessionReachability`) live in
**`packages/swift-traysession`**; its `CLAUDE.md` documents storage, TTL, and tests.

`SessionReachability` follows bounded `TRAY_SUPERSEDED` chains; only terminal
HTTP 200 with `leader.connected == true` is live. Replacement URLs stay private.

- **Producer** — `SliccstartApp` publishes non-nil `leaderJoinUrl`, withdraws
  when cleared, and refreshes every 4 hours. Clean quit withdraws; update/detach
  does not because the browser survives and relaunch republishes.
- **Consumer** — `AppListView` probes remote rows on section appearance/store
  reload and stably sorts live/unprobed first. Unreachable rows use
  `icloud.slash`, `· not responding`, 0.55 opacity, and disable Attach/Follow,
  not Copy; local rows skip probing. Remote Follow passes a join URL override;
  Attach-browser uses `launchBrowserFollower`.
- **Security** — secret-bearing join URLs sync only through same-Apple-ID,
  encrypted iCloud KVS. `TraySessionLauncherTests` covers row state and Follow.

### Headless CLI (`Sliccstart --list-sessions`)

The iCloud store is readable only by this signed, iCloud-entitled binary, so the
Go `slicc` CLI shells out to a subcommand parsed in `main.swift` **before** the
SwiftUI app boots (`TraySessionCLI.parse` returns `nil` for a normal launch).
`--list-sessions` prints active sessions as JSON, **metadata only** (`joinUrl`
redacted). `--reveal-urls` adds `joinUrl` behind a **consent gate**: a remembered
"Always" (`UserDefaults`, keyed by caller code-signing id / path) wins; else an
`NSAlert` (Deny / Allow Once / Always Allow / Always Deny) shows in a GUI session
and a headless/SSH caller is **denied** (exit 3). Pure logic in
`Models/TraySessionCLI.swift` is unit-tested (`TraySessionCLITests`); untestable
glue (NSAlert, `getppid`/`proc_pidpath`/`SecCode`, store read) sits in
`TraySessionCLIRunner`. Caller identity is spoofable, so redaction-by-default is
the real control and the dialog a speed bump.

## App Ordering, Browser Followers, and Startup

- `Models/AppOrdering.swift` — pure default ordering (`browserBundlePriority`
  market-share, `terminalBundlePriority` power-user-first); a user drag-reorder
  persists via `AppOrderStore` (UserDefaults `browserOrder`/`terminalOrder`,
  bundle-id arrays) and wins. `AppTarget.bundleId` (populated by `AppScanner`;
  `nil` for CDP-sniffed electron apps) is the ordering/matching key.
  `AppListView` drag-reorders via the `ReorderableRow` modifier
  (`.onDrag`/`.onDrop`), keyed off the on-screen order so newly installed apps
  are draggable too.
- **Browser as follower** — `browserFollowerArgs(cdpPort:joinUrl:)` passes
  `--join=<url>` (vs `--lead`). `launchBrowserFollower` flags the record
  `isFollower`, excluding it from `isLeaderReady`, `leaderTargetName`,
  leader-URL clearing, and reattach. Clicking a browser with remote sessions
  opens a lead-vs-attach dialog; with none it launches standalone.
- **Startup** — `Models/StartupPreference.swift`: the `launchBrowserAtStartup`
  checkbox replaces the per-browser picker; `resolveEnabled(defaults:)` migrates
  legacy `autoLaunchAppId` once; launch starts the **top** ordered browser
  (`AppOrdering.topBrowser`, shared with the link handler).
- Tests: `AppOrderingTests`, `StartupPreferenceTests`, `SliccProcessLaunchArgsTests`.

## Default Browser Role

Sliccstart can hold the macOS http/https handler role (Settings → Startup).
`Models/DefaultBrowserRegistration.swift` claims it, `assemble-app.mjs`'s
`CFBundleURLTypes` is the precondition, and `Models/IncomingURLRouter.swift`
opens each link `application(_:open:)` receives as a tab in the leader browser
over CDP, starting it first when none runs. See
[`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

### iCloud provisioning (Developer ID app)

Sync needs an iCloud KVS entitlement backed by an _embedded_ provisioning
profile (Developer ID signing alone does not authorize iCloud).
`sign-and-package.sh` gates on optional **`PROVISION_PROFILE`**: **unset** signs
`Sliccstart.entitlements` only and `NSUbiquitousKeyValueStore` degrades to a
local cache; **set** embeds the profile and signs a merged file (base +
`ubiquity-kvstore-identifier`). CI decodes `APPLE_MACOS_PROVISIONING_PROFILE_BASE64`
and exports `PROVISION_PROFILE` and `KVSTORE_IDENTIFIER` (default
`${APPLE_TEAM_ID}.com.slicc.sliccstart`; releases ship `S8LB56P782.ai.sliccy.trays`,
which the iOS follower must match). Signing contract: `macos-permissions.test.mjs`.

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
- **`WebRTC.framework` ships next to `slicc-server`** (its `@rpath`/`@loader_path`): `assemble-app.mjs` copies it in, `sign-and-package.sh` re-signs it innermost-first — else dyld fails and every spawned server dies as "start failed".
- The **one** web artifact still embedded is the Electron overlay bootstrap. `copy-overlay-entry.mjs` copies `dist/ui/electron-overlay-entry.js` into `Contents/Resources/slicc/dist/ui/` so packaged `slicc-server --electron` loads the real overlay instead of its inline fallback. That file is produced by **`@ai-ecoverse/spoon`** (`npm run build -w @ai-ecoverse/spoon`), so it must be built before `assemble-app.mjs` runs — and a `packages/spoon/**` change is what re-triggers this job in CI (not a general webapp change).
- Packaging emits only the full `Sliccstart-<v>.zip`. There is no webapp-only smooth-update pair anymore.

## Updates

Updates are **full-app-only**, driven by the external `AppUpdater` SPM package (`import AppUpdater`). The launcher no longer ships a webapp-only "smooth update" path — with local UI serving removed (the UI loads from the hosted origin), there is nothing to hot-swap, so `UpdateManifest`, `RunningAppHashes`, `WebappOverlayStore`, `SmoothUpdateCoordinator`, and the `--probe-update` probe were all removed.

- `SliccstartApp.swift` owns an `AppUpdater` `@StateObject` and drives every check through `checkForUpdates()`, which records the outcome in `UpdateCheckStatus` and logs it. When a newer release is downloaded, `appUpdater.state` becomes `.downloaded` and `AppListView.fullUpdateButton` surfaces the `restart-to-update` action that calls `appUpdater.install(bundle)`.
- While an update is ready, the two-second timer polls each live server's `/api/agent-activity`. `AgentActivityProbe` fails open after one second; activity makes the restart action grey instead of green.
- `Models/UpdateCheckStatus.swift` — the footer's report on the last check (`idle`, `checking`, `upToDate`, `noInstallableRelease`, `translocated`, `failed(message)`). `AppUpdater` hands every failure to a callback and otherwise only publishes a downloaded bundle, so without this a rate-limited or asset-less check was indistinguishable from "never checked" and the footer just kept offering "Check for Updates". `AUError.cancelled` maps to `upToDate` (that is how `findViableUpdate` says "nothing newer"), `AppUpdater.Error.noValidUpdate` to `noInstallableRelease`. `AppUpdater` stages its download next to `Bundle.main.bundleURL` before it ever hits the network, so a translocated launch (Gatekeeper copies an unmoved, quarantined `.app` to a read-only synthetic volume under `.../T/AppTranslocation/...`) fails every check with Cocoa's `NSFileWriteVolumeReadOnlyError`; that specific code maps to `translocated` instead of the raw OS error text so the footer tells the user to move the app to `/Applications`.
- `Models/UpdateHostConfiguration.swift` — parses `--update-host=<url>` argument or `SLICC_UPDATE_HOST` env, defaulting to `https://api.github.com`. `AppUpdater`'s releases listing routes through it.
- `Models/TolerantGithubReleaseProvider.swift` — the release provider used by `AppUpdater`; tolerates release-naming drift in the `ai-ecoverse/slicc` release history. It also filters out releases lacking an installable macOS asset (`Sliccstart-<version>.zip`/`.tar`), so `AppUpdater` falls back to the newest release that actually ships a binary (needed now that native artifacts are conditionally built). Because the repo releases many times a day while the macOS artifact is built only on `packages/swift-launcher/**` changes, the newest installable release routinely sits beyond the default 30-release page: the provider requests `per_page=100` and follows the RFC 8288 `Link: rel="next"` chain (same host, HTTP(S) only) until a page yields a viable release **or reaches `currentVersion`** — the release the running build came from, since nothing older can ever be an update. "Reached" is not "saw an older tag": `/releases` is creation-ordered, so a backport published after a newer release, or a non-semver tag decoding to `Version.null`, would otherwise stop page one and hide the installable release further back. `hasReached(_:on:)` therefore stops only when the page carries the running build's own version or when every _parsed_ release on it is older, ignoring unparsable tags. `maxReleasePages` is only a loop guard for a host whose `Link` chain never terminates, not the intended stop. `currentVersion` defaults to `Bundle.main.version` (the same value `AppUpdater` compares against) and `fetchPage` injects a stub transport; both are pinned in tests because the XCTest host bundle's version is unrelated to the release history.
- `Models/LaunchRecordStore.swift` — persisted `PersistedLaunchRecord` JSON (servePort, CDP port, electronAppPath, target name, target type, joinUrl, bridgeToken) at `~/Library/Application Support/Sliccstart/launch-records.json`, plus `CDPLiveProbe` for liveness checks via `/json/version`. No PID is stored — process identity isn't needed for reattach because the CDP port answering `/json/version` is what we use to decide whether the previous browser is still alive. The `bridgeToken` is persisted because the surviving browser tab carries it in its launch URL (`?bridgeToken=<token>`); reattach re-forwards the SAME token so the re-spawned `--serve-only` slicc-server keeps gating `/cdp` against the secret the tab already has, instead of a freshly-minted static one. (Legacy records carrying a `staticRoot` key still decode; the extra key is ignored, and a missing `bridgeToken`/`joinUrl` key loads as nil.)
- `Models/SliccProcess.swift` extensions: `detachAll()` and `reattachPersistedRecords()`. The launcher only ever spawns thin-bridge `slicc-server` processes — no `--static-root` / overlay plumbing.

## Update Tests

- `SliccstartTests/UpdateHostConfigurationTests.swift` — unit coverage for `--update-host` / `SLICC_UPDATE_HOST` parsing and defaulting.
- `SliccstartTests/UpdateCheckIntegrationTests.swift` — integration tests that hit the **real GitHub API** (via `TolerantGithubReleaseProvider`) to catch release-naming drift a frozen fixture could not, including a `per_page=1` walk that proves the `Link: rel="next"` pagination reaches an installable release. They share a single authenticated call (`GH_TOKEN`, set by `ci.yml` from `${{ github.token }}`) to stay inside the rate budget; without a token — or with an **empty** one — they fall back to the unauthenticated path and may flake under contention.
- `SliccstartTests/ReleaseFetchPaginationTests.swift` — stubbed-transport coverage for the paginated walk: follows `Link` headers until a viable release appears, stops on the first page that has one, stops at the page holding the running build's release, keeps auth on every page, honours the page budget, and rejects off-host or non-HTTP(S) `rel="next"` targets.
- `SliccstartTests/UpdateCheckStatusTests.swift` — error-to-status mapping so no check outcome can be swallowed silently.
- `SliccstartTests/AgentActivityProbeTests.swift` — aggregation and fail-open tests.
- `SliccstartTests/LauncherErrorReportTests.swift` — RUM beacon contract: stable `source` keys and the redaction/truncation rules applied to `target`.
