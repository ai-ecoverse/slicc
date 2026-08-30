# CLAUDE.md — `@slicc/webcomponents`

Standalone library extracting `proto/StellarRubySwift.html` into reusable web components. **Webapp wiring underway**: `?ui=wc` mounts the migration shell from `packages/webapp/src/ui/wc/` (live boots the kernel worker; `&ui-fixture` renders the design-time fixture). Webapp imports the barrel; `ui/press-button.ts` is a shim over `slicc-press-button`. Internals: `docs/webcomponents-details.md`.

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

**`SliccPanel` + `<slicc-layout>` are the layout API going forward**; `slicc-dock-tree` is the shipping default until `panel-layouts` flips. Model/locking/Cherry: `docs/layouts.md`; rationale: `docs/panel-system-design.md`.

- Light-DOM; stylesheet keys on `data-slicc-panel`. **Panels default VISIBLE** (opposite of `<slicc-surface>`).
- DOM-free: `@slicc/webcomponents/panel/meta`, `@slicc/webcomponents/internal/html`. Barrel is not (needs `CSSStyleSheet`).
- Schema: `docks[]` (exact-size chrome; fr-only zones can't say `"44px"`) + `zones` (top/left/center/right/bottom). Variants REPLACE a section; `panels` overrides merge per id.
- Overlays + pointer capture on the HOST, not a slot (slots rebuild; capture is lost if the element is removed).
- Unplaced panels park offstage (not destroyed). Re-resolve on HOST resize, rAF-debounced. Rebuild a stable inner root — replacing host children re-enters `MutationObserver`.
- `panel/*.stories.ts` required for PR screenshots.

## Dock-tree (the shipping default)

**`slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`)** is the default boot — superseded, not removed. Driven by webapp `layout` (`docs/shell-reference.md`, `docs/layouts.md`). Light DOM: `<slicc-surface>` children match leaves by identity (`surface-id`/`data-s`/`id`) and are MOVED, not cloned; unmatched park offstage. `slicc-shell` hosts it beside the dock rail.

- `CHAT_SURFACE_ID = 'chat'` reserved. `setPinned([...])` is runtime-only (never in `getTree()`); pinned `removeSurface` is a no-op. `moveSurfaceToZone` bypasses the pinned guard.
- `DockTreeSpec.locked`/`DockNode.locked` (inherited) block drag, resize, `removeSurface`; no move button. Cherry: `packages/webapp/CLAUDE.md` Layouts.
- `tilesMovable`/`tiles-movable` defaults off; flag-on swaps in `<slicc-layout>`. `DropRegion`: `docs/layouts.md`.
- Resize floor: 2% of pair weight (`setSurfaceSize`). **Pointer capture on the host, not the divider**.
- `dock-tree-change`/`dock-tree-resize` (`detail: { tree }`) never persist (`wireDockTreePersistence` in webapp). `dock-tree-render` (`detail: { placed }`) fires after EVERY render including silent `setTree` — display-only (chatpane `narrow` re-theme, never width); never persistence.
- Non-chat tiles: `.dock-tree__tile--chrome`; chat leaf is flat.

## File tree + Quick Look (Pierre libraries)

Adapters keep SLICC's public contract ([pierre.computer](https://pierre.computer)). Rules: `docs/webcomponents-details.md`.

- **`slicc-file-tree`** → `@pierre/trees`. `FileTreeItem`, `items`/`selected`, and `file-select`/`file-preview`/`file-reference`/`file-download`/`file-overflow`/`dir-toggle` unchanged; `gitStatus` is new.
- **`slicc-quick-look`** → `@pierre/diffs`. Diff when `baseContent` is set; rendered document when `rendered` is set.

- Hierarchy from **PATHS**, not `children`. Strip leading `/` (`toTreePath`) or `['/a.ts']` is one blank row. Guard `selectFile()` with `#selecting`.
- Quick Look **converts nothing**. Host sanitizes; `inline` via `createContextualFragment`; `sandbox` iframe with EMPTY `sandbox` (no `allow-scripts`, no `allow-same-origin`). `sandboxDocument` goes AFTER doctype (else quirks mode), BEFORE file markup. Rendered form opens first.
- `@pierre/trees` `sideEffects` mispathed in `1.0.0-beta.6` — import `FileTree` from the package root. Both libs in `optimizeDeps.include` (`vitest.config.ts`). Tests assert contract, not markup (`composed: true`).

