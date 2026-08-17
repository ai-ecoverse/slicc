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

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag, `Slicc*` class. Register via `define(tag, ctor)` at module bottom (self-guards double-registration); add an `HTMLElementTagNameMap` augmentation.
- **No `innerHTML` — build the DOM.** Use `internal/dom.ts` (`h()`, `frag()`, `append()`) + `replaceChildren()`; `h()` children / `textContent` is DOM-escaped. Render lucide glyphs with `iconEl(name, opts)`. Shadow components share one constructable stylesheet: `const SHEET = sheet(STYLE)` module-scope, `this.#root.adoptedStyleSheets = [SHEET]` in ctor (no `<style>` node). Light-DOM hosts keep document `<style>` injection but build the subtree with `h()`. Reference: `src/primitives/slicc-logo.ts`. **Enforced** by `lint:no-innerhtml` on `src/**/*.ts` (stories/tests exempt).
- **NodeNext imports:** relative imports MUST carry `.js` (`./foo.js`), including stories/tests. tsc enforces this.
- **Shadow vs light vs iframe** — shadow DOM for self-contained chips (pill, add-menu, tag, icon-button, logo); light DOM for layout/gesture/slotting hosts (nav, composer, shell, file-tree, press-button); `slicc-dip` stays **iframe-isolated** (webapp `dip.ts` trusted-source boundary — shadow DOM is NOT a security boundary).
- **Theming:** reference prototype tokens (`var(--canvas)`, `--ink`, `--ctx`, `--rainbow`, `--ctl-h`, …); they inherit through shadow roots — don't re-declare. Light default; dark is `body.dark`/`.dark`/`[data-theme="dark"]`. Preserve `::part` hooks on lifted elements exactly.
- **Animation loops must not force reflow.** A `requestAnimationFrame` loop must never read computed style/layout per frame; resolve CSS-derived values once and cache, invalidating on attribute + theme changes. Pattern: `docs/webcomponents-details.md`.
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
