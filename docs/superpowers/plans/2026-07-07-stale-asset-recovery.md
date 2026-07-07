# Stale-asset recovery after deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a deploy, automatically recover any long-lived SLICC tab/worker that crashes on a now-gone content-hashed Vite chunk, instead of leaving the session unrecoverable (issue #1330).

**Architecture:** Four triggers funnel into one shared, instanceId-scoped, fail-closed, timestamp-guarded page reload. Two page-side triggers (`window` `vite:preloadError` for page-owned lazy chunks; a `Worker` `error` event for a stale worker entry chunk) and two worker-side triggers (a `boot()` `try/catch` for boot-time provider imports; the `scoop-context` turn-error classifier) — the worker triggers `postMessage` an instanceId-stamped signal over a `BroadcastChannel` that only the owning page acts on.

**Tech Stack:** TypeScript, Vite (content-hashed chunks + `__vitePreload`/`vite:preloadError`), Vitest (node env + a fake `BroadcastChannel`; jsdom for the DOM/`window` test), Cloudflare Workers Static Assets (SPA fallback).

## Global Constraints

- Scope is **`packages/webapp` only** — no `cloudflare-worker` / `cloud-core` changes.
- The shared detection/channel module MUST be realm-agnostic (no `window`/`document` at module scope) — imported by the page AND the kernel worker. Prove it by adding the module to `tsconfig.webapp-worker.json`'s `include` (no-DOM `WebWorker` lib) — Task 1.
- Reload guard: **timestamp window `RELOAD_WINDOW_MS = 60_000`** (must exceed the 30 s host-ready boot timeout), **fail-closed** on any `sessionStorage` throw, `sessionStorage` key `'slicc:stale-asset-reloaded-at'`.
- Worker→page signal is **instanceId-scoped** (`BroadcastChannel 'slicc-stale-asset-reload'`, message `{ type: 'stale-asset-reload', instanceId }`); the page listener acts only on its own `instanceId`. Never origin-wide.
- **Ordering is load-bearing:** `BroadcastChannel` does NOT buffer and `spawnKernelWorker()` posts `kernel-worker-init` synchronously, so the page reload listener MUST be installed BEFORE `spawnKernelWorker()` is called.
- `isDynamicImportError` anchors on module-script context (`module script` / `JavaScript module` / `dynamically imported module`); a bare `MIME type` match is forbidden (false-positive risk).
- **Tests use the repo fake-`BroadcastChannel`** (neither node nor jsdom implements a working cross-instance one) — a shared helper, mirroring `tests/kernel/panel-rpc.test.ts`.
- Commits: focused, package-local, **no `Co-Authored-By` trailer**. Run `npx prettier --write` on touched files before each commit.

## File Structure

- **Create** `packages/webapp/src/core/stale-asset-channel.ts` — realm-agnostic: `isDynamicImportError`, channel name + message type, `setStaleAssetInstanceId`, `broadcastStaleAssetReload`, `broadcastIfStaleAssetError`, `installStaleAssetReloadListener`. (In `core/` — imported by both realms; avoids a worker→`ui/` import.)
- **Create** `packages/webapp/tests/helpers/fake-broadcast-channel.ts` — shared in-memory `BroadcastChannel` polyfill + install/reset.
- **Create** `packages/webapp/src/ui/boot/setup-preload-error-reload.ts` — page-only: `decideStaleReload`, `guardedReload`, `setupPreloadErrorReload`, `installWorkerStaleAssetReloadListener`, `__resetForTest`.
- **Modify** `packages/webapp/src/ui/main.ts` — `setupPreloadErrorReload()` first in `main()`.
- **Modify** `packages/webapp/src/scoops/scoop-context.ts` — `handleStaleAssetError` before `handleNonRetryableError` in `handlePromptAttemptError`.
- **Modify** `packages/webapp/src/kernel/kernel-worker.ts` — `setStaleAssetInstanceId` + `try/catch(broadcastIfStaleAssetError)` around `boot()`.
- **Modify** `packages/webapp/src/kernel/spawn.ts` — `WorkerLike.addEventListener?` + `onWorkerScriptError?` on both option types + attach in `bootstrapKernelWorker`.
- **Modify** `packages/webapp/src/ui/wc/wc-live.ts` — install the listener before `spawnKernelWorker`, pass `onWorkerScriptError`.
- **Modify** `tsconfig.webapp-worker.json` — add the channel module to `include`.
- **Create/extend** tests: `tests/core/stale-asset-channel.test.ts`, `tests/ui/boot/setup-preload-error-reload.test.ts`; extend `tests/scoops/scoop-context.test.ts`, `tests/kernel/spawn.test.ts`.
- **Modify** docs: `packages/webapp/CLAUDE.md`, `docs/pitfalls.md`.

---

### Task 1: Shared detection + channel module (+ fake-channel test helper)

**Files:**

