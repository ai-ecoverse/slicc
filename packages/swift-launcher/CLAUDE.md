# CLAUDE.md

Native macOS launcher `Sliccstart` in `packages/swift-launcher/`. SwiftUI app: finds browsers, Electron apps, and terminals; starts the right SLICC runtime; creates debug-friendly Electron builds. Deep reference: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md).

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

## Linting and Formatting

`.swiftlint.yml` inherits repo-root `.swiftlint.yml` via `parent_config` and excludes `.build`; only `error`-severity violations fail CI. Auto-fix: `npm run lint:fix -w @slicc/swift-launcher`. Formatting is `swift format` (Swift 6+) against the single repo-root `.swift-format`.

```bash
npm run lint:format -w @slicc/swift-launcher   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-launcher        # swift format --in-place
```

## Layout

`Sliccstart/` — SwiftUI app (`SliccstartApp.swift` boots UI; `Models/AppScanner.swift` finds Chromium/CDP apps; `Models/SliccBootstrapper.swift` + `Models/SliccProcess.swift` handle launch/lifecycle; `Views/`). `SliccstartTests/` — tests. `assemble-app.mjs` — assembles `.app` bundle; `build-app-icon.mjs` — app-icon artefacts. `sign-and-package.sh` — signing/packaging.

## Runtime Refresh Budget

`SliccstartApp` ticks `refreshRuntimeStates` every 2 s and `runtimeState(for:)` runs on every SwiftUI render, so anything on that path must be O(1) and filesystem-free in the steady state. Electron liveness uses the launch record's `observedAppPID` (`kill(pid, 0)`) first; the `NSWorkspace.runningApplications` scan (`candidateBundlePaths` + `appMatches`, pure string compares) is a fallback only. Do not reintroduce per-app `resolvingSymlinksInPath()` — with ~270 running apps it pinned the launcher at ~40% CPU. Tests: `ElectronAppMatchingTests`.

## Operational Telemetry (OpTel)

`SliccstartApp.swift`'s `WindowGroup` root calls `.optelAutoInstrument(appID:)` from `@slicc/swift-optel` once; on macOS that activates `enter`, global `click`, `navigate`, and `error` (uncaught `NSException`). `appID = Bundle.main.bundleIdentifier` (`com.slicc.sliccstart`); beacons land in `helix-225321.helix_rum.cluster`.

Swift errors are values and cannot be intercepted globally, so `do/catch` boundaries report through **`Models/LauncherErrorReport.swift`**. `source = sliccstart:<operation>` is a wire contract (RUM filters on `Operation` enum strings). `target` is **redacted**: URLs → `<url>`, paths → `<path>`, `token`/`secret`/`password`/`key` → `<redacted>`. **Never report `AUError.cancelled`** — that is the normal up-to-date outcome.

Key controls carry stable `.accessibilityIdentifier` values (`get-extension`, `rescan`, `check-for-updates`, `restart-to-update`, `update`, `app-row-<Name>`).

## App Scanning

Chromium browsers by bundle ID; `/Applications` for Electron/WebView2 bundles with CDP frameworks; `~/Applications` scanned first so `* Debug.app` wins over originals; Terminal.app, iTerm2, Ghostty, WezTerm, kitty, Alacritty by bundle ID.

## Terminal Followers

Terminal rows attach the selected terminal to the current leader via `slicc <join-url> follow`. **Disabled until `leaderJoinUrl` is known; never auto-start a leader.**

`SliccCliLocator` order: managed `~/Library/Application Support/Sliccstart/bin/slicc`, repo `make build`, arch-specific `make dist`, `/usr/local/bin`, `~/.local/bin`, `/opt/homebrew/bin`. **The CLI is never bundled in `Sliccstart.app`.** If none is found, the launcher **asks before** downloading from `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`, validates Developer ID signature and team `S8LB56P782` before making executable, then atomically installs. Bare Mach-Os carry no stapled ticket — see [`docs/pitfalls.md`](../../docs/pitfalls.md) § "Downloaded `slicc` CLI".

Terminal.app and iTerm2 launch through Apple Events; `sign-and-package.sh` signs with `Sliccstart.entitlements` including `com.apple.security.automation.apple-events`.

## Finder File Provider (leader VFS)

Shared provider logic in **`packages/swift-traykit`** (`SliccTrayVFS`). `SliccFileProvider.appex` is built via XcodeGen (`project.yml`) + `xcodebuild`, then `stageFileProviderAppex` copies it into `Contents/PlugIns/` **with its own `WebRTC.framework` and `AppIcon.icns`** — a sandboxed appex cannot load the host `Resources/` copy, and Finder Locations uses the appex icon. `FileProviderCoordinator` saves the join URL to an app-group file (not keychain) when `leaderJoinUrl` is set; Settings → Startup toggles Finder integration. Clean quit withdraws the domain (update/detach does not). The appex is App Sandbox + network client/server, notarized alongside the main app; enable once in System Settings → Login Items & Extensions → File Provider. Coverage: `FileProviderCoordinatorTests`, `stage-file-provider-appex.test.mjs`, `packages/swift-traykit` provider tests.

