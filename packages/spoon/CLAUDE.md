# CLAUDE.md — `@ai-ecoverse/spoon`

The **injection web component** package. Self-contained home of the
`<slicc-launcher>` overlay element, its pure state helpers, and the
inject/remove glue. Extracted so the one artifact every runtime embeds — the
overlay bootstrap IIFE — has a small, isolated source graph: a change here (and
only here) re-triggers the slow macOS `swift-launcher` CI job, while 99% of
webapp UI changes skip it.

## New Opt-In Capabilities

The launcher now supports three OPT-IN, backward-compatible modes for on-demand
per-page cherry sidebar use:

### 1. Open-on-mount

Setting the `open` attribute before `connectedCallback` makes the sidebar render
open immediately (no click required). The existing reflected `open` attribute
already gates the CSS; this ensures a pre-set `open` isn't cleared on connect.

### 2. `slicc-launcher-close` Event

A `CustomEvent` (`bubbles:true, composed:true`, no detail) fired when the user
closes the sidebar via the close affordance (backdrop click or the new
`requestClose()` method). Consumers whose default is teardown/removal listen for
this. Legacy consumers that want collapse-to-button simply don't listen.

### 3. Managed-iframe Mode

A `managed` boolean attribute/property. In managed mode:

- `#syncIframe()` does NOT set `iframe.src` from `app-url`
- The iframe is revealed and the `.empty` placeholder is hidden (so the
  externally-driven iframe isn't covered)
- A public `get managedIframe(): HTMLIFrameElement` getter exposes the internal
  iframe so an external caller (`mountSlicc({ iframe })`) can drive it

**Critical: spoon imports NOTHING from `@ai-ecoverse/cherry`.** The
spoon↔cherry wiring lives in the extension entry (a later task), not here.

## Why this package exists

Four runtimes consume the launcher, so it can't live inside the large
`@slicc/webcomponents` graph without dragging unrelated UI changes into the
swift trigger path:

- **webapp** — `src/ui/slicc-launcher-inject.ts` re-exports spoon; vite serves
  spoon's `overlay-entry.ts` at `/electron-overlay-entry.js`.
- **chrome-extension** — `content-script.ts` imports `SliccLauncher` from spoon.
- **node-server** — reads the built `dist/ui/electron-overlay-entry.js` IIFE
  (`getElectronOverlayEntryDistPath`) and injects it via CDP / Electron.
- **swift-server / swift-launcher** — `assemble-app.mjs` copies the built IIFE
  into the `.app`; `ElectronLauncher.swift` reads it at runtime.
- **webcomponents** — re-exports `SliccLauncher` + launcher-state from spoon
  (barrel + `register.ts`) so `?ui=wc` and existing consumers keep working.

**Zero dependency on `@slicc/webcomponents`** — that's the whole point. Spoon
carries its own minimal `internal/define.ts` + `internal/dom.ts` (`h`/`sheet`)
copies so its source graph is exactly the launcher + glue.

## Layout

```
src/
  slicc-launcher.ts     # the <slicc-launcher> custom element (shadow DOM)
  slicc-launcher.stories.ts
  launcher-state.ts     # pure corner/snap/follower-status helpers (DOM-free)
  inject.ts             # injectSliccLauncher / removeSliccLauncher glue
  overlay-entry.ts      # IIFE entry → window.__SLICC_ELECTRON_OVERLAY__
  index.ts              # public barrel (registers the element on import)
  internal/define.ts    # guarded customElements registration
  internal/dom.ts       # h() / sheet() / frag() — no innerHTML
  css.d.ts              # *.svg?raw module declaration
tests/slicc-launcher.test.ts   # @vitest/browser (real Chromium)
build.mjs               # esbuild IIFE → <repoRoot>/dist/ui/electron-overlay-entry.js
```

## Conventions

- **No `innerHTML`** — build the DOM with `internal/dom.ts` (`h`/`sheet`);
  SVG logos are imported `?raw` and parsed via `DOMParser`. Matches the
  `@slicc/webcomponents` rule.
- **Register via `define(tag, ctor)`** at module bottom (self-guards double
  registration; no-ops in registry-less MV3 ISOLATED worlds).
- **NodeNext imports** carry the `.js` extension.
- The `window.__SLICC_ELECTRON_OVERLAY__` `{ inject, remove }` API surface is a
  stable contract with node-server / swift-server — do not rename it.

## Build / test / typecheck

- `npm run build -w @ai-ecoverse/spoon` → `node build.mjs` emits the canonical
  `dist/ui/electron-overlay-entry.js` IIFE (the path node + swift consume).
  Wired into the root `build` + `postinstall` chains before the runtimes that
  embed it.
- `npm run test -w @ai-ecoverse/spoon` → browser-mode Vitest (needs
  `npx playwright install chromium`). Kept OUT of the root `vitest run` so the
  default `npm test` stays browser-free; CI runs `test:coverage:spoon`.
- `npm run typecheck -w @ai-ecoverse/spoon` → `tsc --noEmit`. Wired into the
  root `typecheck` chain. Coverage floor: root `coverage-thresholds.json` →
  `typescript.spoon`.
