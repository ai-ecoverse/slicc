# Layouts

`<slicc-dock-tree>` (`packages/webcomponents/src/workbench/slicc-dock-tree.ts`) is the **sole layout system**. There is no separate "editor mode," fixed-grid mode, or IDE-panel-dock mode — the dock-tree is always mounted, always full-span, and every panel (chat, the four fixed tool panels, and every sprinkle) is an independent, permanently-composed leaf. Any panel can be dragged, resized, or closed at any time.

## The `layout` shell command

`packages/webapp/src/shell/supplemental-commands/layout-command.ts` (kernel worker, no DOM) is the **agent-facing surface** for arranging panels programmatically — not just the five canned presets. It parses `set|chat|open|close|move|size|list|reset|edit` into a `LayoutApplyMsg` and forwards it to the page over the `layout-apply` panel-RPC op:

- `layout set <name>` — load a named preset's tree wholesale (see Presets below).
- `layout chat <zone>` — move the pinned `chat` leaf to `top`/`left`/`middle`/`right`/`bottom` without touching anything else.
- `layout open <surfaceId> <zone>` — place a surface into a zone alongside whatever's already there (no-op if `surfaceId` is already placed anywhere) — the agent-driven equivalent of clicking a tool's dock icon or dragging a sprinkle in from the rail.
- `layout close <surfaceId>` — remove a surface from wherever it sits (no-op if absent/pinned/locked). Its inverse.
- `layout move <surfaceId> <zone>` — generalizes `layout chat <zone>` to any surface: detaches it from wherever it sits (even pinned) and makes it that zone's sole leaf.
- `layout size <surfaceId> [--width <px|percent>] [--height <px|percent>]` — resize a placed leaf to an exact pixel or percent (0–100) of its current sibling group, on whichever axis(es) that leaf actually has a lever for; a no-op axis (e.g. width on a top/bottom zone root, which always spans full width) is silently ignored. See `setSurfaceSize` below.
- `layout reset` — reload the default (`focus`) preset.
- `layout edit` — friendly alias for `layout set focus` (there's no separate "editor mode" to enter; this exists for muscle-memory from when one did).
- `layout list` — print the preset names and the default.

`surfaceId` accepts `chat`, a tool-panel id (`files`/`term`/`memory`/`monitor`), a full `sprinkle:<name>` id, or a bare sprinkle name — `open`/`close`/`move`/`size` auto-prefix a bare name that isn't `chat`/a tool-panel id to `sprinkle:<name>` (`normalizeSurfaceId` in `layout-command.ts`).

`packages/webapp/src/ui/wc/apply-layout.ts:applyLayout(zone, msg)` is the page-side counterpart: `set`/`reset` call `WcSprinkleZone.applyLayout(tree)` (`wc-sprinkles.ts`), `chat`/`move` call `WcSprinkleZone.moveSurfaceToZone`, `open`/`close` call `placeSurface`/`removeSurface`, `size` calls `setSurfaceSize`.

## Presets

`packages/webapp/src/ui/wc/layout-spec.ts` — `LAYOUT_PRESETS: Record<string, NamedDockTreeSpec>`, each a `{ name, tree: DockTreeSpecLike }`. `focus` is the default (chat alone, `left`, single column — matches the original fixed shell's shape). `split` (chat 50/50), `dashboard` (chat narrow-left, a populated `middle`), `dev` (chat + a `bottom` split of files/terminal), `stage` (chat on the `right`). Presets only declare content for zones they want pre-populated — dropping a second panel into an already-populated zone splits it live, same as any drag-drop arrangement; there's no way to pre-draw an _unpopulated_ multi-panel grid in this model.

## The dock-tree model

`SliccDockTree`'s `DockTreeSpec` is a fixed skeleton of 5 zones (`ZoneName`: `top`/`left`/`middle`/`right`/`bottom`), each holding a recursive `DockNode` — a `leaf` (one surface) or a `split` (`dir: 'row' | 'col'`, children + relative `sizes`). A zone whose node is `null` collapses entirely in normal rendering.

- **`setTree(spec | null)` / `getTree()`** — full serialization, including sizes.
- **`placeSurface(surfaceId, zone)`** — programmatic placement; empty zone becomes the leaf, non-empty gets it appended as a `col` split. No-op if `surfaceId` is already anywhere in the tree.
- **`removeSurface(surfaceId)`** — inverse of `placeSurface`; no-op if absent, if pinned, or if locked.
- **`moveSurfaceToZone(surfaceId, zone)`** — detaches-then-reinserts, bypassing the pinned-leaf guard `removeSurface` has (needed for `chat`, since it's pinned).
- **`setSurfaceSize(surfaceId, size)`** — resize the leaf holding `surfaceId` to an exact width/height, in pixels or as a percent (0–100) of its current sibling group; the agent-facing counterpart to dragging a divider by hand (see `#sizeAxesFor`/`#applyAxisSize` in `slicc-dock-tree.ts`). A leaf inside a `split` sizes against that split's `sizes[]` (width if `dir==='row'`, height if `dir==='col'`); a bare zone-root leaf sizes against the skeleton `colFr`/`rowFr` weights — a center-zone (`left`/`middle`/`right`) root's "height" (there being no per-zone height in the skeleton) maps to `rowFr.center`, the lever shared by the whole center row. Every other sibling in the affected group keeps its own weight, so only the targeted leaf's share changes. No-ops (returns `false`) when `surfaceId` isn't placed, is `locked`, or the axis has nothing to size against (a lone shown block). Fires `dock-tree-resize` when it actually changes something.
- **`beginExternalDrag(surfaceId, pointerId?)`** — lets a drag that started outside the component (a dock-rail launcher chip) enter the same drag state machine as an internal drag.
- **`setPinned(surfaceIds)`** — marks leaves non-removable (runtime-only, never serialized).

## Chat and tool panels are permanent, independent leaves

`wc-shell.ts`'s `mountWcShell` composes every panel directly into the dock-tree at boot — there is no shared "workbench body" or "tools" leaf:

- **Chat**: `CHAT_SURFACE_ID = 'chat'` (exported by `slicc-dock-tree.ts`; redeclared, not imported, in `wc-sprinkles.ts` — see that file for the no-runtime-dependency rationale). The live `<slicc-chatpane>` is composed into a `<slicc-surface surface-id="chat">` leaf at boot, `setPinned(['chat'])` so `removeSurface('chat')` can never orphan it, and `placeSurface('chat', 'left')` as the design-time-preview default (live floats immediately overwrite this via `wireDockTreePersistence`'s restored-or-default tree, so it's a no-op there).
- **Tool panels** (`files`/`term`/`memory`/`monitor`): each is its own `<slicc-surface>`, composed into the tree at boot but **not placed anywhere** — they start closed, exactly like a sprinkle. `WcSprinkleZone.placeSurface`/`removeSurface` themselves fire `onToolPanelActivate`/`onToolPanelDeactivate` for a tool-panel id (starts/stops its poller/lazy-mount, see Workbench activator below) — so a dock-rail click (`wireWcSprinkles`'s `slicc-dock-select` listener calling `zone.placeSurface(DEFAULT_TOOL_ZONE, id)`, `DEFAULT_TOOL_ZONE = 'right'`) and an agent-driven `layout open`/`layout close` (routed through the same zone methods via `apply-layout.ts`) get identical lifecycle — clicking the dock icon isn't a separate code path from the shell command. Clicking the active tool's icon emits `slicc-dock-collapse`, which calls `zone.removeSurface(id)`.
- **Sprinkles**: `WcSprinkleZone.#add` composes a `<slicc-surface surface-id="sprinkle:<name>">` leaf and calls `placeSurface(id, DEFAULT_TREE_ZONE)` (`DEFAULT_TREE_ZONE = 'middle'`) unless a drag or a restored tree already placed it.
- **Browser**: a `<slicc-surface surface-id="browser">` fallback pane is always composed for floats that never wire the full-screen tab-switcher overlay (see `WcShellRefs.overlaySurfaces`); a leader that claims `browser` for its overlay leaves this pane inert but present.

## Workbench activator (independent per-panel lifecycle)

`packages/webapp/src/ui/wc/wc-workbench.ts`'s `createWorkbenchActivator` returns a `WorkbenchActivator { activate(surfaceId), deactivate(surfaceId) }` — since every tool panel is now its own permanently-mounted, independently open/closeable leaf (no more show-one swapping), each panel's poller runs only while THAT panel is open:

- `files` — `activate` starts a 3s VFS refresh poll; `deactivate` stops it.
- `monitor` — `activate` starts a 5s refresh poll; `deactivate` stops it.
- `memory` — refreshes once per `activate`; no poller.
- `term` — mounts the worker-shell terminal once on first `activate` and never tears it down (the session persists regardless of panel visibility, matching the old show-one behavior).

`wc-live.ts` wires `onToolPanelActivate`/`onToolPanelDeactivate` (passed into `wireWcSprinkles`) straight to the activator's `activate`/`deactivate`. `boot.setActivateSurface(activator)` also replays `activate` for every tool panel already placed in the dock-tree at attach time (a restored/persisted tree may already contain tool leaves before the activator exists).

## Locking (Cherry-pushed fixed layouts)

`DockTreeSpec.locked` (tree-wide) and `DockNode.locked` (per-leaf or per-split, inherited DOWN to every descendant — locking a split locks all its children, but locking a leaf never affects siblings) block drag, resize, and `removeSurface` for the affected node(s). Computed by `computeLocked(root, target, treeLocked)` walking from a zone root down to the target, ORing every ancestor's `locked`. A locked leaf renders no move button at all — there's nothing to click, matching "cannot drag" literally. Separate from `setPinned` (which only blocks `removeSurface`, for non-embedding cases like chat) — locking blocks everything.

Used by embedders (e.g. Cherry) to push a fixed, unmovable arrangement into a follower — see `packages/webapp/CLAUDE.md`'s Layouts section and `packages/cherry/CLAUDE.md` for the `mountSlicc({ layout })` wire path.

## Move / drag-drop interaction

Every unlocked leaf's tile reveals a `.dock-tree__tile-move` button on hover over its top-left corner (`opacity:0` → `1`, mirrors `slicc-file-tree.ts`'s hover-reveal action-button pattern, built with `iconEl('grip-vertical', …)` — no visible title bar). Dragging it and hovering another tile computes a `DropRegion` (`n`/`s`/`e`/`w`/`center`) and splits accordingly on drop: `e`/`w` → `row` split (side-by-side), `n`/`s`/`center` → `col` split (stacked). Dropping on an empty zone placeholder places the leaf as that zone's root. Dropping on the dragged tile itself, on a locked tile, or nowhere valid, cancels cleanly with no event.

A `pointerdown` on a dock-rail sprinkle launcher chip (`wireDockExternalDragToTree` in `wc-shell.ts`) arms `beginExternalDrag(surfaceId, pointerId)` instead of click-opening it — a plain click still degrades cleanly since `beginExternalDrag` never calls `preventDefault`/`stopPropagation`.

## Resize

Every skeleton divider (between shown top/center/bottom blocks, and between shown left/middle/right zones) and every in-zone split divider is pointer-drag-resizable, moving `fr` weight (or a split's `sizes`) between adjacent slots, clamped to 2% of the dragged pair's own combined weight (`MIN_FRACTION` in `slicc-dock-tree.ts`) — the same floor `setSurfaceSize` enforces, so dragging by hand can always reach whatever a `layout size --height 2%` call can, and vice versa. A divider adjacent to a locked participant doesn't render.

Pointer capture for a divider drag is held on the dock-tree host element itself, not the divider — the divider gets torn down and rebuilt by `#render()` on every `pointermove`, and a captured element that's removed from the DOM implicitly loses capture (per spec), which would otherwise leave the drag's `pointerup` delivery unreliable and the `window`-level `pointermove` listener stuck firing indefinitely on mouse movement alone, held button or not.

## Persistence

`wireDockTreePersistence(refs, log)` (`wc-live.ts`) is the **sole seed/restore source** for the dock-tree's content: on attach it reads the persisted tree from `localStorage['slicc-dock-tree:default']` (`DOCK_TREE_STORAGE_KEY`; `default` stands in for a real per-profile key until profiles ship) and calls `dockTree.setTree(...)`, falling back to `DEFAULT_DOCK_TREE_ON_BOOT` (a chat leaf in `left`, nothing else — tool panels start closed) on a missing/corrupt value. It then listens for `dock-tree-change` (drag-drop / `placeSurface` / `removeSurface` mutations) and `dock-tree-resize` (divider drags) and persists `detail.tree` on each. `setTree` never itself emits a change event, so restore can never loop back into a persist write. Runs for BOTH floats (standalone and extension) via `attachWcClient`.

## Known gaps (documented follow-ups, not yet wired)

- No dedicated bottom-docked terminal region beyond what a user drags there manually.
- No multi-profile layout storage (`DOCK_TREE_STORAGE_KEY` is single-profile).
