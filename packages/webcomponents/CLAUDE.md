# CLAUDE.md — `@slicc/webcomponents`

Standalone library extracting `proto/StellarRubySwift.html` into reusable, individually testable web components. **Webapp wiring underway**: `?ui=wc` mounts the migration shell from `packages/webapp/src/ui/wc/` (live boots the kernel worker; `&ui-fixture` renders the design-time fixture). Webapp imports the barrel; `ui/press-button.ts` is a shim over `slicc-press-button`. Tested functionally (`@vitest/browser`) + visually (Storybook).

## Layout

```
src/
  internal/      define(), dom.ts (h()/sheet()/frag()), icons.ts (iconEl()), url-state.ts
  theme/         tokens.css (prototype token vocabulary), tokens.ts, slicc-theme*
  primitives/    token-only leaves (logo, tag, icon-button, send-button, eyes, …)
  pill/ add-menu/  shadow-DOM elements lifted verbatim from the prototype
  chat/          message/card/dip composites + verbatim pure modules
  overlay/       slicc-dialog (modal shell) and other viewport overlays
  composer/ switcher/ workbench/ dock/ freezer/ nav/ shell/ memory/ showcase/
src/**/<name>.stories.ts   co-located Storybook stories (excluded from dist)
tests/**/<name>.test.ts    co-located browser tests, mirroring src/ subsystem
```

## Panel system (`src/panel/`)

**`SliccPanel` + `<slicc-layout>` are the layout API going forward**; `slicc-dock-tree` (below) is the shipping default until the `panel-layouts` flag flips. Model, locking, Cherry wire: `docs/layouts.md`; rationale: `docs/panel-system-design.md`; internals: `docs/webcomponents-details.md`.

Non-obvious invariants:

