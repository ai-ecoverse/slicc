# Cherry Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the extension's page-injected cherry sidebar with a Chrome side panel that hosts the cherry UI-only follower connected to the sticky hosted leader tab.

**Architecture:** The toolbar icon toggles a window-level side panel (Chrome-native `openPanelOnActionClick`). `sidepanel.html` (extension origin) iframes the hosted `?cherry=1&ui-only=1` follower and `mountSlicc`s it. The panel gets the leader's tray joinUrl from the service worker over an internal `cherry-panel` Port using a tri-state protocol (`booting`/`ready`/`disconnected`). The follower joins the leader's tray over WebRTC and mirrors chat; the agent drives whatever tab is active via the real `chrome.debugger` CDP bridge. Nothing is injected into third-party pages.

**Tech Stack:** TypeScript, Chrome MV3 (`chrome.sidePanel`, `chrome.runtime` Ports, `chrome.debugger`), Vitest (jsdom + node), esbuild (IIFE bundles via Vite `closeBundle`), Cloudflare Worker (tray hub), `@ai-ecoverse/cherry` `mountSlicc`.

**Spec:** `docs/superpowers/specs/2026-07-02-cherry-side-panel-design.md` (read it — it carries the rationale, the CSP/framing analysis, and the Load-Bearing Verifications).

## Global Constraints

- **Branch:** `worktree-feat+on-demand-cherry-sidebar` — rework PR #1287 in place. Do NOT create a new branch.
- **Thin extension:** no bundled UI / agent engine. The follower loads from the hosted origin inside an iframe. Only a minimal panel shell + wiring is bundled.
- **Dual-mode N/A:** side panel is extension-only. Standalone/CLI/Electron floats are untouched (cross-runtime parity note: N/A).
- **Reuse, do not reinvent:** cherry `mountSlicc` `iframe`/`uiOnly` (`packages/cherry/src/index.ts`), ui-only advertise suppression (`page-follower-tray.ts`/`wc-follower.ts`), the `leader.join-url` bridge (`extension-bridge-*.ts`, `page-leader-tray.ts`, `bridge-sw.ts`), the active-tab marker (`bridge-sw.ts`), and the `main-cherry.ts` `ancestorOrigins` handshake fix all stay as-is.
- **Chat-focused features (verbatim):** `SIDE_PANEL_FEATURES = { terminal: false, files: false, memory: false, browser: false, newSprinkle: false, monitor: false, modelPicker: true, history: true, nav: true }`.
- **Cherry capabilities (verbatim):** `{ navigate: false, screenshot: 'none', openUrl: false }`.
- **Tri-state joinUrl:** `booting` (spinner) / `ready` (+joinUrl → mount) / `disconnected` (teardown + iframe blank). Never conflate `booting` with `disconnected`.
- **iframe teardown:** `mountSlicc().destroy()` does NOT remove a caller-provided iframe — the panel MUST blank it (`iframe.src = 'about:blank'`) after every `destroy()` and before any remount.
- **Toggle:** committed primary is `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` (Chrome owns open/closed state; eviction-immune). The old `action.onClicked` cherry-injection listener is REMOVED. `ensureLeaderTab()` runs from the panel port-connect, not `onClicked`.
- **`declarativeNetRequestWithHostAccess` permission STAYS** (fetch proxy needs it). Only the static `dnr-frame-ancestors.json` rule resource is revisited.
- **Framing (committed mechanism (a)):** amend `resolveCherryFrameAncestors` so explicit `chrome-extension://…` origins survive a `*` list; config lists the extension origin. Remove the static DNR framing rule (in Task 8). The DNR remove/replace fallback (b) ships only if (a) is shown not to work in the harness (Task 7 verification).
- **`dev:extension:fresh` must connect end-to-end with zero manual steps** (same-origin local tray).
- **Gates before every commit:** `npx prettier --write <files>` (CI rejects unformatted). Full pre-push pass before the PR: `npm run lint:ci`, `npm run typecheck`, `npm run test`, `npm run test:coverage`, `npm run build`, `npm run build -w @slicc/chrome-extension`, `npm run deadcode`. Coverage must stay at/above each package's `coverage-thresholds.json` floor.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**Create:**

- `packages/chrome-extension/sidepanel.html` — panel shell (iframe container + status line).
- `packages/chrome-extension/src/sidepanel-entry.ts` — panel host: Port + tri-state state machine + `mountSlicc` + iframe teardown.
- `packages/chrome-extension/src/cherry-panel-protocol.ts` — shared types/consts: `CHERRY_PANEL_PORT_NAME`, `PanelToSwMessage`, `SwToPanelMessage`, `SIDE_PANEL_FEATURES`.
- `packages/chrome-extension/src/cherry-panel-sw.ts` — SW side: `cherry-panel` `onConnect` handler, tri-state joinUrl store, `ensureLeaderTab` on connect, broadcast, `handleLeaderTabRemoved` hook.

**Modify:**

- `packages/chrome-extension/manifest.json` — +`sidePanel` perm, +`side_panel.default_path`, +`minimum_chrome_version`, −`scripting`, − DNR rule resource (Task 6).
- `packages/chrome-extension/src/chrome.d.ts` — `chrome.sidePanel` typings.
- `packages/chrome-extension/src/service-worker.ts` — remove cherry-injection `onClicked` + relay `onConnect` + injection imports; wire `cherry-panel-sw`; `setPanelBehavior`; `handleLeaderTabRemoved` → broadcast disconnected.
- `packages/chrome-extension/vite.config.ts` — remove `buildRelayIsolatedPlugin`/`buildCherrySidebarMainPlugin`; add `buildSidePanelPlugin`; add `sidepanel.html` to the copy list.
- `packages/chrome-extension/package.json` (if a cherry-dep note is needed — cherry is already aliased from source in the build).
- `knip.json` — chrome-extension `entry`: −`relay-isolated.ts!`/`cherry-sidebar-main.ts!`, +`sidepanel-entry.ts!`.
- `packages/dev-tools/tools/dev-extension-fresh.sh` — same-origin local tray.
- `packages/cloudflare-worker/src/index.ts` — `resolveCherryFrameAncestors` amendment.
- `packages/cloudflare-worker/wrangler.jsonc` — `ALLOWED_CHERRY_HOST_ORIGINS` includes the extension origin.
- `docs/chrome-web-store-submission.md`, `packages/chrome-extension/CLAUDE.md`, `docs/architecture.md` — docs.

**Delete:**

- `packages/chrome-extension/src/relay-isolated.ts`, `src/cherry-relay-protocol.ts`, `src/cherry-sidebar-main.ts`, `src/cherry-sidebar-sw.ts`.
- `packages/chrome-extension/dnr-frame-ancestors.json` (deleted in Task 8 under mechanism (a); kept only if Task 7 verification forces fallback (b)).
- Their tests: `tests/cherry-sidebar-main.test.ts`, `tests/service-worker-cherry.test.ts`, any relay/inject tests.

---

## Task 1: Same-origin local tray in `dev:extension:fresh`

**Files:**

- Modify: `packages/dev-tools/tools/dev-extension-fresh.sh:172-190`
- Modify: `packages/chrome-extension/CLAUDE.md` (Local QA section)

**Why:** Today the harness forces the tray to deployed staging (`TRAY_WORKER_BASE_URL_OVERRIDE`), making the follower's tray fetch cross-origin → intercepted by `llm-proxy-sw` → `/api/fetch-proxy` (absent on a worker-served app) → follower never connects. A same-origin local tray (`wrangler dev --env staging`, whose `routes: []` makes `url.origin = localhost:8787`) fixes it and is a prerequisite for the Load-Bearing Verifications.

- [ ] **Step 1: Change the wrangler launch to a same-origin local tray.**

In `dev-extension-fresh.sh`, the `else` branch (`STARTED_WRANGLER`) currently runs:

```bash
  npx wrangler dev \
    --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
    --port "$WRANGLER_PORT" --ip 127.0.0.1 \
    --var "GITHUB_CLIENT_ID:${STAGING_GH_CLIENT_ID}" \
    --var "TRAY_WORKER_BASE_URL_OVERRIDE:${STAGING_WORKER}" &
```

