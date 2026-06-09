# CLAUDE.md — `@slicc/webcomponents`

Standalone library that extracts the UI prototype `proto/StellarRubySwift.html`
into reusable, individually testable web components. **It is not wired into the
webapp yet** — that is a separate, later migration. This pass ends at: components
built → functional (`@vitest/browser`) + visual (Storybook) green → human visual
review.

## Layout

```
src/
  internal/      define() (guarded registration), escapeHtml(), shared helpers
  theme/         tokens.css (prototype token vocabulary), tokens.ts, slicc-theme*
  primitives/    token-only leaves (logo, tag, icon-button, send-button, eyes, …)
  pill/          slicc-pill (shadow DOM, lifted from prototype)
  add-menu/      slicc-add-menu (shadow DOM, lifted from prototype)
  chat/          message/card/dip composites + verbatim pure modules
  composer/ switcher/ workbench/ dock/ freezer/ nav/ shell/ memory/
src/**/<name>.stories.ts   co-located Storybook stories (excluded from dist)
tests/**/<name>.test.ts    co-located browser tests, mirroring src/ subsystem
```

## Conventions (every component MUST follow)

- **Vanilla web components**, no framework. One element per file, `slicc-*` tag,
  `Slicc*` PascalCase class. Build markup with template strings + `innerHTML`
  (prototype style); escape interpolated text with `escapeHtml`.
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

## Build / typecheck

- `npm run build` → `tsc -p tsconfig.build.json` (emits `dist/`, excludes stories).
- `npm run typecheck` → `tsc --noEmit -p tsconfig.json` (src + tests, DOM libs).
- Wired into the root `build`, `typecheck`, and `postinstall` chains before
  `@slicc/webapp`. Coverage floor lives in root `coverage-thresholds.json`
  under `typescript.webcomponents`.
