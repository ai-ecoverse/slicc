# CLAUDE.md

Native macOS launcher `Sliccstart` (SwiftUI): finds browsers, Electron apps, and terminals; starts the right SLICC runtime; creates debug Electron builds. Rationale, coverage, gotchas: [`docs/swift-launcher-details.md`](../../docs/swift-launcher-details.md).

## Build, Test, Lint

```bash
cd packages/swift-launcher
swift build && swift test && swift run Sliccstart
npm run build
npm run lint -w @slicc/swift-launcher          # SwiftLint
npm run lint:format -w @slicc/swift-launcher   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-launcher        # swift format --in-place
./sign-and-package.sh
```

`.swiftlint.yml` inherits repo-root config via `parent_config`; only `error`-severity fails CI (`lint:fix` auto-fixes). Format: `swift format` (Swift 6+) against repo-root `.swift-format`.

## Layout

`Sliccstart/` — SwiftUI app (`SliccstartApp.swift` boots UI; `Models/AppScanner.swift` finds Chromium/CDP apps; `SliccBootstrapper`/`SliccProcess` handle launch/lifecycle; `Views/`). `SliccstartTests/` — tests. Scripts: `assemble-app.mjs`, `build-app-icon.mjs`, `sign-and-package.sh`.

## Runtime Refresh Budget

`refreshRuntimeStates` ticks every 2 s and `runtimeState(for:)` runs on every SwiftUI render, so that path must be O(1) and filesystem-free at steady state. Electron liveness uses the launch record's `observedAppPID` (`kill(pid, 0)`), with an `NSWorkspace.runningApplications` fallback. **Do not reintroduce per-app `resolvingSymlinksInPath()`** — with ~270 apps it pinned the launcher at ~40% CPU.

## Testing the SwiftUI Surfaces

`SliccstartTests/ViewHosting.swift` renders views off-screen (`ImageRenderer` digest) so a test asserts two states **render differently** (`assertRendersDifferently`). Headless SwiftUI can't be interacted with and renders `Table`/`Toggle`/`.borderless` as nothing — so **logic lives out of view closures** (window behavior on `Models/LauncherModel.swift`; launch via injectable `SliccProcess.SpawnServices`).

## Operational Telemetry (OpTel)

The `WindowGroup` root calls `.optelAutoInstrument(appID:)` (`@slicc/swift-optel`) once. `do/catch` boundaries report via **`Models/LauncherErrorReport.swift`**: `source = sliccstart:<operation>` is a wire contract (RUM filters on it); `target` is **redacted**. **Never report `AUError.cancelled`** — the normal up-to-date result.

## App Scanning

Chromium browsers and terminals (Terminal.app, iTerm2, Ghostty, WezTerm, kitty, Alacritty) by bundle ID; `/Applications` for Electron/WebView2 bundles with CDP frameworks. `~/Applications` first so `* Debug.app` wins.

## Terminal Followers

Terminal rows attach the selected terminal to the leader via `slicc <join-url> follow`. **Disabled until `leaderJoinUrl` is known; never auto-starts a leader.** `SliccCliLocator` resolves the CLI in a fixed order (managed Application Support → repo builds → `/usr/local/bin`); **never bundled in the app.** If none found, the launcher **asks before** downloading from `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`, **validates Developer ID signature and team `S8LB56P782`** before making executable, then atomically installs. Terminal.app/iTerm2 launch via Apple Events. [pitfalls § Downloaded slicc CLI](../../docs/pitfalls.md).

## Widget Extension (Cones & Scoops)

`SliccstartWidgets.appex` (`com.slicc.sliccstart.widgets`) shows cones and scoops in Notification Centre / on the desktop; views live in **`packages/swift-widgetkit`** (this package owns only the `@main` bundle + build wiring). `Models/WidgetTrayObserver.swift` is a **read-only tray follower** off `leaderJoinUrl`, **gated on install** (`WidgetInstallationQuery`). Native desktop capture is a **separate** follower (`Models/ComputerTrayFollower.swift`, runtime `sliccstart-computer`) that **always dials** when a join URL is set, never advertises `exec`. **`capabilities.computer` is derived from the live Screen Recording grant, never hardcoded** (`Models/ComputerCapabilityAdvertisement.swift`) — claiming it ungranted costs the leader the `screencapture` fallback. A grant watch re-sends `hello` on flip (TCC has no notification; Accessibility rides the MOTD).

## Finder File Provider (leader VFS)

Shared logic in **`packages/swift-traykit`** (`SliccTrayVFS`). `SliccFileProvider.appex` is staged into `Contents/PlugIns/` **with its own `WebRTC.framework` and `AppIcon.icns`** — a sandboxed appex can't load the host `Resources/` copy. `FileProviderCoordinator` saves the join URL to an app-group file (not keychain); clean quit withdraws the domain — update/detach don't.

## iCloud Sync (Tray Sessions)

Shared models in **`packages/swift-traysession`**. **Secret-bearing join URLs sync only through same-Apple-ID, encrypted iCloud KVS.** `SessionReachability` follows bounded `TRAY_SUPERSEDED` chains; only HTTP 200 with `leader.connected == true` is live. Clean quit withdraws the URL.