## Conventions

- **Vanilla web components.** One element per file, `slicc-*` tag, `Slicc*` class. Register via `define(tag, ctor)` at module bottom (self-guards double-registration); add an `HTMLElementTagNameMap` augmentation.
- **No `innerHTML` — build the DOM.** `internal/dom.ts` (`h()`, `frag()`, `append()`) + `replaceChildren()`. Lucide: `iconEl(name, opts)`. Shadow: `const SHEET = sheet(STYLE)`, `this.#root.adoptedStyleSheets = [SHEET]` in ctor. Light-DOM hosts inject document `<style>` but still build with `h()`. **Enforced** by `lint:no-innerhtml` on `src/**/*.ts` (stories/tests exempt).
- **NodeNext:** relative imports MUST carry `.js` (`./foo.js`), including stories/tests.
- **Shadow vs light vs iframe** — shadow for chips (pill, add-menu, tag, icon-button, logo); light for layout/gesture/slotting hosts (nav, composer, shell, file-tree, press-button); `slicc-dip` stays **iframe-isolated** (webapp `dip.ts` trusted-source boundary — shadow DOM is NOT a security boundary).
- **Slotted subtrees need a document sheet.** `::slotted()` matches only TOP-LEVEL children. Markdown hosts (`slicc-lick-card`) ship containment (`white-space:pre-wrap`, `overflow-wrap:anywhere`, capped tables/images) as an idempotent document `<style>` selected by the host tag.
- **Chat prose must contain unbroken runs.** `slicc-user-message` `.b` and `slicc-agent-message` `.body` use `overflow-wrap: anywhere`. A pasted base64 payload is one token; `max-width` does not contain it. Fenced code opts OUT (`pre code`). Test `scrollWidth` vs `clientWidth` — a box-width assertion proves nothing.
- **Theming:** prototype tokens (`var(--canvas)`, `--ink`, `--ctx`, `--rainbow`, `--ctl-h`, …) inherit through shadow roots — don't re-declare. Light default; dark is `body.dark`/`.dark`/`[data-theme="dark"]`. Preserve `::part` hooks exactly.
- **Animation loops must not force reflow — and must carry a frame budget.** Never read computed style/layout per rAF frame. Ambient: `AMBIENT_FPS` (15) with 800 ms full-rate burst; stop when static (`src/freezer/frame-budget.ts`; `slicc-shader`). Never schedule with timers — only rAF pauses when the page hides.
- **Public API:** class + reflected attributes, `::part`, named slots, composed+bubbling `CustomEvent`s — never another component's internals.
- **Avatar / meters / PTT** — `docs/webcomponents-details.md`. `<slicc-agent-avatar activity>` is SwiftUI-mirrorable (`switcher/avatar-expression.ts`); no `activity` = legacy pointer face; static outranks every channel; brows paint outside the tile (~3 px at 26 px). Meter `markers`: HOST-resolved CSS `color` (`scoopColor()`); dots never focusable. `<slicc-composer ptt>` owns the gesture — inject `ComposerSpeech` via `speech` (`@slicc/webcomponents/composer/speech`); dictated submits `detail.source === 'dictation'`.

## Tests (`@vitest/browser`, real Chromium)

- `tests/<area>/<name>.test.ts`, `globals: true`. Assert registration, attribute↔property reflection, shadow structure, events, lifecycle cleanup, and (via real browser) `getComputedStyle`/geometry. Stub `ResizeObserver`/`IntersectionObserver` only when asserting reflow directly.
- Run: `npm run test -w @slicc/webcomponents` (browser mode via `vitest.config.ts`; needs `npx playwright install chromium`). Kept OUT of root `vitest run` projects so `npm test` stays browser-free.

## Stories (Storybook, `@storybook/web-components-vite`)

- `src/<area>/<name>.stories.ts`. Cover the **state matrix**: variant/state × light/dark × screen size (theme + viewport toolbars). `render` returns a constructed element or HTML string.
- Run: `npm run storybook -w @slicc/webcomponents`; build: `npm run build-storybook`.

## Storybook PR screenshots

PRs touching `packages/webcomponents/**` get light+dark screenshots of **affected** stories at 1280×900 (`.github/workflows/storybook-screenshots.yml`). PNGs → R2 `slicc-pr-screenshots`; forks fall back to a workflow artifact. Heuristic, manifest v1, R2, secrets: `docs/webcomponents-details.md`.

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
