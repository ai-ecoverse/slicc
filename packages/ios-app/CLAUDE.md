# CLAUDE.md

iOS follower app in `packages/ios-app/` — native iOS 26 SwiftUI SPM project (`Package.swift`), not an npm workspace. **Follower only**: connects to a SLICC leader over WebRTC (chat + sprinkles + limited federated CDP), no agent runtime. Deep reference: [`docs`](../../docs/ios-app-details.md).

Plain SPM commands do nothing — build/test go through XcodeGen. **The Xcode project is generated from `project.yml`, not committed**: run `xcodegen generate` after clone and when sources change.

## Layout

- `SliccFollower/App/` — `SliccFollowerApp` (+ `SliccAppDelegate` for APNs), `@MainActor AppState` (`AppState+SudoApproval` = Face ID gate + push); inbound coordinator + `SliccShareExtension/` funnel `slicc://`, universal links, App Intents + share URLs (deep links confirm via card, fail-closed): [`docs`](../../docs/ios-app-details.md#inbound-entry-points).
- `SliccFollower/Models/` — `ScoopStatus`; `UnitRole` (read-only rule, below); `ICloudSessionList` + `.entitlements`; `*Avatar*`.
- `SliccFollower/Notifications/` — `NotificationCoordinator` (`UNUserNotificationCenter` delegate): categories `SLICC_TURN_END`/`SLICC_SUDO_REQUEST` mirror hub `apns.ts`; local fallbacks + lock-screen Deny.
- `SliccFollower/Sync/` — `ThreadSync` (background per-unit prefetch via `request_snapshot.peek`, leader ≥ 9: [`docs`](../../docs/ios-app-details.md#background-thread-sync)); `LocalSendLedger`; `Keepalive`; `TerminalClient` (single-flight); `ConnectionSettle` (`ConnectionHealth`+`ConnectionSettler` = blip hold behind `settledConnection`). `SliccFollower/CDP/` — `CDPBridge`+`CDPTarget` host WKWebViews as CDP targets.
- `SliccFollower/Views/` — chat, sprinkles (`.shtml`), dock (48pt rail), `TerminalView`, `TabsCarouselView`, `ToolProgressChrome`, thread list (`ScoopSwitcher` → `ThreadListView`). Light/dark follows the device (`ThemePalette.resolve`); a leader theme supplies its full palette when `base` matches, and only `--ctx` otherwise. Terminal stays always-dark. Chrome gotchas, thread layout + parity: [chrome](../../docs/ios-app-details.md#chat-view-chrome), [list](../../docs/ios-app-details.md#thread-list), [parity](../../docs/ios-app-details.md#thread-decoration-parity). View invariants:
  - **Read-only scoop** — no `InputBar`, `tool_ui` mounts no card. Rule lives ONCE in `Models/UnitRole.swift` (`UnitRole.isReadOnly`) via `selectedUnitIsReadOnly`: [`docs`](../../docs/ios-app-details.md#read-only-scoop-view)
  - **Transcript** — short actions paint through `Views/TranscriptText.swift` (`UITextView`); `FileMentionResolver` confirms with ONE leader `stat`; reading column caps **per row** (`readableTranscriptColumn()`): [`docs`](../../docs/ios-app-details.md#transcript-short-actions)
  - **Composer is a bottom inset** — `InputBar` rides `.safeAreaInset`, never a `VStack` sibling; a snapshot never erases an unconfirmed send (`Sync/LocalSendLedger`); a v10 `user_message_ack` `rejected` flags the bubble with the leader's reason, `accepted` never releases the ledger: [`docs`](../../docs/ios-app-details.md#the-composer-is-a-bottom-inset-not-a-sibling)
  - **`MessageListView` is a `ZStack`, not a `Group`** (a `Group` rebuilds the floating-glass composer, losing its state) and the transcript keeps `.id(selectedScoopJid)` (one scroll view per unit, or a shorter thread opens blank): [float](../../docs/ios-app-details.md#the-composer-and-nav-bar-pills-float), [per-unit id](../../docs/ios-app-details.md#one-scroll-view-per-unit)
  - **Provider error parity** — `Models/ErrorFamilies.swift` mirrors the web exhausted-budget table (Adobe/Grok); follower cards stay actionless (changes are the leader's): [`docs`](../../docs/ios-app-details.md#follower-state-invariants)
- `SliccTrayFollower/` (`swift-trayfollower`, via `TrayFollowerExports.swift`) — sync/networking; `Models/SyncProtocol.swift` is a partial `Codable` mirror (below).
- `SliccWidgets/` — **Cones & Scoops** widget extension (`com.sliccy.follower.widgets`, incl. lock-screen/StandBy); pixels from **`packages/swift-widgetkit`** (`SliccWidgetKit`). No tray connection: the app captures a `WidgetSnapshot` into `group.ai.sliccy.follower` (`AppState+WidgetSnapshot.swift`) from **settled** health; label is name-or-HOST, **never the join URL**; must not import WebRTC (`npm run lint:swift-forbidden-imports`): [`docs/widgets.md`](../../docs/widgets.md).
- `SliccTrayKit/FileProvider/` + `SliccFileProvider/` — Files.app provider for leader VFS (logic in **`packages/swift-traykit`**/`SliccTrayVFS` via `TrayVFSExports.swift`). Appex Info.plist MUST set `NSExtensionFileProviderSupportsEnumeration` or Files hides the domain.
- **App icon**: `Icon-Tinted` (`AppIcon.appiconset`) is **hand-authored, not a desaturation** and must span the full luminance range (iOS masks luminance onto the tint); master + `min`/`stddev` re-check: [`docs`](../../docs/ios-app-details.md#app-icon).

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts` (the `docs/architecture.md` matrix is canonical). iOS-local messages (`preview.open`, `sudo.approve.*`, `capabilities.exec`, `computers.*`) + the six-step variant order: [`docs`](../../docs/ios-app-details.md#protocol-mirror-ios-local-messages). Safety-critical: exec accepts only `open [--universal|--x-callback] <url>` scoped-approval gated; iOS never originates transcript export, never advertises `capabilities.computer`.

## Follower on `AppState`

`Keepalive` splits **stalled** vs **dead** (`lastError`=transport, `leaderError`=cone); dispatch via `handleDataChannelMessage` (the only iOS switch). Swipe arbitration freezes edge state at drag start, fails closed. Settle/VFS/lick/`tool_ui`/swipe: [`docs`](../../docs/ios-app-details.md#follower-state-invariants).

## iCloud Sessions

`AppState.sessionStore` (**`packages/swift-traysession`**) discovers trays; KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. **Never expose `joinUrl`** (screen or widget). Reconnect follows `TRAY_SUPERSEDED`/`SupersedeRedirect`; `FrozenSessions.swift` opens saved transcripts read-only: [`docs`](../../docs/ios-app-details.md#icloud-sessions-and-joins). **Recent joins**: `RecentJoinStore` records + syncs on `dataChannelOpened` (not at dial time); `SettingsView` shows label-or-`displayHost`, never the URL: [`docs`](../../docs/ios-app-details.md#recent-joins).

## Push to Talk · Terminal

Hold empty composer to dictate; only dictated replies speak (typed turns silent), `AudioSessionCoordinator` solely owns `AVAudioSession`: [ptt](../../docs/ios-app-details.md#push-to-talk), [Kokoro ~83 MB Wi-Fi consent](../../docs/ios-app-details.md#local-kokoro-models). Terminal: `InMemoryTerminalSession` + `TerminalClient` exec the leader shell (`hello.capabilities.exec`), one per connection: [`docs`](../../docs/ios-app-details.md#terminal).

## Agent Avatar

`SliccAgentAvatarView` mirrors the browser `<slicc-agent-avatar>`; fullness = pupil size only, recoverable state stays in avatar/composer (no banner row). Chrome, expression kit, fixtures: [`docs`](../../docs/ios-app-details.md#agent-avatar-chrome). Load-bearing: **no connection state may reach the composer's first-responder layer** (not `.disabled`, `allowsHitTesting`, nor mounting above the editor) — only sending is gated; trouble surfaces after `ConnectionSettler.holdDuration`. The widget keeps a test-pinned **static** parity copy of the geometry + grammar (`UnitAvatarGeometry`/`UnitAvatarFace` in `packages/swift-widgetkit`): [`docs/widgets.md`](../../docs/widgets.md#the-avatar).

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

Run `xcodebuild test` on a simulator. The gate boots a matching iPhone, retries infra failures, enforces `coverage-thresholds.json` (`SliccFollowerTests` only; `SLICC_IOS_SIM_UDID` overrides). **Never pass `CODE_SIGNING_ALLOWED=NO` to tests** (XCTest needs ad-hoc signing). Object selection, `SliccFileProvider/` exclusion: [`docs`](../../docs/ios-app-details.md#coverage-gate-details).

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

**Isolation.** Both bundles are serial (`-parallel-testing-enabled NO`); independence comes from **random execution order** (per target in `project.yml`) + per-test state via `makeIsolatedDefaults` (`SliccFollowerTests/IsolatedTestDefaults.swift`), **never `UserDefaults.standard`**. `ios-sim-prepare.sh` erases both containers per run; `npm run lint:ios-test-isolation` gates: [`docs`](../../docs/dev-tools-details.md#ios-test-isolation-gate).

## UI tests (`SliccFollowerUITests`)

`bundle.ui-testing` stays in the scheme; the unit gate excludes it. No test needs a leader — every fixture runs off a `#if DEBUG` launch-argument hook. **CI runs the whole bundle** (both `ios-app-tests` cells) minus `ui-test-exclusions.json`; leaving CI needs an entry there with a reason (`npm run lint:ios-ui-tests` rejects stale): [`docs`](../../docs/ios-app-details.md#ui-test-details).

## Linting · TestFlight

SwiftLint + `swift format` inherit repo-root configs; only `error` severity fails CI (`npm run lint:swift:format`/`format:swift`): [`docs`](../../docs/ios-app-details.md#linting-details).

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. It **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode < 26 — green is no proof an ipa shipped: [`docs`](../../docs/ios-app-details.md#testflight-distribute).

## Related

Leader side: `packages/shared-ts/src/tray-sync-protocol.ts` (canonical), `packages/webapp/src/scoops/{tray-leader-sync,tray-follower-sync}.ts`, `packages/webapp/src/ui/sprinkle-follower-controller.ts`; `docs/architecture.md` "Multi-Browser Sync (Tray)"; QA: [`docs`](../../docs/ios-simulator-qa.md).