**Advertise what is true now, not at launch:** the browser re-mints the tray on reload/supersede, so the launcher watches `/api/tray-status`, withdraws superseded entries (keyed by `SHA256(joinUrl)`), re-reads before stamping `lastSeenAt`. **`leaderJoinUrl` is the single gate** for Electron/terminal rows _and_ iCloud advertising, so `reattach` probes **after** `spawn` registers the record — else a smooth update strands it on "Start a browser first".

**SIGPIPE** — `main.swift` calls `BrokenPipeSignal.ignore()` first, so a write to a closed socket/pipe (libwebrtc, stdio) returns `EPIPE` instead of killing the GUI or headless mode. Write stdio with `try? FileHandle.write(contentsOf:)`, not raising `write(_:)`.

**Headless CLI** — both subcommands parse in `main.swift` **before** SwiftUI boots.

- `--list-sessions` prints JSON, **metadata only** (`joinUrl` redacted); `--reveal-urls` gates behind `NSAlert`, headless/SSH callers **denied** (exit 3).
- `--computer-follow <url> [--pair <token>]` (for `slicc <url> follow --computer`) runs **only** `ComputerTrayFollower`: no menu bar/widget, `NSApplication` `.accessory` (**not `.prohibited`** — that suppresses the TCC prompts). Stdout protocol: `SLICC_COMPUTER_FOLLOW_READY` **immediately** (an older launcher ignores the flag, boots its GUI, never exits), `..._ATTACHED` only after `hello` (**ready ≠ attached** — never before `onConnected`), else `..._FAILED` + exit 1. Exits when its **parent pid** dies (kqueue). `--pair` rides on `hello.pairId` so the leader folds it into the CLI's roster entry. `--computer-preflight [--json]` raises both prompts, reports grants (by hand always false — TCC attributes it to the terminal). Malformed **exits 2**.

## App Ordering, Followers, Startup, Mounts

`Models/AppOrdering.swift` holds default priority (drag-reorder via `AppOrderStore` wins); `StartupPreference` starts the top-ordered browser. `browserFollowerArgs` passes `--join=<url>` vs `--lead`; the lead-or-attach dialog counts only attachable iCloud sessions (all-dead → standalone). The **mount table** (`Models/MountTablePreference.swift`, Settings → Mounts) emits `--mount=<os>:<vfs>` (browsers only), served by `/api/hostfs`. [mounts](../../docs/mounts.md)

## Default Browser Role

Sliccstart can hold the macOS http/https handler role (Settings → Startup): `Models/DefaultBrowserRegistration.swift` claims it (precondition: `assemble-app.mjs`'s `CFBundleURLTypes`); `Models/IncomingURLRouter.swift` opens links over CDP. [details](../../docs/sliccstart-browser.md)

## Debug Build Creation

`Models/DebugBuildCreator.swift` builds Electron debug variants for apps that block remote debugging: copy to `~/Applications/<Name> Debug.app`, patch Electron fuses + `app.asar` CDP-blocking JS, ad-hoc sign, strip quarantine.

## App Icon

`build-app-icon.mjs` writes **`AppIcon.icns`** (flat, `CFBundleIconFile`) and **`Assets.car`** (`actool`-compiled from `macos-icon.icon`; `CFBundleIconName`). `buildIconAssetCatalog` **degrades instead of throwing** when `actool` is absent/too old (**common on CI**) — so a green build is **not** proof the appearance variants shipped; watch for `WARNING: appearance-keyed app icon skipped`.

## Packaging & Provisioning

`npm run build` assembles the `.app` from pre-built artifacts; `sign-and-package.sh` builds the distributable `Sliccstart-<v>.zip`. Expects `slicc-server` pre-built (webapp **not** bundled); **`WebRTC.framework` ships next to `slicc-server`** and re-signing is **innermost-first** or dyld kills every spawned server ("start failed"). iCloud sync needs an _embedded_ provisioning profile (**Developer ID signing alone doesn't authorize it**), gated on optional **`PROVISION_PROFILE`** (unset → local cache only; CI ships `S8LB56P782.ai.sliccy.trays`, **matched by the iOS follower**). Contract: `macos-permissions.test.mjs`.

## Updates

**Full-app-only**, driven by the external `AppUpdater` SPM package; the 2 s timer defers restart while `/api/agent-activity` shows work (`AgentActivityProbe` fails open after 1 s). Host: `--update-host` / `SLICC_UPDATE_HOST`. Load-bearing (translocation, pagination stop, reattach ordering in [details](../../docs/swift-launcher-details.md#updates)): `TolerantGithubReleaseProvider` skips releases lacking a `Sliccstart-<version>.zip`/`.tar` asset and pages via RFC 8288 `Link`; `LaunchRecordStore` persists `bridgeToken` but **no PID** (reattach re-forwards it, probes `CDPLiveProbe`); `reattachPersistedRecords()` **spawns only the thin-bridge `slicc-server`, no `--static-root`/overlay.**
