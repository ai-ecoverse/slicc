# Swift Launcher Details

Deep-reference companion to [`packages/swift-launcher/CLAUDE.md`](../packages/swift-launcher/CLAUDE.md). Extended rationale that does not fit the package guide's size budget.

## optel

`.optelAutoInstrument`'s `error` hook only catches Objective-C `NSException`s — Swift errors are values and cannot be intercepted globally. `Models/LauncherErrorReport.swift` bridges every `do/catch` boundary in the launcher:

- `LauncherErrorReport.report(.<operation>, error)` emits an `error` checkpoint with `source = sliccstart:<operation>`. The `Operation` enum values (`update-check`, `update-detach`, `bootstrap`, `bootstrap-update`, `launch-standalone`, `launch-electron`, `auto-launch`, `debug-build`, `terminal-follower`, `reattach`, `secrets-unlock`, `secrets-persist`) are a wire contract — RUM dashboards filter on these strings.
- `target` is the bridged error domain plus its description, redacted before it leaves the machine: URLs collapse to `<url>` (a join URL carries the session secret), absolute paths to `<path>` (home reveals the user name), `token`/`secret`/`password`/`key` values to `<redacted>`, whitespace collapses, and the result truncates to `maxTargetLength`.
- Add a new call site together with an `Operation` case and a `log.error` line. Never report the up-to-date outcome of an update check (`AUError.cancelled`) — that is a normal result, not a fault.
- `Optel.sample` no-ops until `.optelAutoInstrument` has configured a session, so reporting from a failure that happens before instrumentation mounts (or from a unit test) is safe.

## terminal-followers

`SliccCliLocator` resolves an executable in this order: managed `~/Library/Application Support/Sliccstart/bin/slicc`, the repository's local `make build` output, its architecture-specific `make dist` output, then `/usr/local/bin`, `~/.local/bin`, `/opt/homebrew/bin`. The CLI is never bundled in `Sliccstart.app`.

If none is found, the launcher asks before downloading the current Darwin release from `https://www.sliccy.ai/download/slicc-cli/darwin-<arch>`, validates its Developer ID Application signature and release team identifier (`S8LB56P782`) before making it executable or running `--version`, then atomically installs it in the managed location. A successful terminal launch exposes that managed binary through `~/.local/bin/slicc`; the best-effort symlink step preserves regular files and unrelated user symlinks, and only re-points stale links under Sliccstart's own Application Support root.

Release Darwin binaries are signed and notarized, but a bare Mach-O gets no stapled ticket — see [`docs/pitfalls.md`](pitfalls.md) § "Downloaded `slicc` CLI" for why Sliccstart neither strips quarantine nor trusts `spctl`.

## icloud-sync

