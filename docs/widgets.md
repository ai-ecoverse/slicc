# Home-screen widgets

The **Cones & Scoops** widget shows what the agents in the currently connected
SLICC instance are doing: a grid of the four work units that most want your
attention — cones and scoops alike — each as its own agent avatar, with a strip
of everything else underneath.

There is no status word on it, no model id and no progress bar. **The face is
the status.** Multiple cones are coming (the flag already exists), so there is
no single "the" cone to build a layout around; a flat, ranked grid of peers is
what survives that.

One design, two hosts:

|           | iOS (`Sliccy`)                                         | macOS (`Sliccstart`)                           |
| --------- | ------------------------------------------------------ | ---------------------------------------------- |
| Extension | `packages/ios-app/SliccWidgets/`                       | `packages/swift-launcher/SliccstartWidgets/`   |
| Bundle id | `com.sliccy.follower.widgets`                          | `com.slicc.sliccstart.widgets`                 |
| App group | `group.ai.sliccy.follower`                             | `S8LB56P782.com.slicc.sliccstart.fileprovider` |
| Families  | small, medium, large + lock-screen/StandBy accessories | small, medium, large                           |
| Tap       | `slicc://unit?jid=…` (route not wired)                 | opens the app                                  |

Everything drawn lives in `packages/swift-widgetkit`
([CLAUDE.md](../packages/swift-widgetkit/CLAUDE.md)); each extension is the
four lines WidgetKit insists on owning.

## Status: design only, not wired

Nothing writes the snapshot yet. Both extensions build with
`SLICC_WIDGET_DESIGN_FIXTURES` (set in each `project.yml`), which makes
`UnitsTimelineProvider.currentSnapshot()` fall back to
`WidgetSnapshot.fixtureBusy` when the app-group file is absent. The read path
is already the real one.

To review the design without installing anything:

```bash
cd packages/swift-widgetkit
swift run slicc-widget-gallery ./out    # PNG per family x fixture x scheme + two contact sheets
```

## Why a snapshot file

A widget is **not a follower**. It runs in its own short-lived process, cannot
dial a leader, cannot hold a WebRTC data channel, and may run while the app is
dead. So the contract is one-way: the host app captures the smallest honest
description of the instance and writes it into the shared app group; the widget
reads it and says how old it is.

A JSON file, not `UserDefaults`: the snapshot is a document, group-container
`UserDefaults` is a coalescing cache with no ordering guarantee against a
process that is not running, and an atomic file replace gives the widget a read
that is either the old snapshot or the new one and never half of both.

`WidgetSnapshot.schema` versions the shape. A snapshot from a NEWER schema is
rejected outright (`WidgetSnapshotStoreError.futureSchema`) rather than
half-decoded; unknown enum values inside a unit degrade that unit to `unknown`
and leave the rest of the snapshot intact.

## Wiring plan

### iOS

`AppState.handleDataChannelMessage`'s `.scoopsList` case already holds
everything the snapshot needs. The capture side is:

1. On `scoops.list`, on `connectionState` changes, and on disconnect, build a
   `WidgetSnapshot` from `scoops` + `leaderActiveScoopJid` + the tray session
   label, write it through `WidgetHost.follower.store`, then call
   `WidgetCenter.shared.reloadAllTimelines()`.
   The last turn comes from `AppState.messages.last` — flatten its markdown,
   truncate to `WidgetMessage.previewLimit`, and attribute it to the unit whose
   transcript it came from.
2. Debounce it. `scoops.list` arrives on every turn boundary; WidgetKit's
   reload budget is small and a reload per token is how a widget ends up
   frozen at the moment it mattered. Coalesce to at most one write every few
   seconds, and force one on the transitions that matter (broken, turn end).
3. Truncate `WidgetUnit.detail` at the capture site. A scoop's `trigger` can be
   an entire user turn; a home screen is not a place to park a paragraph.
4. `clear()` the store on disconnect-and-forget, so a widget cannot keep naming
   an instance the user has detached from.
5. Drop `SLICC_WIDGET_DESIGN_FIXTURES` from `packages/ios-app/project.yml`.

