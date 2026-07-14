# Thin-extension dead-code & asset cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead thin-bridge Chrome-extension sandbox-iframe JS realm (#1504) and the ~37 MB of vestigial fat-extension build assets + the dead extension-runtime branches / deps that fed them (#1339), shrinking `dist/extension/` toward ~2 MB with zero runtime-behavior change.

**Architecture:** Everything removed is gated behind `isExtensionRealm()`/`isExtensionRuntime()`/`isExtensionFloat()`, all of which are **false** in the thin extension's only JS-execution contexts (the hosted `www.sliccy.ai/?slicc=leader` tab + its kernel worker). So each removal is provably dead; the live fall-through (standalone/hosted path served from `dist/ui`) is what already runs. Work lands as 4 cohesive, green-at-each-commit tasks + a final gate pass.

**Tech Stack:** TypeScript, Vite (rolldown-vite), esbuild closeBundle plugins, Vitest, knip (deadcode), Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-07-14-thin-extension-dead-code-and-asset-cleanup-design.md` (v3).

## Global Constraints

- **Node >= 22.13.0.** Run everything from the worktree `.claude/worktrees/karl-changes` (do NOT `cd` to the main checkout).
- **Linear history:** never merge; the branch is already rebased on `origin/main` @ `884c79e41`.
- **Prettier before every commit:** `npx prettier --write <changed-files>` (husky lint-staged also runs it, but run it yourself). CI's `lint:ci` (biome, no `--write`) + `deadcode` (knip) are hard gates.
- **Do NOT touch the standalone/hosted webapp build** (`packages/webapp/vite.config.ts`, `dist/ui`) or the webapp's own `slicc-editor.js` / `slicc-diff.js` / `lucide-icons.js` outputs — the webapp vite config independently builds + dev-serves those and they stay live.
- **Keep** `picker-popup.*`, `capture-popup.*`, `secrets.html`, `sidepanel.html`, `preview-sw`, `check-extension-rhc.sh`, and the `strip-biome-wasm-asset` / `strip-ort-wasm-asset` plugins.
- **`buffer-polyfill.ts` stays** (imported by `js-realm-shared.ts` worker realm + `git-commands.ts`); only its extension IIFE build is removed.
- **`bsh-watchdog.ts` + its live `require-guards` mirror stay** — only the `sandbox.html` half of its parity test is dropped.
- End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit only when a task's gates are green.

---

## File Structure (what changes, by responsibility)

**Deleted files:**

- `packages/webapp/src/kernel/realm/realm-iframe.ts` — the dead `createIframeRealm` sandbox-iframe realm.
- `packages/webapp/src/shims/realm-vendor.ts` — `__sliccRealmVendor` shim, consumed only by `sandbox.html`.
- `packages/chrome-extension/sandbox.html`, `sprinkle-sandbox.html`, `tool-ui-sandbox.html` — dead CSP-exempt shells.
- Tests: `packages/webapp/tests/kernel/realm/realm-iframe.test.ts`, `packages/webapp/tests/shell/supplemental-commands/node-command-loadmodule.test.ts`, `packages/chrome-extension/tests/sandbox-realm-behavioral.test.ts`, `packages/chrome-extension/tests/sprinkle-sandbox.test.ts`.

**Modified files (realm):** `realm-factory.ts`, `realm-types.ts`, `require-guards.ts`, `node-builtins.ts`, `js-realm-helpers.ts`, `js-realm-shared.ts` (comment strips + branch/member removals).

**Modified files (runtime branches):** `packages/webapp/src/cdp/har-recorder.ts`, `packages/webapp/src/ui/sprinkle-renderer.ts`, `packages/webapp/src/shell/supplemental-commands/magick-wasm.ts`, `packages/webapp/src/shell/supplemental-commands/ffmpeg-wasm.ts`.

**Modified files (build/config):** `packages/chrome-extension/vite.config.ts`, `packages/chrome-extension/manifest.json`, `packages/chrome-extension/package.json`, `knip.json`.

**Modified files (tests):** `js-realm-helpers.test.ts`, `browser-fetch.test.ts`, `bsh-watchdog.test.ts`, `sprinkle-renderer.test.ts`, `manifest-sidepanel.test.ts`, `dev-reload.test.ts`.

**Modified files (docs):** root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `packages/chrome-extension/CLAUDE.md`, `docs/architecture.md`, `docs/pitfalls.md`, `docs/development.md`, `docs/shell-reference.md`, `docs/node-compat-shims.md`, `docs/chrome-web-store-submission.md`. (`AGENTS.md` are symlinks to `CLAUDE.md` — no separate edits.)

**Commands used throughout:**

- Realm/har/sprinkle tests: `npm run test -w @slicc/webapp -- <path>`
- Extension tests: `npm run test -w @slicc/chrome-extension`
- Extension build: `npm run build -w @slicc/chrome-extension`
- Dead-code gate: `npm run deadcode`
- RHC guard: `bash packages/dev-tools/tools/check-extension-rhc.sh`

---

## Task 1: Remove the dead `sandbox.html` JS realm + har-recorder filter branch

Everything tied to `sandbox.html` (the `createIframeRealm` realm and the har-recorder filter consumer), landed together so the extension build + tests stay green.

**Files:**

- Delete: `packages/webapp/src/kernel/realm/realm-iframe.ts`, `packages/webapp/src/shims/realm-vendor.ts`, `packages/chrome-extension/sandbox.html`
- Delete tests: `packages/webapp/tests/kernel/realm/realm-iframe.test.ts`, `packages/webapp/tests/shell/supplemental-commands/node-command-loadmodule.test.ts`, `packages/chrome-extension/tests/sandbox-realm-behavioral.test.ts`
- Modify: `packages/webapp/src/kernel/realm/realm-factory.ts`, `realm-types.ts`, `require-guards.ts`, `node-builtins.ts`, `js-realm-helpers.ts`, `js-realm-shared.ts`
- Modify: `packages/webapp/src/cdp/har-recorder.ts`
- Modify: `packages/chrome-extension/vite.config.ts`, `packages/chrome-extension/manifest.json`, `knip.json`
- Modify tests: `packages/webapp/tests/kernel/realm/js-realm-helpers.test.ts`, `packages/webapp/tests/kernel/realm/browser-fetch.test.ts`, `packages/webapp/tests/shell/bsh-watchdog.test.ts`
- Test (new regression): `packages/webapp/tests/cdp/har-recorder.test.ts` (or extend existing har coverage)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `createDefaultRealmFactory` now always returns `createJsWorkerRealm()` for `kind:'js'`; `HarRecorder.applyFilter` always calls `applyFilterDirect`. No new exported symbols.

- [ ] **Step 1: Collapse `har-recorder.applyFilter` and delete the sandbox path**

In `packages/webapp/src/cdp/har-recorder.ts`, replace the `applyFilter` + `applyFilterViaSandbox` methods (the block starting at the `applyFilter` JSDoc through the end of `applyFilterViaSandbox`) with just:

```ts
  /**
   * Apply the recording's filter to entries. Compiles + applies directly.
   * Returns entries unfiltered on error (graceful fallback).
   */
  private async applyFilter(entries: HarEntry[], filterCode: string): Promise<HarEntry[]> {
    return applyFilterDirect(entries, filterCode);
  }
