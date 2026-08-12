# iOS Follower App — Deep Reference

Long-form detail moved out of [`packages/ios-app/CLAUDE.md`](../packages/ios-app/CLAUDE.md) so the package guide stays under its size budget. Anchors below match the summary links in the guide.

## x-callback exec

`--x-callback` replaces any supplied callback keys with app-owned nonce URLs. A correlated success/error/cancel emits one ordered `{status, parameters:[{name,value}]}` JSON line on stdout, then exits 0/1/130. Results are capped at 16 parameters and 16 KiB serialized JSON; overflow fails without truncation. Callback state is process-local, so a callback after app restoration is consumed silently and the leader owns its timeout.

## Transcript swipe arbitration

Nested horizontal content keeps a drag while it can scroll that way; scoop navigation or frozen dismissal takes over only at the departing edge. Freeze edge state at drag start, tolerate either callback order, fail closed for unknown guarded contexts. Edge math includes both 8pt negative-padding expansions. On iOS 18+, each guarded scroller uses `UIGestureRecognizerRepresentable` and snapshots its `UIScrollView` at touch-down; the parent handles ordinary content. Keep the iOS 17 fallback and preserve vertical scrolling.

## iCloud tray supersede chain

iCloud keeps advertising the **old** tray after a leader reconnects. `SessionReachability` and both attach loops must follow the `TRAY_SUPERSEDED` chain (`SupersedeRedirect`, which also moves the tray the connection owns) or a row reads live but cannot connect.

## Local Kokoro models

Settings downloads the anonymous, revision-pinned ~83 MB Hugging Face pack after Wi-Fi consent with progress, cancel, retry, and removal; replies never provision. Pack: nine CoreML stages, two vocabularies, `af_heart`. Marker/cache delete together; weights are not committed. Live-simulator QA: [`docs/ios-simulator-qa.md`](ios-simulator-qa.md).

## Agent avatar treatment

`SliccAgentAvatarView` shares its treatment with the browser `<slicc-agent-avatar>`. The chat header is one 36pt row: scoop pill leading, avatar centered, session-controls cluster trailing. The cluster is a shell overlay, not a toolbar item — the nav bar clips its own items and the cluster must overlap the dock rail. It tracks the chat toolbar: hidden under a compact workbench, kept in the regular split where the conversation stays visible. Menu rows stay text-only. Fullness is pupil size only — never a ring, gauge, badge, or text. Connection trouble outranks lifecycle and replaces pupils and eye whites with 1pt TV static; the a11y phrase still carries label, lifecycle, fill, and connection status. CoreMotion pupil movement is relative to the rolling 60-second average tilt and capped at one eye diameter per second; reduce-motion and closed eyes center pupils. `-uiTestAvatarFixture light-static|dark-static` freezes a noise frame.

No connection banner row: recoverable state stays in the avatar and composer placeholder so it cannot move message rows; terminal `.gaveUp` opens Settings.

### Settle window

The follower's WebRTC link blips — an ICE failure or a closed data channel drops a connection the bounded reconnect rebuilds seconds later. Every connection treatment on the chat surface therefore reads `AppState.settledConnection` (a `ConnectionHealth` of state + stall + attempt), never the raw properties, and `ConnectionSettler` decides when the raw state gets there:

- **Into trouble** — held for `ConnectionSettler.holdDuration`. A blip that heals inside the window publishes _nothing_; the pending update is dropped, not replayed. The hold is sized above `ReconnectBackoff.baseDelay` on purpose: the first reconnect attempt only fires after that delay and still needs signaling plus ICE to land, so a shorter hold would expire while the blip it exists to hide is still healing.
- **Back to health** — immediate. Nothing is gained by leaving a stale alarm over a connection that is demonstrably fine.
- **Trouble → different trouble** — immediate, so the attempt counter keeps up instead of freezing at whatever landed first.

The window is measured from the first reading that broke health. Trouble arriving while a hold is already running only updates what that hold will publish — the reconnect loop bumps its attempt counter about once a second, and restarting the clock on each bump would let it outrun any hold.

