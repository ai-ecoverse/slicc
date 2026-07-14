# Thin-extension dead-code & asset cleanup — design

- **Date:** 2026-07-14
- **Closes:** #1504 (dead extension sandbox-iframe JS realm), #1339 (~37 MB vestigial fat-extension assets)
- **Branch/worktree:** `worktree-karl-changes` (`.claude/worktrees/karl-changes`), based on `origin/main` @ `884c79e41` (release 5.57.1)
- **PR shape:** one combined PR, ordered commits (realm code → extension build assets → dead runtime branches → deps → docs/tests)
- **Review status:** v3 — two external-review passes (cursor-agent/gpt-5.5; codex spend-capped). Core confirmed sound; v3 adds knip.json edits, stale source-comment updates, and the sprinkle-renderer test + broadened CLAUDE.md doc completeness items. References cite **symbols**, not line numbers, to stay drift-proof.

## Background & root cause

The thin-bridge migration removed the extension's offscreen document and bundled UI.
The extension is now a CDP pass-through + bootstrapper; the webapp UI, kernel worker,
orchestrator, and agent shell all run in a **hosted `www.sliccy.ai/?slicc=leader` tab**
(and its `DedicatedWorker`). The side panel iframes a hosted `?cherry=1&ui-only=1`
follower, also `sliccy.ai`-origin.

The canonical extension-realm check, `isExtensionRealm()` (`packages/webapp/src/core/runtime-env.ts`,
`chrome.runtime.id`-based), and its aliases `isExtensionRuntime()` / `isExtensionFloat()`
(`packages/webapp/src/shell/supplemental-commands/shared.ts`) are therefore **false in every
JS-execution context the thin extension actually has** (the hosted tab is a normal page with
no `chrome.runtime.id`; its kernel worker likewise). `isExtensionRealm()` is only true in real
`chrome-extension://` contexts — the service worker (no `document`), the side-panel shell
(iframes the hosted follower), and the options/secrets page (runs no kernel) — **none of which
execute a JS realm, render sprinkles/dips, load the sandbox HTMLs, or run HAR filtering.**
(Independently confirmed by the external review across `sidepanel-entry.ts`, `secrets-entry.ts`,
`service-worker.ts`.)

Consequence: every code path gated behind these checks is **dead** in the thin extension.
#1504 is the **JS-realm slice**; #1339 is the **build-asset slice**. This design treats them as
one cleanup and removes both, plus the dead runtime branches and unused deps left behind.

## Goals

- Remove all dead thin-extension JS-realm code, vestigial extension build assets, and the dead
  extension-runtime branches + package deps that fed them.
- Keep every runtime-reachable path behavior-identical (thin extension + standalone/hosted).
- Keep tests, docs, and CI gates green; shrink `dist/extension/` from ~68 MB (or ~39 MB
  post-logos-PR) toward ~2 MB.

## Non-goals / out of scope