```

Then remove the now-unused import: delete `import { isExtensionRealm } from '../core/runtime-env.js';` (it was used only in `applyFilter`).

- [ ] **Step 2: Write the har-recorder regression test**

Create/extend `packages/webapp/tests/cdp/har-recorder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyFilterDirect } from '../../src/cdp/har-recorder.js';

describe('HAR filter — direct (no sandbox)', () => {
  it('applies the filter without any chrome-extension sandbox dependency', () => {
    const entries = [
      { request: { url: 'https://a.test/keep' } },
      { request: { url: 'https://a.test/drop' } },
    ] as any;
    const kept = applyFilterDirect(
      entries,
      "return entries.filter(e => e.request.url.includes('keep'))"
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].request.url).toContain('keep');
  });
});
```

If `applyFilterDirect` is not already exported, export it from `har-recorder.ts` (it is module-local today — add `export` to its declaration).

- [ ] **Step 3: Run the har-recorder test**

Run: `npm run test -w @slicc/webapp -- tests/cdp/har-recorder.test.ts`
Expected: PASS.

- [ ] **Step 4: Delete the realm-iframe realm + collapse the factory**

Delete `packages/webapp/src/kernel/realm/realm-iframe.ts`. In `realm-factory.ts`:

- Remove `import { createIframeRealm } from './realm-iframe.js';`
- In `createDefaultRealmFactory`, delete the branch:

```ts
if (isExtensionRuntime() && typeof document !== 'undefined') {
  return createIframeRealm(kind, ctx);
}
```

so the `kind === 'js'` path is just `if (typeof Worker !== 'undefined') return createJsWorkerRealm(); return inProcessJs({ kind, ctx });`

- Rewrite the file-top JSDoc + the `createDefaultRealmFactory` JSDoc to drop the "extension → sandbox iframe" narrative and the "kind:'js' extension → sandbox iframe → in-process JS" fallback line.
- If `isExtensionRuntime` is now unused in this file, drop it from the `shared.js` import (leave `isNodeRuntime`, `resolveNodePackageBaseUrl` — still used by `resolvePyodideIndexURL`).

- [ ] **Step 5: Remove the `realm-iframe-ready` message type**

In `realm-types.ts`, delete the union member `{ type: 'realm-iframe-ready' }` (and its surrounding JSDoc line). Leave every other `RealmOutMsg`/`RealmInitMsg` member intact.

- [ ] **Step 6: Delete `realm-vendor.ts` + strip the sandbox.html mirror comments**

- Delete `packages/webapp/src/shims/realm-vendor.ts`.
- In `js-realm-helpers.ts`, `js-realm-shared.ts`, `require-guards.ts`, `node-builtins.ts`: remove the comment lines that say the code is "Mirrored (verbatim/inline) in `chrome-extension/sandbox.html`" and the `realm-vendor.js`/`__sliccRealmVendor` "loaded by sandbox.html" references. Do NOT change any code — only comments.

- [ ] **Step 7: Delete the dead realm tests + trim parity assertions**

- Delete `packages/webapp/tests/kernel/realm/realm-iframe.test.ts`.
- Delete `packages/webapp/tests/shell/supplemental-commands/node-command-loadmodule.test.ts` (it `readFileSync`s `chrome-extension/sandbox.html`).
- `packages/webapp/tests/kernel/realm/js-realm-helpers.test.ts`: delete the `describe('sandbox.html mirror parity', …)` block and the file-header note about the sandbox mirror.
- `packages/webapp/tests/kernel/realm/browser-fetch.test.ts`: delete the `describe('sandbox.html ↔ js-realm-shared parity — browser.fetch', …)` block.
- `packages/webapp/tests/shell/bsh-watchdog.test.ts`: in `describe('NODE_NATIVE_PACKAGES mirror parity (canonical → sandbox.html, bsh-watchdog.ts)', …)`, remove the `sandboxSrc` `readFileSync` + every assertion against it; KEEP the `bsh-watchdog.ts` mirror assertions. Do NOT touch `describe('BshWatchdog mirror of require-guards', …)`.

- [ ] **Step 8: Run the webapp realm/shell tests**

Run: `npm run test -w @slicc/webapp -- tests/kernel/realm tests/shell/bsh-watchdog.test.ts`
Expected: PASS (no test reads `sandbox.html`; bsh-watchdog `require-guards` mirror still green).

- [ ] **Step 9: Remove the sandbox.html extension build wiring + file**

In `packages/chrome-extension/vite.config.ts`:

- In `copyStaticShellFiles`, remove `'sandbox.html'` from the `files` array.
- Delete `buildRealmVendorPlugin` and `buildBufferPolyfillPlugin` (both esbuild `realm-vendor.ts` / `buffer-polyfill.ts` for `sandbox.html` only) and remove them from the `plugins:` list.

Delete `packages/chrome-extension/sandbox.html`.
Delete `packages/chrome-extension/tests/sandbox-realm-behavioral.test.ts`.

In `packages/chrome-extension/manifest.json`, remove `"sandbox.html"` from the `sandbox.pages` array (leave `sprinkle-sandbox.html` + `tool-ui-sandbox.html` — Task 2 removes the whole key).

- [ ] **Step 10: Update knip.json (realm-vendor entry)**

In `knip.json`, in the `packages/webapp` `entry` array, delete the line `"src/shims/realm-vendor.ts!"` (file no longer exists).

- [ ] **Step 11: Build the extension + run its tests + deadcode**

Run: `npm run build -w @slicc/chrome-extension`
Expected: build succeeds; `dist/extension/` no longer contains `sandbox.html`, `realm-vendor.js`, `buffer-polyfill.js`.
Run: `npm run test -w @slicc/chrome-extension`
Expected: PASS.
Run: `npm run deadcode`
Expected: PASS (no dangling ref to `realm-vendor.ts`).

- [ ] **Step 12: Prettier + commit**

```bash
cd /Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/karl-changes
npx prettier --write packages/webapp/src/kernel/realm packages/webapp/src/cdp/har-recorder.ts packages/chrome-extension/vite.config.ts packages/chrome-extension/manifest.json knip.json packages/webapp/tests packages/chrome-extension/tests
git add -A
git commit -m "refactor(realm): remove dead extension sandbox-iframe JS realm

