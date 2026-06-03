# Standalone remote-CDP bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a standalone leader's cone **drive** federated tray/cherry targets (`screenshot`, `navigate`, `evaluate`, `click`, …) — not just list them — by giving the kernel-worker `BrowserAPI` a `TrayTargetProvider` whose transport tunnels CDP over the existing panel-RPC BroadcastChannel to the page, where the real `RemoteCDPTransport` lives.

**Architecture:** The worker `BrowserAPI.attachToPage(composite)` already routes composite `"<runtimeId>:<localTargetId>"` ids through `trayTargetProvider.createRemoteTransport()` — it's just never set in the worker. We add `createPanelRpcTrayProvider()` (worker) returning a `PanelRpcCdpTransport` modeled on `RemoteCDPTransport` (starts `'connected'`, no-op `connect()`, lazy page-side session on first `send`). Each `send`/`subscribe` is a panel-RPC `call` to new page-side handlers that own the _real_ `RemoteCDPTransport` (via `pageLeaderTray.sync`). CDP events flow back over a new `panel-rpc-push` envelope. `BrowserAPI`'s driving logic is unchanged.

**Tech Stack:** TypeScript (strict), Vitest (project `webapp`, node environment), the existing `kernel/panel-rpc.ts` BroadcastChannel bridge, `cdp/transport.ts` `CDPTransport` interface, `scoops/tray-leader-sync.ts` `LeaderSyncManager` (the page-side `TrayTargetProvider`).

---

## Background the engineer needs