Capability gates (can this surface reach the leader at all — Files, Memory, Terminal, Settings) stay on the raw state, as does `MonitorView`, which exists to report what is actually happening. The dividing line for an **action** is whether its failure is visible: a send follows the settled view because a send the transport refuses lands in the transcript and marks itself undelivered, while New chat follows the raw state because `requestNewSession` returns without a word and a live-looking button would eat the tap.

**Composite transitions must go through `AppState.updateConnection`.** Each property publishes through its own `didSet`, so a sequence that passes through a healthy-looking intermediate — `handleDisconnect` clearing the stall before moving the state is the one that bit — hands the settler a recovery that never happened: it drops the treatment already on screen, then serves the real trouble a fresh hold, so a stall that died reads as connected for the whole window. Writes inside that block are ingested once, on the value they end at.

**No connection state may reach the composer's first-responder layer.** Not `.disabled`, not `allowsHitTesting`, not the mounting of anything above the editor. The keyboard follows composer focus and nothing else. What an unusable leader blocks is _sending_ — `canSend` / `submit`, the dimmed send button, and the placeholder that says why. This is a deliberate divergence from the browser follower (`wc-follower.ts` disables its input card), which has no first-responder coupling to lose.

That rule was learned twice, in two places one line apart:

- `.disabled(!isComposable)` on the band disabled the `TextEditor` inside it; a disabled editor resigns first responder, so the keyboard was pulled from someone mid-sentence and restored unasked on the re-enable.
- `pttArmed` was `text.isEmpty && isComposable`, and it drives `allowsHitTesting` on the editor plus the `PttPressSurface` overlay above it. On an **empty, focused** composer — the state someone is in the instant they tap to write — a blip flipped it twice: the drop unmounted the surface (survivable) and the **heal remounted it over the focused editor**, dismissing the keyboard. Two edges, so the keyboard visibly toggled off and on.

The second one is why `ComposerConnectionUITests` stages a blip that **heals** (`-uiTestConnectionBlip "3,3"`). A permanent drop passes with the bug present — only unmounting is harmless — so a test that stages one is not a regression test at all.

Push-to-talk therefore arms on `text.isEmpty` alone. Dictating with no usable leader is allowed and lands somewhere useful: `submit` refuses it and the transcript stays in the composer as a draft, which beats taking the microphone away because a ping was late.

## UI-test details

- Put accessibility identifiers on leaves (`message-<id>`). Container ids propagate; `.accessibilityElement(children: .contain)` does not fix it.
- Row ids alone are blind — also add a `variantMarkers` string only that renderer can emit.
- The transcript pins to the newest message; variant walks scroll bottom-to-top and must be bounded.
- A red CI job names the test, not the reason. Read XCTAssert text from the uploaded `test-timings-ios-app-<ios>-<device>` xcresult via `xcrun xcresulttool get test-results tests`. Host death before XCTest connects is usually a runtime mismatch or `CODE_SIGNING_ALLOWED=NO`, not flake.
- Regular-width browser tabs claim the whole iPad window; returning to the overview restores the split. CI runs this enter/exit regression in the `ios-app-tests` matrix (iPad cells).

## TestFlight distribute

`scripts/testflight-distribute.mjs` (gated on `SLICC_TF_EXTERNAL_GROUP`; unset = upload-only) waits for processing, sets What to Test notes, submits Beta App Review, and attaches the build to that group. **Submission and attach are independent** — only a `fatal` submit aborts; `deferred` (review quota) warns and still attaches, so the build ships once review clears. Tests: `testflight-distribute.test.mjs`.

What to Test copy comes from `composeWhatsNew()`: the release workflow's `analyze` job drafts end-user highlights from the last week of `feat`/`fix`/`perf`/revert commits touching `packages/ios-app` + the swift tray packages (path-selected, not scope-selected — cross-cutting tray work rarely carries an `ios` scope) via headless `claude -p` on Bedrock (not `claude-code-action` — it rejects push-triggered workflows) and passes them as `SLICC_TF_WHATS_NEW`; the static onboarding copy (session-join instructions, appending `SLICC_TF_DEMO_JOIN_URL`) always follows, and highlights are capped at 3,000 code points so the footer survives the ASC 4,000-char limit. The draft is **best-effort by design** — no iOS commits, a model outage, or empty output all leave `SLICC_TF_WHATS_NEW` unset and the static copy ships alone; the draft must never block a release.