## Widget Extension (Cones & Scoops)

`SliccstartWidgets.appex` (`com.slicc.sliccstart.widgets`) shows the connected instance's cones and scoops in Notification Centre / on the desktop. Views live in **`packages/swift-widgetkit`**; this package owns only the `@main` bundle and the build wiring — XcodeGen (`project.yml`, `SliccstartWidgets` scheme) → `stageWidgetAppex` into `Contents/PlugIns/` → `sign-and-package.sh` signs it with `SliccstartWidgets.entitlements` (sandbox + app group, no framework to embed, unlike the File Provider appex).

**Not wired yet**: Sliccstart holds no cone/scoop state (it is a launcher; state is client-side in the leader tab), so nothing writes `widget-snapshot.json` and the target carries `SLICC_WIDGET_DESIGN_FIXTURES`. The capture side is a small tray follower over the join URL it already knows — never the local server, which is a stateless relay. Plan: [`docs/widgets.md`](../../docs/widgets.md).

## iCloud Sync (Tray Sessions)

Shared models in **`packages/swift-traysession`**. **Secret-bearing join URLs sync only through same-Apple-ID, encrypted iCloud KVS.** `SessionReachability` follows bounded `TRAY_SUPERSEDED` chains; only HTTP 200 with `leader.connected == true` is live. `SliccstartApp` publishes non-nil `leaderJoinUrl` (refreshes every 4 h); clean quit withdraws, update/detach does not. Coverage: `TraySessionLauncherTests`.

**`leaderJoinUrl` is the single gate** for Electron/terminal rows _and_ iCloud advertising. `reattach` must call `startLeaderProbe` **after** `spawn` registers the launch record, and the loop's `leaderProbeStep` must keep waiting for a record it has never seen (bounded grace) — `reattachPersistedRecords` is nonisolated `async`, so the probe can outrun the record. Getting this wrong strands the launcher on "Start a browser first" after every smooth update. Tests: `SliccProcessLeaderProbeTests`.

**Headless CLI (`Sliccstart --list-sessions`)** — parsed in `main.swift` **before** SwiftUI boots. Prints JSON, **metadata only** (`joinUrl` redacted). `--reveal-urls` gates behind `NSAlert`; headless/SSH callers **denied** (exit 3). Pure logic in `Models/TraySessionCLI.swift`; glue in `TraySessionCLIRunner`.

## App Ordering, Browser Followers, Startup

`Models/AppOrdering.swift` (default `browserBundlePriority`/`terminalBundlePriority`; user drag-reorder via `AppOrderStore` UserDefaults wins). `browserFollowerArgs(cdpPort:joinUrl:)` passes `--join=<url>` vs `--lead`; `launchBrowserFollower` flags `isFollower`. `BrowserLaunchAction` and the lead-or-attach dialog count only attachable iCloud sessions (no confirmed-unreachable `SessionReachability` verdict) — all-dead lists launch standalone with no dialog. `Models/StartupPreference.swift`: launch starts top-ordered browser (`AppOrdering.topBrowser`). Tests: `AppOrderingTests`, `StartupPreferenceTests`, `SliccProcessLaunchArgsTests`.

## Mount Table (Settings → Mounts)

`Models/MountTablePreference.swift`: newline-separated `autoMountTable` UserDefault of `os-path:slicc-path` mappings (parse mirrors swift-server `ServerConfig.parseMountMapping`: last-colon split, `~` expansion, dedup by target), emitted as `--mount=<os>:<vfs>` by `standaloneBrowserArgs(cdpPort:mounts:)` and `reattachArgs(...mounts:)` (browsers only). Mapped folders are served by swift-server's `/api/hostfs` and auto-mounted by the webapp — no picker, no permission prompt. `Views/SettingsView.swift` → `MountsSettingsView`. Tests: `MountTablePreferenceTests`, `SliccProcessLaunchArgsTests`. Behaviour: [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table).

## Default Browser Role

Sliccstart can hold the macOS http/https handler role (Settings → Startup). `Models/DefaultBrowserRegistration.swift` claims it; `assemble-app.mjs`'s `CFBundleURLTypes` is the precondition; `Models/IncomingURLRouter.swift` opens each link over CDP. See [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## iCloud Provisioning (Developer ID app)

Sync needs an iCloud KVS entitlement backed by an _embedded_ provisioning profile — **Developer ID signing alone does not authorize iCloud.** `sign-and-package.sh` gates on optional **`PROVISION_PROFILE`**: unset → signs `Sliccstart.entitlements` only, `NSUbiquitousKeyValueStore` degrades to a local cache; set → embeds the profile and signs a merged file. CI exports `PROVISION_PROFILE` and `KVSTORE_IDENTIFIER` (releases ship `S8LB56P782.ai.sliccy.trays`, **which the iOS follower must match**). Signing contract: `macos-permissions.test.mjs`.

## Debug Build Creation