- Create: `packages/webapp/src/core/stale-asset-channel.ts`
- Create: `packages/webapp/tests/helpers/fake-broadcast-channel.ts`
- Test: `packages/webapp/tests/core/stale-asset-channel.test.ts`
- Modify: `tsconfig.webapp-worker.json` (add module to `include`)

**Interfaces:**

- Consumes: `createLogger` from `../core/logger.js` (relative `./logger.js`).
- Produces:
  - `isDynamicImportError(msg: string): boolean`
  - `STALE_ASSET_RELOAD_CHANNEL: string`, `interface StaleAssetReloadMsg { type: 'stale-asset-reload'; instanceId: string }`
  - `setStaleAssetInstanceId(id: string | undefined): void`
  - `broadcastStaleAssetReload(): void`
  - `broadcastIfStaleAssetError(err: unknown): void`
  - `installStaleAssetReloadListener(instanceId: string, onReload: () => void): () => void`
  - Test helper: `FakeBroadcastChannel`, `installFakeBroadcastChannel()`, `resetFakeBroadcastChannel()`

- [ ] **Step 1: Write the shared fake-channel helper**

```ts
// packages/webapp/tests/helpers/fake-broadcast-channel.ts
/**
 * In-memory BroadcastChannel polyfill for tests. Neither the node vitest env
 * nor jsdom provides a working cross-instance BroadcastChannel; this mirrors
 * the real async-same-thread delivery via queueMicrotask. Based on the pattern
 * in tests/kernel/panel-rpc.test.ts. Install onto globalThis BEFORE code
 * constructs `new BroadcastChannel(...)`.
 */
export class FakeBroadcastChannel {
  private static buses = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;

  constructor(public readonly name: string) {
    let bus = FakeBroadcastChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeBroadcastChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeBroadcastChannel.buses.get(this.name);
    if (!bus) return;
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data }));
      });
    }
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.closed = true;
    FakeBroadcastChannel.buses.get(this.name)?.delete(this);
  }
}

let original: unknown;
export function installFakeBroadcastChannel(): void {
  original = (globalThis as Record<string, unknown>).BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
}
export function resetFakeBroadcastChannel(): void {
  (FakeBroadcastChannel as unknown as { buses: Map<string, unknown> }).buses = new Map();
  (globalThis as Record<string, unknown>).BroadcastChannel = original;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/webapp/tests/core/stale-asset-channel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeBroadcastChannel,
  resetFakeBroadcastChannel,
} from '../helpers/fake-broadcast-channel.js';
import {
  broadcastIfStaleAssetError,
  broadcastStaleAssetReload,
  installStaleAssetReloadListener,
  isDynamicImportError,
  setStaleAssetInstanceId,
} from '../../src/core/stale-asset-channel.js';

describe('isDynamicImportError', () => {
  it('matches the cross-browser dynamic-import / module-script failure family', () => {
    expect(isDynamicImportError('Failed to fetch dynamically imported module: /assets/x.js')).toBe(
      true
    );
    expect(isDynamicImportError('error loading dynamically imported module')).toBe(true);
    expect(isDynamicImportError('Importing a module script failed.')).toBe(true);
    expect(
      isDynamicImportError(
        'Expected a JavaScript module script but the server responded with a MIME type of text/html'
      )
    ).toBe(true);
  });
  it('does NOT match unrelated errors', () => {
    expect(isDynamicImportError('401 Unauthorized')).toBe(false);
    expect(isDynamicImportError('rate limit exceeded')).toBe(false);
    expect(isDynamicImportError('network error')).toBe(false);
    expect(isDynamicImportError('Upload failed: unsupported MIME type image/tiff')).toBe(false);
    expect(isDynamicImportError('TypeError: Failed to fetch')).toBe(false);
  });
});

describe('broadcast + listener (instanceId-scoped)', () => {
  beforeEach(() => installFakeBroadcastChannel());
  afterEach(() => {
    setStaleAssetInstanceId(undefined);
    resetFakeBroadcastChannel();
  });

  it('delivers only to a listener whose instanceId matches', async () => {
    const matched = vi.fn();
    const other = vi.fn();
    const d1 = installStaleAssetReloadListener('inst-A', matched);
    const d2 = installStaleAssetReloadListener('inst-B', other);
    setStaleAssetInstanceId('inst-A');
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(matched).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    d1();
    d2();
  });

  it('no-ops when no instanceId has been set', async () => {
    const cb = vi.fn();
    const d = installStaleAssetReloadListener('inst-A', cb);
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    d();
  });

  it('broadcastIfStaleAssetError broadcasts for a dynamic-import Error only', async () => {
    const cb = vi.fn();
    const d = installStaleAssetReloadListener('inst-A', cb);
    setStaleAssetInstanceId('inst-A');
    broadcastIfStaleAssetError(new Error('random failure'));
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    broadcastIfStaleAssetError(new Error('Failed to fetch dynamically imported module: /a.js'));
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    d();
  });

  it('setStaleAssetInstanceId(undefined) dev-warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStaleAssetInstanceId(undefined);
    // Dev-only warning; assert it does not throw and (in DEV) warns at least 0+ times.
    expect(() => setStaleAssetInstanceId(undefined)).not.toThrow();
    warn.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/core/stale-asset-channel.test.ts`
