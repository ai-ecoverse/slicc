# Layouts

Every visible piece of SLICC chrome is a **panel** — movable, resizable,
hideable, and describable in JSON — except one fixed avatar strip. Layouts are
documents you can save, load, ship in a skill, or push into an embed.

Two systems coexist during the migration:

| System                                     | Status                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `<slicc-layout>` + `SliccPanel` (panels)   | current; behind the `panel-layouts` flag        |
| `<slicc-dock-tree>` (five zones, surfaces) | still the default boot; superseded, not removed |

Both are documented here — the dock-tree section is what a default install runs
today. Design rationale and the trust model:
[`panel-system-design.md`](panel-system-design.md).

## Enabling the panel system

The panel system is gated by the **`panel-layouts` feature flag**, which ships
`off`. Three ways to turn it on, in precedence order (see
`packages/webapp/src/core/feature-flags.ts`):

1. **Per browser, by the user** — the flag is `userToggleable`, so it appears as
   "Panel layouts" in the **Experimental features…** dialog off the avatar menu.
   That dialog is itself gated by `experimental-settings`, which the worker sets
   `on` for `standalone` and `off` for `cherry` — so the toggle is visible in a
   normal install and hidden inside an embed.
2. **Per environment, by the worker** — `FEATURE_FLAGS` in the cloudflare-worker's
   `wrangler.jsonc` (both the production and staging blocks). Flipping it there
   needs no release, but takes effect on the next page load: flag hydration is
   read once at boot and has no live refresh.
3. **Bundled default** — `defaultValue: 'off'` in the flag definition.
4. **Per embed, by the host page** — `mountSlicc({ flags: { 'panel-layouts': 'on' } })`.
   The only way to reach this flag from inside a Cherry embed: the "Experimental
   features…" dialog that would otherwise let a user flip it is itself hidden
   there (Cherry sets `experimental-settings: off`). Applied once at boot,
   session-only — never written to the follower's `localStorage` — and gated
   through the exact same `userToggleable`-and-float check a local user
   override must pass, so an embedder can only reach flags this registry
   already marked safe for outside control. See "Cherry: pushing a layout
   into an embed" below.

There is deliberately **no URL parameter**. An earlier `?panels=1` was removed when
the flag landed: two switches for one boolean meant a bookmarked URL could
contradict the user's own setting, with nothing in the UI to explain why.

The gate is uniform across every float, including a Cherry embed that pushes its
own `LayoutDocument` — one answer to "are panels on here". A host pushing a layout
while the flag is off (and not turning it on itself via `flags`) gets the default
shell and a logged warning, not a partial application.

---

## The panel system

### What is fixed vs. a panel

Only the **avatar strip** (top-right: the avatar menu and the add-panel `+`) is
fixed. It renders in the **trusted layer** — a sibling of the panel host that no
panel can paint over (see Trusted layer below). Everything else is a panel:

| Panel id                                            | Wraps                                           |
| --------------------------------------------------- | ----------------------------------------------- |
| `chat`                                              | `<slicc-chatpane>`                              |
| `sessions-rail`                                     | `<slicc-freezer>` (gets `docked` to go in-flow) |
| `dock-rail`                                         | `<slicc-dock>`                                  |
| `scoop-switcher`                                    | `<slicc-scoop-switcher>`                        |
| `floatbar`                                          | `<slicc-floatbar>` (npx-live + $/h)             |
| `files` / `term` / `memory` / `monitor` / `browser` | the tool surfaces                               |
| `sprinkle:<name>`                                   | a discovered `.shtml` sprinkle                  |

### `SliccPanel`

`packages/webcomponents/src/panel/slicc-panel.ts`. The base class every panel
extends; it owns identity, visibility, lock state, and lifecycle, and nothing
about content.

- `panelId` — prefers the `panel-id` attribute, falls back to the subclass's
  static `panelMeta.id`, so one class can back many ids (every sprinkle panel
  shares an implementation).
- `visible` — the inverse of the native `hidden` attribute, so hiding carries a11y
  semantics for free. **Panels default to VISIBLE**, the opposite of the older
  `<slicc-surface>` (hidden until `[active]`): a surface was one of a show-one
  stack, whereas a panel is _placed_ by the layout — if it's in the tree it
  renders.
