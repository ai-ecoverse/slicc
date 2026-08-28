# iOS Follower App — Deep Reference

Long-form detail moved out of [`packages/ios-app/CLAUDE.md`](../packages/ios-app/CLAUDE.md) so the package guide stays under its size budget. Anchors below match the summary links in the guide.

## x-callback exec

`--x-callback` replaces any supplied callback keys with app-owned nonce URLs. A correlated success/error/cancel emits one ordered `{status, parameters:[{name,value}]}` JSON line on stdout, then exits 0/1/130. Results are capped at 16 parameters and 16 KiB serialized JSON; overflow fails without truncation. Callback state is process-local, so a callback after app restoration is consumed silently and the leader owns its timeout.

## Protocol variant checklist

`// MARK: -` boundaries are the anchors. Every variant needs a fixture + iOS expectation in `tray-sync-protocol-corpus.ts`, decoded by vitest + Swift. Order: (1) TS union, (2) Swift enum + `init(from:)` arm, (3) leader broadcast, (4) browser + iOS dispatch (`AppState.handleDataChannelMessage` is the only iOS switch), (5) corpus + tests, (6) architecture matrix. Skipping iOS fails `SyncProtocolCorpusTests` instead of `.unknown`.

## Sudo approval and push

Issue #2062. The leader delegates a sudo prompt here when it is headless or its human last spoke from this phone (`docs/approvals.md` → "Where the prompt goes"). `SudoApprovalController` (SliccTrayKit, clock- and gate-injected) owns the pending cards and replies exactly once; `AppState+SudoApproval` supplies the gate (`LAContext.evaluatePolicy(.deviceOwnerAuthentication)` — Face ID / Touch ID with passcode fallback; the attestation reports which one passed), the notification hooks, and `push.register`. Rules: Allow and Always never skip the gate, Deny never runs it, a cancelled/failed gate is a deny, `sudo.approve.cancel` and transport loss withdraw cards silently (the leader already denied), and an `always` pattern left empty falls back to the leader's suggestion. The card offers "Always…" only when the device can authenticate its owner — the leader would downgrade it otherwise.

`NotificationCoordinator` registers two categories that the tray hub's APNs payloads (`packages/cloudflare-worker/src/apns.ts`) reuse: `SLICC_TURN_END` (plain banner) and `SLICC_SUDO_REQUEST` (time-sensitive; actions **Deny** — no authentication, no foregrounding — and **Review…**, which opens the app onto the card; Allow is deliberately not a lock-screen action). Banners are suppressed while the app is active. Without APNs (simulator, denied permission) the same banners are posted locally as long as the data channel is alive. Provisioning: the App ID needs Push Notifications + Time Sensitive Notifications; `aps-environment` is `development` in the entitlements and rewritten for distribution; debug builds register against the sandbox gateway, release builds against production. Worker secrets: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC` (= bundle id). UI hook: `-uiTestSudoApproval YES` stages a card with an always-authenticated gate.

## Follower state invariants

Chat-surface treatments read `settledConnection`, not the raw state: `Sync/ConnectionSettle.swift` holds transitions INTO trouble and publishes recovery at once, so multi-property transitions MUST go through `updateConnection` or a healthy-looking intermediate reads as a recovery. Leader VFS uses `FsClient` with `targetRuntimeId: "leader"` (leader-origin gets `ENOTSUP`); `hello` sends `exec: true` + device `motd`. `sprinkle.lick` is its own message (`sprinkle` is not `FORWARDABLE_TO_LEADER`); `LickEvent` mirrors only `navigate` + `discovery` from `WKNavigationResponse` Link headers; attachment chips are user-only with no web CTAs; `tool_ui` is cleared by `tool_ui_done` / snapshot. A message's tool calls run concurrently on the leader, so `tool_result` pairs by the provider's `toolCallId` (stored as the message-scoped row id `<messageId>:<toolCallId>`, matching the webapp) — `AppState.toolCallIndex` also accepts the bare id for history synced by an older build, and falls back to the last same-named call still awaiting a result only for a leader that sends no id. `tool_progress` ticks (≤4/s per unit) resolve against the transcript the same way but write only `AppState.toolProgress` — never `messages`, which at that rate would be a redraw storm — and the row chrome in `Views/ToolProgressChrome.swift` paints the webapp's three cues off it: the tool glyph fills bottom-up (a hard-stop `LinearGradient` on the SF Symbol, indeterminate breathes), the trailing spinner becomes three dots, and an EXPANDED row wears a 3pt bar — row-only, never on a cluster head, whose gear fills with `aggregateToolProgress` instead. A phone also shows the percentage and ETA as a caption, since there is no hover title to hide them in. Units clear on the call's result, on a `phase: end` tick, when the turn that owns the row ends or dies, when a snapshot drops the row, and on session reset — deliberately NOT on the `isStreaming` edge, which `selectScoop` also moves, so a background scoop keeps its bars while you read another one.