- The `logos/` over-copy fix (companion PR per #1339 — already handled by `copyLogoAndFontAssets`).
- Any change to the standalone/hosted webapp build (`packages/webapp/vite.config.ts`, `dist/ui`),
  its own sprinkle sandboxes / WASM, or the webapp's copies of `slicc-editor.js` / `slicc-diff.js`
  / `lucide-icons.js` (the webapp vite config **independently** builds + dev-serves these).
- `picker-popup.*` / `capture-popup.*` (device-picker + media-capture gesture windows — still used).
- The MV3 remote-hosted-code guard script (`check-extension-rhc.sh` stays — a cheap safety scan).
- Removing `stripBiomeWasmAssetPlugin` / `stripOrtWasmAssetPlugin` from the extension config — they
  guard against a >25 MiB Biome asset / ort fallout; kept as defensive no-ops (per review).

## Contradiction resolution (evidence)

#1504 says: keep `sprinkle-sandbox.html` + `tool-ui-sandbox.html`, they're "LIVE".
#1339 says: they're dead in thin-bridge, remove them. **#1339 is correct**, verified against code:

| Asset                   | Consumer(s)                                                                                 | Guard (all false in thin-bridge)                                                | Verdict                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `sandbox.html`          | `realm-iframe.ts` (`createIframeRealm`) **and** `har-recorder.ts` (`applyFilterViaSandbox`) | `realm-factory.ts` `createDefaultRealmFactory`; `har-recorder.ts` `applyFilter` | dead (#1504 listed only the `realm-iframe.ts` consumer) |
| `sprinkle-sandbox.html` | `sprinkle-renderer.ts` (`renderInSandbox`)                                                  | `sprinkle-renderer.ts` `const isExtension = isExtensionRealm()`                 | dead                                                    |
| `tool-ui-sandbox.html`  | **none** — zero TS references (only manifest `sandbox.pages`, vite copy list, stale docs)   | n/a                                                                             | dead                                                    |

The kernel worker (where JS realms run) has no `document` and no `chrome.runtime.id`, so
`realm-factory` always takes `createJsWorkerRealm()`; the sprinkle renderer and har-recorder both
run where `isExtensionRealm()` is false, so their sandbox branches never fire. #1504's "LIVE"
annotation was over-cautious scoping, not a runtime fact.

## Scope note — thorough vs. tight (please confirm)

Removing the vendored WASM (#1339) leaves **dead `getURL(...)` loader branches** pointing at
deleted assets: `resolvePyodideIndexURL` (`realm-factory.ts`), `magick-wasm.ts` `loadMagick`, and
`ffmpeg-wasm.ts` (each an `if (isExtension…)` block returning `chrome.runtime.getURL('pyodide/')`
/ `getURL('magick.wasm')` / `getURL('vendor/ffmpeg-core.js')`). #1339's literal scope is the vite
config only. **This design takes the thorough path: collapse those three branches too** (each is a
self-contained `if`-block whose fall-through is the live standalone path — low risk), so we leave
no `getURL` pointing at a deleted asset and we strip a stale "offscreen document" comment in
`magick-wasm.ts`. The same applies to the `sprinkle-renderer.ts` and `har-recorder.ts` sandbox
branches (they reference deleted HTML files, so collapsing them is non-optional). If you prefer
**tight** scope, we would keep the three vendor-loader branches (dead but harmless, matching the
many other surviving `isExtension` branches) — at the cost of dangling `getURL`s a reviewer will flag.

## Removal inventory

### A. Dead JS-realm code (`packages/webapp/src/kernel/realm/`)

- **Delete** `realm-iframe.ts` (`createIframeRealm`) + its test `tests/kernel/realm/realm-iframe.test.ts`.
- `realm-factory.ts` (`createDefaultRealmFactory`): drop the `isExtensionRuntime() && document`
  branch returning `createIframeRealm(...)`, its `import { createIframeRealm }`, and the
  offscreen-era JSDoc (the "extension → sandbox iframe" narrative + fallback-chain comment). JS
  realms unconditionally take `createJsWorkerRealm()`; the in-process fallback stays.
  Also collapse `resolvePyodideIndexURL`'s `isExtensionRuntime()` branch (see Scope note), and
  update the `createPyWorkerRealm` JSDoc that references the extension `getURL('pyodide/')` path.
- `realm-types.ts`: drop the `'realm-iframe-ready'` message-type union member, and update the
  `RealmInitMsg.pyodideIndexURL` JSDoc that cites `chrome.runtime.getURL('pyodide/')` as live.
- Strip the "Mirrored (verbatim/inline) in `chrome-extension/sandbox.html`" comments from
  `require-guards.ts`, `node-builtins.ts`, `js-realm-helpers.ts`, `js-realm-shared.ts`. **The code
  stays** — the worker realm uses it; only the mirror notes die.
- **Delete** `packages/webapp/src/shims/realm-vendor.ts` — it publishes `globalThis.__sliccRealmVendor`
  **only** for `sandbox.html` (no live import; the worker realm imports `js-md5`/`js-sha1`/`js-sha256`/`pako`
  directly in `js-realm-helpers.ts`). Update the `realm-vendor.js` reference comments in `js-realm-helpers.ts`.

> `buffer-polyfill.ts` **stays** — it's imported directly by `js-realm-shared.ts` (worker realm)
> and `git-commands.ts`; only the extension's `buildBufferPolyfillPlugin` (which rebuilt it for
> `sandbox.html`) is removed.
> `bsh-watchdog.ts`'s inline mirror of `require-guards` is a **separate, live** mirror (for `.bsh`
> browser scripts via CDP `Runtime.evaluate`; wired in `kernel/host.ts`) and is **kept**.

### B. Extension build assets + deps (`packages/chrome-extension/`)

- **Delete** `sandbox.html`, `sprinkle-sandbox.html`, `tool-ui-sandbox.html`.
- `manifest.json`: remove the entire `"sandbox": { "pages": [...] }` key.
- `vite.config.ts`:
  - `copyStaticShellFiles`: drop the three sandbox HTMLs (keep `capture-popup.*`, `picker-popup.*`,
    `secrets.html`, `sidepanel.html`).
  - **Delete** the sandbox-only plugins: `buildSliccEditorPlugin` (incl. its `lucide-icons.js` build),
    `buildSliccDiffPlugin`, `buildRealmVendorPlugin`, `buildBufferPolyfillPlugin`, `buildFfmpegWorkerPlugin`,
    and the body of `copyWasmVendorAssets` (pyodide dir, `magick.wasm`, `vendor/ffmpeg-core.js`).
  - Remove `stripFfmpegCoreCdnLiteralPlugin` from the extension plugin list + import (its target — the
    bundled ffmpeg worker — is gone). **Keep** `stripBiomeWasmAssetPlugin` / `stripOrtWasmAssetPlugin`
    (defensive; verified to have no biome/ort target in the current extension build but cheap to keep).
  - Keep `buildExtensionServiceWorkerPlugin`, `buildPreviewSwPlugin`, `buildSidePanelPlugin`,
    `buildSecretsPagePlugin`, `copyLogoAndFontAssets`, `writeExtensionManifest`, the noop input plugin,
    and the dev-reload wiring.
- `package.json`: remove the now-unused deps that fed only the removed plugins — `@ffmpeg/core` +
  `@imagemagick/magick-wasm` (dependencies), `js-md5` + `js-sha1` + `js-sha256` + `pako`
  (devDependencies). Verified: each is referenced **only** in `chrome-extension/vite.config.ts`
  (the deleted plugins), nowhere in extension `src`. They remain declared in `packages/webapp`,
  where the worker realm / magick / ffmpeg loaders use them. (Otherwise `deadcode`/knip fails.)
- `knip.json`: remove `src/shims/realm-vendor.ts!` from the `packages/webapp` `entry` list (the file is
  deleted), and drop `@imagemagick/magick-wasm` + `@ffmpeg/core` from the `packages/chrome-extension`
  `ignoreDependencies`. Re-run `npm run deadcode` and reconcile any remaining hints for the removed
  `js-md5` / `js-sha1` / `js-sha256` / `pako` devDeps empirically. (`slicc-editor-entry.ts` /
  `slicc-diff-entry.ts` / `lucide-icons.ts` **stay** in the webapp `entry` list — the webapp still builds them.)

> The `strip-ffmpeg-core-cdn-literal.ts` plugin **file** in `packages/webapp/vite-plugins/` **stays**
> — the webapp (`dist/ui`) vite config still imports and uses it. We only remove its wiring from the
> **extension** config.
> **Kept sources** (standalone build still ships them / worker uses them): `slicc-editor-entry.ts`,
> `slicc-diff-entry.ts`, `lucide-icons.ts`, `buffer-polyfill.ts`.

### C. Dead extension-runtime branches (shared webapp code)

Collapse each `isExtension…`-gated branch to its live fall-through; behavior in thin-bridge and
standalone is unchanged (the fall-through is the path that already runs):

- `packages/webapp/src/cdp/har-recorder.ts`: collapse `applyFilter` to always call `applyFilterDirect`;
  delete `applyFilterViaSandbox` + its `getURL('sandbox.html')` postMessage plumbing.
- `packages/webapp/src/ui/sprinkle-renderer.ts`: remove the `if (isExtension)` branch in `render()`,
  delete `renderInSandbox` and the extension-only `chrome.runtime.getURL('sprinkle-sandbox.html')` /
  `getURL('slicc-editor.js')` / `getURL('slicc-diff.js')` / `getURL('lucide-icons.js')` fetches. The
  standalone `renderFullDoc` / `renderInline` paths (which serve `/slicc-editor.js` etc. from `dist/ui`)
  are untouched. Drop the now-unused `isExtension` / `isExtensionRealm` import if fully orphaned.
- `packages/webapp/src/shell/supplemental-commands/magick-wasm.ts`: remove the `if (isExtension)` block
  in `loadMagick` (+ the stale "offscreen document" comment); fall through to the ipk/standalone path.
- `packages/webapp/src/shell/supplemental-commands/ffmpeg-wasm.ts`: remove the `if (isExtensionRuntime())`
  block in `resolveAssetUrls` returning `getURL('vendor/ffmpeg-core.js')` + `getURL('vendor/ffmpeg-worker.js')`;
  fall through to the standalone blob-URL path.
- **Comment hygiene:** update adjacent JSDoc/comments in the four files above (e.g. `loadMagick`'s
  "offscreen document" note, `ffmpeg-wasm.ts`'s vendor-bundling note) so none still claims the extension
  bundles `magick.wasm` / `vendor/ffmpeg-*` / `pyodide/` as a live path.

## Documentation (part of the change)

Update to drop offscreen-era sandbox-iframe framing (exact edits confirmed during impl via grep):

- `packages/chrome-extension/CLAUDE.md`: rewrite the "CSP Workarounds" section (still lists all three
  sandboxes as live) + the scope line naming `tool-ui-sandbox`, **and** fix the "Build Notes", "Dev Watch",
  and "Automated CDP Smoke Test" sections that still describe removed outputs as live ("sandbox helpers",
  the `slicc-editor-entry` / `slicc-diff-entry` esbuild inputs, the "ffmpeg-core literal strip", "bundled vendor JS").
- `packages/webapp/CLAUDE.md`: fix the Sprinkle Rendering + Dips lines claiming extension rendering
  "routes through `sprinkle-sandbox.html`".
- Root `CLAUDE.md`: the Sprinkle/Dips extension-mode notes + the "Extension CSP workaround: dynamic
  code routes through `sandbox.html`" line.
- `docs/architecture.md`, `docs/pitfalls.md`, `docs/development.md`, `docs/shell-reference.md`,
  `docs/node-compat-shims.md`, `docs/chrome-web-store-submission.md` (bundled `ffmpeg-core.js`):
  purge references to the removed sandboxes / `createIframeRealm` / bundled vendor WASM where they
  describe live behavior; mark genuinely historical notes as such.
- **`AGENTS.md` needs no separate edits** — root, `packages/webapp`, and `packages/chrome-extension`
  `AGENTS.md` are symlinks to their sibling `CLAUDE.md` (verified), so the CLAUDE.md edits cover them.

## Tests

- **Delete** `packages/webapp/tests/kernel/realm/realm-iframe.test.ts`.
- **Drop the `sandbox.html`-parity assertions:**
  - `tests/kernel/realm/js-realm-helpers.test.ts` — remove the `describe('sandbox.html mirror parity', …)`
    block (+ the `__sliccRealmVendor` sandbox assertion) and the file-header note.
  - `tests/kernel/realm/browser-fetch.test.ts` — remove the `describe('sandbox.html ↔ js-realm-shared
parity — browser.fetch', …)` block.
  - `tests/shell/bsh-watchdog.test.ts` — in `describe('NODE_NATIVE_PACKAGES mirror parity (canonical →
sandbox.html, bsh-watchdog.ts)', …)`, **drop only the `sandbox.html` half** (the `sandboxSrc` read +
    its assertions); **keep** the `bsh-watchdog.ts` mirror assertions and the `describe('BshWatchdog
mirror of require-guards', …)` block (that mirror is live).
- **Delete** `packages/webapp/tests/shell/supplemental-commands/node-command-loadmodule.test.ts`
  (reads `chrome-extension/sandbox.html`; the extension node-load path it pins no longer exists) — or
  rewrite to assert the worker-realm loadmodule path if that coverage is still wanted. Decision at impl.
- **Extension tests** (`packages/chrome-extension/tests/`):
  - `sandbox-realm-behavioral.test.ts` — delete (exercises the dead sandbox.html realm + `__sliccRealmVendor`).
  - `sprinkle-sandbox.test.ts` — delete (exercises the dead sprinkle-sandbox.html).
  - `manifest-sidepanel.test.ts` — update any assertion expecting the `sandbox.pages` key / three sandbox
    HTMLs; keep sidepanel assertions.
  - `dev-reload.test.ts` — update if it asserts the removed copied assets exist.
- `packages/webapp/tests/ui/sprinkle-renderer.test.ts` — remove the two extension-mode blocks that
  exercise removed code: `describe('sandbox localStorage proxy (extension mode)', …)` and
  `describe('getLucideScript caching and retry (extension mode)', …)`. Keep the standalone blocks
  (`onclick function hoisting`, `multi-sprinkle slicc bridge isolation`, `isFullDocument detection`,
  `full document rendering`).
- `tests/shell/supplemental-commands/shared.test.ts` — its `describe('resolvePyodideIndexURL', …)` block
  has an extension-mode case (asserting `chrome-extension://<id>/pyodide/`) that must be removed with the
  vendor-loader branch collapse; its **separate** preview-`getURL` (`toPreviewUrl`) test is kept.
- **Not affected** (verified): `tests/ui/sprinkle-renderer-inline.test.ts` (tests the kept inline-scripts path).
- **har-recorder / sprinkle-renderer**: add/adjust tests asserting `applyFilter` filters directly and
  `render()` uses the standalone path with no sandbox/`getURL` dependency (regression guards for the
  collapsed branches).
- Re-run knip after edits so no test-only import / dep dangles.

## Verification plan

**I run all gates** (per the agreed split):
`npm run lint` → `npm run typecheck` → `npm run test` → `npm run test:coverage` (each touched package
≥ its floor in `coverage-thresholds.json`) → the TS/JS build chain incl. `npm run build -w @slicc/chrome-extension` (root `npm run build` runs these but then fails at swift-server locally — Swift 6.0.3 < 6.2, environmental) →
`npm run deadcode` (knip — confirms no dangling refs to removed exports/assets **and** the removed
`chrome-extension` deps are gone) → `packages/dev-tools/tools/check-extension-rhc.sh` → touched-file
complexity gate. Verify `dist/extension/` no longer contains `pyodide/`, `magick.wasm`, `vendor/ffmpeg-*`,
`slicc-editor.js`, `slicc-diff.js`, `realm-vendor.js`, `buffer-polyfill.js`, `lucide-icons.js`, or the
three sandbox HTMLs, and that its size dropped toward ~2 MB.

**Manual CDP smoke checklist (handed to the user):**

1. `npm run dev:extension:fresh` (builds ext with `SLICC_EXT_DEV=1`, self-builds leader UI, wrangler
   on `:8787`, Chrome for Testing on CDP `:9333`).
2. In the pinned `http://localhost:8787/?slicc=leader` tab, confirm each still executes via the
   **worker realm**: `node -e "console.log(1+1)"`, a `.jsh` script, and a `workflow run`.
3. Render a sprinkle/dip in the leader tab — confirms the standalone sprinkle path is unaffected.
4. Click the toolbar icon → the side-panel `?cherry=1&ui-only=1` follower connects (tri-state resolves
   to the live follower, not "Disconnected").
5. `ffmpeg -version` / `python3 -c` / `convert` in the leader tab still resolve via the hosted `dist/ui`
   WASM (not the removed extension vendor copies).

## Risks & mitigations

- **Hidden reachable consumer.** Mitigation: knip `deadcode` + `npm run build -w @slicc/chrome-extension` + the manual smoke; the
  static guard is that every removed path sits behind an `isExtensionRealm()/isExtensionRuntime()/isExtensionFloat()`
  check provably false in the hosted tab + worker (confirmed independently by the external review).
- **Collapsing a vendor-loader branch breaks the standalone fallback.** Mitigation: each is a self-contained
  `if`-block whose fall-through is the path thin-bridge already runs; covered by `build` + `test` + smoke steps 2/5.
- **Removed dep still needed by the extension.** Mitigation: verified each of the 6 deps is referenced only
  in the deleted plugins; knip is the hard gate.
- **Over-trimming the `bsh-watchdog.ts` mirror parity test.** Mitigation: explicit "keep the bsh-watchdog half";
  the live `describe('BshWatchdog mirror of require-guards')` must stay green.

## Ordered commits (within the one PR)

1. `refactor(realm): remove dead extension sandbox-iframe JS realm` — inventory A (realm-iframe, factory
   branch + pyodide branch, realm-types, mirror comments, realm-vendor.ts) + realm tests.
2. `chore(extension): drop vestigial fat-extension build assets + deps` — inventory B (sandbox HTMLs,
   manifest, vite plugins, package.json deps) + extension tests.
3. `refactor: drop dead extension-runtime branches (har/sprinkle/magick/ffmpeg)` — inventory C + regression tests.
4. `docs: purge offscreen-era sandbox-iframe references` — all doc edits.
