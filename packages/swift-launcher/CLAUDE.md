# CLAUDE.md

Native macOS launcher `Sliccstart` (SwiftUI): finds browsers, Electron apps, and terminals; starts the right SLICC runtime; creates debug Electron builds. Deep reference for every section below: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md).

## Build, Test, Lint

```bash
cd packages/swift-launcher
swift build
swift test
swift run Sliccstart
npm run build
npm run lint -w @slicc/swift-launcher          # SwiftLint
npm run lint:format -w @slicc/swift-launcher   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-launcher        # swift format --in-place
./sign-and-package.sh
```

`.swiftlint.yml` inherits repo-root config via `parent_config`; only `error`-severity fails CI (`npm run lint:fix` auto-fixes). Formatting: `swift format` (Swift 6+) against repo-root `.swift-format`.

## Layout

`Sliccstart/` — SwiftUI app (`SliccstartApp.swift` boots UI; `Models/AppScanner.swift` finds Chromium/CDP apps; `SliccBootstrapper`/`SliccProcess` handle launch/lifecycle; `Views/`). `SliccstartTests/` — tests. `assemble-app.mjs`/`build-app-icon.mjs`/`sign-and-package.sh` assemble, build icons, sign/package.

## Runtime Refresh Budget

`refreshRuntimeStates` ticks every 2 s and `runtimeState(for:)` runs on every SwiftUI render, so anything on that path must be O(1) and filesystem-free in steady state. Electron liveness uses the launch record's `observedAppPID` (`kill(pid, 0)`) first; the `NSWorkspace.runningApplications` scan (pure string compares) is a fallback only. **Do not reintroduce per-app `resolvingSymlinksInPath()`** — with ~270 apps it pinned the launcher at ~40% CPU.

## Testing the SwiftUI Surfaces

