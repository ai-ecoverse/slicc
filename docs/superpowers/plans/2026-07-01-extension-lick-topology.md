# Extension Lick Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make licks (webhook / crontask / lick-ws) work in the extension-delegate leader (a hosted tab with no node-server) by finishing the float-topology migration and retiring the dead `isExtension` flag.

**Architecture:** Generalize the existing secrets-only `resolveSecretTopology()` into a shared `resolveFloatTopology()` + `hasLocalNodeServer()` predicate. Gate the `/licks-ws` bridge and the webhook/crontask node-server-REST paths on `hasLocalNodeServer()` (topology `node-rest`) instead of the dead `KernelHostConfig.isExtension` / the naive `!!chrome.runtime.id` heuristic. Extension-delegate leaders route licks through the worker-resident `LickManager` + the tray worker (which already delivers inbound webhook events).

**Tech Stack:** TypeScript, Vitest (node env, `globals: true`), the webapp browser bundle.

## Global Constraints

- **Discriminator:** gate on `resolveFloatTopology() === 'node-rest'` (via `hasLocalNodeServer()`), NOT `localLickWsUrl != null` (serve-only is `node-rest` with a null override and relies on the same-origin fallback).
- **Keep the same-origin fallback** in `scoops/lick-ws-bridge.ts` — do not remove it.
- **Do not migrate webhook CRUD to REST.** Webhook CRUD stays on the direct `LickManager` surface in every topology; only its URL resolution + messaging change.
- **Webhook URL precedence is tray-first in ALL topologies**, then a topology-specific fallback (never regress `node-rest + active tray → tray URL`).
- **Tests:** mirror `packages/webapp/tests/**` structure; node env; use `vi.stubGlobal` for `chrome`/`fetch`/`self`; reset `setExtensionDelegateId(null)` in `afterEach`. Keep each package at/above its coverage floor.
- **Prettier:** run `npx prettier --write <files>` before every commit (CI rejects unformatted code).
- **Spec:** `docs/superpowers/specs/2026-07-01-extension-lick-topology-design.md`.

---

### Task 1: Generalize the topology resolver (`float-topology.ts`)

**Files:**

- Create: `packages/webapp/src/core/float-topology.ts`
- Modify: `packages/webapp/src/core/secret-topology.ts` (becomes a re-export shim)
- Test: `packages/webapp/tests/core/float-topology.test.ts`

**Interfaces:**

