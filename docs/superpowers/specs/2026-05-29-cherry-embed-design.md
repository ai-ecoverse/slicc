# Cherry — Embedded SLICC Follower (`@slicc/cherry`)

**Status:** Design / approved through brainstorming
**Date:** 2026-05-29
**Owner:** Karl
**Spec:** this document

## Summary

Cherry lets a third-party web page embed a live SLICC follower inside an
iframe and **lend its own page to the agent as a driveable CDP target**. The
embedding host loads a small SDK (`@slicc/cherry`), drops a SLICC iframe into a
container, and wires a handful of host capabilities (navigate, screenshot,
permission prompt). From that point a remote SLICC **leader** (a cloud cone)
drives the host page through the existing federated-CDP / tray machinery — the
same `playwright-cli` and `BrowserAPI` skills work unchanged, because the host
page is exposed as one ordinary CDP target.

The garnish metaphor: a **cherry** sits on top of someone else's sundae (their
page) and is driven by the cone underneath.

### What this is, precisely

- **Cherry is not a new follower role.** It is an ordinary tray _follower_
  (the same code path as `page-follower-tray.ts`) plus **one extra
  `CDPTransport` implementation** whose backend is the host page reached over
  `postMessage`, instead of a WebSocket (CLI) or `chrome.debugger`
  (extension).
- **The driver is remote.** The embedded follower does not run the cone. A
  remote leader (cloud cone) issues CDP over the WebRTC tray data channel; the
  follower translates those CDP calls into operations on the host page via the
  host SDK. This is identical in topology to how the iOS follower and the
  browser tray follower already advertise and serve targets to the leader.
- **The host page is a single target.** The host page's top frame is the one
  and only CDP target Cherry exposes. Same-origin nested iframes are reached
  via `Runtime.evaluate` against the top frame, not as separate targets.
  Cross-origin frames are not driveable (browser security; no extension
  present).

## Motivation

Primary scenario: embed an AI agent directly inside Adobe products (AEM and
peers) so the agent can _operate the product's own UI_ — click, type, read the
DOM, take screenshots, run JS in the page — while the heavy agent runtime lives
in a cloud cone, not in the customer's tab. But the SDK is **generic**: any
site can embed Cherry. Nothing in the contract is Adobe-specific; Adobe is just
the first consumer.

Why an embedded follower rather than the extension: the extension requires
install and `chrome.debugger`, which is a non-starter for a product that wants
"drop a script tag, get an agent that can drive this page." Cherry trades the
extension's full cross-origin reach for a zero-install, single-page,
cooperative contract the host explicitly opts into.

## Goals

1. A host page embeds a SLICC follower with a small, documented SDK.
2. The host page's top frame is exposed to the remote cone as a normal CDP
   target — existing browser-automation skills work without modification.
3. Provisioning works from either a `joinUrl` **or** an IMS token (creating /
   resuming a cloud cone via the existing `/api/cloud/*` worker API).
4. Bidirectional application events: host → SLICC and SLICC → host, riding the
   existing tray data channel to the remote leader.
5. Strict origin pinning on every `postMessage` boundary, both directions.
6. Dual-mode parity is **not** required of the host page (the host is neither
   "CLI" nor "extension" SLICC) — but the SLICC build that runs _inside_ the
   Cherry iframe is the ordinary webapp build and must keep working in its
   normal floats.

## Non-Goals (v1)

- **Cross-origin frame driving.** Only the host top frame (+ same-origin
  reachable DOM) is driveable. Cross-origin iframes inside the host are opaque.
- **`Network.*` CDP domain.** No request interception / network emulation in
  v1. Skills that depend on `Network.enable` degrade (see translation matrix).
- **New cloudflare-worker endpoints.** Provisioning reuses `/api/cloud/*`
  verbatim. No worker route additions, so the routes-mirror rule is not
  triggered by this feature.
- **Multiple host-page targets.** Exactly one target per Cherry mount.
- **Pixel-perfect screenshots of cross-origin content.** `html2canvas` cannot
  read cross-origin-tainted pixels; screenshots are best-effort (see below).
