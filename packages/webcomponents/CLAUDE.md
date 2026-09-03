# CLAUDE.md — `@slicc/webcomponents`

Standalone library extracting `proto/StellarRubySwift.html` into reusable, individually testable web components. **Webapp wiring underway**: `?ui=wc` mounts the migration shell from `packages/webapp/src/ui/wc/` (live boots the kernel worker; `&ui-fixture` renders the design-time fixture).

## Layout

```
src/
  internal/      define(), dom.ts (h()/sheet()/frag()), icons.ts (iconEl()), url-state.ts
  theme/         tokens.css (prototype token vocabulary), tokens.ts, slicc-theme*
  primitives/    token-only leaves (logo, tag, icon-button, send-button, eyes, …)
  pill/ add-menu/  shadow-DOM elements lifted verbatim from the prototype
  chat/          message/card/dip composites + verbatim pure modules
  overlay/       slicc-dialog (modal shell) + other viewport overlays
  composer/ switcher/ workbench/ dock/ freezer/ nav/ shell/ memory/ showcase/
```

Co-located `src/**/<name>.stories.ts` (dist-excluded) + `tests/**/<name>.test.ts` (mirrors `src/`). Deep per-subsystem internals: `docs/webcomponents-details.md`.

## Panel system (`src/panel/`)

**`SliccPanel` + `<slicc-layout>` are the layout API going forward**; `slicc-dock-tree` (below) is the shipping default until the `panel-layouts` flag flips. Model, locking, Cherry wire: `docs/layouts.md`; rationale: `docs/panel-system-design.md`. Invariants:

- **`SliccPanel` is light-DOM**; shared stylesheet keys on a `data-slicc-panel` marker (must cover runtime-registered subclasses). **Panels default VISIBLE** (opposite of `<slicc-surface>`). DOM-free subpaths `.../panel/meta` and `.../internal/html` are safe for webapp + kernel worker; the barrel is not (needs `CSSStyleSheet`).
- **Layout schema** — `docks[]` (fixed chrome pinned to an edge at exact size; fr-only zones can't say `"44px"`) + `zones` (five BorderLayout `ZoneName` regions: top/left/center/right/bottom); variants REPLACE a section, `panels` overrides merge per id.
- **Overlays + pointer capture live on the HOST, not a slot** (slots rebuild every render; a removed captured element loses capture). **`<slicc-layout>` parks unplaced panels offstage** (preserving scroll / live terminal), re-resolves on HOST resize (rAF-debounced), rebuilds a stable inner root. `panel/*.stories.ts` are required for PR screenshots to cover panels.

## Dock-tree (the shipping default)

**`slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`) is what a default install boots** — superseded by the panel system above, not yet removed. Driven by the webapp's `layout` shell command (`docs/shell-reference.md`, `docs/layouts.md`). Light DOM: `<slicc-surface>` children match leaves by identity (`surface-id`/`data-s`/`id`) and are MOVED not cloned (unmatched park offstage); `slicc-shell` hosts it beside the dock rail. Model, API, drag-drop, events: `docs/webcomponents-details.md`. Non-obvious rules:

- `CHAT_SURFACE_ID = 'chat'` is reserved; `setPinned([...])` marks leaves runtime-only (never serialized) so pinned `removeSurface` is a no-op, and `moveSurfaceToZone` bypasses the pinned guard (needed for chat). `DockTreeSpec.locked`/`DockNode.locked` (inherited) block drag/resize/`removeSurface` and render no move button (Cherry uses this).
- **Pointer capture is held on the host, not the divider** (resize clamps to 2%). `dock-tree-change`/`-resize`/`-render` (composed + bubbling) never persist — `slicc-shell` keys chatpane `narrow` re-theming off `dock-tree-render`; persistence is the webapp's `wireDockTreePersistence`. Non-chat tiles carry rounded workbench-pane chrome; the reserved chat leaf renders flat.

## File tree + Quick Look (Pierre libraries)

`slicc-file-tree` renders through **`@pierre/trees`** and `slicc-quick-look` through **`@pierre/diffs`**, each wrapped by an adapter preserving SLICC's public contract (input shapes, accessors, events) so hosts stay unchanged. **Read `docs/webcomponents-details.md` before touching either adapter.** Load-bearing gotchas:

