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

## UI-test details

- Put accessibility identifiers on leaves (`message-<id>`). Container ids propagate; `.accessibilityElement(children: .contain)` does not fix it.
- Row ids alone are blind — also add a `variantMarkers` string only that renderer can emit.
- The transcript pins to the newest message; variant walks scroll bottom-to-top and must be bounded.
- A red CI job names the test, not the reason. Read XCTAssert text from the uploaded `test-timings-ios-app-<ios>-<device>` xcresult via `xcrun xcresulttool get test-results tests`. Host death before XCTest connects is usually a runtime mismatch or `CODE_SIGNING_ALLOWED=NO`, not flake.
- Regular-width browser tabs claim the whole iPad window; returning to the overview restores the split. CI runs this enter/exit regression in the `ios-app-tests` matrix (iPad cells).

## TestFlight distribute

`scripts/testflight-distribute.mjs` (gated on `SLICC_TF_EXTERNAL_GROUP`; unset = upload-only) waits for processing, sets What to Test notes, submits Beta App Review, and attaches the build to that group. **Submission and attach are independent** — only a `fatal` submit aborts; `deferred` (review quota) warns and still attaches, so the build ships once review clears. Tests: `testflight-distribute.test.mjs`.

What to Test copy comes from `composeWhatsNew()`: the release workflow's `analyze` job drafts end-user highlights from the last week of `feat`/`fix`/`perf`/revert commits touching `packages/ios-app` + the swift tray packages (path-selected, not scope-selected — cross-cutting tray work rarely carries an `ios` scope) via headless `claude -p` on Bedrock (not `claude-code-action` — it rejects push-triggered workflows) and passes them as `SLICC_TF_WHATS_NEW`; the static onboarding copy (session-join instructions, appending `SLICC_TF_DEMO_JOIN_URL`) always follows, and highlights are capped at 3,000 code points so the footer survives the ASC 4,000-char limit. The draft is **best-effort by design** — no iOS commits, a model outage, or empty output all leave `SLICC_TF_WHATS_NEW` unset and the static copy ships alone; the draft must never block a release.