Replace with (drop the staging override; use the `staging` env so `routes: []` → `url.origin = localhost:8787`; add the dev extension origin to the cherry framing allowlist so the follower can be framed by the panel — Task 6's mechanism (a)):

```bash
  npx wrangler dev \
    --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
    --env staging \
    --port "$WRANGLER_PORT" --ip 127.0.0.1 \
    --var "GITHUB_CLIENT_ID:${STAGING_GH_CLIENT_ID}" \
    --var "ALLOWED_CHERRY_HOST_ORIGINS:* chrome-extension://bdgicfcdbgckhdcpklcefkogmahcogbd" &
```

(The dev extension id `bdgicfcdbgckhdcpklcefkogmahcogbd` is path-derived from the fixed `/tmp/slicc-ext-build` load path; confirm it in the harness via `/json/list` and correct if different.)

**Reuse-branch guard.** The `if wrangler_up` reuse branch (`dev-extension-fresh.sh:176`) reuses ANY wrangler already on `:8787` — which could be a stale wrong-config instance (e.g. a staging-override one from another worktree). Add a validation after the reuse log line: fetch `http://127.0.0.1:${WRANGLER_PORT}/api/runtime-config` and, if `trayWorkerBaseUrl` is NOT `http://localhost:8787`, print a loud warning telling the user to kill the stale wrangler and re-run (do not silently proceed against a cross-origin tray):

```bash
  # Query via localhost (the worker echoes the request host into
  # trayWorkerBaseUrl, so 127.0.0.1 would report 127.0.0.1 and false-warn).
  RC="$(curl -s "http://localhost:${WRANGLER_PORT}/api/runtime-config" 2>/dev/null || true)"
  if printf '%s' "$RC" | grep -qiE 'workers\.dev|sliccy\.ai'; then
    echo "⚠️  Reused wrangler points the tray at a REMOTE origin (cross-origin) — the cherry"
    echo "    panel follower can't connect. Kill it (pkill -f 'wrangler dev') and re-run."
  fi
```

- [ ] **Step 2: Run the harness and verify the tray is local same-origin.**

```bash
npm run dev:extension:fresh
# in another shell, once ready:
curl -s http://localhost:8787/api/runtime-config
```

Expected: `"trayWorkerBaseUrl":"http://localhost:8787"` (NOT staging).

```bash
curl -s -X POST 'http://localhost:8787/tray?json=true' -H 'content-type: application/json' --data-raw '{}'
```

Expected: `capabilities.join.url` begins `http://localhost:8787/join/` (NOT `www.sliccy.ai`).

- [ ] **Step 3: Confirm the leader becomes an active tray leader (manual, CDP).**

With the harness up, the pinned leader tab (`http://localhost:8787/?slicc=leader&ext=<id>`) should reach `leaderTrayStatus.state === 'leader'` with a `http://localhost:8787/join/...` joinUrl. Verify by evaluating `localStorage.getItem('slicc.leaderTrayStatus')` in the leader tab over CDP (`SLICC_CDP_PORT=9333 node packages/dev-tools/tools/slicc-debug.mjs ...`). Reload the leader once if it booted before wrangler was ready.

- [ ] **Step 4: Document it in `packages/chrome-extension/CLAUDE.md`.**

Update the "Local QA" / `dev:extension:fresh` section to state the harness now runs a same-origin local tray via `--env staging` (no staging override), and why (cross-origin tray + `llm-proxy-sw` → `/api/fetch-proxy` dead-end).

- [ ] **Step 5: Commit.**

```bash
npx prettier --write packages/chrome-extension/CLAUDE.md
git add packages/dev-tools/tools/dev-extension-fresh.sh packages/chrome-extension/CLAUDE.md
git commit -m "fix(dev): dev:extension:fresh runs a same-origin local tray

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Cherry-panel protocol module + `chrome.sidePanel` typings

**Files:**

- Create: `packages/chrome-extension/src/cherry-panel-protocol.ts`
- Modify: `packages/chrome-extension/src/chrome.d.ts`
- Test: `packages/chrome-extension/tests/cherry-panel-protocol.test.ts`

**Interfaces produced (used by Tasks 4 & 5):**

- `CHERRY_PANEL_PORT_NAME = 'cherry-panel'`
- `type PanelToSwMessage = { kind: 'hello'; windowId: number }`
- `type SwToPanelMessage = { kind: 'join-url'; state: 'booting' } | { kind: 'join-url'; state: 'ready'; joinUrl: string } | { kind: 'join-url'; state: 'disconnected' }`
- `SIDE_PANEL_FEATURES: CherryFeatures` (the verbatim chat-focused object)

- [ ] **Step 1: Write the failing test.**

`packages/chrome-extension/tests/cherry-panel-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHERRY_PANEL_PORT_NAME, SIDE_PANEL_FEATURES } from '../src/cherry-panel-protocol.js';

describe('cherry-panel-protocol', () => {
  it('names the internal panel port', () => {
    expect(CHERRY_PANEL_PORT_NAME).toBe('cherry-panel');
  });
  it('SIDE_PANEL_FEATURES is the chat-focused set (kernel panels off, chrome on)', () => {
    expect(SIDE_PANEL_FEATURES).toEqual({
      terminal: false,
      files: false,
      memory: false,
      browser: false,
      newSprinkle: false,
      monitor: false,
      modelPicker: true,
      history: true,
      nav: true,
    });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**

Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-protocol.test.ts`
Expected: FAIL (cannot resolve `../src/cherry-panel-protocol.js`).

- [ ] **Step 3: Create the protocol module.**

`packages/chrome-extension/src/cherry-panel-protocol.ts`:

```ts
/**
 * Shared contract for the side-panel cockpit: the internal `cherry-panel` Port
 * between the sidepanel page and the service worker, and the chat-focused
 * feature set the panel mounts the follower with.
 */
import type { CherryFeatures } from '@ai-ecoverse/cherry';

/** Internal (same-extension) Port name used by the side panel. */
export const CHERRY_PANEL_PORT_NAME = 'cherry-panel';

/** Panel → SW: sent once on (re)connect so the SW can key open-state by window. */
export interface PanelHelloMessage {
  kind: 'hello';
  windowId: number;
}
export type PanelToSwMessage = PanelHelloMessage;

/** SW → panel: tri-state joinUrl status. */
export type SwToPanelMessage =
  | { kind: 'join-url'; state: 'booting' }
  | { kind: 'join-url'; state: 'ready'; joinUrl: string }
  | { kind: 'join-url'; state: 'disconnected' };

/**
 * Chat-focused sidebar: kernel-backed panels (terminal/files/memory) are inert
 * in a follower and the browser panel is redundant (the agent drives the tab via
 * real chrome.debugger CDP). `CherryFeatures` fields default to true, so hidden
 * panels must be set false explicitly.
 */
export const SIDE_PANEL_FEATURES: CherryFeatures = {
  terminal: false,
  files: false,
  memory: false,
  browser: false,
  newSprinkle: false,
  monitor: false,
  modelPicker: true,
  history: true,
  nav: true,
};
```

- [ ] **Step 4: Run the test — expect PASS.**

Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-protocol.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `chrome.sidePanel` typings to `chrome.d.ts`.**

Add a `ChromeSidePanelAPI` interface and a `sidePanel` member on `ChromeAPI` (place near `ChromeActionAPI`). Feature-detected members (`close`, `onOpened`, `onClosed`) are optional so older-Chrome fallback code type-checks:

```ts
interface ChromeSidePanelAPI {
  setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  open(options: { windowId?: number; tabId?: number }): Promise<void>;
  /** Chrome 141+. */
  close?(options: { windowId?: number }): Promise<void>;
  /** Chrome 141+. */
  onOpened?: { addListener(cb: (info: { windowId: number }) => void): void };
  /** Chrome 142+. */
  onClosed?: { addListener(cb: (info: { windowId: number }) => void): void };
}
```

Add to the `ChromeAPI` interface body: `sidePanel: ChromeSidePanelAPI;`.

- [ ] **Step 6: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (no new errors; the browser bundle typecheck covers `chrome.d.ts` via the extension config).

- [ ] **Step 7: Commit.**

```bash
npx prettier --write packages/chrome-extension/src/cherry-panel-protocol.ts packages/chrome-extension/src/chrome.d.ts packages/chrome-extension/tests/cherry-panel-protocol.test.ts
git add packages/chrome-extension/src/cherry-panel-protocol.ts packages/chrome-extension/src/chrome.d.ts packages/chrome-extension/tests/cherry-panel-protocol.test.ts
git commit -m "feat(extension): cherry-panel protocol + chrome.sidePanel typings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Manifest — add `sidePanel` permission, `side_panel`, `minimum_chrome_version`

**Files:**

- Modify: `packages/chrome-extension/manifest.json`
- Modify: `docs/chrome-web-store-submission.md` (add `sidePanel` row)
- Test: `packages/chrome-extension/tests/manifest-sidepanel.test.ts`

**Note:** `scripting` is NOT removed here — the SW still calls `chrome.scripting.executeScript` until the injection code is deleted. Dropping `scripting` (and evaluating `activeTab`) happens in the removal task (Task 8), after the injection paths are gone, so manifest and code stay consistent at every step. `check-manifest-justifications.sh` (CI lint) requires every permission justified in `docs/chrome-web-store-submission.md`; add the `sidePanel` row now (Step 3b) so the lint passes mid-plan.

- [ ] **Step 1: Write the failing test.**

`packages/chrome-extension/tests/manifest-sidepanel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest side panel', () => {
  it('declares the sidePanel permission', () => {
    expect(manifest.permissions).toContain('sidePanel');
  });
  it('registers the default side panel path', () => {
    expect((manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path).toBe(
      'sidepanel.html'
    );
  });
  it('sets a minimum_chrome_version >= 116 (sidePanel.open availability)', () => {
    const v = Number((manifest as { minimum_chrome_version?: string }).minimum_chrome_version);
    expect(v).toBeGreaterThanOrEqual(116);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npx vitest run packages/chrome-extension/tests/manifest-sidepanel.test.ts`
Expected: FAIL (`sidePanel` missing / no `side_panel` / no `minimum_chrome_version`).

- [ ] **Step 3: Edit `manifest.json`.**

- In `"permissions"`, add `"sidePanel"`. **Keep** `"scripting"`, `"activeTab"`, and `"declarativeNetRequestWithHostAccess"` for now.
- Add top-level `"minimum_chrome_version": "116"` (Side Panel API is 114+ but `sidePanel.open()` is 116+; `close()`/`onOpened` 141+ and `onClosed` 142+ stay optional/feature-detected in `chrome.d.ts`).
- Add top-level `"side_panel": { "default_path": "sidepanel.html" }`.
- **Create a placeholder `packages/chrome-extension/sidepanel.html`** so `default_path` resolves to a real file at this commit (Task 4 replaces it with the real shell + build). Also add `'sidepanel.html'` to the `vite.config.ts` static-asset copy list now, so the built extension is loadable after Task 3. Minimal placeholder:
  ```html
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>SLICC</title>
    </head>
    <body>
      Loading…
    </body>
  </html>
  ```

(Leave the `declarative_net_request.rule_resources` block — Task 8 removes the framing rule under mechanism (a), after Task 7 verifies (a) works.)

- [ ] **Step 3b: Add the `sidePanel` justification row** to `docs/chrome-web-store-submission.md` so `check-manifest-justifications.sh` passes now (Task 9 reconciles the full doc). Run `bash packages/dev-tools/tools/check-manifest-justifications.sh` — expect PASS.

- [ ] **Step 4: Run the test — expect PASS.**

Run: `npx vitest run packages/chrome-extension/tests/manifest-sidepanel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
npx prettier --write packages/chrome-extension/manifest.json packages/chrome-extension/tests/manifest-sidepanel.test.ts docs/chrome-web-store-submission.md packages/chrome-extension/vite.config.ts
git add packages/chrome-extension/manifest.json packages/chrome-extension/tests/manifest-sidepanel.test.ts docs/chrome-web-store-submission.md packages/chrome-extension/sidepanel.html packages/chrome-extension/vite.config.ts
git commit -m "feat(extension): manifest sidePanel permission + side_panel path + min_chrome 116

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Side-panel host — `sidepanel.html` + `sidepanel-entry.ts` (tri-state state machine) + build wiring

**Files:**

- Create: `packages/chrome-extension/sidepanel.html`
- Create: `packages/chrome-extension/src/sidepanel-entry.ts`
- Modify: `packages/chrome-extension/vite.config.ts` (add `buildSidePanelPlugin`; add `sidepanel.html` to copy list)
- Modify: `knip.json` (add `src/sidepanel-entry.ts!`)
- Test: `packages/chrome-extension/tests/sidepanel-entry.test.ts`

**Interfaces:**

- Consumes: `CHERRY_PANEL_PORT_NAME`, `PanelToSwMessage`, `SwToPanelMessage`, `SIDE_PANEL_FEATURES` (Task 2); `mountSlicc` (`@ai-ecoverse/cherry`).
- Produces: `createSidePanelController(deps)` (exported for tests) with `{ dispose(): void }`; a side-effect boot at module end that calls it with real deps.

**Design:** `sidepanel-entry.ts` factors a testable `createSidePanelController` that takes injectable deps (`connect`, `mountSlicc`, the iframe element, a status setter, `sliccOrigin`, `windowId`). It connects the Port, sends `hello`, and runs the tri-state machine: `booting` → status "starting…", no mount; `ready` → if joinUrl differs, `destroy()` + blank iframe + `mountSlicc(...)`, status "connected"; identical `ready` → no-op; `disconnected` → `destroy()` + blank iframe + status "disconnected". On `port.onDisconnect` → reconnect with backoff + re-send `hello`.

- [ ] **Step 1: Write the failing test** (jsdom; mocks `@ai-ecoverse/cherry` + a fake Port).

`packages/chrome-extension/tests/sidepanel-entry.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createSidePanelController } from '../src/sidepanel-entry.js';
import type { SwToPanelMessage } from '../src/cherry-panel-protocol.js';

function makePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const disc: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (cb: (m: unknown) => void) => listeners.push(cb),
      removeListener: vi.fn(),
    },
    onDisconnect: { addListener: (cb: () => void) => disc.push(cb) },
    _emit: (m: SwToPanelMessage) => listeners.forEach((l) => l(m)),
    _drop: () => disc.forEach((d) => d()),
  };
}