- **Driving native/OS surfaces** the host page itself cannot reach.

## Architecture

### Topology

```
┌─────────────────────────── Host page (e.g. AEM, https://author.example.com) ──┐
│                                                                                │
│   @slicc/cherry SDK  ──postMessage(origin-pinned)──┐                           │
│   (host realm: DOM, router, html2canvas)           │                           │
│                                                     ▼                           │
│                        ┌──────── <iframe src=sliccy.ai/cherry> ───────────┐    │
│                        │  Ordinary SLICC webapp build, follower role        │  │
│                        │  CherryHostTransport (CDPTransport impl)           │  │
│                        │            │                                       │  │
│                        │            ▼  serves CDP for the host-page target  │  │
│                        │  FollowerTrayManager  ── WebRTC data channel ──────┼──┼──▶ Cloud cone (LEADER)
│                        └────────────────────────────────────────────────────┘  │   - runs the cone/orchestrator
│                                                                                │   - BrowserAPI drives the
└────────────────────────────────────────────────────────────────────────────┘     advertised host-page target
```

- **Host realm:** owns the DOM, the SPA router, screenshots. Speaks the inner
  Cherry envelope over `postMessage` to the iframe.
- **Cherry iframe:** the standard webapp, running as a tray follower. Hosts
  `CherryHostTransport` and advertises the host page as a CDP target to the
  leader. Holds no agent — it is a pass-through driver surface.
- **Leader (cloud cone):** the actual agent. Issues CDP over the data channel;
  receives host application events; emits SLICC application events.

### The key reuse: Cherry is `page-follower-tray` + a transport

`packages/webapp/src/ui/page-follower-tray.ts` already boots a follower with
auto-reconnect, wires a `FollowerSyncManager`, and **advertises local CDP
targets to the leader on an interval** (`refreshTargets` → `advertiseTargets`).
The leader's `BrowserAPI` then drives those targets via `cdp.request` /
`cdp.response` over the data channel (federated CDP).

Cherry changes exactly one thing: the _source_ of the advertised target and the
_CDP backend_. Instead of `browserAPI.listPages()` over a WebSocket/extension
transport, the follower's CDP transport is `CherryHostTransport`, which:

- advertises a single synthetic target (`cherry-host`) for the host top frame;
- serves CDP methods by translating them into host-SDK operations over
  `postMessage`;
- emits CDP events (frame navigated, console) it receives from the host.

Everything north of the transport — target advertisement, federation, the
leader's `BrowserAPI`, `playwright-cli` — is unchanged.

## New & changed components

### New package: `packages/cherry/` (`@slicc/cherry`)

The host-side SDK. New npm workspace. Ships a tiny, dependency-light ES module
(plus an optional `html2canvas` lazy import). Entry point `mountSlicc()`.

```ts
export interface MountSliccOptions {
  /** URL of the SLICC Cherry iframe (e.g. https://sliccy.ai/cherry). */
  iframeUrl: string;

  /** Provision via an existing tray join URL … */
  joinUrl?: string;
  /** … OR provision a cloud cone from an IMS token. Exactly one of
   *  joinUrl / auth is required. */
  auth?: {
    provider: 'ims';
    token: string; // IMS access token (Bearer)
    coneName?: string; // resume/create a named cone
    createIfMissing?: boolean; // create when named cone absent (default false)
  };

  /** Origins the SDK will accept postMessages from (the iframe origin).
   *  No wildcards. */
  allowOrigins: string[];

  /** Element to mount the iframe into. */
  container: HTMLElement;

  /** What the host lets the agent do to the page. */
  capabilities?: HostCapabilities;

  /** Host-side lifecycle + event hooks. */
  hooks?: HostHooks;
}

export interface HostCapabilities {
  /** Page.navigate handler — typically the SPA router's pushState.
   *  Omit to make Page.navigate an error. */
  navigate?: (url: string) => void | Promise<void>;
  /** Page.captureScreenshot strategy. Default 'html2canvas'. */
  screenshot?: 'html2canvas' | 'none';
  /** Target.createTarget behaviour. Default 'none' (error).
   *  'window-open' = courtesy window.open returning a non-driveable target. */
  createTarget?: 'window-open' | 'none';
}

export interface HostHooks {
  onAgentReady?: () => void;
  onAgentDisconnect?: (reason: string) => void;
  /** Gate sensitive CDP verbs (navigate, createTarget, …). Return false to
   *  deny. Default-allow when omitted. */
  onPermissionPrompt?: (verb: string, args: unknown) => boolean | Promise<boolean>;
  /** Receives SLICC → host application events. */
  onSliccEvent?: (name: string, data: unknown) => void;
}

export function mountSlicc(opts: MountSliccOptions): SliccHandle;

export interface SliccHandle {
  destroy(): void;
  isConnected(): boolean;
  /** host → SLICC application event. */
  send(name: string, data: unknown): void;
}
```