Read these before starting (they're the load-bearing context):

- **Spec:** `docs/superpowers/specs/2026-06-03-standalone-remote-cdp-bridge-design.md` — the authority. This plan implements it.
- **`packages/webapp/src/cdp/remote-cdp-transport.ts`** — `PanelRpcCdpTransport` is modeled on this. Note `_state = 'connected'`, `connect()` is a no-op, `on/off` keep an `eventListeners: Map<string, Set<CDPEventListener>>`, `once()` builds a one-shot handler with a timeout.
- **`packages/webapp/src/cdp/transport.ts`** — the `CDPTransport` interface we must implement.
- **`packages/webapp/src/cdp/browser-api.ts`** — `attachToPage()` (lines ~310-376) and `closePage()`/`detach()` show the remote branch: `if (this.trayTargetProvider?.createRemoteTransport && targetId.includes(':'))`. **It never calls `connect()` on a remote transport** and **never calls `getTargets()` to drive** — it splits the composite id and calls `createRemoteTransport(runtimeId, localTargetId)` then `send('Target.attachToTarget', …)`. Cleanup paths call `removeRemoteTransport(runtimeId, localTargetId)`.
- **`packages/webapp/src/kernel/panel-rpc.ts`** — the bridge. Worker calls `createPanelRpcClient({ instanceId }).call(op, payload, { timeoutMs })`; page installs `installPanelRpcHandler({ handlers, instanceId })`. `getPanelRpcClient()` returns the global the kernel worker publishes (null off-worker). `DEFAULT_TIMEOUT_MS = 15_000`.
- **`packages/webapp/src/ui/panel-rpc-handlers.ts`** — `createStandalonePanelRpcHandlers(options)` builds the handler record; `StandalonePanelRpcHandlerOptions` carries page-side callbacks (e.g. `emitCherrySliccEvent`, `listRemoteTargets`).
- **`packages/webapp/src/scoops/tray-leader-sync.ts`** — `LeaderSyncManager` is the page-side `TrayTargetProvider`. `createRemoteTransport(runtimeId, localTargetId)` returns a real `RemoteCDPTransport`; `removeRemoteTransport()` disconnects + evicts; `openRemoteTab()`; `cleanupRemoteTransports(runtimeId)` (private) fires on follower disconnect via `removeFollower()`.
- **Test harness pattern:** `packages/webapp/tests/kernel/panel-rpc.test.ts` has a `FakeChannel` BroadcastChannel polyfill (Node-env, `queueMicrotask` delivery). Reuse it for any test touching the real channel.

**Commands (run from repo root, the worktree dir):**

- Single test file: `npx vitest run --project webapp <path-from-repo-root>`
- Lint (CI gate, run before any commit): `npm run lint`
- Typecheck: `npm run typecheck`
- Webapp coverage (global floor 50% lines/statements/functions, 40% branches): `npm run test:coverage:webapp`

**Commit discipline:** one commit per task (after its tests pass). End every commit message with:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## File Structure

**New files:**

- `packages/webapp/src/cdp/panel-rpc-cdp-transport.ts` — `PanelRpcCdpTransport` (worker-side `CDPTransport` tunneling over panel-RPC). One responsibility: be a `CDPTransport` whose I/O is panel-RPC calls + pushes.
- `packages/webapp/src/cdp/panel-rpc-tray-provider.ts` — `createPanelRpcTrayProvider(getPanelRpc)` (worker-side `TrayTargetProvider`; caches transports; `getTargets(): []`).
- `packages/webapp/src/ui/remote-cdp-page-bridge.ts` — `createRemoteCdpPageBridge({ getSync, postEvent })`: page-side session map + ref-counted event forwarders. One responsibility: own per-target `RemoteCDPTransport`s on behalf of worker requests and relay events back.
- Tests: `packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts`, `packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts`, `packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts`, `packages/webapp/tests/cdp/standalone-remote-cdp-bridge.integration.test.ts`.

**Modified files:**

- `packages/webapp/src/kernel/panel-rpc.ts` — new request ops + results, `PanelRpcPushMsg`/`RemoteCdpEventPayload`, `PanelRpcClient.registerPushTarget`/`unregisterPushTarget`, push dispatch in `createPanelRpcClient`, exported `PANEL_RPC_DEFAULT_TIMEOUT_MS`.
- `packages/webapp/src/kernel/kernel-worker.ts` — wire `browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient))` at boot.
- `packages/webapp/src/ui/panel-rpc-handlers.ts` — `remoteCdp` option + the five `remote-cdp-*` / `remote-open-tab` handlers.
- `packages/webapp/src/scoops/tray-leader-sync.ts` — `onRemoteTransportsCleaned?` option, fired in `cleanupRemoteTransports`.
- `packages/webapp/src/ui/page-leader-tray.ts` — thread `onRemoteTransportsCleaned` from `StartPageLeaderTrayOptions` into `LeaderSyncManagerOptions`.
- `packages/webapp/src/ui/main.ts` — construct the push channel + bridge, wire `remoteCdp` + `onRemoteTransportsCleaned`, dispose on leader-stop/unload.
- Docs: `docs/architecture.md`, `packages/webapp/CLAUDE.md`.

---

## Task 1: panel-rpc protocol additions (ops, results, push envelope, client push dispatch)

**Files:**

- Modify: `packages/webapp/src/kernel/panel-rpc.ts`
- Test: `packages/webapp/tests/kernel/panel-rpc.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the top-level `describe('panel-rpc', …)` block in `packages/webapp/tests/kernel/panel-rpc.test.ts` (the `FakeChannel` global is already installed by the file's `beforeEach`). Also add the new imports to the existing import block at the top of the file.

Add to the import from `'../../src/kernel/panel-rpc.js'`:

```ts
import {
  createPanelRpcClient,
  installPanelRpcHandler,
  PANEL_RPC_DEFAULT_TIMEOUT_MS,
  type PanelRpcPushMsg,
  panelRpcChannelName,
} from '../../src/kernel/panel-rpc.js';
```

New tests:

```ts
it('exposes the default timeout constant', () => {
  expect(PANEL_RPC_DEFAULT_TIMEOUT_MS).toBe(15_000);
});

it('round-trips a remote-cdp-send request', async () => {
  const stop = installPanelRpcHandler({
    instanceId: 'rcdp-send',
    handlers: {
      'remote-cdp-send': (p) => ({ echoed: p.method }),
    },
  });
  const client = createPanelRpcClient({ instanceId: 'rcdp-send' });
  const result = await client.call('remote-cdp-send', {
    runtimeId: 'follower-1',
    localTargetId: 'tgt-1',
    method: 'Page.captureScreenshot',
  });
  expect(result).toEqual({ echoed: 'Page.captureScreenshot' });
  client.dispose();
  stop();
});

it('dispatches a remote-cdp-event push to the registered target', async () => {
  const client = createPanelRpcClient({ instanceId: 'rcdp-push' });
  const received: Array<{ method: string }> = [];
  client.registerPushTarget('follower-1:tgt-1', (payload) => {
    received.push({ method: payload.method });
  });

  // A second channel on the same name simulates the page-side pusher.
  const pusher = new BroadcastChannel(panelRpcChannelName('rcdp-push'));
  const push: PanelRpcPushMsg = {
    type: 'panel-rpc-push',
    op: 'remote-cdp-event',
    payload: { runtimeId: 'follower-1', localTargetId: 'tgt-1', method: 'Page.loadEventFired' },
  };
  pusher.postMessage(push);

  await new Promise((r) => setTimeout(r, 0));
  expect(received).toEqual([{ method: 'Page.loadEventFired' }]);

  client.unregisterPushTarget('follower-1:tgt-1');
  pusher.postMessage(push);
  await new Promise((r) => setTimeout(r, 0));
  // No new delivery after unregister.
  expect(received).toEqual([{ method: 'Page.loadEventFired' }]);

  pusher.close();
  client.dispose();
});

it('ignores pushes for unregistered target keys without throwing', async () => {
  const client = createPanelRpcClient({ instanceId: 'rcdp-orphan' });
  const pusher = new BroadcastChannel(panelRpcChannelName('rcdp-orphan'));
  pusher.postMessage({
    type: 'panel-rpc-push',
    op: 'remote-cdp-event',
    payload: { runtimeId: 'x', localTargetId: 'y', method: 'Page.frameNavigated' },
  } satisfies PanelRpcPushMsg);
  await new Promise((r) => setTimeout(r, 0));
  // Reaching here without an unhandled error is the assertion.
  expect(true).toBe(true);
  pusher.close();
  client.dispose();
});

it('push register/unregister are no-ops when BroadcastChannel is unavailable', () => {
  const saved = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
  const client = createPanelRpcClient({ instanceId: 'no-bc-push' });
  expect(() => client.registerPushTarget('a:b', () => {})).not.toThrow();
  expect(() => client.unregisterPushTarget('a:b')).not.toThrow();
  client.dispose();
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = saved;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project webapp packages/webapp/tests/kernel/panel-rpc.test.ts`
Expected: FAIL — `PANEL_RPC_DEFAULT_TIMEOUT_MS` / `PanelRpcPushMsg` not exported, `registerPushTarget` not a function, `remote-cdp-send` not a valid op.

- [ ] **Step 3: Add the request ops to the `PanelRpcRequest` union**

In `packages/webapp/src/kernel/panel-rpc.ts`, append these branches to the `PanelRpcRequest` union (after the existing `list-remote-targets` branch, before the union closes at `;`):

```ts
  | {
      // Drive a remote (tray/cherry) target: relay a single CDP command
      // to the page-side RemoteCDPTransport that owns the WebRTC channel.
      // The worker's PanelRpcCdpTransport can't own an RTCDataChannel, so
      // it tunnels here. `sessionId` threads through transparently.
      op: 'remote-cdp-send';
      payload: {
        runtimeId: string;
        localTargetId: string;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
    }
  | {
      // Subscribe the page-side RemoteCDPTransport to a CDP event so its
      // firings get pushed back to the worker as `remote-cdp-event`.
      // Ref-counted page-side (0→1 wires a forwarder).
      op: 'remote-cdp-subscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Drop one event subscription (1→0 unwires the page-side forwarder).
      op: 'remote-cdp-unsubscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Dispose the page-side session for a target (drops forwarders and
      // the RemoteCDPTransport). Sent by PanelRpcCdpTransport.disconnect().
      op: 'remote-cdp-detach';
      payload: { runtimeId: string; localTargetId: string };
    }
  | {
      // Open a new tab on a remote runtime; returns the composite targetId.
      op: 'remote-open-tab';
      payload: { runtimeId: string; url: string };
    };
```

- [ ] **Step 4: Add the result types to `PanelRpcResults`**

In the `PanelRpcResults` interface (after the `list-remote-targets` entry):

```ts
  'remote-cdp-send': Record<string, unknown>;
  'remote-cdp-subscribe': { ok: true };
  'remote-cdp-unsubscribe': { ok: true };
  'remote-cdp-detach': { ok: true };
  'remote-open-tab': { targetId: string };
```

- [ ] **Step 5: Add the push envelope + payload types and export the timeout constant**

Add `export` to the default timeout near the top constants — change:

```ts
const DEFAULT_TIMEOUT_MS = 15_000;
```

to:

```ts
const DEFAULT_TIMEOUT_MS = 15_000;
/** Public alias of the panel-RPC default `call()` timeout (15s). */
export const PANEL_RPC_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
```

Then, just below the `PanelRpcResponseMsg` interface in the "Wire envelopes" section, add:

```ts
/** Payload of a `remote-cdp-event` push (page → worker). */
export interface RemoteCdpEventPayload {
  runtimeId: string;
  localTargetId: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Page → worker push envelope, distinct from the request/response
 * envelopes. Relays CDP events fired on a page-side `RemoteCDPTransport`
 * back to the worker-side `PanelRpcCdpTransport` that subscribed. Posted
 * on the same instance-scoped channel; the worker client routes it to a
 * registered push target keyed by `runtimeId:localTargetId`.
 */
export interface PanelRpcPushMsg {
  type: 'panel-rpc-push';
  op: 'remote-cdp-event';
  payload: RemoteCdpEventPayload;
}
```

- [ ] **Step 6: Extend the `PanelRpcClient` interface**

Add the two push-registry methods to the `PanelRpcClient` interface (between `call` and `dispose`):

```ts
  /**
   * Register a handler for `remote-cdp-event` pushes targeting a
   * composite key (`runtimeId:localTargetId`). Used by
   * `PanelRpcCdpTransport` to receive page-pushed CDP events. No-op
   * when `BroadcastChannel` is unavailable.
   */
  registerPushTarget(key: string, handler: (payload: RemoteCdpEventPayload) => void): void;
  /** Drop a previously registered push handler. */
  unregisterPushTarget(key: string): void;
```

- [ ] **Step 7: Implement push registry + dispatch in `createPanelRpcClient`**

In the no-`BroadcastChannel` early-return object, add the two no-ops:

```ts
if (typeof BroadcastChannel !== 'function') {
  return {
    call: () => Promise.reject(new Error('panel-rpc: BroadcastChannel is unavailable')),
    registerPushTarget: () => {},
    unregisterPushTarget: () => {},
    dispose: () => {},
  };
}
```

After the `pending` Map is created, add the push-target registry:

```ts
const pushTargets = new Map<string, (payload: RemoteCdpEventPayload) => void>();
```

Replace the `channel.addEventListener('message', …)` body so it branches on push messages first:

```ts
channel.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as PanelRpcResponseMsg | PanelRpcPushMsg | undefined;
  if (msg?.type === 'panel-rpc-push') {
    if (msg.op === 'remote-cdp-event') {
      const p = msg.payload;
      pushTargets.get(`${p.runtimeId}:${p.localTargetId}`)?.(p);
    }
    return;
  }
  if (msg?.type !== 'panel-rpc-response') return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  clearTimeout(slot.timer);
  if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
  else slot.resolve(msg.result);
});
```

Add the two functions before the final `return`, and include them in the returned object:

```ts
function registerPushTarget(key: string, handler: (payload: RemoteCdpEventPayload) => void): void {
  pushTargets.set(key, handler);
}

function unregisterPushTarget(key: string): void {
  pushTargets.delete(key);
}

return { call, registerPushTarget, unregisterPushTarget, dispose };
```

(Also clear `pushTargets` in `dispose()` — add `pushTargets.clear();` next to `pending.clear();`.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --project webapp packages/webapp/tests/kernel/panel-rpc.test.ts`
Expected: PASS (all prior + 5 new tests).

- [ ] **Step 9: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/kernel/panel-rpc.ts packages/webapp/tests/kernel/panel-rpc.test.ts
git commit -m "feat(webapp): add remote-cdp panel-RPC ops + event push envelope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `PanelRpcCdpTransport` (worker CDPTransport over panel-RPC)

**Files:**

- Create: `packages/webapp/src/cdp/panel-rpc-cdp-transport.ts`
- Test: `packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS,
  PanelRpcCdpTransport,
} from '../../src/cdp/panel-rpc-cdp-transport.js';
import { PANEL_RPC_DEFAULT_TIMEOUT_MS, type PanelRpcClient } from '../../src/kernel/panel-rpc.js';

/** Minimal fake panel-RPC client capturing calls and push registration. */
function makeFakeClient(): {
  client: PanelRpcClient;
  calls: Array<{ op: string; payload: unknown; timeoutMs?: number }>;
  pushTargets: Map<string, (payload: unknown) => void>;
  resolveNext: (result: Record<string, unknown>) => void;
} {
  const calls: Array<{ op: string; payload: unknown; timeoutMs?: number }> = [];
  const pushTargets = new Map<string, (payload: unknown) => void>();
  let pendingResolve: ((result: Record<string, unknown>) => void) | null = null;
  const client = {
    call: vi.fn((op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
      calls.push({ op, payload, timeoutMs: opts?.timeoutMs });
      return new Promise((resolve) => {
        pendingResolve = resolve as (r: Record<string, unknown>) => void;
      });
    }),
    registerPushTarget: vi.fn((key: string, handler: (payload: unknown) => void) => {
      pushTargets.set(key, handler);
    }),
    unregisterPushTarget: vi.fn((key: string) => {
      pushTargets.delete(key);
    }),
    dispose: vi.fn(),
  } as unknown as PanelRpcClient;
  return {
    client,
    calls,
    pushTargets,
    resolveNext: (result) => pendingResolve?.(result),
  };
}

describe('PanelRpcCdpTransport', () => {
  it('starts connected and connect() is a no-op', async () => {
    const { client } = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => client, 'follower-1', 'tgt-1');
    expect(t.state).toBe('connected');
    await expect(t.connect()).resolves.toBeUndefined();
    expect(t.state).toBe('connected');
  });

  it('send maps to remote-cdp-send with the layered timeout', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.send('Page.captureScreenshot', { format: 'png' }, 'sess-1');
    expect(fake.calls[0].op).toBe('remote-cdp-send');
    expect(fake.calls[0].payload).toEqual({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
      sessionId: 'sess-1',
    });
    // default CDP timeout 30_000 → max(30_000, 15_000) + margin
    expect(fake.calls[0].timeoutMs).toBe(30_000 + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS);
    fake.resolveNext({ data: 'AAAA' });
    await expect(p).resolves.toEqual({ data: 'AAAA' });
  });

  it('honors an explicit CDP timeout below the panel-RPC floor', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    void t.send('Page.enable', undefined, undefined, 5_000);
    // max(5_000, 15_000) + margin
    expect(fake.calls[0].timeoutMs).toBe(15_000 + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS);
    expect(PANEL_RPC_DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it('fails closed when there is no panel-RPC client', async () => {
    const t = new PanelRpcCdpTransport(() => null, 'follower-1', 'tgt-1');
    await expect(t.send('Page.enable')).rejects.toThrow(/no page bridge to the leader tray/);
  });

  it('first on() subscribes, last off() unsubscribes', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const a = vi.fn();
    const b = vi.fn();
    t.on('Page.loadEventFired', a);
    t.on('Page.loadEventFired', b);
    // Only the 0→1 transition subscribes.
    const subs = fake.calls.filter((c) => c.op === 'remote-cdp-subscribe');
    expect(subs).toHaveLength(1);
    t.off('Page.loadEventFired', a);
    expect(fake.calls.filter((c) => c.op === 'remote-cdp-unsubscribe')).toHaveLength(0);
    t.off('Page.loadEventFired', b);
    expect(fake.calls.filter((c) => c.op === 'remote-cdp-unsubscribe')).toHaveLength(1);
  });

  it('dispatches a pushed event to local listeners', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const seen: Array<Record<string, unknown>> = [];
    t.on('Page.loadEventFired', (params) => seen.push(params));
    const handler = fake.pushTargets.get('follower-1:tgt-1');
    expect(handler).toBeTypeOf('function');
    handler?.({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });
    expect(seen).toEqual([{ timestamp: 1 }]);
  });

  it('once() resolves on the next matching pushed event', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired');
    fake.pushTargets.get('follower-1:tgt-1')?.({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.loadEventFired',
      params: { ok: true },
    });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('once() rejects on timeout', async () => {
    vi.useFakeTimers();
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired', 50);
    const expectation = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await expectation;
    vi.useRealTimers();
  });

  it('disconnect() detaches, unregisters the push target, and rejects later sends', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    t.on('Page.loadEventFired', vi.fn()); // forces push registration
    t.disconnect();
    expect(t.state).toBe('disconnected');
    expect(fake.calls.some((c) => c.op === 'remote-cdp-detach')).toBe(true);
    expect(fake.client.unregisterPushTarget).toHaveBeenCalledWith('follower-1:tgt-1');
    await expect(t.send('Page.enable')).rejects.toThrow(/disconnected/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project webapp packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts`
Expected: FAIL — module `panel-rpc-cdp-transport.js` does not exist.

- [ ] **Step 3: Implement the transport**

Create `packages/webapp/src/cdp/panel-rpc-cdp-transport.ts`:

```ts
/**
 * PanelRpcCdpTransport — a `CDPTransport` that tunnels CDP over the
 * panel-RPC BroadcastChannel to a page-side handler which owns the real
 * `RemoteCDPTransport` (the WebRTC data channel to a follower/cherry).
 *
 * Standalone splits the agent + `BrowserAPI` (kernel worker) from the
 * tray + WebRTC channels (page). The worker can't hold an
 * `RTCDataChannel`, so the worker's `BrowserAPI` drives remote targets
 * through this transport instead of a directly-owned `RemoteCDPTransport`.
 *
 * Modeled on `RemoteCDPTransport`: initial `state = 'connected'`,
 * `connect()` is a no-op, and the page-side session is created lazily on
 * the first `send`/`subscribe` for the key. `BrowserAPI.attachToPage()`
 * never calls `connect()` on a remote transport — it goes straight to
 * `createRemoteTransport()` → `send('Target.attachToTarget', …)`.
 */

import type { CDPTransport } from './transport.js';
import type { CDPEventListener, ConnectionState } from './types.js';
import {
  PANEL_RPC_DEFAULT_TIMEOUT_MS,
  type PanelRpcClient,
  type RemoteCdpEventPayload,
} from '../kernel/panel-rpc.js';

/** Default CDP send timeout, matching `RemoteCDPTransport`. */
const DEFAULT_CDP_TIMEOUT_MS = 30_000;

/**
 * Headroom added on top of the CDP timeout so the panel-RPC `call()`
 * layer never times out *before* the CDP op it carries. Keeps bridge
 * timeouts from masking the real CDP error.
 */
export const PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS = 5_000;

export class PanelRpcCdpTransport implements CDPTransport {
  private readonly eventListeners = new Map<string, Set<CDPEventListener>>();
  private readonly key: string;
  private _state: ConnectionState = 'connected';
  private pushRegistered = false;

  constructor(
    private readonly getPanelRpc: () => PanelRpcClient | null,
    private readonly runtimeId: string,
    private readonly localTargetId: string,
    private readonly timeoutMs = DEFAULT_CDP_TIMEOUT_MS
  ) {
    this.key = `${runtimeId}:${localTargetId}`;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {
    // No-op — the page owns the real transport (data channel). Mirrors
    // RemoteCDPTransport; BrowserAPI never calls connect() on a remote
    // transport. (Fewer params than CDPTransport.connect is fine: an
    // optional trailing arg can be omitted by an implementer.)
  }

  disconnect(): void {
    this._state = 'disconnected';
    const rpc = this.getPanelRpc();
    if (rpc) {
      if (this.pushRegistered) {
        rpc.unregisterPushTarget(this.key);
        this.pushRegistered = false;
      }
      // Best-effort page-side teardown; ignore failures (the page may
      // already be gone, e.g. on reload).
      void rpc
        .call('remote-cdp-detach', {
          runtimeId: this.runtimeId,
          localTargetId: this.localTargetId,
        })
        .catch(() => {});
    }
    this.eventListeners.clear();
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>> {
    if (this._state === 'disconnected') {
      throw new Error('Transport disconnected');
    }
    const rpc = this.getPanelRpc();
    if (!rpc) {
      throw new Error('cdp: no page bridge to the leader tray (panel-RPC client)');
    }
    const cdpTimeout = timeout ?? this.timeoutMs;
    const timeoutMs =
      Math.max(cdpTimeout, PANEL_RPC_DEFAULT_TIMEOUT_MS) + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS;
    return rpc.call(
      'remote-cdp-send',
      {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        method,
        params,
        sessionId,
      },
      { timeoutMs }
    );
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.eventListeners.get(event);
    const firstForEvent = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
    if (firstForEvent) this.subscribe(event);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.eventListeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.eventListeners.delete(event);
      this.unsubscribe(event);
    }
  }

  once(event: string, timeout?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const tm = timeout ?? this.timeoutMs;
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Remote CDP event timed out: ${event}`));
      }, tm);
      const handler = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  /** Dispatch a page-pushed CDP event to local listeners. */
  private handleEvent(method: string, params: Record<string, unknown>): void {
    const listeners = this.eventListeners.get(method);
    if (!listeners) return;
    for (const cb of [...listeners]) cb(params);
  }

  private ensurePushRegistered(rpc: PanelRpcClient): void {
    if (this.pushRegistered) return;
    rpc.registerPushTarget(this.key, (payload: RemoteCdpEventPayload) =>
      this.handleEvent(payload.method, payload.params ?? {})
    );
    this.pushRegistered = true;
  }

  private subscribe(event: string): void {
    const rpc = this.getPanelRpc();
    if (!rpc) return; // fail-closed: events simply won't arrive
    this.ensurePushRegistered(rpc);
    void rpc
      .call('remote-cdp-subscribe', {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        event,
      })
      .catch(() => {});
  }

  private unsubscribe(event: string): void {
    const rpc = this.getPanelRpc();
    if (!rpc) return;
    void rpc
      .call('remote-cdp-unsubscribe', {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        event,
      })
      .catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project webapp packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/cdp/panel-rpc-cdp-transport.ts packages/webapp/tests/cdp/panel-rpc-cdp-transport.test.ts
git commit -m "feat(webapp): add PanelRpcCdpTransport (worker CDP over panel-RPC)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: worker-side `createPanelRpcTrayProvider`

**Files:**

- Create: `packages/webapp/src/cdp/panel-rpc-tray-provider.ts`
- Test: `packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createPanelRpcTrayProvider } from '../../src/cdp/panel-rpc-tray-provider.js';
import { PanelRpcCdpTransport } from '../../src/cdp/panel-rpc-cdp-transport.js';
import type { PanelRpcClient } from '../../src/kernel/panel-rpc.js';

function fakeClient(): PanelRpcClient {
  return {
    call: vi.fn(async (op: string) => {
      if (op === 'remote-open-tab') return { targetId: 'follower-1:new-tab' };
      return {};
    }),
    registerPushTarget: vi.fn(),
    unregisterPushTarget: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PanelRpcClient;
}

describe('createPanelRpcTrayProvider', () => {
  it('getTargets returns empty (listing stays on the supplement)', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    expect(provider.getTargets()).toEqual([]);
  });

  it('createRemoteTransport returns a PanelRpcCdpTransport cached per key', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    const a = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    const b = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    const c = provider.createRemoteTransport?.('follower-1', 'tgt-2');
    expect(a).toBeInstanceOf(PanelRpcCdpTransport);
    expect(a).toBe(b); // same key → cached
    expect(a).not.toBe(c); // different key → new transport
  });

  it('removeRemoteTransport disconnects and evicts so a fresh transport is made next', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    const a = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    provider.removeRemoteTransport?.('follower-1', 'tgt-1');
    expect(a?.state).toBe('disconnected');
    const b = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    expect(b).not.toBe(a);
    expect(b?.state).toBe('connected');
  });

  it('openRemoteTab relays remote-open-tab and returns the composite id', async () => {
    const client = fakeClient();
    const provider = createPanelRpcTrayProvider(() => client);
    const id = await provider.openRemoteTab?.('follower-1', 'https://x.test');
    expect(client.call).toHaveBeenCalledWith('remote-open-tab', {
      runtimeId: 'follower-1',
      url: 'https://x.test',
    });
    expect(id).toBe('follower-1:new-tab');
  });

  it('openRemoteTab fails closed without a panel-RPC client', async () => {
    const provider = createPanelRpcTrayProvider(() => null);
    await expect(provider.openRemoteTab?.('follower-1', 'about:blank')).rejects.toThrow(
      /no page bridge to the leader tray/
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project webapp packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the provider**

Create `packages/webapp/src/cdp/panel-rpc-tray-provider.ts`:

```ts
/**
 * Worker-side `TrayTargetProvider` that bridges remote-target *driving*
 * to the page over panel-RPC. Wired onto the kernel-worker `BrowserAPI`
 * so `attachToPage("<runtimeId>:<localTargetId>")` builds a
 * `PanelRpcCdpTransport` instead of failing through to a local attach.
 *
 * `getTargets()` returns `[]` on purpose: listing stays on the existing
 * `list-remote-targets` panel-RPC supplement (PR #831). A `[]` here is
 * behaviourally identical to the pre-existing no-provider case, so there
 * is no listing regression — this provider's job is driving, not listing.
 */

import type { TrayTargetProvider } from './browser-api.js';
import { PanelRpcCdpTransport } from './panel-rpc-cdp-transport.js';
import type { TrayTargetEntry } from '../scoops/tray-sync-protocol.js';
import type { PanelRpcClient } from '../kernel/panel-rpc.js';

export function createPanelRpcTrayProvider(
  getPanelRpc: () => PanelRpcClient | null
): TrayTargetProvider {
  const transports = new Map<string, PanelRpcCdpTransport>();
  const keyOf = (runtimeId: string, localTargetId: string): string =>
    `${runtimeId}:${localTargetId}`;

  return {
    getTargets(): TrayTargetEntry[] {
      return [];
    },

    createRemoteTransport(runtimeId: string, localTargetId: string): PanelRpcCdpTransport {
      const key = keyOf(runtimeId, localTargetId);
      let transport = transports.get(key);
      if (!transport) {
        transport = new PanelRpcCdpTransport(getPanelRpc, runtimeId, localTargetId);
        transports.set(key, transport);
      }
      return transport;
    },

    removeRemoteTransport(runtimeId: string, localTargetId: string): void {
      const key = keyOf(runtimeId, localTargetId);
      const transport = transports.get(key);
      if (transport) {
        transport.disconnect();
        transports.delete(key);
      }
    },

    async openRemoteTab(runtimeId: string, url: string): Promise<string> {
      const rpc = getPanelRpc();
      if (!rpc) {
        throw new Error('cdp: no page bridge to the leader tray (panel-RPC client)');
      }
      const { targetId } = await rpc.call('remote-open-tab', { runtimeId, url });
      return targetId;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project webapp packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/cdp/panel-rpc-tray-provider.ts packages/webapp/tests/cdp/panel-rpc-tray-provider.test.ts
git commit -m "feat(webapp): add worker-side panel-RPC TrayTargetProvider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: wire the provider onto the kernel-worker `BrowserAPI`

**Files:**

- Modify: `packages/webapp/src/kernel/kernel-worker.ts:201` (after `BrowserAPI` construction) and `:241-243` (after the panel-RPC client is published)

There is no unit-test scaffold for `kernel-worker.ts` boot (a worker entrypoint). This wiring is verified by `npm run typecheck` and by the Task 9 integration test exercising the provider it installs.

- [ ] **Step 1: Import the provider factory**

In `packages/webapp/src/kernel/kernel-worker.ts`, add to the static imports near the top (next to `import { BrowserAPI } from '../cdp/browser-api.js';`):

```ts
import { createPanelRpcTrayProvider } from '../cdp/panel-rpc-tray-provider.js';
import { getPanelRpcClient } from './panel-rpc.js';
```

- [ ] **Step 2: Set the tray target provider after the panel-RPC client is published**

The provider must resolve the client lazily (it reads `globalThis.__slicc_panelRpc`, which is set at line ~243). Add, immediately after the existing block that assigns `(globalThis …).__slicc_panelRpc = panelRpcClient;`:

```ts
// Give the worker BrowserAPI a tray target provider so the cone can
// *drive* federated tray/cherry targets, not just list them. The
// provider tunnels each CDP op over panel-RPC to the page-side
// RemoteCDPTransport (which owns the WebRTC channel). Safe to set
// unconditionally: its methods run only for composite remote ids
// (which exist only when a tray is active), and with no panel-RPC
// client they fail closed. See issue #848.
browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
npm run lint
git add packages/webapp/src/kernel/kernel-worker.ts
git commit -m "feat(webapp): wire panel-RPC tray provider onto worker BrowserAPI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: page-side `createRemoteCdpPageBridge`

**Files:**

- Create: `packages/webapp/src/ui/remote-cdp-page-bridge.ts`
- Test: `packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts`

This owns the page-side session map: per composite target it holds the real `RemoteCDPTransport` (from `pageLeaderTray.sync`) and ref-counted event forwarders that post `remote-cdp-event` pushes worker-ward.

- [ ] **Step 1: Write the failing tests**

Create `packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  createRemoteCdpPageBridge,
  type RemoteCdpEventPayload,
  type RemoteCdpSyncProvider,
} from '../../src/ui/remote-cdp-page-bridge.js';
import type { CDPEventListener } from '../../src/cdp/types.js';

/** A fake page-side RemoteCDPTransport with controllable events. */
class FakeRemoteTransport {
  sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  listeners = new Map<string, Set<CDPEventListener>>();
  disconnected = false;
  send = vi.fn(async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    this.sent.push({ method, params, sessionId });
    if (method === 'Target.attachToTarget') return { sessionId: 'sess-1' };
    return { ok: method };
  });
  on(event: string, listener: CDPEventListener): void {
    let s = this.listeners.get(event);
    if (!s) {
      s = new Set();
      this.listeners.set(event, s);
    }
    s.add(listener);
  }
  off(event: string, listener: CDPEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  emit(event: string, params: Record<string, unknown>): void {
    for (const cb of this.listeners.get(event) ?? []) cb(params);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function makeSync(): {
  sync: RemoteCdpSyncProvider;
  transports: Map<string, FakeRemoteTransport>;
  removed: string[];
} {
  const transports = new Map<string, FakeRemoteTransport>();
  const removed: string[] = [];
  const sync: RemoteCdpSyncProvider = {
    createRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      let t = transports.get(key);
      if (!t) {
        t = new FakeRemoteTransport();
        transports.set(key, t);
      }
      return t as unknown as ReturnType<RemoteCdpSyncProvider['createRemoteTransport']>;
    },
    removeRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      transports.get(key)?.disconnect();
      removed.push(key);
    },
    async openRemoteTab(runtimeId, url) {
      return `${runtimeId}:tab-for-${url}`;
    },
  };
  return { sync, transports, removed };
}

describe('createRemoteCdpPageBridge', () => {
  it('send lazily creates the transport and relays the CDP call', async () => {
    const { sync, transports } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    const result = await bridge.send({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Target.attachToTarget',
      sessionId: undefined,
    });
    expect(result).toEqual({ sessionId: 'sess-1' });
    expect(transports.get('follower-1:tgt-1')?.sent[0].method).toBe('Target.attachToTarget');
  });

  it('send throws a clear error when the leader tray is not started', async () => {
    const bridge = createRemoteCdpPageBridge({ getSync: () => null, postEvent: vi.fn() });
    await expect(
      bridge.send({ runtimeId: 'f', localTargetId: 't', method: 'Page.enable' })
    ).rejects.toThrow(/leader tray not started/);
  });

  it('ref-counts subscribe/unsubscribe and forwards events as pushes', async () => {
    const { sync, transports } = makeSync();
    const pushes: RemoteCdpEventPayload[] = [];
    const bridge = createRemoteCdpPageBridge({
      getSync: () => sync,
      postEvent: (p) => pushes.push(p),
    });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    const transport = transports.get('f:t')!;
    expect(transport.listenerCount('Page.loadEventFired')).toBe(1); // single forwarder

    transport.emit('Page.loadEventFired', { ts: 1 });
    expect(pushes).toEqual([
      { runtimeId: 'f', localTargetId: 't', method: 'Page.loadEventFired', params: { ts: 1 } },
    ]);

    // First unsubscribe keeps the forwarder (count 2→1).
    await bridge.unsubscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(1);
    // Second unsubscribe removes it (1→0).
    await bridge.unsubscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(0);
  });

  it('detach disposes the session and removes the transport', async () => {
    const { sync, transports, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    const transport = transports.get('f:t')!;
    await bridge.detach({ runtimeId: 'f', localTargetId: 't' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(0);
    expect(removed).toContain('f:t');
  });

  it('cleanupRuntime drops all sessions for a runtime', async () => {
    const { sync, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.send({ runtimeId: 'f', localTargetId: 't1', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'f', localTargetId: 't2', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'g', localTargetId: 't3', method: 'Page.enable' });
    bridge.cleanupRuntime('f');
    expect(removed.sort()).toEqual(['f:t1', 'f:t2']);
  });

  it('disposeAll drops every session', async () => {
    const { sync, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.send({ runtimeId: 'f', localTargetId: 't1', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'g', localTargetId: 't2', method: 'Page.enable' });
    bridge.disposeAll();
    expect(removed.sort()).toEqual(['f:t1', 'g:t2']);
  });

  it('openTab relays through sync and returns the composite id', async () => {
    const { sync } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    const result = await bridge.openTab({ runtimeId: 'f', url: 'https://x.test' });
    expect(result).toEqual({ targetId: 'f:tab-for-https://x.test' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the bridge**

Create `packages/webapp/src/ui/remote-cdp-page-bridge.ts`:

```ts
/**
 * Page-side remote-CDP bridge. Owns, per composite target
 * (`runtimeId:localTargetId`), the real `RemoteCDPTransport` (obtained
 * from the page-side `LeaderSyncManager`) plus ref-counted event
 * forwarders. Worker-side `PanelRpcCdpTransport`s tunnel their CDP I/O
 * here over panel-RPC; CDP events flow back as `remote-cdp-event`
 * pushes.
 *
 * Created in `main.ts` (standalone) and exercised through the
 * `remote-cdp-*` / `remote-open-tab` panel-RPC handlers. See issue #848
 * and `docs/superpowers/specs/2026-06-03-standalone-remote-cdp-bridge-design.md`.
 */

import type { CDPEventListener } from '../cdp/types.js';
import type { CDPTransport } from '../cdp/transport.js';

export type { RemoteCdpEventPayload } from '../kernel/panel-rpc.js';
import type { RemoteCdpEventPayload } from '../kernel/panel-rpc.js';

/**
 * The slice of the page-side `LeaderSyncManager` (a `TrayTargetProvider`)
 * this bridge needs. `LeaderSyncManager` satisfies it structurally.
 */
export interface RemoteCdpSyncProvider {
  createRemoteTransport(runtimeId: string, localTargetId: string): CDPTransport;
  removeRemoteTransport?(runtimeId: string, localTargetId: string): void;
  openRemoteTab?(runtimeId: string, url: string): Promise<string>;
}

export interface RemoteCdpPageBridge {
  send(p: {
    runtimeId: string;
    localTargetId: string;
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<Record<string, unknown>>;
  subscribe(p: { runtimeId: string; localTargetId: string; event: string }): Promise<{
    ok: true;
  }>;
  unsubscribe(p: { runtimeId: string; localTargetId: string; event: string }): Promise<{
    ok: true;
  }>;
  detach(p: { runtimeId: string; localTargetId: string }): Promise<{ ok: true }>;
  openTab(p: { runtimeId: string; url: string }): Promise<{ targetId: string }>;
  /** Drop sessions for a runtime that disconnected out of band. */
  cleanupRuntime(runtimeId: string): void;
  /** Dispose every session (page/session reload, tray-leave, leader stop). */
  disposeAll(): void;
}

interface Session {
  runtimeId: string;
  localTargetId: string;
  transport: CDPTransport;
  /** event → { forwarder, refcount } */
  forwarders: Map<string, { listener: CDPEventListener; count: number }>;
}

export function createRemoteCdpPageBridge(opts: {
  getSync: () => RemoteCdpSyncProvider | null;
  postEvent: (payload: RemoteCdpEventPayload) => void;
}): RemoteCdpPageBridge {
  const sessions = new Map<string, Session>();
  const keyOf = (runtimeId: string, localTargetId: string): string =>
    `${runtimeId}:${localTargetId}`;

  const getOrCreate = (runtimeId: string, localTargetId: string): Session => {
    const key = keyOf(runtimeId, localTargetId);
    let session = sessions.get(key);
    if (!session) {
      const sync = opts.getSync();
      if (!sync) throw new Error('remote-cdp: leader tray not started');
      session = {
        runtimeId,
        localTargetId,
        transport: sync.createRemoteTransport(runtimeId, localTargetId),
        forwarders: new Map(),
      };
      sessions.set(key, session);
    }
    return session;
  };

  const disposeSession = (key: string): void => {
    const session = sessions.get(key);
    if (!session) return;
    for (const [event, fwd] of session.forwarders) {
      session.transport.off(event, fwd.listener);
    }
    session.forwarders.clear();
    const sync = opts.getSync();
    if (sync?.removeRemoteTransport) {
      sync.removeRemoteTransport(session.runtimeId, session.localTargetId);
    } else {
      session.transport.disconnect();
    }
    sessions.delete(key);
  };

  return {
    async send({ runtimeId, localTargetId, method, params, sessionId }) {
      const session = getOrCreate(runtimeId, localTargetId);
      return session.transport.send(method, params, sessionId);
    },

    async subscribe({ runtimeId, localTargetId, event }) {
      const session = getOrCreate(runtimeId, localTargetId);
      const existing = session.forwarders.get(event);
      if (existing) {
        existing.count += 1;
        return { ok: true };
      }
      const listener: CDPEventListener = (params) =>
        opts.postEvent({ runtimeId, localTargetId, method: event, params });
      session.transport.on(event, listener);
      session.forwarders.set(event, { listener, count: 1 });
      return { ok: true };
    },

    async unsubscribe({ runtimeId, localTargetId, event }) {
      const session = sessions.get(keyOf(runtimeId, localTargetId));
      const fwd = session?.forwarders.get(event);
      if (!session || !fwd) return { ok: true };
      fwd.count -= 1;
      if (fwd.count <= 0) {
        session.transport.off(event, fwd.listener);
        session.forwarders.delete(event);
      }
      return { ok: true };
    },

    async detach({ runtimeId, localTargetId }) {
      disposeSession(keyOf(runtimeId, localTargetId));
      return { ok: true };
    },

    async openTab({ runtimeId, url }) {
      const sync = opts.getSync();
      if (!sync?.openRemoteTab) {
        throw new Error('remote-cdp: openRemoteTab not available');
      }
      return { targetId: await sync.openRemoteTab(runtimeId, url) };
    },

    cleanupRuntime(runtimeId) {
      const prefix = `${runtimeId}:`;
      for (const key of [...sessions.keys()]) {
        if (key.startsWith(prefix)) disposeSession(key);
      }
    },

    disposeAll() {
      for (const key of [...sessions.keys()]) disposeSession(key);
    },
  };
}
```

> Note: `cleanupRuntime`'s prefix match (`"<runtimeId>:"`) is exact because the session key is built from the known `runtimeId` + `localTargetId` (not re-split from a composite string), so a `runtimeId` that itself contains a colon can't cause a mismatch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/ui/remote-cdp-page-bridge.ts packages/webapp/tests/ui/remote-cdp-page-bridge.test.ts
git commit -m "feat(webapp): add page-side remote-CDP bridge (sessions + forwarders)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: panel-RPC handlers for `remote-cdp-*` / `remote-open-tab`

**Files:**

- Modify: `packages/webapp/src/ui/panel-rpc-handlers.ts`
- Test: `packages/webapp/tests/ui/panel-rpc-handlers.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/webapp/tests/ui/panel-rpc-handlers.test.ts` (inside the existing top-level `describe`, or add a new `describe` block). First ensure the import of `createStandalonePanelRpcHandlers` exists at the top of the file (it does — the file already tests this factory). Add:

```ts
describe('createStandalonePanelRpcHandlers — remote-cdp', () => {
  const makeBridge = () => {
    const calls: string[] = [];
    return {
      calls,
      bridge: {
        send: vi.fn(async (p: { method: string }) => {
          calls.push(`send:${p.method}`);
          return { echoed: p.method };
        }),
        subscribe: vi.fn(async () => {
          calls.push('subscribe');
          return { ok: true as const };
        }),
        unsubscribe: vi.fn(async () => {
          calls.push('unsubscribe');
          return { ok: true as const };
        }),
        detach: vi.fn(async () => {
          calls.push('detach');
          return { ok: true as const };
        }),
        openTab: vi.fn(async () => {
          calls.push('openTab');
          return { targetId: 'follower-1:new' };
        }),
        cleanupRuntime: vi.fn(),
        disposeAll: vi.fn(),
      },
    };
  };

  it('routes remote-cdp-send to the bridge', async () => {
    const { bridge } = makeBridge();
    const handlers = createStandalonePanelRpcHandlers({ remoteCdp: bridge });
    const result = await handlers['remote-cdp-send']!({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.captureScreenshot',
    });
    expect(result).toEqual({ echoed: 'Page.captureScreenshot' });
    expect(bridge.send).toHaveBeenCalledOnce();
  });

  it('routes subscribe / unsubscribe / detach / open-tab to the bridge', async () => {
    const { bridge } = makeBridge();
    const handlers = createStandalonePanelRpcHandlers({ remoteCdp: bridge });
    expect(
      await handlers['remote-cdp-subscribe']!({
        runtimeId: 'f',
        localTargetId: 't',
        event: 'Page.loadEventFired',
      })
    ).toEqual({ ok: true });
    expect(
      await handlers['remote-cdp-unsubscribe']!({
        runtimeId: 'f',
        localTargetId: 't',
        event: 'Page.loadEventFired',
      })
    ).toEqual({ ok: true });
    expect(await handlers['remote-cdp-detach']!({ runtimeId: 'f', localTargetId: 't' })).toEqual({
      ok: true,
    });
    expect(await handlers['remote-open-tab']!({ runtimeId: 'f', url: 'about:blank' })).toEqual({
      targetId: 'follower-1:new',
    });
  });

  it('rejects remote-cdp-send when no bridge is wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    await expect(
      handlers['remote-cdp-send']!({ runtimeId: 'f', localTargetId: 't', method: 'Page.enable' })
    ).rejects.toThrow(/remote-cdp bridge not available/);
  });
});
```

If `vi` is not already imported in this test file, add it to the `vitest` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/panel-rpc-handlers.test.ts`
Expected: FAIL — `remoteCdp` not a known option; handlers missing.

- [ ] **Step 3: Add the `remoteCdp` option type**

In `packages/webapp/src/ui/panel-rpc-handlers.ts`, add the import for the bridge type near the other type imports:

```ts
import type { RemoteCdpPageBridge } from './remote-cdp-page-bridge.js';
```

Add to `StandalonePanelRpcHandlerOptions` (after `listRemoteTargets?`):

```ts
  /**
   * Page-side remote-CDP bridge backing the `remote-cdp-*` /
   * `remote-open-tab` ops. Lets the worker BrowserAPI *drive* federated
   * tray/cherry targets by tunneling each CDP op to the page-side
   * `RemoteCDPTransport`. Wired by `mainStandaloneWorker`; absent in
   * environments without a leader tray (the ops then reject clearly).
   * See issue #848.
   */
  remoteCdp?: RemoteCdpPageBridge;
```

- [ ] **Step 4: Add the handlers to the returned record**

In the object returned by `createStandalonePanelRpcHandlers`, after the `'list-remote-targets'` handler, add:

```ts
    'remote-cdp-send': async ({ runtimeId, localTargetId, method, params, sessionId }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.send({ runtimeId, localTargetId, method, params, sessionId });
    },

    'remote-cdp-subscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.subscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-unsubscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.unsubscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-detach': async ({ runtimeId, localTargetId }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.detach({ runtimeId, localTargetId });
    },

    'remote-open-tab': async ({ runtimeId, url }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.openTab({ runtimeId, url });
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/panel-rpc-handlers.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/ui/panel-rpc-handlers.ts packages/webapp/tests/ui/panel-rpc-handlers.test.ts
git commit -m "feat(webapp): add remote-cdp panel-RPC handlers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: leader-sync follower-disconnect cleanup hook

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (`LeaderSyncManagerOptions` + `cleanupRemoteTransports`)
- Modify: `packages/webapp/src/ui/page-leader-tray.ts` (`StartPageLeaderTrayOptions` + `syncOptions`)
- Test: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`, `packages/webapp/tests/ui/page-leader-tray.test.ts`

When a follower disconnects, `LeaderSyncManager.removeFollower()` calls the private `cleanupRemoteTransports(runtimeId)`, which disconnects the page-side `RemoteCDPTransport`s. The page bridge's session map must drop those sessions in sync. We add an optional callback fired from `cleanupRemoteTransports`.

- [ ] **Step 1: Write the failing test (tray-leader-sync)**

This test reuses the file's existing `createManager(overrides)` helper and `FakeChannel` (with `simulateMessage`). Adding a follower then advertising targets populates `runtimeToBootstrap`; `removeFollower` then calls `cleanupRemoteTransports(runtimeId)`, which must fire the new callback. Add inside `describe('LeaderSyncManager', …)`:

```ts
it('fires onRemoteTransportsCleaned for each mapped runtime when a follower is removed', () => {
  const onRemoteTransportsCleaned = vi.fn();
  const { manager } = createManager({ onRemoteTransportsCleaned });
  const ch1 = new FakeChannel();
  manager.addFollower('b1', ch1);
  // Advertise so runtimeToBootstrap maps 'follower-b1' → 'b1'.
  ch1.simulateMessage({
    type: 'targets.advertise',
    targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
    runtimeId: 'follower-b1',
  });
  manager.removeFollower('b1');
  expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('follower-b1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project webapp packages/webapp/tests/scoops/tray-leader-sync.test.ts`
Expected: FAIL — `onRemoteTransportsCleaned` is not a known option / never called.

- [ ] **Step 3: Add the option and fire it**

In `packages/webapp/src/scoops/tray-leader-sync.ts`, add to `LeaderSyncManagerOptions` (near `onFollowerCountChanged?`):

```ts
  /**
   * Invoked from `cleanupRemoteTransports` (follower disconnect) with the
   * runtimeId whose page-side RemoteCDPTransports were just disconnected.
   * The standalone page wires this to the remote-CDP bridge so its
   * worker-facing session map drops matching sessions in sync. See #848.
   */
  onRemoteTransportsCleaned?: (runtimeId: string) => void;
```

In `cleanupRemoteTransports(runtimeId)`, after the loop that disconnects + deletes the cached transports, add the notification (fire once per runtime, regardless of whether any transport existed, so the page bridge can drop a session it created lazily even if the leader never cached one):

```ts
  private cleanupRemoteTransports(runtimeId: string): void {
    const prefix = `${runtimeId}:`;
    for (const key of [...this.remoteTransports.keys()]) {
      if (key.startsWith(prefix)) {
        const transport = this.remoteTransports.get(key);
        transport?.disconnect();
        this.remoteTransports.delete(key);
        log.debug('Cleaned up stale remote transport', { key });
      }
    }
    this.options.onRemoteTransportsCleaned?.(runtimeId);
  }
```

- [ ] **Step 4: Thread the callback through `page-leader-tray.ts`**

In `packages/webapp/src/ui/page-leader-tray.ts`, add to `StartPageLeaderTrayOptions` (near `onFollowerCountChanged?`):

```ts
  onRemoteTransportsCleaned?: LeaderSyncManagerOptions['onRemoteTransportsCleaned'];
```

In `startPageLeaderTray`, add it to `syncOptions` (next to `onFollowerCountChanged`):

```ts
    onFollowerCountChanged: options.onFollowerCountChanged,
    onRemoteTransportsCleaned: options.onRemoteTransportsCleaned,
```

- [ ] **Step 5: Add a page-leader-tray threading test**

In `packages/webapp/tests/ui/page-leader-tray.test.ts`, add a test that starts a tray with an `onRemoteTransportsCleaned` spy, drives a follower add → advertise → remove through `handle.sync`, and asserts the spy fired. `makeBaseOptions(...)` returns the full options object; spread it and add the new field (it's optional, so spreading then assigning is type-safe). A self-contained fake data channel (implementing `TrayDataChannelLike`) captures the `message` listener so we can simulate the follower's `targets.advertise`.

Add the import for the type at the top of the file (next to the existing imports):

```ts
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';
import type { FollowerToLeaderMessage } from '../../src/scoops/tray-sync-protocol.js';
```

Add a local fake channel above the `describe` block:

```ts
class CapturingChannel implements TrayDataChannelLike {
  readyState = 'open';
  private messageListeners: Array<(event: { data: string }) => void> = [];
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener as (event: { data: string }) => void);
    }
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
  simulate(msg: FollowerToLeaderMessage): void {
    const data = JSON.stringify(msg);
    for (const l of this.messageListeners) l({ data });
  }
}
```

And the test (inside `describe('startPageLeaderTray', …)`, which already provides a `beforeEach`-scoped `store: MemorySessionStore` and the `makeLeaderFetch()` helper used by every neighboring test):

```ts
it('threads onRemoteTransportsCleaned into the sync manager', () => {
  const { fetchImpl, webSocketFactory } = makeLeaderFetch();
  const onRemoteTransportsCleaned = vi.fn();
  const opts = {
    ...makeBaseOptions({ fetchImpl, webSocketFactory, store }),
    onRemoteTransportsCleaned,
  };
  const handle = startPageLeaderTray(opts);

  const channel = new CapturingChannel();
  handle.sync.addFollower('b1', channel);
  channel.simulate({
    type: 'targets.advertise',
    targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
    runtimeId: 'follower-b1',
  });
  handle.sync.removeFollower('b1');
  expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('follower-b1');

  handle.stop();
});
```

> No socket needs to connect for this test (we drive `handle.sync` directly), so there's no `sockets[0].dispatch('open')` step. The contract asserted: **the `onRemoteTransportsCleaned` passed to `startPageLeaderTray` is the callback the underlying `LeaderSyncManager` fires on follower removal.**

- [ ] **Step 6: Run both test files to verify they pass**

```bash
npx vitest run --project webapp packages/webapp/tests/scoops/tray-leader-sync.test.ts packages/webapp/tests/ui/page-leader-tray.test.ts
```

Expected: PASS.

- [ ] **Step 7: Lint + commit**

```bash
npm run lint
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/src/ui/page-leader-tray.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts packages/webapp/tests/ui/page-leader-tray.test.ts
git commit -m "feat(webapp): notify on follower-disconnect remote-transport cleanup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: wire the page bridge in `main.ts`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts` — `buildLeaderTrayOptions` (~2542), `clearLeaderHooks` (~2628), the panel-RPC handler install (~2682-2715)

There is no unit-test scaffold for `main.ts` (`mainStandaloneWorker` has no test harness — see the comment at `main.ts:2757`). This wiring is verified by `npm run typecheck` and the Task 9 integration test, which exercises the exact handler + bridge + transport composition `main.ts` assembles.

- [ ] **Step 1: Add imports**

In `packages/webapp/src/ui/main.ts`, add to the imports (near the other `./` imports):

```ts
import { createRemoteCdpPageBridge } from './remote-cdp-page-bridge.js';
import { panelRpcChannelName, type PanelRpcPushMsg } from '../kernel/panel-rpc.js';
```

(If `installPanelRpcHandler` is already dynamically imported at the call site, keep that; only `panelRpcChannelName` + `PanelRpcPushMsg` + `createRemoteCdpPageBridge` are new. If `panel-rpc.js` is already statically imported elsewhere in main.ts, merge the named imports rather than adding a duplicate import line.)

- [ ] **Step 2: Construct the push channel + bridge before `buildLeaderTrayOptions`**

Immediately **before** the `const buildLeaderTrayOptions = …` declaration (~line 2542), add:

```ts
// Remote-CDP driving bridge (issue #848): the kernel worker's BrowserAPI
// drives federated tray/cherry targets by tunneling CDP over panel-RPC
// to this page-side bridge, which owns the real RemoteCDPTransport via
// `pageLeaderTray.sync`. CDP events flow back as `remote-cdp-event`
// pushes on a dedicated channel instance (same instance-scoped name).
const remoteCdpPushChannel =
  typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(panelRpcChannelName(instanceId))
    : null;
const remoteCdpBridge = createRemoteCdpPageBridge({
  getSync: () => pageLeaderTray?.sync ?? null,
  postEvent: (payload) => {
    const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
    remoteCdpPushChannel?.postMessage(msg);
  },
});
```

> `pageLeaderTray` is already forward-declared above this point (the existing panel-RPC handler closes over it). `instanceId` is in scope (used by the existing `installPanelRpcHandler` call).

- [ ] **Step 3: Wire `onRemoteTransportsCleaned` into `buildLeaderTrayOptions`**

In the object returned by `buildLeaderTrayOptions`, add (next to `onFollowerCountChanged`):

```ts
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
```

- [ ] **Step 4: Pass the bridge into the handlers**

In the `createStandalonePanelRpcHandlers({ … })` call (~2686), add:

```ts
      remoteCdp: remoteCdpBridge,
```

- [ ] **Step 5: Dispose sessions on leader stop + unload**

In `clearLeaderHooks` (~2628), add a line so leaving/stopping the leader tears down active sessions:

```ts
const clearLeaderHooks = (): void => {
  setConnectedFollowersGetter(null);
  setTrayResetter(null);
  layout.panels.chat.setOnLocalUserMessage(undefined);
  sprinkleManager.setSendToSprinkleHook(undefined);
  remoteCdpBridge.disposeAll();
};
```

In the existing `beforeunload` once-listener that calls `stopPanelRpcHandler()` (~2715), extend it:

```ts
window.addEventListener(
  'beforeunload',
  () => {
    stopPanelRpcHandler();
    remoteCdpBridge.disposeAll();
    remoteCdpPushChannel?.close();
  },
  { once: true }
);
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run lint
git add packages/webapp/src/ui/main.ts
git commit -m "feat(webapp): wire standalone remote-CDP page bridge in main.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: cross-realm integration test (the #848 regression bar)

**Files:**

- Create: `packages/webapp/tests/cdp/standalone-remote-cdp-bridge.integration.test.ts`

Wires a worker-side `PanelRpcCdpTransport` (via the provider) ↔ the page-side handlers (via `installPanelRpcHandler` + the bridge) ↔ a real `RemoteCDPTransport` driven by a fake `RemoteCDPSender`, all over a `FakeChannel` BroadcastChannel. Asserts a `screenshot` round-trips (realistic-size payload) and a `navigate`'s `once('Page.loadEventFired')` resolves from a pushed event.

- [ ] **Step 1: Write the integration test**

Create `packages/webapp/tests/cdp/standalone-remote-cdp-bridge.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPanelRpcTrayProvider } from '../../src/cdp/panel-rpc-tray-provider.js';
import { RemoteCDPTransport, type RemoteCDPSender } from '../../src/cdp/remote-cdp-transport.js';
import {
  createPanelRpcClient,
  installPanelRpcHandler,
  panelRpcChannelName,
  type PanelRpcClient,
  type PanelRpcPushMsg,
} from '../../src/kernel/panel-rpc.js';
import {
  createRemoteCdpPageBridge,
  type RemoteCdpSyncProvider,
} from '../../src/ui/remote-cdp-page-bridge.js';
import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';

/**
 * In-memory BroadcastChannel polyfill (same shape as the one in
 * tests/kernel/panel-rpc.test.ts): async delivery via queueMicrotask,
 * never delivers to the posting instance.
 */
class FakeChannel {
  private static buses = new Map<string, Set<FakeChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;
  constructor(public readonly name: string) {
    let bus = FakeChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeChannel.buses.get(this.name);
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
    FakeChannel.buses.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

let saved: typeof BroadcastChannel | undefined;
beforeEach(() => {
  saved = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
    FakeChannel as unknown as typeof BroadcastChannel;
});
afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = saved;
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = undefined;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Captures CDP requests and resolves them from a shared canned-response map. */
class FakeSender implements RemoteCDPSender {
  transport!: RemoteCDPTransport;
  constructor(private readonly responses: Record<string, Record<string, unknown>>) {}
  sendCDPRequest(
    requestId: string,
    method: string,
    _params?: Record<string, unknown>,
    _sessionId?: string
  ): void {
    // Resolve synchronously, as the real sync manager would on a fast
    // local round-trip. Unknown methods resolve with {}.
    this.transport.handleResponse(requestId, this.responses[method] ?? {});
  }
}

/**
 * Build the full standalone wiring over a single instance-scoped channel
 * name: worker client + provider, page handlers + bridge + pusher, and a
 * fake leader sync that hands out real RemoteCDPTransports driven by a
 * fake sender. The shared `responses` map is consulted by every sender,
 * so seeding it before a send makes even the first send deterministic.
 * Returns the provider + per-target transports (for firing events) + a
 * teardown.
 */
function wire(instanceId: string, responses: Record<string, Record<string, unknown>>) {
  // ── Page side ──
  const transports = new Map<string, RemoteCDPTransport>();
  const fakeSync: RemoteCdpSyncProvider = {
    createRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      let t = transports.get(key);
      if (!t) {
        const sender = new FakeSender(responses);
        t = new RemoteCDPTransport(sender);
        sender.transport = t;
        transports.set(key, t);
      }
      return t;
    },
    removeRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      transports.get(key)?.disconnect();
      transports.delete(key);
    },
    async openRemoteTab(runtimeId) {
      return `${runtimeId}:new-tab`;
    },
  };

  const pushChannel = new BroadcastChannel(panelRpcChannelName(instanceId));
  const bridge = createRemoteCdpPageBridge({
    getSync: () => fakeSync,
    postEvent: (payload) => {
      const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
      pushChannel.postMessage(msg);
    },
  });
  const stopHandler = installPanelRpcHandler({
    instanceId,
    handlers: createStandalonePanelRpcHandlers({ remoteCdp: bridge }),
  });

  // ── Worker side ──
  const client: PanelRpcClient = createPanelRpcClient({ instanceId });
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = client;
  const provider = createPanelRpcTrayProvider(() => client);

  return {
    provider,
    transports,
    teardown: () => {
      client.dispose();
      stopHandler();
      pushChannel.close();
    },
  };
}

describe('standalone remote-CDP bridge (integration)', () => {
  it('round-trips attach + a realistic-size screenshot through the bridge', async () => {
    const bigData = 'A'.repeat(2_000_000); // ~2MB base64 screenshot payload
    const responses = {
      'Target.attachToTarget': { sessionId: 'sess-1' },
      'Page.enable': {},
      'Page.captureScreenshot': { data: bigData },
    };
    const { provider, teardown } = wire('itest-screenshot', responses);
    // BrowserAPI would do: createRemoteTransport → Target.attachToTarget →
    // Page.enable → Page.captureScreenshot. Drive the transport directly.
    const transport = provider.createRemoteTransport!('follower-1', 'cherry-target');

    const attach = await transport.send('Target.attachToTarget', { targetId: 'cherry-target' });
    expect(attach).toEqual({ sessionId: 'sess-1' });
    await transport.send('Page.enable', {}, 'sess-1');
    const shot = await transport.send('Page.captureScreenshot', { format: 'png' }, 'sess-1');
    expect((shot.data as string).length).toBe(2_000_000);

    teardown();
  });

  it("navigate's once('Page.loadEventFired') resolves from a pushed event", async () => {
    const responses = { 'Page.navigate': { frameId: 'f1' } };
    const { provider, transports, teardown } = wire('itest-navigate', responses);
    const transport = provider.createRemoteTransport!('follower-1', 'cherry-target');

    // Subscribe for the load event first (BrowserAPI.navigate uses once()
    // before issuing the navigate), then drive the navigate.
    const loadPromise = transport.once('Page.loadEventFired');
    const nav = await transport.send('Page.navigate', { url: 'https://x.test' }, 'sess-1');
    expect(nav).toEqual({ frameId: 'f1' });

    // Allow the subscribe round-trip to wire the page-side forwarder.
    await tick();
    await tick();

    // Follower fires the event → page RemoteCDPTransport.handleEvent →
    // forwarder posts remote-cdp-event push → worker transport resolves once().
    transports.get('follower-1:cherry-target')!.handleEvent('Page.loadEventFired', {
      timestamp: 123,
    });

    await expect(loadPromise).resolves.toEqual({ timestamp: 123 });
    teardown();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run --project webapp packages/webapp/tests/cdp/standalone-remote-cdp-bridge.integration.test.ts`
Expected: PASS (2 tests) — the screenshot round-trips a 2MB payload, and the navigate's `once('Page.loadEventFired')` resolves from a pushed event.

- [ ] **Step 3: Lint + commit**

```bash
npm run lint
git add packages/webapp/tests/cdp/standalone-remote-cdp-bridge.integration.test.ts
git commit -m "test(webapp): cross-realm integration for standalone remote-CDP bridge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: documentation (three-gates)

**Files:**

- Modify: `docs/architecture.md` (tray / federated-CDP section)
- Modify: `packages/webapp/CLAUDE.md` (CDP/tray subsection)

- [ ] **Step 1: Find the tray / federated-CDP section in `docs/architecture.md`**

Run: `grep -n "federated\|RemoteCDPTransport\|TrayTargetProvider\|tray" docs/architecture.md | head -30`
Locate the subsection describing federated CDP / tray target routing.

- [ ] **Step 2: Add the worker→page driving note to `docs/architecture.md`**

In that section, add a paragraph (adapt heading level to the surrounding doc):

```markdown
**Standalone remote-CDP driving (worker → page).** In standalone mode the agent's
`BrowserAPI` runs in the kernel worker, but the tray's `LeaderSyncManager` and the
WebRTC data channels live on the page. The worker can't own an `RTCDataChannel`, so
it drives federated tray/cherry targets through a panel-RPC bridge: the worker
`BrowserAPI` gets a `TrayTargetProvider` (`createPanelRpcTrayProvider`) whose
`createRemoteTransport()` returns a `PanelRpcCdpTransport` (modeled on
`RemoteCDPTransport`: starts `'connected'`, no-op `connect()`, lazy page-side
session on first `send`). Each CDP op is a `remote-cdp-send` panel-RPC call; the
page-side `remote-cdp-*` handlers (backed by `createRemoteCdpPageBridge`) own the
real `RemoteCDPTransport` via `pageLeaderTray.sync` and relay both directions. CDP
events flow back over a `panel-rpc-push` / `remote-cdp-event` envelope on the same
instance-scoped channel. Listing stays separate (the `list-remote-targets`
supplement); this bridge is for _driving_. The extension float doesn't use it —
its `BrowserAPI`, tray, and WebRTC channels all share the offscreen realm.
```

- [ ] **Step 3: Find and update the CDP/tray subsection in `packages/webapp/CLAUDE.md`**

Run: `grep -n "CDP\|tray\|RemoteCDPTransport\|federated" packages/webapp/CLAUDE.md | head -30`
Add a concise note to the CDP (or tray) subsection:

```markdown
- **Standalone remote-CDP driving:** the worker-side `BrowserAPI` gets a panel-RPC
  bridging `TrayTargetProvider` (`cdp/panel-rpc-tray-provider.ts`) so the cone can
  _drive_ federated tray/cherry targets, not just list them. `PanelRpcCdpTransport`
  (`cdp/panel-rpc-cdp-transport.ts`) tunnels CDP over the panel-RPC BroadcastChannel
  to page-side `remote-cdp-*` handlers (`ui/remote-cdp-page-bridge.ts`), which own
  the real `RemoteCDPTransport`. Events return via the `remote-cdp-event` push.
  Extension mode is unaffected (in-realm). See issue #848.
```

- [ ] **Step 4: Format docs**

Run: `npm run lint`
Expected: PASS (prettier formats the Markdown).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md packages/webapp/CLAUDE.md
git commit -m "docs: standalone remote-CDP driving bridge (worker → page)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (run the full gate suite before opening a PR)

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: PASS (no diffs).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Full webapp test + coverage**

Run: `npm run test:coverage:webapp`
Expected: PASS, coverage at or above the webapp floor (50% lines/statements/functions, 40% branches). The new files are small and well-covered by their unit + integration tests.

- [ ] **Step 4: Build**

Run: `npm run build -w @slicc/webapp`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional, requires a follower)**

1. `npm run dev` (leader). Configure a tray worker URL; start a follower (a second standalone instance joining the tray, or a cherry host page).
2. In the cone, run `playwright-cli tab-list` — confirm the follower's composite target (`<runtimeId>:<localTargetId>`) appears (existing listing bridge).
3. Run `playwright-cli screenshot --tab=<follower:target>` — confirm it returns an image instead of `CDP error: No target with given id found (-32602)`.
4. Run `playwright-cli goto --tab=<follower:target> https://example.com` — confirm navigation completes (the `Page.loadEventFired` round-trips via the push).

```

```
