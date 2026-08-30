# CLAUDE.md

iOS follower in `packages/ios-app/` — iOS 26 SwiftUI SPM (`Package.swift`, not npm). **Follower only**: WebRTC to a SLICC leader (chat + sprinkles + limited federated CDP); no agent runtime. Deep reference: [`docs/ios-app-details.md`](../../docs/ios-app-details.md) ([related](../../docs/ios-app-details.md#related)).

SPM on macOS is a no-op; **Xcode project generated from `project.yml`, not committed** — `xcodegen generate` after clone and on source changes.

## Layout

- `SliccFollower/App/` — `SliccFollowerApp` + `SliccAppDelegate` (APNs); `@MainActor AppState` (`AppState+SudoApproval` = Face ID + push). `InboundActions` / `AppGroupInbox` / `OpenInSliccIntents` + `SliccShareExtension/` funnel `slicc://open|prompt` (+`x-callback-url`), `sliccy.ai/app/*` universal links, App Intents, share URLs in `group.ai.sliccy.follower`. Deep links confirm via card (fail-closed).
- `SliccFollower/{Models,Notifications,Sync,CDP}/` — `ScoopStatus`; `UnitRole`; `ICloudSessionList` + entitlements (`SliccTraySession` + KVS); `*Avatar*`. `NotificationCoordinator`: `SLICC_TURN_END` / `SLICC_SUDO_REQUEST` (hub `apns.ts`), local fallbacks, lock-screen Deny. `Keepalive`; `TerminalClient` (single-flight `exec.*`); `ConnectionSettle` behind `AppState.settledConnection`. `CDPBridge` + `CDPTarget` host WKWebViews as CDP targets.
- `SliccFollower/Views/` — chat / sprinkles (`.shtml`) / 48pt dock / terminal / tabs (`browserViewingTabId` hides rail) / `ToolProgressChrome`. Compact workbench sets `toolbarSuppressed`; http(s) in-app unless Settings → Advanced `openLinksInBuiltInBrowser` off.
- `SliccTrayFollower/` — `swift-trayfollower` (`TrayFollowerExports.swift`); `SyncProtocol.swift` (see Protocol).
- `SliccWidgets/` — **Cones & Scoops** (`com.sliccy.follower.widgets`); pixels from **`packages/swift-widgetkit`**. Snapshot JSON in `group.ai.sliccy.follower` (widget cannot hold a tray). Publish on `scoops.list`, connection/stall, `turn_end`; clear on detach. **Settled** health; label is display name or join URL HOST — **never the join URL**. [`docs/widgets.md`](../../docs/widgets.md).
- `SliccTrayKit/FileProvider/` + `SliccFileProvider/` — Files.app provider (`packages/swift-traykit` / `SliccTrayVFS`). Appex Info.plist MUST set `NSExtensionFileProviderSupportsEnumeration` or Files hides the domain (`userEnabled=false`).

Gotchas — App Intents from the **widget snapshot** (cold, no `AppState`); `OpenInSliccBrowserIntent` has **no** schema; View Annotations need 27 SDK (`canImport(AppIntentsTypeSupport)`): [intents](../../docs/ios-app-details.md#app-intents-entities-and-schemas). Read-only scoop: no `InputBar`, no scoop `tool_ui` card (`UnitRole.isReadOnly`): [read-only](../../docs/ios-app-details.md#read-only-scoop-view). Transcript: UIKit long-press (not `confirmationDialog`), phones → **Messages**, one `stat` never a walk; tables hug content; reading column **per row**: [short actions](../../docs/ios-app-details.md#transcript-short-actions) · [tables](../../docs/ios-app-details.md#markdown-tables) · [column](../../docs/ios-app-details.md#reading-column).

## App Icon

Three 1024s in `Assets.xcassets/AppIcon.appiconset`. `Icon-Tinted` is **hand-authored** (master `packages/assets/logos/slicc-icon-tinted-master-1024.png`) — iOS maps luminance onto the tint. Full-bleed square; `Icon-Dark` has pre-rounded corners. macOS does **not** consume this PNG ([swift-launcher](../swift-launcher/CLAUDE.md#app-icon)). [stats](../../docs/ios-app-details.md#app-icon).

```bash
magick Icon-Tinted.png -alpha remove -colorspace Gray \
  -format "min=%[fx:minima*255] sd=%[fx:standard_deviation*255]\n" info:
```

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`; matrix in `docs/architecture.md` is source of truth. iOS-local:

- `preview.open` → `CDPBridge.handleTabOpen`, acks `tab.opened`.
- iOS never originates transcript export; those prompts decode to `.unknown` / `undecodable`.
- `sudo.approve.request` / `.cancel` → `SudoApprovalController` (SliccTrayKit/Sudo); reply `sudo.approve.response`. Allow / Always pass `LAContext` `.deviceOwnerAuthentication` first, Deny never does. `hello` advertises `sudoApproval: true` and `biometric: true` iff the device can authenticate its owner. `push.register` carries the APNs token on every connect. [sudo + push](../../docs/ios-app-details.md#sudo-approval-and-push).
- `capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, scoped-approval gated. [exec](../../docs/ios-app-details.md#exec-capability); `--x-callback` nonces, JSON result, 16-param / 16-KiB caps: [x-callback](../../docs/ios-app-details.md#x-callback-exec).

New variants: six-step order ending in corpus + architecture matrix: [checklist](../../docs/ios-app-details.md#protocol-variant-checklist).

## Follower on `AppState`

Lifecycle `connect`/`disconnect`/`dataChannelOpened`/`handleDisconnect`; `Keepalive` splits **stalled** vs **dead** (`lastError`=transport, `leaderError`=cone); dispatch via `handleDataChannelMessage`. Swipe arbitration freezes edge state at drag start and fails closed. [invariants](../../docs/ios-app-details.md#follower-state-invariants) · [swipe](../../docs/ios-app-details.md#transcript-swipe-arbitration).

## iCloud Sessions

`AppState.sessionStore` uses **`packages/swift-traysession`**; launcher publishes, `SettingsView` joins. Liveness requires a connected leader. KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS. Unprovisioned builds have no cache; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. **Never expose `joinUrl`.** Attach loops after reconnect follow `TRAY_SUPERSEDED` / `SupersedeRedirect`: [supersede](../../docs/ios-app-details.md#icloud-tray-supersede-chain).

**Recent joins**: record on `dataChannelOpened` (after supersede, never at dial time); rows show label-or-`displayHost`, **never the join URL**. Hook: `-uiTestRecentJoinsFixture/Empty`. [recent](../../docs/ios-app-details.md#recent-joins).

**Frozen sessions**: `FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts` (read-only). Hook: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Hold empty composer to dictate (`PttController` + `Dictation`/`SFSpeechRecognizer`); release calls `InputBar.submit(_:dictated:)`. Only dictated replies speak (Kokoro for English, else `AVSpeechSynthesizer`); typed turns silent. `AudioSessionCoordinator` solely owns `AVAudioSession`. Hooks: `-uiTestSpeechPermission/Script`, `-uiTestPttStage`. Kokoro (~83 MB, Wi-Fi consent; replies never provision): [Kokoro](../../docs/ios-app-details.md#local-kokoro-models). QA: [`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md).

## Terminal

`InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`). One virtual shell per connection; Ctrl-C → `SIGINT` until `exec.response`.

## Agent Avatar

`SliccAgentAvatarView` mirrors `<slicc-agent-avatar>`. Fullness = pupil size only; recoverable state stays in avatar/composer (no banner). Widget is a **static** copy in `packages/swift-widgetkit` — change a ratio here, change it there ([avatar](../../docs/widgets.md#the-avatar)). Expression kit: time is a parameter, never ambient. **Brows paint outside the tile crop** (~3pt overhang at 26pt — hosts must not clip). Precedence: **local > wire > state**. **No connection state on the composer's first-responder layer**; only sending is gated; a regression test must stage a blip that HEALS. [treatment](../../docs/ios-app-details.md#agent-avatar-treatment).

## Build

```bash
cd packages/ios-app
xcodegen generate
xcodebuild build -project SliccFollower.xcodeproj -scheme SliccFollower \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO
swiftlint lint
```

## Test + coverage

Run `xcodebuild test` on a simulator. Coverage gate (`SliccFollowerTests` only, `.build/coverage/`) boots an iPhone matching the simulator SDK, retries infra failures, enforces `coverage-thresholds.json`. Override via worktree-owned `SLICC_IOS_SIM_UDID`. **Never pass `CODE_SIGNING_ALLOWED=NO` to tests** (XCTest needs ad-hoc signing). [coverage](../../docs/ios-app-details.md#coverage-gate-details).

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

## UI tests (`SliccFollowerUITests`)

`bundle.ui-testing` stays in the scheme; the unit gate excludes it. No test needs a leader — fixtures are `#if DEBUG` launch-argument hooks. **CI runs the whole bundle** on both GA cells of `ios-app-tests`, minus `ui-test-exclusions.json` (new class is gated on land; leaving CI needs a written reason — `npm run lint:ios-ui-tests` rejects stale entries). [hooks](../../docs/ios-app-details.md#ui-test-hooks) · [authoring](../../docs/ios-app-details.md#ui-test-details).

## Linting

SwiftLint + `swift format` inherit repo-root configs; only `error` fails CI. `npm run lint:swift:format` / `format:swift` from repo root. [lint](../../docs/ios-app-details.md#linting-details).

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. Script **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode < 26 (a green release is not proof an ipa shipped). [distribute](../../docs/ios-app-details.md#testflight-distribute).