**Provisioning (inside `mountSlicc`, when `auth` is given):** the SDK
orchestrates the existing cloud API client-side — no new endpoints:

1. `GET /api/cloud/list` (Bearer = `auth.token`).
2. If `coneName` matches an existing cone:
   - `paused` → `POST /api/cloud/resume { sandboxId }`.
   - `running` → use its `joinUrl`.
3. If no match and `createIfMissing` → `POST /api/cloud/start { name: coneName }`.
4. Otherwise surface a "no cone" error to `onAgentDisconnect`.
5. Feed the resolved `joinUrl` to the iframe to start the follower.

This is exactly the `list → (resume | start)` flow recorded for the cloud API;
caps (`CONE_CAP_RUNNING/PAUSED`) and auth are enforced worker-side as today.
`E2B_API_KEY` never touches the browser.

### New: `packages/webapp/src/cdp/cherry-host-transport.ts`

A `CDPTransport` implementation (peer of `cdp-client.ts` / `debugger-client.ts`).
Runs inside the Cherry iframe. Bridges the leader's federated CDP calls to the
host SDK over the **inner Cherry envelope** (`postMessage`):

- Advertises a single target `cherry-host`.
- `send(method, params)` → encodes a `cdp.request` envelope to the host,
  awaits the matching `cdp.response`.
- Surfaces host-pushed `cdp.event` envelopes as CDP events to `BrowserAPI`.
- Enforces handshake/origin before any CDP flows.

### New: `packages/webapp/src/cdp/cherry-host-protocol.ts`

The **inner** iframe↔host envelope types (distinct from the tray wire
protocol). Pure types + guards, no logic:

- `handshake.hello` / `handshake.welcome` — version + capability negotiation,
  origin pinning.
- `cdp.request` / `cdp.response` / `cdp.event` — CDP transport.
- `permission.request` / `permission.response` — host gating of sensitive verbs.
- `host.event` / `slicc.event` — application messaging (see below; these are
  the _iframe-local_ leg; the cross-network leg uses the tray protocol).

### Changed: `packages/webapp/src/scoops/tray-sync-protocol.ts` (CANONICAL wire protocol)

Bidirectional application events must reach the **remote leader** (where the
cone lives), so they ride the existing WebRTC tray data channel — _not_ the
local follower's LickManager. Two new message kinds:

```ts
type FollowerToLeaderMessage =
  | /* …existing… */
  | { type: 'cherry.host_event';  name: string; data: unknown };

type LeaderToFollowerMessage =
  | /* …existing… */
  | { type: 'cherry.slicc_event'; name: string; data: unknown };
```

Flow:

