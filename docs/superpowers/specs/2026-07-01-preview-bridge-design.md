# Driveable Preview Bridge — design

**Status:** draft for review
**Date:** 2026-07-01
**Branch:** `feat/preview-bridge`
**Lineage:** revives the Phase-2 `serve --bridge` channel designed in PR #1118 (closed) and deferred by PR #1160 (merged, worker-relayed preview on `sliccy.now`/`sliccy.dev`).

---

## 1. Summary

`serve --bridge <dir>` turns an opted-in preview into a **live remote-control surface**. The
worker injects a small bootstrap into the served HTML; **any** browser that opens the
`https://<token>.sliccy.now/…` URL auto-connects back to the leader and becomes a
**driveable synthetic-CDP target**. The leader (cone) can `navigate` / `Runtime.evaluate` /
DOM-read / `Input`-click / screenshot the tab, is notified when tabs connect, and weaves
events in both directions using machinery that already exists (webhooks + `Runtime.evaluate`).

This is Cherry's model relocated into the preview page's **own origin** and re-backhauled
over the **existing preview worker-WS relay** instead of WebRTC. Plain `serve` (no `--bridge`)
is byte-for-byte unchanged.

## 2. Goals / non-goals

**Goals**

- `serve --bridge <dir>` produces a preview URL whose every visitor tab becomes a live,
  leader-driveable target — automatically, with no in-page prompt.
- Full drive parity with Cherry: `Page.navigate`, `Runtime.evaluate`, `DOM.*` (read/query),
  `Input.*` (click/type), `Page.captureScreenshot` (html2canvas), `Target.createTarget`
  (open-url). `Network.*` always rejected.
- The agent is notified when a tab connects, so it can weave in on open, and can enumerate
  and drive many concurrent tabs.
- Idle bridged tabs cost effectively nothing: the relay uses the Cloudflare **WebSocket
  Hibernation API** end-to-end.
- Works uniformly whichever float is the leader (standalone / extension / Electron / cloud
  hosted-leader), because the relay rides the controller WS that every serving leader holds.
- Zero new lick-delivery machinery for page↔cone events (reuse webhooks + `Runtime.evaluate`).

**Non-goals**

- No consent prompt / opt-in for visitors (deliberate product choice: automatic).
- No `Network.*` domain on a preview target (identical to Cherry; can never serve a teleport).
- Driving a bridged preview that a native follower (iOS `SliccFollower`, TS tray follower)
  opened in its own webview is best-effort, out of scope for v1.
- Provisioning/creating cones from the preview page: out of scope (as with Cherry).

## 3. Product surface

- `serve --bridge <dir>` — mint a driveable preview. Injects the bootstrap, auto-provisions a
  webhook, enables the WS-relay target, and (as today) forces `allowLive` (no CDN cache).
- `serve --no-bridge <dir>` — force a plain read-only preview; wins over everything, including
  the Cherry-follower default.
- Cherry-attached followers keep defaulting **live/no-cache** on (existing
  `effectiveAllowLive = !noBridge && (bridge || hasCherryFollower)`) but **not driveable** —
  driveability requires an explicit `serve --bridge`. Decoupling these is a correctness
  requirement (see `PreviewRecord.bridge`, §3): otherwise a plain `serve` with a Cherry
  follower connected would silently expose arbitrary visitor eval.
- `--bridge` optionally takes `--quiet` to suppress connect/disconnect licks for high-traffic
  URLs (default: notify, rate-limited).
- New `serve --bridge --max-tabs <n>` (default 20) caps concurrent bridged tabs per preview.

A bridged preview is both no-cache and remotely driveable, but the two are computed
**independently** so the driveable bit can never be turned on implicitly.

**`PreviewRecord.bridge` (new persisted field) — the opt-in guarantee.** The mint path today
computes `effectiveAllowLive = !noBridge && (bridge || hasCherryFollower)` for
`PreviewRecord.allowLive` (caching). Driveability must **not** inherit that — a plain `serve`
with a Cherry follower attached sets `allowLive` yet must stay read-only
(`setup-standalone-panel-rpc.ts:88`). So `bridge` is a **distinct, explicit-only** boolean:
`bridge = !noBridge && bridgeFlag` (the literal `--bridge`), decoupled from `hasCherryFollower`.
It is persisted separately on the `PreviewRecord` and returned from
`/internal/preview/resolve`. The worker keys HTML injection **and** bridge-WS acceptance
strictly on `bridge`; `allowLive` keeps meaning "no CDN cache" only. **Only an explicit
`serve --bridge` makes a preview driveable** — this is the security opt-in gate.

