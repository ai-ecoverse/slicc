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
- **Framing (committed mechanism (a)):** amend `resolveCherryFrameAncestors` so explicit `chrome-extension://…` origins survive a `*` list; config lists the extension origin. Remove the static DNR framing rule. The DNR remove/replace fallback (b) ships only if (a) is shown not to work in the harness (Task 8).
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
- `packages/chrome-extension/dnr-frame-ancestors.json` (mechanism (a); keep only if Task 8 forces fallback (b)).
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

Replace with (drop the staging override; use the `staging` env so `routes: []` → `url.origin = localhost:8787`):

```bash
  npx wrangler dev \
    --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
    --env staging \
    --port "$WRANGLER_PORT" --ip 127.0.0.1 \
    --var "GITHUB_CLIENT_ID:${STAGING_GH_CLIENT_ID}" &
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

## Task 3: Manifest — `sidePanel` permission, `side_panel`, `minimum_chrome_version`; drop `scripting`

**Files:**

- Modify: `packages/chrome-extension/manifest.json`
- Test: `packages/chrome-extension/tests/manifest-sidepanel.test.ts`

**Note on permission justifications:** `check-manifest-justifications.sh` (CI lint) requires every permission to be justified in `docs/chrome-web-store-submission.md`. That doc is updated in Task 9; if the lint runs earlier, add the `sidePanel` row now (Task 9 reconciles the full doc).

- [ ] **Step 1: Write the failing test.**

`packages/chrome-extension/tests/manifest-sidepanel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest side panel', () => {
  it('declares the sidePanel permission and drops scripting', () => {
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.permissions).not.toContain('scripting');
  });
  it('registers the default side panel path', () => {
    expect((manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path).toBe(
      'sidepanel.html'
    );
  });
  it('sets a minimum_chrome_version (>=114 for sidePanel)', () => {
    const v = Number((manifest as { minimum_chrome_version?: string }).minimum_chrome_version);
    expect(v).toBeGreaterThanOrEqual(114);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npx vitest run packages/chrome-extension/tests/manifest-sidepanel.test.ts`
Expected: FAIL (`sidePanel` missing / `scripting` present / no `side_panel`).

- [ ] **Step 3: Edit `manifest.json`.**

- In `"permissions"`, remove `"scripting"` and add `"sidePanel"`. Keep `"activeTab"` for now (Task 9 evaluates its removal). Keep `"declarativeNetRequestWithHostAccess"`.
- Add top-level `"minimum_chrome_version": "114"`.
- Add top-level `"side_panel": { "default_path": "sidepanel.html" }`.

(Leave the `declarative_net_request.rule_resources` block for now — Task 6 removes the framing rule under mechanism (a).)

- [ ] **Step 4: Run the test — expect PASS.**

Run: `npx vitest run packages/chrome-extension/tests/manifest-sidepanel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
npx prettier --write packages/chrome-extension/manifest.json packages/chrome-extension/tests/manifest-sidepanel.test.ts
git add packages/chrome-extension/manifest.json packages/chrome-extension/tests/manifest-sidepanel.test.ts
git commit -m "feat(extension): manifest sidePanel + side_panel path; drop scripting

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
  let port: ReturnType<typeof makePort>;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    statuses = [];
    destroy = vi.fn();
    mountSlicc = vi.fn(() => ({ iframe, emitHostEvent: vi.fn(), destroy }));
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

  it('duplicate identical ready is a no-op (no remount)', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    expect(mountSlicc).toHaveBeenCalledTimes(1);
  });

  it('new ready joinUrl remounts: destroy + blank iframe + mount', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/a.1' });
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/b.2' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute('src')).toBe('about:blank'); // blanked before remount
    expect(mountSlicc).toHaveBeenCalledTimes(2);
  });

  it('disconnected → destroy + blank iframe + disconnected status', () => {
    make();
    port._emit({ kind: 'join-url', state: 'ready', joinUrl: 'https://tray/join/t.s' });
    port._emit({ kind: 'join-url', state: 'disconnected' });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(statuses).toContain('disconnected');
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
    if (msg.joinUrl === currentJoinUrl && handle) return; // idempotent
    handle?.destroy();
    handle = null;
    blankIframe(); // clear the stale follower before remount (destroy() keeps caller iframes)
    currentJoinUrl = msg.joinUrl;
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
    });
    deps.setStatus('connected');
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

- [ ] **Step 4: Run the test — expect PASS (7 tests).**

Run: `npx vitest run packages/chrome-extension/tests/sidepanel-entry.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `sidepanel.html`.**

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

Register it in the plugins array where `buildCherrySidebarMainPlugin()` / `buildRelayIsolatedPlugin()` are listed (those two are removed in Task 7). Add `'sidepanel.html'` to the static-asset copy-list array (the one containing `'secrets.html'`, ~line 388-397).

> Note: verify `PROD_IIFE_DEFAULTS` allows a `format` override; if it hardcodes `format: 'iife'`, spread then override as shown. If the module-vs-IIFE distinction causes issues, drop `format` (default) and change `sidepanel.html`'s `<script>` to a plain `<script src="sidepanel.js">` — an IIFE runs fine there. Pick whichever the harness loads cleanly (Task 8 confirms).

- [ ] **Step 7: Register the knip entry.**

In `knip.json`, under `packages/chrome-extension` → `entry`, add `"src/sidepanel-entry.ts!"`. (The old `relay-isolated.ts!`/`cherry-sidebar-main.ts!` entries are removed in Task 7.)

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
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing).**

Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-sw.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `cherry-panel-sw.ts`.**

```ts
/// <reference path="./chrome.d.ts" />
import type { SwToPanelMessage } from './cherry-panel-protocol.js';

/** Connected side-panel ports. */
const panelPorts = new Set<ChromeRuntimePort>();

/** Current tri-state, broadcast to panels; defaults to booting. */
let state: SwToPanelMessage = { kind: 'join-url', state: 'booting' };

/** Test-only reset. */
export function resetCherryPanelState(): void {
  panelPorts.clear();
  state = { kind: 'join-url', state: 'booting' };
}

export function getPanelState(): SwToPanelMessage {
  return state;
}

function broadcast(): void {
  for (const port of panelPorts) {
    try {
      port.postMessage(state);
    } catch {
      panelPorts.delete(port);
    }
  }
}

export interface CherryPanelConnectDeps {
  ensureLeaderTab: () => Promise<void>;
}

/**
 * Register a `cherry-panel` port: ensure the leader tab exists (so it becomes a
 * tray leader and delivers `leader.join-url`), and push the current tri-state to
 * this port immediately. The panel sends `{ kind:'hello', windowId }`; the
 * windowId is currently informational (Chrome owns panel open/closed state).
 */
export async function handleCherryPanelConnect(
  port: ChromeRuntimePort,
  deps: CherryPanelConnectDeps
): Promise<void> {
  panelPorts.add(port);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener(() => {
    /* hello is informational; presence in panelPorts is the open signal */
  });
  port.postMessage(state); // replay current status to the fresh port
  await deps.ensureLeaderTab();
}

/** Leader delivered a joinUrl (string) or dropped its tray (null). */
export function setCherryPanelJoinUrl(joinUrl: string | null): void {
  state = joinUrl
    ? { kind: 'join-url', state: 'ready', joinUrl }
    : { kind: 'join-url', state: 'disconnected' };
  broadcast();
}

/** Leader tab was removed → tell panels. */
export function broadcastLeaderGone(): void {
  state = { kind: 'join-url', state: 'disconnected' };
  broadcast();
}
```

- [ ] **Step 4: Run the test — expect PASS (6 tests).**

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
- **Remove** the `chrome.action.onClicked` cherry-injection listener (lines ~353-370: the `canInjectInto`/`toggleCherryTab` block). If nothing else needs the action-click, remove the listener entirely. (Do NOT keep `toggleCherryTab`.)
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
      handleCherryPanelConnect(port, { ensureLeaderTab }).catch((err) =>
        console.error('[slicc-sw] handleCherryPanelConnect failed', err)
      );
      return;
    }
    if (port.name !== 'fetch-proxy.fetch') return;
    // …unchanged fetch-proxy handling…
  });
  ```

> This step deletes all references to `cherry-sidebar-sw.ts`; the file itself (and relay/main) is removed in Task 7.

- [ ] **Step 6: Typecheck + run the SW test.**

Run: `npm run typecheck`
Expected: PASS. (If `service-worker.ts` still imports removed symbols, fix them now.)
Run: `npx vitest run packages/chrome-extension/tests/cherry-panel-sw.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
npx prettier --write packages/chrome-extension/src/cherry-panel-sw.ts packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/cherry-panel-sw.test.ts
git add packages/chrome-extension/src/cherry-panel-sw.ts packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/cherry-panel-sw.test.ts
git commit -m "feat(extension): SW cherry-panel wiring (tri-state) + native sidePanel toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Framing — resolver names the extension origin; drop the DNR framing rule

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts` (`resolveCherryFrameAncestors`, ~line 34-40)
- Modify: `packages/cloudflare-worker/wrangler.jsonc` (`ALLOWED_CHERRY_HOST_ORIGINS`)
- Modify: `packages/chrome-extension/manifest.json` (remove the `declarative_net_request.rule_resources` framing rule)
- Delete: `packages/chrome-extension/dnr-frame-ancestors.json`
- Test: `packages/cloudflare-worker/tests/cherry-frame-ancestors.test.ts` (extend existing resolver test if present; else create)

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

- [ ] **Step 6: Remove the static DNR framing rule (mechanism (a)).**

- Delete `packages/chrome-extension/dnr-frame-ancestors.json`.
- In `manifest.json`, remove the `declarative_net_request` block **only if no other rule resource exists** (it currently holds only `frame_ancestors_sliccy`). Keep the `declarativeNetRequestWithHostAccess` **permission** (fetch proxy).
- Grep for other references to `dnr-frame-ancestors.json` (vite copy list, tests) and remove them.

```bash
grep -rn "dnr-frame-ancestors\|frame_ancestors_sliccy" packages/chrome-extension
```

> If Task 8's harness check shows a named `chrome-extension://<id>` ancestor is NOT honored, revert this deletion and instead ship a DNR rule that **removes** the `content-security-policy` header (operation `remove`) scoped to `resourceTypes:["sub_frame"]` for both prod `sliccy.ai` and dev `localhost:8787` — and restore the `declarative_net_request` block + a test. That is fallback (b).

- [ ] **Step 7: Worker routes-mirror check + tests.**

This task changes no routes, so `tests/index.test.ts` / `tests/deployed.test.ts` route lists are untouched. Run the worker tests:

Run: `cd packages/cloudflare-worker && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
npx prettier --write packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/cherry-frame-ancestors.test.ts packages/chrome-extension/manifest.json
git add -A packages/cloudflare-worker packages/chrome-extension/manifest.json packages/chrome-extension/dnr-frame-ancestors.json packages/dev-tools/tools/dev-extension-fresh.sh
git commit -m "feat(worker): frame-ancestors keeps chrome-extension origin under wildcard; drop DNR framing rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Remove the injection machinery

**Files:**

- Delete: `packages/chrome-extension/src/relay-isolated.ts`, `src/cherry-relay-protocol.ts`, `src/cherry-sidebar-main.ts`, `src/cherry-sidebar-sw.ts`
- Delete: `packages/chrome-extension/tests/cherry-sidebar-main.test.ts`, `tests/service-worker-cherry.test.ts` (+ any relay/inject tests)
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
```

(Also `git rm` any other test that imports the deleted modules — find them in the next step.)

- [ ] **Step 2: Remove the vite plugins + knip entries.**

- In `vite.config.ts`: delete `buildRelayIsolatedPlugin()` and `buildCherrySidebarMainPlugin()` functions and their entries in the plugins array (~lines 634-635).
- In `knip.json`: remove `"src/relay-isolated.ts!"` and `"src/cherry-sidebar-main.ts!"` from the chrome-extension `entry` list.

- [ ] **Step 3: Find + fix any dangling references.**

```bash
grep -rn "cherry-sidebar-sw\|cherry-sidebar-main\|relay-isolated\|cherry-relay-protocol\|CHERRY_RELAY_PORT_NAME\|toggleCherryTab\|plumbTrustedOrigin\|injectCherry\|canInjectInto" packages/chrome-extension
```

Expected after fixes: no matches in `src/` (tests for the new panel path are fine). Fix any stragglers.

- [ ] **Step 4: Typecheck + full extension test run + deadcode.**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx vitest run packages/chrome-extension`
Expected: PASS (no references to deleted modules).
Run: `npm run deadcode`
Expected: PASS (knip clean — new entry registered, old entries removed).

- [ ] **Step 5: Build the extension + RHC check.**

Run: `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`
Expected: exit 0; no `relay-isolated.js` / `cherry-sidebar-main.js` emitted; `sidepanel.html`/`sidepanel.js` present.
Run: `npm run postbuild:check -w @slicc/chrome-extension`
Expected: PASS (`check-extension-rhc.sh` — no CDN URL literals).

- [ ] **Step 6 (optional): Revert the spoon managed-iframe additions if now unused.**

The injection sidebar added `managed` / `managedIframe` / `requestClose` /
`slicc-launcher-close` to `packages/spoon/src/slicc-launcher.ts`. The side panel
does NOT use `<slicc-launcher>` (the panel is the container). If nothing else
consumes those additions, revert them; if reverting is risky or they're shared,
leave them (they're extra API surface, not a correctness issue). Check first:

```bash
grep -rn "managed\b\|managedIframe\|slicc-launcher-close\|requestClose" packages --include=*.ts | grep -v spoon/src | grep -v /tests/
```

If the only consumers were the removed cherry-sidebar-main, revert the spoon
additions + their spoon tests; run `npm run test -w @ai-ecoverse/spoon` (or the
spoon vitest project). Otherwise skip.

- [ ] **Step 7: Commit.**

```bash
npx prettier --write packages/chrome-extension/vite.config.ts knip.json
git add -A packages/chrome-extension knip.json packages/spoon
git commit -m "refactor(extension): remove page-injection machinery (relay/main/inject SW)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Load-Bearing Verifications in the live harness + contingencies

**Files:** (contingent — only if a check fails)

- Maybe modify: `packages/webapp/src/ui/main-cherry.ts` (parent-origin hint)
- Maybe modify: `packages/chrome-extension/manifest.json` (extension-page `frame-src`) / re-add DNR fallback (b)

**Prereq:** Tasks 1-7 landed. Run `npm run dev:extension:fresh`.

- [ ] **Step 1: Verify the panel opens + follower connects end-to-end.**

Click the toolbar icon (real gesture). Expected: the side panel opens (staying on the current page), shows "Starting SLICC…", then the follower connects and chat mirrors the leader. Verify over CDP (port 9333): the cherry iframe (`?cherry=1&ui-only=1`) exists and its WC shell mounted; the leader's `__slicc_browser.listAllTargets()` shows the real tabs but **no** `cherry`/`slicc-cherry` federated target.

- [ ] **Step 2: Verify the handshake parent origin (`ancestorOrigins`).**

In the cherry iframe over CDP, eval `Array.from(location.ancestorOrigins||[])`. Expected: `["chrome-extension://<dev-id>"]` and NO "Cherry handshake timed out" error in the follower.
**Contingency (only if empty / not the extension origin):** add a trusted parent-origin hint. In `sidepanel-entry.ts`, mountSlicc is passed the iframe; before mount, append `&parent-origin=<chrome.runtime.getURL('').slice(0,-1)>` to the follower URL is NOT how cherry sets src — instead thread a `parentOrigin` option through `mountSlicc`/`main-cherry.ts`'s `resolveParentOrigin()` so it consumes an explicit hint first. Keep it minimal and covered by a `main-cherry` test. (Do this ONLY if Step 2 shows the need.)

- [ ] **Step 3: Verify framing (mechanism (a)).**

Confirm the follower iframe actually loaded (not blocked by CSP). If blocked, check the follower response's `content-security-policy: frame-ancestors` (should include `chrome-extension://<dev-id>` via the Task-6 resolver + dev config).
**Contingency (only if blocked despite the named origin):** ship DNR fallback (b) per Task 6 Step 6's note (remove the CSP header, scoped to sub_frame, prod+dev).

- [ ] **Step 4: Verify the extension-page CSP does not block the iframe.**

Expected: no `frame-src` violation in the panel's console.
**Contingency (only if blocked):** add `frame-src 'self' https://www.sliccy.ai http://localhost:8787` to `manifest.json` `content_security_policy.extension_pages` (keep `script-src`/`object-src`).

- [ ] **Step 5: Verify the icon toggles + records the onClicked reality.**

Click the icon again → panel closes; click again → opens. Record whether `chrome.action.onClicked` fires under `openPanelOnActionClick: true` (add a `console.debug` in a temporary listener if needed, then remove it). If native toggle-close does NOT work on the harness Chrome, wire the fallback path per the spec's Deferred Decision (onClicked + `open()`/`close()`).

- [ ] **Step 6: Verify persistence + close.**

Navigate the active tab to a new URL → the panel stays (window-level). Close the leader tab → the panel shows "Disconnected"; re-open/ensure recreates it. Reload the extension → the panel re-connects.

- [ ] **Step 7: Record findings + land any contingency commits.**

Append the verification results (and which contingencies, if any, were applied) to the plan or a short note in `packages/chrome-extension/CLAUDE.md`. Commit any contingency changes with focused messages + the standard footer.

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

In `docs/chrome-web-store-submission.md`: add the `sidePanel` justification row; remove the `scripting` row (and `activeTab` if dropped); **keep** the `declarativeNetRequestWithHostAccess` justification (fetch proxy); reconcile the single-purpose statement (a side-panel cockpit connected to the hosted leader; no page injection). Ensure `check-manifest-justifications.sh` passes.

- [ ] **Step 3: Update `packages/chrome-extension/CLAUDE.md`.**

Rewrite the "On-Demand Per-Page Cherry Sidebar" section to describe the **side panel**: icon → Chrome-native toggle; `sidepanel.html` iframes the hosted `?cherry=1&ui-only=1` follower; `cherry-panel` Port + tri-state; `setPanelBehavior`; framing via server CSP naming the extension origin; no `scripting`, no injection, no DNR framing rule. Remove the injection/relay/DNR-framing description.

- [ ] **Step 4: Update `docs/architecture.md`.**

Update the extension thin-bridge section: the per-page injected cherry sidebar is replaced by a `chrome.sidePanel` cockpit hosting the ui-only follower.

- [ ] **Step 5: Full pre-PR gate pass.**

```bash
npm run lint:ci
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
npm run deadcode
```

Expected: all PASS; coverage at/above each package floor. Fix anything red.

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