- **`SliccPanel` is light-DOM**; shared stylesheet keys on a `data-slicc-panel` marker (must cover runtime-registered subclasses). **Panels default VISIBLE** (opposite of `<slicc-surface>`).
- **DOM-free subpaths** `@slicc/webcomponents/panel/meta` and `@slicc/webcomponents/internal/html` are safe for webapp + kernel worker; barrel is not (needs `CSSStyleSheet`).
- **Layout schema** — `docks[]` (fixed chrome pinned to an edge at exact size; fr-only zones can't say `"44px"`) + `zones` (five BorderLayout regions, `ZoneName`: top/left/center/right/bottom); variants REPLACE a section, `panels` overrides merge per id.
- **Slot pitfall — overlays + pointer capture live on the HOST, not a slot**: slots rebuild every render; a captured element removed from the DOM loses capture per spec.
- **`<slicc-layout>` parks unplaced panels offstage** (not destroyed), preserving scroll / live terminal session across variant switches. Re-resolves on HOST resize (not window), rAF-debounced. Rebuilds target a stable inner root (replacing the host's own children re-enters its `MutationObserver`).
- Panel stories (`panel/*.stories.ts`) are required for PR screenshots to cover panels.

## Dock-tree (the shipping default)

**`slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`) is what a default install boots** — superseded by the panel system above, not yet removed. Driven by the webapp's `layout` shell command (`docs/shell-reference.md`, `docs/layouts.md`). Light DOM: `<slicc-surface>` children match leaves by identity (`surface-id`/`data-s`/`id`) and are MOVED, not cloned; unmatched park offstage. `slicc-shell` hosts it beside the dock rail. Internals: `docs/webcomponents-details.md`.

Non-obvious rules:

- `CHAT_SURFACE_ID = 'chat'` is reserved; `setPinned([...])` marks leaves runtime-only (never serialized by `getTree()`) so pinned `removeSurface` is a no-op. `moveSurfaceToZone` bypasses the pinned guard (needed for chat).
- `DockTreeSpec.locked`/`DockNode.locked` (inherited) block drag, resize, `removeSurface`; locked leaves render no move button. Cherry uses this — see `packages/webapp/CLAUDE.md`'s Layouts section.
- `tilesMovable`/`tiles-movable` defaults off; flag-on replaces the dock-tree with `<slicc-layout>`. Full `DropRegion` contracts: `docs/layouts.md`.
- Divider resize clamps to 2% of pair's combined weight (floor `setSurfaceSize` enforces). **Pointer capture is held on the host, not the divider**.
- `dock-tree-change`/`dock-tree-resize` (composed + bubbling, `detail: { tree }`) never persist — see `packages/webapp/CLAUDE.md`'s `wireDockTreePersistence`.
- Non-chat tiles carry the rounded workbench-pane chrome (`.dock-tree__tile--chrome`); the reserved chat leaf renders flat. `dock-tree-render` (`detail: { placed }`) fires after EVERY render — the change-silent `setTree` included — and is display-only: `slicc-shell` keys the chatpane's `narrow` re-theming (never its width) off it, and it must never feed persistence.

## File tree + Quick Look (Pierre libraries)

Two components delegate their rendering to [pierre.computer](https://pierre.computer) libraries. Both are wrapped by an adapter that keeps SLICC's existing public contract, so hosts did not change.

- **`slicc-file-tree`** renders through **`@pierre/trees`** (trees.software). The `FileTreeItem` input shape, the `items` / `selected` accessors and the `file-select` / `file-preview` / `file-reference` / `file-download` / `file-overflow` / `dir-toggle` events are unchanged; `gitStatus` is new. Search, inline rename, drag-and-drop, virtualization and git lanes come from the library.
- **`slicc-quick-look`** renders text through **`@pierre/diffs`** (diffs.com), shows a unified diff instead of the file when the caller supplies `baseContent`, and shows a rendered document when the caller supplies `rendered`. The header toggle exposes whichever of Preview / Source / Diff exist.

Non-obvious rules:

- **The library builds hierarchy from PATHS, not from `children` nesting.** A `FileTreeItem` whose `id` is a bare name renders at the root no matter where it sits in the literal — ids must be full paths (which is what `buildVfsTreeItems` produces).
- **Strip the leading slash before handing paths to `@pierre/trees`** (`toTreePath`). A leading `/` becomes an empty first segment: `['/a.ts', '/b.ts']` renders ONE blank row and no files (verified against `1.0.0-beta.6`). Events convert back, so absolute VFS paths stay absolute at the component boundary.
- **`renderRowDecoration` returns text or an icon only** — no interactive elements. That is why the old per-row hover buttons (Preview / Reference / Download) now live in the row context menu, whose `onOpen` re-emits SLICC's `file-overflow` so `SliccOverflowMenu` still draws the menu.
- **Selection echoes.** `selectFile()` reflects to the `selected` attribute, which tells the library to select the row, which calls back through `onSelectionChange` — guard with the `#selecting` flag or one click emits two `file-select` events.
- **Quick Look renders text twice on purpose**: a synchronous `<pre>` first, then the `@pierre/diffs` view once that lazily-imported chunk arrives (~628 KB, so it must never block the overlay). If the import fails the `<pre>` stays — a degraded preview, not a broken one. A `#generation` counter drops an upgrade that resolves after the overlay moved to another file.
- **Quick Look converts nothing.** A `rendered` payload arrives as HTML from the host: `inline` must already be sanitized (the webapp runs markdown through `message-renderer.ts`) and mounts via `createContextualFragment`, the same no-innerHTML path as `setBodyHtml`; `sandbox` mounts in an iframe with an EMPTY `sandbox` attribute (no `allow-scripts`, no `allow-same-origin`) and is the only treatment raw HTML ever gets. That document is wrapped in a base stylesheet (`sandboxDocument`) stating `color-scheme` + `Canvas`/`CanvasText`, because an iframe starts transparent with black text and knows nothing about the app's `data-theme` — an unstyled report rendered near-black on the dark panel. The base goes AFTER any doctype (before it means quirks mode) and BEFORE the file's own markup, so author rules outrank it. Keeping conversion in the host is what keeps a markdown parser out of this library.
- **A rendered form opens FIRST, ahead of the diff.** Someone who clicked a `.md` name meant to read the file; a modified README is still a README. Files without a rendered form keep the old diff-first behavior. Views are rebuilt on switch, never kept mounted in parallel.
- **`@pierre/trees` `sideEffects` is mispathed** in `1.0.0-beta.6` (`./dist/components/web-components.js` vs the real `dist/web-components.js`), so `import '@pierre/trees/web-components'` tree-shakes to nothing. Importing `FileTree` from the package root is unaffected — it pulls the element registration itself.
- **Both libraries are in `optimizeDeps.include`** (`vitest.config.ts`). Discovering them mid-run makes Vite re-optimize and reload; a reload after a custom element is defined leaves the tag bound to the pre-reload class, and every tree/preview test then fails as if the component were broken.
- **Tests assert the contract, not the markup** — accessible row names and events, since the DOM belongs to the library now. Synthetic events need `composed: true` to cross its shadow boundary.

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag, `Slicc*` class. Register via `define(tag, ctor)` at module bottom (self-guards double-registration); add an `HTMLElementTagNameMap` augmentation.
- **No `innerHTML` — build the DOM.** Use `internal/dom.ts` (`h()`, `frag()`, `append()`) + `replaceChildren()`; `h()` children / `textContent` is DOM-escaped. Render lucide glyphs with `iconEl(name, opts)`. Shadow components share one constructable stylesheet: `const SHEET = sheet(STYLE)` module-scope, `this.#root.adoptedStyleSheets = [SHEET]` in ctor (no `<style>` node). Light-DOM hosts keep document `<style>` injection but build the subtree with `h()`. Reference: `src/primitives/slicc-logo.ts`. **Enforced** by `lint:no-innerhtml` on `src/**/*.ts` (stories/tests exempt).
- **NodeNext imports:** relative imports MUST carry `.js` (`./foo.js`), including stories/tests. tsc enforces this.
- **Shadow vs light vs iframe** — shadow DOM for self-contained chips (pill, add-menu, tag, icon-button, logo); light DOM for layout/gesture/slotting hosts (nav, composer, shell, file-tree, press-button); `slicc-dip` stays **iframe-isolated** (webapp `dip.ts` trusted-source boundary — shadow DOM is NOT a security boundary).
- **Slotted subtrees need a document sheet.** `::slotted()` matches only the slot's TOP-LEVEL children — never a `<pre>` / `<table>` nested inside a slotted wrapper. A shadow component that accepts rendered markdown (`slicc-lick-card`) therefore ships its containment rules (`white-space:pre-wrap`, `overflow-wrap:anywhere`, capped tables/images) as an idempotent document `<style>` selected by the host tag, alongside its `adoptedStyleSheets`. Without it an unwrapped `<pre>` bursts the card and scrolls the whole chat column sideways.
- **Theming:** reference prototype tokens (`var(--canvas)`, `--ink`, `--ctx`, `--rainbow`, `--ctl-h`, …); they inherit through shadow roots — don't re-declare. Light default; dark is `body.dark`/`.dark`/`[data-theme="dark"]`. Preserve `::part` hooks on lifted elements exactly.
- **Animation loops must not force reflow — and must carry a frame budget.** A `requestAnimationFrame` loop must never read computed style/layout per frame; resolve CSS-derived values once and cache, invalidating on attribute + theme changes. Decorative/ambient loops render at `AMBIENT_FPS` (15) with an 800 ms full-rate burst on interaction, and stop entirely when the field is static (`src/freezer/frame-budget.ts` is the shared gate; `slicc-shader` is the reference consumer). Never schedule frames with timers — rAF is the only scheduler that pauses when the page hides. Pattern: `docs/webcomponents-details.md`.
- **Public API:** export the class; expose attributes (reflected to properties), `::part` hooks, named slots, `CustomEvent`s (composed + bubbling) — never reach into another component's internals.
- **Agent-avatar expression kit:** `<slicc-agent-avatar activity>` adds shape morph, brows, lids and gaze on top of the four original channels; every channel is a point, scalar or event (SwiftUI-mirrorable), grammar in `switcher/avatar-expression.ts`. No `activity` attribute = the legacy pointer-tracking face; static outranks every channel. Table + constants: `docs/webcomponents-details.md`.
- **Composer push-to-talk:** `<slicc-composer ptt>` owns the hold-to-dictate gesture but not the audio stack — hosts inject a `ComposerSpeech` via `speech` (`composer/speech.ts`, exported DOM-free as `@slicc/webcomponents/composer/speech`). Dictated submits carry `detail.source === 'dictation'`. Contract, stages, whisper upgrade: `docs/webcomponents-details.md`.

## Tests (`@vitest/browser`, real Chromium)

- `tests/<area>/<name>.test.ts`, `globals: true`. Assert registration, attribute↔property reflection, shadow structure, events, lifecycle cleanup, and (via real browser) `getComputedStyle`/geometry. Stub `ResizeObserver`/`IntersectionObserver` only when asserting reflow directly.
- Run: `npm run test -w @slicc/webcomponents` (browser mode via `vitest.config.ts`; needs `npx playwright install chromium`). Kept OUT of root `vitest run` projects so `npm test` stays browser-free.

## Stories (Storybook, `@storybook/web-components-vite`)

- `src/<area>/<name>.stories.ts`. Cover the **state matrix**: variant/state × light/dark × screen size (theme + viewport toolbars). `render` returns a constructed element or HTML string.
- Run: `npm run storybook -w @slicc/webcomponents`; build: `npm run build-storybook`.

## Storybook PR screenshots (visual spot-check)

PRs touching `packages/webcomponents/**` get a sticky comment with light + dark screenshots of **affected** stories at 1280×900, driven by `.github/workflows/storybook-screenshots.yml` (capture + resolver under `packages/dev-tools/tools/`). PNGs upload to R2 bucket `slicc-pr-screenshots`; fork PRs fall back to a workflow artifact. Heuristic, manifest v1, R2 dedupe/retry, secrets/vars: `docs/webcomponents-details.md`.

**Running it locally** (flags are `--flag=value` only; manifest is always `<out>/manifest.json`; empty diff → empty `shots[]` + a "no affected stories" comment):

```bash
npm run build-storybook -w @slicc/webcomponents
git diff --name-only main... > /tmp/changed.txt
npx playwright install chromium   # once
node packages/dev-tools/tools/storybook-affected-screenshots.mjs \
  --changed-files=/tmp/changed.txt \
  --storybook-static=packages/webcomponents/storybook-static \
  --out=/tmp/sb-shots
```

## Build / typecheck

- `npm run build` → `tsc -p tsconfig.build.json` (emits `dist/`, excludes stories).
- `npm run typecheck` → `tsc --noEmit -p tsconfig.json` (src + tests, DOM libs).
- Wired into root `build`, `typecheck`, `postinstall` chains before `@slicc/webapp`. Coverage floor in root `coverage-thresholds.json` under `typescript.webcomponents`.