Freshness while the app is not running is bounded by iOS, not by us: the
widget only changes when something reloads its timeline. The existing APNs
path (#2062) is the obvious lever — a `turn_end` push already wakes the app,
and waking it is what lets it write a snapshot.

### macOS

Sliccstart has no cones or scoops of its own — state is client-side in the
leader tab. It does already know `leaderJoinUrl`, and `SliccTrayVFS` already
opens a tray connection from the File Provider appex, so the honest source is
the same wire: a small tray follower in Sliccstart that consumes `scoops.list`
and writes the snapshot. That is the one piece of genuinely new plumbing in
the whole feature.

Do **not** reach for the local server instead: SLICC is browser-first and the
server is a stateless relay — it does not know what the cones are doing.

## Layout

Three tiles, three shapes, so not one layout at three scales.

**small — _who needs me?_** Four peers in a 2x2, ranked by attention, with the
rest as a strip of faces underneath. A 158pt tile holds four legible faces and
nothing more, so this family says nothing about ownership and stops.

**medium — _what is the one thing, and what else is going on?_** The leading
unit large on the left, up to six more as a 3x2 field on the right. The tile is
338x158 — twice as wide as it is tall — and four equal squares in a row leave a
band of air above and below every one of them; a focus plus a field uses the
full height for the unit that earned it.

**large — _what did it just say?_** Medium's focus and field at a larger size,
and then the ~200pt of extra height goes to the **last turn in the session**,
printed under a rule. Rearranging the same faces into that space only produced
medium at 3x. The sentence is the thing you would have opened the app for.

|                    | small          | medium            | large                         |
| ------------------ | -------------- | ----------------- | ----------------------------- |
| Shape              | 2x2 grid       | focus + 3x2 field | focus + 3x2 field + last turn |
| Face, busiest case | 34pt           | 84 / 38pt         | 104 / 44pt                    |
| Face, one unit     | 64pt           | 100pt             | 125pt                         |
| Caps               | 4 + strip of 5 | 1 + 6             | 1 + 6, message at 5 lines     |

**Which units earn the scarce cells** (`UnitRanking`): broken first (they want a
human), then busy, then a turn handed back to you, then the quiet ones. Cones
outrank scoops inside a band — they are the units you can actually talk to —
and wire order breaks the last tie, so a face does not change cell on every
refresh. Every cap is stated: `+N` in a grid's last slot and on the strip.

**Fewer units get bigger faces.** A session with one cone is the common case on
day one and no family may look broken there, so rather than parking a 34pt
avatar in the corner of a 338pt tile, a lone cone fills it.

### The last turn

`WidgetSnapshot.lastMessage` is text only — no markdown, no attachments, no
tool calls — and the capture side flattens and truncates it to
`WidgetMessage.previewLimit` (280 characters). A widget snapshot is not a
transcript and a home screen is the last place to park one.

It carries its **own** timestamp, separate from `capturedAt`: a snapshot taken
now can hold a turn from an hour ago, and the large tile prints both times a
few points apart. An agent turn wears the face of the unit that said it; a user
turn reads "You" and wears none. A turn from a unit that has since left the
snapshot still prints, attributed to "Agent".

The text is marked **`.privacySensitive()`**, so iOS redacts it on a locked
device. That is the only correct default for arbitrary conversation text
sitting on a home screen — the faces above it stay visible, because a cone's
mood is not a secret and the sentence it just wrote might be.

## The avatar

Every unit is drawn as its **agent avatar** — the roundrect tile with the
googly eyes — and the avatar carries the phase on its own.
`View/UnitAvatar.swift` is a deliberately static port of
`SliccAgentAvatarGeometry` / `SliccAgentAvatarView` / `AvatarExpression` from
`packages/ios-app`, which in turn mirror the web's `<slicc-agent-avatar>`.

The ratios are the same numbers and the expression grammar is the same grammar.
What is gone is the integrator that moves through it: no blink timeline, no
saccade hop, no CoreMotion tilt, no drowse ramp. A widget process gets one
still frame, no sensors and a hard memory budget, and `TimelineView(.animation)`
does not animate there. Each phase renders at the pose the app's own
reduced-motion `settle` would land on, with the gaze aimed at the target the
engine would have hopped to — so a widget avatar is the app's avatar caught
mid-thought, not a second design that happens to look similar.

### Phase, from the icon alone

| state        | face                                                                   |
| ------------ | ---------------------------------------------------------------------- |
| tool running | eyes **square up** — the shape channel, `AvatarExpression.shapeTarget` |
| thinking     | round eyes, **brows up**, looking up and away past your shoulder       |
| your turn    | **eye contact** under the soft arrival lid (`drowseStartLid`)          |
| idle         | eyes wander low, whole tile **dims to 55%**                            |
| broken       | **X'd out** — and never dimmed                                         |
| starting     | **no eyes yet**                                                        |
| no instance  | eyes full of frozen **TV static**                                      |

There is no status word beside any of this on the system families, and that is
the point: four faces beat four labels at 34pt, and the words were repeating
what the eyes already said.

The eyes overhang the tile and are cropped by the roundrect; that is the
avatar's look, not a bug to fix by pulling them inward. The brows are the one
thing that moved: the app lets them overhang because nothing clips an avatar
there, but a grid cell cannot give 15% slack on every side without shrinking
every face to pay for it, so `browRaiseDamping` seats them in the headroom
above the socket. The differential — one brow cocked, one settled — is what
reads as quizzical, and it survives the damping.

Three more rules carry over unchanged:

- **Identity, not activity.** The tile takes the unit's hue from
  `WidgetUnit.avatarColorHex`, mirroring the leader's `scoopColor` — a cone is
  always waffle brown, a scoop is hashed from its name (the hash follows JS
  `charCodeAt(0)`, high surrogate only). A scoop wears the same colour here as
  in the tab strip. Colour is WHO, never what.
- **Fullness is pupil size.** Nothing else — no ring, no gauge, no badge, no
  number, no bar — on the same `fillToPupilScale` curve: flat to 50%, then
  growing to 2.2x by 85%, at which point the pupil fills the socket and the
  face reads as the alarm it is. `bandTravelClamp` is what stops it walking
  out through the white.
- **Lifecycle picks the eye treatment.** `broken` gets X'd-out eyes,
  `initializing` gets none, everything else gets the open face and a pose.

The one widget-only addition: a dormant unit's tile dims to 55%, so a grid of
avatars reads busy-vs-idle before a single face is resolved. `broken` is
excluded — it is idle by the letter of the lifecycle and the loudest thing on
the tile by intent (`WidgetUnit.isDormant`).

### No, the eyes cannot follow the accelerometer

The app's pupils track device tilt through CoreMotion. A widget's cannot, and
this is not a permission we are missing — it is what a widget _is_. The
extension process is not alive while you look at the tile: WidgetKit calls the
timeline provider, renders the views to an image, and tears the process down.
There is no run loop to sample a sensor on, no frame callback, and
`TimelineView(.animation)` does not animate in a widget. iOS 17+ interactivity
is `Button` / `Toggle` bound to an App Intent — a tap, not a stream.

What the gaze channel CAN do is carry meaning per snapshot, since the pose is
chosen at capture time rather than per frame. The phase table above already
spends it (up-and-away, low-wander, eye contact). One idea worth its own
decision: aim every avatar's gaze at whichever unit is broken, so a grid of
faces literally looks at the problem. That is one field on `UnitAvatarFace`
plus the cell's position in the grid, and it costs nothing at runtime.

The one surface where motion is on the table is a **Live Activity** — same
static-render constraint, but it updates on push, so the eyes could shift with
each turn. That is a different feature from a home-screen widget.

Parity with the app is a manual contract, pinned by `UnitAvatarGeometryTests`
against the exact values the app's own `SliccAgentAvatarGeometryTests` asserts
(scoop eyes at x = 8.2625 / 91.7375, cone at 2.75 / 97.25 on a 100pt tile).
Unifying the two means lifting the geometry out of the follower target into
this package — a refactor of shared app code with a coverage-floor consequence
for `ios-app`, so it is a decision of its own rather than a side effect of the
widget.

## Marks

The outline cone and scoop marks in `View/UnitMarks.swift` survive in exactly
one place: the monochrome lock-screen accessories, where `.widgetAccentable()`
flattens a filled tile into a silhouette. That is also the one surface that
still spells the status out in words, for the same reason — up there the face
cannot carry it. They are simplified redraws of
lucide `ice-cream-cone` / `ice-cream-bowl`, authored natively in lucide's
24-unit box with its 2-unit round-capped stroke. `ice-cream-bowl`'s three
overlapping domes smudge below about 24pt, and a widget draws these at 12–20pt
with no hover, no motion and no second glance, so the bowl keeps one dome. The
silhouettes stay distinct where it counts: a triangle below the band is a cone,
a bowl on a foot is a scoop.

If the marks should be pixel-identical to the app's instead, the move is to
lift `SVGPath.swift` and `LucideIcon.swift` out of `packages/ios-app` into
`packages/swift-widgetkit` and re-export them (the `TrayFollowerExports.swift`
pattern). That is a refactor of shared app code with a coverage-floor
consequence for `ios-app` — a deliberate decision, not a widget one.

## Developer Portal prerequisites

Two new App IDs. **The iOS one gates TestFlight**: the widget appex ships
inside the `.ipa`, so `package-and-upload-testflight.sh` soft-skips the entire
upload until `APPLE_WIDGETS_PROVISIONING_PROFILE_BASE64` exists.

### iOS — required before the next TestFlight release

1. <https://developer.apple.com/account> → **Identifiers** → **+** → App IDs →
   App. Description `Slicc Follower Widgets`, Bundle ID **explicit**
   `com.sliccy.follower.widgets`.
2. Capabilities: tick **App Groups** only. Edit it and select the existing
   `group.ai.sliccy.follower` — do **not** create a new group; the widget joins
   the group the app, the share extension and the File Provider already share.
   No push, no iCloud, no associated domains: the widget reads one file.
3. **Profiles** → **+** → Distribution → **App Store Connect**. App ID
   `com.sliccy.follower.widgets`, the same Apple Distribution certificate the
   other three profiles use. Name it exactly
   `Slicc Follower Widgets App Store` (that string is the default in the
   packaging script).
4. Download it, then register the secrets:

   ```bash
   packages/ios-app/scripts/setup-testflight-secrets.sh ^
     --widgets-profile ~/Downloads/Slicc_Follower_Widgets_App_Store.mobileprovision ^
     ...existing flags...
   ```

   That sets `APPLE_WIDGETS_PROVISIONING_PROFILE_BASE64`,
   `APPLE_WIDGETS_PROVISIONING_PROFILE_NAME` and `APPLE_WIDGETS_BUNDLE_ID`.
   The script requires every profile, so pass the other three flags too.

Nothing changes in App Store Connect: a widget extension is not a separate app
and needs no new record.

### macOS — not required to ship, required for a clean install

Sliccstart is Developer ID + notarized, and `com.apple.security.app-sandbox`
plus `com.apple.security.application-groups` are not restricted entitlements —
`sign-and-package.sh` signs the widget appex with them and notarization
accepts it without a profile, exactly as it already does for the File Provider
appex.

Register the App ID anyway when convenient
(**Identifiers** → App IDs → `com.slicc.sliccstart.widgets`, App Groups →
`S8LB56P782.com.slicc.sliccstart.fileprovider`) so the bundle id is claimed
before anyone else's and so a future capability does not require a scramble.

The group name still says `fileprovider`. Renaming it would strand the File
Provider's saved join URL, so the widget joins the existing group and lives
with the name.

## Simulator / local checks

```bash
# iOS: build the app with the widget embedded
cd packages/ios-app && xcodegen generate
xcodebuild build -project SliccFollower.xcodeproj -scheme SliccFollower \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO

# macOS: assemble Sliccstart.app with both appexes staged
cd packages/swift-launcher && npm run build
ls build/Sliccstart.app/Contents/PlugIns/
```

Adding the widget to a simulator home screen is a manual step (long-press →
Edit → Add Widget); `slicc-widget-gallery` covers everything short of that.