`Models/DebugBuildCreator.swift` creates Electron debug builds by: (1) copying into `~/Applications/<Name> Debug.app`, (2) patching Electron fuses for remote debugging, (3) unpacking/patching `app.asar` JS checks that block CDP, (4) ad-hoc signing, (5) removing quarantine attributes. Use when an Electron app disables remote debugging in production.

## App Icon

Two artefacts, both written by `build-app-icon.mjs`:

- **`AppIcon.icns`** — one flat image from `packages/assets/logos/macos-icon-iOS-Default-1024x1024@1x.png`, via `sips` + `iconutil` (both ship with macOS). `CFBundleIconFile`.
- **`Assets.car`** — `actool`-compiled from `packages/assets/logos/macos-icon.icon` (Icon Composer). Adds the `NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua` / `ISAppearanceTintable` icon stacks macOS 26 picks between. `CFBundleIconName`, emitted into `Info.plist` only when the compile succeeds.

`buildIconAssetCatalog` **degrades instead of throwing** on all three failure modes — the bundle still gets its `.icns`, just with no Dark/Tinted appearance:

1. `actool` absent (it lives in Xcode, not the Command Line Tools);
2. `actool` present but too old to compile the `.icon` — **this is the common case in CI**, whose `swift-launcher` job runs on `macos-latest` (still macOS 15 / Xcode 16.x); only `release.yml` pins `macos-26`;
3. `actool` exits 0 but writes no `Assets.car`.

So a green `swift-launcher` CI build is **not** proof the appearance variants shipped — only the `macos-26` release job produces them. Watch for the `WARNING: appearance-keyed app icon skipped` line if a build's icon stops adapting, and confirm what actually shipped with `xcrun assetutil --info <app>/Contents/Resources/Assets.car`.

A classic `AppIcon.appiconset` cannot replace the `.icon` here: `actool` honours the `appearances` key on iOS idioms only and reports macOS ones as "unassigned children", dropping them without failing the build. Per-appearance _custom artwork_ (`image-name-specializations`) exists in the `.icon` format but is authored in Icon Composer — hand-written variants of that key are silently ignored, so the macOS Tinted icon is **system-derived** from the layer artwork. Its contrast is therefore a property of `macos-icon.icon`'s layer, not something a separate PNG can override. Tests: `build-app-icon.test.mjs`.

## Packaging Notes

- `npm run build` assembles the `.app` from pre-built artifacts; `sign-and-package.sh` is the distributable path.
- Expects `packages/swift-server/.build/release/slicc-server` to be pre-built. Webapp is **not** bundled — `assemble-app.mjs` writes an empty `Contents/Resources/slicc` marker dir.
- **`WebRTC.framework` ships next to `slicc-server`**: `sign-and-package.sh` re-signs **innermost-first** — else dyld fails and every spawned server dies as "start failed".
- Electron overlay bootstrap `dist/ui/electron-overlay-entry.js` is produced by **`@ai-ecoverse/spoon`** (`npm run build -w @ai-ecoverse/spoon`) and must be built before `assemble-app.mjs`; a `packages/spoon/**` change re-triggers this CI job.
- Packaging emits only the full `Sliccstart-<v>.zip`.

## Updates

**Full-app-only**, driven by external `AppUpdater` SPM package. `SliccstartApp.swift` owns an `AppUpdater` `@StateObject`; `checkForUpdates()` records outcome in `UpdateCheckStatus`. On `.downloaded`, `AppListView.fullUpdateButton` surfaces `restart-to-update` → `appUpdater.install(bundle)`. The 2 s timer polls `/api/agent-activity`; `AgentActivityProbe` fails open after 1 s.

- `Models/UpdateCheckStatus.swift` — `idle`, `checking`, `upToDate`, `noInstallableRelease`, `translocated`, `failed(message)`.
- `Models/UpdateHostConfiguration.swift` — `--update-host=<url>` / `SLICC_UPDATE_HOST` (default `https://api.github.com`).
- `Models/TolerantGithubReleaseProvider.swift` — filters releases lacking `Sliccstart-<version>.zip`/`.tar`; `per_page=100`; follows RFC 8288 `Link: rel="next"` (same host, HTTP(S) only) until viable release or `currentVersion`.
- `Models/LaunchRecordStore.swift` — `PersistedLaunchRecord` JSON at `~/Library/Application Support/Sliccstart/launch-records.json` + `CDPLiveProbe` (`/json/version`). **No PID stored.** `bridgeToken` persisted so reattach re-forwards the same secret the surviving tab has.
- `Models/SliccProcess.swift`: `detachAll()`, `reattachPersistedRecords()`. **The launcher only ever spawns thin-bridge `slicc-server` — no `--static-root` / overlay plumbing.**

## Update Tests

`UpdateHostConfigurationTests.swift`, `UpdateCheckIntegrationTests.swift` (real GitHub API — needs `GH_TOKEN` from `${{ github.token }}` in `ci.yml`), `ReleaseFetchPaginationTests.swift`, `UpdateCheckStatusTests.swift`, `AgentActivityProbeTests.swift`, `LauncherErrorReportTests.swift`.

Deep reference for every section above: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md).