- **Hierarchy comes from PATHS, not `children` nesting** — `FileTreeItem` ids must be full paths, **stripped of the leading slash** before `@pierre/trees` (`toTreePath`) or the tree renders one blank row. `selectFile()` echoes back, so guard with `#selecting` or one click emits two `file-select`s.
- **Quick Look converts nothing**: `rendered` HTML must arrive pre-sanitized; `inline` mounts via `createContextualFragment`, `sandbox` in an empty-`sandbox` iframe. A rendered form opens ahead of the diff; text renders twice (`<pre>`, then the lazily-imported `@pierre/diffs` view).
- **`@pierre/trees` `sideEffects` is mispathed** in `1.0.0-beta.6` — import `FileTree` from the package root, not `/web-components`; both libraries must stay in `optimizeDeps.include` or a mid-run Vite reload unbinds the elements.

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag, `Slicc*` class. Register via `define(tag, ctor)` at module bottom (self-guards double-registration) + an `HTMLElementTagNameMap` augmentation. **NodeNext imports** MUST carry `.js`, incl. stories/tests (tsc enforces).
- **No `innerHTML` — build the DOM** with `internal/dom.ts` (`h()`, `frag()`, `append()`) + `replaceChildren()` (`h()` children / `textContent` is DOM-escaped); lucide glyphs via `iconEl(name, opts)`. Shadow components share one module-scope constructable stylesheet (`sheet(STYLE)` → `adoptedStyleSheets`); light-DOM hosts keep document `<style>` injection. Ref `src/primitives/slicc-logo.ts`. **Enforced** by `lint:no-innerhtml` on `src/**/*.ts` (stories/tests exempt).
- **Shadow vs light vs iframe** — shadow DOM for self-contained chips (pill, tag, icon-button, logo); light DOM for layout/gesture/slotting hosts (nav, composer, shell, file-tree); `slicc-dip` stays **iframe-isolated** (trusted-source boundary — shadow DOM is NOT a security boundary).
- **Slotted subtrees + chat prose need containment.** `::slotted()` matches only a slot's TOP-LEVEL children, so a shadow component accepting rendered markdown (`slicc-lick-card`) ships containment as an idempotent document `<style>` keyed to the host tag; chat message bodies carry `overflow-wrap: anywhere` (fenced code opts OUT via `pre code`). Rationale: `docs/webcomponents-details.md`.
- **Animation loops:** a `requestAnimationFrame` loop must never read computed style/layout per frame (cache CSS values once) and must carry a frame budget — ambient `AMBIENT_FPS` (15), an 800 ms full-rate burst on interaction, stopping when static (`src/freezer/frame-budget.ts`; `slicc-shader` reference). Never a timer (only rAF pauses when hidden). Rationale: `docs/webcomponents-details.md`.
- **Public API:** export the class; expose attributes (reflected to properties), `::part` hooks, named slots, `CustomEvent`s (composed + bubbling) — never reach into another component's internals.
- **Theming:** reference prototype tokens (`var(--canvas)`, `--ink`, `--ctx`, `--rainbow`, …); they inherit through shadow roots — don't re-declare. Light default; dark is `body.dark`/`.dark`/`[data-theme="dark"]`.

Four specialized components carry non-obvious host contracts — full tables/rules in `docs/webcomponents-details.md`:

- **Agent-avatar expression kit** (`<slicc-agent-avatar activity>`): shape/brows/lids/gaze over four channels (point/scalar/event; grammar in `switcher/avatar-expression.ts`). No `activity` = legacy pointer-tracking face; static outranks every channel; brows paint OUTSIDE the tile crop, so hosts must not clip the avatar.
- **Monitor meter markers**: a `MonitorVital` `ratio` also takes `markers` (`MonitorMeterMarker[]`), one dot each; `color` is a resolved CSS color the HOST supplies (webapp passes `scoopColor()`). Deep-copied by the `model` getter.
- **Keyboard-mode HUD** (`<slicc-key-hud>`): pins itself to the bottom of the nearest positioned ancestor — the shell makes that `<slicc-chatpane>`, the COLUMN, so it survives a read-only unit hiding the composer band (#2312). A `::after` bleed matches the composer's full-bleed band under an open tool pane (z-index 2, under chrome tiles). `hint` takes a `[x]` cap notation so the host names the keys its live keymap binds; `slicc-composer[keys]` is the band's half (everything but the HUD recedes).
- **Composer push-to-talk** (`<slicc-composer ptt>`): owns the hold-to-dictate gesture, not the audio stack — hosts inject a `ComposerSpeech` via `speech` (DOM-free subpath `.../composer/speech`); dictated submits carry `detail.source === 'dictation'`.

## Tests + Stories

- **Tests** (`@vitest/browser`, real Chromium): `tests/<area>/<name>.test.ts`, `globals: true`. Assert registration, attribute↔property reflection, shadow structure, events, lifecycle cleanup, and (real browser) `getComputedStyle`/geometry; stub `ResizeObserver`/`IntersectionObserver` only when asserting reflow. `npm run test -w @slicc/webcomponents` (needs `npx playwright install chromium`); kept OUT of root `vitest run` so `npm test` stays browser-free.
- **Stories** (Storybook, `@storybook/web-components-vite`): `src/<area>/<name>.stories.ts`, covering the **state matrix** variant/state × light/dark × size. `npm run storybook`, build `npm run build-storybook` (`-w @slicc/webcomponents`).

## Storybook PR screenshots

PRs touching `packages/webcomponents/**` get a sticky comment with light + dark screenshots of **affected** stories at 1280×900 (`.github/workflows/storybook-screenshots.yml`; capture + resolver under `packages/dev-tools/tools/`). PNGs upload to R2 `slicc-pr-screenshots`; fork PRs fall back to a workflow artifact. Heuristic, manifest, dedupe/retry, secrets, local-run recipe: `docs/webcomponents-details.md`.

## Build / typecheck

`npm run build` → `tsc -p tsconfig.build.json` (emits `dist/`, excludes stories); `npm run typecheck` → `tsc --noEmit -p tsconfig.json` (src + tests, DOM libs). Wired into root `build`/`typecheck`/`postinstall` before `@slicc/webapp`; coverage floor in `coverage-thresholds.json` under `typescript.webcomponents`.