- `locked` — blocks user rearrangement; a locked panel renders no move handle.
- `presentation` / `anchor` — see Docked vs floating.
- `onPanelShow` / `onPanelHide` / `onPanelResize` — so a panel starts and stops
  its own pollers instead of the host tracking them. The `ResizeObserver` is only
  created when a subclass actually implements `onPanelResize`.

Panels are light-DOM hosts (the repo convention for layout/slotting elements), and
the shared stylesheet keys on a `data-slicc-panel` marker rather than the tag —
one rule set has to cover subclasses whose tags don't exist when the CSS is
written.

`panelMeta` and its pure helpers live in `panel-meta.ts`, importable with **no
DOM** via `@slicc/webcomponents/panel/meta`.

### Panel registry

`panel-registry.ts` (DOM-free, `@slicc/webcomponents/panel/registry`) maps a
layout's panel id to something that can render it. Three sources: `builtin`
(bundled), `sprinkle` (discovered `.shtml`), `agent` (authored at runtime).

A duplicate id **replaces** and returns `false` rather than throwing or being
ignored — every caller is a legitimate re-registration path (HMR, sprinkle
discovery's `resync`, the agent rewriting a panel it just authored). Throwing
would break boot; ignoring would leave a stale implementation live after an edit.

`panelRegistryEvents` fires `panel-registry-change`, so a live add-panel menu
re-renders when VFS-backed discovery lands after first paint.

### Docked vs floating

Two things that are easy to conflate:

- **"Collapsed by default"** is about _membership_: a panel simply isn't in the
  layout until opened. That's how tool panels behave — the dock rail places and
  removes them. Nothing to do with stacking.
- **Presentation** is about _how an open panel occupies space_:
  - `docked` (default) — a real cell: takes space, siblings reflow, can be split
    and resized against them.
  - `floating` — painted above the docked panels without reflowing them. For
    glanceable panels and narrow viewports.

Docked is the default for tool panels: a floating terminal covering the chat
you're reading is worse than a docked one, and you can't split against something
that isn't in the tree. `presentation` is settable per panel type (`panelMeta`)
and per placement (a layout override wins), so one document can dock the monitor
while another floats it.

A floating panel stacks **inside** the panel host with `z-index: 1`, never in
`document.body` — so it can never rise above the trusted layer.

## Layout documents

Schema and resolution: `packages/webcomponents/src/panel/layout-schema.ts`
(DOM-free — the kernel-worker `layout` command imports it).

```jsonc
{
  "version": 1,
  "id": "my-dashboard",
  "title": "My dashboard",
  "locked": false,
  "base": {
    // The FIXED CHROME. Not resizable, not rearrangeable — visible or not.
    "docks": [
      { "edge": "top", "size": "36px", "panels": ["scoop-switcher", "floatbar"] },
      { "edge": "left", "size": "44px", "panels": ["sessions-rail"] },
      { "edge": "right", "size": "48px", "panels": ["dock-rail"] },
    ],
    // The WORKING AREA the docks leave over, as five BorderLayout regions.
    "zones": {
      "top": ["status"],
      "left": ["chat", "files"], // two panels in one zone
      "center": ["term"],
      "right": [],
      "bottom": [],
      "axes": { "left": "row" }, // side by side rather than stacked
      "sizes": { "top": "80px", "left": "40%" }, // center takes the rest
      "locked": ["top"],
    },
    "floating": [{ "panel": "monitor", "anchor": "right", "width": "320px" }],
  },
  "panels": {
    "sessions-rail": { "movable": false, "resizable": false },
    "files": { "visible": false, "size": 2 }, // weight within its zone
  },
  "variants": [{ "when": { "maxWidth": 700 }, "docks": [], "zones": { "center": ["chat"] } }],
}
```

### Two layers: docks, then zones

**Docks** are the fixed chrome pinned to an edge at an exact size: the scoop/budget
strip on top, the sessions rail left, the tool rail right. A zone-only model cannot
express them, because fr fractions have no way to say "44px".

A single edge may carry **several** docks. They stack along that edge's cross axis in
declaration order — a second `top` dock sits _below_ the first, not beside it — and
each keeps its own thickness.

Note what a dock spans: the full width (or height) of the layout, **outside** the
zones. A `top` dock therefore crosses over both rails. A bar that should sit below
the SLICC strip _and_ between the rails belongs in `zones.top`, not in a second
`top` dock — that is the working area, which is exactly what the zones describe.

**Zones** are the working area the docks leave over — five named regions in the sense
of Java's `BorderLayout`:

```text
┌─────────────────────────────────────┐  ← docked strip (scoops, budget)
├──┬───────────────────────────────┬──┤
│  │             TOP               │  │
│  ├─────┬──────────────────┬──────┤  │
│  │LEFT │     CENTER       │RIGHT │  │
│  ├─────┴──────────────────┴──────┤  │
│  │            BOTTOM             │  │
└──┴───────────────────────────────┴──┘
   ↑ sessions rail        tool rail ↑
```

Because the zones live inside what the docks did not take, `top` is **below** the
scoop strip and `left`/`right` are **inboard of** the rails — the chrome and the
zones can never overlap. `center` takes whatever the edge zones leave, so an
arrangement cannot end up with a gap.

**A zone holds any number of panels**, laid out along its `axis` — so two panels can
sit side by side in `left`, or stacked, and the document picks which. Defaults suit
each zone's shape: the wide bands (`top`/`bottom`) run in a row, the tall ones
(`left`/`right`/`center`) stack. Panels within a zone are resizable against each
other; their weights live in `panels[id].size`, since a zone's own `sizes` entry is
its _thickness_ against the other zones — a different axis and a different question.

This replaced a recursive split tree. The tree could express arrangements the zones
cannot, but not ones a user could aim at: rearranging meant picking one of five
positions relative to some particular panel, multiplied by every panel on screen.
Five named zones is the whole vocabulary, however much is open.

Documents saved before the zone model still render — a `center` tree is flattened
into the `center` zone (`zonesFromCenter`), and the first hand-drag migrates the
document rather than refusing to move. Everything lands in the center deliberately:
the tree's geometry has no faithful five-zone equivalent, and inventing one would
silently rearrange a saved layout.

A panel referenced in no zone is **not mounted** — tool panels start closed, as
before, and open into `right`.

### Responsive variants

`variants[]` re-resolve on host resize (rAF-debounced, and skipped entirely when
the matched variant set didn't change, so resizing within a breakpoint doesn't
churn DOM). `when` accepts `minWidth`/`maxWidth`/`minHeight`/`maxHeight`/
`orientation`/`platform` (`web`/`extension`/`electron`); all present predicates
must hold.

Resolution runs against the **host element's box**, not the window's, so a layout
nested in a narrow container (extension side panel, Cherry embed) responds to the
space it actually has.

**Variants replace a section, they do not deep-merge it.** Supplying `center`
replaces it outright; omitting it keeps the previous value; `[]` explicitly
clears. Deep-merging two recursive split trees has no intuitive semantics (what is
a 2-child row merged into a 3-child col?), whereas "the narrow layout declares its
own center" reads obviously. `panels` overrides _do_ merge per id — flat
key/value, unambiguous.

Scope is web only. iOS is out: the follower is native SwiftUI and would need a
whole native renderer.

### Unplaced panels are parked, not destroyed

A panel the current arrangement doesn't place stays in the DOM offstage, so it
keeps its scroll position, live terminal session and loaded file tree across
variant switches. `getPlacedPanelIds()` reports what actually **rendered**, not
merely what the document mentions.

## Saving and loading

| Path                        | Agent writes                                   |
| --------------------------- | ---------------------------------------------- |
| `/workspace/layouts/*.json` | free — the normal path                         |
| `/etc/slicc/layouts/*.json` | require user approval (sudoers self-protected) |

The free path is the default because SLICC doesn't prompt for ordinary agent work
— writing a sprinkle or running a shell command is ungated, so saving a layout
should be too. The protected root is the opt-in exception for arrangements that
shouldn't change without your say-so; it's enforced in `matchPath`
(`shell/sudo/sudoers.ts`) where **no `NOPASSWD` rule can override it**, the same
invariant as `/etc/sudoers`. Reads are never gated, so loading a pinned layout at
boot never prompts.

A **user layout shadows a protected one of the same name**, so you can override a
shipped or pinned layout locally without write access to the protected copy. A
corrupt document is skipped with a warning rather than failing the listing.

A skill ships layouts by writing them into either root — discovery lists both, so
"load an app including its UI" needs no registration step.

Saving persists the **document**, not the resolved arrangement: resolution is
viewport-dependent, so saving the resolved form would freeze whichever breakpoint
happened to be active and discard every other variant.

### From the UI

The panels menu (the `layout-dashboard` button beside the avatar) is the single
surface for all of it — the same menu that adds and removes panels and sprinkles:

- **Save layout as…** prompts for a name and writes
  `/workspace/layouts/<name>.json`. The free root, not the sudo-gated one: this is
  the user saving their own arrangement, which needs no approval.
- Every saved document and shipped preset is listed; clicking one loads it.
- Saved documents carry a hover-revealed delete button. Presets do not — they are
  read-only.

The name is sanitized (`sanitizeLayoutName`) before it becomes a path: it is
lowercased, reduced to `[a-z0-9._-]`, and capped at 64 characters. That is a
security boundary, not tidiness — the name becomes
`/workspace/layouts/<name>.json`, so an unsanitized `../../etc/sudoers` would
escape the layouts directory entirely. A name that reduces to nothing saves nothing
rather than inventing one.

The prompt is the NATIVE `prompt`, captured at module init — the same measure
`sudo/panel-responder.ts` takes. Page-realm code (a sprinkle, an agent-authored
panel) can reassign `globalThis.prompt`, and this names a file that gets written, so
a later reassignment must not be able to intercept it. With no `prompt` available at
all (a worker, a headless run) saving declines rather than guessing a name.

### From the shell

`layout save <name> [--protected]`, `layout load <name>`, `layout delete <name>`,
`layout docs`. See the `layout` command section below.

## Agent-authored panels

A directory under `/workspace/panels/<name>/` with a `panel.json` manifest
(`id`, `title`, optional `icon`/`entry`/`minWidth`/`presentation`/`anchor`).
Discovered at boot; a malformed manifest is skipped with a warning so one typo
doesn't hide the rest.

**Not gated, scanned, or signed** — deliberately. The agent already writes files
and runs shell commands without prompting, so a panel grants it no capability it
lacks; an approval prompt on top of an ungated shell would be theater, and
prompting for "make me a panel" would make the feature unusable. Static analysis
was considered and rejected as a _gate_: it's trivially defeated in JS
(`globalThis[atob(…)]`, `new Function(fetched)`) and manufactures false
confidence. Third-party panels distributed between users are a different threat
and out of scope — that wants a dedicated sandbox origin (issue #1717 option C),
not scanning.

They register as `sandboxed` sources. A main-realm registration is possible (the
CSP permits it) but would place freshly written code beside the tray channel and
stored credentials for no functional gain.

## Locking — two orthogonal layers

Different mechanisms with different subjects; neither substitutes for the other.

**Runtime lock (restricts the USER).** `locked: true` document-wide, or per panel
via `panels: { chat: { locked: true } }`; `movable`/`resizable`/`hideable` give
finer control. A locked panel renders no move handle at all. Inherited _down_ — a
locked dock or split locks its contents, locking one panel never affects a
sibling. This is what a Cherry embedder sets.

**Sudo-gated files (restricts the AGENT).** The `/etc/slicc/layouts/` root above.

## Cherry: pushing a layout into an embed

```ts
mountSlicc({
  flags: { 'panel-layouts': 'on' }, // the panel-layouts flag ships off; push it on for this embed
  layout: {
    version: 1,
    id: 'embed',
    locked: true,
    base: {
      docks: [{ edge: 'top', size: '36px', panels: ['floatbar'] }],
      center: {
        split: 'row',
        sizes: [2, 1],
        children: [{ panel: 'chat' }, { panel: 'sprinkle:progress' }],
      },
    },
  },
});
```

`layout` is serialized into `handshake.welcome.layout` and applied once at boot —
static, like `theme`. The follower accepts **either** shape: a `LayoutDocument` (has
`base`) or the older `DockTreeSpec` (has `zones`), since embedders vendor the SDK
and upgrade on their own schedule.

`flags` is serialized into `handshake.welcome.flags` and applied session-only
(never persisted) before the `panel-layouts` gate is checked — this is how a
pushed `LayoutDocument` can turn the flag on for itself rather than depending on
the target deployment's worker-level `FEATURE_FLAGS`. Only ids the flag registry
marks `userToggleable`-and-allowed for the `cherry` float take effect; anything
else is silently dropped, the same gate a local end-user override must pass. A
vendored SDK too old to send `flags` at all simply doesn't — the field is
additive, so the handshake still completes.

A pushed layout is applied **without a filesystem**, so it can never be persisted
or drifted client-side, and `layout save` inside an embed reports that it needs one
rather than writing the embedder's arrangement into the user's profile. An invalid
document is ignored in favor of the default rather than rendering half-broken.

## Trusted layer (spoof-proofing)

`packages/webapp/src/ui/wc/trusted-layer.ts`. Panels render inside
`.wcui-panel-host`, which establishes a CSS **stacking context**
(`isolation: isolate`); `.wcui-trusted-layer` is a later sibling and therefore
always paints above it, needing no `z-index` of its own.

This is a stacking context rather than a "big z-index" precisely because the latter
is an arms race a panel wins by adding a nine. Inside the host, the largest
`z-index` any descendant can reach is still ordered _within_ that context —
verified in a real browser: a panel at `z-index: 2147483647` loses to trusted
chrome that sets none.

`mountTrusted()` **throws** rather than falling back to `document.body`, because a
silent fallback would render approval chrome a panel could occlude — the exact case
this prevents. It protects against _visual_ spoofing and occlusion, not DOM access;
guarding that needs realm isolation.

## The `layout` shell command

Panel verbs (when the `panel-layouts` flag is on):

| Command                            | Effect                                            |
| ---------------------------------- | ------------------------------------------------- |
| `layout load <name>`               | load a saved document, else a shipped preset      |
| `layout save <name> [--protected]` | persist the current document                      |
| `layout delete <name>`             | remove a saved document (either root)             |
| `layout docs`                      | list saved documents + presets, marking protected |
| `layout panels`                    | list every registered panel, `*` = placed         |
| `layout show <panelId>`            | place / reveal a panel                            |
| `layout hide <panelId>`            | hide a panel                                      |

**There is exactly one shipped document: `default`** — the arrangement SLICC boots
with (chat in `center`, the three locked docks, and a narrow-viewport variant that
drops both rails below 700px). Canned arrangements beyond it are the user's to make
and save, not the app's to guess; `layout save <name>` and the panels menu cover
that, and a skill ships its own layout as a document.

A saved document of the same name SHADOWS the shipped one, so saving your own
`default` overrides the boot arrangement without touching it.

`show`/`hide` edit the **document**, not the element's `hidden` attribute, so the
change survives the next re-render and is saveable.

Dock-tree verbs (`set`/`chat`/`open`/`close`/`move`/`size`/`reset`/`edit`) target
the older engine and are documented in
[`shell-reference.md`](shell-reference.md); against a panel layout they report
which verbs to use instead rather than silently doing nothing.

## The dock-tree (current default)

Still what a default install boots. `<slicc-dock-tree>` is a fixed skeleton of 5
zones (`top`/`left`/`middle`/`right`/`bottom`), each holding a recursive `DockNode`
— a `leaf` (one surface) or a `split` (`row`/`col` with relative `sizes`). A zone
whose node is `null` collapses entirely.

- `setTree(spec | null)` / `getTree()` — full serialization including sizes.
- `placeSurface(surfaceId, zone)` / `removeSurface(surfaceId)`.
- `moveSurfaceToZone(surfaceId, zone)` — detaches then reinserts, bypassing the
  pinned guard `removeSurface` has (needed for `chat`).
- `setSurfaceSize(surfaceId, size)` — px/percent resize of any leaf.
- `beginExternalDrag(surfaceId, pointerId?)` — lets a dock-rail chip drag enter
  the same state machine.
- `setPinned(surfaceIds)` — non-removable leaves (runtime-only, never serialized).

Rendering: every non-chat leaf's tile carries the floating rounded
workbench-pane chrome (`.dock-tree__tile--chrome`: `--canvas` card, 1px `--line`
border, 14px radius, the elevated two-layer shadow, 12px float margin,
`overflow: hidden` clipping full-bleed content to the corners) — the look the
deleted `<slicc-workbench-pane>` → `<slicc-pane elevated>` chain gave right-rail
slide-ins. A tile a render NEWLY placed slides in from the right (0.38s, the
prototype's workbench easing, `prefers-reduced-motion` aware); re-renders with
an unchanged placed set — one per divider-drag pointermove — never replay it,
and closing is instant. The reserved `chat` leaf renders flat/full-bleed over
the shader. The composer's band is full-bleed in the shell: its paint lives on
a `::before` extending right past the column (under the floating pane, which
sits above at z-index 3 along with the rail — `slicc-composer.ts`), so no raw
shader strip shows between the composer and the rail.
After **every** render — the deliberately silent `setTree` restore included —
the tree fires `dock-tree-render` (composed + bubbling,
`detail: { placed: string[] }`), a display-only notification that never drives
persistence. `<slicc-shell>` keys the chatpane's `narrow` state off it: `narrow`
is set exactly while any non-chat leaf is placed, and re-themes the
thread/composer (tight feather, hidden ⏎/⇧⏎ hints) without sizing the column —
the leaf owns width now, so the shell-era `calc(100% - 48px)` / `34%` widths are
gone from `<slicc-chatpane>`.

Drag-drop: every unlocked leaf reveals a `.dock-tree__tile-move` button on hover
over its top-left corner; hovering another tile computes a `DropRegion`
(`n`/`s`/`e`/`w`/`center`) and splits accordingly.

The `tilesMovable` / `tiles-movable` gate is set by the webapp only when
`panel-layouts` resolves on at boot. Default off renders no move button and makes
internal/external drag starts no-op. When enabled, the nearest-edge-or-center-box
region maps `e`/`w` to a `row` split (side-by-side and nestable for more columns),
and `n`/`s` or `center` to a `col` split (stacked). Dropping on an empty zone
placeholder makes the leaf that zone's root; dropping on the dragged tile, a
locked tile, or nowhere valid cancels without an event, and locking always wins.

Dock-tree drag is dormant in the shipped webapp. With `panel-layouts` off,
`tiles-movable` stays off; with it on, `panelize-shell.ts` calls
`shellRow.replaceWith(layout)`, removing the dock-tree, and rearrangement moves to
`.slicc-layout__move`. The machinery remains as the component contract for
embedders/tests and in case panels are reverted.

Resize: every divider is pointer-drag-resizable, clamped to 2% of the dragged
pair's combined weight — the same floor `setSurfaceSize` enforces, so dragging can
reach whatever a command can. Pointer capture is held on the **host**, not the
divider: the divider is rebuilt on every `pointermove`, and a captured element
removed from the DOM implicitly loses capture, which previously left drags stuck
resizing after mouseup.

Persistence: `wireDockTreePersistence` restores from
`localStorage['slicc-dock-tree:default']` (falling back to
`DEFAULT_DOCK_TREE_ON_BOOT`) and persists on `dock-tree-change` /
`dock-tree-resize`.

## Fixed chrome: the rails and the top bar

The two rails and the top bar are **not resizable and never share space**. A rail
is a strip of icons at one intrinsic width; the top bar is a `--barh`-high row.
Stretching either can only produce a broken-looking gap, so their only
configurability is _visible or not_ — hiding one collapses its dock entirely.

Their size is pinned on the PANEL, not left to the dock's `size`. Marking a dock
`locked` only stops a **user** dragging it; a document (a preset, a saved layout, a
Cherry push) could still set `size: '400px'` and widen the icon strip into an empty
band. Pinning makes the width a property of the rail, so no document can get it
wrong. The shipped docks are also `locked` in the default document, so the intent
travels with a saved or pushed layout.

The sessions rail is the exception to a fixed number: it owns its own
collapsed↔expanded width (44px ↔ 260px) and animates between them, so the panel
follows the component rather than overriding it.

## Rearranging and resizing by hand

There is **no edit mode**. Nothing is toggled on first; a panel is always movable
and resizable, so there is no state to enter or leave.

**Move.** Hovering a panel reveals a grip in its top-left corner — no permanent
title bar. Grabbing it shows the **five destinations** as a compass over the working
area: TOP, LEFT, CENTER, RIGHT, BOTTOM. Moving onto one highlights it; releasing puts
the panel in that zone. Dropping onto a zone's _area_ rather than its badge works
too, so a coarse drop is fine.

The compass is positioned from the working area's box, not the layout's, so the
badges sit inside the fixed chrome — where a badge appears is where the panel lands.
The badges are the actual hit targets, so what commits is what was aimed at.

A panel joins a zone that already has panels rather than replacing them, which is how
"two panels on the left" is reached by hand.

**Resize.** Two kinds of seam, both 6px:

| Seam  | Between                                     | Writes                      | Floor          |
| ----- | ------------------------------------------- | --------------------------- | -------------- |
| Panel | adjacent panels in one zone, along its axis | `panels[id].size` (weights) | 2% of the pair |
| Zone  | adjacent zones — the fainter hairline       | `zones.sizes[zone]` (px)    | 48px           |

A ZONE seam drags a zone's thickness against its neighbours. It writes **pixels**,
not a weight, because that is what a zone thickness is here: `sizeToFlex` turns px
into a fixed basis that neither grows nor shrinks, whereas a weight would make an
edge band rubber-band as the window resized — the opposite of what a rail-like zone
wants. Only the edge zone is written; `center` is the remainder by definition and
absorbs the difference.

Its clamp reserves room for **every** other element in the run, not just the
immediate neighbour: a fixed zone reserves its actual width (it will not shrink to
make room) and the flexible one reserves only the floor. Reserving a single floor let
a hard drag crush the center to 0px, because the opposite zone's width and the seams'
own gutters went unaccounted for.

A PANEL seam moves weight between two panels inside one zone. Weights start from
measured geometry, so a zone becomes resizable on the first drag without sizes
authored up front.

A seam is omitted beside an empty zone — it takes no space, so the seam would sit
against nothing and drag a thickness nobody can see — and whenever either neighbour
is locked, since the drag moves space between the two of them.

The move grip is absent in three cases, because there would be nothing for it to do:

| Case                             | Why                                                    |
| -------------------------------- | ------------------------------------------------------ |
| A locked panel or locked zone    | Lock means lock — a disabled button is worse than none |
| A docked panel (rail, top strip) | Fixed chrome: one correct position, one correct size   |
| Under a document-wide `locked`   | What a Cherry embedder sets                            |

### What a gesture writes

Both edit the DOCUMENT and re-render from it, so the result is what `getLayout()`
serializes and what a save round-trips. They edit whichever arrangement the current
environment actually renders — a matched variant, if one supplies the working area,
else `base`. Editing `base` while a narrow variant is on screen would land the change
somewhere invisible and the drag would appear to snap back.

`slicc-layout-change` fires with `reason: 'rearrange'` or `'resize'`. A resize fires
ONCE, on release; the per-frame re-render is silent, since a persisting listener
would otherwise write ~60 times per drag.

Pointer capture for a resize goes on the HOST, not the divider: each frame rebuilds
the divider, and a captured element removed from the DOM loses capture per spec —
which once left a resize stuck to a free-moving mouse because `pointerup` was never
delivered.

### Persistence

`panelize-shell.ts` stores the document under `slicc-panel-layout:default` on those
two reasons only, and restores it on the next boot in place of the boot document.
Other reasons are the layout reacting to something already reproducible from what is
stored — persisting a `viewport` change would freeze a transient breakpoint as if
the user had chosen it. A corrupt or schema-rejected entry falls back to the shipped
default rather than failing the boot.

## Known gaps

- The panel system is behind the `panel-layouts` feature flag, off by default; the
  dock-tree is still the shipping boot. See "Enabling the panel system" above.
- No gesture for moving a panel INTO a dock, or for turning a docked panel into a
  floating one. Documents and the `layout` command express both.
- Panels have no explicit order within a zone beyond append order.
- No per-profile layout storage (`slicc-panel-layout:default`, like
  `DOCK_TREE_STORAGE_KEY`, is single-profile).
