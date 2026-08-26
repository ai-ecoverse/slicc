> [!NOTE]
> **Outcome (2026-08-26).** The recommendation held — no UIKit port — but the fix needed one more
> part than this report first proposed. `defaultScrollAnchor(.bottom)` alone kills the jump (0pt drift,
> confirmed) **but stops the list following new messages**: measured, a sent message landed in the
> transcript and the view did not move to it. The shipped fix therefore pairs the anchor with a
> one-shot `ScrollViewReader.scrollTo(id:)` gated on `onScrollTargetVisibilityChange` — a scroll
> _action_, never a stored offset, so it cannot reintroduce #2072. A user's own message always wins;
> everything the cone produces defers to where the reader is. Two further variants were measured and
> rejected: `.scrollPosition(id:anchor:)` (the transcript cannot be dragged back at all with it
> installed) and removing the binding with no anchor (loses the initial bottom pin, so the
> measurement point is unreachable). See PR for #2072.

# Should the iOS transcript be ported from SwiftUI to UIKit?

**Status:** research, no production code changed. **Date:** 2026-08-26.
**Question:** issue [#2072](https://github.com/ai-ecoverse/slicc/issues/2072) (keyboard jump) + general
transcript sluggishness. Proposal on the table: rewrite `MessageListView` on UIKit.

## Recommendation, up front

**Do not port. Fix the SwiftUI.** The keyboard jump is not an unfixable platform bug — it is caused by
**our own `.scrollPosition($binding)` on the transcript's `ScrollView`**. I reproduced the jump, then
removed that one modifier in favour of `.defaultScrollAnchor(.bottom)`, and the jump went to **exactly
zero drift** on the same device, runtime, fixture and reading position.

(See the note above: the anchor alone also removes auto-follow, so the shipped fix adds a gated
one-shot `scrollTo`. The diagnosis below is unchanged; only the size of the fix moved, from ~3 lines
to ~30.)

| variant                                            | anchor row `midY` after reader scroll | after keyboard | after 1st keystroke | after long type | drift        |
| -------------------------------------------------- | ------------------------------------- | -------------- | ------------------- | --------------- | ------------ |
| baseline (`.scrollPosition($shared)`)              | 507.5                                 | 766.2          | 766.2               | row gone        | **+258.7pt** |
| baseline, repeat run                               | 531.8                                 | 789.5          | 789.5               | row gone        | **+257.7pt** |
| A2: `.scrollPosition($localState)`                 | 513.2                                 | row gone       | —                   | —               | **worse**    |
| **A: `.defaultScrollAnchor(.bottom)`, no binding** | **508.8**                             | **508.8**      | **508.8**           | **508.8**       | **0.0pt**    |

iPhone 17e simulator, iOS 26.5, Xcode 26.6, `ChatFixture` (18 messages), anchor row centred in the
viewport before focusing the composer in every run.

Variant A also **regresses nothing**: the transcript-adjacent UI suite
(`TranscriptColumnUITests`, `FixtureConversationUITests`, `ComposerKeyboardUITests`,
`ReadOnlyScoopUITests`, `SteerUITests` — 14 tests) produces the **identical** 4 failures on variant A
and on pristine `main`, and all four are pre-existing on this simulator (two hardware-keyboard tests,
one gesture-handoff test, and one stale hard-coded id list that the fixture outgrew when #2316 added
`fx-assistant-progress*`).

The sluggishness is a separate problem with a separate, also-not-a-port fix: the transcript re-parses
its markdown and re-evaluates every visible row several times per keystroke. Measured below.

A UIKit port would cost weeks, regress [#2316](https://github.com/ai-ecoverse/slicc/pull/2316),
[#2378](https://github.com/ai-ecoverse/slicc/pull/2378) and [#2048](https://github.com/ai-ecoverse/slicc/pull/2048),
and — because `UIHostingConfiguration` cells do not self-resize when their SwiftUI content changes
height — would hand us the dynamic-height problem back, manually.

---

## A. Diagnosis

### Method

Built the app from this worktree (Xcode 26.6, `-derivedDataPath .build/research-dd`), added throwaway
counters to `MessageListView.body`, `MessageBubble.body`, `MarkdownText.blocks` and `groupedMessages`
that emit to `os_log(subsystem: "ai.sliccy.research")`, and ran the reproduction under
`xcodebuild test` on a booted iPhone 17e simulator while streaming the log. All instrumentation is
throwaway and is **not** part of the deliverable.

Two things had to be fixed before the reproduction could run at all — see "Corrections to the issue".

### A.1 The jump: it is our `scrollPosition` binding, not (only) FB20979569

`MessageListView` installs `.scrollPosition($scrollPosition)`, bound up through `ChatView` to
`@Published var transcriptPosition` on `ChatPresentationState`, and hand-rolls bottom-pinning with five
`.onChange` handlers calling `scrollPosition.scrollTo(edge: .bottom)`.

WWDC26 [session 321, "Dive into lazy stacks and scrolling with SwiftUI"](https://developer.apple.com/videos/play/wwdc2026/321/)
is explicit that a lazy stack's content offset is _estimated_ and that state derived from the absolute
offset is unstable. A `ScrollPosition` bound to a `ScrollView` over a `LazyVStack` is exactly that
estimated quantity, and restoring it across a container resize is exactly the operation that WWDC26
says is not reliable. `.defaultScrollAnchor(.bottom)` is not an offset — it is a layout rule, resolved
after the resize, and it is [documented](<https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:)>)
to keep content pinned to the bottom precisely when "the UI alters without the user scrolling — for
example if the keyboard appears, or you adjust the size of the scroll view".

**Why nobody found this.** The issue's rejected-attempts table contains both halves of the fix, but
never together:

- `.defaultScrollAnchor(.bottom)` — tried, "+265pt, no effect". It has no effect _while a
  `scrollPosition` binding is installed_; the explicit binding wins.
- "remove the `.scrollPosition` binding" — dismissed as "confounded: also removes the initial
  scroll-to-bottom". True, and resolvable: `.defaultScrollAnchor(.bottom)` supplies the initial
  scroll-to-bottom. The confound was the reason to stop, and it was removable.

**What I changed in variant A** (three things at once, so attribute with care):

1. `.scrollPosition($scrollPosition)` → `.defaultScrollAnchor(.bottom)`
2. `scrollToBottom()` made a no-op (the five `.onChange` handlers stop force-scrolling)
3. nothing else

Variant A2 isolates one confound: keeping `.scrollPosition` but binding it to a **local** `@State`
instead of the shared `@Published` did **not** help — it was worse. So the problem is the
`ScrollPosition`-over-`LazyVStack` restoration path, not the `@Published` round-trip.

A minimal bisect between (1) and (2) is still owed before anyone writes the fix.

### A.2 The sluggishness: over-invalidation and per-frame re-parsing

Counters from one instrumented run, correlated against the test's own timeline:

| phase                                             | `MessageListView.body` | `groupedMessages` | `MessageBubble.body` | `MarkdownBlockParser.parse` |
| ------------------------------------------------- | ---------------------- | ----------------- | -------------------- | --------------------------- |
| launch → reader has scrolled back (2 drags, ~14s) | 44                     | 43                | **871**              | **227**                     |
| typing ~70 characters (~4.5s)                     | 38                     | 38                | **360**              | 0                           |

18 fixture messages. Scrolling back two screens cost 871 row-body evaluations and 227 complete markdown
re-parses. Typing cost 38 full transcript rebuilds and 360 row-body evaluations — roughly **five
message-body evaluations per keystroke**.

Four mechanisms, all in our code, all fixable without leaving SwiftUI:

1. **`MarkdownText.blocks` is a computed property.** `MarkdownBlockParser.parse(content)` runs on every
   body evaluation, and every block then calls `AttributedString(markdown:)` plus a run-walk in
   `styledInlineCode`. Nothing is cached. `MessageBubble.assistantBody` additionally re-runs
   `extractInlineSprinkles` (two scanning passes over the message text) and `splitIntoSegments` per
   body evaluation.
2. **`groupedMessages` allocates a `DateFormatter` per message, per evaluation.**
   `MessageListView.timestampLabel(for:calendar:)` constructs a fresh `DateFormatter()` on every call;
   `groupedMessages` calls it once per message and is itself recomputed on every body evaluation.
   `DateFormatter` construction is one of the more expensive things in Foundation.
3. **`AppState` is one `ObservableObject` with ~45 `@Published` properties**, reached by `ChatView`,
   `ConversationView` and three other views via `@EnvironmentObject`. Any one of those 45 firing
   invalidates the whole chat shell, and the transcript with it. `ChatPresentationState` adds
   `@Published var composerDraft`, so **every keystroke re-evaluates `ChatView.body`** and everything
   under it. iOS 26 has `@Observable`, which tracks per-property; the app has not adopted it.
4. **Nothing in the transcript path can be memoised.** `MessageListView` and `MessageBubble` both carry
   escaping closures (`onInlineSprinkleLick`, `onOpenApprovalDecision`, …), which never compare equal,
   so SwiftUI can never skip a body. `MessageBubble` is also handed the **entire** `toolProgress`
   dictionary, so one progress tick on one tool row invalidates every row in the transcript.

Plus two things that make the lazy stack's estimates worse, both of which WWDC26 names directly
("layout changes post-appearance … invalidate estimates, cause jumpiness"):

5. **`HorizontalScrollGuard`** is applied to every markdown table and every fenced code block. Each one
   installs a `GeometryReader` publishing `proxy.frame(in: .named(transcriptSpace))` — a value that
   changes on **every scroll frame** — into an `.onPreferenceChange` that writes `@State`. Scrolling a
   transcript with N code blocks on screen therefore does N preference propagations and N state writes
   per frame.
6. **`InlineSprinkleHost`** reports its `WKWebView`'s height back through `@State` after load, resizing
   the row after it appeared. `InlineSprinkleView` has no cache, so a sprinkle that scrolls out of the
   materialised window is destroyed and reloaded from scratch on the way back.

### A.3 What is _not_ the cause

Ruled out, so nobody re-investigates:

- **Animations.** `PulsingDot`, `ToolProgressBar` and the breathing chrome all use
  `.animation(_:value:)` on `scaleEffect`/`opacity`. Those are render-server animations, not per-frame
  body evaluations, and they contributed nothing to the counters.
- **Image decoding.** The transcript has no async image path; attachments render as chips.
- **`scrollTargetLayout` cancelling frames (the #2048 mechanism).** That bug is about a sizing frame
  _wrapping_ the target layout. Here the cap is correctly on the rows, and variant A left
  `.scrollTargetLayout()` in place and still went to zero drift — so the target layout is not
  implicated in the keyboard jump.

### A.4 Corrections to the issue and the draft PR

Three premises in #2072 / #2086 did not survive checking. Stating them plainly because they shaped the
"platform bug, wait for Apple" conclusion:

1. **"Apple DTS acknowledged it."** [Forum thread 805306](https://developer.apple.com/forums/thread/805306)
   does not show an acknowledgement. The DTS engineer asked for a test project and then reported the
   opposite: _"I tried Xcode 26.1 beta 3 … the dynamic latin paragraphs are working well so far for
   me."_ They could not reproduce it and referred the reporter to Feedback Assistant. FB20979569 exists;
   an Apple confirmation of it does not.
2. **`seedTranscriptFixture` is never called.** On `origin/fix/ios-transcript-composer-growth`,
   `UITestHooks.seedTranscriptFixture(into:)` is defined and has **no call site** — `git grep` finds
   only the declaration. So `-uiTestTranscriptFixture YES` seeds nothing, the anchor row never appears,
   and `TranscriptComposerGrowthUITests` fails at `waitForExistence(timeout: 60)`. This is very likely
   the real explanation for "the harness cannot reach the measurement point on iOS 27" — it cannot
   reach it on 26 either, as pushed. I added the call site locally to run any of this.
3. **"The inset lands on the first keystroke, not when the keyboard appears."** Not on my device. With
   a 1.5s settle after `app.keyboards.firstMatch` exists, the full displacement had _already_ happened
   (507.5 → 766.2), and the first keystroke added **zero** further movement. Either this is
   device-dependent (iPhone 17e vs the iPhone 17 Pro used in the issue) or the earlier sampling ran
   before the settle. It matters because "the keystroke does it" points at composer growth, and
   composer growth is not involved.

The test also needs two mechanical fixes to run: `anchor.swipeDown()` fails because the row is
offscreen at launch, and `app.scrollViews.firstMatch` resolves to one of `HorizontalScrollGuard`'s
zero-width horizontal scrollers. Coordinate drags work.

---

## B. Pre-built libraries

Checked via the GitHub API on 2026-08-26 (default-branch last commit, not just `pushed_at`, which
picks up branch pushes on a dormant repo).

| library                                                                 | last commit    | last release        | stack                                | verdict                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------- | ------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MessageKit](https://github.com/MessageKit/MessageKit) (6.3k★)          | 2026-08-20     | 5.0.0, Dec 2024     | UIKit `UICollectionView`, min iOS 14 | Maintained but **not viable**: the row model is a closed `MessageKind` enum (text/photo/video/location/…). Our rows host markdown, tool-progress chrome, `WKWebView` sprinkles and approval cards. You would fight it for every row we have.   |
| [Chatto](https://github.com/badoo/Chatto) (4.5k★)                       | **2025-11-25** | **4.1.0, May 2021** | UIKit                                | **Effectively abandonware.** `pushed_at` reads 2026-08 but the default branch has not moved in nine months and there has been no release in five years. 162 open issues. Do not adopt.                                                         |
| [ExyteChat](https://github.com/exyte/Chat) (1.9k★)                      | 2026-08-21     | 2.1.4, Jan 2025     | SwiftUI, min iOS 17                  | Genuinely maintained. But it pulls in the **Giphy iOS SDK (pinned exact), Kingfisher and Exyte MediaPicker**, and its message model is media-messaging shaped. Wrong dependency footprint for a follower app, and no seam for our row content. |
| [SwiftyChat](https://github.com/EnesKaraosman/SwiftyChat) (349★)        | 2026-06-01     | —                   | SwiftUI                              | Small, alive-ish, 11 fixed message types. Same closed-enum problem as MessageKit with less behind it.                                                                                                                                          |
| [Stream Chat SwiftUI](https://github.com/GetStream/stream-chat-swiftui) | 2026-08-25     | **5.9.0, Aug 2026** | SwiftUI                              | The healthiest of the lot, and **the most useful thing here is its source, not its API** — see C. Adopting it means adopting Stream's backend model. Not applicable.                                                                           |

**Conclusion for B: no turnkey library fits.** Every chat framework in this space models a _message_ as
a closed set of kinds. Our rows are open-ended: markdown blocks with horizontally-scrollable tables and
code, `ToolProgressChrome`, `InlineSprinkleHost` (`WKWebView`), `ToolUICardView`, `OpenApprovalCard`,
`SudoApprovalCard`, `LickRow`, `ErrorCard`. Adopting any of them means reimplementing all of that
inside someone else's cell contract, which is strictly more work than fixing our own list.

For the _list_ rather than the _chat_, if a UIKit port ever happens, the maintained options are
[IGListKit](https://github.com/Instagram/IGListKit) (13k★, active 2026-08-19; Objective-C-ish, section
based) and [ReactiveCollectionsKit](https://github.com/jessesquires/ReactiveCollectionsKit) (192★,
active 2026-06-22; modern diffable/compositional). Neither is needed for the recommendation below.

---

## C. State of the art, 2026

**Apple's guidance.** WWDC26 session 321, ["Dive into lazy stacks and scrolling with SwiftUI"](https://developer.apple.com/videos/play/wwdc2026/321/)
(Rens Breur, UI Frameworks) is the authoritative statement and reads like a list of things we do:

- Lazy stacks estimate off-screen heights as _average placed size × remaining count_, refining as you
  scroll. **Absolute content offset is estimated and unstable** — do not derive state from
  `onScrollGeometryChange`; use `onScrollTargetVisibilityChange`.
- **Prefer id-based scrolling over absolute offset**, because a lazy stack can locate a `ForEach` target
  without building the views in between.
- **Set views up in `init`, not `onAppear`** — prefetched work done in `onAppear` is discarded.
- **Avoid layout changes after appearance** (`onGeometryChange`-driven resizing): it invalidates the
  estimates and causes jumpiness. (`HorizontalScrollGuard` and `InlineSprinkleHost` both do this.)

The session says nothing specific about keyboard insets or chat transcripts. `defaultScrollAnchor(.bottom)`
(iOS 17, refined with `defaultScrollAnchor(_:for:)` and `ScrollAnchorRole` in iOS 18) is Apple's
documented answer for "scroll view that starts at the bottom and stays pinned when the keyboard
appears" — that is the closest thing to an official chat-transcript recommendation.

**What a shipping SwiftUI chat SDK actually does.** Stream Chat SwiftUI 5.9.0 (Aug 2026) still uses
`ScrollView` + `LazyVStack` — no UIKit list — with three notable choices, all readable in
[`MessageListView.swift`](https://github.com/GetStream/stream-chat-swiftui/blob/main/Sources/StreamChatSwiftUI/ChatMessageList/MessageListView.swift):

1. **Inverted list.** `.flippedUpsideDown()` on the scroll view and again on each row. The bottom
   becomes the layout origin, so a viewport resize never has to restore an estimated offset.
2. **The `scrollPosition` binding is installed only when it is needed** —
   `ScrollPositionModifier(scrollPosition: loadingNextMessages ? $scrollPosition : .constant(nil))`.
   They deliberately do not leave it attached. This is the same conclusion this report reaches, arrived
   at independently.
3. **An eager stack below 20 messages**, with a comment recording the same class of bug we hit:
   _"the jump reproduces with two or more messages in a lazy stack even with all scroll callbacks
   disabled, and never with an eager one."_

**The UIKit-is-faster claim.** [Jacob's Tech Tavern, "SwiftUI vs UIKit" (2026-03-09)](https://blog.jacobstechtavern.com/p/swiftui-vs-uikit)
measured 3.4 hitches/s and 248MB for a SwiftUI `List` against 0.7 hitches/s and 92MB for
`UICollectionView`, and concludes "SwiftUI is dead, long live UIKit". Real numbers, but the workload —
high-resolution autoplaying GIFs in variable-size cells — is not ours, and the same author's
[earlier 120fps study](https://blog.jacobstechtavern.com/p/swiftui-scroll-performance-the-120fps)
found SwiftUI `List` (which _is_ `UICollectionView` underneath) matched UIKit on dynamically-sized
content while raw `LazyVStack` "crapped out". Treat as: raw `LazyVStack` is the weak spot; recycling
containers are fine. That is a point in favour of the seam in D, not of a full port.

**`UIHostingConfiguration` reality check.** It is the only officially supported way to put SwiftUI in a
collection-view cell — and cells hosted this way **do not resize themselves when the SwiftUI content
changes its own height**; you must tell the collection view to re-measure. Our streaming rows grow on
every token and our sprinkle rows resize asynchronously from JavaScript. A UIKit port therefore does
not remove the dynamic-height problem, it transfers ownership of it to us, per row, per token. That is
the single most important fact for the decision.

---

## D. The hybrid options, ranked by value per unit of rewrite

| #     | seam                                                                                                                                                                                                                                       | what it buys                                                                             | what it costs                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Replace `.scrollPosition($binding)` with `.defaultScrollAnchor(.bottom)`**                                                                                                                                                               | **Measured: the entire keyboard jump.**                                                  | ~3 lines + one unit test + losing offset-preservation across the compact/regular shell switch.                                                                                                                 |
| **1** | Memoise per-message derived content (parse markdown / extract sprinkles once per `(id, content)`, not per body); hoist the `DateFormatter` to a `static let`; pass each row only _its_ `ToolProgressEvent` instead of the whole dictionary | Removes the 227 re-parses and most of the 871 row evaluations. This is the sluggishness. | A day or two. Local to `MarkdownText`, `MessageBubble`, `MessageListView`. Zero risk to #2316/#2378/#2048.                                                                                                     |
| **2** | Migrate `AppState` + `ChatPresentationState` to `@Observable`                                                                                                                                                                              | Per-property tracking; a keystroke stops invalidating the transcript                     | A few days, wide but mechanical diff, well-covered by the existing UI suite.                                                                                                                                   |
| **3** | Give `HorizontalScrollGuard` a cheaper region-publishing path (publish on gesture start, not on every scroll frame); cache `InlineSprinkleView`'s `WKWebView` by id                                                                        | Removes the per-frame preference/state churn and the sprinkle reload storm               | ~2–3 days, touches the swipe-arbitration invariants — needs care.                                                                                                                                              |
| 4     | Keep SwiftUI rows, swap the container for `UICollectionView` + `UIHostingConfiguration`                                                                                                                                                    | Cell recycling; explicit offset control across bounds changes                            | ~1–2 weeks. Inherits the manual re-measure burden for every streaming and sprinkle row. Rebuilds the swipe arbitration, the iPad reading column (#2048) and the frozen-session viewer against a new container. |
| 5     | Invert the list (Stream's approach), staying in SwiftUI                                                                                                                                                                                    | Bottom becomes the layout origin; resizes stop needing offset restoration                | ~3–5 days. `WKWebView` under a double `rotationEffect` is the risk; VoiceOver ordering needs checking. **Only worth it if #0 does not hold up.**                                                               |
| 6     | Full UIKit port                                                                                                                                                                                                                            | —                                                                                        | Weeks. Regresses #2316, #2378, #2048. Not justified by anything measured here.                                                                                                                                 |

**The boundary that buys the most for the least is #0 and #1.** They are independent, they are both
local to the transcript files, and between them they address both complaints.

---

## E. Recommendation

**Fix the SwiftUI. Do not port.** In order:

1. **Land #0 behind the reproduction test.** Bisect variant A into its two halves first (is it removing
   the binding, or adding the anchor, or both?), then take the minimal change. Ship
   `TranscriptComposerGrowthUITests` **un-skipped**, with the call site PR #2086 is missing, as the
   regression gate.
2. **Land #1** — the memoisation and the `DateFormatter`. Cheap, safe, and it is the actual answer to
   "sluggish".
3. **Then re-measure.** Only if the transcript is still slow after #1 does #2 (`@Observable`) and #3
   (guard/sprinkle churn) become worth their diff. Only if #0 does not hold on real devices does #5
   (inversion) come back on the table. #4 and #6 need a much stronger case than exists today.

### Cost

- #0: half a day of work, plus a day of verification across devices and both shells.
- #1: 1–2 days.
- #2 + #3, if needed: ~1 week.
- Full port (#6), for comparison: 3–5 weeks with a high regression surface.

### Risks and open questions

- **`defaultScrollAnchor(.bottom)` must still auto-scroll on new messages.** Partially covered:
  `FixtureConversationUITests` walks the transcript from the newest row and behaved identically under
  variant A, so the _initial_ bottom pin survives. What is **not** covered is _append-time_ pinning —
  the fixture is static. Verify with a streaming fixture: at the bottom, a streamed reply pulls the view
  down; scrolled back, it does _not_ hijack the reader. (The current five `.onChange` handlers
  force-scroll unconditionally, which is arguably a bug of its own.)
- **The shell switch loses viewport preservation.** `ChatPresentationState.transcriptPosition` exists so
  a compact↔regular transition keeps the reader's place. If the binding goes, either accept that or
  switch to the **id-based** `.scrollPosition(id:anchor:)` form, which WWDC26 explicitly prefers over
  offset-based and which may keep both properties. Worth testing as variant B.
- **`ChatPresentationStateTests` exercises `transcriptPosition.scrollTo(id:)`** and would need rework.
- **Simulator, one device, small fixture.** Everything above is iPhone 17e / iOS 26.5 / 18 messages.
  Confirm on a physical device and on a several-hundred-message transcript before committing.
- **iOS 27.** Untested here. If #0 lands, the reproduction test becomes the tripwire for both the SDK
  bump and any regression.

### What I would measure first, before writing any fix

1. ~~**Bisect variant A**~~ — **done.** Removing the binding with no anchor cannot reach the
   measurement point at all (the transcript opens at the top, so the anchor row is never
   materialized). The anchor is load-bearing; the two changes are inseparable.
2. ~~**Variant B: `.scrollPosition(id:anchor:)` + `.defaultScrollAnchor(.bottom)`**~~ — **done, and
   rejected.** With an id binding installed the transcript cannot be dragged back at all: the anchor
   row never reaches the viewport in 14 drags. Do not reach for it without re-measuring. The
   compact/regular restoration stays lost, and is a follow-up.
3. ~~**A streaming-append fixture**~~ — **done**, as `-uiTestTranscriptAppendAfter`. It caught the
   real regression in the first proposed fix: `defaultScrollAnchor(.bottom)` alone does not follow
   appended content once the keyboard has resized the viewport.
4. **Instruments "Animation Hitches" on a physical device** with a few hundred real messages, before and
   after #1, so the sluggishness claim has a hitch rate attached rather than a body-evaluation count.
5. Re-run the reproduction on **iOS 27** now that the fixture hook actually works.

---

## Evidence appendix

- Reproduction: `TranscriptComposerGrowthUITests` from PR #2086, plus the missing
  `seedTranscriptFixture` call site, plus coordinate-drag scrolling and a mid-viewport anchor target.
- Instrumentation: `os_log` counters on `MessageListView.body`, `MessageBubble.body`,
  `MarkdownText.blocks`, `groupedMessages`.
- Runs: baseline ×2 (+258.7pt, +257.7pt), variant A2 ×1 (worse — anchor left the tree), variant A ×2
  (0.0pt, 0.0pt).
- Regression check: 14-test transcript-adjacent UI subset, variant A vs pristine `main` — same 4
  pre-existing failures on both (`testCodeBlockScrollUsesRubberBandScoopHandoff`,
  `testEveryFixtureMessageVariantRenders`, `testReturnSubmitsPrompt`, `testShiftReturnInsertsLineBreak`).
- Environment: iPhone 17e simulator `1B486B0A`, iOS 26.5, Xcode 26.6 (17F113), macOS 15 (Darwin 25.5).

### Sources

- [WWDC26 321 — Dive into lazy stacks and scrolling with SwiftUI](https://developer.apple.com/videos/play/wwdc2026/321/) ([notes](https://wwdcnotes.com/documentation/wwdc26-321-dive-into-lazy-stacks-and-scrolling-with-swiftui/))
- [Apple forums 805306 — ScrollView + LazyVStack + dynamic height on iOS 26](https://developer.apple.com/forums/thread/805306)
- [Apple forums 794212 — iOS 26 breaks simultaneous gestures in SwiftUI chat](https://developer.apple.com/forums/thread/794212)
- [`defaultScrollAnchor(_:)`](<https://developer.apple.com/documentation/swiftui/view/defaultscrollanchor(_:)>) · [`scrollPosition(id:anchor:)`](<https://developer.apple.com/documentation/swiftui/view/scrollposition(id:anchor:)>)
- [Stream Chat SwiftUI `MessageListView.swift`](https://github.com/GetStream/stream-chat-swiftui/blob/main/Sources/StreamChatSwiftUI/ChatMessageList/MessageListView.swift)
- [Jacob's Tech Tavern — SwiftUI vs UIKit (2026-03-09)](https://blog.jacobstechtavern.com/p/swiftui-vs-uikit) · [SwiftUI Scroll Performance: The 120FPS Challenge](https://blog.jacobstechtavern.com/p/swiftui-scroll-performance-the-120fps)
- [Apple forums 789208 — `UIHostingConfiguration` touch handling](https://developer.apple.com/forums/thread/789208) · [719445 — hosting controllers in cells](https://developer.apple.com/forums/thread/719445)
