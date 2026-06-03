# Standalone remote-CDP bridge — driving federated tray targets from the cone

**Status:** Design / approved through brainstorming
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
build a `RemoteCDPTransport`. That realm boundary — not the driving logic — is
the entire gap.

Listing was already bridged worker→page via the `list-remote-targets`
panel-RPC op. This is the same move for **driving**.

## Goal

From a standalone leader's cone, driving a remote (tray/cherry) target works
with **full parity** to a local tab — `screenshot`, `navigate`, `evaluate`,
`click`/`type`, `snapshot`/accessibility — anything `BrowserAPI` does. Achieved
without changing `BrowserAPI`'s driving logic: the worker gets a
`TrayTargetProvider` whose transport tunnels CDP over the existing panel-RPC
BroadcastChannel to the page, where the real `RemoteCDPTransport` lives.

## Non-goals

- No change to the extension/offscreen path (it already works in-realm).
- No new transport stack — reuse the existing panel-RPC BroadcastChannel and the
  page-side `RemoteCDPTransport`.
- Not changing how targets are **listed** (the `list-remote-targets` supplement
  in `playwright-command.ts` stays as-is).
- `Network.*` remains unavailable on cherry targets (a follower/cherry
  capability concern, orthogonal to this bridge).

## Architecture

Give the kernel-worker `BrowserAPI` a `TrayTargetProvider` whose
`createRemoteTransport()` returns a `PanelRpcCdpTransport` — a `CDPTransport`
implementation that tunnels over the panel-RPC BroadcastChannel to a page-side
handler. The handler owns the _real_ `RemoteCDPTransport` (built via the
page's `LeaderSyncManager` provider) and relays both directions. Net effect:
the worker's `attachToPage` / `withTab` / `screenshot` / `navigate` / … run
**unchanged** — the same code path the offscreen BrowserAPI already uses; only
the transport differs (panel-RPC-tunneled instead of directly owning WebRTC).

## Components

### 1. `PanelRpcCdpTransport` (worker, `packages/webapp/src/cdp/`)

Implements `CDPTransport`:

- `connect()` → panel-RPC `remote-cdp-attach { runtimeId, localTargetId }`; the
  page creates/gets its `RemoteCDPTransport` for the target.
- `send(method, params, sessionId, timeout)` → panel-RPC
  `remote-cdp-send { runtimeId, localTargetId, method, params, sessionId }`;
  returns the page-relayed CDP response. `sessionId` threads through
  transparently (the bridge is session-agnostic).
- `on(event, listener)` / `off` / `once(event, timeout)` — register interest
  locally; the first listener for an event sends `remote-cdp-subscribe`
  (idempotent) so the page wires a forwarder; `off`/teardown send
  `remote-cdp-unsubscribe`. Events arrive as pushed `remote-cdp-event` messages
  and dispatch to local listeners. `once` resolves on the next matching push
  (with timeout).
- `disconnect()` → panel-RPC `remote-cdp-detach`; the page disposes its
  transport + forwarders.
- `state` tracks connection state.

Keyed per `runtimeId:localTargetId`.

### 2. Worker bridging `TrayTargetProvider` (`packages/webapp/src/cdp/`, wired in `kernel-worker.ts`)

`createPanelRpcTrayProvider(getPanelRpc)`:

- `createRemoteTransport(runtimeId, localTargetId)` → a `PanelRpcCdpTransport`.
- `removeRemoteTransport(runtimeId, localTargetId)` → disconnects/disposes it.
- `openRemoteTab(runtimeId, url)` → panel-RPC `remote-open-tab`, returning the
  composite targetId.
- `getTargets()` returns `[]` — listing stays handled by the existing
  `list-remote-targets` supplement in `playwright-command.ts` (a `[]` here is
  behaviourally identical to today's no-provider case, so there is no listing
  regression). This provider's job is **driving**, not listing.

Wired once at worker boot: `browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient))`.
Safe to set unconditionally — its methods are only exercised for composite
remote ids, which exist only when a tray is active; with no panel-RPC client
they fail closed with a clear "no page bridge" error.

### 3. Page-side handlers (`createStandalonePanelRpcHandlers` + `main.ts` wiring)

New handlers, backed by a callback `main.ts` wires to
`pageLeaderTray.sync` (the `LeaderSyncManager`, which is the page-side
`TrayTargetProvider`):

- `remote-cdp-attach` → `sync.createRemoteTransport(runtimeId, localTargetId)`;
  track the session.
- `remote-cdp-send` → relay `transport.send(...)`, return the response.
- `remote-cdp-subscribe` / `remote-cdp-unsubscribe` → wire/unwire
  `transport.on(event, forwarder)`; the forwarder posts a `remote-cdp-event`
  worker-ward.
- `remote-cdp-detach` → unsubscribe all + dispose; remove from tracking.
- `remote-open-tab` → `sync.openRemoteTab(runtimeId, url)`.

Lifecycle: all active remote sessions are torn down on `beforeunload` /
session-reload (mirrors the existing handler teardown), so nothing leaks.

### 4. `panel-rpc.ts` protocol additions

- Request ops (worker→page, req/resp): `remote-cdp-attach`, `remote-cdp-send`,
  `remote-cdp-subscribe`, `remote-cdp-unsubscribe`, `remote-cdp-detach`,
  `remote-open-tab`, with matching `PanelRpcResults` entries.
- A new **page→worker push** message `remote-cdp-event`
  `{ runtimeId, localTargetId, method, params }`. The BroadcastChannel is
  already bidirectional (worker posts requests, page posts responses); the
  worker's existing channel listener gains a branch that routes
  `remote-cdp-event` to the matching `PanelRpcCdpTransport` (by
  `runtimeId:localTargetId`).

## Data flow

```
worker:  playwright-cli screenshot --tab follower-X:cherry-target
  withTab(composite) → attachToPage(composite)
    → provider.createRemoteTransport(X, cherry-target) = PanelRpcCdpTransport
    → transport.connect()                  → [remote-cdp-attach]  → page: sync.createRemoteTransport(...)
    → send('Target.attachToTarget', …)     → [remote-cdp-send]     → page RemoteCDPTransport → WebRTC → follower
  → screenshot() → send('Page.captureScreenshot') → [remote-cdp-send] → … → bytes back
  navigate():
    → send('Page.navigate', …)             → [remote-cdp-send]
    → once('Page.loadEventFired')          → [remote-cdp-subscribe] then push:
         follower fires loadEventFired → page RemoteCDPTransport.on → [remote-cdp-event push] → worker dispatch → once() resolves
  (withTab finally) → transport.disconnect() → [remote-cdp-detach]
```

## Error handling & lifecycle

- No panel-RPC client (not standalone / no page bridge) → `connect`/`send`
  reject with a clear "no page bridge to the leader tray" message (mirrors the
  `cherry-emit` pattern); surfaces to `playwright-cli` as a non-zero exit.
- No active leader tray / target gone / follower disconnected → the page handler
  returns a CDP-style error, surfaced unchanged to the cone.
- Hangs → panel-RPC calls already support `timeoutMs`; the CDP `send` timeout
  threads through.
- Teardown: detach disposes the page-side transport + forwarders; `beforeunload`
  / session-reload tears down all active remote sessions.

## Testing

- **Unit (worker):** `PanelRpcCdpTransport` — `send` maps to the op, pushed
  events dispatch to `on` listeners, `once` resolves/timeouts, `connect`/
  `disconnect` issue attach/detach. The provider — `createRemoteTransport`
  returns the transport; `removeRemoteTransport` disposes.
- **Unit (page):** the handlers — attach creates via a fake `sync`, send
  relays, subscribe wires a forwarder that posts `remote-cdp-event`, detach
  disposes; teardown on unload.
- **Integration:** wire a worker `PanelRpcCdpTransport` ↔ page handler ↔ a fake
  `RemoteCDPTransport` over a fake BroadcastChannel, and assert a `screenshot`
  round-trips **and** a `navigate` `once('Page.loadEventFired')` resolves from a
  pushed event. This doubles as the cross-realm regression test the cherry PR
  lacked.

## Out of scope / future

- Folding remote listing into the worker provider's `getTargets()` (and
  simplifying `playwright-command.ts`'s explicit supplement) — optional cleanup,
  not required.
- Per-event volume optimization beyond explicit subscribe/unsubscribe.
