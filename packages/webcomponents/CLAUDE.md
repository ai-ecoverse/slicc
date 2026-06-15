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
- **Public API:** export the class; expose attributes (reflected to properties),
  `::part` hooks, named slots, and `CustomEvent`s (composed + bubbling) — never
  reach into another component's internals.
- **Composer push-to-talk:** `<slicc-composer ptt>` owns the hold-to-dictate
  GESTURE (5s hold-to-enable permission stage, recording overlay with caption
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

**Trigger:** any path under `packages/webcomponents/**` on a `pull_request` to
`main` (`dorny/paths-filter` `webcomponents` flag). PRs that don't touch the
package don't run the job.

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
