# Standalone remote-CDP bridge — driving federated tray targets from the cone

**Status:** Design / approved through brainstorming (revised after design review)
**Date:** 2026-06-03
**Owner:** Karl
**Issue:** [ai-ecoverse/slicc#848](https://github.com/ai-ecoverse/slicc/issues/848)

## Problem

In **standalone** mode (the kernel-worker architecture used by the CLI and the
hosted-leader/cloud float), the agent's `playwright-cli` can **enumerate**
remote tray/cherry targets but cannot **drive** them. Any CDP operation on a
composite `"<runtimeId>:<localTargetId>"` target fails with Chrome's
`CDP error: No target with given id found (-32602)`.

Root cause: `playwright-cli` runs in the **kernel worker**
(`kernel-worker.ts` → `new BrowserAPI(cdpProxy)`). `BrowserAPI.attachToPage()`
only routes a composite id through a `RemoteCDPTransport` when
`this.trayTargetProvider` is set, and `setTrayTargetProvider()` is called only
on the **page-side** BrowserAPI (`page-leader-tray.ts`) and the **offscreen**
BrowserAPI in the extension (`offscreen.ts`) — never on the worker's. So in
standalone the composite id falls through to a _local_ attach against the
leader's own Chrome, which has no such target.

**Why the extension already works (and standalone doesn't):** in the extension
the agent, the `BrowserAPI`, the tray `LeaderSyncManager`, and the WebRTC data
channels all live in the **same realm** (the offscreen document), so the
BrowserAPI builds a `RemoteCDPTransport` straight over the co-located WebRTC
channel — no bridge needed. Standalone splits the agent + `BrowserAPI` (kernel
worker) from the tray + WebRTC channels (page). The worker physically cannot
build a `RemoteCDPTransport` (the `RTCDataChannel` is non-transferable). That
realm boundary — not the driving logic — is the entire gap.

Listing was already bridged worker→page via the `list-remote-targets`
panel-RPC op (PR #831, on main). This is the same move for **driving**.

## Goal

From a standalone leader's cone, driving a remote (tray/cherry) target works
with **full parity** to a local tab — `screenshot`, `navigate`, `evaluate`,
`click`/`type`, `snapshot`/accessibility — anything `BrowserAPI` does, **without
changing `BrowserAPI`'s driving logic**: the worker gets a `TrayTargetProvider`
whose transport tunnels CDP over the existing panel-RPC BroadcastChannel to the
page, where the real `RemoteCDPTransport` lives.

## Non-goals

- No change to the extension/offscreen path (it already works in-realm).
- No new transport stack — reuse the existing panel-RPC BroadcastChannel and the
  page-side `RemoteCDPTransport`.
- Not changing how targets are **listed** (the `list-remote-targets` supplement
  in `playwright-command.ts` stays as-is). Worker-side `BrowserAPI.listAllTargets()`
  therefore remains local-only — see "Listing stays split" below.
- `Network.*` remains unavailable on cherry targets (a follower/cherry
  capability concern, orthogonal to this bridge).

## Architecture

Give the kernel-worker `BrowserAPI` a `TrayTargetProvider` whose
`createRemoteTransport()` returns a `PanelRpcCdpTransport` — a `CDPTransport`
implementation that tunnels over the panel-RPC BroadcastChannel to a page-side
handler. The handler lazily creates/owns the _real_ `RemoteCDPTransport` (via
the page's `LeaderSyncManager` provider) and relays both directions. Net
effect: the worker's `attachToPage` / `withTab` / `screenshot` / `navigate` / …
run **unchanged** — the same code path the offscreen BrowserAPI already uses;
only the transport differs (panel-RPC-tunneled instead of directly owning
WebRTC).

## Components

### 1. `PanelRpcCdpTransport` (worker, `packages/webapp/src/cdp/panel-rpc-cdp-transport.ts`)

Implements `CDPTransport`, **modeled on `RemoteCDPTransport`** (same shape, same
no-`connect()` lifecycle) — this is load-bearing:

- **Lifecycle parity with `RemoteCDPTransport`:** initial `state = 'connected'`,
  `connect()` is a no-op. `BrowserAPI.attachToPage()` / `closePage()` go
  straight to `createRemoteTransport()` → `send('Target.attachToTarget' | …)`
  and **never call `connect()`** on a remote transport. The page-side session is
  created **lazily on the first `send`/`subscribe`** for a key, not by an
  explicit attach step. (Mirroring `RemoteCDPTransport`, whose `connect()` is
  `/* no-op — connected via data channel */`.)
- `send(method, params, sessionId, timeout)` → `panelRpc.call('remote-cdp-send',
{ runtimeId, localTargetId, method, params, sessionId }, { timeoutMs })` →
  returns the page-relayed CDP response. `sessionId` threads through
  transparently (the bridge is session-agnostic). Timeout rule below.
- `on(event, listener)` / `off` / `once(event, timeout)` — maintain a local
  `eventListeners` map (as `RemoteCDPTransport` does). The first listener for an
  event sends `remote-cdp-subscribe`; the last `off` sends
  `remote-cdp-unsubscribe`. Pushed `remote-cdp-event` messages dispatch to local
  listeners; `once` resolves on the next matching push (with timeout).
- `disconnect()` → `panelRpc.call('remote-cdp-detach', …)`; clears local
  listeners.
- Fails closed: if `getPanelRpcClient()` is `null` (not standalone / no page
  bridge), `send` rejects with a clear "no page bridge to the leader tray"
  error — the same fail-closed pattern other worker-side panel-RPC consumers use
  (e.g. `cherry-emit`).

> Implementation note: a hand-rolled impl mirroring `RemoteCDPTransport` fits
> panel-RPC's call/promise + event-push model directly. `kernel/cdp-bridge.ts`'s
> `CdpTransportBridge` (used by `panel-cdp-proxy` / `offscreen-cdp-proxy`) is an
> alternative if it removes more duplicated listener/timeout logic than it adds
> impedance against panel-RPC's promise-based `call()`. The plan picks one;
> either way the observable `CDPTransport` behavior must match `RemoteCDPTransport`.

### 2. Worker bridging `TrayTargetProvider` (`packages/webapp/src/cdp/panel-rpc-tray-provider.ts`, wired in `kernel-worker.ts`)

`createPanelRpcTrayProvider(getPanelRpc)`:

- `createRemoteTransport(runtimeId, localTargetId)` → a `PanelRpcCdpTransport`,
  **cached by `runtimeId:localTargetId`** so repeated `attachToPage` to the same
  target (or `closePage`'s create/use/remove) doesn't leak page-side sessions.
- `removeRemoteTransport(runtimeId, localTargetId)` → `disconnect()` the cached
  transport (→ `remote-cdp-detach`) and drop it from the cache. Must be reached
  from every `BrowserAPI` cleanup path (detach, target switch,
  `ensureConnected()` recovery) — same call sites that already invoke it for the
  page-side provider.
- `openRemoteTab(runtimeId, url)` → `panelRpc.call('remote-open-tab', …)`,
  returning the composite targetId.
- `getTargets()` returns `[]` — listing stays on the existing
  `list-remote-targets` supplement (a `[]` here is behaviourally identical to
  today's no-provider case → no listing regression). This provider's job is
  **driving**, not listing.

Wired once at worker boot, after `BrowserAPI` construction:
`browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient))`.
Safe to set unconditionally — its methods are exercised only for composite
remote ids (which exist only when a tray is active); with no panel-RPC client it
fails closed.

### 3. Page-side handlers (`createStandalonePanelRpcHandlers` + `main.ts` wiring)

New handlers, backed by a callback `main.ts` wires to `pageLeaderTray.sync` (the
`LeaderSyncManager`, the page-side `TrayTargetProvider`). The handler keeps a
**session map** `runtimeId:localTargetId → { transport, forwarders }`:

- `remote-cdp-send` → get-or-**lazily create** the session's
  `RemoteCDPTransport` via `sync.createRemoteTransport(runtimeId, localTargetId)`,
  relay `transport.send(...)`, return the response. (No separate attach op —
  matches `RemoteCDPTransport`'s lazy model.)
- `remote-cdp-subscribe` / `remote-cdp-unsubscribe` `{ runtimeId, localTargetId,
event }` → **ref-counted** per `(target, event)` (mirror the 0→1 / 1→0
  subscribe protocol in `cdp-worker-proxy.ts` / `startPageCdpForwarder`): on
  0→1, wire `transport.on(event, forwarder)` where the forwarder posts a
  `remote-cdp-event` push worker-ward; on 1→0, `transport.off(...)`. Prevents
  duplicate forwarders / premature unsubscription with multiple listeners.
- `remote-cdp-detach` → drop all forwarders + dispose the session.
- `remote-open-tab` → `sync.openRemoteTab(runtimeId, url)`.

### 4. `panel-rpc.ts` protocol additions

- Request ops (worker→page, req/resp, in the `PanelRpcRequest` union with
  matching `PanelRpcResults`): `remote-cdp-send`, `remote-cdp-subscribe`,
  `remote-cdp-unsubscribe`, `remote-cdp-detach`, `remote-open-tab`. Payloads:
  - send: `{ runtimeId, localTargetId, method, params?, sessionId? }` → CDP result
  - subscribe/unsubscribe: `{ runtimeId, localTargetId, event }` → `{ ok: true }`
  - detach: `{ runtimeId, localTargetId }` → `{ ok: true }`
  - open-tab: `{ runtimeId, url }` → `{ targetId }`
- A new **page→worker push** envelope, distinct from req/resp:
  ```ts
  interface PanelRpcPushMsg {
    type: 'panel-rpc-push';
    op: 'remote-cdp-event';
    payload: {
      runtimeId: string;
      localTargetId: string;
      method: string;
      params?: Record<string, unknown>;
    };
  }
  ```
  Posted on the **same instance-scoped** `slicc-panel-rpc:{instanceId}` channel.
  `createPanelRpcClient`'s channel listener (today handles only
  `panel-rpc-response`) gains a branch that routes `panel-rpc-push` /
  `remote-cdp-event` to the matching `PanelRpcCdpTransport` via a worker-side
  registry `(runtimeId:localTargetId) → transport`.

## Timeout layering

- panel-RPC default `call()` timeout is **15s** (`DEFAULT_TIMEOUT_MS`); CDP
  default is **30s** (`RemoteCDPTransport`). For `remote-cdp-send`, the panel-RPC
  `timeoutMs` **must be ≥ the CDP send timeout** so the bridge layer never times
  out before the CDP op does. Rule: `timeoutMs = max(cdpTimeout ?? 30_000, DEFAULT_TIMEOUT_MS) + margin`.
  Subscribe/unsubscribe/detach/open-tab use the panel-RPC default.

## Data flow

```
worker:  playwright-cli screenshot --tab follower-X:cherry-target
  withTab(composite) → attachToPage(composite)
    → provider.createRemoteTransport(X, cherry-target) = PanelRpcCdpTransport  (state 'connected', no connect())
    → send('Target.attachToTarget', …)  → [remote-cdp-send] → page lazily creates RemoteCDPTransport(X,ct) → WebRTC → follower
  → screenshot() → send('Page.captureScreenshot') → [remote-cdp-send] → … → bytes back
  navigate():
    → send('Page.navigate', …)          → [remote-cdp-send]
    → once('Page.loadEventFired')        → [remote-cdp-subscribe] (0→1) then push:
         follower fires loadEventFired → page RemoteCDPTransport.on → [remote-cdp-event push] → worker dispatch → once() resolves
  (withTab finally) → provider.removeRemoteTransport → transport.disconnect() → [remote-cdp-detach]
```

## Error handling & lifecycle

| Condition                                             | Behavior                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No panel-RPC client (not standalone / no page bridge) | `send` rejects with a clear "no page bridge to the leader tray" message → `playwright-cli` non-zero exit (fail-closed, like `cherry-emit`).                                                 |
| Leader tray not started                               | `remote-cdp-send` (lazy create) rejects with a clear error, same as `tray-reset` when no leader.                                                                                            |
| Follower disconnects mid-command                      | Page `RemoteCDPTransport` errors → relayed unchanged to the worker → `BrowserAPI.ensureConnected()` recovery applies.                                                                       |
| Follower disconnect (out of band)                     | `LeaderSyncManager.cleanupRemoteTransports(runtimeId)` already fires page-side; the handler's session map must drop matching sessions in sync (and a later worker `send` then fails clean). |
| `tray-leave` / leader stop                            | Tear down active page-side sessions, else worker transports hang on the next `send`.                                                                                                        |
| Page reload / session reload / `beforeunload`         | Dispose all sessions — wire into the existing handler disposer in `main.ts`.                                                                                                                |

## Listing stays split (documented, intentional)

`getTargets()` returning `[]` means worker-side `BrowserAPI.listAllTargets()`
still won't include remote targets — only `playwright-cli tab-list` (via the
`list-remote-targets` supplement) will. Other worker callers of
`listAllTargets()` (e.g. `realm-host.ts`, `upskill-command.ts`) remain
local-only. That's acceptable and out of scope here; folding listing into the
provider is deferred.

## Large responses over BroadcastChannel

Screenshot/evaluate results can be multi-MB base64. The page-side
`RemoteCDPTransport` already reassembles chunked tray responses before its
`send()` resolves, so the panel-RPC relay sees a single complete result. The
integration test must include a realistic-size screenshot payload to de-risk
structured-clone limits on the BroadcastChannel (local CDP already crosses a
MessagePort, so this is expected to be fine).

## Testing

- **Unit (worker):** `PanelRpcCdpTransport` — initial `state==='connected'` and
  `connect()` is a no-op; `send` maps to `remote-cdp-send` with the right
  timeout; pushed events dispatch to `on` listeners; `once` resolves/timeouts;
  first `on`→subscribe, last `off`→unsubscribe; `disconnect`→detach; no-client →
  fail-closed. The provider — `createRemoteTransport` caches per key;
  `removeRemoteTransport` disconnects + evicts.
- **Unit (page):** handlers — lazy create via a fake `sync`; send relays;
  ref-counted subscribe/unsubscribe wires/unwires a forwarder that posts a push;
  detach disposes; teardown on unload; `cleanupRemoteTransports` drops sessions.
- **Integration (the #848 regression bar):** wire worker `PanelRpcCdpTransport`
  ↔ page handler ↔ a fake `RemoteCDPTransport` over a fake BroadcastChannel;
  assert a `screenshot` round-trips (with a realistic-size payload) **and** a
  `navigate`'s `once('Page.loadEventFired')` resolves from a pushed event.

## Documentation (repo three-gates)

- `docs/architecture.md` — tray / federated-CDP section: note the worker→page
  bridge for **driving** (not just listing), and the `remote-cdp-*` ops +
  `remote-cdp-event` push.
- `packages/webapp/CLAUDE.md` — CDP/tray subsection: the worker `BrowserAPI`
  now gets a panel-RPC bridging `TrayTargetProvider` in standalone.

## Sequencing

- Implement against **main** (which has the `list-remote-targets` listing bridge,
  PR #831 — the "listing already bridged" premise). The driving bridge lands
  independently but is tested with the listing supplement in place — repro from
  #848: `tab-list` then `screenshot --tab=<follower:target>`.

## Out of scope / future

- Folding remote listing into the worker provider's `getTargets()` (and
  simplifying `playwright-command.ts`'s supplement) — optional cleanup.
- Per-event volume optimization beyond ref-counted subscribe/unsubscribe.