createIframeRealm/sandbox.html were the offscreen-era extension JS realm; the
thin-bridge worker realm (createJsWorkerRealm) is the only live path. Also drops
the dead har-recorder sandbox filter branch, realm-vendor.ts, and the
sandbox.html-only extension IIFE plugins. Part of #1504.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Remove `sprinkle-sandbox.html` + `tool-ui-sandbox.html` + the sprinkle-renderer extension branch

**Files:**

- Delete: `packages/chrome-extension/sprinkle-sandbox.html`, `packages/chrome-extension/tool-ui-sandbox.html`
- Delete test: `packages/chrome-extension/tests/sprinkle-sandbox.test.ts`
- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts`, `packages/webapp/src/ui/lucide-icons.ts` (comment)
- Modify: `packages/chrome-extension/vite.config.ts`, `packages/chrome-extension/manifest.json`
- Modify tests: `packages/webapp/tests/ui/sprinkle-renderer.test.ts`, `packages/chrome-extension/tests/manifest-sidepanel.test.ts`, `packages/chrome-extension/tests/dev-reload.test.ts`

**Interfaces:**

- Consumes: Task 1's state (sandbox.html already gone).
- Produces: `SprinkleRenderer.render()` always renders via `renderFullDoc`/`renderInline`; no `renderInSandbox`/`getLucideScript` remain.

- [ ] **Step 1: Collapse `SprinkleRenderer.render()`**

In `packages/webapp/src/ui/sprinkle-renderer.ts`, replace the `render()` body's `if (isExtension) … else if …` with the non-extension path only:

```ts
  /** Render SHTML content into the container. */
  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();
    if (isFullDocument(content)) {
      await this.renderFullDoc(content, sprinkleName);
    } else {
      this.renderInline(content, sprinkleName);
    }
  }