describe('sidepanel-entry controller', () => {
  let iframe: HTMLIFrameElement;
  let statuses: string[];
  let mountSlicc: Mock;
  let destroy: Mock;
  let srcAtMount: string[]; // iframe.src observed at each mountSlicc call
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mountOpts: any[]; // options passed to each mountSlicc call (incl. hooks)
  let port: ReturnType<typeof makePort>;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    statuses = [];
    destroy = vi.fn();
    srcAtMount = [];
    mountOpts = [];
    // Capture iframe.src AT mount time (proves blank-before-remount ordering:
    // destroy() does not clear caller iframes) and the mount options (so tests
    // can drive hooks.onSliccEvent).
    mountSlicc = vi.fn((opts) => {
      srcAtMount.push(iframe.getAttribute('src') ?? '');
      mountOpts.push(opts);
      return { iframe, emitHostEvent: vi.fn(), destroy };
    });
    port = makePort();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const make = () =>
    createSidePanelController({
      connect: () => port as never,
      mountSlicc: mountSlicc as never,
      iframe,
      setStatus: (s) => statuses.push(s),
      sliccOrigin: 'https://www.sliccy.ai',
      windowId: 7,
    });

  it('sends hello with windowId on connect', () => {
    make();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'hello', windowId: 7 });
  });

  it('booting → spinner, no mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'booting' });
    expect(mountSlicc).not.toHaveBeenCalled();
    expect(statuses).toContain('starting');
  });

  it('ready → mounts with uiOnly + chat features + joinToken', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(mountSlicc).toHaveBeenCalledWith(
      expect.objectContaining({
        iframe,
        joinToken: 'https://tray/join/t.s',
        uiOnly: true,
        sliccOrigin: 'https://www.sliccy.ai',
        capabilities: { navigate: false, screenshot: 'none', openUrl: false },
        features: {
          terminal: false,
          files: false,
          memory: false,
          browser: false,
          newSprinkle: false,
          monitor: false,
          modelPicker: true,
          history: true,
          nav: true,
        },
      })
    );
  });

  it('status is driven by follower slicc events, not by mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    // After mount, still "starting" — the follower has not connected to the tray yet.
    expect(statuses[statuses.length - 1]).toBe('starting');
    // Follower connects → connected.
    mountOpts[0].hooks.onSliccEvent('slicc.follower.ready');
    expect(statuses[statuses.length - 1]).toBe('connected');
    // Follower drops → back to the spinner (reconnecting), not teardown.
    mountOpts[0].hooks.onSliccEvent('slicc.follower.disconnected');
    expect(statuses[statuses.length - 1]).toBe('starting');
  });

  it('duplicate identical ready is a no-op (no remount)', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(mountSlicc).toHaveBeenCalledTimes(1);
  });

  it('ready → booting → same ready: no remount, status returns to connected (post-eviction blip)', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'booting' }); // SW cache lost on eviction
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' }); // replay
    expect(mountSlicc).toHaveBeenCalledTimes(1); // NOT remounted
    expect(statuses[statuses.length - 1]).toBe('connected'); // spinner cleared
  });

  it('new ready joinUrl remounts: destroy + blank-BEFORE-mount + mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/a.1' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/b.2' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(mountSlicc).toHaveBeenCalledTimes(2);
    // The 2nd mount must have observed the blanked iframe (ordering proof: the
    // stale follower was cleared before the new one mounted).
    expect(srcAtMount[1]).toBe('about:blank');
  });

  it('disconnected → destroy + blank iframe + disconnected status', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'disconnected' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(statuses).toContain('disconnected');
  });

  it('reconnects (new port + re-sends hello) after the port drops', () => {
    vi.useFakeTimers();
    const ports = [makePort(), makePort()];
    let i = 0;
    createSidePanelController({
      connect: () => ports[i++] as never,
      mountSlicc: mountSlicc as never,
      iframe,
      setStatus: (s) => statuses.push(s),
      sliccOrigin: 'https://www.sliccy.ai',
      windowId: 7,
    });
    expect(ports[0].postMessage).toHaveBeenCalledWith({ kind: 'hello', windowId: 7 });
    ports[0]._drop(); // SW evicted / restarted
    vi.advanceTimersByTime(300); // backoff
    expect(ports[1].postMessage).toHaveBeenCalledWith({ kind: 'hello', windowId: 7 });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**

Run: `npx vitest run packages/chrome-extension/tests/sidepanel-entry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `sidepanel-entry.ts`.**

```ts
/// <reference path="./chrome.d.ts" />
import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import {
  CHERRY_PANEL_PORT_NAME,
  SIDE_PANEL_FEATURES,
  type SwToPanelMessage,
} from './cherry-panel-protocol.js';

// Production hosted origin for the follower iframe; DEV → local wrangler.
declare const __SLICC_EXT_DEV__: boolean;
const sliccOriginDefault = __SLICC_EXT_DEV__ ? 'http://localhost:8787' : 'https://www.sliccy.ai';

export interface SidePanelDeps {
  connect: () => ChromeRuntimePort;
  mountSlicc: typeof mountSlicc;
  iframe: HTMLIFrameElement;
  setStatus: (s: 'starting' | 'connected' | 'disconnected') => void;
  sliccOrigin: string;
  windowId: number;
}

export function createSidePanelController(deps: SidePanelDeps): { dispose(): void } {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectDelay = 250;

  const blankIframe = () => {
    deps.iframe.setAttribute('src', 'about:blank');
  };
  const teardown = () => {
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    blankIframe();
  };

  const onMessage = (raw: unknown) => {
    const msg = raw as SwToPanelMessage;
    if (!msg || msg.kind !== 'join-url') return;
    if (msg.state === 'booting') {
      deps.setStatus('starting');
      return;
    }
    if (msg.state === 'disconnected') {
      teardown();
      deps.setStatus('disconnected');
      return;
    }
    // state === 'ready'
    if (msg.joinUrl === currentJoinUrl && handle) {
      // Idempotent: same joinUrl, follower already mounted. Restore 'connected'
      // — a `booting` blip (e.g. SW eviction) may have shown the spinner over a
      // perfectly valid follower.
      deps.setStatus('connected');
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe(); // clear the stale follower before remount (destroy() keeps caller iframes)
    currentJoinUrl = msg.joinUrl;
    // Status stays 'starting' (spinner) until the follower actually connects to
    // the leader over the tray. The hosted follower emits `slicc.follower.ready`
    // / `slicc.follower.disconnected` (wc-follower.ts), surfaced here via
    // `hooks.onSliccEvent` — that, not "mount happened", is what flips to
    // 'connected'.
    deps.setStatus('starting');
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
      hooks: {
        onSliccEvent: (name: string) => {
          if (name === 'slicc.follower.ready') deps.setStatus('connected');
          else if (name === 'slicc.follower.disconnected') deps.setStatus('starting');
        },
      },
    });
    reconnectDelay = 250;
  };

  const wire = () => {
    port = deps.connect();
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      setTimeout(() => {
        if (!disposed) wire();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    port.postMessage({ kind: 'hello', windowId: deps.windowId });
  };

  wire();

  return {
    dispose() {
      disposed = true;
      teardown();
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

// --- boot (skipped under test: no chrome.runtime / import path differs) ---
if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
  const iframe = document.getElementById('cherry-follower') as HTMLIFrameElement;
  const statusEl = document.getElementById('cherry-status');
  const setStatus = (s: 'starting' | 'connected' | 'disconnected') => {
    if (!statusEl) return;
    statusEl.textContent =
      s === 'connected'
        ? ''
        : s === 'starting'
          ? 'Starting SLICC…'
          : 'Disconnected — reopen to retry';
    statusEl.dataset.state = s;
  };
  chrome.windows.getCurrent().then((w) => {
    createSidePanelController({
      connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
      mountSlicc,
      iframe,
      setStatus,
      sliccOrigin: sliccOriginDefault,
      windowId: w.id ?? 0,
    });
  });
}
```

- [ ] **Step 4: Run the test — expect PASS (all cases).**

Run: `npx vitest run packages/chrome-extension/tests/sidepanel-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the Task-3 placeholder `sidepanel.html` with the real shell.**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SLICC</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #1e1e1e;
      }
      #cherry-follower {
        border: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      #cherry-status {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        color: #aaa;
        font: 14px system-ui;
      }
      #cherry-status[data-state='starting'],
      #cherry-status[data-state='disconnected'] {
        display: flex;
      }
    </style>
  </head>
  <body>
    <div id="cherry-status" data-state="starting">Starting SLICC…</div>
    <iframe
      id="cherry-follower"
      allow="camera; microphone; clipboard-read; clipboard-write"
    ></iframe>
    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Add the esbuild build plugin + copy list entry in `vite.config.ts`.**

Add a plugin mirroring `buildCherrySidebarMainPlugin` (bundle cherry from source, external html2canvas, `__SLICC_EXT_DEV__` define, raw SVG plugin):

```ts
function buildSidePanelPlugin() {
  return {
    name: 'build-sidepanel',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        format: 'esm', // sidepanel.html loads it as type="module"
        entryPoints: [resolve(Dirname, 'src/sidepanel-entry.ts')],
        outfile: resolve(outDir, 'sidepanel.js'),
        alias: {
          '@ai-ecoverse/cherry': resolve(repoRoot, 'packages/cherry/src/index.ts'),
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
        external: ['html2canvas-pro'],
        plugins: [rawSvgEsbuildPlugin()],
        define: { ...PROD_IIFE_DEFAULTS.define, __SLICC_EXT_DEV__: JSON.stringify(isExtDev) },
      });
    },
  };
}
```

Register it in the plugins array where `buildCherrySidebarMainPlugin()` / `buildRelayIsolatedPlugin()` are listed (those two are removed in Task 8). (`'sidepanel.html'` was already added to the static-asset copy-list array in Task 3 Step 3 — verify it's present, ~line 388-397.)

> Note: verify `PROD_IIFE_DEFAULTS` allows a `format` override; if it hardcodes `format: 'iife'`, spread then override as shown. If the module-vs-IIFE distinction causes issues, drop `format` (default) and change `sidepanel.html`'s `<script>` to a plain `<script src="sidepanel.js">` — an IIFE runs fine there. Pick whichever the harness loads cleanly (Task 7 confirms).

- [ ] **Step 7: Register the knip entry.**

In `knip.json`, under `packages/chrome-extension` → `entry`, add `"src/sidepanel-entry.ts!"`. (The old `relay-isolated.ts!`/`cherry-sidebar-main.ts!` entries are removed in Task 8.)

- [ ] **Step 8: Build the extension + verify assets emitted.**

Run: `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`
Expected: `dist/extension/sidepanel.html` and `dist/extension/sidepanel.js` exist; build exits 0.

- [ ] **Step 9: Commit.**

```bash
npx prettier --write packages/chrome-extension/src/sidepanel-entry.ts packages/chrome-extension/sidepanel.html packages/chrome-extension/vite.config.ts knip.json packages/chrome-extension/tests/sidepanel-entry.test.ts
git add packages/chrome-extension/src/sidepanel-entry.ts packages/chrome-extension/sidepanel.html packages/chrome-extension/vite.config.ts knip.json packages/chrome-extension/tests/sidepanel-entry.test.ts
git commit -m "feat(extension): side-panel host (sidepanel.html + tri-state entry) + build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: SW cherry-panel wiring (tri-state store, ensure-leader, broadcast) + toggle

**Files:**

- Create: `packages/chrome-extension/src/cherry-panel-sw.ts`
- Modify: `packages/chrome-extension/src/service-worker.ts`
- Test: `packages/chrome-extension/tests/cherry-panel-sw.test.ts`

**Interfaces:**

- Consumes: `CHERRY_PANEL_PORT_NAME`, `SwToPanelMessage`, `PanelToSwMessage` (Task 2); the SW's existing `ensureLeaderTab` + `leader.join-url` delivery (`onLeaderJoinUrl` callback in `service-worker.ts:1183`).
- Produces:
  - `handleCherryPanelConnect(port, deps)` — registers a panel port, ensures the leader, replies with current tri-state, tracks the port by windowId.
  - `setCherryPanelJoinUrl(joinUrl: string | null)` — called from the leader `onLeaderJoinUrl` path: `string` → `ready` broadcast; `null` → `disconnected` broadcast. Before the first non-null it stays `booting`.
  - `broadcastLeaderGone()` — called from `handleLeaderTabRemoved`: sets `disconnected` and broadcasts.
  - `getPanelState()` (for tests).

**Design:** module-level `panelPorts: Set<ChromeRuntimePort>` and `state: SwToPanelMessage`. Default `{ kind:'join-url', state:'booting' }`. On connect: push current `state`, call `ensureLeaderTab()`. On `setCherryPanelJoinUrl(url)`: update `state` to `ready`/`disconnected`, broadcast to all ports. This **replaces** the old `cachedLeaderJoinUrl` + relay-port fanout in `cherry-sidebar-sw.ts`.

- [ ] **Step 1: Write the failing test** (node env; fake ports).

`packages/chrome-extension/tests/cherry-panel-sw.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastLeaderGone,
  getPanelState,
  handleCherryPanelConnect,
  resetCherryPanelState,
  setCherryPanelJoinUrl,
} from '../src/cherry-panel-sw.js';

function fakePort() {
  const msgs: unknown[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  let onDisc: (() => void) | undefined;
  return {
    _sent: msgs,
    _rx: (m: unknown) => onMsg?.(m),
    _drop: () => onDisc?.(),
    postMessage: (m: unknown) => msgs.push(m),
    disconnect: vi.fn(),
    onMessage: { addListener: (cb: (m: unknown) => void) => (onMsg = cb), removeListener: vi.fn() },
    onDisconnect: { addListener: (cb: () => void) => (onDisc = cb) },
  };
}

describe('cherry-panel-sw', () => {
  beforeEach(() => resetCherryPanelState());

  it('on connect: ensures the leader and replies with current state (booting)', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    p._rx({ kind: 'hello', windowId: 3 });
    expect(ensureLeaderTab).toHaveBeenCalledTimes(1);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
  });

  it('setCherryPanelJoinUrl(string) broadcasts ready to connected panels', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
    setCherryPanelJoinUrl('https://tray/join/t.s');
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/t.s',
    });
    expect(getPanelState()).toEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/t.s',
    });
  });

  it('setCherryPanelJoinUrl(null) → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
    setCherryPanelJoinUrl('https://tray/join/t.s');
    setCherryPanelJoinUrl(null);
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('broadcastLeaderGone → disconnected', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._rx({ kind: 'hello', windowId: 3 });
    broadcastLeaderGone();
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'disconnected' });
  });

  it('a late-connecting panel gets the latest state (ready)', async () => {
    setCherryPanelJoinUrl('https://tray/join/late.9');
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/late.9',
    });
  });

  it('drops the port from the set on disconnect (no throw on later broadcast)', async () => {
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    p._drop();
    expect(() => setCherryPanelJoinUrl('https://tray/join/x.1')).not.toThrow();
  });

  it('reconnect after disconnected transitions back to booting (not stuck disconnected)', async () => {
    broadcastLeaderGone(); // global state = disconnected
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab: vi.fn(async () => {}) });
    // the freshly connected panel is told booting, not disconnected
    expect(p._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
    expect(getPanelState()).toEqual({ kind: 'join-url', state: 'booting' });
  });

  it('records the panel windowId from hello (used by the fallback toggle path)', async () => {
    const ensureLeaderTab = vi.fn(async () => {});
    const p = fakePort();
    await handleCherryPanelConnect(p as never, { ensureLeaderTab });
    p._rx({ kind: 'hello', windowId: 42 });
    // A later broadcast still reaches the (windowId-tagged) port without throwing.
    expect(() => setCherryPanelJoinUrl('https://tray/join/y.2')).not.toThrow();
    expect(p._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://tray/join/y.2',
    });
  });

  it('recovers a tray-gave-up disconnected by reloading the existing leader once', async () => {
    broadcastLeaderGone(); // disconnected while the leader tab still exists (null from gave-up)
    const ensureLeaderTab = vi.fn(async () => {}); // no-op: tab exists
    const reloadLeaderTabIfExists = vi.fn(async () => true);
    const p1 = fakePort();
    await handleCherryPanelConnect(p1 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1); // forced a fresh tray join
    // A second connect in the same disconnected episode does NOT reload again.
    const p2 = fakePort();
    await handleCherryPanelConnect(p2 as never, { ensureLeaderTab, reloadLeaderTabIfExists });
    expect(reloadLeaderTabIfExists).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**

Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-sw.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `cherry-panel-sw.ts`.**

```ts
/// <reference path="./chrome.d.ts" />
import type { PanelToSwMessage, SwToPanelMessage } from './cherry-panel-protocol.js';

/** Connected side-panel ports → their windowId (undefined until `hello`). */
const panelPorts = new Map<ChromeRuntimePort, number | undefined>();

/** Current tri-state, broadcast to panels; defaults to booting. */
let state: SwToPanelMessage = { kind: 'join-url', state: 'booting' };

/** Guards leader reload to at most once per `disconnected` episode. */
let recoveredThisEpisode = false;

/** Test-only reset. */
export function resetCherryPanelState(): void {
  panelPorts.clear();
  state = { kind: 'join-url', state: 'booting' };
  recoveredThisEpisode = false;
}

export function getPanelState(): SwToPanelMessage {
  return state;
}

function broadcast(): void {
  for (const port of [...panelPorts.keys()]) {
    try {
      port.postMessage(state);
    } catch {
      panelPorts.delete(port);
    }
  }
}

export interface CherryPanelConnectDeps {
  ensureLeaderTab: () => Promise<void>;
  /**
   * Reload the leader tab IF it already exists (returns true if reloaded). Used
   * to recover from a tray reconnect-gave-up (`leader.join-url: null`) while the
   * tab still exists: `ensureLeaderTab()` no-ops then, so nothing re-delivers a
   * joinUrl and the panel would sit at `booting` forever. Optional so existing
   * tests need not pass it.
   */
  reloadLeaderTabIfExists?: () => Promise<boolean>;
}

/**
 * Register a `cherry-panel` port: ensure the leader tab exists (so it becomes a
 * tray leader and delivers `leader.join-url`), and push the current tri-state to
 * this port immediately. The panel sends `{ kind:'hello', windowId }`, recorded
 * per port (informational under the native toggle; used by the fallback toggle
 * path). A fresh connection means we are (re)ensuring the leader, so if we were
 * `disconnected` we move back to `booting` — otherwise a panel that reopens after
 * the leader was closed would show a stale "disconnected" while the leader comes
 * back up.
 */
export async function handleCherryPanelConnect(
  port: ChromeRuntimePort,
  deps: CherryPanelConnectDeps
): Promise<void> {
  panelPorts.set(port, undefined);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelToSwMessage;
    if (msg?.kind === 'hello' && typeof msg.windowId === 'number') {
      panelPorts.set(port, msg.windowId);
    }
  });
  const wasDisconnected = state.state === 'disconnected';
  if (wasDisconnected) {
    state = { kind: 'join-url', state: 'booting' };
    broadcast(); // move any other stale panels back to the spinner too
  }
  port.postMessage(state); // replay current status to the fresh port
  await deps.ensureLeaderTab(); // creates the leader if it was closed → fresh joinUrl
  if (wasDisconnected && !recoveredThisEpisode) {
    // `disconnected` may also come from `leader.join-url: null` (tray reconnect
    // gave up) while the tab still exists — reload it once to force a fresh tray
    // join + joinUrl. Bounded to one reload per disconnected episode.
    recoveredThisEpisode = true;
    await deps.reloadLeaderTabIfExists?.();
  }
}

/** Leader delivered a joinUrl (string) or dropped its tray (null). */
export function setCherryPanelJoinUrl(joinUrl: string | null): void {
  state = joinUrl
    ? { kind: 'join-url', state: 'ready', joinUrl }
    : { kind: 'join-url', state: 'disconnected' };
  recoveredThisEpisode = false; // new episode (ready clears it; a fresh null re-arms recovery)
  broadcast();
}

/** Leader tab was removed → tell panels. */
export function broadcastLeaderGone(): void {
  state = { kind: 'join-url', state: 'disconnected' };
  recoveredThisEpisode = false; // fresh disconnected episode → allow one recovery reload
  broadcast();
}
```

- [ ] **Step 4: Run the test — expect PASS (all cases).**

Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-sw.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `service-worker.ts`.**

- Replace the cherry-sidebar-sw imports (lines ~41-51: `CHERRY_RELAY_PORT_NAME`, `onLeaderJoinUrl as cherryOnLeaderJoinUrl`, `handleCherryRelayConnect`, `toggleCherryTab`, `canInjectInto`, `readActivatedTabs`, `writeActivatedTabs`, `cherryHandleTabRemoved`, …) with:
  ```ts
  import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';
  import {
    broadcastLeaderGone,
    handleCherryPanelConnect,
    setCherryPanelJoinUrl,
  } from './cherry-panel-sw.js';
  ```
- **Toggle:** at top-level SW init (near where listeners are registered), add:
  ```ts
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[slicc-sw] setPanelBehavior failed', err));
  ```
- **Remove** the `chrome.action.onClicked` cherry-injection listener (lines ~353-370: the `canInjectInto`/`toggleCherryTab` block). Remove the listener entirely (native toggle replaces it; do NOT keep `toggleCherryTab`).
- **Remove the `tabs.onUpdated` cherry re-injection listener** (~`service-worker.ts:310`, the `status === 'complete'` → re-inject-if-tracked block, and its `handleTabUpdated` helper if now unused). Nothing re-injects into pages anymore.
- **`onLeaderJoinUrl` callback** (line ~1183): replace the `cherryOnLeaderJoinUrl(...)` body with `setCherryPanelJoinUrl(joinUrl)`:
  ```ts
  onLeaderJoinUrl: (joinUrl /* , tabId */) => {
    setCherryPanelJoinUrl(joinUrl);
  },
  ```
- **`handleLeaderTabRemoved`** (line ~294): after clearing the stored id, call `broadcastLeaderGone()`:
  ```ts
  async function handleLeaderTabRemoved(tabId: number): Promise<void> {
    const storedId = await readStoredLeaderTabId();
    if (storedId !== tabId) return;
    await clearStoredLeaderTabId();
    broadcastLeaderGone();
  }
  ```
  Also drop the `cherryHandleTabRemoved(tabId)` call in the `tabs.onRemoved` listener.
- **`onConnect`** (line ~1322): replace the `CHERRY_RELAY_PORT_NAME` branch with the panel branch:

  ```ts
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === CHERRY_PANEL_PORT_NAME) {
      handleCherryPanelConnect(port, { ensureLeaderTab, reloadLeaderTabIfExists }).catch((err) =>
        console.error('[slicc-sw] handleCherryPanelConnect failed', err)
      );
      return;
    }
    if (port.name !== 'fetch-proxy.fetch') return;
    // …unchanged fetch-proxy handling…
  });
  ```

- **Add the `reloadLeaderTabIfExists` helper** (near `ensureLeaderTab`) used by the disconnected-recovery path:

  ```ts
  async function reloadLeaderTabIfExists(): Promise<boolean> {
    const id = await readStoredLeaderTabId();
    if (typeof id !== 'number') return false;
    try {
      await chrome.tabs.reload(id);
      return true;
    } catch {
      return false; // tab vanished between read and reload
    }
  }
  ```

  Add `reload(tabId: number): Promise<void>;` to the `tabs` interface in `chrome.d.ts` (it currently lacks `reload`).

- **Update the SW test mocks + injection assertions:**
  - The SW now calls `chrome.sidePanel.setPanelBehavior(...).catch(...)` at module init, so **every** test that imports `service-worker.js` needs a **promise-returning** `sidePanel` mock (a bare `vi.fn()` returns `undefined` → `.catch` throws). Find them all and fix each chrome mock:
    ```bash
    grep -rln "service-worker.js\|service-worker'" packages/chrome-extension/tests
    ```
    Add (or upgrade an existing non-promise stub — e.g. `tests/service-worker-cdp-unmask.test.ts:67` has `sidePanel: { setPanelBehavior: vi.fn(), setOptions: vi.fn() }` which must become promise-returning):
    ```ts
    sidePanel: {
      setPanelBehavior: vi.fn(async () => {}),
      setOptions: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    },
    ```
    Also add `tabs.reload: vi.fn(async () => {})` to those tabs mocks (the new `reloadLeaderTabIfExists` helper).
  - In `tests/service-worker-leader-tab.test.ts`, remove/rewrite the action-click **injection** cases (~lines 365, 431 — they assert `toggleCherryTab`/injection). Replace with an assertion that `setPanelBehavior({ openPanelOnActionClick: true })` was called at init (the icon now toggles the panel natively). Keep the leader-tab lifecycle cases.
  - Run `grep -rn "toggleCherryTab\|canInjectInto\|action.onClicked" packages/chrome-extension/tests` and update any other SW test that asserts the old injection click path.

> This step removes all references to `cherry-sidebar-sw.ts`; the source files (and relay/main) are deleted in **Task 8** (after Task 7's verifications confirm the new path works).

- [ ] **Step 6: Typecheck + run the SW test.**

Run: `npm run typecheck`
Expected: PASS. (If `service-worker.ts` still imports removed symbols, fix them now.)
Run the **full** extension suite (many tests import `service-worker.js` and all need the promise-returning `chrome.sidePanel` mock added above — a partial run hides breakage):
Run: `npx vitest run packages/chrome-extension`
Expected: PASS (panel-sw + every SW-importing test with the `chrome.sidePanel`/`tabs.reload` mocks and the reworked action-click assertion). Injection tests still pass here — they're deleted in Task 8.

- [ ] **Step 7: Commit.**

```bash
npx prettier --write packages/chrome-extension/src/cherry-panel-sw.ts packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/cherry-panel-sw.test.ts packages/chrome-extension/tests/service-worker.test.ts packages/chrome-extension/tests/service-worker-leader-tab.test.ts
git add packages/chrome-extension/src/cherry-panel-sw.ts packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/cherry-panel-sw.test.ts packages/chrome-extension/tests/service-worker.test.ts packages/chrome-extension/tests/service-worker-leader-tab.test.ts
git commit -m "feat(extension): SW cherry-panel wiring (tri-state) + native sidePanel toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Framing — resolver names the extension origin (mechanism (a))

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts` (`resolveCherryFrameAncestors`, ~line 73)
- Modify: `packages/cloudflare-worker/wrangler.jsonc` (`ALLOWED_CHERRY_HOST_ORIGINS`)
- Modify: `packages/cloudflare-worker/CLAUDE.md` (the `resolveCherryFrameAncestors` bullet, ~line 93 — currently says a bare `*` mixed with origins emits only `*`)
- Test: `packages/cloudflare-worker/tests/cherry-frame-ancestors.test.ts` (new) + update existing resolver/framing assertions in `packages/cloudflare-worker/tests/index.test.ts` (~2532, ~2588)

**Note:** the static DNR framing rule (`dnr-frame-ancestors.json`) and the `manifest.json` DNR block are NOT touched here — they are removed in the removal task (**Task 8**), only after **Task 7** confirms mechanism (a) works. (If (a) fails, Task 8 keeps/repurposes DNR as fallback (b).)

**Note:** `chrome-extension://<prod-id>` — the prod extension id is fixed via the manifest `key`. Compute it once (load the unpacked build and read `/json/list`, or derive from the key) and record it; the plan uses the placeholder `<PROD_EXT_ID>`. The dev harness id (`bdgicfcdbgckhdcpklcefkogmahcogbd`, path-derived from `/tmp/slicc-ext-build`) is added to the dev/staging config only.

- [ ] **Step 1: Write the failing test.**

`packages/cloudflare-worker/tests/cherry-frame-ancestors.test.ts` (or extend the existing resolver test):

```ts
import { describe, expect, it } from 'vitest';
import { resolveCherryFrameAncestors } from '../src/index.js';

describe('resolveCherryFrameAncestors — extension origins survive a wildcard', () => {
  it("empty → 'none'", () => {
    expect(resolveCherryFrameAncestors('')).toBe("'none'");
  });
  it('wildcard alone → *', () => {
    expect(resolveCherryFrameAncestors('*')).toBe('*');
  });
  it('wildcard + extension origin → keeps both', () => {
    expect(resolveCherryFrameAncestors('* chrome-extension://abc')).toBe(
      '* chrome-extension://abc'
    );
  });
  it('explicit origins pass through unchanged', () => {
    expect(resolveCherryFrameAncestors('https://a.example chrome-extension://abc')).toBe(
      'https://a.example chrome-extension://abc'
    );
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (current resolver returns `*` for `* chrome-extension://abc`).

Run: `cd packages/cloudflare-worker && npx vitest run tests/cherry-frame-ancestors.test.ts`
Expected: FAIL on the "wildcard + extension origin" case (returns `*`).

- [ ] **Step 3: Amend the resolver.**

In `packages/cloudflare-worker/src/index.ts`, change `resolveCherryFrameAncestors`:

```ts
export function resolveCherryFrameAncestors(allowed: string | undefined): string {
  const trimmed = (allowed ?? '').trim();
  if (trimmed.length === 0) return "'none'";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.includes('*')) {
    // `*` matches only HTTP(S)/same-scheme ancestors — it does NOT authorize a
    // chrome-extension:// parent. Keep explicit extension origins alongside it.
    const ext = tokens.filter((t) => t.startsWith('chrome-extension://'));
    return ext.length ? ['*', ...ext].join(' ') : '*';
  }
  return tokens.join(' ');
}
```

- [ ] **Step 4: Run the test — expect PASS.**

Run: `cd packages/cloudflare-worker && npx vitest run tests/cherry-frame-ancestors.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Add the extension origin to the config.**

In `packages/cloudflare-worker/wrangler.jsonc`, set the prod `ALLOWED_CHERRY_HOST_ORIGINS` to include the extension origin (space-separated), e.g. `"* chrome-extension://<PROD_EXT_ID>"` (or an explicit allowlist if `*` is no longer wanted). For the dev harness, `dev-extension-fresh.sh` (Task 1) passes the value; add `--var "ALLOWED_CHERRY_HOST_ORIGINS:* chrome-extension://bdgicfcdbgckhdcpklcefkogmahcogbd"` there (dev id).

- [ ] **Step 6: Update existing framing assertions in `tests/index.test.ts`.**

Review the current cherry `frame-ancestors` assertions (~lines 2532, 2588). `*`-alone still resolves to `*` (unchanged), so those cases still pass — but if any asserts the resolved value for a config that now includes a `chrome-extension://` origin, update it to expect `* chrome-extension://<id>`. Do not weaken the `'none'`/empty case.

```bash
grep -n "frame-ancestors\|resolveCherryFrameAncestors\|ALLOWED_CHERRY_HOST_ORIGINS" packages/cloudflare-worker/tests/index.test.ts
```

- [ ] **Step 7: Update the worker `CLAUDE.md` doc.**

In `packages/cloudflare-worker/CLAUDE.md`, fix the `resolveCherryFrameAncestors` bullet (~line 93): a bare `*` now emits `*` **plus any explicit `chrome-extension://…` origins** (so the extension can frame the cherry follower), not just `*`.

- [ ] **Step 8: Worker tests (no route change).**

This task changes no routes, so `tests/index.test.ts` / `tests/deployed.test.ts` route lists are untouched. Run the worker tests + its coverage gate:

Run: `cd packages/cloudflare-worker && npx vitest run`
Expected: PASS.
Run: `npm run test:coverage:cloudflare-worker`
Expected: PASS (at/above the worker floor).

- [ ] **Step 9: Commit.**

```bash
npx prettier --write packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/cherry-frame-ancestors.test.ts packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/wrangler.jsonc packages/cloudflare-worker/CLAUDE.md packages/dev-tools/tools/dev-extension-fresh.sh
git add packages/cloudflare-worker packages/dev-tools/tools/dev-extension-fresh.sh
git commit -m "feat(worker): frame-ancestors keeps chrome-extension origin under wildcard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Load-Bearing Verifications in the live harness (run BEFORE removal)

Verify the empirical unknowns against the live panel path **before** deleting anything — Tasks 1-6 have landed and the injection machinery is still present as a reference, so a failed check picks a contingency instead of shipping a broken migration.

**Prereq:** Tasks 1-6 landed. Run `npm run dev:extension:fresh`; drive/verify over CDP with `SLICC_CDP_PORT=9333 node packages/dev-tools/tools/slicc-debug.mjs ...`.

- [ ] **Step 1: Panel opens + follower connects end-to-end.**
      Click the toolbar icon (a real gesture — CDP can't synthesize it). Expected: the panel opens (staying on the current page); "Starting SLICC…" → follower connects → chat mirrors the leader. Over CDP: the `?cherry=1&ui-only=1` iframe exists + its WC shell mounted (custom-element tags present); the leader's `__slicc_browser.listAllTargets()` shows the real tabs but **no** `cherry`/`slicc-cherry` federated target.

- [ ] **Step 2: Handshake parent origin (`ancestorOrigins`).**
      In the cherry iframe over CDP, eval `Array.from(location.ancestorOrigins||[])`. Expected: `["chrome-extension://<dev-id>"]` and NO "Cherry handshake timed out" in the follower. **If empty / not the extension origin → apply contingency 7a before proceeding.**

- [ ] **Step 3: Framing honored (mechanism (a)).**
      Confirm the follower iframe loaded (not CSP-blocked). Over CDP / DevTools, the follower response's `content-security-policy` should carry `frame-ancestors … chrome-extension://<dev-id>` (from the Task-6 resolver + the harness `ALLOWED_CHERRY_HOST_ORIGINS`). **If blocked despite the named origin → apply contingency 7b.**

- [ ] **Step 4: Extension-page CSP does not block the iframe.**
      Expected: no `frame-src` violation in the panel console. **If blocked → apply contingency 7c.**

- [ ] **Step 5: Toggle + record the `onClicked` reality.**
      Click the icon again → panel closes; again → opens. Determine whether `chrome.action.onClicked` fires under `openPanelOnActionClick:true` (temporarily add a `console.debug` listener, then remove it). **If native toggle-close does NOT work on the harness Chrome (149) → apply contingency 7d.**

- [ ] **Step 6: Persistence + close.**
      Navigate the active tab → panel persists (window-level). Close the leader tab → panel shows "Disconnected"; reopening it re-ensures the leader (booting→ready). Reload the extension → panel reconnects.

- [ ] **Step 7: Record results.**
      Note in the PR description + `packages/chrome-extension/CLAUDE.md` which mechanism each check resolved to (mechanism (a) vs a contingency). **This gates Task 8:** Task 8 deletes the DNR rule ONLY if Step 3 confirmed mechanism (a); if 7b shipped, Task 8 keeps it.

### Contingencies (apply only the ones a check above triggered; commit each with the standard footer)

**7a — parent-origin hint (if Step 2 fails).** `main-cherry.ts:resolveParentOrigin()` reads `ancestorOrigins[0]` → `document.referrer` → same-origin. If Chrome doesn't expose the `chrome-extension://` parent there, the follower can't target the panel. This needs a cherry-SDK design decision (thread an explicit parent-origin the panel controls). **STOP and escalate to the controller/human — do not invent a cherry API.** Likely shape once confirmed: a `parentOrigin` option on `mountSlicc` that adds `?parent-origin=` to the follower URL, consumed first by `resolveParentOrigin()`, with a `main-cherry` test.

**7b — DNR remove-CSP fallback (if Step 3 fails).** Re-introduce a DNR rule that REMOVES the `content-security-policy` response header (so no `frame-ancestors` restriction applies), scoped to the cherry sub-frame. Write `packages/chrome-extension/dnr-frame-ancestors.json`:

Use **host-anchored** rules (one per origin) so it can never strip CSP from an
arbitrary third-party subframe that merely contains `cherry=1`:

```json
[
  {
    "id": 1,
    "priority": 1,
    "condition": {
      "urlFilter": "||www.sliccy.ai/?cherry=1",
      "resourceTypes": ["sub_frame"]
    },
    "action": {
      "type": "modifyHeaders",
      "responseHeaders": [{ "header": "content-security-policy", "operation": "remove" }]
    }
  },
  {
    "id": 2,
    "priority": 1,
    "condition": {
      "urlFilter": "||localhost:8787/?cherry=1",
      "resourceTypes": ["sub_frame"]
    },
    "action": {
      "type": "modifyHeaders",
      "responseHeaders": [{ "header": "content-security-policy", "operation": "remove" }]
    }
  }
]
```

(`||host` anchors to that exact host, so only `www.sliccy.ai`/`localhost:8787`'s
`/?cherry=1` sub-frame responses match.) Keep the `declarative_net_request.rule_resources`
block in `manifest.json` (Task 8 must NOT delete it in this case). Add
`tests/dnr-frame-ancestors.test.ts` asserting both rules use `operation: "remove"`
(not `set`), target `resourceTypes: ["sub_frame"]`, and are host-anchored to prod
and dev respectively.

**7c — extension-page `frame-src` (if Step 4 fails).** Set in `manifest.json`:
`"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src 'self' https://www.sliccy.ai http://localhost:8787" }` (keep `script-src`/`object-src`; dev origin harmless in prod). Add a `tests/manifest-sidepanel.test.ts` assertion for the `frame-src`.

**7d — manual toggle fallback (if Step 5 fails).** Set `openPanelOnActionClick:false`; add `chrome.action.onClicked` → if a live `cherry-panel` port exists for `tab.windowId` call `sidePanel.close({ windowId })`, else `sidePanel.open({ windowId })` (**before** any `await`); `ensureLeaderTab()` still runs from the port-connect. `close()` needs Chrome ≥141 → bump `minimum_chrome_version` to `141` and update `tests/manifest-sidepanel.test.ts`. Add SW tests for open-when-closed / close-when-open driven by the live-port set (extend `cherry-panel-sw.ts` to expose the per-window open check).

---

## Task 8: Remove the injection machinery + drop `scripting`/DNR (after Task 7)

**Gate:** do NOT start until Task 7 confirmed the panel connects end-to-end. Delete the DNR framing rule ONLY if Task 7 Step 3 confirmed mechanism (a); if contingency 7b shipped, KEEP the DNR block + file + test.

**Files:**

- Delete: `packages/chrome-extension/src/relay-isolated.ts`, `src/cherry-relay-protocol.ts`, `src/cherry-sidebar-main.ts`, `src/cherry-sidebar-sw.ts`
- Delete tests: `tests/cherry-sidebar-main.test.ts`, `tests/service-worker-cherry.test.ts` (+ any relay/inject tests); `tests/dnr-frame-ancestors.test.ts` (unless 7b shipped)
- Delete: `packages/chrome-extension/dnr-frame-ancestors.json` (unless 7b shipped)
- Modify: `packages/chrome-extension/manifest.json` (drop `scripting`; remove the `declarative_net_request` block unless 7b shipped)
- Modify: `packages/chrome-extension/vite.config.ts` (remove `buildRelayIsolatedPlugin`/`buildCherrySidebarMainPlugin` + their plugins-array entries)
- Modify: `knip.json` (remove `src/relay-isolated.ts!`, `src/cherry-sidebar-main.ts!`)

- [ ] **Step 1: Delete the source + test files.**

```bash
git rm packages/chrome-extension/src/relay-isolated.ts \
       packages/chrome-extension/src/cherry-relay-protocol.ts \
       packages/chrome-extension/src/cherry-sidebar-main.ts \
       packages/chrome-extension/src/cherry-sidebar-sw.ts
git rm packages/chrome-extension/tests/cherry-sidebar-main.test.ts \
       packages/chrome-extension/tests/service-worker-cherry.test.ts 2>/dev/null || true
# Only if mechanism (a) held (NOT contingency 7b):
git rm packages/chrome-extension/dnr-frame-ancestors.json \
       packages/chrome-extension/tests/dnr-frame-ancestors.test.ts 2>/dev/null || true
```

(Also `git rm` any other test that imports the deleted modules — find them in Step 3.)

- [ ] **Step 2: Drop `scripting`; remove the DNR block; remove vite plugins + knip entries.**

- In `manifest.json`: remove `"scripting"` from `permissions`. Remove the `declarative_net_request` block **only if mechanism (a) held** (contingency 7b keeps it). Keep `declarativeNetRequestWithHostAccess` (fetch proxy). Update `tests/manifest-sidepanel.test.ts`:
  - `expect(manifest.permissions).not.toContain('scripting')`;
  - under mechanism (a): `expect((manifest as { declarative_net_request?: unknown }).declarative_net_request).toBeUndefined()` (regression: the framing rule is gone). If 7b shipped, instead assert the block exists with the remove-CSP rule.
- Update `tests/content-script.test.ts` (~line 124): it currently asserts the manifest has `scripting` (and `activeTab`) — drop the `scripting` assertion here (the `activeTab` assertion is handled in Task 9 if that permission is dropped).
- In `vite.config.ts`: delete `buildRelayIsolatedPlugin()` + `buildCherrySidebarMainPlugin()` and their plugins-array entries (~lines 634-635).
- In `knip.json`: remove `"src/relay-isolated.ts!"` and `"src/cherry-sidebar-main.ts!"` from the chrome-extension `entry`.

- [ ] **Step 3: Find + fix any dangling references.**

```bash
grep -rn "cherry-sidebar-sw\|cherry-sidebar-main\|relay-isolated\|cherry-relay-protocol\|CHERRY_RELAY_PORT_NAME\|toggleCherryTab\|plumbTrustedOrigin\|injectCherry\|canInjectInto" packages/chrome-extension
```

Expected after fixes: no matches in `src/`. Fix any stragglers (including tests that import deleted modules).

- [ ] **Step 4 (optional): Revert spoon managed-iframe additions if now unused.**

The injection sidebar added `managed` / `managedIframe` / `requestClose` / `slicc-launcher-close` to `packages/spoon/src/slicc-launcher.ts`. The side panel does NOT use `<slicc-launcher>`. Check for other consumers:

```bash
grep -rn "managedIframe\|slicc-launcher-close\|requestClose" packages --include=*.ts | grep -v spoon/src | grep -v /tests/
```

If the only consumer was the removed cherry-sidebar-main, revert the spoon additions + their spoon tests (`npm run test -w @ai-ecoverse/spoon`). Otherwise skip (extra API surface, not a correctness issue).

- [ ] **Step 5: Typecheck + full extension test run + deadcode.**

Run: `npm run typecheck` → PASS.
Run: `npx vitest run packages/chrome-extension` → PASS (no references to deleted modules).
Run: `npm run deadcode` → PASS (knip clean — new `sidepanel-entry.ts!` entry present, old entries gone).

- [ ] **Step 6: Build the extension + RHC check.**

Run: `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` → exit 0; no `relay-isolated.js`/`cherry-sidebar-main.js`; `sidepanel.html`/`sidepanel.js` present.
Run: `npm run postbuild:check -w @slicc/chrome-extension` → PASS (`check-extension-rhc.sh`).

- [ ] **Step 7: Commit.**

```bash
npx prettier --write packages/chrome-extension/vite.config.ts knip.json packages/chrome-extension/manifest.json packages/chrome-extension/tests/manifest-sidepanel.test.ts
git add -A packages/chrome-extension knip.json packages/spoon
git commit -m "refactor(extension): remove page-injection machinery + drop scripting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Docs + permissions justifications + full gate verification

**Files:**

- Modify: `docs/chrome-web-store-submission.md`, `packages/chrome-extension/CLAUDE.md`, `docs/architecture.md`
- Modify: `packages/chrome-extension/manifest.json` (drop `activeTab` if unused — verify first)

- [ ] **Step 1: Evaluate `activeTab` removal.**

```bash
grep -rn "activeTab" packages/chrome-extension/src
```

`activeTab` was for `executeScript` injection. The active-tab **marker** uses `chrome.tabs.query({ lastFocusedWindow: true })` (the `tabs` permission), and `chrome.debugger` uses the `debugger` permission. If nothing else needs `activeTab`, remove it from `manifest.json` permissions and update the `manifest-sidepanel.test.ts` expectation.

- [ ] **Step 2: Update the CWS submission doc.**

In `docs/chrome-web-store-submission.md`: the `sidePanel` row was added in Task 3; now remove the `scripting` row (dropped in Task 8) and the `activeTab` row (if dropped in Step 1); **keep** the `declarativeNetRequestWithHostAccess` justification (fetch proxy — and, if contingency 7b shipped, note the framing rule too); reconcile the single-purpose statement (a side-panel cockpit connected to the hosted leader; no page injection). Run `bash packages/dev-tools/tools/check-manifest-justifications.sh` — expect PASS.

- [ ] **Step 3: Update `packages/chrome-extension/CLAUDE.md`.**

Rewrite the "On-Demand Per-Page Cherry Sidebar" section to describe the **side panel**: icon → Chrome-native toggle; `sidepanel.html` iframes the hosted `?cherry=1&ui-only=1` follower; `cherry-panel` Port + tri-state; `setPanelBehavior`; framing via server CSP naming the extension origin; no `scripting`, no injection, no DNR framing rule. Remove the injection/relay/DNR-framing description.

- [ ] **Step 4: Update `docs/architecture.md`.**

Update the extension thin-bridge section: the per-page injected cherry sidebar is replaced by a `chrome.sidePanel` cockpit hosting the ui-only follower.

- [ ] **Step 5: Full pre-PR gate pass** (mirror the CI jobs — several run separately from `lint:ci`).

```bash
npm run lint:ci
npm run deadcode
npm run deadcode:production-files                            # CI-only production dead-file gate
npm run typecheck
npm run test
# Per-package coverage gates (root `test:coverage` uses aggregate defaults, NOT
# the per-package floors CI enforces). Run the ones for touched packages:
npm run test:coverage:chrome-extension
npm run test:coverage:cloudflare-worker
# + npm run test:coverage:spoon   # only if the optional spoon revert (Task 8 Step 4) was taken
# + npm run test:coverage:webapp  # only if contingency 7a touched main-cherry.ts
npm run build
npm run build -w @slicc/chrome-extension
npm run postbuild:check -w @slicc/chrome-extension          # check-extension-rhc.sh (no CDN literals)
bash packages/dev-tools/tools/check-manifest-justifications.sh   # every permission justified
node packages/dev-tools/tools/check-touched-exemptions.mjs       # touched-file complexity gate
# Extension bundle scans (inline in the chrome-extension CI job; this change adds
# a new bundle entry, so run both):
#  - Node-only-API scan over the built bundle (grep dist/extension for fs/path/
#    crypto/etc. require() + fileURLToPath, per ci.yml "Check bundle for Node-only APIs").
#  - Dev-deps scan: `cd packages/chrome-extension && npx vite optimize --force`,
#    then grep the optimized deps for the same Node-only APIs (per ci.yml "Check
#    dev deps for Node-only APIs"). Copy the exact FORBIDDEN pattern + globs from
#    `.github/workflows/ci.yml` (chrome-extension job).
```

Expected: all PASS; coverage at/above each package floor. Fix anything red. (CI runs these as distinct jobs — `.github/workflows/ci.yml`.)

- [ ] **Step 6: Commit.**

```bash
npx prettier --write docs/chrome-web-store-submission.md packages/chrome-extension/CLAUDE.md docs/architecture.md packages/chrome-extension/manifest.json
git add -A docs packages/chrome-extension
git commit -m "docs(extension): side-panel cockpit — CWS justifications, CLAUDE.md, architecture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: PR update + review + CI + live test

- [ ] **Step 1: Push + update PR #1287.**

```bash
git push
```

Update the PR #1287 title/body to describe the side-panel rework (supersedes the injection approach). End the body with the Claude Code footer.

- [ ] **Step 2: Run `/pr-review-toolkit:review-pr` and address findings.**

- [ ] **Step 3: Monitor CI to green; address automated reviewer comments (answer + resolve).**

- [ ] **Step 4: Final live test via `npm run dev:extension:fresh`** — the full success-criteria pass from the spec (panel connects, no federated cherry target, agent drives active tab via real CDP, persistence, close).
