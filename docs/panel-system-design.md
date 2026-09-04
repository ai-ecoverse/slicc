# Panel system — design

Status: **proposed** (design doc, not yet implemented). Supersedes the layout
model described in `docs/layouts.md` once implemented.

## Goal

Every visible piece of SLICC chrome becomes a **panel** — a movable, resizable,
hideable, JSON-describable unit — except one fixed avatar strip. Layouts become
loadable/saveable JSON documents, so a skill can ship a whole app (UI included)
and a user can save and restore arrangements across sessions. The agent can
author brand-new panel types at runtime.

## What is fixed vs. a panel

**Fixed (the only fixed chrome):** a thin strip carrying the user avatar and the
"add panel" menu. Everything else is a panel:

| Panel id                                            | Today                                            |
| --------------------------------------------------- | ------------------------------------------------ |
| `chat`                                              | `<slicc-chatpane>` (already a dock-tree leaf)    |
| `sessions-rail`                                     | `<slicc-freezer>` — currently `position:fixed`   |
| `dock-rail`                                         | `<slicc-dock>` — currently fixed 48px flex child |
| `scoop-switcher`                                    | inside `<slicc-nav>`                             |
| `floatbar`                                          | inside `<slicc-nav>` (npx-live + $/h)            |
| `files` / `term` / `memory` / `monitor` / `browser` | already dock-tree leaves                         |
| `sprinkle:<name>`                                   | already dock-tree leaves                         |
| `sprinkle-tabs`                                     | `<slicc-tab-overlay>`                            |

`<slicc-nav>` stops being a container and becomes just the fixed avatar strip;
the switcher and floatbar become independently placeable panels.

## `SliccPanel` — the common base component

One SLICC-specific base class every panel extends. It owns the contract the
layout engine drives; subclasses own only their content.

```ts
abstract class SliccPanel extends HTMLElement {
  static readonly panelMeta: PanelMeta; // id, title, icon, sizing hints
  get visible(): boolean; // ← show/hide, the core requirement
  set visible(v: boolean);
  get locked(): boolean; // runtime lock (see Locking)
  // lifecycle the engine calls, so a panel can start/stop pollers:
  onPanelShow?(): void;
  onPanelHide?(): void;
  onPanelResize?(rect: DOMRectReadOnly): void;
}

interface PanelMeta {
  id: string;
  title: string;
  icon?: string; // lucide name, VFS path, or inline svg
  minWidth?: number;
  minHeight?: number;
  /** Fixed-size chrome (rails, strips) opt out of fractional sizing. */
  preferredSize?: string; // e.g. "44px", "30%", "3fr"
  /** Docked (takes layout space) vs floating (paints above). See Presentation. */
  presentation?: 'docked' | 'floating';
  /** Edge a floating panel pins to. */
  anchor?: 'top' | 'right' | 'bottom' | 'left' | 'center';
  /** Rendering realm. Built-ins are 'main'; see Trust model. */
  realm?: 'main' | 'sandboxed';
}
```

### Presentation: docked vs floating

Two separate concerns that are easy to conflate:

- **"Collapsed by default"** is about _membership_: a panel simply is not in the
  layout tree until opened. Already how tool panels behave — `layout open files
right` / a dock-rail click places them, collapse removes them. Nothing to do
  with stacking.
- **Presentation** is about _how an open panel occupies space_:
  - `docked` (default) — a real cell in the tree. Takes space, siblings reflow,
    can be drag-split and resized against them.
  - `floating` — painted above the docked panels without reflowing them. For
    glanceable panels (a monitor you check rather than work in) and for narrow
    viewports where docking would crush the chat.

Docked stays the default for the tool panels: a floating terminal covering the
chat you are reading is worse than a docked one, you cannot drag-split against
something that is not in the tree, and those panels only just became real
resizable leaves. `presentation` is per-panel-type (via `panelMeta`) AND
per-placement (a layout override wins), so a `dashboard` layout can dock the
monitor while `focus` floats it.