```

- [ ] **Step 2: Delete the extension-only members**

In the same file:

- Delete the entire `private async renderInSandbox(…) { … }` method (from its signature through its closing brace, immediately before `private generateBridgeScript()`).
- Delete the entire `private async getLucideScript(): Promise<string> { … }` method.
- Delete the two static fields it used: `private static cachedLucideScript` and `private static lucideScriptPromise`.
- Delete `const isExtension = isExtensionRealm();` and the `import { isExtensionRealm } from '../core/runtime-env.js';` (now orphaned).
- Update the two JSDoc comments that reference `renderInSandbox` (the "device bridge call in both `renderInSandbox` and `renderFullDoc`" and the "(`renderInSandbox`) and the CLI/standalone full-document iframe" notes) to drop the `renderInSandbox` mention.
- **Keep** `generateBridgeScript`, `postToIframe`, `renderFullDoc`, `renderInline`, `dispose`, and `registerSprinkleWindow`/`unregisterSprinkleWindow` usage — all live via `renderFullDoc`.

- [ ] **Step 3: Fix the lucide-icons.ts comment**

In `packages/webapp/src/ui/lucide-icons.ts`, update the two comments mentioning `sprinkle-sandbox.html` (the "body may not exist yet when loaded in `<head>` (e.g. sprinkle-sandbox.html)" notes) to reference the standalone sprinkle full-doc iframe instead. Code unchanged.

- [ ] **Step 4: Remove the sprinkle-renderer extension-mode test blocks**

In `packages/webapp/tests/ui/sprinkle-renderer.test.ts`, delete the two `describe` blocks that exercise removed code:

- `describe('sandbox localStorage proxy (extension mode)', …)`
- `describe('getLucideScript caching and retry (extension mode)', …)`

Keep `onclick function hoisting`, `multi-sprinkle slicc bridge isolation`, `isFullDocument detection`, `full document rendering`. Do NOT touch `sprinkle-renderer-inline.test.ts`.

- [ ] **Step 5: Run the sprinkle-renderer tests**

Run: `npm run test -w @slicc/webapp -- tests/ui/sprinkle-renderer.test.ts tests/ui/sprinkle-renderer-inline.test.ts`
Expected: PASS (standalone render paths only).

- [ ] **Step 6: Remove the sandbox HTMLs + their extension build wiring**

In `packages/chrome-extension/vite.config.ts`:

- In `copyStaticShellFiles`, remove `'sprinkle-sandbox.html'` and `'tool-ui-sandbox.html'`.
- Delete `buildSliccEditorPlugin` (which also builds `lucide-icons.js`) and `buildSliccDiffPlugin`, and remove them from the `plugins:` list. (They fed `sprinkle-sandbox.html` only; the webapp build still ships `/slicc-editor.js` etc. for the standalone path.)

Delete `packages/chrome-extension/sprinkle-sandbox.html`, `packages/chrome-extension/tool-ui-sandbox.html`, and `packages/chrome-extension/tests/sprinkle-sandbox.test.ts`.

In `packages/chrome-extension/manifest.json`, remove the entire `"sandbox": { "pages": [...] }` key (all three pages are now gone).

- [ ] **Step 7: Update the extension guard tests**

- `packages/chrome-extension/tests/manifest-sidepanel.test.ts`: remove/adjust any assertion that expects the `sandbox` key or the three sandbox HTMLs; keep the sidepanel/manifest assertions.
- `packages/chrome-extension/tests/dev-reload.test.ts`: if it asserts `sprinkle-sandbox.html` / `slicc-editor.js` / `slicc-diff.js` / `lucide-icons.js` are copied/synced, remove those assertions.

Run: `npm run test -w @slicc/chrome-extension`
Expected: PASS.

- [ ] **Step 8: Build the extension + deadcode**

Run: `npm run build -w @slicc/chrome-extension`
Expected: build succeeds; `dist/extension/` no longer contains `sprinkle-sandbox.html`, `tool-ui-sandbox.html`, `slicc-editor.js`, `slicc-diff.js`, `lucide-icons.js`.
Run: `npm run deadcode`
Expected: PASS.

- [ ] **Step 9: Prettier + commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-renderer.ts packages/webapp/src/ui/lucide-icons.ts packages/chrome-extension/vite.config.ts packages/chrome-extension/manifest.json packages/webapp/tests/ui packages/chrome-extension/tests
git add -A
git commit -m "chore(extension): drop dead sprinkle/tool-ui sandboxes + editor IIFEs

sprinkle-sandbox.html/tool-ui-sandbox.html + the slicc-editor/slicc-diff/lucide
IIFEs were only reachable via the extension sprinkle-renderer branch, which is
dead in thin-bridge (hosted follower renders on sliccy.ai origin). Part of #1339.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Remove vendored WASM + collapse the dead vendor-loader branches + deps

**Files:**

- Modify: `packages/chrome-extension/vite.config.ts`, `packages/chrome-extension/package.json`, `knip.json`
- Modify: `packages/webapp/src/shell/supplemental-commands/magick-wasm.ts`, `ffmpeg-wasm.ts`, `packages/webapp/src/kernel/realm/realm-factory.ts`, `realm-types.ts`

**Interfaces:**

- Consumes: Tasks 1–2 state.
- Produces: `resolvePyodideIndexURL` / `loadMagick` / ffmpeg `resolveAssetUrls` have no extension branch; each falls through to the node/standalone path.

- [ ] **Step 1: Remove the WASM vendor copy + ffmpeg worker plugin from the extension build**

In `packages/chrome-extension/vite.config.ts`:

- Delete `buildFfmpegWorkerPlugin` and remove it from `plugins:`.
- In `copyExtensionAssetsPlugin`'s `closeBundle`, remove the `copyWasmVendorAssets();` call and delete the `copyWasmVendorAssets` function (pyodide dir + `magick.wasm` + `vendor/ffmpeg-core.js`).
- Remove `stripFfmpegCoreCdnLiteralPlugin` from `plugins:` and its `import` line (its target — the bundled ffmpeg worker — is gone). **Keep** `stripBiomeWasmAssetPlugin` + `stripOrtWasmAssetPlugin`.

- [ ] **Step 2: Collapse `magick-wasm.loadMagick`**

In `packages/webapp/src/shell/supplemental-commands/magick-wasm.ts`:

- Delete the `if (isExtension) { … }` block at the top of `loadMagick` (the `chrome.runtime.getURL('magick.wasm')` fetch + compile + return, incl. its stale "offscreen document" comment). `loadMagick` now begins with the `if (isNodeRuntime())` branch.
- Delete `export const isExtension = isExtensionRealm();` and the `import { isExtensionRealm } from '../../core/runtime-env.js';` (verified: no external importers of this `isExtension`).

- [ ] **Step 3: Collapse ffmpeg `resolveAssetUrls`**

In `packages/webapp/src/shell/supplemental-commands/ffmpeg-wasm.ts`:

- Delete the `if (isExtensionRuntime()) { return { coreURL: getURL('vendor/ffmpeg-core.js'), wasmURL, classWorkerURL: getURL('vendor/ffmpeg-worker.js') }; }` block (incl. its vendor-bundling comment). The function falls through to the standalone `return { coreURL: stringToBlobUrl(...), wasmURL };`.
- Change the import from `import { isExtensionRuntime, isNodeRuntime } from './shared.js';` to `import { isNodeRuntime } from './shared.js';` (`isNodeRuntime` is still used).

- [ ] **Step 4: Collapse `resolvePyodideIndexURL` + fix comments**

In `packages/webapp/src/kernel/realm/realm-factory.ts`:

- In `resolvePyodideIndexURL`, delete the `if (isExtensionRuntime()) { const c = …; if (c?.runtime?.getURL) return c.runtime.getURL('pyodide/'); }` block. The function now starts with `if (isNodeRuntime()) { … }`.
- If `isExtensionRuntime` is now unused in the file, drop it from the `shared.js` import.
- Update the `createPyWorkerRealm` JSDoc that references the extension "bundled" pyodide URL.

In `packages/webapp/src/kernel/realm/realm-types.ts`: update the `RealmInitMsg.pyodideIndexURL` JSDoc that cites `chrome.runtime.getURL('pyodide/')` as a live extension source (drop the extension mention).

- [ ] **Step 5: Run the affected webapp tests**

Run: `npm run test -w @slicc/webapp -- tests/kernel/realm tests/shell/supplemental-commands/magick-wasm.test.ts tests/shell/supplemental-commands/ffmpeg-wasm.test.ts`
Expected: PASS. (If a test asserted the extension `getURL` branch, update it to the node/standalone expectation.)

- [ ] **Step 6: Remove the unused extension deps + sync knip**

In `packages/chrome-extension/package.json`:

- Remove from `dependencies`: `@ffmpeg/core`, `@imagemagick/magick-wasm`.
- Remove from `devDependencies`: `js-md5`, `js-sha1`, `js-sha256`, `pako`.

In `knip.json`, in the `packages/chrome-extension` `ignoreDependencies`, remove `@imagemagick/magick-wasm` and `@ffmpeg/core`.

Run: `npm install` (updates `package-lock.json` for the removed extension deps). If `git diff package-lock.json` shows ONLY the removal of these deps, keep it; if it also shows unrelated npm-version churn (`./dist/cli.js`→`dist/cli.js`, `libc` hints), `git checkout -- package-lock.json` then re-run `npm install --package-lock-only`.

- [ ] **Step 7: deadcode + extension build + RHC guard**

Run: `npm run deadcode`
Expected: PASS. If knip flags the removed `js-md5`/`js-sha1`/`js-sha256`/`pako` as "unlisted" or reports an unused ignore, reconcile: they should now be absent from the extension workspace entirely. Adjust `knip.json` only as needed to reach green.
Run: `npm run build -w @slicc/chrome-extension`
Expected: succeeds; `dist/extension/` has no `pyodide/`, `magick.wasm`, `vendor/ffmpeg-core.js`, `vendor/ffmpeg-worker.js`.
Run: `bash packages/dev-tools/tools/check-extension-rhc.sh`
Expected: PASS (no forbidden CDN literal).

- [ ] **Step 8: Prettier + commit**

```bash
npx prettier --write packages/chrome-extension/vite.config.ts packages/chrome-extension/package.json knip.json packages/webapp/src/shell/supplemental-commands/magick-wasm.ts packages/webapp/src/shell/supplemental-commands/ffmpeg-wasm.ts packages/webapp/src/kernel/realm/realm-factory.ts packages/webapp/src/kernel/realm/realm-types.ts
git add -A
git commit -m "chore(extension): drop vendored WASM + dead loader branches + deps

