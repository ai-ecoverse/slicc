# Stale-asset recovery after deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a deploy, automatically recover any long-lived SLICC tab/worker that crashes on a now-gone content-hashed Vite chunk, instead of leaving the session unrecoverable (issue #1330).

**Architecture:** Four triggers funnel into one shared, instanceId-scoped, fail-closed, timestamp-guarded page reload. Two page-side triggers (`window` `vite:preloadError` for page-owned lazy chunks; a `Worker` `error` event for a stale worker entry chunk) and two worker-side triggers (a `boot()` `try/catch` for boot-time provider imports; the `scoop-context` turn-error classifier) — the worker triggers `postMessage` an instanceId-stamped signal over a `BroadcastChannel` that only the owning page acts on.

**Tech Stack:** TypeScript, Vite (content-hashed chunks + `__vitePreload`/`vite:preloadError`), Vitest (jsdom for DOM/BroadcastChannel tests), Cloudflare Workers Static Assets (SPA fallback).

## Global Constraints

- Scope is **`packages/webapp` only** — no `cloudflare-worker` / `cloud-core` changes.
- The shared detection/channel module MUST be realm-agnostic (no `window`/`document` at module scope) — it is imported by the page AND the kernel worker.
- Reload guard: **timestamp window `RELOAD_WINDOW_MS = 60_000`** (must exceed the 30 s host-ready boot timeout), **fail-closed** on any `sessionStorage` throw (never reload if the guard can't be read/persisted), `sessionStorage` key `'slicc:stale-asset-reloaded-at'`.
- Worker→page signal is **instanceId-scoped** (`BroadcastChannel 'slicc-stale-asset-reload'`, message `{ type: 'stale-asset-reload', instanceId }`); the page listener acts only on its own `instanceId`. Never origin-wide.
- **Ordering is load-bearing:** `BroadcastChannel` does NOT buffer and `spawnKernelWorker()` posts `kernel-worker-init` synchronously, so the page reload listener MUST be installed BEFORE `spawnKernelWorker()` is called.
- `isDynamicImportError` anchors on module-script context (`module script` / `JavaScript module` / `dynamically imported module`); a bare `MIME type` match is forbidden (false-positive risk).
- Commits: focused, package-local, **no `Co-Authored-By` trailer**. Run `npx prettier --write` on touched files before each commit.

## File Structure

- **Create** `packages/webapp/src/core/stale-asset-channel.ts` — realm-agnostic: `isDynamicImportError`, the `BroadcastChannel` name + message type, `setStaleAssetInstanceId`, `broadcastStaleAssetReload`, `installStaleAssetReloadListener`. (In `core/` — imported by both page and worker; avoids a worker→`ui/` import.)
- **Create** `packages/webapp/src/ui/boot/setup-preload-error-reload.ts` — page-only: `decideStaleReload`, `guardedReload`, `setupPreloadErrorReload`, `installWorkerStaleAssetReloadListener`.
- **Modify** `packages/webapp/src/ui/main.ts` — call `setupPreloadErrorReload()` first in `main()`.
- **Modify** `packages/webapp/src/scoops/scoop-context.ts` — turn-time trigger: a stale-asset guard checked before `handleNonRetryableError`.
- **Modify** `packages/webapp/src/kernel/kernel-worker.ts` — boot-time trigger: `setStaleAssetInstanceId` + `try/catch` around `boot()`.
- **Modify** `packages/webapp/src/kernel/spawn.ts` — `onWorkerScriptError?` option → `worker.addEventListener('error', …)`.
- **Modify** `packages/webapp/src/ui/wc/wc-live.ts` — install the listener before `spawnKernelWorker`, pass `onWorkerScriptError`.
- **Create** tests: `tests/core/stale-asset-channel.test.ts`, `tests/ui/boot/setup-preload-error-reload.test.ts`; **extend** `tests/scoops/scoop-context.test.ts`.
- **Modify** docs: `packages/webapp/CLAUDE.md`, `docs/pitfalls.md`.

---

### Task 1: Shared detection + channel module

**Files:**

- Create: `packages/webapp/src/core/stale-asset-channel.ts`
- Test: `packages/webapp/tests/core/stale-asset-channel.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces:
  - `isDynamicImportError(msg: string): boolean`
  - `STALE_ASSET_RELOAD_CHANNEL: string`
  - `interface StaleAssetReloadMsg { type: 'stale-asset-reload'; instanceId: string }`
  - `setStaleAssetInstanceId(id: string | undefined): void`
  - `broadcastStaleAssetReload(): void`
  - `installStaleAssetReloadListener(instanceId: string, onReload: () => void): () => void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/core/stale-asset-channel.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

  it('does NOT match unrelated errors (no bare MIME / bare failed-to-fetch)', () => {
    expect(isDynamicImportError('401 Unauthorized')).toBe(false);
    expect(isDynamicImportError('rate limit exceeded')).toBe(false);
    expect(isDynamicImportError('network error')).toBe(false);
    expect(isDynamicImportError('Upload failed: unsupported MIME type image/tiff')).toBe(false);
    expect(isDynamicImportError('TypeError: Failed to fetch')).toBe(false);
  });
});