The record gains two more bridge fields (mint body + record + resolve payload all extended):
`maxTabs` (the DO enforces the per-preview cap at bridge-upgrade time) and `webhookId` (the
auto-provisioned webhook the DO stamps onto page→cone emits, §6). The webhook lifecycle lives in
the **worker realm** (`serve` creates it before mint and deletes it on `serve --stop`, recovering
the id from the stop route's response — §7); the DO stores `webhookId` on the record so `emit`
can stamp it. Separately, the leader keeps a small **page-side** `previewToken → { url, title,
quiet }` registry (populated at mint) purely so bridge-target surfacing has a URL/title and the
connect lick can honor `quiet` — it holds **no** `webhookId`. Current mint / record / resolve
carry only `allowLive` + path/cache data (`session-tray-preview.ts:175,336`, `shared.ts:63`,
`preview-worker.ts:39`), so each must be extended for `bridge` / `maxTabs` / `webhookId`, and the
mint response must additionally return `previewToken`.

## 4. Architecture

### 4.1 Data flow (Route C — worker-WS relay)

```
visitor tab  https://<token>.sliccy.now/…              LEADER (cone, any float)
  [preview-bridge.js]  (injected into <head>)           page realm: LeaderTrayManager
   │ WSS  wss://<token>.sliccy.now/__slicc/bridge        owns the controller WS
   │ runs createCdpHostHandler on its OWN document       │
   └──────────►  preview-worker.ts ──► TRAY_HUB DO  ◄──── controller WS (existing)
                 (forwards Upgrade)    SessionTrayDO:      │  PreviewBridgeCdpTransport
                                       relays bridge.*     │  (CherryHostTransport with a
                                       between bridge WS   │   WS backhaul, keyed by connId)
                                       and controller WS   │
                                                           ▼
                                             kernel-worker BrowserAPI
                                             drives via existing
                                             panel-RPC → remote-cdp-page-bridge
```

CDP request path: the cone runs `playwright-cli` / `open` against target id
`preview:<token>:<connId>` → `BrowserAPI.attachToPage()` detects the remote scheme →
`TrayTargetProvider.createRemoteTransport()` builds a `PreviewBridgeCdpTransport` (via the
existing panel-RPC page bridge) → the transport synthesizes the CDP session lifecycle locally
and forwards the "real" methods as `bridge.cdp.request` over the controller WS → DO relays to
the correct bridge WS by `connId` → the visitor bootstrap runs `createCdpHostHandler` against
its own `document` → `bridge.cdp.response` flows back the same way.

### 4.2 Why this transport (recap of the decision)

Route C (worker-WS relay) was chosen over Route W (WebRTC tray follower) because: (a) it
needs no WebRTC/TURN from arbitrary anonymous visitors on arbitrary networks (TURN has
per-GB cost and fails on UDP-blocked networks); (b) it is a direct extension of #1160's own
relay pattern; (c) for cloud-cone leaders the WebRTC "peer-to-peer" win evaporates anyway
(traffic TURN-relays through Cloudflare); (d) the bootstrap stays light (no peer-connection
code). Cost: a new DO WS role + relay message types + a leader-side CDP-over-controller-WS
transport and target surfacing — all built on existing patterns.

## 5. Components

### 5.1 Worker (`packages/cloudflare-worker/`)

**`preview-worker.ts` (existing entry, routes `*.sliccy.now/*` + `*.sliccy.dev/*` in
`wrangler-preview.jsonc`)** today resolves the preview token on **every** request before
mapping it to a VFS path (`preview-worker.ts:20-47`). The three new `/__slicc/*` branches must
be handled **before** that resolve, or they'd be treated as VFS file paths:

1. `GET /__slicc/preview-bridge.js` → serve the embedded, bundled bootstrap
   (`content-type: application/javascript; charset=utf-8`, immutable cache), **same-origin**. It
   is a single **classic IIFE** with `html2canvas-pro` bundled in (no code-splitting, no
   `type="module"`) — a plain `<script src>` works and screenshots run from the same bundle.
2. `<ws|wss>://…/__slicc/bridge` (Upgrade: websocket) → forward to the DO stub
   (`stub.fetch(request)`), which performs the hibernatable accept.
3. `POST /__slicc/emit` (**same-origin**, fire-and-forget beacon target for `window.slicc.emit`)
   → forward to a DO-internal `/internal/preview/emit` route, which looks up the record's
   `webhookId` and sends the **full** existing envelope
   `sendToLeader({ type:'webhook.event', webhookId, headers: {}, body, timestamp })` — matching
   `handleWebhook`'s shape (`session-tray.ts:648`) so the `WorkerToLeaderControlMessage` type and
   the leader's `LickManager.handleWebhookEvent` path are satisfied → a normal `webhook` lick (§6).

The main hub (`index.ts`) also dispatches preview subdomains early (`index.ts:347`); dev/test
paths that route preview hosts through the hub must apply the same pre-resolve `/__slicc/*`
branch there for parity.

**HTML injection** — Cloudflare **`HTMLRewriter`** in `preview-worker.ts`, only when
`PreviewRecord.bridge` is true **and** the response `content-type` is `text/html`. Inject into
`<head>`:

```html
<script
  src="/__slicc/preview-bridge.js"
  data-slicc-token="<previewToken>"
  data-slicc-ws="wss://<host>/__slicc/bridge"
></script>
```

`HTMLRewriter` streams (no full-body buffer). Skipped for non-HTML and non-bridged previews
(byte-transparent, unchanged). The `data-slicc-ws` scheme is **derived from the request**:
`wss://` for prod/staging (`sliccy.now`/`sliccy.dev`, https), `ws://` for the local
`http://<token>.localhost:8787` dev host (`preview-url.ts:50`). The preview CSP is
`default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'none'`
(`session-tray-preview.ts:295`) — there is no separate `script-src`, so `default-src` governs
scripts: a same-origin `<script src="/__slicc/…">` and inline script are both permitted. There
is also no `connect-src` today, so `default-src 'self'` would govern outbound connections — but
**`'self'` is not cross-browser reliable for `ws`/`wss` schemes** (MDN `connect-src`). So for
**bridged** responses the preview worker augments the CSP header (it is already rewriting those
responses for injection) with an explicit `connect-src 'self' <ws|wss>://<host>` (scheme matched
to the request — `wss://` for prod/staging, `ws://` for local `http://…localhost:8787`) — enough
for the same-origin bridge WS (`<ws|wss>://<token>.<preview-base>/__slicc/bridge`) and the
same-origin `POST /__slicc/emit`, while a cross-origin beacon to the hub `/webhook/*` stays
blocked (why
`slicc.emit` uses the same-origin relay, §6). Non-bridged previews keep the current CSP
unchanged.
**[D1 — decided]** injection lives in the worker (not the leader): the worker already owns
content-type sniffing, caching, CSP, and now bridge-awareness; the leader's VFS read stays
byte-transparent.

**DO abstraction changes (required — the local seams don't model this yet).** The real
Cloudflare runtime supports tags, attachments, and auto-response, but the repo's abstraction
and fakes do not: `DurableObjectStateLike` (`shared.ts:36`) lacks `getTags` /
`setWebSocketAutoResponse`; `TrayWebSocketLike` lacks `serializeAttachment` /
`deserializeAttachment`; the fake DO state in `tests/index.test.ts:35` only stores tags
internally. This feature must first extend those seams (and the fake) before it can route by
role.

**`SessionTrayDurableObject` (`session-tray.ts`) — role routing must be reworked, not just
extended.** Today `webSocketMessage()` assigns **every** accepted socket to `leaderSocket` and
routes all messages to `handleLeaderMessage()` (`session-tray.ts:201`); recovery only uses
`getWebSockets('leader')` (`session-tray.ts:237`). Adding a bridge role therefore means:

- New pre-resolve route in `fetch()`: `/__slicc/bridge` Upgrade → `handleBridgeWebSocket(url)`.
  Parse the preview token from host, resolve the `PreviewRecord`, **reject 4xx if `!bridge`**
  or if the per-preview `--max-tabs` cap is reached (`getWebSockets(BRIDGE_WS_TAG)` filtered by
  the `tok:` tag), mint a `connId`, then:
  ```ts
  this.state.acceptWebSocket(server, [BRIDGE_WS_TAG, `tok:${previewToken}`, `conn:${connId}`]);
  server.serializeAttachment({ connId, previewToken, origin, userAgent, connectedAt });
  ```
  then send the tab `{ t:'welcome', connId }` and notify the leader `bridge.connected`. The
  preview token comes from the Host (subdomain) at upgrade time — same extraction as the HTTP
  preview path — so there is no `hello` frame to validate.
- `webSocketMessage(ws, msg)` **branches on role first** via `getTags(ws)` (it can no longer
  assume every socket is the leader): a `BRIDGE_WS_TAG` socket routes to bridge handling
  (`{ t:'cdp.res' | 'cdp.evt' }` → `bridge.cdp.response` / `bridge.cdp.event` to the leader,
  stamped with the socket's `connId` from `deserializeAttachment`); the `LEADER_WS_TAG` socket
  keeps `handleLeaderMessage()`, now also handling `bridge.cdp.request{connId,…}` → find the
  bridge WS whose attachment `connId` matches (via `getWebSockets(BRIDGE_WS_TAG)`) → forward
  `{ t:'cdp.req', … }`.
- `webSocketClose`/`webSocketError` on a bridge socket → `bridge.disconnected{connId}` to the
  leader. `restoreLeaderSocket()` stays keyed on `LEADER_WS_TAG` (bridge sockets never
  populate `leaderSocket`).

**Hibernation strategy (the cost requirement).**

- Bridge sockets use `state.acceptWebSocket` (never `addEventListener('message')`), so the DO
  is evicted from memory between messages and **not billed for idle connection time**.
- All per-connection state (`connId`, `previewToken`, origin, UA, connectedAt) lives in
  `serializeAttachment` (never an in-memory map); routing after a wake reconstructs from
  `getWebSockets(BRIDGE_WS_TAG)` + `deserializeAttachment()` — mirrors the existing
  `getWebSockets(LEADER_WS_TAG)` recovery in `restoreLeaderSocket()`.
- Keepalive **must** use `setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))`
  so the runtime answers matching text pings **without waking** the object. Deliberate contrast:
  the existing leader controller WS sends JSON pings every 30s that the DO _does_ wake to handle
  (`tray-leader.ts:621`, `session-tray.ts:755`), so it is **not** idle-zero today; this feature
  does not change that socket. Bridge sockets achieve idle-zero via the auto-response pair.
- In-flight CDP round-trips keep the DO awake for their (short) duration, so no assembler/timeout
  map needs to persist across hibernation — same as the existing `preview.request`
  `PreviewAssembler`.

**Route registration.** The new paths are **preview-worker** routes (`wrangler-preview.jsonc`,
`*.sliccy.now/*` + `*.sliccy.dev/*`), **not** hub API routes — so the hub routes-mirror rule
(`src/index.ts` array + `tests/index.test.ts` + `tests/deployed.test.ts`, which list hub routes
at `index.ts:417` / `index.test.ts:1196`) does **not** automatically cover them. Add `/__slicc/*`
to the hub route index **only** if the hub also serves preview subdomains in dev/test (it
dispatches them early at `index.ts:347`) — keep the two consistent. The new DO-internal route
and the `bridge.*` message set get their own unit tests.

### 5.2 Leader (`packages/webapp/src/`)

- **`PreviewBridgeCdpTransport implements CDPTransport`** (`packages/webapp/src/cdp/`): a
  sibling of `CherryHostTransport`. It **is** `CherryHostTransport` with a different backhaul —
  same synthesized session lifecycle (`Target.getTargets`/`attachToTarget`, `*.enable`,
  `Page.getFrameTree`, `Runtime.createIsolatedWorld`, and the synthetic
  `Page.frameNavigated`+`Page.loadEventFired` emitted after a `Page.navigate` resolves so
  `BrowserAPI.navigate()` doesn't hang) — but instead of posting `cdp.request` over
  postMessage, it posts `bridge.cdp.request{connId,…}` over the controller WS and resolves on
  `bridge.cdp.response`. **Refactor:** extract the synthetic-lifecycle + forward skeleton
  from `CherryHostTransport` into a shared base (`SyntheticCdpTransport`) that both subclass;
  only the backhaul (`sendToCounterpart` / event pump) differs.
- **Control-message surfaces are mirrored — update all three.** Add the variants to the
  worker's `tray-signaling.ts` (`WorkerToLeaderControlMessage`: `bridge.connected`,
  `bridge.disconnected`, `bridge.cdp.response`, `bridge.cdp.event`; `LeaderToWorkerControlMessage`:
  `bridge.cdp.request`) **and** its webapp mirror `tray-types.ts:97` (structurally identical).
  The controller WS is owned by **`LeaderTrayManager`** (`tray-leader.ts`), not `LeaderSyncManager`:
  inbound frames dispatch through `page-leader-tray.ts` `onControlMessage` (`:226`, today handling
  `webhook.event` / `preview.request` / `preview.revoked`), and outbound goes through
  `LeaderTrayManager.sendControlMessage` (`tray-leader.ts:477`). Add `bridge.*` cases to
  `onControlMessage` that hand off to the bridge coordinator; send `bridge.cdp.request` via
  `sendControlMessage`.
- **Bridge-target surfacing (`tray-leader-sync.ts`).** A new `'preview'` target `kind` must be
  added to **all three** kind unions — `RemoteTargetInfo` **and** `TrayTargetEntry`
  (`tray-sync-protocol.ts:155,241`) and `PageInfo` (`cdp/types.ts:60`), currently
  `'browser' | 'cherry'`. Preview conns are **not** tray followers, so they are absent from
  `runtimeToBootstrap`, and `getConnectedEntries()` (`:917`) drops non-leader runtimes today —
  so it needs a parallel path that also emits the tracked bridge conns as targets
  (`id = preview:<previewToken>:<connId>`, `kind:'preview'`, `url` from the served entry) for
  `list-remote-targets` / `playwright-cli`. `PageInfo` already carries `kind`/`capabilities`
  (`cdp/types.ts:54`) but has **no** separate visitor-label field, and the `list-remote-targets`
  panel-RPC surface returns only `targetId`/`title`/`url` (`panel-rpc-handlers.ts:911`) — so the
  human label (visitor origin + connect time) rides **in `title`** (e.g. `Preview · <origin> ·
<time>`) rather than a new field. Exclude `'preview'` from **both** teleport paths, fail-closed:
  auto-selection in `selectTeleportPool()` (`tray-leader-sync.ts`, cherry-only today) **and** the
  explicit `teleport --runtime` guard (`playwright/handlers/teleport.ts:80`, which currently
  rejects only cherry) — no `Network.*`, so a preview target can never serve a teleport. The
  manager tracks the per-conn `PreviewBridgeCdpTransport`s, but the actual WS send/recv rides
  `LeaderTrayManager`'s seam above.
- **Target routing / page bridge — mind the two-colon id.** `BrowserAPI.attachToPage` splits on
  the **first** colon via `indexOf(':')` (`browser-api.ts:402`), so `preview:<token>:<connId>`
  parses as `runtimeId='preview'`, `localTargetId='<token>:<connId>'` — fine, but the current
  leader remote path then does `runtimeToBootstrap.get('preview')` and fails because no follower
  owns that runtime (`tray-leader-sync.ts:929`). So the leader must **special-case
  `runtimeId === 'preview'`**: `remote-cdp-page-bridge.ts` + `panel-rpc-tray-provider.ts` route
  it to a `PreviewBridgeCdpTransport` (parsing `localTargetId` as `<token>:<connId>`) instead of
  the follower `runtimeToBootstrap` map. **Do not** introduce `split(':', 2)` anywhere — it
  would corrupt the id.
- **Connect lifecycle lick [D2 — decided].** A small new `'preview'` `LickEvent.type`, used
  **only** for lifecycle (`connected` / `disconnected`), leader-emitted when
  `bridge.connected`/`bridge.disconnected` arrives — analogous to `session-reload`
  (leader-derived, not a page→cone relay, so it does **not** reintroduce the bespoke event
  channel that was rightly rejected). Fields: `previewToken`, `connId`, visitor `origin`,
  `userAgent`, `connectedAt`. Rate-limited; suppressed by `serve --bridge --quiet`. Adding the
  type touches **all** its render plumbing, not just the union: the `LickEvent['type']` union
  (`lick-manager.ts:37`), `EXTERNAL_LICK_CHANNELS` + the channel label map
  (`lick-formatting.ts:29`), a `formatLickEventForCone` branch, and the
  `resolveLickEventName`/`resolveLickEventId` fallbacks in `host.ts` (`:194`) so the channel
  name/id are not `undefined`. Page-emitted events are **not** this lick — they are webhooks (§6).

### 5.3 Visitor bootstrap (`preview-bridge.js`)

Dependency-light, **must not import `@slicc/webapp`** (same rule as the Cherry SDK). It reuses
Cherry's **`createCdpHostHandler`** (`packages/cherry/src/cdp-host-handlers.ts`, already
webapp-import-free) run against its **own** `document` (same-origin — no postMessage hop, no
capability-escape gating needed; full-drive means all capabilities are `true`). The bootstrap:

1. Reads config from its own `<script data-slicc-*>` tag.
2. Opens the injected `data-slicc-ws` URL (`<ws|wss>://<host>/__slicc/bridge`, scheme
   request-derived) — the preview token is in the Host (subdomain), so the DO derives it at
   upgrade time (no `hello` frame) and sends `{ t:'welcome', connId }` right after accept.
3. On `{ t:'cdp.req', id, method, params, sessionId }` → runs `createCdpHostHandler` →
   replies `{ t:'cdp.res', id, result|error }`. `createCdpHostHandler` does a bare
   `await import('html2canvas-pro')` (`cdp-host-handlers.ts:133`); the bootstrap bundle resolves
   that at build time and **inlines** it into the single classic IIFE (no dynamic-import chunk,
   no `type="module"`), so `Page.captureScreenshot` works from the same script under the `'self'`
   CSP with no CDN. (The cost is a heavier one-time bundle on bridged pages only; acceptable for
   an opt-in surface.)
4. Exposes `window.slicc`:
   - `slicc.emit(name, detail)` → `navigator.sendBeacon('/__slicc/emit', JSON.stringify({name, detail}))`
     — **same-origin** (covered by `default-src 'self'`; a cross-origin beacon to the hub
     `/webhook/*` would be blocked by the preview CSP's `connect-src` fallback regardless of
     CORS). The preview worker relays it to the DO → leader as a `webhook.event` stamped with the
     preview's `webhookId`, so it lands as a normal webhook lick.
   - `slicc.on(name, cb)` → `addEventListener(name, e => cb(e.detail))` sugar over the
     `CustomEvent`s the agent dispatches via `Runtime.evaluate`.
5. Sends `ping` on an interval (answered by the DO's auto-response while hibernated).

**Packaging [D3 — decided].** Build `preview-bridge.js` as a single **classic IIFE**
(`format: iife`, no code-splitting) that reuses Cherry's `createCdpHostHandler` and bundles
`html2canvas-pro` inline. Embed the emitted bytes into the preview worker at build time (text
import) and serve them at `/__slicc/preview-bridge.js`, same-origin under the `'self'` CSP —
no CDN, no ASSETS binding, no dynamic-import chunk, no `type="module"`. The bundle must not
import `@slicc/webapp` (Cherry's rule); it lives alongside the Cherry SDK build so the shared
handler stays the single source of truth. The embedded bytes live in the worker **script**
(not a static asset), so the relevant limit is the Workers script-size limit, not the 25 MiB
asset cap.

## 6. Event model (no new lick machinery)

- **page → cone**: `window.slicc.emit()` = a **same-origin** `sendBeacon('/__slicc/emit', …)`
  (CSP-safe); the preview worker forwards it to the DO, which stamps the preview's `webhookId`
  and sends `webhook.event` to the leader → a normal `webhook` lick with full filter/scoop
  routing. Auto-provisioning wires into `serve`: the shell `webhook create` requires `--scoop`
  (`webhook-command.ts:182`), so the mint path calls
  `LickManager.createWebhook(name, /* scoop */ undefined)` **programmatically**
  (`lick-manager.ts:237`) for a cone-targeted webhook and threads the `webhookId` into the mint
  opts + record (`serve-command.ts:269` currently passes only preview-mint opts, so it must be
  extended). Truly external callers (GitHub, etc.) still use the normal hub `/webhook/*` URL —
  unaffected by the preview page CSP.
- **cone → page**: the agent `Runtime.evaluate`s `window.dispatchEvent(new CustomEvent(...))`;
  the page listens via `window.slicc.on()`.
- **webhook → weave-in**: an external (or `slicc.emit`) webhook lick reaches the cone; the
  agent reacts and drives the tab. Nothing new.

## 7. Security threat model

- **`--bridge` is the gate.** Opening a bridged preview URL means **joining a live
  remote-control session**, not viewing a static preview. `--bridge` is opt-in per serve and is
  computed from the explicit flag only — never inherited from `allowLive`/Cherry (§3). Docs
  (README, shell-reference, serve skill) must state the capability in bold.
- **What the leader can actually do (state it honestly).** Within the `<token>.sliccy.now`
  origin the leader can `Runtime.evaluate` arbitrary JS, read/write the DOM, read
  `localStorage`/`sessionStorage`, read cookies scoped to that host, dispatch clicks/keys
  (`Input`), navigate, and open URLs — Cherry's full handler (`cdp-host-handlers.ts:52`). On a
  shared URL that means the agent can observe and manipulate whatever a visitor does on that
  page. This is a real capability, not "harmless self-XSS."
- **Origin confinement + the cross-subdomain cookie residual risk (accepted).** Same-origin
  policy prevents reading _other_ sites' cookies/storage/tabs, and each preview's unique
  `<token>.sliccy.now` subdomain already isolates **host-only** cookies (the default) per
  preview. The residual gap: a cookie explicitly set with `Domain=.sliccy.now` (`/.sliccy.dev`)
  is readable across **every** preview subdomain, so one bridged preview could read such a
  cookie set by another. This **cannot be enforced by a response-header test** — the served page
  runs arbitrary JS and the bridge allows `Runtime.evaluate`, so `document.cookie = "…;
Domain=sliccy.now"` can happen at runtime. **Decision (accept + document):** the exposure is
  narrow (host-only cookies already isolated; only apps that _deliberately_ set a parent-domain
  cookie are affected, and none do today), `--bridge` is opt-in, and the agent authors the
  served content. Documented as a known residual risk; not otherwise mitigated (PSL isolation of
  `sliccy.now`/`sliccy.dev` was considered and declined for now).
- **Revocation.** Killing a preview must (a) close all live bridge sockets for that token (DO
  `getWebSockets(BRIDGE_WS_TAG)` filtered by `tok:`), (b) reject new `/__slicc/bridge` upgrades
  for it, (c) emit `bridge.disconnected` so the leader drops the targets, and (d) delete the
  auto-provisioned webhook. **Webhook-deletion path:** the worker stop route returns the record's
  `webhookId` in its response, and `serve --stop` (worker realm) calls `deleteWebhook(webhookId)`
  via the lick surface (`lick-manager.ts:259`). The only _worker-initiated_ revoke is tray
  expiry — at which point the leader (and its `LickManager` + webhooks) is already gone, so there
  is no live webhook to leak. So a revoked token never leaves a driveable tab connected, nor a
  live webhook behind a live leader.
- **Visibility.** Connect/disconnect licks surface every attachment in the cone transcript
  (rate-limited; `--quiet` to mute); the bootstrap may render an optional subtle "live" badge
  (not a prompt — respects the automatic choice).
- **DoS** — `--max-tabs` cap per preview; hibernation bounds idle cost; the DO rejects bridge
  upgrades when `!bridge` or over cap.
- **No `Network.*`** — a preview target can never proxy the visitor's network or serve a
  cookie/storage teleport (identical to Cherry; excluded from teleport pools by `kind`).
- **Secrets** — preview content is read from the VFS exactly as today; the bridge adds no new
  secret-exfiltration path (the agent already authored the content). No change to the secrets
  pipeline.

## 8. Cross-float parity

Route C rides the controller WS, which every leader float holds while a preview is being
served (standalone, extension, Electron, cloud hosted-leader). The `PreviewBridgeCdpTransport`
lives page-side where `LeaderTrayManager` owns that WS (`sendControlMessage` /
`onControlMessage`), and the kernel-worker `BrowserAPI`
reaches it through the existing panel-RPC → `remote-cdp-page-bridge` path — the same wiring
used for WebRTC federated targets. No float-specific code. iOS/TS followers that _open_ a
bridged preview in their own webview: the bootstrap would run, but driving it is best-effort
and out of scope for v1 (documented "N/A" for the parity matrix, with a follow-up note).

## 9. Reuse vs. build

**Reuse:** the preview relay pipe + `PreviewRecord` + controller WS + DO hibernation pattern;
the `webhook` command + `LickManager.createWebhook` + `/webhook/*` forwarding + all lick
routing; federated-CDP target routing (`attachToPage` composite key), `remote-cdp-page-bridge`,
`panel-rpc-tray-provider`; Cherry's `createCdpHostHandler` and `CherryHostTransport`
synthetic-lifecycle logic; the `--bridge`/`--no-bridge` flag plumbing (driveability computed as
a **separate explicit** `bridge` bit, not `effectiveAllowLive`).

**Build:** extend the DO seams (`DurableObjectStateLike.getTags` / `setWebSocketAutoResponse`,
`TrayWebSocketLike.serializeAttachment` / `deserializeAttachment`) + the test fake; the DO
bridge WS role incl. **reworked `webSocketMessage` role routing** + hibernation attachment
routing + **revocation** (DO closes bridge sockets on stop and its stop response returns the
record's `webhookId`; `serve --stop` deletes the webhook worker-side — §7); the
`/__slicc/bridge` + `/__slicc/preview-bridge.js` + `/__slicc/emit` routes (branched
**pre-resolve**) on **both** the preview worker and the hub preview path (`preview-handler.ts`,
for staging/dev parity) via a shared helper + the DO-internal `/internal/preview/emit` route;
`HTMLRewriter` injection; the single-IIFE `preview-bridge.js` bootstrap (html2canvas bundled) + embed;
`PreviewBridgeCdpTransport` + the `SyntheticCdpTransport` refactor of `CherryHostTransport`;
`runtimeId === 'preview'` handling in the page bridge/provider; bridge-target surfacing in
`LeaderSyncManager`; the mirrored `bridge.*` control messages (`tray-signaling.ts` +
`tray-types.ts`) + `page-leader-tray.ts` dispatch; the `'preview'` lifecycle lick + its render
plumbing; `serve` flag parsing + programmatic webhook auto-provision; docs + tests.

## 10. Testing

- **Worker/DO (vitest, extended `FakeDurableObjectState` modeling tags + attachments +
  auto-response):** bridge upgrade accept + cap rejection + `!bridge` rejection; **role routing**
  (a `BRIDGE_WS_TAG` socket is not treated as the leader in `webSocketMessage`); hibernation
  attachment round-trip (`serializeAttachment`/`getWebSockets`/`deserializeAttachment` recover a
  conn after a simulated eviction); relay of `bridge.cdp.request` → correct bridge WS by
  `connId`; relay of `cdp.res`/`cdp.evt` → leader; `bridge.disconnected` on close; **revocation**
  closes bridge sockets + rejects reconnect; `HTMLRewriter` injection only for `text/html` +
  bridged, skipped otherwise; auto-response ping pair set.
- **No test for the cross-subdomain cookie risk** — it's an accepted, documented residual risk
  (§7), not test-enforceable (runtime `document.cookie` bypasses any response-header check).
- **Leader (vitest):** `PreviewBridgeCdpTransport` synthesizes lifecycle + forwards real
  methods + emits synthetic nav events; `SyntheticCdpTransport` shared-base parity with
  `CherryHostTransport`; `preview:` scheme routing in `BrowserAPI.attachToPage`; bridge-target
  listing; `'preview'` lifecycle lick emit + rate-limit + `--quiet`.
- **Bootstrap (vitest jsdom):** `createCdpHostHandler` against a jsdom `document`;
  `window.slicc.emit` → beacon URL; `slicc.on` → CustomEvent; `welcome` frame received (token
  derived from Host at upgrade — no `hello`); ping.
- **`serve` command:** `--bridge` provisions a webhook + marks the record driveable;
  `--no-bridge` wins; `--max-tabs`/`--quiet` parsing.
- **Coverage** kept at/above each package floor (`coverage-thresholds.json`).
- **Manual smoke (staging):** `npm run dev -- --lead <staging-hub>`, `serve --bridge`,
  open the URL in a second browser, confirm the tab appears as a `preview:` target, drive it
  with `playwright-cli`, confirm a connect lick, `slicc.emit` lands as a webhook lick, and an
  idle tab does not keep the DO billed (hibernation).

## 11. Documentation

- Root `CLAUDE.md` (external-handoffs-adjacent preview section), `packages/webapp/CLAUDE.md`
  (new transport + lick), `packages/cloudflare-worker/CLAUDE.md` (bridge WS role + routes +
  hibernation), `packages/cherry/CLAUDE.md` (shared handler now feeds the preview bootstrap).
- `docs/architecture.md` — extend the synthetic-CDP translation matrix and the tray/sync
  matrix with the `preview:` target + `bridge.*` messages; note the `SyntheticCdpTransport`
  base.
- `docs/shell-reference.md` — `serve --bridge/--no-bridge/--max-tabs/--quiet` (also fixes the
  pre-existing gap: `serve` has no `mount`-style content there yet).
- `README.md` — user-facing "driveable preview" note **with the security warning in bold**.
- `packages/vfs-root/workspace/skills/*` — the `serve` skill: `--bridge` behavior + the
  `window.slicc` page API + the security posture.

## 12. Rollout phases

1. **DO relay + hibernation + bootstrap + transport** — a preview tab connects, is listed, and
   is driveable for `navigate`/`eval`/`DOM`/`Input`; connect/disconnect licks. (Core.)
2. **Screenshot** — `Page.captureScreenshot` (html2canvas-pro is bundled into the bootstrap
   IIFE). (Can trail phase 1; it's the only non-native capability.)
3. **`window.slicc` sugar + webhook auto-provision** — DX polish over the existing beacon +
   `Runtime.evaluate` mechanisms.
4. **Docs + skill + parity notes.**

## 13. Resolved decisions

- **[D1 — resolved]** HTML injection in the worker via `HTMLRewriter` (not leader-side).
- **[D2 — resolved]** A small new `'preview'` lick type, lifecycle-only (connect/disconnect).
- **[D3 — resolved]** Bootstrap is a single classic IIFE (html2canvas bundled in), served as a
  worker-embedded same-origin `/__slicc/preview-bridge.js` (not cross-origin from the hub, no
  code-split chunk).

All three took the recommended option and are reflected inline above; listed here for
traceability. No open decisions requiring a product call remain.