pyodide/magick.wasm/ffmpeg vendor copies + their extension getURL loader
branches are dead in thin-bridge (WASM runs in the hosted tab). Removes the
copies, collapses the loaders, and drops the now-unused @ffmpeg/core,
@imagemagick/magick-wasm, js-md5/sha1/sha256, pako deps. Part of #1339.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Purge offscreen-era sandbox-iframe references from docs

**Files (modify):** root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `packages/chrome-extension/CLAUDE.md`, `docs/architecture.md`, `docs/pitfalls.md`, `docs/development.md`, `docs/shell-reference.md`, `docs/node-compat-shims.md`, `docs/chrome-web-store-submission.md`.

- [ ] **Step 1: Grep every live-behavior reference**

Run: `rg -n -e "sandbox\.html|sprinkle-sandbox\.html|tool-ui-sandbox\.html|createIframeRealm|realm-iframe|__sliccRealmVendor|ffmpeg-core\.js|magick\.wasm bundle" CLAUDE.md packages/webapp/CLAUDE.md packages/chrome-extension/CLAUDE.md docs`
Use the hits as the edit checklist.

- [ ] **Step 2: Edit each doc**

- `packages/chrome-extension/CLAUDE.md`: rewrite the "CSP Workarounds" section (drop the three-sandbox "use X for Y" bullets); fix the scope line naming `tool-ui-sandbox`; fix "Build Notes" ("sandbox helpers"), "Dev Watch" (`slicc-editor-entry`/`slicc-diff-entry` esbuild inputs, "ffmpeg-core literal strip"), and "Automated CDP Smoke Test" ("bundled vendor JS", `ffmpeg-core.js` from `chrome-extension://`) so they describe the thin extension's actual outputs (SW, sidepanel, secrets, preview-sw, popups).
- `packages/webapp/CLAUDE.md`: fix the "Sprinkle Rendering" + "Dips" lines claiming extension rendering "routes through `sprinkle-sandbox.html`" — extension sprinkle/dip rendering happens in the hosted follower on the standalone path.
- Root `CLAUDE.md`: fix the Sprinkle/Dips extension-mode notes and the "Extension CSP workaround: dynamic code routes through `sandbox.html`" line.
- `docs/architecture.md`, `docs/pitfalls.md`, `docs/development.md`, `docs/shell-reference.md`, `docs/node-compat-shims.md`: remove/rephrase references to the removed sandboxes, `createIframeRealm`, and the extension iframe realm where they describe live behavior. Mark genuinely historical notes as historical.
- `docs/chrome-web-store-submission.md`: update the section describing bundled `ffmpeg-core.js` under `vendor/` — the thin extension no longer bundles it (ffmpeg runs in the hosted tab).