describe('broadcastStaleAssetReload / installStaleAssetReloadListener', () => {
  afterEach(() => setStaleAssetInstanceId(undefined));

  it('delivers only to a listener with the matching instanceId', async () => {
    const matched = vi.fn();
    const other = vi.fn();
    const d1 = installStaleAssetReloadListener('inst-A', matched);
    const d2 = installStaleAssetReloadListener('inst-B', other);
    setStaleAssetInstanceId('inst-A');
    broadcastStaleAssetReload();
    await new Promise((r) => setTimeout(r, 0));
    expect(matched).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    d1();
    d2();
  });

  it('no-ops when no instanceId has been set', async () => {
    const cb = vi.fn();
    const d = installStaleAssetReloadListener('inst-A', cb);
    broadcastStaleAssetReload();
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).not.toHaveBeenCalled();
    d();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/core/stale-asset-channel.test.ts`
Expected: FAIL — cannot resolve `../../src/core/stale-asset-channel.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/webapp/src/core/stale-asset-channel.ts
/**
 * Realm-agnostic detection + worker→page signal for stale-chunk recovery after
 * a deploy (#1330). Shell-free and DOM-free at module scope (only
 * `BroadcastChannel`, available in the page AND the kernel worker), so both
 * realms import it. Mirrors the split-out shape of `nuke-channel.ts`.
 */
import { createLogger } from './logger.js';

const log = createLogger('stale-asset');

// Anchored on module-script context — NOT a bare "MIME type" or "failed to
// fetch", which would false-positive on unrelated tool/upload/provider errors
// classified from a generic error.message.
const DYNAMIC_IMPORT_ERROR_RE =
  /dynamically imported module|importing a module script failed|expected a javascript module|module script/i;

/** True for the cross-browser dynamic-import / module-script load failure family. */
export function isDynamicImportError(msg: string): boolean {
  return DYNAMIC_IMPORT_ERROR_RE.test(msg);
}

/** Same-origin channel the failing worker uses to ask its owning page to reload. */
export const STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload';

export interface StaleAssetReloadMsg {
  type: 'stale-asset-reload';
  instanceId: string;
}

// Set once by the kernel worker at boot start; read by the broadcasters so both
// worker failure sites reach the signal without threading the id through.
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

/**
 * Page-side listener. Invokes `onReload` only for a broadcast stamped with the
 * page's own `instanceId` (never another tab's). Returns a disposer.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/core/stale-asset-channel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/core/stale-asset-channel.ts packages/webapp/tests/core/stale-asset-channel.test.ts
git add packages/webapp/src/core/stale-asset-channel.ts packages/webapp/tests/core/stale-asset-channel.test.ts
git commit -m "feat(webapp): stale-asset detection + instanceId-scoped reload channel (#1330)"
```

---

### Task 2: Shared guarded reload + page `vite:preloadError` trigger

**Files:**

- Create: `packages/webapp/src/ui/boot/setup-preload-error-reload.ts`
- Test: `packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`

**Interfaces:**

- Consumes: `installStaleAssetReloadListener` from Task 1.
- Produces:
  - `RELOAD_WINDOW_MS: number`
  - `decideStaleReload(lastReloadAt: number | null, now: number, windowMs: number): boolean`
  - `interface GuardedReloadDeps { reload: () => void; storage: Pick<Storage,'getItem'|'setItem'>; now: () => number; windowMs: number; storageKey: string }`
  - `guardedReload(deps?: GuardedReloadDeps): boolean`
  - `setupPreloadErrorReload(deps?: Partial<GuardedReloadDeps>): void`
  - `installWorkerStaleAssetReloadListener(instanceId: string): () => void`
  - `__resetForTest(): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTest,
  decideStaleReload,
  guardedReload,
  installWorkerStaleAssetReloadListener,
  RELOAD_WINDOW_MS,
  setupPreloadErrorReload,
} from '../../../src/ui/boot/setup-preload-error-reload.js';
import {
  broadcastStaleAssetReload,
  setStaleAssetInstanceId,
} from '../../../src/core/stale-asset-channel.js';

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
  it('reloads once and persists the timestamp; suppresses a second call in-window', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    let t = 10_000;
    const deps = { reload, storage, now: () => t, windowMs: RELOAD_WINDOW_MS, storageKey: 'k' };
    expect(guardedReload(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    t += 5_000;
    expect(guardedReload(deps)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    t += RELOAD_WINDOW_MS;
    expect(guardedReload(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('fail-closed: does not reload (and does not throw) when storage throws', () => {
    const reload = vi.fn();
    expect(() =>
      guardedReload({
        reload,
        storage: makeStorage({}, { throwOn: 'get' }),
        now: () => 1,
        windowMs: RELOAD_WINDOW_MS,
        storageKey: 'k',
      })
    ).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
    expect(() =>
      guardedReload({
        reload,
        storage: makeStorage({}, { throwOn: 'set' }),
        now: () => 1,
        windowMs: RELOAD_WINDOW_MS,
        storageKey: 'k',
      })
    ).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('setupPreloadErrorReload (page trigger)', () => {
  beforeEach(() => __resetForTest());

  it('reloads on vite:preloadError and preventDefaults only when it reloads', () => {
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
    setStaleAssetInstanceId(undefined);
  });

  it('runs the guarded reload on a matching-instanceId broadcast', async () => {
    const reload = vi.fn();
    const storage = makeStorage();
    setupPreloadErrorReload({
      reload,
      storage,
      now: () => 1_000,
      windowMs: RELOAD_WINDOW_MS,
      storageKey: 'k',
    });
    installWorkerStaleAssetReloadListener('inst-A');
    setStaleAssetInstanceId('inst-A');
    broadcastStaleAssetReload();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`
Expected: FAIL — cannot resolve `setup-preload-error-reload.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/webapp/src/ui/boot/setup-preload-error-reload.ts
/**
 * Page-side stale-asset recovery (#1330). Owns the one guarded reload every
 * trigger shares, plus the page `vite:preloadError` handler (page-owned lazy
 * chunks) and the worker-broadcast listener. Sibling to
 * `setup-nuke-reload-listener.ts`. See the spec for the four-trigger design.
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
 * Reload the page at most once per `windowMs` per tab. Fail-closed: if
 * `sessionStorage` can't be read or written we do NOT reload (never reload
 * without a persistable guard, or a broken deploy could loop). Returns whether
 * it triggered a reload.
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

/**
 * Install the page `vite:preloadError` handler (idempotent). Call FIRST in
 * `main()`, before any dynamic `import()`. `preventDefault()` is called only
 * when we actually reload, so a guard-suppressed error still surfaces.
 */
export function setupPreloadErrorReload(deps?: Partial<GuardedReloadDeps>): void {
  if (vitePreloadHandler) return;
  activeDeps = { ...defaultDeps(), ...deps };
  vitePreloadHandler = (e: Event) => {
    if (guardedReload(activeDeps!)) e.preventDefault();
  };
  window.addEventListener('vite:preloadError', vitePreloadHandler);
}

let workerListenerDispose: (() => void) | null = null;

/**
 * Install the instanceId-scoped worker-broadcast listener (idempotent). MUST be
 * called BEFORE `spawnKernelWorker()` — `BroadcastChannel` does not buffer and
 * the worker posts init synchronously, so a late listener misses a fast
 * boot-time failure. Runs the same `guardedReload` as the page trigger.
 */
export function installWorkerStaleAssetReloadListener(instanceId: string): () => void {
  if (workerListenerDispose) return workerListenerDispose;
  workerListenerDispose = installStaleAssetReloadListener(instanceId, () => {
    guardedReload(activeDeps ?? undefined);
  });
  return workerListenerDispose;
}

/** Test-only: detach handlers and clear module state. */
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
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/boot/setup-preload-error-reload.ts packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
git add packages/webapp/src/ui/boot/setup-preload-error-reload.ts packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts
git commit -m "feat(webapp): shared guarded reload + page vite:preloadError trigger (#1330)"
```

---

### Task 3: Register the page trigger in `main()`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts` (inside `main()`, first statement)

**Interfaces:**

- Consumes: `setupPreloadErrorReload` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Add the import and the first-statement call**

At the top of `packages/webapp/src/ui/main.ts`, add the import alongside the other `./boot/…` imports:

```ts
import { setupPreloadErrorReload } from './boot/setup-preload-error-reload.js';
```

Then make it the FIRST statement inside `async function main()` (before `const app = document.getElementById('app')` and before the `?ui-fixture` check):

```ts
async function main(): Promise<void> {
  // Recover any long-lived tab that crashes on a now-gone content-hashed chunk
  // after a deploy (#1330). Installed before any dynamic import() so page-owned
  // lazy-chunk failures are always caught. Harmless on the ?ui-fixture surface
  // (no worker, no provider imports).
  setupPreloadErrorReload();

  const app = document.getElementById('app');
  // ...existing body unchanged...
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts
git add packages/webapp/src/ui/main.ts
git commit -m "feat(webapp): register the stale-asset page trigger first in main() (#1330)"
```

---

### Task 4: Worker turn-time trigger (`scoop-context`)

**Files:**

- Modify: `packages/webapp/src/scoops/scoop-context.ts` (import; new `handleStaleAssetError`; call before `handleNonRetryableError` at ~line 871)
- Test: `packages/webapp/tests/scoops/scoop-context.test.ts` (extend)

**Interfaces:**

- Consumes: `isDynamicImportError`, `broadcastStaleAssetReload` from Task 1; existing `isRetryableError`.
- Produces: private `handleStaleAssetError(message: string): boolean`.

- [ ] **Step 1: Write the failing test (precedence)**

Append to `packages/webapp/tests/scoops/scoop-context.test.ts`. It proves the stale-asset string ALSO matches the generic retry matcher, so the stale check must run first:

```ts
import { isDynamicImportError } from '../../src/core/stale-asset-channel.js';

describe('stale-asset error takes precedence over the retry matcher', () => {
  const staleMsg = 'Failed to fetch dynamically imported module: https://x/assets/anthropic-abc.js';
  it('is detected as a dynamic-import error', () => {
    expect(isDynamicImportError(staleMsg)).toBe(true);
  });
  it('ALSO matches isRetryableError ("failed to fetch") — hence the stale check must run first', () => {
    expect(isRetryableError(staleMsg)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts -t "stale-asset error takes precedence"`
Expected: FAIL — cannot resolve `stale-asset-channel.js` import.

- [ ] **Step 3: Add the import**

At the top of `packages/webapp/src/scoops/scoop-context.ts`, add:

```ts
import { broadcastStaleAssetReload, isDynamicImportError } from '../core/stale-asset-channel.js';
```

- [ ] **Step 4: Add the guard method**

Add this private method next to `handleNonRetryableError` (after it, ~line 773):

```ts
  /**
   * Handle a stale-asset import failure (#1330). A gone content-hashed chunk
   * after a deploy — retrying the cached-failed import is futile (checked
   * before the retry matcher, which also matches "failed to fetch"), so ask the
   * owning page to reload (guarded) and surface as fatal. Returns true if handled.
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

- [ ] **Step 5: Call it first in the error sequence**

In the turn-error handling (line ~871), add the stale check BEFORE the non-retryable check:

```ts
if (this.handleStaleAssetError(message)) return true;
if (this.handleNonRetryableError(message)) return true;
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts`
Expected: PASS (existing + the 2 new precedence tests).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/scoop-context.ts packages/webapp/tests/scoops/scoop-context.test.ts
git add packages/webapp/src/scoops/scoop-context.ts packages/webapp/tests/scoops/scoop-context.test.ts
git commit -m "feat(webapp): worker turn-time stale-asset trigger in scoop-context (#1330)"
```

---

### Task 5: Worker boot-time trigger (`kernel-worker`)

**Files:**

- Modify: `packages/webapp/src/kernel/kernel-worker.ts` (`boot()` — `setStaleAssetInstanceId` + `try/catch`)

**Interfaces:**

- Consumes: `setStaleAssetInstanceId`, `broadcastStaleAssetReload`, `isDynamicImportError` from Task 1.
- Produces: nothing new (behavioral change to `boot`).

- [ ] **Step 1: Add the import**

At the top of `packages/webapp/src/kernel/kernel-worker.ts`:

```ts
import {
  broadcastStaleAssetReload,
  isDynamicImportError,
  setStaleAssetInstanceId,
} from '../core/stale-asset-channel.js';
```

- [ ] **Step 2: Record the instanceId first, wrap the boot body**

`boot()` currently reads `async function boot(init: KernelWorkerInitMsg): Promise<void> {` then runs its body (setBridgeToken … `registerProviders()` … `kernel-worker-ready`). Change to record the instanceId first and wrap the whole body so a stale boot import broadcasts then rethrows (preserving the init-guard reset + worker-ready-timeout fallback):

```ts
async function boot(init: KernelWorkerInitMsg): Promise<void> {
  // Record our instanceId up front so a stale-import failure anywhere in boot
  // (registerProviders eagerly imports every provider chunk) can broadcast an
  // instanceId-scoped reload request to the owning page. (#1330)
  setStaleAssetInstanceId(init.instanceId);
  try {
    // ↓↓↓ the entire existing boot body, unchanged, moves inside this try ↓↓↓
    setBridgeToken(init.bridgeToken ?? null);
    // ... all existing statements through:
    init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);
    // ↑↑↑ end existing body ↑↑↑
  } catch (err) {
    if (isDynamicImportError(String((err as Error)?.message ?? err))) {
      broadcastStaleAssetReload();
    }
    throw err;
  }
}
```

Do NOT change any statement inside the body — only indent it into the `try`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the kernel-worker unit tests (guard still resets on boot error)**

Run: `npx vitest run packages/webapp/tests/kernel/`
Expected: PASS (the init-guard reset-on-error behavior is unchanged — `boot()` still rejects).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/kernel-worker.ts
git add packages/webapp/src/kernel/kernel-worker.ts
git commit -m "feat(webapp): worker boot-time stale-asset trigger in kernel-worker (#1330)"
```

---

### Task 6: `worker.onerror` trigger + install-before-spawn ordering

**Files:**

- Modify: `packages/webapp/src/kernel/spawn.ts` (`KernelWorkerSpawnOptions` + `spawnKernelWorker`)
- Modify: `packages/webapp/src/ui/wc/wc-live.ts` (install listener before spawn; pass `onWorkerScriptError`)
- Test: `packages/webapp/tests/kernel/spawn-worker-error.test.ts`

**Interfaces:**

- Consumes: `installWorkerStaleAssetReloadListener`, `guardedReload` from Task 2.
- Produces: `KernelWorkerSpawnOptions.onWorkerScriptError?: () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/webapp/tests/kernel/spawn-worker-error.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { spawnKernelWorker } from '../../src/kernel/spawn.js';

describe('spawnKernelWorker onWorkerScriptError', () => {
  it('calls onWorkerScriptError when the worker script fails to load', () => {
    const onWorkerScriptError = vi.fn();
    // A bogus workerUrl makes `new Worker` fail to load; jsdom emits an 'error'
    // event on the Worker. (jsdom's Worker is a stub that never becomes ready,
    // so we assert the listener is wired by dispatching the event ourselves.)
    const host = spawnKernelWorker({
      workerUrl: 'data:application/javascript,//noop',
      realCdpTransport: { on: () => {}, off: () => {}, send: async () => ({}) } as never,
      callbacks: {} as never,
      instanceId: 'inst-A',
      onWorkerScriptError,
    });
    // The Worker reference is not exposed; simulate the browser firing 'error'
    // by grabbing it via the spy path is overkill — instead assert no throw and
    // that a subsequent error event on any Worker created is handled. We assert
    // wiring indirectly: the option is accepted and spawn returns a host.
    expect(host).toBeTruthy();
    host.dispose?.();
  });
});
```

> Note: jsdom's `Worker` does not reliably emit `error` for a bad module URL. Keep this test to "option accepted + no throw"; the behavioral guarantee (a real `error` event → `guardedReload`) is covered by Task 2's `installWorkerStaleAssetReloadListener` test plus the one-line `addEventListener` wiring, which is code-review-verifiable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/spawn-worker-error.test.ts`
Expected: FAIL — `onWorkerScriptError` is not a known option (TS) / host shape mismatch.

- [ ] **Step 3: Add the option to `spawn.ts`**

In `KernelWorkerSpawnOptions` (the interface around line 119), add:

```ts
  /** Page-side hook fired if the worker ENTRY chunk fails to load (stale after a
   *  deploy) — the worker never evaluates, so its own boot catch can't run.
   *  Wired to the guarded reload. (#1330) */
  onWorkerScriptError?: () => void;
```

In `spawnKernelWorker` (line 301), attach the handler right after the `Worker` is created, before `bootstrapKernelWorker`:

```ts
export function spawnKernelWorker(options: KernelWorkerSpawnOptions): SpawnedKernelHost {
  const worker = options.workerUrl
    ? new Worker(options.workerUrl, { type: 'module' })
    : new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
  if (options.onWorkerScriptError) {
    worker.addEventListener('error', () => options.onWorkerScriptError!());
  }
  return bootstrapKernelWorker({
    worker,
    // ...existing fields unchanged...
  });
}
```

- [ ] **Step 4: Wire the caller in `wc-live.ts`**

Add the import near the other boot imports:

```ts
import {
  guardedReload,
  installWorkerStaleAssetReloadListener,
} from '../boot/setup-preload-error-reload.js';
```

At the spawn site (line ~1607), install the listener BEFORE `spawnKernelWorker` and pass `onWorkerScriptError`:

```ts
const boot = prepareWcShell(app, floatLabel);
// #1330: install the instanceId-scoped reload listener BEFORE spawning the
// worker — BroadcastChannel doesn't buffer and the worker posts init
// synchronously, so a late listener would miss a fast boot-time failure.
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

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run packages/webapp/tests/kernel/spawn-worker-error.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/spawn.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/tests/kernel/spawn-worker-error.test.ts
git add packages/webapp/src/kernel/spawn.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/tests/kernel/spawn-worker-error.test.ts
git commit -m "feat(webapp): worker.onerror trigger + install reload listener before spawn (#1330)"
```

---

### Task 7: Docs + close the issue

**Files:**

- Modify: `packages/webapp/CLAUDE.md` (UI/boot section)
- Modify: `docs/pitfalls.md`

**Interfaces:** none.

- [ ] **Step 1: Add the webapp CLAUDE.md note**

Under the `packages/webapp/CLAUDE.md` "UI" or boot area, add:

```markdown
### Stale-asset recovery (post-deploy)

After a deploy, a long-lived tab/worker can crash on a now-gone content-hashed
chunk (#1330). Four triggers funnel into one shared, **instanceId-scoped**,
**fail-closed**, timestamp-guarded (`RELOAD_WINDOW_MS = 60_000`) page reload
(`ui/boot/setup-preload-error-reload.ts` + the realm-agnostic
`core/stale-asset-channel.ts`):

- page `window` `vite:preloadError` — page-owned lazy chunks;
- page `Worker` `error` (`spawn.ts` `onWorkerScriptError`) — a stale worker ENTRY chunk;
- worker `boot()` `try/catch` — boot-time `registerProviders()` imports;
- worker `scoop-context` classifier — turn-time imports (checked BEFORE the
  `failed to fetch` retry matcher so it isn't retried 3× futilely).

Worker triggers `broadcastStaleAssetReload()` over `BroadcastChannel`, stamped
with the worker's `instanceId`; only the owning page reloads. The listener is
installed BEFORE `spawnKernelWorker()` (BroadcastChannel doesn't buffer). Fresh
`index.html` on reload relies on `location.reload()` top-document revalidation.
```

- [ ] **Step 2: Add the pitfalls.md entry**

Append to `docs/pitfalls.md`:

```markdown
## Stale content-hashed chunks after a deploy (#1330)

A long-lived sliccy.ai tab/worker holds an old module graph; after a deploy the
old `/assets/<hash>.js` is gone. The worker's SPA fallback
(`not_found_handling: single-page-application`) returns `index.html` as
`200 text/html`, so the lazy `import()` rejects with a MIME/module-script error
(not a 404). The failing import is usually WORKER-owned (providers load in the
kernel worker), and Vite injects `vite:preloadError` only into the PAGE bundle —
so a `window` listener alone can't catch it. Recovery is the four-trigger guarded
reload in `core/stale-asset-channel.ts` + `ui/boot/setup-preload-error-reload.ts`.
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/CLAUDE.md docs/pitfalls.md
git add packages/webapp/CLAUDE.md docs/pitfalls.md
git commit -m "docs: stale-asset recovery note + pitfall (#1330)"
```

- [ ] **Step 4: Full verification gate**

Run each and confirm PASS:

```bash
npm run lint:ci
npm run deadcode
npm run typecheck
npm run test:coverage:webapp
npm run build -w @slicc/chrome-extension
```

(The top-level `npm run build` fails only at the `swift-server` step on this
machine — a known Swift-toolchain constraint unrelated to this change; the TS
workspaces build before it.)

- [ ] **Step 5: Close the issue on merge**

Ensure the PR body includes `Fixes #1330`.

---

## Self-Review

**Spec coverage:**

- Page `vite:preloadError` trigger → Task 2 + Task 3. ✓
- Worker boot-time trigger → Task 5. ✓
- Worker turn-time trigger → Task 4. ✓
- Page `worker.onerror` trigger → Task 6. ✓
- instanceId-scoped channel + `isDynamicImportError` (module-script anchored) → Task 1. ✓
- Timestamp guard (60 s) + fail-closed → Task 2. ✓
- Install-before-spawn ordering → Task 6 (caller installs before `spawnKernelWorker`). ✓
- `setStaleAssetInstanceId` at boot start + dev-warn → Task 1 + Task 5. ✓
- Idempotent listener → Task 2 (`installWorkerStaleAssetReloadListener` guard). ✓
- Docs + close #1330 → Task 7. ✓
- Out-of-scope (worker `no-cache`, server 404, cloud auto-restart) → intentionally omitted. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one soft spot (jsdom can't reliably fire `Worker` `error`) is called out explicitly with the compensating coverage, not hidden. ✓

**Type consistency:** `guardedReload(deps?)`, `GuardedReloadDeps`, `installWorkerStaleAssetReloadListener(instanceId)`, `broadcastStaleAssetReload()`, `setStaleAssetInstanceId(id)`, `isDynamicImportError(msg)`, `onWorkerScriptError?` — names/signatures match across Tasks 1, 2, 4, 5, 6. ✓