- Produces: `type FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest'`; `resolveFloatTopology(): FloatTopology`; `hasLocalNodeServer(): boolean`.
- Consumes: `getExtensionDelegateId()` from `../shell/proxied-fetch.js`.
- Preserves: `resolveSecretTopology()` / `SecretTopology` (re-exported aliases) so `secret-topology.test.ts` and all secret-CRUD call sites keep working unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/core/float-topology.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveFloatTopology + hasLocalNodeServer', () => {
  let originalChrome: unknown;
  let originalConnectMode: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
  });

  it('returns extension-direct when chrome.runtime.id is truthy', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { resolveFloatTopology, hasLocalNodeServer } =
      await import('../../src/core/float-topology.js');
    expect(resolveFloatTopology()).toBe('extension-direct');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns extension-delegate when a delegate id is set (no runtime.id)', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { resolveFloatTopology, hasLocalNodeServer } =
      await import('../../src/core/float-topology.js');
    expect(resolveFloatTopology()).toBe('extension-delegate');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns connect when __slicc_connect_mode is set and no delegate id', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveFloatTopology, hasLocalNodeServer } =
      await import('../../src/core/float-topology.js');
    expect(resolveFloatTopology()).toBe('connect');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns node-rest by default and hasLocalNodeServer is true only then', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveFloatTopology, hasLocalNodeServer } =
      await import('../../src/core/float-topology.js');
    expect(resolveFloatTopology()).toBe('node-rest');
    expect(hasLocalNodeServer()).toBe(true);
  });

  it('secret-topology re-export resolves identically', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    const { resolveFloatTopology } = await import('../../src/core/float-topology.js');
    expect(resolveSecretTopology()).toBe(resolveFloatTopology());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/core/float-topology.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/float-topology.js'`.

- [ ] **Step 3: Create `float-topology.ts`**

Create `packages/webapp/src/core/float-topology.ts`:

```ts
/**
 * Float-topology resolver — the canonical "which float am I?" discriminator.
 *
 * Generalizes the secrets-only `resolveSecretTopology()` (EXT7) so the lick
 * legs (lick-ws bridge, webhook, crontask) share ONE extension detector
 * instead of the dead `KernelHostConfig.isExtension` flag / the naive
 * `!!chrome.runtime.id` heuristic — both permanently false in the extension
 * hosted-leader tab. Pure + side-effect-free: reads ambient globals only.
 */

import { getExtensionDelegateId } from '../shell/proxied-fetch.js';

export type FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest';

/**
 * Resolve the current realm's float topology. First match wins:
 * 1. **extension-direct** — real `chrome-extension://` page (`chrome.runtime.id`).
 *    No such kernel ships today (offscreen + side panel removed in `54eb0811`);
 *    kept for completeness and treated as "no node-server" by callers.
 * 2. **extension-delegate** — thin-ext hosted leader tab / its kernel worker
 *    (a delegate id was wired at boot). Wins over node-rest even when a
 *    `localApiBaseUrl` is also set.
 * 3. **connect** — `?connect=1` provider-login popup (no kernel).
 * 4. **node-rest** — default: a reachable local node-server (standalone
 *    thin-bridge, electron, hosted/cloud cone, serve-only).
 */
export function resolveFloatTopology(): FloatTopology {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
    return 'extension-direct';
  }
  if (getExtensionDelegateId()) {
    return 'extension-delegate';
  }
  if ((globalThis as Record<string, unknown>).__slicc_connect_mode) {
    return 'connect';
  }
  return 'node-rest';
}

/**
 * True iff this float has a reachable local node-server REST / `/licks-ws`
 * surface (topology `node-rest`). The lick legs use this to choose
 * REST / lick-ws (true) vs the worker `LickManager` + tray worker (false —
 * extension-delegate, and the unreachable extension-direct).
 */
export function hasLocalNodeServer(): boolean {
  return resolveFloatTopology() === 'node-rest';
}
```

- [ ] **Step 4: Rewrite `secret-topology.ts` as a re-export shim**

Replace the entire contents of `packages/webapp/src/core/secret-topology.ts` with:

```ts
/**
 * Back-compat re-export. The topology resolver was generalized into
 * `float-topology.ts` so the lick legs and the secrets leg share one
 * extension discriminator. Existing secret-CRUD call sites and tests keep
 * importing `resolveSecretTopology` / `SecretTopology` from here unchanged.
 */
export {
  resolveFloatTopology as resolveSecretTopology,
  type FloatTopology as SecretTopology,
} from './float-topology.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/core/float-topology.test.ts packages/webapp/tests/core/secret-topology.test.ts`
Expected: PASS (both files — the re-export keeps the existing secret-topology suite green).

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/src/core/float-topology.ts packages/webapp/src/core/secret-topology.ts packages/webapp/tests/core/float-topology.test.ts
git add packages/webapp/src/core/float-topology.ts packages/webapp/src/core/secret-topology.ts packages/webapp/tests/core/float-topology.test.ts
git commit -m "feat(topology): generalize resolveSecretTopology into float-topology + hasLocalNodeServer"
```

---

### Task 2: Gate the lick-ws bridge on `node-rest` + retire `KernelHostConfig.isExtension`

**Files:**

- Modify: `packages/webapp/src/kernel/host.ts`
- Test: `packages/webapp/tests/kernel/host-lick-ws-gate.test.ts`

**Interfaces:**

- Consumes: `hasLocalNodeServer()` from `../core/float-topology.js`.
- Produces: `shouldStartLickWsBridge(): boolean` (exported from `host.ts`).
- Removes: the `isExtension?: boolean` field from `KernelHostConfig` (no production or test caller passes it — verified).

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/kernel/host-lick-ws-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('shouldStartLickWsBridge (kernel host lick-ws gate)', () => {
  let originalChrome: unknown;
  let originalConnectMode: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
  });

  it('starts the bridge for node-rest', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(true);
  });

  it('does NOT start the bridge for extension-delegate', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(false);
  });

  it('does NOT start the bridge for extension-direct', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/kernel/host-lick-ws-gate.test.ts`
