# CLAUDE.md

Native macOS launcher `Sliccstart`. SwiftUI app: finds browsers, Electron apps, and terminals; starts the right SLICC runtime; creates debug-friendly Electron builds. Deep reference: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md).

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

`.swiftlint.yml` inherits repo-root via `parent_config` and excludes `.build`; only `error` fails CI. Auto-fix: `npm run lint:fix -w @slicc/swift-launcher`. `swift format` (Swift 6+) uses the repo-root `.swift-format`.

```bash
npm run lint:format -w @slicc/swift-launcher   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-launcher        # swift format --in-place
```

## Layout

`Sliccstart/` — SwiftUI app (`SliccstartApp.swift` boots UI; `Models/AppScanner.swift` finds Chromium/CDP apps; `Models/SliccBootstrapper.swift` + `Models/SliccProcess.swift` handle launch/lifecycle; `Views/`). `SliccstartTests/` — tests. `assemble-app.mjs` — `.app`; `build-app-icon.mjs` — icons; `sign-and-package.sh` — signing.

## Runtime Refresh Budget

`refreshRuntimeStates` ticks every 2 s and `runtimeState(for:)` runs on every SwiftUI render — that path must be O(1) and filesystem-free in the steady state. Electron liveness uses the launch record's `observedAppPID` (`kill(pid, 0)`) first; `NSWorkspace.runningApplications` (`candidateBundlePaths` + `appMatches`, string compares) is fallback only. **Do not reintroduce per-app `resolvingSymlinksInPath()`** — ~270 running apps pinned the launcher at ~40% CPU. Tests: `ElectronAppMatchingTests`.

## Testing SwiftUI Surfaces

`ViewHosting.swift` (`assertRendersDifferently`) reaches `AppListView` / `SettingsView` body branches. An `App` `Scene` cannot be rendered — put window behavior on `LauncherModel`, content on `RootView`; `SliccstartAppDelegate` is the injectable composition root (stop-everything vs detach-for-update). Launch paths inject `SliccProcess.SpawnServices` (`/bin/sleep`; no 5710/9222). Auto-launch is `resolveEnabled && isInstalledLocation`. `SliccProcess`, `SliccBootstrapper`, `AppManagementPermission` are **not `final`**. Constraints: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#swiftui-testing). Tests: `LauncherModelTests`, `RootViewRenderTests`, `AppDelegateLifecycleTests`, `SliccProcessLaunchPathTests`.

## OpTel, scanning, terminals