`SliccstartTests/ViewHosting.swift` renders views off-screen (`ImageRenderer` digest) so a test asserts two states **render differently** (`assertRendersDifferently`). Headless SwiftUI can't be interacted with, renders `Table`/`Toggle`/`.borderless` as nothing, and differs on CI's older macOS — so **logic lives out of view closures** (window behavior on `Models/LauncherModel.swift`, launch via injectable `SliccProcess.SpawnServices`, collaborators non-`final`). [details](../../docs/swift-launcher-details.md#testing-swiftui-surfaces)

## Operational Telemetry (OpTel)

The `WindowGroup` root calls `.optelAutoInstrument(appID:)` (`@slicc/swift-optel`) once. `do/catch` boundaries report through **`Models/LauncherErrorReport.swift`**: `source = sliccstart:<operation>` is a wire contract (RUM filters on `Operation` strings), `target` is **redacted** (URLs, paths, secrets). **Never report `AUError.cancelled`** — the normal up-to-date outcome. Operation cases + redaction: [details](../../docs/swift-launcher-details.md#optel).

## App Scanning

Chromium browsers and terminals (Terminal.app, iTerm2, Ghostty, WezTerm, kitty, Alacritty) by bundle ID; `/Applications` for Electron/WebView2 bundles with CDP frameworks. `~/Applications` first so `* Debug.app` wins.

## Terminal Followers

Terminal rows attach the selected terminal to the current leader via `slicc <join-url> follow`. **Disabled until `leaderJoinUrl` is known; never auto-start a leader.** `SliccCliLocator` resolves the CLI in a fixed order (managed Application Support, then repo builds, then `/usr/local/bin`); **the CLI is never bundled in `Sliccstart.app`.** If none is found, the launcher **asks before** downloading from `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`, validates Developer ID signature and team `S8LB56P782` before making executable, then atomically installs ([pitfalls](../../docs/pitfalls.md) § "Downloaded `slicc` CLI"; [details](../../docs/swift-launcher-details.md#terminal-followers)). Terminal.app/iTerm2 launch via Apple Events (apple-events entitlement in `Sliccstart.entitlements`).

## Widget Extension (Cones & Scoops)

`SliccstartWidgets.appex` (`com.slicc.sliccstart.widgets`) shows cones and scoops in Notification Centre / on the desktop; views live in **`packages/swift-widgetkit`**, this package owns only the `@main` bundle and build wiring. Capture is `Models/WidgetTrayObserver.swift`: a **read-only tray follower** off `leaderJoinUrl`, **gated on the widget being installed** (`WidgetInstallationQuery`) so no WebRTC slot stays open for an unused tile. [details](../../docs/swift-launcher-details.md#widget-extension)

## Finder File Provider (leader VFS)

Shared provider logic in **`packages/swift-traykit`** (`SliccTrayVFS`). `SliccFileProvider.appex` is staged into `Contents/PlugIns/` **with its own `WebRTC.framework` and `AppIcon.icns`** — a sandboxed appex cannot load the host `Resources/` copy. `FileProviderCoordinator` saves the join URL to an app-group file (not keychain); clean quit withdraws the domain (not update/detach); enable once in System Settings → Login Items & Extensions. Rationale + coverage: [details](../../docs/swift-launcher-details.md#finder-file-provider).

## iCloud Sync (Tray Sessions)

Shared models in **`packages/swift-traysession`**. **Secret-bearing join URLs sync only through same-Apple-ID, encrypted iCloud KVS.** `SessionReachability` follows bounded `TRAY_SUPERSEDED` chains; only HTTP 200 with `leader.connected == true` is live. Clean quit withdraws the published `leaderJoinUrl`.

**Advertise what is true now, not what was true at launch:** the browser re-mints the tray on reload/supersede, so the launcher watches `/api/tray-status`, withdraws superseded entries (keyed by `SHA256(joinUrl)`), and re-reads before stamping `lastSeenAt`. **`leaderJoinUrl` is the single gate** for Electron/terminal rows _and_ iCloud advertising, so `reattach` probes **after** `spawn` registers the record (bounded grace) — else a smooth update strands it on "Start a browser first". [details](../../docs/swift-launcher-details.md#keeping-the-advertised-join-url-true).

**Headless CLI (`Sliccstart --list-sessions`)** — parsed in `main.swift` **before** SwiftUI boots. Prints JSON, **metadata only** (`joinUrl` redacted); `--reveal-urls` gates behind `NSAlert`, headless/SSH callers **denied** (exit 3). [details](../../docs/swift-launcher-details.md#headless-cli-sliccstart---list-sessions)

## App Ordering, Followers, Startup, Mounts

`Models/AppOrdering.swift` holds default priority (user drag-reorder via `AppOrderStore` wins); `StartupPreference` starts the top-ordered browser. `browserFollowerArgs` passes `--join=<url>` vs `--lead`; the lead-or-attach dialog counts only attachable iCloud sessions (all-dead → launch standalone, no dialog). The **mount table** (`Models/MountTablePreference.swift`, Settings → Mounts) emits `--mount=<os>:<vfs>` mappings (browsers only; parse mirrors swift-server's), served by `/api/hostfs`, auto-mounted by the webapp. [details](../../docs/swift-launcher-details.md#app-ordering-startup-mounts) · [mounts](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table)

## Default Browser Role

Sliccstart can hold the macOS http/https handler role (Settings → Startup): `Models/DefaultBrowserRegistration.swift` claims it (`assemble-app.mjs`'s `CFBundleURLTypes` is the precondition), `Models/IncomingURLRouter.swift` opens each link over CDP. [sliccstart-browser](../../docs/sliccstart-browser.md)

## Debug Build Creation

`Models/DebugBuildCreator.swift` creates Electron debug builds (copy to `~/Applications/<Name> Debug.app`, patch Electron fuses + `app.asar` JS checks that block CDP, ad-hoc sign, strip quarantine) — for apps that block remote debugging in production.

## App Icon

`build-app-icon.mjs` writes **`AppIcon.icns`** (flat, `CFBundleIconFile`) and **`Assets.car`** (`actool`-compiled from `macos-icon.icon`; `CFBundleIconName`). `buildIconAssetCatalog` **degrades instead of throwing** when `actool` is absent/too old — **the common CI case** — so a green build is **not** proof the appearance variants shipped (watch for `WARNING: appearance-keyed app icon skipped`). [details](../../docs/swift-launcher-details.md#app-icon)

## Packaging & Provisioning

`npm run build` assembles the `.app` from pre-built artifacts; `sign-and-package.sh` is the distributable path (`Sliccstart-<v>.zip`). Load-bearing: expects `slicc-server` pre-built (webapp **not** bundled); **`WebRTC.framework` ships next to `slicc-server`** and re-signing is **innermost-first** or dyld kills every spawned server ("start failed"). iCloud sync needs an _embedded_ provisioning profile — **Developer ID signing alone does not authorize iCloud** — gated on optional **`PROVISION_PROFILE`** (unset → local cache only; CI ships `S8LB56P782.ai.sliccy.trays`, **which the iOS follower must match**). Contract `macos-permissions.test.mjs`; [details](../../docs/swift-launcher-details.md#packaging).

## Updates

**Full-app-only**, driven by the external `AppUpdater` SPM package; the 2 s timer defers restart while `/api/agent-activity` shows work (`AgentActivityProbe` fails open after 1 s). Update host: `--update-host` / `SLICC_UPDATE_HOST`. Load-bearing (rationale — translocation, pagination stop, reattach ordering — in [details](../../docs/swift-launcher-details.md#updates)): `TolerantGithubReleaseProvider` skips releases lacking a `Sliccstart-<version>.zip`/`.tar` asset and pages via RFC 8288 `Link`; `LaunchRecordStore` persists `bridgeToken` but **no PID** (reattach re-forwards the same secret, probes via `CDPLiveProbe`); `reattachPersistedRecords()` **only spawns the thin-bridge `slicc-server` — no `--static-root`/overlay.** `UpdateCheckIntegrationTests` hits the real GitHub API (needs `GH_TOKEN`).
