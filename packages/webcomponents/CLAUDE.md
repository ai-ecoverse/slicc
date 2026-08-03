# CLAUDE.md — `@slicc/webcomponents`

Standalone library that extracts the UI prototype `proto/StellarRubySwift.html`
into reusable, individually testable web components. **Webapp wiring is underway**:
`?ui=wc` mounts the migration shell from `packages/webapp/src/ui/wc/` (live mode
boots the kernel worker; `&ui-fixture` renders the design-time fixture). The
webapp imports the package barrel; its legacy `ui/press-button.ts` is now a
re-export shim over this library's `slicc-press-button`. Components remain
individually testable here: functional (`@vitest/browser`) + visual (Storybook).

## Layout

```
src/
  internal/      define() (guarded registration), dom.ts (h()/sheet()/frag()), icons.ts (iconEl()), url-state.ts (per-component URL param sync), shared helpers
  theme/         tokens.css (prototype token vocabulary), tokens.ts, slicc-theme*
  primitives/    token-only leaves (logo, tag, icon-button, send-button, eyes, …)
  pill/          slicc-pill (shadow DOM, lifted from prototype)
  add-menu/      slicc-add-menu (shadow DOM, lifted from prototype)
  chat/          message/card/dip composites + verbatim pure modules
  overlay/       slicc-dialog (modal shell) and other viewport overlays
  composer/ switcher/ workbench/ dock/ freezer/ nav/ shell/ memory/ showcase/
src/**/<name>.stories.ts   co-located Storybook stories (excluded from dist)
tests/**/<name>.test.ts    co-located browser tests, mirroring src/ subsystem
```

## Layout feature APIs

**`slicc-dock-tree` (`src/workbench/slicc-dock-tree.ts`) is the sole layout API**, driven by the webapp's `layout` shell command (see `docs/shell-reference.md`, `docs/layouts.md`). Light DOM, no shadow root: it never owns surface content — `<slicc-surface>` children are matched to tree leaves by identity (`surface-id` → `data-s` → plain `id`) and moved (not cloned) into their leaf's container; unmatched surfaces park offstage. Every panel (chat, the four fixed tool panels, every sprinkle) is composed directly into it as an independent, permanently-mounted leaf — there is no separate "workbench body," grid mode, or chat-placement API on `slicc-shell` anymore; `slicc-shell` (`src/shell/slicc-shell.ts`) is just a flex row hosting the dock-tree beside the dock rail.

