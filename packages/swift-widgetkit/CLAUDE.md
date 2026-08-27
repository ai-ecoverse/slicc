# CLAUDE.md

Shared widget library in `packages/swift-widgetkit/` — the SPM module `SliccWidgetKit`. Deep reference: [`docs/widgets.md`](../../docs/widgets.md).

## Scope

Everything the "Cones & Scoops" home-screen widget draws, for both hosts: the iOS follower's `SliccWidgets.appex` (`packages/ios-app/SliccWidgets/`) and Sliccstart's `SliccstartWidgets.appex` (`packages/swift-launcher/SliccstartWidgets/`). Foundation + SwiftUI + WidgetKit only — **no WebRTC, no AppKit/UIKit, no tray transport**. A widget runs in its own short-lived process under a hard memory budget; anything linked here is loaded to paint a 158pt tile.

Supports `.macOS(.v14)` and `.iOS("18.0")`.

## Contents

- `Model/WidgetUnit.swift` — one work unit as a widget sees it: role, lifecycle, activity refinement, fill, model, detail. A read-only projection of `ScoopSummary`, deliberately **not** a re-export — the widget must decode snapshots written by older builds of the app, so it versions on its own clock (`WidgetSnapshot.schema`).
- `Model/WidgetSnapshot.swift` — instance identity, connection, capture time, units, and the last turn (`WidgetMessage`). `isStale(asOf:)` and `isUnavailable` are the two state questions every family asks.
- `Model/WidgetSnapshotStore.swift` — the app-group JSON drop box (atomic write, tolerant read). Imports no WidgetKit so it is testable from a plain target; callers follow `write` with `WidgetCenter.shared.reloadAllTimelines()`.
- `Model/WidgetHost.swift` — the three per-app differences: app name, app group, tap-route scheme.
- `Model/WidgetSnapshotFixtures.swift` — the six states the design is drawn against, shipped in the library because WidgetKit asks for a placeholder before any data exists.
- `View/UnitAvatar.swift` — the roundrect googly-eye tile and `UnitAvatarFace`, the widget's whole status channel. A **static** port of `SliccAgentAvatarGeometry` / `SliccAgentAvatarView` / `AvatarExpression`: same ratios, same grammar, no integrator. Each phase renders at the pose the app's own reduced-motion `settle` lands on, with the gaze aimed where the engine would have hopped. Parity pinned by `UnitAvatarGeometryTests` against the values the app's `SliccAgentAvatarGeometryTests` asserts.
- `View/UnitCell.swift` — `UnitCell` (avatar + name, nothing else), `UnitGrid` (fixed columns + a stated `+N`), `UnitOverflowStrip`, `InstanceHeader`, `LastMessageView`, `UnavailableView`.
- `View/` — `WidgetPalette` (deliberately tiny: no activity palette, because phase lives in the face), `UnitMarks` (outline cone/scoop marks, used ONLY by the monochrome lock-screen accessories, where `.widgetAccentable()` would flatten a filled tile to a blob), `UnitsWidgetViews` (`UnitRanking`, the shared `FocusAndFieldRow`, the three family layouts, the iOS accessories and the family switch).
- `Widget/UnitsWidget.swift` — `UnitsTimelineProvider` and `unitsWidgetConfiguration(host:families:)`. `Widget` requires an `init()`, so each extension owns its own four-line `Widget` struct and everything else is shared.

## Not Wired

Nothing writes `widget-snapshot.json` yet. Both extension targets compile with `SLICC_WIDGET_DESIGN_FIXTURES`, which makes `UnitsTimelineProvider.currentSnapshot()` fall back to `WidgetSnapshot.fixtureBusy` instead of the empty state. **Drop that flag from both `project.yml` files in the same commit that lands the capture side** — the read path is already the real one. Capture plan and the Developer-portal prerequisites: [`docs/widgets.md`](../../docs/widgets.md).

## Design Rules

- **The face is the status channel.** There is no status word, no model id and no context bar on any system family — each said something the face already says, and three lines of small grey text is what turns a glanceable tile into a form. Tool work squares the eyes, thinking grows brows and looks up and away, an ended turn holds eye contact under a soft lid, idle wanders low and dims, broken is X'd out, booting has no eyes yet. If you cannot tell what a unit is doing from its face, the face is the bug — do not add a label.
- **The tile says WHO, the face says WHAT.** Tile colour is the unit's IDENTITY hue (`WidgetUnit.avatarColorHex`, mirroring the leader's `scoopColor` — cone waffle brown, scoop hashed from its name), never its state, so a scoop wears the same colour here as in the tab strip.
- **Fullness is pupil size.** Never a ring, gauge, badge or number — the app's rule, on the app's `fillToPupilScale` curve. `bandTravelClamp` is what keeps a nearly-full pupil from walking out through the white.
- **Three families, three layouts — never one layout at three scales.** small = four peers in a 2x2 (_who needs me?_); medium = one focus plus a field (_what is the one thing?_); large = the cone-grouped tree (_how is this organised?_). Only large shows ownership, and only large has the height to. `UnitRanking` decides who earns a cell — broken, then busy, then a handed-back turn, then quiet, cones ahead of scoops inside a band, wire order last. Fewer units get BIGGER faces rather than a small avatar marooned in the corner.
- **A dormant unit dims to 55%; `broken` and `awaiting` never do.** Both are idle by the letter of the lifecycle: one is the loudest thing on the tile by intent, the other is the unit holding the ball and waiting on YOU. Receding is the wrong signal for either (`WidgetUnit.isDormant`).
- **A healthy connection says nothing.** `WidgetPalette.connectionColor` returns nil for `.connected`; the pip is for trouble only.
- **Every cap is stated.** `+N` in a grid's last slot, on the strip, and `+N more cones` under the tree. A silently truncated list reads as "that is everything".
- **`now` is a parameter, never `Date()`.** WidgetKit composes a timeline ahead of time; a view that reads the clock renders something the timeline never promised.
- **The brows move inside the crop.** The app lets them overhang the tile because nothing clips an avatar there; a grid cell cannot give 15% slack on every side without shrinking every face to pay for it, so `browRaiseDamping` seats them in the headroom above the socket and `browCenter` clamps their x inside the tile. The differential is what reads as quizzical, and it survives.
- The lock screen is the ONE exception to all of this: `.widgetAccentable()` flattens the avatar to a silhouette, so the accessory families still use an outline mark and a spelled-out status word.

## Build and Test

```bash
cd packages/swift-widgetkit
swift build
swift test
swift run slicc-widget-gallery ./out   # PNG contact sheets of every family x fixture x scheme
npm run lint -w @slicc/swift-widgetkit
```

`slicc-widget-gallery` writes each tile at 4x and one sheet per family x scheme (split by family on purpose — a single all-in-one sheet is tall enough that any viewer scales it down, and a widget reviewed at half size is not reviewed). It is a design tool, not a gate — it asserts nothing. The gate is `WidgetRenderSmokeTests`, which renders every family against every fixture in both schemes: a widget view that traps shows up as a blank grey tile on someone's home screen with no crash report they will ever see, so rendering in CI is the only place that failure mode is cheap.

CI: `swift-widgetkit` job (lint, format, macOS + iOS Simulator build, coverage gate).