`.optelAutoInstrument(appID:)` once (`com.slicc.sliccstart` → `helix-225321.helix_rum.cluster`). `LauncherErrorReport`: `source = sliccstart:<operation>` is a wire contract; `target` redacts URLs → `<url>`, paths → `<path>`, `token`/`secret`/`password`/`key` → `<redacted>`. **Never report `AUError.cancelled`.** Identifiers: `get-extension`, `rescan`, `check-for-updates`, `restart-to-update`, `update`, `app-row-<Name>`. [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#optel).

Scan: Chromium by bundle ID; `/Applications` for Electron/WebView2 with CDP frameworks; `~/Applications` first so `* Debug.app` wins; Terminal.app, iTerm2, Ghostty, WezTerm, kitty, Alacritty by bundle ID.

Terminal rows: `slicc <join-url> follow`. **Disabled until `leaderJoinUrl` is known; never auto-start a leader. CLI never bundled.** Download asks first; Developer ID + team `S8LB56P782`; `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`. Locator + Gatekeeper: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#terminal-followers), [`docs/pitfalls.md`](../../docs/pitfalls.md) § "Downloaded `slicc` CLI". Terminal.app/iTerm2: Apple Events (`com.apple.security.automation.apple-events`).

## Finder File Provider, Widgets

`SliccFileProvider.appex` (XcodeGen `project.yml` + `xcodebuild` → `Contents/PlugIns/`) **embeds its own `WebRTC.framework` and `AppIcon.icns`**. Join URL in an app-group file, not keychain. Clean quit withdraws the domain (update/detach does not). Enable once: System Settings → Login Items & Extensions → File Provider. Shared: **`packages/swift-traykit`**. [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#finder-file-provider). Tests: `FileProviderCoordinatorTests`, `stage-file-provider-appex.test.mjs`.

`SliccstartWidgets.appex` (`com.slicc.sliccstart.widgets`): views in **`packages/swift-widgetkit`**; this package owns `@main` + wiring (`SliccstartWidgets` → `stageWidgetAppex` → sandbox + app group, **no** nested framework). `WidgetTrayObserver` is a **read-only tray follower** off `leaderJoinUrl`, **gated on `WidgetInstallationQuery`**. [`docs/widgets.md`](../../docs/widgets.md#capture).

## iCloud Sync (Tray Sessions)

**`packages/swift-traysession`**. **Join URLs sync only through same-Apple-ID, encrypted iCloud KVS.** Live = HTTP 200 + `leader.connected == true` on bounded `TRAY_SUPERSEDED` chains. Publish non-nil `leaderJoinUrl`; clean quit withdraws, update/detach does not. Advertise-now: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#keeping-the-advertised-join-url-true).

**`leaderJoinUrl` is the single gate** for Electron/terminal rows _and_ iCloud. `reattach` must `startLeaderProbe` **after** `spawn` registers the record; `leaderProbeStep` waits (bounded) for a never-seen record (`reattachPersistedRecords` is nonisolated `async`). Wrong order → "Start a browser first" after every smooth update. Tests: `SliccProcessLeaderProbeTests`, `LauncherModelTests`, `TraySessionLauncherTests`.

**`Sliccstart --list-sessions`**: `main.swift` **before** SwiftUI. JSON, **metadata only** (`joinUrl` redacted). `--reveal-urls` needs `NSAlert`; headless/SSH **denied** (exit 3). `TraySessionCLI` / `TraySessionCLIRunner`.

## Ordering, mounts, default browser

`AppOrdering` (`browserBundlePriority`/`terminalBundlePriority`; `AppOrderStore` UserDefaults wins). `browserFollowerArgs` passes `--join=<url>` vs `--lead`; `launchBrowserFollower` flags `isFollower`. Lead-or-attach counts only attachable iCloud sessions — all-dead lists launch standalone. `StartupPreference` starts `AppOrdering.topBrowser`. Tests: `AppOrderingTests`, `StartupPreferenceTests`, `SliccProcessLaunchArgsTests`.

`MountTablePreference`: `autoMountTable` of `os-path:slicc-path` (last-colon split, `~` expansion, dedup by target), emitted as `--mount=<os>:<vfs>` (browsers only). `/api/hostfs` + webapp auto-mount — no picker. Tests: `MountTablePreferenceTests`. [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table).

Default http/https handler: `DefaultBrowserRegistration`; `CFBundleURLTypes` precondition; `IncomingURLRouter` opens links over CDP. [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## iCloud Provisioning (Developer ID app)

Sync needs an iCloud KVS entitlement backed by an _embedded_ provisioning profile — **Developer ID signing alone does not authorize iCloud.** `sign-and-package.sh` gates on optional **`PROVISION_PROFILE`**: unset → signs `Sliccstart.entitlements` only, `NSUbiquitousKeyValueStore` degrades to a local cache; set → embeds the profile and signs a merged file. CI exports `PROVISION_PROFILE` and `KVSTORE_IDENTIFIER` (releases ship `S8LB56P782.ai.sliccy.trays`, **which the iOS follower must match**). Signing contract: `macos-permissions.test.mjs`.

## App Icon

`DebugBuildCreator`: copy to `~/Applications/<Name> Debug.app`, patch Electron fuses, unpack/patch `app.asar` CDP blocks, ad-hoc sign, drop quarantine.

`build-app-icon.mjs` writes `AppIcon.icns` (`sips`+`iconutil`) and `Assets.car` (`actool` from `macos-icon.icon`). Degrades if `actool` is missing/too old (CI `macos-latest` = macOS 15; only `release.yml` pins `macos-26`) — a green CI build is **not** proof appearance variants shipped. Watch `WARNING: appearance-keyed app icon skipped`; `xcrun assetutil --info <app>/Contents/Resources/Assets.car`. [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#app-icon). Tests: `build-app-icon.test.mjs`.

Packaging: `npm run build` from pre-built artifacts; `sign-and-package.sh` is the distributable path. Needs `slicc-server`. Webapp **not** bundled. **Re-sign `WebRTC.framework` innermost-first.** Overlay from **`@ai-ecoverse/spoon`** (`npm run build -w @ai-ecoverse/spoon`) before `assemble-app.mjs`. Emits only `Sliccstart-<v>.zip`. [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#packaging).

## Updates

**Full-app-only** (`AppUpdater` SPM). `checkForUpdates()` → `UpdateCheckStatus`; `.downloaded` → `restart-to-update` → `appUpdater.install(bundle)`. 2 s timer polls `/api/agent-activity`; `AgentActivityProbe` fails open after 1 s. `--update-host=<url>` / `SLICC_UPDATE_HOST` (default `https://api.github.com`). `TolerantGithubReleaseProvider`: `Sliccstart-<version>.zip`/`.tar`; `per_page=100`; RFC 8288 `rel="next"` (same host, HTTP(S) only). `LaunchRecordStore` + `CDPLiveProbe` (`/json/version`): **no PID**; persist `bridgeToken`. `detachAll()` / `reattachPersistedRecords()`. **Thin-bridge `slicc-server` only — no `--static-root`.** [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md#updates).

Tests: `UpdateHostConfigurationTests`, `UpdateCheckIntegrationTests` (real GitHub API — `GH_TOKEN` from `${{ github.token }}` in `ci.yml`), `ReleaseFetchPaginationTests`, `UpdateCheckStatusTests`, `AgentActivityProbeTests`, `LauncherErrorReportTests`.