Expected: FAIL — cannot resolve `../../src/core/stale-asset-channel.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/webapp/src/core/stale-asset-channel.ts
/**
 * Realm-agnostic detection + worker→page signal for stale-chunk recovery after
 * a deploy (#1330). DOM-free at module scope (only `BroadcastChannel`, in the
 * page AND the kernel worker), so both realms import it. Mirrors the split-out
 * shape of `nuke-channel.ts`.
 */
import { createLogger } from './logger.js';

const log = createLogger('stale-asset');

// Module-script context ONLY — never a bare "MIME type" / "failed to fetch",
// which would false-positive on unrelated tool/upload/provider errors.
const DYNAMIC_IMPORT_ERROR_RE =
  /dynamically imported module|importing a module script failed|expected a javascript module|module script/i;

/** True for the cross-browser dynamic-import / module-script load failure family. */
export function isDynamicImportError(msg: string): boolean {
  return DYNAMIC_IMPORT_ERROR_RE.test(msg);
}

/** Same-origin channel a failing worker uses to ask its owning page to reload. */
export const STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload';

export interface StaleAssetReloadMsg {
  type: 'stale-asset-reload';
  instanceId: string;
}

let workerInstanceId: string | null = null;

/** Kernel worker records `init.instanceId` at boot start. Dev-warns if absent. */
export function setStaleAssetInstanceId(id: string | undefined): void {
  if (!id) {
    workerInstanceId = null;
    if (import.meta.env?.DEV) {
      log.warn('no instanceId for kernel worker; stale-asset reload signal disabled');
    }
    return;
  }
  workerInstanceId = id;
}

/** Post an instanceId-stamped reload request. No-op until an id is set. */
export function broadcastStaleAssetReload(): void {
  if (!workerInstanceId || typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(STALE_ASSET_RELOAD_CHANNEL);
  try {
    channel.postMessage({
      type: 'stale-asset-reload',
      instanceId: workerInstanceId,
    } satisfies StaleAssetReloadMsg);
  } finally {
    channel.close();
  }
}

/** Broadcast iff `err` is a dynamic-import failure. Called from the worker
 *  `boot()` catch — lives here (not in `kernel-worker.ts`) so it is unit-testable
 *  without triggering that module's load-time `self.addEventListener` side effect. */
export function broadcastIfStaleAssetError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDynamicImportError(msg)) broadcastStaleAssetReload();
}

/**
 * Page-side listener PRIMITIVE. Invokes `onReload` only for a broadcast stamped
 * with the page's own `instanceId`. Returns a fresh disposer per call (like
 * `installNukeReloadListener`); single-install is enforced by the page wrapper
 * `installWorkerStaleAssetReloadListener`.
 */
export function installStaleAssetReloadListener(
  instanceId: string,
  onReload: () => void
): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(STALE_ASSET_RELOAD_CHANNEL);
  const handler = (event: MessageEvent): void => {
    const data = event.data as StaleAssetReloadMsg | undefined;
    if (data?.type !== 'stale-asset-reload' || data.instanceId !== instanceId) return;
    onReload();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
```

- [ ] **Step 5: Add the module to the no-DOM worker typecheck**

In `tsconfig.webapp-worker.json`, add to the `include` array (proves the module has no `window`/DOM dependency):

```json
    "packages/webapp/src/core/stale-asset-channel.ts",
```

- [ ] **Step 6: Run test + the worker typecheck to verify they pass**

Run: `npx vitest run packages/webapp/tests/core/stale-asset-channel.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.webapp-worker.json`
Expected: PASS (no `window`/DOM errors — proves worker-safety).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/webapp/src/core/stale-asset-channel.ts packages/webapp/tests/helpers/fake-broadcast-channel.ts packages/webapp/tests/core/stale-asset-channel.test.ts tsconfig.webapp-worker.json
git add packages/webapp/src/core/stale-asset-channel.ts packages/webapp/tests/helpers/fake-broadcast-channel.ts packages/webapp/tests/core/stale-asset-channel.test.ts tsconfig.webapp-worker.json
git commit -m "feat(webapp): stale-asset detection + instanceId-scoped reload channel (#1330)"
```

---

### Task 2: Shared guarded reload + page `vite:preloadError` trigger

**Files:**

- Create: `packages/webapp/src/ui/boot/setup-preload-error-reload.ts`
- Test: `packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`

**Interfaces:**

- Consumes: `installStaleAssetReloadListener` (Task 1); the fake-channel helper.
- Produces: `RELOAD_WINDOW_MS`, `decideStaleReload`, `GuardedReloadDeps`, `guardedReload(deps?)`, `setupPreloadErrorReload(deps?)`, `installWorkerStaleAssetReloadListener(instanceId)`, `__resetForTest()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeBroadcastChannel,
  resetFakeBroadcastChannel,
} from '../../helpers/fake-broadcast-channel.js';
import {
  broadcastStaleAssetReload,
  setStaleAssetInstanceId,
} from '../../../src/core/stale-asset-channel.js';
import {
  __resetForTest,
  decideStaleReload,
  guardedReload,
  installWorkerStaleAssetReloadListener,
  RELOAD_WINDOW_MS,
  setupPreloadErrorReload,
} from '../../../src/ui/boot/setup-preload-error-reload.js';

