# CLAUDE.md — `@slicc/webcomponents`

Standalone library extracting `proto/StellarRubySwift.html` into reusable, testable web components. **Webapp wiring underway**: `?ui=wc` mounts the migration shell from `packages/webapp/src/ui/wc/` (live boots the kernel worker; `&ui-fixture` renders the design-time fixture). Per-subsystem internals in `docs/webcomponents-details.md`.

## Layout

```
src/
  internal/      define(), dom.ts (h()/sheet()/frag()), icons.ts (iconEl()), url-state.ts
  theme/         tokens.css (prototype vocabulary), tokens.ts, slicc-theme*
  primitives/    token-only leaves (logo, tag, icon-button, send-button, eyes, …)
  pill/ add-menu/  shadow-DOM elements lifted verbatim from the prototype
  chat/          message/card/dip composites + verbatim pure modules
  overlay/       slicc-dialog (modal shell), slicc-secret-dialog + viewport overlays
  composer/ switcher/ workbench/ dock/ freezer/ nav/ shell/ memory/ showcase/
```

Co-located `src/**/<name>.stories.ts` (dist-excluded) + `tests/**/<name>.test.ts` mirror `src/`.

## Panel system (`src/panel/`)

**`SliccPanel` + `<slicc-layout>` are the layout API going forward**; `slicc-dock-tree` (below) is the shipping default until the `panel-layouts` flag flips. Model, locking, Cherry wire: `docs/layouts.md`; rationale: `docs/panel-system-design.md`.

- **`SliccPanel` is light-DOM**; shared stylesheet keys on a `data-slicc-panel` marker (must cover runtime-registered subclasses). **Panels default VISIBLE** (opposite of `<slicc-surface>`). DOM-free subpaths `.../panel/meta` and `.../internal/html` are safe for webapp + kernel worker; the barrel needs `CSSStyleSheet`.
- **Layout schema** — `docks[]` (fixed chrome pinned to an edge at exact size; fr-only zones can't say `"44px"`) + `zones` (five BorderLayout regions top/left/center/right/bottom); variants REPLACE a section, `panels` merge per id.
- **Overlays + pointer capture live on the HOST, not a slot** (slots rebuild every render; a removed captured element loses capture). **`<slicc-layout>` parks unplaced panels offstage** (preserving scroll / live terminal), re-resolves on HOST resize (rAF-debounced).

## Dock-tree (the shipping default)

**`slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`) is what a default install boots** — superseded by the panel system above, not yet removed. Driven by the webapp's `layout` shell command (`docs/shell-reference.md`, `docs/layouts.md`). Light DOM: `<slicc-surface>` children match leaves by identity (`surface-id`/`data-s`/`id`), MOVED not cloned (unmatched park offstage); `slicc-shell` hosts it beside the dock rail. API/drag-drop/events: `docs/webcomponents-details.md`.

- `CHAT_SURFACE_ID = 'chat'` reserved; `setPinned([...])` marks leaves runtime-only (never serialized) so pinned `removeSurface` is a no-op, and `moveSurfaceToZone` bypasses the pinned guard (chat needs this). `DockTreeSpec.locked`/`DockNode.locked` (inherited) block drag/resize/`removeSurface` and render no move button (Cherry).
- **Pointer capture held on the host, not the divider** (resize clamps to 2%). `dock-tree-change`/`-resize`/`-render` (composed + bubbling) never persist — `slicc-shell` keys chatpane `narrow` re-theming off `dock-tree-render`; persistence is the webapp's `wireDockTreePersistence`. Non-chat tiles get rounded chrome; the chat leaf is flat.

## File tree + Quick Look (Pierre libraries)

`slicc-file-tree` wraps **`@pierre/trees`**, `slicc-quick-look` wraps **`@pierre/diffs`**, each adapter preserving SLICC's public contract. **Read `docs/webcomponents-details.md` before touching either adapter.** Gotchas:

- **Hierarchy comes from PATHS, not `children` nesting** — `FileTreeItem` ids must be full paths, **stripped of the leading slash** before `@pierre/trees` (`toTreePath`) or the tree renders one blank row. `selectFile()` echoes back — guard with `#selecting` or one click emits two `file-select`s.
- **Quick Look converts nothing**: `rendered` HTML must arrive pre-sanitized; `inline` mounts via `createContextualFragment`, `sandbox` in an empty-`sandbox` iframe.
- **`@pierre/trees` `sideEffects` is mispathed** (`1.0.0-beta.6`) — import `FileTree` from package root, not `/web-components`; both libs must stay in `optimizeDeps.include` or a mid-run Vite reload unbinds them.

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag, `Slicc*` class. Register via `define(tag, ctor)` at module bottom (self-guards double-registration) + an `HTMLElementTagNameMap` augmentation. **NodeNext imports** MUST carry `.js`.
- **No `innerHTML` — build the DOM** with `internal/dom.ts` (`h()`, `frag()`, `append()`) + `replaceChildren()` (`h()` children / `textContent` are DOM-escaped); lucide glyphs via `iconEl(name, opts)`. Shadow components share one module-scope constructable stylesheet (`sheet(STYLE)` → `adoptedStyleSheets`); light-DOM hosts inject a document `<style>`. **Enforced** by `lint:no-innerhtml`.
- **Shadow vs light vs iframe** — shadow DOM for self-contained chips (pill, tag, icon-button, logo); light DOM for layout/gesture/slotting hosts (nav, composer, shell, file-tree); `slicc-dip` stays **iframe-isolated** (trusted-source boundary — shadow DOM is NOT security).
- **Public API:** export the class; expose attributes (reflected to properties), `::part` hooks, named slots, `CustomEvent`s (composed + bubbling) — never reach into another component's internals.
- **Slotted subtrees + chat prose need containment.** `::slotted()` matches only a slot's TOP-LEVEL children, so a shadow component accepting rendered markdown (`slicc-lick-card`) ships containment as an idempotent document `<style>` keyed to the host tag; chat bodies carry `overflow-wrap: anywhere` (fenced code opts OUT via `pre code`). The same chrome caps **markdown media** (`.msg__media`/`.msg__media-gallery`) at column width; the webapp renderer stamps those classes and the names are the contract (`webcomponents` must not import `webapp`; enforced by `scanWebcomponentsWebappEscapes`).
- **Animation loops:** a `requestAnimationFrame` loop must never read computed style/layout per frame (cache CSS once) and must carry a frame budget — ambient `AMBIENT_FPS` (15) with an interaction burst, stopping when static (`src/freezer/frame-budget.ts`). Never a timer (only rAF pauses when hidden).
- **Theming:** reference prototype tokens (`var(--canvas)`, `--ink`, `--ctx`, `--rainbow`, …); they inherit through shadow roots — don't re-declare. Light default; dark via `body.dark`/`.dark`/`[data-theme="dark"]`.

Six specialized components carry non-obvious host contracts — full tables/rules in `docs/webcomponents-details.md`:

- **Agent-avatar kit** (`<slicc-agent-avatar activity>`): shape/brows/lids/gaze over four channels (grammar in `switcher/avatar-expression.ts`). No `activity` = legacy pointer-tracking face; static outranks every channel; brows paint OUTSIDE the tile crop — don't clip it.
- **Budget-mode cost surfaces** (`primitives/budget-usage.ts`): a provider on a rolling allowance headlines percent **USED** (never remaining) on `<slicc-floatbar>` (`budget-*` attrs / `budget` prop) and `<slicc-cost-overlay>` (`budget` prop); `resets` copy is HOST-formatted (no clock in the component), the bar clamps but the figure does not, and `rate-limited` is critical whatever the percent says. No budget → today's `$` headline, untouched.
- **Monitor meter markers**: a `MonitorVital` `ratio` also takes `markers` (`MonitorMeterMarker[]`), one dot each; `color` is a resolved CSS color the HOST supplies (webapp passes `scoopColor()`), deep-copied by `model`.
- **Keyboard-mode HUD** (`<slicc-key-hud>`): pins to the bottom of the nearest positioned ancestor — the shell makes that `<slicc-chatpane>` (the COLUMN) so it survives a read-only unit hiding the composer band. A `.slicc-shell` `::after` bleed matches the composer's full-bleed band under an open tool pane (panel-layouts skip it). `hint` uses `[x]` cap notation for keys.
- **Keyboard-mode key caps** (`<slicc-keycap>`): floats a key legend on a control, `aria-hidden` + `pointer-events: none`, self-gated to `(pointer: fine)`. Hover PRESSES the cap, watched on the anchor (the cap can't see its own `:hover`); a host that can't nest it floats over a measured ghost with `anchor` on the control.
- **Composer push-to-talk** (`<slicc-composer ptt>`): owns the hold-to-dictate gesture, not the audio stack — hosts inject a `ComposerSpeech` via `speech` (DOM-free `.../composer/speech`); dictated submits carry `detail.source === 'dictation'`.

## Tests + Stories

- **Tests** (`@vitest/browser`, real Chromium): `tests/<area>/<name>.test.ts`, `globals: true`. Assert registration, attribute↔property reflection, shadow structure, events, lifecycle cleanup, and `getComputedStyle`/geometry; stub `ResizeObserver`/`IntersectionObserver` only when asserting reflow. `npm run test -w @slicc/webcomponents` (needs `npx playwright install chromium`); kept OUT of root `vitest run` so `npm test` is browser-free.
- **Stories** (`@storybook/web-components-vite`): `src/<area>/<name>.stories.ts`, the **state matrix** variant/state × light/dark × size. `npm run storybook`; `npm run build-storybook` (`-w @slicc/webcomponents`).
- **PR screenshots** — PRs touching `packages/webcomponents/**` get a sticky comment with light + dark shots of **affected** stories at 1280×900 (`.github/workflows/storybook-screenshots.yml`; capture + resolver under `packages/dev-tools/tools/`). PNGs upload to R2 `slicc-pr-screenshots`; fork PRs fall back to an artifact. Full recipe: `docs/webcomponents-details.md`.

## Build / typecheck

`npm run build` → `tsc -p tsconfig.build.json` (emits `dist/`, excludes stories); `npm run typecheck` → `tsc --noEmit -p tsconfig.json` (src + tests). Wired into root `build`/`typecheck`/`postinstall` before `@slicc/webapp`; coverage floor: `coverage-thresholds.json` (`typescript.webcomponents`).