**A floating panel stacks inside `.wcui-panel-host`, never in `document.body`.**
Its `z-index: 1` orders it against its docked siblings only — the panel host is
a stacking context (H2), so a floating panel can never rise above the trusted
layer and occlude an approval dialog. Regression-tested in
`packages/webcomponents/tests/shell/trusted-layer-stacking.test.ts`.

`<slicc-surface>` (today's `surface-id` + visibility wrapper) is the direct
ancestor of this idea and is absorbed into it — `SliccPanel` is what
`<slicc-surface>` should have been, plus metadata, lifecycle, and a registry
entry.

### Panel registry

A single registry maps `id → { ctor | sandboxed entry, meta }`. Three sources:

1. **Built-ins** — registered at module load, shipped in the bundle.
2. **Sprinkles** — every discovered `.shtml` auto-registers as a panel whose
   body is the existing sandboxed iframe (no change to sprinkle authoring).
3. **Agent-authored** — a `panel.json` manifest + JS module under
   `/workspace/panels/<name>/`, dynamically imported and `define()`d.

The registry is what the "add panel" menu lists and what a layout JSON
references by id. An id in a layout with no registry entry renders as an empty
placeholder rather than failing the whole layout.

## Layout JSON ✅ (implemented)

Schema and resolution: `packages/webcomponents/src/panel/layout-schema.ts`
(DOM-free, so the kernel-worker-side `layout` command can import it).
Rendering: `<slicc-layout>` in `packages/webcomponents/src/panel/slicc-layout.ts`,
built **alongside** `<slicc-dock-tree>` so the shipping shell keeps working until
Phase 3 switches over.

Two behaviors worth knowing, both deliberate:

- **Variants replace a section, they do not deep-merge it.** A variant supplying
  `center` replaces it outright; omitting it keeps the previous value; `center: []`
  /`docks: []` explicitly clears. Deep-merging two recursive split trees has no
  intuitive semantics (what is a 2-child row merged into a 3-child col?), whereas
  "the narrow layout declares its own center" reads obviously. `panels` overrides
  DO merge per id, since those are flat key/value.
- **Unplaced panels are parked, not destroyed.** They stay in the DOM offstage, so
  a panel keeps its scroll position, its live terminal session, its loaded file
  tree across variant switches. Rebuilding would lose all of that.

Docked edges + a flexible recursive center. This shape is chosen over today's
5-zone fr-only tree because rails and strips are **fixed sizes** (44px, 36px)
which fractions cannot express, and because it maps onto native layout
primitives (see iOS below).

```jsonc
{
  "version": 1,
  "id": "my-dashboard",
  "title": "My dashboard",
  "locked": false, // runtime lock; see Locking
  "base": {
    "docks": [
      { "edge": "top", "size": "36px", "panels": ["scoop-switcher", "floatbar"] },
      { "edge": "left", "size": "44px", "panels": ["sessions-rail"] },
      { "edge": "right", "size": "48px", "panels": ["dock-rail"] },
    ],
    "center": {
      "split": "row",
      "sizes": [3, 1],
      "children": [
        { "panel": "chat" },
        {
          "split": "col",
          "sizes": [1, 1],
          "children": [{ "panel": "files" }, { "panel": "term" }],
        },
      ],
    },
  },
  "panels": {
    // per-panel overrides, all optional
    "sessions-rail": { "visible": true, "movable": false, "resizable": false },
    "sprinkle:kpi": { "visible": true },
  },
  "variants": [/* see Responsive */],
}
```

- A panel referenced nowhere in `base`/`variants` is **not mounted** (tool
  panels start closed today — same behavior).
- `sizes` accept `3` (fr), `"30%"`, or `"44px"`; a dock's `size` is normally
  fixed but may be fractional.
- The default SLICC layout is a shipped JSON reproducing today's arrangement,
  so a fresh profile is visually unchanged.

### Responsive: breakpoint variants in one file

One document declares a base arrangement plus keyed overrides. The engine
re-evaluates on resize (and on platform at boot) and applies the first matching
variant, deep-merged over `base`.

```jsonc
"variants": [
  { "when": { "maxWidth": 700 },
    "docks": [{ "edge": "top", "size": "36px", "panels": ["floatbar"] }],
    "panels": { "sessions-rail": { "visible": false },
                "dock-rail":     { "visible": false } },
    "center": { "panel": "chat" } },
  { "when": { "platform": "ios" },
    "center": { "split": "col", "children": [{ "panel": "chat" }] } }
]
```

`when` predicates: `minWidth` / `maxWidth` / `minHeight` / `maxHeight` /
`platform` (`web` | `ios` | `extension` | `electron`) / `orientation`.

**Scope: web only.** `platform` covers `web` / `extension` / `electron`. iOS is
explicitly **out of scope** — `packages/ios-app` is native SwiftUI and cannot
render web components at all, so a shared layout would need a whole native
renderer, which is not being built.

The schema nonetheless stays declarative (edges, order, splits, visibility,
sizes — no CSS strings, no web-only units beyond `px`/`%`/`fr`), because that is
simply the cleaner document format; it happens to leave the door open to a native
interpreter later, but nothing here is designed around that possibility and no
work is planned for it.

Resolution is against the **host element's box**, not the window's, so a layout
nested in a narrow container (extension side panel, Cherry embed) responds to the
space it actually has.

## Locking — two orthogonal layers

These are different mechanisms with different subjects. Neither is a substitute
for the other.

### Layer 1 — runtime lock (restricts the USER)

`locked: true` at document level, or `movable`/`resizable`/`hideable: false` per
panel. A locked panel renders **no** move handle or resize divider at all (not a
disabled one). This is what a Cherry embedder sets so the arrangement it pushed
can't be rearranged by the end user:

```ts
mountSlicc({ layout: { locked: true, base: { … } } });
```

Applied once at boot from the handshake welcome, bypassing persistence
entirely — a pushed layout is never written back to local storage, so it can't
drift. Configurable per-panel so an embedder can allow resizing but forbid
closing, etc.

### Layer 2 — sudo-gated layout files (restricts the AGENT)

Layout documents live on the VFS. Two roots with different protection:

| Path                        | Who can write                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `/etc/slicc/layouts/*.json` | agent write **requires user approval** (sudoers self-protection, like `/etc/sudoers`) |
| `/workspace/layouts/*.json` | freely agent-writable (saved layouts, skill-shipped layouts)                          |

This is the standard sudoers path-matching mechanism, extended with one
hardcoded rule in `matchPath` so a `NOPASSWD` grant cannot override it.

**Consistency note.** SLICC's shipped `/etc/sudoers` has every rule commented
out — the product does not prompt for ordinary agent work (writing sprinkles,
running shell commands). This design keeps that posture: creating panels and
saving layouts to `/workspace/layouts/` prompts for **nothing**. Only the
`/etc/slicc/layouts/` root is gated, matching the existing
"`/etc` is self-protected" invariant.

## Trust model for agent-authored panels

**Agent-authored panels are not gated, scanned, or signed.** They have the same
posture as sprinkles and `.jsh` scripts today: the agent can already write files
and run arbitrary shell commands, so a panel grants it no meaningful new
capability. Adding an approval prompt on top of an ungated shell would be
security theater, and prompting for something as routine as "make me a panel"
would make the feature unusable.

Two things were considered and **rejected as security gates**:

- **Static code scanning** before load. Trivially defeatable in JS
  (`globalThis[atob('bG9jYWxTdG9yYWdl')]`, `new Function(fetchedString)()`,
  benign-then-malicious updates). Worse than useless: it manufactures false
  confidence. Acceptable only as _advisory metadata_ ("this panel touches
  localStorage") — never as a gate.
- **Signing.** Proves provenance, not safety. Useful once panels are
  distributed between users; useless against a malicious-but-authentic author.

**Third-party (user-to-user distributed) panels are a different threat** and are
out of scope. When that ships, the honest answer is a dedicated sandbox origin
(issue #1717's "option C"), not scanning — #1717 already measured and rejected
dropping `allow-same-origin` from the sprinkle iframe, because it breaks
`localStorage`, service-worker inheritance, and same-site `fetch`.

### Realms

Both realms use the same `SliccPanel` base class and API surface; only the
execution context differs.

- `realm: 'main'` (built-ins, and agent-authored by default) — a real custom
  element in the page realm. Needed for chrome: a 44px rail whose popover must
  overflow its bounds, drag-drop across panels, inherited theme tokens.
- `realm: 'sandboxed'` (sprinkles, and anything opting in) — body renders in the
  existing sandboxed iframe with the `slicc.*` bridge.

Iframes are **not** an isolation boundary here, and the plan does not pretend
otherwise. `sprinkle-renderer.ts:575` documents this explicitly: `allow-scripts`
plus `allow-same-origin` together are escapable; the sandbox is "only a speed
bump against ACCIDENTAL misbehavior … the trust model, not this attribute, is
the boundary."

## Hardening (**implemented** — extractable to separate PRs)

Two latent weaknesses that main-realm panels **widen** rather than create. Both
are worth fixing on their own merit and neither introduces a new prompt. Both
have landed ahead of the panel work so the rest of the refactor builds on a
hardened base; each is self-contained and can be lifted into its own PR.

### H1 — approval path must not be defeatable by page JS ✅

`packages/webapp/src/sudo/panel-responder.ts` prompts via `window.confirm`, and
its doc comment states the security property as _"`window.confirm`/
`window.prompt` are not scriptable by the offscreen agent."_ That is true of the
**kernel worker** but false of anything in the **page realm**: page JS can
assign `globalThis.confirm = () => true` and every subsequent sudo prompt
silently self-approves — including the always-gated writes to `/etc/sudoers`,
the one invariant that is supposed to be unbypassable.

This is a soft spot **today** (any main-realm code, including a mis-scoped
sprinkle path, could do it). Main-realm panels make it routinely reachable.

**Implemented.** `panel-responder.ts` now captures the native
`confirm`/`prompt` once at module evaluation (`NATIVE_CONFIRM`/`NATIVE_PROMPT`,
bound to `globalThis` — they are `[[Call]]`-on-window intrinsics that throw
Illegal-invocation if invoked detached) and every call goes through the captured
reference, never the live global. Module init happens during boot, before any
dynamically registered component can run, so a later override is inert. A realm
with no native modal denies rather than allowing, and a missing `prompt` keeps
the narrow suggested pattern instead of widening. The misleading doc comments in
`sudo/index.ts`, `sudo/extension-broker.ts` (deleted in #2276 slice C; its
capture-native-modals concern now lives in `panel-responder.ts` itself), and
`ui/boot/setup-sudo.ts` were corrected to scope the guarantee accurately, and
`docs/approvals.md` gained a "Scope of the unforgeable-gesture guarantee"
section.

Where a stronger channel exists it is still preferred: standalone / Electron /
swift-server raise the dialog from a separate process via `/api/sudo-approve`,
entirely out of reach of page JS.

Tests: `packages/webapp/tests/sudo/panel-responder.test.ts` (fail-closed +
override-resistance) and
`packages/webapp/tests/sudo/panel-responder-native-capture.test.ts` (jsdom, the
only place a _native_ modal exists to capture — proves the captured reference
wins and the hijack is never called).

Residual: code that runs before the module loads, or that patches the captured
function's prototype chain, is still out of scope. This is defense-in-depth, not
a hard boundary.

### H2 — spoof-proof region for fixed chrome and approval overlays ✅

A main-realm panel can render convincing fake SLICC chrome — a fake approval
dialog, a fake "enter your API key" form — and can overlay real chrome. A
sandboxed sprinkle is visually boxed inside its iframe; a main-realm panel is
not. This is the one thing a panel can do that has no equivalent today.

**Implemented** in `packages/webapp/src/ui/wc/trusted-layer.ts`, wired into
`mountWcShell` (so all five floats get it from the single shared boot path).

The mechanism is a **CSS stacking context, not a z-index ceiling** — the initial
sketch above said "clamped `z-index`", which would have been an arms race a panel
always wins by adding a nine. `z-index` only orders siblings _within_ a stacking
context, so instead:

```text
.wcui-frame
  ├─ .wcui-panel-host      ← isolation:isolate ⇒ own stacking context
  │     └─ …every panel…   ← z-index:2147483647 here is clamped to the host
  └─ .wcui-trusted-layer   ← later sibling ⇒ always composites above
```

Once the host is a stacking context its whole subtree composites as one unit and
is ordered against the trusted layer by **sibling order alone**. `isolation:
isolate` is used rather than a `z-index` on the host precisely so the trusted
layer needs no number of its own. `pointer-events:none` on the layer (with
`auto` on its children) lets clicks fall through its empty regions to the panels
beneath.

`mountTrusted()` **throws** rather than falling back to `document.body` when the
layer is absent — a silent fallback would render approval chrome a panel could
occlude, which is the exact case this exists to prevent. `isInTrustedLayer()` is
the single structural predicate defining "trusted", so audits don't rely on
naming convention.

Tests:

- `packages/webapp/tests/ui/wc/trusted-layer.test.ts` (jsdom) — the invariants
  that produce correct stacking: the isolation declaration is present, the layer
  has **no** `z-index`, sibling order is host-then-layer, and `mountTrusted`
  fails loud.
- `packages/webcomponents/tests/shell/trusted-layer-stacking.test.ts` (real
  Chromium, the repo's only browser-mode project) — the outcome itself, via the
  browser's own hit-test: a panel at `z-index: 2147483647` still loses to
  trusted chrome with no `z-index`, including when nested five levels deep. It
  includes a **counter-test** that sets `isolation:auto` and asserts the hostile
  panel then wins, so a refactor dropping the load-bearing declaration can't
  leave the suite green.

Verified in a live browser too: `document.elementFromPoint` at the overlap of a
max-`z-index` panel and trusted chrome returns the trusted element.

Residual: this prevents _visual_ spoofing and occlusion, not DOM access — a
main-realm panel can still reach `document` and mutate the layer's contents.
Guarding that needs realm isolation (#1717 "option C"), not painting order.
Current tenants: none yet (the layer is established but empty) — the fixed avatar
strip moves in during Phase 3, and approval overlays should migrate off
`document.body.append` onto `mountTrusted`.

## Migration

The current dock-tree (`<slicc-dock-tree>`, PR #1784) is the direct ancestor:
its recursive split model, `locked` semantics, `MIN_FRACTION` resize floor,
`setSurfaceSize` math, and the `layout open|close|move|size` command surface all
carry forward. What changes is that the fixed 5 zones become docks + a
recursive center, `<slicc-surface>` grows into `SliccPanel`, and the nav/rails
move inside the layout.

`mountWcShell` is the **single** boot path for every float (standalone,
extension side panel, follower, cherry) — panelizing it changes all of them at
once. That is good for cross-runtime parity and is also the main risk;
`WcShellRefs` is consumed by `wc-live.ts`, `wc-nav.ts`, `wc-sprinkles.ts`,
`wc-tray.ts`, and `wc-browser.ts`, so the refs surface must stay
backward-compatible during migration (keep the named getters, resolve them
through the registry).

Behavioral change to call out: `sessions-rail` (the freezer) is `position: fixed`
today, reserving space via `--rail-w` on `.wcui-appcol`. As a real docked panel
it moves into flow, and its expand/collapse becomes a size change rather than an
overlay + padding transition.