`SessionReachability` follows bounded supersede chains — the `successor-version` `Link` header (`SupersedeLink`, #1957) first, the 409 `TRAY_SUPERSEDED` body second — so a hop survives a body shape this build does not model. Only a terminal HTTP 200 with `leader.connected == true` is live. Replacement URLs stay private.

- **Producer** — `SliccstartApp` publishes non-nil `leaderJoinUrl`, withdraws when cleared, and refreshes every 4 hours. Clean quit withdraws; update/detach does not because the browser survives and relaunch republishes.
- **Consumer** — `AppListView` probes remote rows on section appearance/store reload and stably sorts live/unprobed first. Unreachable rows use `icloud.slash`, `· not responding`, 0.55 opacity, and disable Attach/Follow, not Copy; local rows skip probing. Remote Follow passes a join URL override; Attach-browser uses `launchBrowserFollower`. The browser-row lead-or-attach flow counts only attachable sessions (`TraySessionPresentation.attachableSessions`: no confirmed-unreachable verdict; unprobed still counts so a slow probe never hides a live session) — when every advertised session is unreachable the row launches standalone with no dialog, and the dialog's attach buttons drop dead sessions live as verdicts land. Clicking a browser row re-probes so those verdicts stay fresh while the dialog is open.

### Keeping the advertised join URL true

`startLeaderProbe` is _discovery_: it stops for good the moment a join URL lands. But the tray is minted by the browser, and a tab that reloads or has its tray superseded mints a new one — after which the discovered URL names a tray with no leader on it. Two beats keep the advertisement honest, and neither is optional:

- **`SliccProcess.startLeaderJoinUrlWatch()`** (`SliccProcess+LeaderJoinUrl.swift`, 60 s) re-reads `/api/tray-status` and adopts a changed URL via `refreshLeaderJoinUrl`. `RootView`'s `onChange` publishes the new one, and `LauncherModel.leaderJoinUrlChanged(_:previous:)` withdraws its predecessor — sessions are keyed by `SHA256(joinUrl)`, so a re-mint otherwise _adds_ a row and the device advertises a dead session until the 12 h TTL sweeps it. A failed probe never clears a known URL: a transient miss and "the tray is gone" are the same answer over HTTP, and losing the browser is `clearLeaderIfNoBrowserRunning`'s job. The loop idles (no HTTP) while no leader browser runs, so a leader started later is picked up without a restart.
- **`LauncherModel.republishLeaderSession()`** (4 h, well inside the TTL) re-reads the tray _before_ stamping `lastSeenAt`, and publishes nothing when the leader does not answer. Stamping the cached URL made the beat a liar twice over: it kept a superseded tray advertised, and — since a `Timer` fires on any run-loop tick it gets, including a dark wake on a sleeping Mac — it kept re-floating the session of a machine whose lid had been shut for hours, so it never aged out. The other device's `SessionReachability` probe then correctly reported "not responding" for a session this Mac was still swearing to.

The symptom that found this: a live leader on one Mac showing as "not responding" in the iOS follower's iCloud list while `Sliccstart --list-sessions` reported a `lastSeenAt` minutes old. The one-way session id is what makes it diagnosable without revealing a secret — `shasum -a 256` of the live `/api/tray-status` `joinUrl` either matches the advertised `id` or it does not.

- **Security** — secret-bearing join URLs sync only through same-Apple-ID, encrypted iCloud KVS. `TraySessionLauncherTests` covers row state and Follow.

## finder-file-provider

macOS Finder integration mirrors the iOS Files.app mount: `SliccFileProvider.appex` (`NSFileProviderReplicatedExtension`) exposes the leader VFS under Locations as "Sliccy". Provider logic lives in **`packages/swift-traykit`** (`SliccTrayVFS`) and is shared with the iOS follower appex.

- **Build** — SPM cannot emit `.appex` bundles, so `packages/swift-launcher/project.yml` (XcodeGen) defines the extension target; `assemble-app.mjs` runs `xcodebuild` and `stageFileProviderAppex` copies the product into `Contents/PlugIns/` **with an appex-local `WebRTC.framework`**. The binary links `@rpath/WebRTC.framework/WebRTC` with rpaths `@executable_path/../Frameworks` and `@executable_path/../../../../Frameworks` (host `Contents/Frameworks`). slicc-server needs the same framework at `Contents/Resources` (`@loader_path`); a sandboxed File Provider cannot load that copy. Missing the nested framework makes fileproviderd fail with `extensionKit error 2` / "A connection to the extension could not be made," and Finder shows _"Sliccstart encountered an error. Items may be out of date."_
- **Icon** — Finder Locations uses the _appex_ icon, not the host's. `stageFileProviderAppex` copies the host `AppIcon.icns` into the appex `Resources/` and `Info.plist` sets `CFBundleIconFile=AppIcon`. Without it the sidebar is a generic document glyph.
- **Credentials** — when `leaderJoinUrl` is set, `FileProviderCoordinator` writes the join URL into the team-prefixed app group (`S8LB56P782.com.slicc.sliccstart.fileprovider`) as a 0600 file (`Library/Application Support/slicc-tray-credentials/join-url`). macOS cannot put `keychain-access-groups` on the appex: that restricted entitlement needs an appex-specific Developer ID profile (the host profile is `com.slicc.sliccstart`), and AMFI otherwise refuses spawn (`No matching profile found` / POSIX 163 / extensionKit error 2). iOS still uses the keychain. Tray id is `SyncedTraySession.identifier(forJoinUrl:)`.
- **Domain lifecycle** — `FileProviderDomainLifecycle` (shared) registers `slicc-vfs` with `supportsSyncingTrash=false` (the leader VFS has no trash; FPFS otherwise asks the appex to materialize one). It re-adds domains stuck at `userEnabled=false` (from before `NSExtensionFileProviderSupportsEnumeration`) or still carrying the default trash flag, and withdraws on clean quit (not on update/detach). Settings → Startup toggles Finder integration (`fileProvider.finderEnabled`).
- **Signing** — appex is App Sandbox + `network.client` / `network.server` (WebRTC ICE) with its own entitlements and **no** `keychain-access-groups`; `sign-and-package.sh` signs the nested `WebRTC.framework`, then the appex, then the outer app. User enablement is still required once in System Settings → Login Items & Extensions → File Provider.
- **Limits** — mount is live only while a leader is up; `FileProviderFSClientPool` maps outages to `serverUnreachable`. `readBinaryFile` is all-in-memory today — large Finder drags may need streaming later.

### Headless CLI (`Sliccstart --list-sessions`)

The iCloud store is readable only by this signed, iCloud-entitled binary, so the Go `slicc` CLI shells out to a subcommand parsed in `main.swift` before the SwiftUI app boots (`TraySessionCLI.parse` returns `nil` for a normal launch). `--list-sessions` prints active sessions as JSON, metadata only (`joinUrl` redacted). `--reveal-urls` adds `joinUrl` behind a consent gate: a remembered "Always" (`UserDefaults`, keyed by caller code-signing id / path) wins; else an `NSAlert` (Deny / Allow Once / Always Allow / Always Deny) shows in a GUI session and a headless/SSH caller is denied (exit 3). Pure logic in `Models/TraySessionCLI.swift` is unit-tested (`TraySessionCLITests`); untestable glue (NSAlert, `getppid`/`proc_pidpath`/`SecCode`, store read) sits in `TraySessionCLIRunner`. Caller identity is spoofable, so redaction-by-default is the real control and the dialog a speed bump.

## updates

`Models/UpdateCheckStatus.swift` is the footer's report on the last check (`idle`, `checking`, `upToDate`, `noInstallableRelease`, `translocated`, `failed(message)`). `AppUpdater` hands every failure to a callback and otherwise only publishes a downloaded bundle, so without this a rate-limited or asset-less check was indistinguishable from "never checked" and the footer just kept offering "Check for Updates". `AUError.cancelled` maps to `upToDate` (that is how `findViableUpdate` says "nothing newer"); `AppUpdater.Error.noValidUpdate` to `noInstallableRelease`.

`AppUpdater` stages its download next to `Bundle.main.bundleURL` before it ever hits the network, so a translocated launch (Gatekeeper copies an unmoved, quarantined `.app` to a read-only synthetic volume under `.../T/AppTranslocation/...`) fails every check with Cocoa's `NSFileWriteVolumeReadOnlyError`; that specific code maps to `translocated` instead of the raw OS error text so the footer tells the user to move the app to `/Applications`.

`Models/TolerantGithubReleaseProvider.swift` tolerates release-naming drift in the `ai-ecoverse/slicc` release history. It also filters out releases lacking an installable macOS asset (`Sliccstart-<version>.zip`/`.tar`), so `AppUpdater` falls back to the newest release that actually ships a binary (needed now that native artifacts are conditionally built). Because the repo releases many times a day while the macOS artifact is built only on `packages/swift-launcher/**` changes, the newest installable release routinely sits beyond the default 30-release page: the provider requests `per_page=100` and follows the RFC 8288 `Link: rel="next"` chain (same host, HTTP(S) only) until a page yields a viable release or reaches `currentVersion` — the release the running build came from, since nothing older can ever be an update.

"Reached" is not "saw an older tag": `/releases` is creation-ordered, so a backport published after a newer release, or a non-semver tag decoding to `Version.null`, would otherwise stop page one and hide the installable release further back. `hasReached(_:on:)` therefore stops only when the page carries the running build's own version or when every _parsed_ release on it is older, ignoring unparsable tags. `maxReleasePages` is only a loop guard for a host whose `Link` chain never terminates, not the intended stop. `currentVersion` defaults to `Bundle.main.version` (the same value `AppUpdater` compares against) and `fetchPage` injects a stub transport; both are pinned in tests because the XCTest host bundle's version is unrelated to the release history.

`Models/LaunchRecordStore.swift` persists a `PersistedLaunchRecord` JSON (servePort, CDP port, electronAppPath, target name, target type, joinUrl, bridgeToken) at `~/Library/Application Support/Sliccstart/launch-records.json`, plus `CDPLiveProbe` for liveness checks via `/json/version`. No PID is stored — process identity isn't needed for reattach because the CDP port answering `/json/version` is what decides whether the previous browser is still alive. The `bridgeToken` is persisted because the surviving browser tab carries it in its launch URL (`?bridgeToken=<token>`); reattach re-forwards the same token so the re-spawned `--serve-only` slicc-server keeps gating `/cdp` against the secret the tab already has, instead of a freshly-minted static one. Legacy records carrying a `staticRoot` key still decode; the extra key is ignored, and a missing `bridgeToken`/`joinUrl` key loads as nil.

Reattach also has to recover `leaderJoinUrl`, because that single value gates every Electron/terminal row (`isLeaderReady()`) and all iCloud session advertising. `reattach` therefore calls `startLeaderProbe` — **after** `spawn` has registered the launch record, not before. The probe loop's per-round decision is the pure `SliccProcess.leaderProbeStep`: it probes while a `chromiumBrowser` record is live, stops once a join URL lands or a record it had already seen goes away, and — the part that matters here — _waits_ (bounded by `leaderProbeRecordWaitRounds` × `leaderProbeRecordWaitDelay`, ~6 s) for a record that has never appeared yet. `reattachPersistedRecords` is nonisolated `async`, so the probe's first main-actor hop can beat the record insertion; treating that as terminal left `leaderJoinUrl` nil for the entire session after a smooth update, which showed up as every desktop app stuck on "Start a browser first" with a perfectly healthy leader. Tests: `SliccProcessLeaderProbeTests`.

## swiftui-testing

`SliccstartTests/ViewHosting.swift` renders a view off-screen with `ImageRenderer` and returns a digest of the bitmap, so a test can assert that two states of a view **render differently** (`assertRendersDifferently`) — the only way to reach `AppListView` / `SettingsView` body branches from a unit test.

- **No interaction.** Headless SwiftUI on macOS builds no AppKit control tree and no accessibility tree, so buttons cannot be pressed. Button _actions_ are tested through the plain types they delegate to (`BrowserLaunchAction`, `TerminalLaunchDecision`, `AppRow.statusDot`, …) — keep new view logic in such a type rather than inline in a closure. The exception is `.borderless` buttons, which do materialize as `NSButton`s (`ViewHosting.hostedButtons`, used for `TraySessionRow`).
- **CI runs an older macOS than your Mac** (`macos-latest` is still macOS 15). How much of an AppKit-hosted subtree — `Table`, and anything overlaid on one — an off-screen render produces differs between them, so a render comparison that passes locally is not evidence it passes in CI. Compare only over plain SwiftUI content.
- **Vary exactly one thing per comparison.** Two states that differ in more than one way render differently whether or not the feature under test exists. Pin everything else (`subtitleOverride:`, identical messages, an empty `Secret`), or assert the underlying rule (`AppListView.updateAffordance`, `SecretEditorSheet.validationMessage`) instead of writing a comparison that cannot fail. Mutate the source and watch the test go red before trusting it.
- **`Table`, `Toggle` and `.borderless` buttons draw nothing** (`NSTableView`/`NSSwitch`-backed), so table cells, switch knobs, and anything styled by tint on a borderless button are asserted against their model types instead.

Views take their non-injectable state as init seams: `AppListView(isBundledBuild:)` (the whole update footer is otherwise unreachable outside a packaged `.app`), `MountsSettingsView(rows:)`, `SecretsSettingsView(secrets:unlocked:selection:)` (never touches the Keychain).

**The window is a model, not a `Scene`.** An `App`'s `Scene` cannot be rendered, so anything living inside `WindowGroup` is untestable by construction. `SliccstartApp` is therefore only wiring: the window's behavior is **`Models/LauncherModel.swift`** (launch decisions, dialogs, debug builds, update-check outcomes, the 2 s tick, leader publish/withdraw) and its content is **`Views/RootView.swift`**. `SliccstartAppDelegate` is the composition root, with every collaborator defaulted-but-injectable so the two quit paths (stop-everything vs detach-for-update) are testable. Put new window behavior on `LauncherModel`, not in a `WindowGroup` closure. Tests: `LauncherModelTests`, `RootViewRenderTests`, `AppDelegateLifecycleTests`.

**Launch paths** go through `SliccProcess.SpawnServices` — resolve-binary, run-process, is-port-in-use. Injected so `launchStandalone` / `launchBrowserFollower` / `launchWithElectronApp` are testable without starting a browser or binding 5710/9222; the stub runs `/bin/sleep` in the server's place so records, pids and termination handling stay real. Tests: `SliccProcessLaunchPathTests`.

**Auto-launch requires an installed app.** `StartupPreference.shouldAutoLaunch` is `resolveEnabled && isInstalledLocation` — a copy running from a build directory, `~/Downloads`, or Gatekeeper's translocated path never starts a browser, so a dev/CI run of the launcher cannot take over the screen. The preference is untouched and the Startup tab explains the refusal.

`SliccProcess`, `SliccBootstrapper` and `AppManagementPermission` are deliberately **not `final`** — they are the app's side-effecting collaborators (spawning browsers, running git/npm, opening System Settings), and `@testable` lets a test subclass stand in for them.

## app-icon

Two artefacts, both written by `build-app-icon.mjs`:

- **`AppIcon.icns`** — one flat image from `packages/assets/logos/macos-icon-iOS-Default-1024x1024@1x.png`, via `sips` + `iconutil` (both ship with macOS). `CFBundleIconFile`.
- **`Assets.car`** — `actool`-compiled from `packages/assets/logos/macos-icon.icon` (Icon Composer). Adds the `NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua` / `ISAppearanceTintable` icon stacks macOS 26 picks between. `CFBundleIconName`, emitted into `Info.plist` only when the compile succeeds.

`buildIconAssetCatalog` **degrades instead of throwing** on all three failure modes — the bundle still gets its `.icns`, just with no Dark/Tinted appearance:

1. `actool` absent (it lives in Xcode, not the Command Line Tools);
2. `actool` present but too old to compile the `.icon` — **this is the common case in CI**, whose `swift-launcher` job runs on `macos-latest` (still macOS 15 / Xcode 16.x); only `release.yml` pins `macos-26`;
3. `actool` exits 0 but writes no `Assets.car`.

A green `swift-launcher` CI build is **not** proof the appearance variants shipped — only the `macos-26` release job produces them. Watch for the `WARNING: appearance-keyed app icon skipped` line if a build's icon stops adapting, and confirm what actually shipped with `xcrun assetutil --info <app>/Contents/Resources/Assets.car`.

A classic `AppIcon.appiconset` cannot replace the `.icon` here: `actool` honours the `appearances` key on iOS idioms only and reports macOS ones as "unassigned children", dropping them without failing the build. Per-appearance _custom artwork_ (`image-name-specializations`) exists in the `.icon` format but is authored in Icon Composer — hand-written variants of that key are silently ignored, so the macOS Tinted icon is **system-derived** from the layer artwork. Its contrast is therefore a property of `macos-icon.icon`'s layer, not something a separate PNG can override. Tests: `build-app-icon.test.mjs`.

## packaging

- `npm run build` assembles the `.app` from pre-built artifacts; `sign-and-package.sh` is the distributable path.
- Expects `packages/swift-server/.build/release/slicc-server` to be pre-built. Webapp is **not** bundled — `assemble-app.mjs` writes an empty `Contents/Resources/slicc` marker dir.
- **`WebRTC.framework` ships next to `slicc-server`**: `sign-and-package.sh` re-signs **innermost-first** — else dyld fails and every spawned server dies as "start failed".
- Electron overlay bootstrap `dist/ui/electron-overlay-entry.js` is produced by **`@ai-ecoverse/spoon`** (`npm run build -w @ai-ecoverse/spoon`) and must be built before `assemble-app.mjs`; a `packages/spoon/**` change re-triggers this CI job.
- Packaging emits only the full `Sliccstart-<v>.zip`.

## ordering-mounts-browser

`Models/AppOrdering.swift` holds default `browserBundlePriority` / `terminalBundlePriority`; user drag-reorder via `AppOrderStore` UserDefaults wins. `browserFollowerArgs(cdpPort:joinUrl:)` passes `--join=<url>` vs `--lead`; `launchBrowserFollower` flags `isFollower`. `BrowserLaunchAction` and the lead-or-attach dialog count only attachable iCloud sessions (no confirmed-unreachable `SessionReachability` verdict) — all-dead lists launch standalone with no dialog. `Models/StartupPreference.swift`: launch starts the top-ordered browser (`AppOrdering.topBrowser`). Tests: `AppOrderingTests`, `StartupPreferenceTests`, `SliccProcessLaunchArgsTests`.

`Models/MountTablePreference.swift`: newline-separated `autoMountTable` UserDefault of `os-path:slicc-path` mappings (parse mirrors swift-server `ServerConfig.parseMountMapping`: last-colon split, `~` expansion, dedup by target), emitted as `--mount=<os>:<vfs>` by `standaloneBrowserArgs(cdpPort:mounts:)` and `reattachArgs(...mounts:)` (browsers only). Mapped folders are served by swift-server's `/api/hostfs` and auto-mounted by the webapp — no picker, no permission prompt. `Views/SettingsView.swift` → `MountsSettingsView`. Tests: `MountTablePreferenceTests`, `SliccProcessLaunchArgsTests`. Behaviour: [`docs/mounts.md`](mounts.md#auto-mounted-host-folders-the-mount-table).

Sliccstart can hold the macOS http/https handler role (Settings → Startup). `Models/DefaultBrowserRegistration.swift` claims it; `assemble-app.mjs`'s `CFBundleURLTypes` is the precondition; `Models/IncomingURLRouter.swift` opens each link over CDP. See [`docs/sliccstart-browser.md`](sliccstart-browser.md).