## Transcript swipe arbitration

Nested horizontal content keeps a drag while it can scroll that way; scoop navigation or frozen dismissal takes over only at the departing edge. Freeze edge state at drag start, tolerate either callback order, fail closed for unknown guarded contexts. Edge math includes both 8pt negative-padding expansions. On iOS 18+, each guarded scroller uses `UIGestureRecognizerRepresentable` and snapshots its `UIScrollView` at touch-down; the parent handles ordinary content. Keep the iOS 17 fallback and preserve vertical scrolling.

## iCloud tray supersede chain

iCloud keeps advertising the **old** tray after a leader reconnects. `SessionReachability` and both attach loops must follow the supersede chain (`SupersedeRedirect`, which also moves the tray the connection owns) or a row reads live but cannot connect.

The hop is named twice: in the 409 body (`code: "TRAY_SUPERSEDED"`, `joinUrl`) and as an RFC 5829 `Link: <replacement>; rel="successor-version"` header (`SupersedeLink`, #1957). **The link wins and stands alone** — the chase is gated on having a replacement address, never on the failure code, so a body shape this build does not model (or cannot decode) is not a dead end. Reading the code instead is what stranded the follower in #1956. Bounds stay ours: 5 hops, 1s apart, redirects never auto-followed by `URLSession`.

## Recent joins

iCloud discovery only covers what the macOS launcher advertises, so a join URL pasted into a phone was invisible to every other device. `RecentJoinStore` closes that: each device writes the URLs that **connected** under its own KVS key and reads the union. Recording happens in `dataChannelOpened`, not in `connect` — a dial that never lands must not sync itself to the household — and after `SupersedeRedirect` has moved `activeJoinUrl`, so what syncs is the URL that works.

Display is `ICloudSessionList.recentRows`: trays the live iCloud list already shows are filtered out by the shared one-way id (one tray, one row), then `RecentJoinStore.rank` sorts reachable-first, newest-connected second, and caps at five — the cap after the ranking, so a session that still answers can displace a fresher dead one. Rows render the label, or the host when a pasted URL has none; the path carries the session secret and never reaches the screen. Swipe-to-Remove and Clear Stored Data clear only this device's key, so a row another device recorded can sync back. Both lists probe on `onAppear` **and** on store change: iCloud can push a row in while the sheet is open, and an unprobed id counts as presumed-reachable, so it would sort above known-live rows and hide its "not responding" note until the sheet was reopened.

## Local Kokoro models

Settings downloads the anonymous, revision-pinned ~83 MB Hugging Face pack after Wi-Fi consent with progress, cancel, retry, and removal; replies never provision. Pack: nine CoreML stages, two vocabularies, `af_heart`. Marker/cache delete together; weights are not committed. Live-simulator QA: [`docs/ios-simulator-qa.md`](ios-simulator-qa.md).

## Agent avatar chrome

Chat header is a 36pt row (scoop pill, avatar, session-controls cluster); the cluster is a shell overlay that must overlap the dock rail. Fullness = pupil size only, never ring/gauge/badge/text. Connection trouble replaces pupils + eye whites with 1pt TV static; the a11y phrase carries label, lifecycle, fill and connection. Recoverable state stays in avatar/composer (no banner row); `.gaveUp` opens Settings. `-uiTestAvatarFixture light-static|dark-static` freezes noise; `light-expression|dark-expression` freezes the expression matrix; `light-toolbar|dark-toolbar` reproduces the header's own toolbar layout.

## Agent avatar treatment

`SliccAgentAvatarView` shares its treatment with the browser `<slicc-agent-avatar>`. The chat header is one 36pt row: scoop pill leading, avatar centered, session-controls cluster trailing. The cluster is a shell overlay, not a toolbar item — the nav bar clips its own items and the cluster must overlap the dock rail. It tracks the chat toolbar: hidden under a compact workbench, kept in the regular split where the conversation stays visible. Menu rows stay text-only. Fullness is pupil size only — never a ring, gauge, badge, or text. Connection trouble outranks lifecycle and replaces pupils and eye whites with 1pt TV static; the a11y phrase still carries label, lifecycle, fill, and connection status. CoreMotion pupil movement is relative to the rolling 60-second average tilt and capped at one eye diameter per second; reduce-motion and closed eyes center pupils. `-uiTestAvatarFixture light-static|dark-static` freezes a noise frame.

No connection banner row: recoverable state stays in the avatar and composer placeholder so it cannot move message rows; terminal `.gaveUp` opens Settings.

### Expression kit

The fifth channel and its companions, mirroring [`webcomponents-details.md`](webcomponents-details.md#agent-avatar-expression-kit). Two files carry it: `Models/AvatarExpression.swift` (the UI-free grammar — same constants, same arithmetic, in the web's 200×100 band units) and `Models/AvatarExpressionEngine.swift` (the integrator, the mirror of the web's rAF loop). `SliccAgentAvatarView` paints the scalars: `RoundedRectangle(cornerRadius:)` for the socket/pupil morph, a `Rectangle` mask plus a `Capsule` chord line for the lids, a `Capsule` with `rotationEffect` for the brows — the last of these painted outside the tile's crop.

- **`SliccAgentAvatarGeometry.activity` is the switch.** `nil` keeps the legacy face — no lids, no brows, no engine — so any surface that has not opted in renders exactly as before. `expressionScale` (`eyeRadius / 38`) is the single bridge from band units to points; nothing else converts.

- **The eye band is placed per avatar type.** The web positions its 200×100 band with `TYPE.<type>.eyes` inside `.icon-inner`, which then applies `translate(--tx,--ty) scale(--zoom)`; `SliccAgentAvatarGeometry.BandPlacement` reproduces that arithmetic rather than hard-coding the resulting ratios. Both types share one band unit, so the whole difference is the zoom and where the band sits — the cone zooms 3× into a band pulled above the tile, the scoop 2.65× — and every socket length (`eyeRadius`, `eyeOutlineWidth`, `pupilRadius`, `maxPupilTravel`, `eyeCenters`) is a band constant times that unit. Hard-coding the scoop's numbers for both is what shipped cone eyes ~12% too small and pulled ~5% of the tile inboard.

- **The brows paint OUTSIDE the tile crop.** `.clipShape` wraps the tile layer alone — tint, glyph, sockets, pupils, lids — and `ExpressiveAvatarBrows` paints over it unclipped, the mirror of the web's `.crop` / `.brow-layer` split. Placement is therefore plain band space (`browCenter`/`browSize`): each brow rides its own eye's `cx` at `browY`, with `raise` in band units, one for one. It used to be pulled inward by `0.9 * browHalfWidth` with rest and lift budgeted out of the ~14pt of headroom above the eye, because a tile-wide clip left nowhere else to put it; that squeeze read as a flat unibrow at 96pt and vanished entirely at 26pt. Consequences: a brow OVERHANGS the tile (~3pt sideways and ~1.7pt over the top at the 26pt rail size, more for the cone, whose band is zoomed harder), so **hosts must not clip an avatar** — the header's 30pt tile in a 36pt slot is the slack that buys — and both layers must keep the same geometry, which is why `browCenter` goes through the same `BandPlacement` as `eyeCenters`.
- **A blink does not move the brows.** They sit outside `ExpressiveAvatarEye` on purpose: its `blinkScale` squash folded them flat onto the eyeball, which the crop hid and which reads as a wince once it does not. A blink is a lid move. The pose instead eases over `browTransitionSeconds` (the web's `transition: transform`, and like the web it snaps under reduced motion), which is what makes the apex re-cock a readable beat rather than a swap buried in the squash.
- **One `TimelineView` drives the whole avatar.** The tile and the brow layer above it must paint the same frame, and `advance(to:)` integrates on every read — a second timeline would step the engine twice per frame. The timeline therefore wraps `layers(snapshot:)`, not the eyes alone.
- **Both eyes must share one container that measures the whole tile.** They are placed with `.position`, which reads its coordinates from the parent's space, so `expressionEyes` wraps the pair in an explicit `ZStack` frame'd to `sideLength`. Handed to `TimelineView` bare, the two eyes become its multi-view content and are stacked vertically — the right eye lands a half tile low and clips into the bottom-right corner. This only ever bit the ANIMATING path (the settled reduced-motion frame went straight into the view's own `ZStack`), and only where the surrounding layout did not already pin the size, which is why the grid fixtures stayed correct while the chat header did not.
- **Time is a parameter, never an ambient read.** `TimelineView` hands the view a date and the view hands it to `advance(to:)`. The integrator advances per FRAME with a clamped `dt`, so a real-clock assertion would be a race; tests step it instead.
- **Precedence: local derivation > wire state > unknown.** `AppState.runningToolCalls` brackets `tool_use_start` → `tool_result` for the visible scoop (thinking vs the working square); `AppState.awaitingUserSince` is set by the `isStreaming` false-edge via a property observer, so every writer (turn_end, `status: ready`, the error path, snapshot ingest) funnels through one place. Both are bundled as `ScoopSummary.LocalExpressionSignals` and passed to `avatarActivity(local:)` for the FOCUSED scoop only — they are richer and land a broadcast earlier. Every other tab reads `ScoopSummary.activity` — the optional refinement of `state`, parsed by `ScoopActivity` with unknown values falling back to `state` alone. `state` itself stays the closed four-value union, so this field can grow without touching how any shipped follower renders a tab. `state` still decides busy-vs-idle in both modes, which is what keeps a leader that predates the refinement rendering correctly. `tool_result`'s already-mirrored `isError` fires the glower; the composer's `onChange` fires scrutiny + wake.
- **iOS `awaiting` is centred, not anchored.** There is no pointer and no composer element to aim at, so the agent holds eye contact through the screen. CoreMotion tilt owns the gaze only while `working` — the pointer channel's analogue.
- **Precedence is unchanged**: static freezes shape, lids and brows (the socket keeps the corner radius it froze at); reduce motion settles instantly with no blinks, saccades or pops and parks the brows at the base pose, and the drowse jumps to its settled cut rather than animating the 12s descent.
- **Parity is gated, not trusted.** `Fixtures/expression-vectors.json` is generated from the TS grammar by `packages/dev-tools/tools/gen-expression-vectors.mjs` and asserted by BOTH `AvatarExpressionVectorTests.swift` and `packages/webcomponents/tests/switcher/expression-vectors.test.ts`. A scalar that drifts on one platform fails on both; without it, each renderer would keep drawing a plausible face that is no longer the same face.
- **Screenshots**: `-uiTestAvatarFixture light-expression|dark-expression` renders the state matrix on a frozen clock, scoops at 96/26pt plus a cone row at 72/26pt (registered in `screenshot-screens.json` as `avatar-expression-light|dark`). `light-toolbar|dark-toolbar` (`avatar-toolbar-light|dark`) renders the header's own `.principal` toolbar item at `ChatView`'s 30pt-tile-in-36pt-slot size; the grids put the tile straight into a stack, so only this variant covers the layout where the eye pair was stacked vertically.

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

## Reading column

The regular-width cap (`MessageListLayout.maximumReadableWidth`) is applied **per row** via `readableTranscriptColumn()`, never as a frame around the transcript's `LazyVStack`. That stack carries `scrollTargetLayout()`, so the scroll view anchors on it and cancels any centering offset wrapped around it with an equal content offset — which is how the capped column ended up flush against the leading edge. Rows are centered by the stack's own `.center` alignment, which needs the stack to stay full-width (the invisible bottom anchor's greedy width is what guarantees that). Covered by `SliccFollowerUITests/TranscriptColumnUITests` on the iPad CI leg.

## Markdown tables

`MarkdownText.tableView` mirrors the web contract for `slicc-agent-message .body table`: a rounded, hairline-ruled card with a `--ghost` header, `padding: 6px 11px` cells, `border-collapse: collapse` rules — and, critically, `width: fit-content` with `max-width: 100%`. The card is sized from its own cells; it must never stretch to the viewport, which on an iPad turned every three-column comparison into a full-width band of empty space.

SwiftUI cannot express that shape declaratively, which is why `Models/MarkdownTableLayout.swift` resolves the column widths up front (widest cell + padding, floored at 56pt, capped at 260pt) and the view stacks fixed-width cells:

- **Inside a horizontal `ScrollView` the content is proposed the viewport width.** A `Grid` of flexible cells therefore stretches AND squeezes its columns — that combination is what truncated header labels that had room to render in full.
- **Pinning it with `fixedSize` alone hugs the content but never wraps**, so a long cell renders at its full single-line width and any cap clips it. Truncated text in a table is unreachable: the scroller pans the card, it cannot reveal an ellipsis. Capped cells wrap instead, via `.fixedSize(horizontal: false, vertical: true)` on the cell text.
- **`Grid` reserves a row's height before a capped cell has wrapped**, clipping the last row away. Rows are plain `HStack`s in a `VStack` for that reason; the widths are already known, so nothing is lost.
- **Cells are measured off the inline parse, not the raw source** (`MarkdownTableLayout.textWidth`) — a `code` chip in its monospace face, a **bold** span in its heavier one — or a column would be sized to its own markdown syntax. Memoized in an `NSCache` for the same reason `MarkdownBlockParser.parse` is (see "Transcript per-render cost").

`HorizontalScrollGuard` widens its scroller by `horizontalTouchSlop` on each side so a finger landing just outside a table still arbitrates against it. `measuredContent` re-inserts that inset, because without it every guarded block — table cells and fenced code alike — renders 8pt left of the surrounding paragraphs and loses that much of its own padding. The rule covered by `SliccFollowerTests/MarkdownTableLayoutTests`; the fixture transcript carries a four-column table with one wrapping cell.

## Transcript short actions

Everything a reader can act on in a transcript carries a **default action on tap** and a **short-action menu on long press**:

| Span                                                | Tap                                                                    | Long press                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `http(s)` link                                      | Sliccy's own browser (Settings → Advanced hands it back to the system) | Open in Sliccy · Copy Link · Share… (+ the system's own link preview) |
| Any other scheme (`mailto:`, `tel:`, an app scheme) | the system's default app                                               | Open · Copy Link · Share…                                             |
| Phone number                                        | **Messages** (`sms:`)                                                  | Message · Call · Copy · Share…                                        |
| Inline `code`                                       | Copy                                                                   | Copy · Share…                                                         |
| Fenced code block                                   | text selection, unchanged                                              | Copy · Share…                                                         |
| Confirmed file mention                              | the preview sheet                                                      | Preview · Copy Path · Share…                                          |
| Base64 payload chip                                 | the preview sheet                                                      | Preview · Share… · Copy Base64                                        |

A tapped phone number goes to Messages rather than the dialer: a number in a transcript is far more often something to text a link to than something to ring, and `tel:` on a device with no cellular plan is a dead end. Calling stays one long press away.

**Every menu in the table is a UIKit menu.** The first version routed a tapped `code` run through a SwiftUI `confirmationDialog`, which put one centred alert card among six contextual menus — the same actions, in a shape that read as a different feature. A tap can either perform an action or present a sheet; there is no API to raise a `UIContextMenuInteraction` programmatically, so a snippet now does the useful thing directly (it is the one span with nowhere to navigate to) and Share stays on the long press with everything else.

### Why a UITextView

SwiftUI's `Text` renders a `.link` run and routes a tap through `\.openURL`, and that is the whole of its link API — no per-span gesture, no preview, no menu. Every short action above is a SECOND action on a span that already has a default one, and `UITextView` is the only text engine on the platform that models that (`primaryActionFor` / `menuConfigurationFor`, iOS 17+).

So `Views/TranscriptText.swift` paints **paragraphs, list items and blockquotes**. Headings and table cells stay on SwiftUI `Text`: they carry the same links and the same tap behaviour, they just have no long-press menu. That gap is deliberate — `MarkdownTableLayout` resolves column widths against measured `Text` metrics (see "Markdown tables"), and swapping the engine underneath it would move every column.

Two consequences of the split:

- **TextKit does not interpret `inlinePresentationIntent`.** SwiftUI's `Text` turns a `.stronglyEmphasized` run bold with no font ever being set; TextKit renders `.font` and nothing else. `TranscriptAttributedText` materialises the intents into real fonts, which is why the UIKit path needs its own styling pass rather than reusing `styledInlineCode`.
- **`linkTextAttributes` is empty, not a colour.** Every link run already carries its own foreground; one tint over all of them would repaint inline code as a hyperlink. Pre-formatted text keeps its code colours precisely because the action it carries is Copy, not navigation.
- **The text view reports itself as static text.** A `UITextView` publishes its contents as the accessibility VALUE with an empty LABEL and reports the `textView` element type, where `Text` does the opposite on both counts. Left alone that re-words every VoiceOver announcement and drops the paragraph out of every static-text query — which is how it silently broke UI tests with nothing to do with short actions. `TranscriptTextView` puts the label back, suppresses the value (VoiceOver reads label THEN value, so reporting both speaks the paragraph twice) and pins `.staticText`, re-asserting the trait on every read because `UITextView` recomputes its own when the text changes.

Taps go back out through `\.openURL` — `ChatView.transcriptLinkAction` — rather than being handled in the coordinator, so one routing rule covers both engines and a link cannot behave differently depending on which block it landed in. Actions the shell has to present (a preview sheet, a share sheet, the code menu) travel through `\.transcriptActions`, a struct of closures rather than an observed object: `MessageBubble` is `Equatable` so SwiftUI can skip unchanged rows, and an object that publishes when a sheet opens would invalidate every row on screen (see "Transcript per-render cost"). Those sheets are mounted ONCE at the shell, and **inside** the `\.palette` environment — a sheet inherits the environment at the position its modifier sits in the chain, so mounting it after `.environment(\.palette, …)` presents it against the default dark palette while the shell behind it is light.

### File mentions

`Models/FileMentions.swift` mirrors the web's `core/file-mentions.ts` — same wordy-extension list, same TLD list, same extensionless names — because a mention that linkifies in the leader tab and stays dead on the phone reads as a bug in the phone. Two follower-specific details:

- **`[` is escaped inside the delimiter character class.** Unlike JavaScript, ICU reads a bare `[` inside a set as the start of a NESTED set, so the web pattern copied verbatim compiles to `nil` and every mention silently stops being found.
- **URLs are masked with spaces of the same character count** before the scan, so `https://example.com/static/app.js` cannot contribute `example.com/static/app.js`. Masking preserves the character count and nothing else, which is why `FileMentions.Candidate` reports a character OFFSET rather than a `String.Index`.

Resolution is where the follower deliberately diverges. The browser answers a bare `check.js` by walking its own VFS and indexing basenames; here every step of a walk is an `fs.request` over the data channel, so `FileMentionResolver` settles only what one `stat` can settle: an **absolute path**, or a partial name that matches a path the turn's own tool calls already named (`ToolCallPathHints`, mirroring `core/tool-call-paths.ts` down to its two-container depth floor). Anything else stays plain text. Verdicts — including the "not a file" ones, which are the common case — are cached for 30s, so a streaming reply does not re-ask per chunk; `AppState.disconnect()` resets them, because a different leader has a different filesystem.

### Base64 payloads

`Models/Base64Mentions.swift` + `Models/Base64Payload.swift` mirror the web's `core/base64-mentions.ts` and `core/base64-payload.ts`, including the column-wrapped-block reassembly that `base64`(1) output actually needs. The verdict rule is the same and is the point: a candidate whose decoded bytes are neither a known signature, a declared type, nor readable text is NOT a payload, and stays exactly as typed — collapsing a run hides text the user wrote.

Unlike the web there is no inline chip: SwiftUI cannot seat a button inside a `Text`, so a paragraph carrying a payload is split into stacked segments by `TranscriptParagraph`. The text either side is trimmed, because a paragraph block legitimately contains blank lines (the parser flushes on a fence, a heading or a list, not on an empty line) and painting them as-is leaves a hole above and below the chip — exactly the noise the chip exists to remove.

The preview sheet is the Files surface's own `FilePreviewSheet`, so a file opened from prose and one opened from the file browser look identical. It renders an **image** before it tries text, because a small PNG will happily decode as garbage UTF-8 and a size line where a screenshot should be is the follower failing to answer the question the tap asked.

### Cost

The finished inline run is memoised in `TranscriptInlineCache`, keyed by (markdown, confirmed files). The pipeline adds a markdown parse, two regex passes, an `NSDataDetector` walk and — for anything past the 128-character floor — a base64 decode, and `MarkdownText` rebuilds its content on every body evaluation. Keying on the confirmed-file map keeps the newly-resolved case correct: when a mention resolves, the key changes and the run is rebuilt. Resolution itself is debounced 250ms inside `.task(id: content)`, which re-fires on every streaming chunk.

Covered by `SliccFollowerTests/TranscriptEntityScanTests` and `TranscriptShortActionTests`; the fixture is `-uiTestShortActionsFixture YES` (`ChatFixture.makeShortActionMessages`), kept apart from `makeMessages()` because several UI tests pin that transcript's shape.

## Transcript scroll anchoring (#2072)

The transcript pins its bottom with `.defaultScrollAnchor(.bottom)` and nothing else. It must **not** carry a `.scrollPosition($binding)`, and it must not hand-roll bottom-pinning with `onChange` + `scrollTo(edge:)`.

That combination is what [#2072](https://github.com/ai-ecoverse/slicc/issues/2072) was: a reader who had scrolled back through the history was thrown ~258pt further back the moment the keyboard's inset landed. A `LazyVStack` only _estimates_ the height of rows it has not materialized, so the scroll view's content offset is an estimate too ([WWDC26 "Dive into lazy stacks and scrolling with SwiftUI"](https://developer.apple.com/videos/play/wwdc2026/321/) — "avoid using the absolute content size or content offset with lazy stacks, since these are estimated and unstable"). Restoring a bound `ScrollPosition` across a container resize restores that estimate, and it resolves against the end of the _measured_ content — mid-history rather than where the reader was.

`defaultScrollAnchor(.bottom)` is a layout rule resolved **after** the resize rather than a value restored **across** it, so no estimate is in the loop. Measured on an iPhone 17e simulator, iOS 26.5: **258pt of drift before, 0pt after**.

It also subsumes the five `onChange` handlers it replaced, and improves on them. Content that grows while the reader is at the bottom keeps the bottom pinned; a reader who has scrolled away is left alone. The old handlers force-scrolled unconditionally, so any streamed token yanked a reader out of the history.

Two things this cost, both deliberate:

- **The compact/regular shell switch re-opens at the newest message.** `ChatPresentationState.transcriptPosition` existed so a rotation or Split View resize kept the reader's place; it rode on the very binding that caused the bug. Restoring it by message id instead is a follow-up.
- **`.scrollPosition(id:anchor:)` is not a drop-in replacement.** It was measured: with an id binding installed the transcript cannot be dragged back at all (the anchor row never reaches the viewport within 14 drags). Do not reach for it without re-measuring.

`SliccFollowerUITests/TranscriptComposerGrowthUITests` is the gate, and it asserts the **measured drift** across a keyboard transition rather than mere rendering — only the measurement catches a reintroduction. It runs on the real chat surface via `-uiTestTranscriptFixture YES` (`UITestHooks.seedTranscriptFixture`), because `-uiTestFixtureRoute` has no composer and this needs a transcript and a composer on screen together.

Two gotchas if you touch that test: the anchor row is offscreen at launch, so `element.swipeDown()` fails with "visible frame is empty"; and `app.scrollViews.firstMatch` resolves to one of `HorizontalScrollGuard`'s zero-width horizontal scrollers, not the transcript. Use coordinate drags.

Full measurement write-up, including the rejected UIKit port: [`docs/research/ios-transcript-uikit.md`](research/ios-transcript-uikit.md).

## Transcript per-render cost

The transcript re-evaluates its rows constantly, so everything a row does per body evaluation is paid many times over. Measured on an 18-message fixture: **871 `MessageBubble` body evaluations and 227 full markdown re-parses just to scroll back two screens**, and 360 body evaluations to type one sentence.

Four rules keep it down. `SliccFollowerTests/TranscriptInvalidationTests` gates all of them.

- **`MarkdownBlockParser.parse` is memoized** (`NSCache`, 256 entries). `MarkdownText.blocks` is a computed property on a `View`, so it re-parses on every body evaluation; message bodies are immutable once a turn settles, so only the streaming tail is ever a genuine miss. `NSCache` over a dictionary because a streaming reply mints a key per token and must be allowed to evict.
- **The timestamp formatters are shared `static let`s.** `groupedMessages` recomputes per body evaluation and calls the labeller once per message, so a `DateFormatter()` per call meant N allocations per render. There are **two** formatters on purpose: the old code mutated one formatter's `dateStyle` mid-function for the older-than-yesterday branch, so a naive hoist would leak that style into every later "Today" label.
- **A row receives only its OWN tool progress**, sliced by `progressSlice(for:)`. Handing every row the whole `AppState.toolProgress` meant one tick on one tool changed every bubble's value and invalidated the entire transcript.
- **No closures on a row's value.** `MessageBubble` is `Equatable` and reads its sprinkle-lick callback from `@Environment(\.inlineSprinkleLick)`. A stored closure never compares equal, and one is enough to defeat the whole comparison — which is what made every other memoization attempt pointless. `ChatMessage` and `ToolCall` conform to `Equatable` so the comparison can be synthesized.

**Still open**: `AppState` is one `ObservableObject` with ~45 `@Published` properties, so any of them invalidates every observer. `ChatPresentationState.composerDraft` has the same shape, which is why a keystroke re-evaluates the whole shell. Migrating either to `@Observable` is the remaining win and is NOT done — `@State` has no autoclosure initializer, unlike `@StateObject`, so a naive swap constructs a fresh model on every `ChatView.init` and trips `ChatPresentationStateTests`. Tracked in [#2072](https://github.com/ai-ecoverse/slicc/issues/2072); full measurements in [`docs/research/ios-transcript-uikit.md`](research/ios-transcript-uikit.md).

## Read-only scoop view

Users never talk to a scoop ([#2312](https://github.com/ai-ecoverse/slicc/issues/2312) on the web, [#2367](https://github.com/ai-ecoverse/slicc/issues/2367) here). Selecting one opens a READ-ONLY transcript: `ConversationView` does not render `InputBar` at all, so nothing is reserved and the transcript grows into the freed band — read-only means the composer does not exist, not that it is disabled (the frozen-session view has always worked this way). Send, dictation (PTT holds the composer) and attachment affordances all live inside that band and leave with it, and a scoop's `tool_ui` never mounts an approval card: the leader routes every scoop request that needs a human to the cone that owns it. Cards are held globally (the leader retracts each by `tool_ui_done`, not per scoop), so `visibleToolUICards` also hides a card the CONE raised while a scoop is selected — hidden, not dropped: it is still the cone's to answer and returns on switching back.

The rule is stated ONCE, in `Models/UnitRole.swift` — `UnitRole.isReadOnly`, the mirror of the webapp's `isReadOnlyRole` — and reached through `ScoopSummary.role`, itself derived from `isRootUnit`: `parentId` (the ownership edge) decides wherever the leader sends it, and only a leader that predates the field falls back to the legacy `isCone` flag ([#2358](https://github.com/ai-ecoverse/slicc/issues/2358) removes it from the wire). Views ask `AppState.selectedUnitIsReadOnly`; none of them re-derives "is this a scoop". `sendMessage` refuses too, because dictation and the inbound-action paths reach it without a composer, and the `tool_ui` refusal is keyed on the OWNING unit rather than the selection, so switching tabs cannot surface a card either. A selection the roster does not describe yet keeps the composer — the pre-multiple-cones default, re-asserted by the next `scoops.list`, exactly as the browser follower resolves it.

Cone selection is unchanged. Covered by `SliccFollowerTests/ReadOnlyScoopTests` and `SliccFollowerUITests/ReadOnlyScoopUITests`.

## UI-test hooks

`UITestHooks` is `#if DEBUG` only. **No test needs a leader**: `-uiTestFixtureRoute YES` opens the leaderless UI Fixture; `-uiTestSessionsFixture/Empty YES` seeds iCloud sessions; `-uiTestRecentJoinsFixture/Empty YES` seeds the synced Recent list (one row this device recorded, one synced from a fixture iPad with no label — the hand-pasted case); `-uiTestScoopStatusFixture` covers lifecycle/fill; `-uiTestUnitRoleFixture cone|scoop` seeds one cone plus the scoop it owns and starts on either, which is how the read-only scoop view is reached without a leader; `-uiTestReduceMotion` freezes pupil motion + noise; `-uiTestCompletedTurn YES` feeds a completed turn; `-uiTestConnectionState` pins a start state (published immediately — a pinned state is a premise, not a transition); `-uiTestConnectionBlip "<dropAfter>[,<healsAfter>]"` stages the mid-session drop the settle window exists for; `-uiTestShortActionsFixture YES` seeds the transcript whose every paragraph carries something to act on (see "Transcript short actions"). Failure-state dials `http://127.0.0.1:1/…` so the avatar reaches `Connection Failed` without DNS.

## Coverage gate details

Outputs land in `.build/coverage/`. The gate runs only `SliccFollowerTests`, disables parallel clones, and keeps random order. Coverage combines app dylib + linked frameworks so `SliccTrayKit` stays measured. Exclude `SliccFileProvider/` (appex not launched in unit tests); **never add the thin adapter binary as a coverage object**. File Provider reads are memory-bound (`readBinaryFile` holds full base64 + decoded `Data`); large VFS files are unsupported until reads stream to disk.

## Linting details

`.swiftlint.yml` inherits repo-root via `parent_config` and excludes `.build`/`SliccFollower.xcodeproj`; only `error` severity fails CI. `swiftlint --fix` rewrites every scanned file (clean tree only). CI ends with an informational Periphery scan (`|| true`) naming project/scheme/target. `swift format` uses repo-root `.swift-format`; run `npm run lint:swift:format` / `format:swift` from repo root (covers `SliccTrayKit`).

## UI-test details

- Put accessibility identifiers on leaves (`message-<id>`). Container ids propagate; `.accessibilityElement(children: .contain)` does not fix it.
- Row ids alone are blind — also add a `variantMarkers` string only that renderer can emit.
- The transcript pins to the newest message; variant walks scroll bottom-to-top and must be bounded.
- A red CI job names the test, not the reason. Read XCTAssert text from the uploaded `test-timings-ios-app-<ios>-<device>` xcresult via `xcrun xcresulttool get test-results tests`. Host death before XCTest connects is usually a runtime mismatch or `CODE_SIGNING_ALLOWED=NO`, not flake.
- Regular-width browser tabs claim the whole iPad window; returning to the overview restores the split. CI runs this enter/exit regression in the `ios-app-tests` matrix (iPad cells).

## Exec capability

`capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, scoped-approval gated, launched via `UIApplication.open` (`universalLinksOnly` for `--universal`). Raw paths reject traversal + encoded delimiters; hierarchical URLs must standardize unchanged. 1,024 IDs are tombstoned; 128 failed retries are held FIFO.

## TestFlight distribute

`scripts/testflight-distribute.mjs` (gated on `SLICC_TF_EXTERNAL_GROUP`; unset = upload-only) waits for processing, sets What to Test notes, submits Beta App Review, and attaches the build to that group. **Submission and attach are independent** — only a `fatal` submit aborts; `deferred` (review quota) warns and still attaches, so the build ships once review clears. Tests: `testflight-distribute.test.mjs`.

What to Test copy comes from `composeWhatsNew()`: the release workflow's `analyze` job drafts end-user highlights from the last week of `feat`/`fix`/`perf`/revert commits touching `packages/ios-app` + the swift tray packages (path-selected, not scope-selected — cross-cutting tray work rarely carries an `ios` scope) via headless `claude -p` on Bedrock (not `claude-code-action` — it rejects push-triggered workflows) and passes them as `SLICC_TF_WHATS_NEW`; the static onboarding copy (session-join instructions, appending `SLICC_TF_DEMO_JOIN_URL`) always follows, and highlights are capped at 3,000 code points so the footer survives the ASC 4,000-char limit. The draft is **best-effort by design** — no iOS commits, a model outage, or empty output all leave `SLICC_TF_WHATS_NEW` unset and the static copy ships alone; the draft must never block a release.