Expected: FAIL — `shouldStartLickWsBridge` is not exported from `host.js`.

- [ ] **Step 3: Add the import and the exported predicate**

In `packages/webapp/src/kernel/host.ts`, add to the imports (near the other `../core/*` imports):

```ts
import { hasLocalNodeServer } from '../core/float-topology.js';
```

Add this exported helper (place it just above `export async function createKernelHost`):

```ts
/**
 * The kernel host starts the `/licks-ws` bridge only when a local node-server
 * exists (topology `node-rest`): standalone thin-bridge, electron, hosted
 * cone, serve-only. Extension-delegate (and the unreachable extension-direct)
 * have no node-server — their licks arrive via the tray worker — so the
 * bridge MUST NOT start there or it dials a dead `wss://.../licks-ws`.
 */
export function shouldStartLickWsBridge(): boolean {
  return hasLocalNodeServer();
}
```

- [ ] **Step 4: Replace the lick-ws gate**

In `host.ts`, replace the step-8a block (currently `if (!isExtension) { … startLickWsBridgeForHost … }`) with the topology gate, and update its comment:

```ts
// 8a. /licks-ws bridge to the node-server. Only `node-rest` floats have a
//     local node-server peer; extension-delegate / extension-direct route
//     licks through the tray worker instead (see lick-ws-bridge.ts).
let lickWsBridgeStop: (() => void) | null = null;
if (shouldStartLickWsBridge()) {
  lickWsBridgeStop = await startLickWsBridgeForHost(
    lickManager,
    log,
    config.localLickWsUrl ?? null
  );
}
```

- [ ] **Step 5: Make the NavigationWatcher gate unconditional**

The NavigationWatcher already self-skips on `transport.isExtensionBridge` (see `startNavigationWatcherForHost`), so the dead `isExtension` wrapper is redundant. Replace the step-8b block (currently `if (!isExtension) { navigationWatcherStop = startNavigationWatcherForHost(...); }`) with:

```ts
// 8b. CDP-level NavigationWatcher. `startNavigationWatcherForHost` self-skips
//     when the CDP transport is the thin extension's `chrome.debugger` Port
//     bridge (`transport.isExtensionBridge`) — the live signal that replaced
//     the dead `isExtension` flag — so no outer gate is needed here.
const navigationWatcherStop: (() => Promise<void>) | null = startNavigationWatcherForHost(
  browser,
  lickManager,
  log
);
```

- [ ] **Step 6: Remove the `isExtension` config field and destructure default**

In `host.ts`, delete the `isExtension = false,` line from the `createKernelHost` destructure (it currently sits between `skipConeBootstrap = false,` and the closing `} = config;`).

In the `KernelHostConfig` interface, delete the `isExtension?: boolean;` field **and its preceding doc comment** (the block describing "The `/licks-ws` bridge to the node-server … Leaving this falsy in standalone / kernel-worker boots …").

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/kernel/host-lick-ws-gate.test.ts packages/webapp/tests/kernel/host-globals.test.ts`
Expected: PASS (new gate test + existing host-globals regression).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS — confirms no remaining references to the removed `isExtension` field.

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/host.ts packages/webapp/tests/kernel/host-lick-ws-gate.test.ts
git add packages/webapp/src/kernel/host.ts packages/webapp/tests/kernel/host-lick-ws-gate.test.ts
git commit -m "feat(kernel): gate lick-ws bridge on node-rest topology; retire dead isExtension flag"
```

---

### Task 3: Route crontask CRUD by topology

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/crontask-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts`

**Interfaces:**

