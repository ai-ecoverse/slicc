# CLAUDE.md — `@ai-ecoverse/spoon`

The **injection web component** package. Self-contained home of the
`<slicc-launcher>` overlay element, its pure state helpers, and the
inject/remove glue. Extracted so the one artifact every runtime embeds — the
overlay bootstrap IIFE — has a small, isolated source graph: a change here (and
only here) re-triggers the slow macOS `swift-launcher` CI job, while 99% of
webapp UI changes skip it.

## Why this package exists

Four consumers embed the launcher, so it can't live inside the large
`@slicc/webcomponents` graph without dragging unrelated UI changes into the
swift trigger path:

- **webapp** — `vite.config.ts` resolves `packages/spoon/src/overlay-entry.ts`
  directly (no re-export shim in `src/ui/`), bundles it with esbuild into
  `dist/ui/electron-overlay-entry.js`, and serves it at
  `/electron-overlay-entry.js`.
- **node-server** — reads the built `dist/ui/electron-overlay-entry.js` IIFE
  (`getElectronOverlayEntryDistPath`) and injects it via CDP / Electron.
- **swift-server / swift-launcher** — `assemble-app.mjs` copies the built IIFE
  into the `.app`; `ElectronLauncher.swift` reads it at runtime.
- **webcomponents** — re-exports `SliccLauncher` + launcher-state from spoon
  (barrel + `register.ts`) so `?ui=wc` and existing consumers keep working.

The **chrome-extension** is _not_ a consumer: the thin bridge has no
`content_scripts` and embeds no launcher; the overlay lives in the hosted
leader tab served by the webapp.

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
  tunnel/asset-graph.ts       # pure module-graph → blob-graph transforms
  tunnel/tunnel-protocol.ts   # frame ↔ controller wire contract
  tunnel/tunnel-runtime.ts    # tunnelled fetch/WebSocket + the loader boot
  tunnel/tunnel-loader-entry.ts # IIFE entry → boot() against the ambient frame
tests/                  # @vitest/browser (real Chromium)
  slicc-launcher.test.ts  launcher-drag.test.ts  internal-dom.test.ts
  overlay-entry.test.ts   index-barrel.test.ts
  asset-graph.test.ts     tunnel-runtime.test.ts
build.mjs               # esbuild IIFEs → <repoRoot>/dist/ui/electron-overlay-entry.js
                        #              + <repoRoot>/dist/ui/electron-tunnel-loader.js
```

## The CDP virtual-network tunnel (`src/tunnel/`)

For Electron apps that deny the renderer **all** network egress (Signal answers
every request with `net::ERR_ACCESS_DENIED`, beneath the layer `Page.setBypassCSP`
or CDP `Fetch` interception reach), the overlay iframe can never load. The
controller instead opens a `srcdoc` frame and injects
`dist/ui/electron-tunnel-loader.js`, which boots the real hosted follower app
with zero network: tunnelled `fetch`/`WebSocket` over a CDP binding, the module
graph materialized as `blob:` URLs, wired by an import map.

- **Split by testability**: `tunnel-loader-entry.ts` is a 3-line IIFE;
  everything lives in `tunnel-runtime.ts`, which takes its browser globals as a
  `TunnelEnv` argument. `tests/tunnel-runtime.test.ts` boots the whole
  loader into a disposable same-origin `<iframe>` against a fake controller —
  no live egress-blocked target needed.
- **Known gap**: `about:srcdoc` documents cannot host a history state object, so
  `virtualizeLocation` cannot replay the app's `?tray=` params there; it warns
  and returns `false`. Delivering those params needs a frame with a real URL (or
  a config channel), on the controller side.
- The controller half of the protocol is **not implemented yet** — no
  node-server / swift-server code reads `TUNNEL_SEND_GLOBAL` today.

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
  Coverage runs over every `src/**` file except `tunnel/tunnel-loader-entry.ts`
  (its one statement boots the loader at import time, which a test realm must
  not do); both IIFE entries' behavior is covered through the modules they call.
- `npm run typecheck -w @ai-ecoverse/spoon` → `tsc --noEmit`. Wired into the
  root `typecheck` chain. Coverage floor: root `coverage-thresholds.json` →
  `typescript.spoon`.
