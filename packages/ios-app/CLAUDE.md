# CLAUDE.md

iOS follower app in `packages/ios-app/` — native iOS 26 SwiftUI SPM project (`Package.swift`), not an npm workspace. **Follower only**: connects to a SLICC leader over WebRTC (chat + sprinkles + limited federated CDP); no agent runtime. Deep reference: [`docs/ios-app-details.md`](../../docs/ios-app-details.md).

## Layout

- `SliccFollower/App/` — `SliccFollowerApp` (+ `SliccAppDelegate` for APNs callbacks), `@MainActor AppState` (`AppState+SudoApproval` = Face ID gate + push registration); inbound coordinator (`InboundActions`, `AppGroupInbox`, `OpenInSliccIntents`) + `SliccShareExtension/` funnel `slicc://open|prompt` (+`x-callback-url`), `sliccy.ai/app/*` universal links, App Intents, share URLs in `group.ai.sliccy.follower`. Deep links confirm via card (fail-closed).
- `SliccFollower/Models/` — `ScoopStatus`; `UnitRole` (the read-only rule, below); `ICloudSessionList` + `SliccFollower.entitlements` (iCloud via `SliccTraySession` + KVS); `*Avatar*`.
- `SliccFollower/Notifications/` — `NotificationCoordinator`: `UNUserNotificationCenter` delegate, categories `SLICC_TURN_END` / `SLICC_SUDO_REQUEST` (mirrors the hub's `apns.ts`), local fallbacks, lock-screen Deny.
- `SliccFollower/Sync/` — `Keepalive` (`DataChannelKeepalive`); `TerminalClient` (single-flight `exec.*`); `ConnectionSettle` (`ConnectionHealth` + `ConnectionSettler`, the blip hold behind `AppState.settledConnection`).
- `SliccFollower/CDP/` — `CDPBridge` + `CDPTarget` host WKWebViews as CDP targets.
- `SliccFollower/Views/` — `ChatView`/`MessageListView`/`MarkdownText` (`ChatPresentationState`; compact workbench sets `toolbarSuppressed`; http(s) links open in-app unless Settings → Advanced `openLinksInBuiltInBrowser` off); `SprinkleWebView`/`InlineSprinkleView`/`SprinkleDetailView` (`.shtml`); `DockModel`/`DockRail`/`WorkbenchHost`/`LucideIcon` (48pt rail); `TerminalView`/`TerminalViewModel`; `TabsCarouselView` (full-screen hides rail via `AppState.browserViewingTabId`); `ToolProgressChrome` (bash-progress row treatment — icon fill, dots, open-body bar — off `AppState.toolProgress`).
  - **Read-only scoop**: selecting a scoop opens a read-only transcript — `ConversationView` renders no `InputBar`, so send / dictation / attachment affordances and the reserved band all go with it, and a scoop's `tool_ui` never mounts a card (#2367, parity with the web's #2312). The rule is stated ONCE in `Models/UnitRole.swift` (`UnitRole.isReadOnly`, mirroring `isReadOnlyRole`) and reached via `AppState.selectedUnitIsReadOnly`; `ScoopSummary.isRootUnit` derives the role from the `parentId` edge and falls back to `isCone` only for leaders that predate it. Why + hooks: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#read-only-scoop-view).
  - **Reading column**: the regular-width cap (`MessageListLayout.maximumReadableWidth`) is applied **per row** via `readableTranscriptColumn()`, never as a frame around the transcript's `LazyVStack` (that stack carries `scrollTargetLayout()` and cancels any wrapping centering offset). Covered by `SliccFollowerUITests/TranscriptColumnUITests`; why: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#reading-column).
- `SliccTrayFollower/` (`swift-trayfollower`, re-exported via `TrayFollowerExports.swift`) — `Models/SyncProtocol.swift` (partial `Codable` mirror of `packages/shared-ts/src/tray-sync-protocol.ts`), `Models/{ChatMessage,TrayTypes,TrayChunkFraming}.swift`, `Networking/{TraySignaling,TrayFollowerConnector,WebRTCManager}.swift`.
- `SliccTrayKit/FileProvider/` + `SliccFileProvider/` — Files.app provider for leader VFS (logic in **`packages/swift-traykit`** / `SliccTrayVFS`, re-exported via `TrayVFSExports.swift`). Appex Info.plist MUST set `NSExtensionFileProviderSupportsEnumeration` or Files hides the domain (`userEnabled=false`).

Plain SPM commands do nothing on a macOS host; build/test go through XcodeGen. **Xcode project generated from `project.yml`, not committed** — run `xcodegen generate` after clone and whenever sources change.

## App Icon

`Assets.xcassets/AppIcon.appiconset` carries three 1024s: `Icon-Default`, `Icon-Dark` and `Icon-Tinted`.

`Icon-Tinted` is **hand-authored, not a desaturation of the colour icon** — master at `packages/assets/logos/slicc-icon-tinted-master-1024.png`. iOS tinted mode maps the asset's _luminance_ onto the user's tint, so an asset confined to the top of the range can only render as a flat blob. The previous `Icon-Tinted` was byte-identical to the Icon Composer `TintedLight` export and never dropped below 39% grey (min 100/255, σ 39); the current one spans the full range (min 0, σ 81) by seating a bright swirl in a near-black tub. Re-check `min`/`stddev` before replacing it:

```bash
magick Icon-Tinted.png -alpha remove -colorspace Gray \
  -format "min=%[fx:minima*255] sd=%[fx:standard_deviation*255]\n" info:
```

It is full-bleed square (iOS applies its own superellipse mask), unlike `Icon-Dark`, which still carries pre-rounded transparent corners. The macOS side does **not** consume this PNG — Sliccstart derives its tinted appearance from `macos-icon.icon`; see [swift-launcher](../swift-launcher/CLAUDE.md#app-icon).

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`; the matrix in `docs/architecture.md` is source of truth. iOS-local:

- `preview.open` → `CDPBridge.handleTabOpen`, acks `tab.opened`.
- iOS never originates transcript export; those prompts decode to `.unknown` / `undecodable`.
- `sudo.approve.request` / `.cancel` → `SudoApprovalController` (SliccTrayKit/Sudo); reply `sudo.approve.response`. Allow / Always pass `LAContext` `.deviceOwnerAuthentication` first, Deny never does. `hello` advertises `sudoApproval: true` and `biometric: true` iff the device can authenticate its owner. `push.register` carries the APNs token on every connect. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#sudo-approval-and-push).
- `capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, scoped-approval gated. URL validation + tombstoning: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#exec-capability); `--x-callback` nonces, JSON result shape, 16-param / 16-KiB caps: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#x-callback-exec).

Adding a variant is a fixed six-step order ending in the corpus + architecture matrix: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#protocol-variant-checklist).

## Follower on `AppState`

Lifecycle `connect`/`disconnect`/`dataChannelOpened`/`handleDisconnect`; `Keepalive` splits **stalled** vs **dead** (`lastError`=transport, `leaderError`=cone); dispatch via `handleDataChannelMessage`. Swipe arbitration freezes edge state at drag start and fails closed. Settle, VFS, lick and `tool_ui` invariants: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#follower-state-invariants); swipe detail: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#transcript-swipe-arbitration).

## iCloud Sessions

`AppState.sessionStore` uses **`packages/swift-traysession`**; launcher publishes, `SettingsView` joins. Liveness requires a connected leader. KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS. Unprovisioned builds have no cache; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. **Never expose `joinUrl`.** Attach loops after reconnect must follow `TRAY_SUPERSEDED` / `SupersedeRedirect`: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#icloud-tray-supersede-chain).

**Recent joins**: `AppState.recentJoinStore` (`RecentJoinStore`) records the join URL on `dataChannelOpened` — every path (paste, deep link, iCloud row, stored credentials), after any supersede hop, never at dial time — and syncs it, so a URL pasted on one device reaches the others. `SettingsView` renders the "Recent" section from `ICloudSessionList.recentRows` (live sessions excluded, `RecentJoinStore.rank` order, five rows); rows show label-or-`displayHost` and **never the join URL**. Replaced the device-local `joinUrlHistory`. Hooks: `-uiTestRecentJoinsFixture/Empty`.

**Frozen sessions**: `FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`; opens saved transcripts read-only. Hook: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Hold empty composer to dictate (`PttController` + `Dictation`/`SFSpeechRecognizer`); release calls `InputBar.submit(_:dictated:)`. Only dictated replies speak: English uses Kokoro, others `AVSpeechSynthesizer`; typed turns silent. `AudioSessionCoordinator` solely owns `AVAudioSession`. Hooks: `-uiTestSpeechPermission/Script`, `-uiTestPttStage`. Kokoro pack (~83 MB, Wi-Fi consent; replies never provision): [`docs/ios-app-details.md`](../../docs/ios-app-details.md#local-kokoro-models). QA: [`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md).

## Terminal

`InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`). One virtual shell per connection; Ctrl-C → `SIGINT` until `exec.response`.

## Agent Avatar

`SliccAgentAvatarView` mirrors the browser `<slicc-agent-avatar>`. Fullness = pupil size only, never ring/gauge/badge/text; recoverable state stays in avatar/composer (no banner row). Header layout, static treatment, a11y phrase and fixtures: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#agent-avatar-chrome).

**Expression kit**: `Models/AvatarExpression.swift` (UI-free grammar, band units) + `Models/AvatarExpressionEngine.swift` (integrator; time is a parameter, never ambient) drive shape morph, brows, chord-cut lids and gaze. `SliccAgentAvatarGeometry.activity == nil` keeps the legacy face; `expressionScale` is the only band→points bridge. Precedence: **local derivation > wire refinement > state** — `AppState.localExpressionSignals` owns the FOCUSED scoop, `ScoopSummary.activity` drives every other tab, `state` stays the closed four-value union so older followers are untouched. Parity gated by `Fixtures/expression-vectors.json` (both suites).

Trouble reaches the surface only after `ConnectionSettler.holdDuration` (recovery lands at once), and **no connection state may reach the composer's first-responder layer** — not `.disabled`, not `allowsHitTesting`, not mounting anything above the editor. Only sending is gated; a regression test must stage a blip that HEALS. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#agent-avatar-treatment).

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

Run `xcodebuild test` on a simulator. Coverage gate boots an iPhone matching the simulator SDK, retries infra failures, enforces `coverage-thresholds.json`. Override via worktree-owned `SLICC_IOS_SIM_UDID`. **Never pass `CODE_SIGNING_ALLOWED=NO` to tests** (XCTest needs ad-hoc signing).

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Outputs in `.build/coverage/`; the gate runs only `SliccFollowerTests`. Object selection, the `SliccFileProvider/` exclusion, and the memory-bound File Provider read limit: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#coverage-gate-details).

## UI tests (`SliccFollowerUITests`)

`bundle.ui-testing` stays in the scheme; the unit gate excludes it. Run `-only-testing:SliccFollowerUITests` on UI changes as a separate CI job. No test needs a leader — every fixture runs off a `#if DEBUG` launch-argument hook. Hook list: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#ui-test-hooks); authoring rules: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#ui-test-details).

## Linting

SwiftLint + `swift format` inherit repo-root configs; only `error` severity fails CI. Run `npm run lint:swift:format` / `format:swift` from repo root. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#linting-details).

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. Script **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode < 26 (a green release is not proof an ipa shipped). Distribution + What to Test copy: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#testflight-distribute).

## Related

`packages/shared-ts/src/tray-sync-protocol.ts` (canonical), `packages/webapp/src/scoops/tray-leader-sync.ts`, `packages/webapp/src/scoops/tray-follower-sync.ts`, `packages/webapp/src/ui/sprinkle-follower-controller.ts`; `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"; `docs/ios-simulator-qa.md`; `docs/ios-app-details.md`.