function makeStorage(initial: Record<string, string> = {}, opts: { throwOn?: 'get' | 'set' } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => {
      if (opts.throwOn === 'get') throw new Error('storage disabled');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOn === 'set') throw new Error('storage disabled');
      map.set(k, v);
    },
  };
}

describe('decideStaleReload', () => {
  it('reloads when no prior timestamp; suppresses within window; allows past window', () => {
    expect(decideStaleReload(null, 1_000, RELOAD_WINDOW_MS)).toBe(true);
    expect(decideStaleReload(1_000, 1_000 + 5_000, RELOAD_WINDOW_MS)).toBe(false);
    expect(decideStaleReload(1_000, 1_000 + RELOAD_WINDOW_MS, RELOAD_WINDOW_MS)).toBe(true);
  });
});

describe('guardedReload', () => {
  it('reloads once, persists, suppresses in-window, reloads again past window', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    let t = 10_000;
    const deps = { reload, storage, now: () => t, windowMs: RELOAD_WINDOW_MS, storageKey: 'k' };
    expect(guardedReload(deps)).toBe(true);
    t += 5_000;
    expect(guardedReload(deps)).toBe(false);
    t += RELOAD_WINDOW_MS;
    expect(guardedReload(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('fail-closed on storage throw (get or set): no reload, no throw', () => {
    const reload = vi.fn();
    for (const throwOn of ['get', 'set'] as const) {
      expect(() =>
        guardedReload({
          reload,
          storage: makeStorage({}, { throwOn }),
          now: () => 1,
          windowMs: RELOAD_WINDOW_MS,
          storageKey: 'k',
        })
      ).not.toThrow();
    }
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('setupPreloadErrorReload (page trigger)', () => {
  beforeEach(() => __resetForTest());
  afterEach(() => __resetForTest());

  it('reloads on vite:preloadError; preventDefaults only when it reloads; suppresses in-window', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    let t = 1_000;
    setupPreloadErrorReload({
      reload,
      storage,
      now: () => t,
      windowMs: RELOAD_WINDOW_MS,
      storageKey: 'k',
    });

    const e1 = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e1.defaultPrevented).toBe(true);

    t += 5_000;
    const e2 = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e2.defaultPrevented).toBe(false);
  });
});

describe('installWorkerStaleAssetReloadListener (worker trigger)', () => {
  beforeEach(() => {
    __resetForTest();
    installFakeBroadcastChannel();
  });
  afterEach(() => {
    setStaleAssetInstanceId(undefined);
    resetFakeBroadcastChannel();
    __resetForTest();
  });

  it('runs the guarded reload on a matching-instanceId broadcast, ignores non-matching', async () => {
    const reload = vi.fn();
    setupPreloadErrorReload({
      reload,
      storage: makeStorage(),
      now: () => 1_000,
      windowMs: RELOAD_WINDOW_MS,
      storageKey: 'k',
    });
    installWorkerStaleAssetReloadListener('inst-A');

    setStaleAssetInstanceId('inst-B'); // other worker
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    setStaleAssetInstanceId('inst-A'); // our worker
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`
Expected: FAIL — cannot resolve `setup-preload-error-reload.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/webapp/src/ui/boot/setup-preload-error-reload.ts
/**
 * Page-side stale-asset recovery (#1330). Owns the one guarded reload every
 * trigger shares, the page `vite:preloadError` handler (page-owned lazy chunks),
 * and the worker-broadcast listener. Sibling to `setup-nuke-reload-listener.ts`.
 */
import { installStaleAssetReloadListener } from '../../core/stale-asset-channel.js';

const STORAGE_KEY = 'slicc:stale-asset-reloaded-at';
/** Must exceed the ~30 s host-ready boot timeout so a stale re-error at boot is
 *  suppressed (loop-proof) while a genuinely new deploy later still reloads. */
export const RELOAD_WINDOW_MS = 60_000;

export interface GuardedReloadDeps {
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
  windowMs: number;
  storageKey: string;
}

function defaultDeps(): GuardedReloadDeps {
  return {
    reload: () => window.location.reload(),
    storage: window.sessionStorage,
    now: () => Date.now(),
    windowMs: RELOAD_WINDOW_MS,
    storageKey: STORAGE_KEY,
  };
}

/** Pure guard: reload iff never reloaded or the window has elapsed. */
export function decideStaleReload(
  lastReloadAt: number | null,
  now: number,
  windowMs: number
): boolean {
  return lastReloadAt === null || now - lastReloadAt >= windowMs;
}

/**
 * Reload at most once per `windowMs` per tab. Fail-closed: if `sessionStorage`
 * can't be read or written we do NOT reload (never reload without a persistable
 * guard, or a broken deploy could loop). Returns whether it reloaded.
 */
export function guardedReload(deps: GuardedReloadDeps = defaultDeps()): boolean {
  let raw: string | null;
  try {
    raw = deps.storage.getItem(deps.storageKey);
  } catch {
    return false;
  }
  const parsed = raw === null ? null : Number(raw);
  const lastReloadAt = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  const now = deps.now();
  if (!decideStaleReload(lastReloadAt, now, deps.windowMs)) return false;
  try {
    deps.storage.setItem(deps.storageKey, String(now));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

let vitePreloadHandler: ((e: Event) => void) | null = null;
let activeDeps: GuardedReloadDeps | null = null;

/** Install the page `vite:preloadError` handler (idempotent). Call FIRST in
 *  `main()`. `preventDefault()` only when we actually reload. */
export function setupPreloadErrorReload(deps?: Partial<GuardedReloadDeps>): void {
  if (vitePreloadHandler) return;
  activeDeps = { ...defaultDeps(), ...deps };
  vitePreloadHandler = (e: Event) => {
    if (guardedReload(activeDeps!)) e.preventDefault();
  };
  window.addEventListener('vite:preloadError', vitePreloadHandler);
}

let workerListenerDispose: (() => void) | null = null;

/** Install the instanceId-scoped worker-broadcast listener (idempotent). MUST be
 *  called BEFORE `spawnKernelWorker()` — BroadcastChannel doesn't buffer and the
 *  worker posts init synchronously. Runs the same `guardedReload`. */
export function installWorkerStaleAssetReloadListener(instanceId: string): () => void {
  if (workerListenerDispose) return workerListenerDispose;
  workerListenerDispose = installStaleAssetReloadListener(instanceId, () => {
    guardedReload(activeDeps ?? undefined);
  });
  return workerListenerDispose;
}

/** Test-only: detach handlers + clear module state. */
export function __resetForTest(): void {
  if (vitePreloadHandler) window.removeEventListener('vite:preloadError', vitePreloadHandler);
  vitePreloadHandler = null;
  activeDeps = null;
  if (workerListenerDispose) workerListenerDispose();
  workerListenerDispose = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/boot/setup-preload-error-reload.ts packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
git add packages/webapp/src/ui/boot/setup-preload-error-reload.ts packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
git commit -m "feat(webapp): shared guarded reload + page vite:preloadError trigger (#1330)"
```

---

### Task 3: Register the page trigger in `main()`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts` (import; first statement in `main()` at line ~48)

**Interfaces:** Consumes `setupPreloadErrorReload` (Task 2).

- [ ] **Step 1: Add the import** (alongside the other `./boot/…` imports):

```ts
import { setupPreloadErrorReload } from './boot/setup-preload-error-reload.js';
```

- [ ] **Step 2: Make it the first statement in `main()`** (before `const app = document.getElementById('app')` and the `?ui-fixture` check):

```ts
async function main(): Promise<void> {
  // Recover a long-lived tab that crashes on a now-gone content-hashed chunk
  // after a deploy (#1330). Installed before any dynamic import() so page-owned
  // lazy-chunk failures are always caught. Harmless on the ?ui-fixture surface.
  setupPreloadErrorReload();

  const app = document.getElementById('app');
  // ...existing body unchanged...
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts
git add packages/webapp/src/ui/main.ts
git commit -m "feat(webapp): register the stale-asset page trigger first in main() (#1330)"
```

---

### Task 4: Worker turn-time trigger (`scoop-context`)

**Files:**

- Modify: `packages/webapp/src/scoops/scoop-context.ts` (import; `handleStaleAssetError`; call in `handlePromptAttemptError` at line ~871, before `handleNonRetryableError`)
- Test: `packages/webapp/tests/scoops/scoop-context.test.ts` (extend)

**Interfaces:** Consumes `isDynamicImportError`, `broadcastStaleAssetReload` (Task 1); existing `isRetryableError`, `emitAgentError`, `ScoopContext`.

- [ ] **Step 1: Write the failing test**

Add the mock + imports **at the top of the file, grouped with the existing imports/mocks** (Vitest hoists `vi.mock` regardless of position — this is a Biome repo, so do NOT add an `eslint-disable import/first` comment):

```ts
// with the other top-level imports:
import {
  broadcastStaleAssetReload,
  isDynamicImportError,
} from '../../src/core/stale-asset-channel.js';

// with the other top-level vi.mock() calls:
vi.mock('../../src/core/stale-asset-channel.js', async (orig) => {
  const actual = await orig<typeof import('../../src/core/stale-asset-channel.js')>();
  return { ...actual, broadcastStaleAssetReload: vi.fn() };
});
```

Then append the describe block, reusing the file's existing `createMockCallbacks()` helper and shared `testScoop` fixture (matching the other `describe` blocks):

```ts
describe('ScoopContext stale-asset error handling', () => {
  const STALE = 'Failed to fetch dynamically imported module: https://x/assets/anthropic-abc.js';

  it('stale-asset string ALSO matches isRetryableError — so the stale check must run first', () => {
    expect(isDynamicImportError(STALE)).toBe(true);
    expect(isRetryableError(STALE)).toBe(true);
  });

  it('handleStaleAssetError broadcasts + surfaces fatal for a dynamic-import error, and returns true', () => {
    vi.mocked(broadcastStaleAssetReload).mockClear();
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);
    const handled = (ctx as any).handleStaleAssetError(STALE) as boolean;
    expect(handled).toBe(true);
    expect(broadcastStaleAssetReload).toHaveBeenCalledTimes(1);
    expect(callbacks.onFatalError).toHaveBeenCalledTimes(1);
  });

  it('handleStaleAssetError ignores a non-dynamic-import error (returns false, no broadcast)', () => {
    vi.mocked(broadcastStaleAssetReload).mockClear();
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);
    expect((ctx as any).handleStaleAssetError('401 Unauthorized')).toBe(false);
    expect(broadcastStaleAssetReload).not.toHaveBeenCalled();
  });
});
```

> `createMockCallbacks()` and `testScoop` already exist in this test file, and
> the private-method-via-`(ctx as any)` pattern is used elsewhere in it.
> `handleStaleAssetError` only touches `onStatusChange` + `onFatalError`/`onError`
>
> - telemetry (`emitAgentError` is a no-op without a sink), so no real FS/container
>   is needed. If `createMockCallbacks()` doesn't set `onFatalError` (it's optional
>   on `ScoopContextCallbacks`), assert on `onError` instead — the fallback branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts -t "stale-asset error handling"`
Expected: FAIL — `(ctx as any).handleStaleAssetError` is not a function.

- [ ] **Step 3: Add the import**

At the top of `packages/webapp/src/scoops/scoop-context.ts`:

```ts
import { broadcastStaleAssetReload, isDynamicImportError } from '../core/stale-asset-channel.js';
```

- [ ] **Step 4: Add `handleStaleAssetError`** (next to `handleNonRetryableError`, ~line 773):

```ts
  /**
   * Handle a stale-asset import failure (#1330). A gone content-hashed chunk
   * after a deploy — retrying the cached-failed import is futile (checked BEFORE
   * the retry matcher, which also matches "failed to fetch"), so ask the owning
   * page to reload (guarded) and surface as fatal. Returns true if handled.
   */
  private handleStaleAssetError(message: string): boolean {
    if (!isDynamicImportError(message)) return false;
    log.error('Stale-asset import failure; requesting page reload', {
      folder: this.scoop.folder,
      error: message,
    });
    broadcastStaleAssetReload();
    emitAgentError('llm', message);
    this.setStatus('error');
    if (this.callbacks.onFatalError) {
      this.callbacks.onFatalError(
        `Scoop "${this.scoop.name}" hit a stale build after a deploy; reloading to recover.`
      );
    } else {
      this.callbacks.onError(message);
    }
    return true;
  }
```

- [ ] **Step 5: Call it first** in `handlePromptAttemptError` (line ~871), before the non-retryable check:

```ts
if (this.handleStaleAssetError(message)) return true;
if (this.handleNonRetryableError(message)) return true;
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/scoop-context.ts packages/webapp/tests/scoops/scoop-context.test.ts
git add packages/webapp/src/scoops/scoop-context.ts packages/webapp/tests/scoops/scoop-context.test.ts
git commit -m "feat(webapp): worker turn-time stale-asset trigger in scoop-context (#1330)"
```

---

### Task 5: Worker boot-time trigger (`kernel-worker`)

**Files:**

- Modify: `packages/webapp/src/kernel/kernel-worker.ts` (`boot()` at line ~241)

**Interfaces:** Consumes `setStaleAssetInstanceId`, `broadcastIfStaleAssetError` (Task 1). Behavioral coverage for the detection lives in Task 1's `broadcastIfStaleAssetError` test (kernel-worker.ts can't be imported in a node test — its module-load `self.addEventListener` throws); the `boot()` wrap itself is verified by typecheck + the existing init-guard reset test.

- [ ] **Step 1: Add the import** at the top of `packages/webapp/src/kernel/kernel-worker.ts`:

```ts
import {
  broadcastIfStaleAssetError,
  setStaleAssetInstanceId,
} from '../core/stale-asset-channel.js';
```

- [ ] **Step 2: Record instanceId + wrap the boot body**

`boot()` begins at line ~241 with `installFetchBypass()` and ends at line ~392 with `init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);`. Record the instanceId first, then wrap the ENTIRE existing body (from `installFetchBypass()` through the ready post) in a try/catch — only indent the existing statements, do not change them:

```ts
async function boot(init: KernelWorkerInitMsg): Promise<void> {
  // #1330: record instanceId up front so a stale-import failure anywhere in boot
  // (registerProviders eagerly imports every provider chunk) broadcasts an
  // instanceId-scoped reload request to the owning page.
  setStaleAssetInstanceId(init.instanceId);
  try {
    installFetchBypass();
    // ... every existing boot statement, unchanged, through:
    init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);
  } catch (err) {
    broadcastIfStaleAssetError(err);
    throw err; // preserve the init-guard reset + worker-ready-timeout fallback
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run kernel tests (init-guard reset on boot error unchanged)**

Run: `npx vitest run packages/webapp/tests/kernel/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/kernel-worker.ts
git add packages/webapp/src/kernel/kernel-worker.ts
git commit -m "feat(webapp): worker boot-time stale-asset trigger in kernel-worker (#1330)"
```

---

### Task 6: `worker.onerror` trigger + install-before-spawn ordering

**Files:**

- Modify: `packages/webapp/src/kernel/spawn.ts` (`WorkerLike` ~line 41; `KernelWorkerSpawnOptions` ~line 47; `KernelWorkerBootstrapOptions` ~line 108; `bootstrapKernelWorker` ~line 170; `spawnKernelWorker` ~line 301)
- Modify: `packages/webapp/src/ui/wc/wc-live.ts` (spawn site ~line 1607; `instanceId` in scope from ~line 1580)
- Test: `packages/webapp/tests/kernel/spawn.test.ts` (extend the existing `MockWorker`)

**Interfaces:** Consumes `installWorkerStaleAssetReloadListener`, `guardedReload` (Task 2). Produces `onWorkerScriptError?: () => void` on both option types; `WorkerLike.addEventListener?`.

- [ ] **Step 1: Write the failing test** (extend `tests/kernel/spawn.test.ts`)

Give the existing `MockWorker` an `addEventListener` that captures the `error` listener, then assert `bootstrapKernelWorker` wires it to `onWorkerScriptError`:

```ts
describe('bootstrapKernelWorker onWorkerScriptError', () => {
  it('calls onWorkerScriptError when the worker fires an error event', () => {
    let errorListener: (() => void) | null = null;
    const worker: WorkerLike = {
      postMessage: () => {},
      terminate: () => {},
      addEventListener: (_t: 'error', l: () => void) => {
        errorListener = l;
      },
    };
    const onWorkerScriptError = vi.fn();
    // Small readyTimeoutMs so the never-posts-ready mock can't arm a 30s timer,
    // and dispose() in `finally` clears it even if an assertion throws (dispose
    // → cleanupReady clears the ready timeout — spawn.ts).
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: { on: () => {}, off: () => {}, send: async () => ({}) } as never,
      callbacks: {} as never,
      readyTimeoutMs: 50,
      onWorkerScriptError,
    });
    try {
      expect(errorListener).toBeTypeOf('function');
      errorListener!();
      expect(onWorkerScriptError).toHaveBeenCalledTimes(1);
    } finally {
      host.dispose();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/spawn.test.ts -t "onWorkerScriptError"`
Expected: FAIL — `onWorkerScriptError` not in options / listener never captured.

- [ ] **Step 3: Extend `WorkerLike` + both option types + wire the listener in `bootstrapKernelWorker`**

In `spawn.ts`, add to `WorkerLike` (~line 42):

```ts
  /** Optional — real `Worker` has it; the mock may omit it. */
  addEventListener?(type: 'error', listener: () => void): void;
```

Add to BOTH `KernelWorkerSpawnOptions` (~line 47) and `KernelWorkerBootstrapOptions` (~line 108):

```ts
  /** Page-side hook fired if the worker ENTRY chunk fails to load (stale after a
   *  deploy) — the worker never evaluates, so its own boot catch can't run. (#1330) */
  onWorkerScriptError?: () => void;
```

In `bootstrapKernelWorker` (~line 170), attach the listener near the top (before/after wiring the ports — anywhere before returning):

```ts
if (options.onWorkerScriptError) {
  options.worker.addEventListener?.('error', () => options.onWorkerScriptError!());
}
```

In `spawnKernelWorker` (~line 305), pass it through to `bootstrapKernelWorker`:

```ts
    extensionDelegateId: options.extensionDelegateId,
    onWorkerScriptError: options.onWorkerScriptError,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/webapp/tests/kernel/spawn.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Wire the caller in `wc-live.ts`**

Add the import near the other boot imports:

```ts
import {
  guardedReload,
  installWorkerStaleAssetReloadListener,
} from '../boot/setup-preload-error-reload.js';
```

At the spawn site (~line 1607), install the listener BEFORE `spawnKernelWorker` and pass `onWorkerScriptError`:

```ts
const boot = prepareWcShell(app, floatLabel);
// #1330: install the reload listener BEFORE spawning — BroadcastChannel doesn't
// buffer and the worker posts init synchronously, so a late listener would miss
// a fast boot-time failure.
if (instanceId) installWorkerStaleAssetReloadListener(instanceId);
const host = spawnKernelWorker({
  realCdpTransport,
  instanceId,
  callbacks: createWcLiveCallbacks(boot.wiring),
  localApiBaseUrl,
  bridgeToken,
  localLickWsUrl,
  extensionDelegateId,
  onWorkerScriptError: () => {
    guardedReload();
  },
});
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/spawn.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/tests/kernel/spawn.test.ts
git add packages/webapp/src/kernel/spawn.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/tests/kernel/spawn.test.ts
git commit -m "feat(webapp): worker.onerror trigger + install reload listener before spawn (#1330)"
```

---

### Task 7: Docs + verification + close the issue

**Files:**

- Modify: `packages/webapp/CLAUDE.md`, `docs/pitfalls.md`

- [ ] **Step 1: Add the webapp CLAUDE.md note** (UI/boot section):

```markdown
### Stale-asset recovery (post-deploy)

After a deploy, a long-lived tab/worker can crash on a now-gone content-hashed
chunk (#1330). Four triggers funnel into one shared, **instanceId-scoped**,
**fail-closed**, timestamp-guarded (`RELOAD_WINDOW_MS = 60_000`) page reload
(`ui/boot/setup-preload-error-reload.ts` + realm-agnostic
`core/stale-asset-channel.ts`): page `vite:preloadError`; page `Worker` `error`
(`spawn.ts` `onWorkerScriptError`); worker `boot()` `try/catch`
(`broadcastIfStaleAssetError`); worker `scoop-context` classifier (checked BEFORE
the `failed to fetch` retry matcher). Worker triggers broadcast over
`BroadcastChannel` stamped with `instanceId`; only the owning page reloads. The
listener installs BEFORE `spawnKernelWorker()` (BroadcastChannel doesn't buffer).
```

- [ ] **Step 2: Add the pitfalls.md entry:**

```markdown
## Stale content-hashed chunks after a deploy (#1330)

A long-lived tab/worker holds an old module graph; after a deploy the old
`/assets/<hash>.js` is gone and the worker's SPA fallback returns `index.html` as
`200 text/html`, so the lazy `import()` rejects with a MIME/module-script error.
The failing import is usually WORKER-owned (providers load in the kernel worker),
and Vite injects `vite:preloadError` only into the PAGE bundle — so a `window`
listener alone can't catch it. Recovery is the four-trigger guarded reload in
`core/stale-asset-channel.ts` + `ui/boot/setup-preload-error-reload.ts`.
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/CLAUDE.md docs/pitfalls.md
git add packages/webapp/CLAUDE.md docs/pitfalls.md
git commit -m "docs: stale-asset recovery note + pitfall (#1330)"
```

- [ ] **Step 4: Full verification gate** — run each, confirm PASS:

```bash
npm run lint:ci
npm run deadcode
npm run typecheck
npm run test:coverage:webapp
npm run build -w @slicc/chrome-extension
```

(Top-level `npm run build` fails only at the `swift-server` step on this machine — a known Swift-toolchain constraint unrelated to this change; the TS workspaces build before it.)

- [ ] **Step 5: PR body includes `Fixes #1330`.**

---

## Self-Review

**Spec coverage:** page `vite:preloadError` → Task 2/3; worker boot-time → Task 5 (+ `broadcastIfStaleAssetError` test in Task 1); worker turn-time → Task 4; page `worker.onerror` → Task 6; instanceId-scoped channel + module-script-anchored matcher → Task 1; 60 s timestamp guard + fail-closed → Task 2; install-before-spawn ordering → Task 6; `setStaleAssetInstanceId` + dev-warn → Task 1 (impl + test); listener idempotency at the wrapper → Task 2; worker-safety proof → Task 1 (tsconfig include); docs + close → Task 7. ✓

**Placeholder scan:** every code step shows complete code; no TBD/TODO; the one test that can't be fully exercised in the env (real `Worker`) is replaced by the injectable `bootstrapKernelWorker` + `MockWorker` path — honest coverage. ✓

**Type consistency:** `guardedReload(deps?)`, `GuardedReloadDeps`, `installWorkerStaleAssetReloadListener(instanceId)`, `broadcastStaleAssetReload()`, `broadcastIfStaleAssetError(err)`, `setStaleAssetInstanceId(id)`, `isDynamicImportError(msg)`, `installStaleAssetReloadListener(instanceId,onReload)`, `WorkerLike.addEventListener?`, `onWorkerScriptError?` — consistent across Tasks 1, 2, 4, 5, 6. ✓