(`AGENTS.md` are symlinks to `CLAUDE.md` — no separate edits.)

- [ ] **Step 3: Verify no stale live references remain**

Run the Step 1 grep again; confirm remaining hits are only in `docs/superpowers/**` (the spec/plan) or explicitly-historical notes.

- [ ] **Step 4: Prettier + commit**

```bash
npx prettier --write CLAUDE.md packages/webapp/CLAUDE.md packages/chrome-extension/CLAUDE.md docs
git add -A
git commit -m "docs: purge offscreen-era sandbox-iframe references

Sync docs with the thin-bridge extension: no sandbox.html/sprinkle-sandbox/
tool-ui-sandbox realms, no bundled vendor WASM/editor IIFEs. Closes #1504, #1339.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full-gate verification pass

- [ ] **Step 1: Run the complete pre-PR gate suite**

```bash
cd /Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/karl-changes
npm run lint
npm run typecheck
npm run test
npm run test:coverage        # each touched package must stay >= its floor in coverage-thresholds.json
npm run build                # up through cloudflare-worker (Swift stages skip: env has Swift 6.0.3 < 6.2)
npm run build:extension
npm run deadcode
bash packages/dev-tools/tools/check-extension-rhc.sh
```

Expected: all green. If `test:coverage` dips below a floor for `webapp` or `chrome-extension` (removing code can move ratios), add targeted regression coverage rather than lowering the floor.

- [ ] **Step 2: Confirm the extension shrank**

Run: `du -sh dist/extension && find dist/extension -maxdepth 2 \( -name '*sandbox*.html' -o -name 'magick.wasm' -o -name 'slicc-editor.js' -o -name 'slicc-diff.js' -o -name 'realm-vendor.js' -o -name 'buffer-polyfill.js' -o -name 'lucide-icons.js' -o -path '*pyodide*' -o -path '*vendor/ffmpeg*' \) -print`
Expected: total ~2 MB; the `find` prints nothing (all removed).

- [ ] **Step 3: Hand the manual CDP smoke checklist to the user**

Post this for the user to run (headed Chrome required; not runnable in the gate suite):

1. `npm run dev:extension:fresh` (builds ext `SLICC_EXT_DEV=1`, self-builds leader UI, wrangler `:8787`, Chrome for Testing CDP `:9333`).
2. In the pinned `http://localhost:8787/?slicc=leader` tab: `node -e "console.log(1+1)"`, run a `.jsh`, run a `workflow run` — all execute via the worker realm.
3. Render a sprinkle/dip in the leader tab — standalone sprinkle path unaffected.
4. Click the toolbar icon → the side-panel `?cherry=1&ui-only=1` follower connects (tri-state resolves to the live follower).
5. `ffmpeg -version` / `python3 -c` / `convert` in the leader tab still resolve via the hosted `dist/ui` WASM.

- [ ] **Step 4: Open the PR**

After gates are green (and ideally the manual smoke), push the branch and open a PR that closes #1504 and #1339, links the spec, and includes the manual smoke checklist + results in the description.
