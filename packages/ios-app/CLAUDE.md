# CLAUDE.md

This file covers the iOS follower app in `packages/ios-app/`.

## Scope

`packages/ios-app/SliccFollower/` is a native iOS SwiftUI app (`SliccFollower`) that connects to a SLICC leader over WebRTC and presents the leader's chat + sprinkles + (limited) federated CDP to a local user. It is **a follower only** — it does not host an agent runtime.

`packages/ios-app` is a Swift Package Manager project (`Package.swift`), not an npm workspace. XcodeGen generates its Xcode project from `project.yml`.

## Layout

| Path                                                                                                 | Purpose                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SliccFollower/App/SliccFollowerApp.swift`, `App/AppState.swift`                                     | App entry + central `@MainActor AppState`                                                                               |
| `SliccFollower/Models/SyncProtocol.swift`                                                            | Partial `Codable` mirror of `packages/shared-ts/src/tray-sync-protocol.ts`                                              |
| `SliccFollower/Models/ChatMessage.swift`, `Models/TrayTypes.swift`, `Models/TrayChunkFraming.swift`  | Chat/signaling types and transport chunk reassembly                                                                     |
| `SliccFollower/Sync/Keepalive.swift`                                                                 | `DataChannelKeepalive` ping/pong actor (used by `AppState`)                                                             |
| `SliccFollower/Sync/TerminalClient.swift`                                                            | Single-flight `exec.*` client for the leader shell, byte output, cancellation, and disconnect handling                  |
| `SliccFollower/Models/ICloudSessionList.swift`, `SliccFollower.entitlements`                         | iCloud tray-session discovery: presentation logic over `SliccTraySession` (see "iCloud Sessions") + the KVS entitlement |
| `SliccFollower/Networking/TraySignaling.swift`, `TrayFollowerConnector.swift`, `WebRTCManager.swift` | Signaling client + WebRTC peer/data-channel setup                                                                       |
| `SliccFollower/CDP/CDPBridge.swift`, `CDPTarget.swift`                                               | Hosts WKWebViews as CDP targets the leader can drive remotely                                                           |
| `SliccFollower/Views/ChatView.swift`, `MessageListView.swift`, `MarkdownText.swift`                  | SwiftUI chat and Markdown rendering                                                                                     |
| `SliccFollower/Views/SprinkleWebView.swift`, `InlineSprinkleView.swift`, `SprinkleDetailView.swift`  | Renders `.shtml`; intercepts bridge calls and stubs VFS APIs                                                            |
| `SliccFollower/Views/DockModel.swift`, `DockRail.swift`, `WorkbenchHost.swift`, `LucideIcon.swift`   | Phone IA (#1802): 48pt dock rail; workbench overlays chat. `Models/SVGPath.swift` parses lucide paths                   |
| `SliccFollower/Views/TerminalView.swift`, `TerminalViewModel.swift`                                  | Persistent libghostty surface with line editing, theming, cancellation, and scrollback                                  |
| `SliccFollower/{Models,Views}/*Avatar*.swift`                                                        | Avatar geometry/motion, renderer, and screenshot fixture                                                                |
| Other views                                                                                          | Top-level shell + smaller UI fragments — not exhaustive                                                                 |

Plain SPM commands do nothing useful on a macOS host (`swift build` hits iOS-only frameworks; `Package.swift` declares no test target). Build and test go through the XcodeGen project on a simulator (see "Test + coverage").

## Protocol Mirror Invariant

`Models/SyncProtocol.swift` mirrors a **subset** of the unions and payloads in
`packages/shared-ts/src/tray-sync-protocol.ts`. The per-message matrix in
`docs/architecture.md` is the cross-float source of truth. Three iOS-local facts:

- `preview.open` routes through `CDPBridge.handleTabOpen` (the URL is the worker-hosted preview the leader's `serve` minted) and acks with `tab.opened`.
- iOS never originates a transcript export, so it is never asked to approve one: the leader's prompt decodes to `.unknown` and the reply is `undecodable` in the corpus.
- iOS mirrors all four `exec.*` messages in both unions. Terminal originates requests/signals and consumes chunks/responses; leader requests get an unsupported response. `capabilities.exec` remains false because the phone has no OS shell.

Both union doc-comments state the omissions explicitly; `// MARK: -` boundaries are the stable anchors, not line numbers.

**Mechanical enforcement:** every variant of both unions needs a fixture and an
explicit iOS expectation in `tray-sync-protocol-corpus.ts`, decoded by both the
vitest and Swift suites. That section of `docs/architecture.md` also covers the
cherry-target surface iOS mirrors but cannot host.

When you change the protocol:

1. Update the TS union in `tray-sync-protocol.ts`.
2. Update the Swift `Codable` enum (`LeaderToFollowerMessage` and/or `FollowerToLeaderMessage`) **including the matching arm in the `init(from:)` decoder switch**. Adding only the enum case without the decoder branch falls through to `.unknown` on `LeaderToFollowerMessage` (silent drop) or throws on `FollowerToLeaderMessage` (loud).
3. Update the leader broadcast in `tray-leader-sync.ts`.
4. Update each follower that needs to handle the new message:
   - **Browser follower (TS)**: extend the `handleLeaderMessage` switch in `tray-follower-sync.ts`, plus the page-side controller wiring if the change is user-visible.
   - **iOS follower (Swift)**: edit `AppState.handleDataChannelMessage`. That's the only dispatch point — every message (including chat events like `agent_event`, `snapshot`, `user_message_echo`) flows through it.
5. Add the variant's fixture + iOS expectation to `tray-sync-protocol-corpus.ts`, regenerate the corpus JSON, and bump tests on both sides. The `SliccFollowerTests` bundle runs in CI via `xcodebuild test` on an iOS Simulator.
6. Add a row to the tray message matrix in `docs/architecture.md` (between the `<!-- tray-sync-matrix:start/end -->` markers). `tray-sync-doc-matrix.test.ts` checks the row exists **and** that its Followers column agrees with the corpus.

Skipping the iOS update now fails `SyncProtocolCorpusTests` in CI instead of quietly dropping the new message via the `.unknown` case (the pre-corpus era's most common form of protocol drift — `theme.apply` shipped exactly that way). Unknown leader message types are also logged at warning now.

## What this app supports vs the browser follower

Both followers implement sprinkle rendering. iOS is the longer-deployed reference; when adding a follower-side feature on the TS side, model it on `AppState`:

- Connection lifecycle: `connect()` / `disconnect()` / `dataChannelOpened()` / `handleDisconnect(reason:)`
- Connection health: `Sync/Keepalive.swift` splits **stalled** (reachable, keep
  probing, composer disabled) from **dead**; collapsing them tore down healthy
  connections. `handleDisconnect` backs off to `.gaveUp`; `lastError` is
  transport-only, `leaderError` the cone's.
- Message dispatch: `handleDataChannelMessage(_ data: Data)` switch
- Sprinkles: `refreshSprinkles()`, `fetchSprinkleContent(_:)` (chunk reassembly + waiter dedup), `sendSprinkleLick(_:body:targetScoop:)`, `handleSprinkleContent(...)`
- Leader VFS: `Sync/FsClient.swift`. iOS is the _requester_ — `fs.request` with
  `targetRuntimeId: "leader"` accesses the **leader's** files, and a
  leader-originated request gets an `ENOTSUP` reply rather than silence
  (`fs-router.ts` has no timeout, so a drop hangs its promise). The client owns
  the deadline and all-or-nothing reassembly the leader lacks. The live leader
  supports reads plus `writeFile`/`mkdir`/`rm` everywhere except `/proc`;
  `exists` and `walk` remain unsupported by the page proxy.
- `hello`: explicitly sends `exec: false` plus a device `motd`; the phone may request leader exec but cannot serve OS commands.
- Multi-scoop: `selectScoop`, `swipeToNextScoop` / `swipeToPreviousScoop`, per-scoop `messagesByScoop` buffer + flush throttling
- Model/thinking controls: `Views/SettingsView.swift` selects from the leader's model catalog and changes thinking for the selected scoop. The thinking picker is shown only when the selected model is reasoning-capable.
- Agent events: `handleAgentEvent(_:scoopJid:)` with the same scoop-targeted buffer update + per-render-loop throttle

### Licks (two envelopes, deliberately)

`sprinkle.lick` keeps its own message: `sprinkle` is **not** in `FORWARDABLE_TO_LEADER`, so routing it through the generic `lick` would get it dropped with a warning. `Models/LickEvent.swift` therefore mirrors only the two types the leader accepts (`navigate`, `discovery`). Origin labels are stamped leader-side — `runtime: "slicc-ios"` already maps to "iOS follower".

`navigate` licks carry handoff `Link` headers. With no CDP `Network` domain here, `CDPTarget.handoff` reads them off `WKNavigationResponse` (main frame only — an iframe must not instruct the cone). `Net/LinkHeader.swift` + `Net/HandoffLink.swift` mirror the TS parser and its branch/path allowlists against a shared corpus; a divergence is a shell-injection bug, not a formatting nit.

### Message rendering parity

Payload fields decode _and_ render. Deliberate divergences from the web:

- Attachment chips: thumbnail (inline base64) or kind glyph plus filename, user messages only. No size/MIME line — the web's chat mapper drops those too. A content-less attachment message renders no bubble.
- The error card omits the web's CTAs (`Try again`, `Open Settings`): each acts on leader state with no follower→leader equivalent, so it would silently no-op.
- `tool_ui` renders a read-only card keyed by `requestId`, title extracted from the leader's HTML minus badge and meta (which carries the mount path). `tool_ui_done` removes it; a `snapshot` clears all cards.

## iCloud Sessions

`AppState.sessionStore` is a read-only `TraySessionSyncStore` from
**`packages/swift-traysession`** (the launcher publishes; the phone only
joins). `SettingsView` lists sessions grouped by device (`ICloudSessionList`);
a tap joins via `connectToDiscoveredSession` — never the Join URL field or
visible history; the empty state distinguishes
signed-out from no-published-sessions. The entitlement's KVS id
(`S8LB56P782.ai.sliccy.trays`) MUST match macOS releases. Unprovisioned builds
degrade to an empty local cache; `SLICC_IOS_NO_ICLOUD=1` archives TestFlight
without the entitlement. `joinUrl` carries the session secret — never log it
or put it in telemetry/accessibility ids (rows use the one-way `session.id`).

## Frozen Sessions

`Models/FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`:
index parse (corrupt → rebuilt from a `/sessions` scan over `fs.*`), archive
parser (`slicc:session-data` block + heading fallback). `FrozenSessionsView`
lists past sessions; opening one swaps the transcript read-only and the
ice-blue banner replaces the composer. Hooks: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Holding the EMPTY composer dictates a `user_message` (no protocol change).
`Models/PttController.swift` ports `<slicc-composer>`'s gesture;
`Models/Dictation.swift` seams the engine (`SFSpeechRecognizer`, on-device
where the locale allows). Hooks: `-uiTestSpeechPermission`/
`-uiTestSpeechScript` script the engine, `-uiTestPttStage` pins the overlay.

Release submits the transcript directly (`InputBar.submit(_:dictated:)`),
never via the composer binding; an unsendable one stays as a draft.

Dictated turns speak their reply back, porting
`webapp/src/speech/{dictation-priming,voice-reply}.ts`.
`Models/DictationPriming.swift` appends the AI-only markers (🎙️ per turn, a
one-time `◁…▷` note, a hidden `<!--lang:xx-->`); bubbles strip them at render
time. `Models/VoiceReply.swift` binds each dictated submission to the scoop
and message that answers it, then speaks via `AVSpeechSynthesizer` behind the
`SpeechSpeaking` seam. Typed turns stay silent, as does a reply whose
declared language has no voice.

## Terminal

The Terminal tab uses libghostty's host-managed `InMemoryTerminalSession`,
not an on-device process. Local editing sends complete commands through
`TerminalClient`; the tab stays unavailable until the leader advertises
`hello.capabilities.exec`. Ctrl-C sends `SIGINT`, but keeps the prompt closed until
the matching `exec.response` confirms the persistent shell is idle. The leader
keeps one virtual shell per iOS follower connection, so cwd and exported variables
survive across submitted lines. Commands have no fixed client deadline because
leader output is buffered until completion; interactive programs and incremental
output are unsupported.

## Agent Avatar

`SliccAgentAvatarView` follows `webcomponents/src/switcher/slicc-agent-avatar.ts`;
`Models/SliccAgentAvatarGeometry.swift` is its parity contract. `ScoopSwitcher`
maps the selected `ScoopSummary` to web defaults and renders a 20pt nav-bar avatar;
menu rows stay textual because custom shapes do not render there. The decorative
avatar is accessibility-hidden beside its label. `Models/SliccAgentAvatarTilt.swift`
seams CoreMotion; disappearance, reduce-motion, unavailable hardware, and closed
eyes stop updates and center pupils. `-uiTestAvatarFixture` renders screenshots.

## Build

```bash
cd packages/ios-app
xcodegen generate                                # Regenerate SliccFollower.xcodeproj from project.yml
xcodebuild build -project SliccFollower.xcodeproj -scheme SliccFollower \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO                        # The build CI runs
swiftlint lint                                   # SwiftLint (config inherits repo-root .swiftlint.yml)
```

## Test + coverage

The suite runs through `xcodebuild test` on a simulator. The shared coverage gate
picks a simulator, enables coverage and on-failure retries, and enforces the
`ios-app` floors in `coverage-thresholds.json`.

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Outputs land in `.build/coverage/` (`summary.json`, `lcov.info`,
`ios-app.xcresult` with per-test durations). Neither bundle is `parallelizable`: the unit tests total
~7s, so cloning simulators only raced the UI runner, which then fails preflight
with `Busy` or dies on `Timed out while loading Accessibility`.
`randomExecutionOrder` still holds, so no test may depend on another's side
effects. Coverage is measured against
`SliccFollower.app/SliccFollower.debug.dylib`, not the launcher stub beside it —
debug builds put the code and the coverage mapping in the dylib.

## Simulator QA path

Hand-running the app for exploratory QA (boot/build/install/launch, seeding
`@AppStorage` via launch arguments, getting a real Join URL) is covered in
[`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md).

## UI tests (`SliccFollowerUITests`)

A `bundle.ui-testing` target runs alongside the unit bundle in the `SliccFollower`
scheme, so `swift-coverage-check.sh --xcodebuild` picks up both. No test needs a
leader: the `-uiTestFixtureRoute YES` launch argument reaches the leaderless
**UI Fixture** route (`FixtureConversationView`) without a tap, and
`-uiTestSessionsFixture/Empty YES` seed the iCloud sessions list from an
in-memory backend (fixture URLs dial `127.0.0.1:1`, failing hermetically). `UITestHooks`
(`App/UITestHooks.swift`) reads it and is `#if DEBUG` only — a shipped binary
must not carry a flag that skips the connection path. The failure-state test
dials `http://127.0.0.1:1/…` — refused without DNS or egress, so
`Connection Failed` arrives in seconds.

- **Put accessibility identifiers on leaves.** SwiftUI pushes one onto a
  container's leaves instead of minting a container, so an identifier on a
  `VStack` yields tagged leaves and no `otherElements` match — and
  `.accessibilityElement(children: .contain)` suppresses that propagation rather
  than fixing it. Every leaf in a message row carries `message-<id>`.
- **Row ids alone are blind.** Because every leaf carries `message-<id>`, a row
  still matches when its specialized renderer is gone. A new fixture variant
  also needs a `variantMarkers` string only that renderer can emit.
- **The transcript is pinned to the newest message**, so a variant walk scrolls
  bottom-to-top and must be bounded.
- **A red CI job names the test, not the reason.** The XCTAssert text lives only
  in the `test-timings-ios-app` xcresult the job uploads — read it with
  `xcrun xcresulttool get test-results tests` before theorizing. These failures
  are load-dependent races, so reproduce them locally under CPU contention with
  `-test-iterations N -run-tests-until-failure`.

## Linting

`packages/ios-app/.swiftlint.yml` inherits the repo-root rule set via
`parent_config` and excludes `.build`/`SliccFollower.xcodeproj`. Only
`error`-severity violations fail CI. `swiftlint --fix` auto-corrects, but
rewrites every file it scans — run it on a clean tree.

The CI job ends with an informational Periphery dead-code scan. It never fails
the job (`|| true`). The app and test targets live in the XcodeGen project, not
the SPM manifest (which declares only the library), so unlike the SPM-based
Swift packages the scan names the project, scheme, and target explicitly.

## Formatting

SwiftLint lints; `swift format` (Swift 6+ toolchain) formats, against the
repo-root `.swift-format` found by walking up from each input file. No
`package.json` here, so invoke it directly — or use the repo-root
`npm run lint:swift:format` / `npm run format:swift`, which cover this package:

```bash
swift format lint --strict --parallel --recursive SliccFollower Package.swift   # CI gate
swift format --in-place --parallel --recursive SliccFollower Package.swift
```

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via
`setup-testflight-secrets.sh`), path-gated by `release-native.mjs`: only when
`packages/ios-app/` changed since the last release. The script **soft-skips
with exit 0** — the release goes green with **no TestFlight build** — in three
cases: `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret missing or set to `-`, or the
runner's default Xcode below 26 (App Store rejects older builds). A green
release is therefore not proof an ipa shipped; check the release job's log for
the skip message.

## Related Guides

- `packages/shared-ts/src/tray-sync-protocol.ts` — canonical protocol (the file this app's `SyncProtocol.swift` partially mirrors); payload types in `packages/shared-ts/src/agent-wire-types.ts`
- `packages/webapp/src/scoops/tray-leader-sync.ts` — leader-side broadcast/respond logic
- `packages/webapp/src/scoops/tray-follower-sync.ts` — browser follower
- `packages/webapp/src/ui/sprinkle-follower-controller.ts` — browser follower's page-side sprinkle renderer (mirrors `SprinkleWebView` behavior)
- `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture" — cross-float overview
- `docs/ios-simulator-qa.md` — live-leader simulator QA