- **host → SLICC:** host SDK `send()` → iframe `host.event` envelope →
  follower forwards as `cherry.host_event` over the data channel → leader
  routes it to the cone (via the leader's LickManager, where licks belong).
- **SLICC → host:** cone emits (see `cherry-emit` below) → leader sends
  `cherry.slicc_event` over the data channel → follower delivers as
  `slicc.event` envelope → host SDK `hooks.onSliccEvent`.

**Protocol mirror invariant (5-step checklist).** Because `tray-sync-protocol.ts`
is mirrored by the iOS Swift follower, both new kinds must be mirrored:

1. Add the TS union members (above).
2. Add encode/handle paths in `tray-leader-sync.ts` / `tray-follower-sync.ts`.
3. Mirror in `packages/ios-app/SliccFollower/Models/SyncProtocol.swift`.
4. Add a **no-op** `cherry.slicc_event` case to
   `AppState.handleDataChannelMessage` so it is not silently dropped via
   `.unknown`. iOS never originates `cherry.host_event`.
5. Update protocol tests on both sides.

### Changed: `packages/webapp/src/scoops/tray-leader-sync.ts`

The follower-`tab.open` federation branch (≈ line 1062–1094) currently assumes
the leader can satisfy a follower's `tab.open` by calling `Target.createTarget`
on its own browser. A Cherry follower advertises a target whose backend cannot
create new targets unless the host opted into `createTarget: 'window-open'`.
The leader must **skip / reject** target-creation against a cherry-mode target
that lacks `createTarget`, surfacing a clean "not driveable" error rather than
attempting it. Add the new `cherry.host_event` handling (route to LickManager)
and `cherry.slicc_event` emission here.

### New: `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`

`cherry-emit <name> <json>` — a leader-side shell command (and
`globalThis.__cherry.emit(name, data)` binding) the cone uses to push a SLICC →
host event. It enqueues a `cherry.slicc_event` on the data channel. Dual-mode:
in extension-float leaders it relays panel→offscreen as other UI-affecting
commands do; but the normal Cherry leader is a cloud cone (node-server hosted
float), so the primary path is the hosted leader.

### New: `/workspace/skills/cherry/SKILL.md`

Documents, for the cone, the host event vocabulary: how to read incoming
`cherry.host_event`s and how to emit with `cherry-emit`. Lives in the leader's
VFS (bundled via `packages/vfs-root/`).

## CDP translation matrix (host-SDK side)

What each CDP method becomes when `CherryHostTransport` forwards it to the host
realm:

| CDP method                                        | Host-side implementation                                                                         | Notes                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `Runtime.evaluate` / `Runtime.callFunctionOn`     | Run in host realm, JSON-serialize result                                                         | Reaches same-origin nested iframes via DOM traversal                         |
| `DOM.*` (getDocument, querySelector, boxModel, …) | Direct DOM, weak-mapped synthetic node IDs                                                       | NodeId↔Node via `WeakMap`; stable within a navigation                        |
| `Input.dispatchMouseEvent`                        | `elementFromPoint` + synthetic `MouseEvent`                                                      | Honest synthetic events; not OS-level                                        |
| `Input.dispatchKeyEvent`                          | Dispatch to `document.activeElement`                                                             |                                                                              |
| `Page.captureScreenshot`                          | Lazy `html2canvas`                                                                               | Best-effort; cross-origin-tainted regions blank. `screenshot:'none'` → error |
| `Page.navigate`                                   | `capabilities.navigate(url)` (SPA router)                                                        | Omitted capability → error. Gated by `onPermissionPrompt('navigate', …)`     |
| `Target.createTarget`                             | `createTarget:'window-open'` → `window.open`, return `{ targetId, driveable:false }`; else error | Courtesy window; the new window is **not** a driveable target                |
| `Accessibility.getFullAXTree`                     | Existing `injected-aria-snapshot.ts` evaluated in host realm                                     | Reuses current snapshot code                                                 |
| `Page.frameNavigated`, `Runtime.consoleAPICalled` | Host pushes as `cdp.event`                                                                       | Powers leader-side waits/logging                                             |
| `Network.*`                                       | **Not implemented (v1)**                                                                         | `Network.enable` no-ops; dependent skills degrade                            |

## Data flow (end-to-end, agent drives host page)

```
cone (leader) playwright-cli click
  → BrowserAPI.click → CDP Input.dispatchMouseEvent
  → leader sends cdp.request over tray data channel
  → Cherry follower CherryHostTransport receives it
  → postMessage cdp.request to host SDK (origin-pinned)
  → host SDK: onPermissionPrompt? → elementFromPoint + synthetic event
  → postMessage cdp.response back to iframe
  → follower returns cdp.response over data channel
  → leader BrowserAPI resolves; cone sees the result
```

## Security model

- **Origin pinning, both directions, no wildcards.** Host SDK accepts messages
  only from `allowOrigins` (the iframe origin); the iframe accepts messages
  only from the host origin it was handed at handshake. Every `postMessage`
  passes an explicit `targetOrigin`.
- **Handshake gate.** No CDP or event traffic flows before `handshake.hello` /
  `handshake.welcome` completes and pins origins + negotiates capabilities.
- **Capability opt-in.** The host page decides what the agent may do.
  `navigate`, `createTarget`, and `screenshot` are off unless the host wires
  them. Sensitive verbs pass through `onPermissionPrompt`.
- **Single target, single origin.** Cherry cannot reach cross-origin frames;
  the browser's same-origin policy is the backstop, not Cherry's good behaviour.
- **No secrets in the browser.** Provisioning uses the IMS bearer the host
  already holds; `E2B_API_KEY` stays worker-only. The cone runs remotely.
- **Tray transport unchanged.** WebRTC + DTLS as today; Cherry adds no new
  network trust boundary beyond the host↔iframe `postMessage` channel.

## Testing strategy

- **`cherry-host-protocol.ts`** — pure type guards / envelope encode-decode
  unit tests (`packages/webapp/tests/cdp/cherry-host-protocol.test.ts`).
- **`CherryHostTransport`** — unit tests with a fake host (`MessagePort` /
  stubbed `postMessage`) asserting: handshake gating, origin rejection,
  request/response correlation, event delivery, single-target advertisement.
- **CDP translation** — per-method tests against a jsdom host realm: evaluate,
  DOM query, synthetic input, navigate-via-router, createTarget error vs
  window-open, screenshot-none error.
- **Tray protocol** — extend existing `tray-sync-protocol` tests for the two
  new kinds; verify leader↔follower round-trip of `cherry.host_event` /
  `cherry.slicc_event`. Mirror tests in the iOS Swift suite (no-op handler does
  not drop to `.unknown`).
- **`@slicc/cherry` SDK** — provisioning orchestration tests with a mocked
  `/api/cloud/*` (list→resume, list→start, no-cone error), and mount/destroy
  lifecycle with a stubbed iframe.
- **Coverage floors** apply per package (webapp 50/40, etc.); new `packages/cherry`
  gets its own floor wired into CI alongside its first tests.

## Docs impact (part of implementation, not follow-up)

- **Root `CLAUDE.md`** — add Cherry to the Floats vocabulary and a `packages/cherry/`
  module-map row.
- **`packages/webapp/CLAUDE.md`** — note `CherryHostTransport` as a third
  `CDPTransport` implementation; the two new tray-protocol message kinds.
- **`packages/cherry/CLAUDE.md`** (new) — SDK contract, provisioning flow,
  security model.
- **`packages/cloudflare-worker/CLAUDE.md`** — note that Cherry consumes the
  existing `/api/cloud/*` API (no new routes).
- **`packages/ios-app/CLAUDE.md`** — note the no-op `cherry.slicc_event` mirror.
- **`docs/architecture.md`** — Cherry topology diagram + the single-host-target
  CDP contract.
- **`README.md`** — user-facing "embed SLICC in your page" blurb.
- **`/workspace/skills/cherry/SKILL.md`** — cone-facing host-event vocabulary.

## Open questions (to settle during planning)

1. Exact `cherry-host` synthetic target shape — what `targetInfo` fields the
   leader's `BrowserAPI` minimally needs to treat it as a normal page target.
2. NodeId lifecycle across SPA soft-navigations (flush the WeakMap on
   `frameNavigated`?).
3. Whether `cherry-emit` should also accept stdin JSON for large payloads.
4. `html2canvas` bundle cost in the webapp build — lazy-import only when a
   screenshot is first requested.

## Out of scope / explicitly deferred

- Cross-origin frame driving (needs the extension).
- `Network.*` interception/emulation.
- Multiple targets per mount.
- New worker endpoints.
- A non-IMS provider in `auth` (the shape allows future providers; only `ims`
  ships in v1).