- Consumes: `hasLocalNodeServer()` from `../../core/float-topology.js`; `setExtensionDelegateId()` from `../../shell/proxied-fetch.js` (test only).
- Behavior: `node-rest` → `apiCall` (unchanged); non-`node-rest` → the worker-resident `LickManager` via `getExtensionLickManager()` (`globalThis.__slicc_lickManager`).

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts` (new `describe` block; imports `setExtensionDelegateId` — add it to the existing top-of-file import from `proxied-fetch.js`):

```ts
describe('crontask command - extension-delegate mode', () => {
  let command: ReturnType<typeof createCrontaskCommand>;
  let mockLm: {
    createCronTask: ReturnType<typeof vi.fn>;
    listCronTasks: ReturnType<typeof vi.fn>;
    deleteCronTask: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.stubGlobal('chrome', { runtime: { connect: () => undefined } });
    vi.stubGlobal('fetch', vi.fn()); // must NOT be called in delegate mode
    vi.resetModules();
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    mockLm = {
      createCronTask: vi.fn().mockResolvedValue({ id: 'c1', name: 'nightly', cron: '0 0 * * *' }),
      listCronTasks: vi.fn().mockReturnValue([]),
      deleteCronTask: vi.fn().mockResolvedValue(true),
    };
    (globalThis as Record<string, unknown>).__slicc_lickManager = mockLm;
    const { createCrontaskCommand } =
      await import('../../../src/shell/supplemental-commands/crontask-command.js');
    command = createCrontaskCommand();
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    vi.clearAllMocks();
  });

  const run = (args: string[]) =>
    (command as any).execute(args, { cwd: '/', env: {}, fs: {} as any });

  it('create routes to the worker LickManager, not apiCall/fetch', async () => {
    const result = await run(['create', '--name', 'nightly', '--cron', '0 0 * * *']);
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('nightly', '0 0 * * *', undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('list routes to the worker LickManager, not fetch', async () => {
    const result = await run(['list']);
    expect(result.exitCode).toBe(0);
    expect(mockLm.listCronTasks).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts -t "extension-delegate"`
Expected: FAIL — with the current `!!chrome.runtime.id` heuristic (false on this stub), create/list take the `apiCall`/`fetch` path, so `mockLm.createCronTask` is not called and `fetch` is.

- [ ] **Step 3: Replace the `isExtension` heuristic with the topology predicate**

In `packages/webapp/src/shell/supplemental-commands/crontask-command.ts`:

Add the import (near the other `../../` imports):

```ts
import { hasLocalNodeServer } from '../../core/float-topology.js';
```

Delete the module-level line:

```ts
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
```

In `handleCreate`, `handleList`, and `handleDelete`, change each `if (isExtension) {` guard to `if (!hasLocalNodeServer()) {`. (Three call sites; the branch bodies — the `getExtensionLickManager()` / `getLickProxy()` calls and the `--filter` CSP guard — are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts`
Expected: PASS (new delegate suite + the existing CLI-mode suite, which stubs `chrome` undefined → `node-rest` → `apiCall`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/crontask-command.ts packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts
git add packages/webapp/src/shell/supplemental-commands/crontask-command.ts packages/webapp/tests/shell/supplemental-commands/crontask-command.test.ts
git commit -m "feat(crontask): route CRUD by float topology (node-rest -> REST, else worker LickManager)"
```

---

### Task 4: Webhook URL resolution — tray-first + shim-aware fallback + honest messaging

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/webhook-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts`

**Interfaces:**

- Consumes: `hasLocalNodeServer()` from `../../core/float-topology.js`; `getLeaderStatusWithFallback()` from `../../scoops/tray-leader.js` (added to the existing `tray-leader` import); `setExtensionDelegateId()` (test only).
- Behavior (URL 2×2): active tray → tray URL (all topologies, via `getLeaderStatusWithFallback()`); no tray + `node-rest` → node-server-origin `/webhooks/<id>`; no tray + non-`node-rest` → `URL_UNAVAILABLE`. CRUD stays on the direct `LickManager` (no REST).

- [ ] **Step 1: Write the failing test**

Append to `packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts` a suite that drives the extension-delegate + no-tray case (the honest message). Reuse the file's existing `stubSelfLocation` / `loadCommandAndTrayLeader` / `buildLickManagerMock` helpers:

```ts
describe('webhook URL resolution — extension-delegate (no node-server)', () => {
  afterEach(async () => {
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('with NO tray session, surfaces the honest "connect a leader tray" message', async () => {
    vi.resetModules();
    vi.stubGlobal('chrome', { runtime: { connect: () => undefined } });
    stubSelfLocation('https://www.sliccy.ai/?slicc=leader&ext=abc');
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('abc'); // topology → extension-delegate (no node-server)

    const lm = buildLickManagerMock({
      createWebhook: vi
        .fn()
        .mockResolvedValue({ id: 'wh1', name: 'default', scoop: undefined } as WebhookEntry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await (command as any).execute(['create', 'default'], {
      cwd: '/',
      env: {},
      fs: {} as any,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('URL unavailable — connect a leader tray');
    expect(result.stdout).not.toContain('https://www.sliccy.ai/webhooks/');
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts -t "extension-delegate"`
Expected: FAIL — the current `if (isExtension) return URL_UNAVAILABLE` is false on this external-page stub, so `buildWebhookUrl` emits `https://www.sliccy.ai/webhooks/wh1` instead of the honest message.

- [ ] **Step 3: Add imports**

In `packages/webapp/src/shell/supplemental-commands/webhook-command.ts`:

```ts
import { hasLocalNodeServer } from '../../core/float-topology.js';
```

Add `getLeaderStatusWithFallback` to the existing import from `../../scoops/tray-leader.js` (the module that already provides `getLeaderTrayRuntimeStatus`).

- [ ] **Step 4: Rewrite `resolveWebhookUrlBase` to use the shim-aware fallback**

Replace the current body with (drops the `isExtension` branch; the direct path now reads the page-side tray via the fallback):

```ts
async function resolveWebhookUrlBase(): Promise<string | null> {
  // Direct/worker path (standalone, hosted, extension-delegate leader). The
  // leader tray may run on the PAGE while this runs in the WORKER (whose tray
  // module global stays `inactive`), so use the shim-aware fallback — same
  // precedent as the `/licks-ws` `tray_status` handler.
  if (getDirectLickManager()) {
    return getLeaderStatusWithFallback().session?.webhookUrl ?? null;
  }
  // No direct manager → legacy side-panel proxy path (unused in the current
  // single-kernel-worker leader tab; kept until confirmed removable).
  const { getTrayWebhookUrlAsync } =
    await import('../../../../chrome-extension/src/lick-manager-proxy.js');
  return await getTrayWebhookUrlAsync();
}
```

- [ ] **Step 5: Rewrite `buildWebhookUrl` fallback to the topology predicate**

Replace with:

```ts
function buildWebhookUrl(webhookId: string, trayUrlBase: string | null): string {
  // Tray-first in EVERY topology.
  if (trayUrlBase) return getTrayWebhookUrl(trayUrlBase, webhookId);
  // No tray: node-rest can still fall back to its local node-server origin; a
  // no-node-server float (extension-delegate / extension-direct) has no URL to
  // give, so surface the honest "connect a leader tray" message.
  if (!hasLocalNodeServer()) return URL_UNAVAILABLE;
  return getWebhookUrl(self.location.href, webhookId);
}
```

- [ ] **Step 6: Update `getLickManagerSurface` guard and remove the `isExtension` const**

In `getLickManagerSurface`, replace `if (!isExtension) return null;` with:

```ts
if (hasLocalNodeServer()) return null;
```

Delete the module-level line:

```ts
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts`
Expected: PASS — the new extension-delegate case plus the existing suite, including the standalone-with-tray assertion (regression guard: `node-rest + active tray → tray URL` still holds).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/webhook-command.ts packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts
git add packages/webapp/src/shell/supplemental-commands/webhook-command.ts packages/webapp/tests/shell/supplemental-commands/webhook-command.test.ts
git commit -m "feat(webhook): tray-first URL via shim-aware fallback; honest no-tray message for delegate"
```

---

### Task 5: Documentation (three gates)

**Files:**

- Modify: `CLAUDE.md` (root), `packages/webapp/CLAUDE.md`, `docs/architecture.md`, `docs/shell-reference.md`

**Interfaces:** none (docs only). No test.

- [ ] **Step 1: Correct the stale extension architecture description**

In root `CLAUDE.md` and `packages/webapp/CLAUDE.md`, update the extension-float descriptions that still describe the three-layer offscreen/side-panel model (removed in `54eb0811`). State the current model: a single pinned hosted **leader** tab (`?slicc=leader&ext=<id>`) boots the kernel worker; other pages get `?cherry=1` cherry-follower iframes; the extension provides CDP (`chrome.debugger`) + fetch bridging. Reference `resolveFloatTopology()` (`core/float-topology.ts`) as the canonical float discriminator and note that licks are a `node-rest`-only concern (extension-delegate leaders use the tray worker).

- [ ] **Step 2: Update the shell-reference webhook/crontask sections**

In `docs/shell-reference.md`, update the `webhook` and `crontask` entries to describe the topology behavior: in the extension-delegate leader, `crontask` runs on the in-tab worker `LickManager` (fires tab-lifetime) and `webhook` URLs come from the connected tray (or show "connect a leader tray" when none). If these commands have no existing section, add a one-paragraph note each.

- [ ] **Step 3: Reconcile architecture.md**

In `docs/architecture.md`, fix any offscreen-era description of the extension float to match Step 1, and note the leader/follower lick model (followers forward `navigate`; only kernel-bearing leaders run lick legs).

- [ ] **Step 4: Commit**

```bash
npx prettier --write CLAUDE.md packages/webapp/CLAUDE.md docs/architecture.md docs/shell-reference.md
git add CLAUDE.md packages/webapp/CLAUDE.md docs/architecture.md docs/shell-reference.md
git commit -m "docs: update extension float model + webhook/crontask topology behavior"
```

---

### Task 6: Full verification pass

**Files:** none (gate only).

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: PASS (0 errors). Fix any reported issues, then re-run.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — in particular confirms no dangling `isExtension` references after Task 2.

- [ ] **Step 3: Full test run + coverage**

Run: `npm run test`
Expected: PASS (all suites).

Run: `npm run test:coverage:webapp`
Expected: PASS — webapp coverage at/above its floor in `coverage-thresholds.json`.

- [ ] **Step 4: Both builds**

Run: `npm run build -w @slicc/webapp`
Run: `npm run build -w @slicc/chrome-extension`
Expected: both succeed.

- [ ] **Step 5: Manual smoke (optional but recommended)**

Load the extension leader tab (`https://www.sliccy.ai/?slicc=leader&ext=<id>`) and confirm: (a) no `wss://www.sliccy.ai/licks-ws` error loop in the console; (b) `crontask create` / `crontask list` work in the panel terminal; (c) `webhook create` returns a tray URL when a tray is connected, or the honest "connect a leader tray" message when not.

- [ ] **Step 6: Final commit (if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore: verification pass fixups for extension lick topology"
```

---

## Self-Review

**1. Spec coverage:**

- §5.1 resolver → Task 1. §5.2 lick-ws gate → Task 2. §5.3 retire `isExtension` → Task 2. §5.4 crontask → Task 3; webhook → Task 4. §5.5 obsolete proxy path → noted in Task 4 Step 4 (kept, flagged; removal deferred as low-risk cleanup). §7 tests → Tasks 1–4. §8 docs → Task 5. §9 verification → Task 6. No gaps.

**2. Placeholder scan:** No TBD/TODO; every code + test step contains full content; commands have expected output.

**3. Type consistency:** `resolveFloatTopology`/`FloatTopology`/`hasLocalNodeServer` (Task 1) are the exact names imported in Tasks 2–4. `shouldStartLickWsBridge` defined and tested in Task 2. `getLeaderStatusWithFallback` matches `tray-leader.ts`. `getExtensionLickManager`/`getDirectLickManager`/`getLickProxy`/`apiCall` are existing symbols left intact.