- **Model**: a fixed skeleton of 5 zones (`ZoneName`: `top`/`left`/`middle`/`right`/`bottom`), each holding a recursive `DockNode` — either a `leaf` (one surface) or a `split` (`dir: 'row' | 'col'`, children + relative `sizes`). A zone whose node is `null` collapses entirely (no space, no divider) in normal rendering; a private dragging flag reveals collapsed zones as drop-target placeholders for the duration of any drag.
- **API**: `setTree(spec | null)` / `getTree()` (full serialization, including sizes), `getSurfaceIds()`, `placeSurface(surfaceId, zone)` (programmatic placement — no drag; empty zone becomes the leaf, non-empty gets it appended as a `col` split; no-op if already placed), `removeSurface(surfaceId)` (its inverse; no-op if absent), `moveSurfaceToZone(surfaceId, zone)` (detaches-then-reinserts, bypassing the pinned-leaf guard `removeSurface` has — needed for moving `chat`, which is pinned), `setSurfaceSize(surfaceId, size)` (resize a placed leaf to an exact px or percent (0-100) of its current sibling group, on whichever axis it has a lever for — the programmatic counterpart to dragging a divider; every other sibling keeps its own weight; no-op/`false` if unplaced, locked, or the axis has nothing to size against), `beginExternalDrag(surfaceId, pointerId?)` (lets a drag that started outside the component, e.g. a dock-rail launcher chip, enter the same drag state machine as an internal drag).
- **Chat as a movable panel**: `CHAT_SURFACE_ID = 'chat'` is the reserved surfaceId the webapp composes the live `<slicc-chatpane>` into at boot (see `packages/webapp/CLAUDE.md`'s Layouts section). `labelForSurface(surfaceId)` derives a tile's friendly label — `'Chat'` for `CHAT_SURFACE_ID`, otherwise the id with any `sprinkle:` prefix stripped — surfaced as the move button's `title`/`aria-label` (see below), not a visible text bar. `setPinned(surfaceIds: string[])` marks leaves as pinned (runtime-only — never serialized by `getTree()`/persisted); a pinned leaf's `removeSurface` is a no-op (defense-in-depth so chat can never be orphaned even if a caller mis-calls remove) — dragging a pinned leaf still moves it normally.
- **Locking**: `DockTreeSpec.locked` (tree-wide) and `DockNode.locked` (per-leaf or per-split, inherited down to every descendant) block drag, resize, and `removeSurface` for the affected node(s). A locked leaf renders no move button at all — there's nothing to click, matching "cannot drag" literally. Used by embedders (e.g. Cherry) to push a fixed, unmovable arrangement — see `packages/webapp/CLAUDE.md`'s Layouts section.
- **Drag-drop interaction**: every unlocked leaf's tile reveals a `.dock-tree__tile-move` button on hover over its top-left corner (`opacity:0` → `1`, mirrors `slicc-file-tree.ts`'s hover-reveal action-button pattern); dragging it and hovering another tile computes a `DropRegion` (`n`/`s`/`e`/`w`/`center`, nearest-edge-or-center-box) and splits accordingly on drop — `e`/`w` (left/right edge) → `row` split (side-by-side; nest further drops for more columns), `n`/`s` (top/bottom edge) or `center` → `col` split (stacked). Dropping on an empty zone placeholder places the leaf as that zone's root. Dropping on the dragged tile itself, on a locked tile, or nowhere valid, cancels cleanly with no event.
- **Resize**: every skeleton divider (between shown top/center/bottom blocks, and between shown left/middle/right zones) and every in-zone split divider is pointer-drag-resizable, moving `fr` weight (or a split's `sizes`) between adjacent slots, clamped to 2% of the dragged pair's own combined weight — the same floor `setSurfaceSize` enforces. Pointer capture is held on the host element, not the divider (the divider itself gets torn down/rebuilt on every `pointermove`, and a captured element removed from the DOM implicitly loses capture per spec).
- **Events**: `dock-tree-change` (composed + bubbling, `detail: { tree }`) fires after a drag-drop (internal or external), `placeSurface`, or `removeSurface` mutates the tree; `dock-tree-resize` (same shape) fires on divider-drag `pointerup` or a `setSurfaceSize` call that actually changed something. Neither event persists anything itself — see `packages/webapp/CLAUDE.md`'s Layouts section for the webapp's `wireDockTreePersistence` listener.

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag,
  `Slicc*` PascalCase class.
- **No `innerHTML` — build the DOM.** Construct markup with the `internal/dom.ts`
  builder (`h(tag, props, ...children)`, `frag()`, `append()`) and commit it via
  `replaceChildren()`; text passed as `h()` children / `textContent` is escaped by
  the DOM, so there is no injection surface and `escapeHtml` is unnecessary. Render
  lucide glyphs with `iconEl(name, opts)` (a live `<svg>`), never an icon string.
  Shadow components share one constructable stylesheet: `const SHEET = sheet(STYLE)`
  at module scope, `this.#root.adoptedStyleSheets = [SHEET]` in the constructor (no
  `<style>` node). Light-DOM hosts keep their one-time document `<style>` injection
  (`style.textContent = CSS` is fine) but build their subtree with `h()`. See
  `src/primitives/slicc-logo.ts` for the reference shape. This is **enforced**: the
  `lint:no-innerhtml` gate (in `npm run lint` / `lint:ci`) fails on any
  `.innerHTML =` / `.outerHTML =` / `insertAdjacentHTML` in `src/**/*.ts`
  (`*.stories.ts` / `*.test.ts` exempt).
- **Register via `define(tag, ctor)`** from `internal/define.js` at module bottom
  (self-guards double-registration). Add a `HTMLElementTagNameMap` augmentation.
- **NodeNext imports:** relative imports MUST carry the `.js` extension
  (`./foo.js`), including in stories and tests. tsc enforces this.
- **Shadow vs light vs iframe** (per project decision):
  - Shadow DOM for self-contained chips: pill, add-menu, tag, icon-button, logo.
  - Light DOM for layout/gesture/slotting hosts: nav, composer, shell, file-tree,
    press-button (slots app content, app CSS styles it).
  - `slicc-dip` stays **iframe-isolated** (preserve the webapp `dip.ts`
    trusted-source security boundary — shadow DOM is NOT a security boundary).
- **Theming:** reference prototype tokens (`var(--canvas)`, `--ink`, `--ctx`,
  `--rainbow`, `--ctl-h`, …). Tokens are inherited, so they pierce shadow roots —
  do not re-declare them. Light is default; dark is `body.dark` / `.dark` /
  `[data-theme="dark"]`. Components needing per-element dark tweaks add their own
  `.dark &` / `:host(...)` rules. Preserve `::part` hooks on lifted elements
  (`slicc-pill`, `slicc-add-menu`) exactly.
- **Animation loops must not force reflow.** A `requestAnimationFrame` loop must
  never call `getComputedStyle`, append/measure a DOM probe, or otherwise read
  computed style/layout per frame — each one forces a full-document style recalc,
  and the cumulative storm flickers/janks the whole app (regression: `slicc-shader`
  resolved its `tint` + `--ink` uniforms via `getComputedStyle` plus a
  `document.body` color probe ~3×/frame — at 120 Hz that's ~360 style-recalcs/sec).
  Resolve CSS-derived values ONCE and cache them; invalidate on the relevant
  attribute change and on a theme change (a `class` / `data-theme` MutationObserver
  on `<html>`/`<body>` plus a `prefers-color-scheme` listener, torn down in
  `disconnectedCallback`).
- **Public API:** export the class; expose attributes (reflected to properties),
  `::part` hooks, named slots, and `CustomEvent`s (composed + bubbling) — never
  reach into another component's internals.
- **Composer push-to-talk:** `<slicc-composer ptt>` owns the hold-to-dictate
  GESTURE (3s hold-to-enable permission stage, recording overlay with caption
  line + mic picker + engine-status line, append+submit on release) but not the
  audio stack — hosts inject a `ComposerSpeech` controller via the `speech`
  property. The contract + built-in Web Speech fallback live in
  `composer/speech.ts`, also exported as the DOM-free subpath
  `@slicc/webcomponents/composer/speech` (safe for node/worker realms; the
  barrel is not). The webapp injects its whisper-upgradable controller there.
  Dictated submits carry `detail.source === 'dictation'` (via the input card's
  `submit(source?)`) so hosts can speak the reply back to spoken input.

## Tests (`@vitest/browser`, real Chromium)

- `tests/<area>/<name>.test.ts`, `globals: true`. Assert: registration,
  attribute↔property reflection, shadow structure (`el.shadowRoot.querySelector`),
  events, lifecycle cleanup, and — leveraging the real browser — `getComputedStyle`
  / geometry where appearance matters. Stub `ResizeObserver`/`IntersectionObserver`
  only if the component needs them and you assert reflow logic directly.
- Run: `npm run test -w @slicc/webcomponents` (uses `vitest.config.ts`, browser
  mode — needs `npx playwright install chromium`). Kept OUT of the root
  `vitest run` projects so the default `npm test` stays browser-free.

## Stories (Storybook, `@storybook/web-components-vite`)

- `src/<area>/<name>.stories.ts`. Cover the **state matrix**: every variant/state
  × light/dark (theme toolbar) × screen sizes (viewport toolbar). `render`
  returns a constructed element or HTML string.
- Run: `npm run storybook -w @slicc/webcomponents`; build: `npm run build-storybook`.

## Storybook PR screenshots (visual spot-check)

PRs that touch `packages/webcomponents/**` automatically get a sticky comment
with light + dark Storybook screenshots of the **affected** stories. Driven by
`.github/workflows/storybook-screenshots.yml`; the capture script and resolver
live under `packages/dev-tools/tools/` (see that package's `CLAUDE.md`).

**Trigger:** the workflow is event-filtered to `packages/webcomponents/**`, its
screenshot tooling, and the workflow definition on a `pull_request` to `main`.
Unrelated PRs do not start the workflow.

**Affected-story heuristic** (directory-level, intentionally coarse — easy to
reason about, no module-graph plumbing):

- A changed `src/<area>/**/*.stories.ts` selects only the stories declared in
  that file (matched by Storybook's `importPath`).
- Any other changed file under `src/<area>/` selects **all** stories whose
  `importPath` lives under that `<area>`.
- Files outside `packages/webcomponents/src/<area>/` (no area subdir, or
  outside the package) contribute nothing.

Each affected story is screenshotted at the desktop viewport (1280×900) for
both the `light` and `dark` theme globals.

**Hosting:** PNGs are uploaded to the Cloudflare R2 bucket
`slicc-pr-screenshots` under the key `pr-<number>/<head-sha>/<file>.png` and
embedded inline in the comment via the public r2.dev base URL. The bucket has
a 30-day object lifecycle rule (`expire-30d`) so screenshots self-clean.

**Fork PRs / missing secret:** when `CLOUDFLARE_API_TOKEN` is unavailable
(typical for fork PRs) the job degrades to attaching the PNGs as a workflow
artifact and the comment links to the run instead of embedding images. The
artifact upload always runs, R2 or not, and the R2 upload step is
`continue-on-error: true` so a single failed object put still leaves the
artifact + comment intact.

**Manifest** (`<out>/manifest.json`, schema v1, consumed by the workflow's
comment builder):

```json
{
  "version": 1,
  "generatedAt": "<ISO8601>",
  "viewport": { "width": 1280, "height": 900 },
  "shots": [
    {
      "storyId": "pill-pill--cone-open-idle",
      "title": "Pill/Pill",
      "name": "Cone Open Idle",
      "area": "pill",
      "importPath": "./src/pill/slicc-pill.stories.ts",
      "theme": "light",
      "file": "pill-pill--cone-open-idle.light.png",
      "triggeredBy": ["packages/webcomponents/src/pill/slicc-pill.ts"]
    }
  ]
}
```

The schema is **flat**: there is one `shots[]` entry per (story × theme).
Consumers group by `storyId` themselves (no `stories[].screenshots[]`
nesting). The capture script is the source of truth for the schema and the
CLI; the workflow YAML follows.

**Running it locally:**

```bash
npm run build-storybook -w @slicc/webcomponents
# write the diff to a file, one repo-relative path per line:
git diff --name-only main... > /tmp/changed.txt
npx playwright install chromium   # once
node packages/dev-tools/tools/storybook-affected-screenshots.mjs \
  --changed-files=/tmp/changed.txt \
  --storybook-static=packages/webcomponents/storybook-static \
  --out=/tmp/sb-shots
```

Flags are `--flag=value` form only (no `--output`, no `--manifest` — the
manifest is always written to `<out>/manifest.json`). An empty / unrelated
diff produces an empty `shots[]` and the PR comment renders a "no affected
stories" message instead of an empty table.

**Ops note:** the repo needs `CLOUDFLARE_API_TOKEN` (R2 read+write on the
`slicc-pr-screenshots` bucket) as an Actions secret. The account ID, bucket
name, and public base URL have sensible defaults baked into the workflow but
can be overridden via the `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET`, and
`R2_PUBLIC_BASE_URL` repo variables.

## Build / typecheck

- `npm run build` → `tsc -p tsconfig.build.json` (emits `dist/`, excludes stories).
- `npm run typecheck` → `tsc --noEmit -p tsconfig.json` (src + tests, DOM libs).
- Wired into the root `build`, `typecheck`, and `postinstall` chains before
  `@slicc/webapp`. Coverage floor lives in root `coverage-thresholds.json`
  under `typescript.webcomponents`.
