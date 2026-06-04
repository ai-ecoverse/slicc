# Unified Preview — worker-relay + wildcard subdomain

- **Date:** 2026-06-04
- **Status:** Design — revised after reviewer feedback (2026-06-04); all 8 open questions pinned
- **Branch:** `worktree-unified-preview` (forked from `origin/main` `f8562d68`)
- **Supersedes:** `docs/superpowers/specs/2026-05-29-federated-preview-design.md` on `worktree-federated-preview` (P2P federated preview — kept as historical record)

## Summary

A single mechanism for `serve`/`preview`/`open` across **every** float and **every** follower, including iOS, Cherry embeds, and shareable links: the agent's served content is rendered in a normal browser tab opened at **`https://<previewToken>.preview.sliccy.ai/<path>`**. The Cloudflare worker, on each request, calls the leader over the **controller WebSocket it already holds** to fetch the file from the leader's VFS, streams the bytes back as a normal HTTP response, and (when enabled) injects a small bridge script so the agent can keep mutating the live page after load.

This collapses today's two preview paths (local SW-served `/preview/*` for the agent's own browser; P2P data-channel-served `/preview/~leader/*` for followers) into one. The follower's preview SW, the per-`clientId` routing state, the `preview-vfs` BroadcastChannel responders, the per-float caveats (extension's no-root-SW limit, relative-vs-root-absolute hand-waving) — all go away. The replacement is a real origin served by `sliccy.ai`, so the browser does the work of telling us what to fetch (including lazy `import()`, runtime `fetch('/api')`, code-split chunks) and nothing has to "predict" the request set.

## Motivation

The federated-preview P2P design works inside its scope, but it has structural gaps that compound:

- **The extension follower has no root-scoped service worker**, so root-absolute paths (`/scripts.js`, `/assets/x.js`) are not intercepted — apps must use relative bases or break.
- **Lazy loads only work for in-scope/relative URLs.** Dynamic `import('/chunks/x.js')` or `fetch('/api/data')` either escape the SW scope (extension) or hit the wrong origin (follower's own app instead of the leader).
- **iOS rendering** would need a native `WKURLSchemeHandler`.
- **Shareable links** are not possible — the tab has to live at the follower app's origin, requires the follower to be a SLICC client, and depends on follower-side SW plumbing.
- **The local-serve path and the federated path are two separate mechanisms** with different caveats and different live-weave stories.

The unified design fixes all of these at once by changing the question from "how do we route the request inside the follower" to "**how is the request answered, given we own the origin**." Once we own the origin, the per-float caveats evaporate, lazy loads stop being a special case, and live-weave can ride a single uniform bridge channel.

## Goals

1. One mechanism for `serve` across all floats. No `--local` escape hatch (rationale and the three real tradeoffs are in the Risks section).
2. Real interactive tabs everywhere — desktop, extension, cloud cone, Cherry-embedded host page, iOS, and arbitrary browsers opening a shared link.
3. **Lazy loads, root-absolute paths, dynamic `import()`** all just work — handled at the network layer.
4. **Live weaving** (agent mutates the rendered page after load) works uniformly via an opt-in **bridge channel** routed through the worker — no per-follower CDP plumbing required.
5. Security boundary: the leader's VFS read surface stays scoped to the agent-served root, including `..`/`.` traversal rejection and sibling-prefix rejection.
6. Resilience: brief leader flaps are absorbed by the worker; medium gaps (page reload within the tray reclaim window) keep URLs working; long gaps (tray expired) return a meaningful "session ended" page instead of an opaque 404.
7. Cloudflare-worker takes the new responsibility, in line with its existing position as the encrypted control plane.

## Non-goals

- **`--local` SW-only preview.** Rejected on the principle that keeping it dilutes every simplification win — see the "if we keep local, we don't get the benefits" thread in design discussion. The current SW-based local serve is replaced, not preserved. Note: **non-serve consumers** of the current SW path (dips, `open` for VFS files) keep working without the SW via direct VFS read — see [Phase 1b](#phase-1b--non-serve-preview-consumer-migration).
- **Decoupling the preview URL's lifetime from the tray's reclaim window** (cone-killed → fresh tray → new token). Out of scope; we accept "session ended" as the honest UX.
- **Driving the live page from a non-SLICC browser** that opened a shareable link. Such a tab gets byte-level fidelity (lazy loads, root-absolute, multi-asset) but no live mutation (no bridge subscriber registered on the leader for that tab unless explicitly wired). Documented limitation, not a defect.
- **Streaming media / range requests** beyond what `fetch`-style chunked responses naturally support. Best-effort for video/audio.
- **Editing the served content from the preview tab.** Read-only. Mutations happen via the leader (which edits the VFS).
- **`Network.*` CDP domain into the preview tab.** Not provided.

## Background — what already exists (verified)

### Worker (Cloudflare)

- `SessionTrayDurableObject` (`packages/cloudflare-worker/src/session-tray.ts`) holds the `TrayRecord` with **three capability tokens** today: `joinToken`, `controllerToken`, `webhookToken` (`shared.ts:127-140` factory). A _fourth_ `previewToken` slots in naturally.
- The leader holds a **controller WebSocket** to the DO (`handleControllerAttach`, ~line 359). It already forwards `webhook.event` to the leader over this socket (`session-tray.ts:571`) — preview content uses the same mechanism with a new message pair.
- Reclaim windows are fixed in `shared.ts:10-11`: **`TRAY_RECLAIM_TTL_MS = 1h` (desktop)**, **`HOSTED_TRAY_RECLAIM_TTL_MS = 30d` (hosted)**. Live previews' URL lifetime is bounded by this.
- The worker has Static Assets via `env.ASSETS`, a SPA fallback, and CORS-aware routes including webhooks with `access-control-allow-origin: *` (`session-tray.ts:517,586,590`).
- Wildcard subdomains on a Cloudflare Worker are bound by adding a route like `*.preview.sliccy.ai/*` in `wrangler.jsonc`; CF auto-provisions TLS for subdomains under a managed zone.

### Webapp / leader

- `LeaderSyncManager` (`packages/webapp/src/scoops/tray-leader-sync.ts`) handles the controller WS, broadcasts to followers, has `getConnectedFollowers()` (~line 827).
- The leader has direct VFS access via `VirtualFS` (LightningFS) — answering a `preview.request` requires only `vfs.readFile`/`stat`. Chunked-response packaging is already implemented in `tray-fs-handler.ts` (`handleReadFile`, `chunkContent` at 64 KB).
- The page-side `LeaderSyncManager` is reachable from the kernel-worker via the existing **`panel-rpc` bridge** (`packages/webapp/src/kernel/panel-rpc.ts`) — proven by the `tray-reset` op.

### Cherry

- `CherryHostTransport` (`packages/webapp/src/cdp/cherry-host-transport.ts`) is a `CDPTransport` over postMessage. The follower is a normal SLICC follower (in a `?cherry=1` iframe) with this transport injected.
- `Target.createTarget` on Cherry is **supported as a courtesy `onOpenUrl(url)` host hook** (`packages/cherry/src/cdp-host-handlers.ts`) — returns a synthetic `targetId: 'cherry-opened'`; the host page decides how to render the URL (its own tab listing, iframe, popout, anything).
- `slicc.event` / `host.event` envelopes carry cooperative bidirectional events between leader and host page. Used today as `cherry` licks; available for preview bridge integration if useful.

### iOS

- `packages/ios-app/SliccFollower/Models/SyncProtocol.swift` decodes unknown message types to `.unknown(type:)` (line 263) and `AppState.handleDataChannelMessage` has a `case .unknown:` arm (line 705/880, logs `"Unknown message type received"` and `break`s). **Today iOS will silently ignore `preview.open` — it doesn't open the URL.** iOS _does_ handle `tab.open { url }` end-to-end (`SyncProtocol.swift:190,267,343`; `AppState.swift:683` dispatches to a WKWebView). So iOS is one small protocol change away from working: **add a `preview.open` case to the Swift union + dispatcher** (the Phase-1 iOS step in this spec). Not free — but a tiny 5-step-checklist change per `packages/ios-app/CLAUDE.md`.

## Architecture

### End-to-end pipe

```
┌───────────────────────── Tab ─────────────────────────┐
│  <previewToken>.preview.sliccy.ai/<path>              │
│   browser issues normal HTTP for index.html, then for │
│   every asset (lazy, dynamic, root-absolute, …)       │
└──────────────────────────┬────────────────────────────┘
                           │ HTTPS to CF edge
                           ▼
┌────────────────── Cloudflare Worker ─────────────────┐
│  Route: *.preview.sliccy.ai/*                        │
│  1. Parse <previewToken> from host header            │
│  2. Look up DO record:                               │
│        { trayId, servedRoot, entryPath, allowLive }  │
│  3. Resolve vfsPath:                                 │
│        path === '/'  →  entryPath                    │
│        else          →  servedRoot + path            │
│  4. Send preview.request{reqId, vfsPath, servedRoot} │
│        over the leader's controller WS               │
│  5. Reassemble preview.response chunks into HTTP body│
│  6. Inject bridge <script> into HTML (if allowLive)  │
│  7. Stream back to browser with correct Content-Type │
└──────────────────────────┬────────────────────────────┘
                           │ controller WS (encrypted, leader-held)
                           ▼
┌──────────────── Leader (any float) ──────────────────┐
│  Handles preview.request:                            │
│   - Verify vfsPath ⊆ servedRoot (security gate)      │
│   - vfs.readFile(vfsPath) / stat for dirs            │
│   - Chunk content (base64 for binary, 64 KB chunks)  │
│   - Reply preview.response{reqId, chunkData, …}      │
│  Leader stores NOTHING about active previews:        │
│  servedRoot comes from the worker on every request.  │
└──────────────────────────────────────────────────────┘
```

For the **live-weave bridge**, see the _Bridge channel — opt-in live weaving_ section below.

### URL scheme — wildcard subdomain (env-derived)

```
prod      https://<previewToken>.preview.sliccy.ai/<path>
staging   https://<previewToken>.preview.staging.sliccy.ai/<path>
                └─ unguessable, DO-issued capability  └─ path forwarded to leader as-is
```

The **preview host is derived from the tray's worker base URL**. A tray on `sliccy.ai` mints preview URLs under `*.preview.sliccy.ai`; a tray on `staging.sliccy.ai` (or whatever staging host the user's `VITE_WORKER_BASE_URL` points to) mints under `*.preview.staging.sliccy.ai`. This keeps a token minted on worker A from being served by worker B (different DurableObject namespaces) — a real risk for local dev pointed at staging while the spec defaults to prod.

The browser's URL-resolution rules then put **every** request — relative, root-absolute, lazy, dynamic — back on the same origin (`<previewToken>.preview.sliccy.ai`), so the worker sees it all. Root-absolute `/scripts.js` resolves to `<previewToken>.preview.sliccy.ai/scripts.js`, hits the worker, gets routed against the served root: solved.

**Origin isolation per preview** is a happy by-product: each preview is its own origin, so previews can't read each other's cookies/localStorage/IndexedDB, and they can't reach `sliccy.ai`'s own cookies/storage either (`sliccy.ai` and `<token>.preview.sliccy.ai` are different origins by the [public suffix-style boundary CF subdomain isolation gives us](https://developers.cloudflare.com/workers/runtime-apis/request/)). Documented browser-native site isolation, free.

### `previewToken` — DO-owned per-preview capability

A fourth capability alongside `join`/`controller`/`webhook`. Minted by **`tray-open-preview`** (the existing panel-rpc op, repurposed): instead of broadcasting a `preview.open` carrying a path-prefix URL, the page-side handler calls the worker to **mint a new previewToken** scoped to `(trayId, servedRoot, entryPath, allowLive)`, gets back the public URL, then broadcasts `preview.open { url }` to followers.

DO record shape:

```ts
interface PreviewRecord {
  previewToken: string; // tray-scoped capability (format: trayId.<18-byte-hex>)
  trayId: string;
  servedRoot: string; // VFS path, e.g. '/workspace/dist'
  entryPath: string; // VFS path of entry file, e.g. '/workspace/dist/index.html'
  allowLive: boolean; // bridge-channel injection opt-in
  createdAt: string;
  // Lifetime bound to the tray's reclaim window — no independent expiry needed
}
```

Tokens are unguessable (`createCapabilityToken(trayId)` pattern from `shared.ts:127`). Stored in the DO's persisted storage. **The leader stores nothing** — `servedRoot` rides on every `preview.request` from the worker, and the leader applies the security gate against that worker-supplied root.

This is the [option-2-from-design-discussion](#) shape: no in-memory state to lose on leader reload, no replay/handshake to re-register served roots after reconnect, tokens are independently revocable.

**Minting is fresh-each-time, not idempotent.** Re-running `serve /workspace/dist` mints a **new** token (and a new subdomain URL) every invocation — the worker does not key tokens by `(trayId, servedRoot, entryPath)` and dedupe. Rationale: capability tokens are unguessable by construction, and keying-by-content would leak structure into what should be opaque. Cheap to mint, independently revocable, no caller surprise where two `serve` calls hand out URLs that share fate. Old previews of the same root remain valid until tray expiry or explicit revoke; they simply co-exist on a different subdomain from the new one.

### Concurrent serves

Multiple `serve` invocations run side-by-side without interference. Each mints its own `previewToken` → its own subdomain → its own origin → its own DO-stored `servedRoot`/`entryPath`. The leader's security gate fires against the per-request `servedRoot`, so paths are scoped to the token that asked for them, not to "whatever the most recent serve set."

Concretely:

```
serve /workspace/dist          → token A  → https://<tokenA>.preview.sliccy.ai/
serve /workspace/site-b        → token B  → https://<tokenB>.preview.sliccy.ai/

GET <tokenA>.preview.sliccy.ai/        → entryPath               = /workspace/dist/index.html
GET <tokenA>.preview.sliccy.ai/app.js  → servedRoot + '/app.js'  = /workspace/dist/app.js
GET <tokenB>.preview.sliccy.ai/        → entryPath               = /workspace/site-b/index.html
GET <tokenB>.preview.sliccy.ai/app.js  → servedRoot + '/app.js'  = /workspace/site-b/app.js
```

`<tokenA>.preview.sliccy.ai/app.js` and `<tokenB>.preview.sliccy.ai/app.js` look like "the same path at the same root" structurally, but they're on **different origins** and resolve to **different physical VFS paths** because the per-token `servedRoot` rides every request. No shared state, no collision, no "most recent serve wins."

Three properties this gives us for free:

- **Browser-native site isolation between previews.** Different subdomains = different origins; cookies, `localStorage`, `IndexedDB`, `postMessage` channels are all isolated. A page served from `<tokenA>` doing `fetch('https://<tokenB>.preview.sliccy.ai/secret')` is a cross-origin request; the worker should **default-deny CORS between preview subdomains** so previews never see each other's content.
- **Bridge channel isolation.** Each token's `__preview/bridge` WS upgrade is scoped to that token's session; the bridge in preview A cannot receive commands for preview B.
- **Independent revocation.** Deleting one preview's DO record doesn't affect the other.

This is a structural fix for a class of bug the current SW-based local serve has to work around. `preview-sw.ts` keeps `projectRoot` per-`clientId` precisely because the old design has a global-clobber problem with concurrent serves (the regression we fixed mid-implementation on the P2P branch). Under the unified design that fix is _structural_ — different tokens = different origins = different gates, end of story — not a per-client lookup map.

### Protocol — worker ↔ leader (controller WS)

The current `LeaderToWorkerControlMessage` union (`packages/cloudflare-worker/src/tray-signaling.ts:~150-160`) is `ping | bootstrap.offer | bootstrap.ice_candidate | bootstrap.failed` — leader replies that aren't bootstrap-related don't exist. **Phase 1 extends the union** (in `tray-signaling.ts`) with two new variants below, and updates the DO's `handleLeaderMessage` to route `preview.response` chunks to the pending-request assembler keyed by `reqId`. Phase 2 adds `preview.bridge_event` (leader → worker, forwarded to bridge) symmetrically.

Two new message types on the existing controller WebSocket the leader already holds:

```ts
// worker → leader
type PreviewRequest = {
  type: 'preview.request';
  reqId: string; // worker-generated nonce for response correlation
  servedRoot: string; // the security scope (leader gates against this)
  vfsPath: string; // the file to read
  asText: boolean; // utf-8 (true) or binary (false)
};

// leader → worker
type PreviewResponse =
  | {
      type: 'preview.response';
      reqId: string;
      ok: true;
      mime: string; // Content-Type for the response
      chunkIndex: number;
      totalChunks: number;
      content: string; // utf-8 OR base64-encoded binary
      encoding: 'utf-8' | 'base64';
    }
  | {
      type: 'preview.response';
      reqId: string;
      ok: false;
      status: 404 | 403 | 500;
      reason?: string;
    };
```

Reassembly is the same shape as today's federated FS: defensive sort by `chunkIndex`, concatenate, decode base64 if binary. Worker has an in-memory map `pending = Map<reqId, ResponseAssembler>` per DO instance.

**Timeout / disconnect handling:**

- Per-request timeout: 30 s (aligned with CF Workers' subrequest limit). On timeout the worker discards the assembler entry and returns **502** to the browser.
- Leader connected, tray valid, no `preview.response` in time → 502.
- Leader disconnected during pending request, tray still inside reclaim window → 502 (the browser can retry; later requests succeed once the leader reattaches).
- Leader disconnected, tray expired → **session-ended HTML** (the user-actionable terminal state).
- Bound on buffered chunked content per pending request: ~few MB before Phase-2 streaming (see Open Q #5).

### Protocol — leader → follower (existing-shape `preview.open`)

```ts
{
  type: 'preview.open';
  requestId: string;
  url: string;
}
```

Carries the **fully-qualified worker URL** (`https://<token>.preview.sliccy.ai/...`). Follower handler is unchanged in shape from the P2P branch — call `Target.createTarget` (or, on Cherry, falls through to `onOpenUrl`).

### Bridge channel — opt-in live weaving

**Bridge is opt-in via `serve --bridge` (or `--interactive`)** — OFF by default for transparency, since the bridge injects code into served HTML. **Cherry-opened previews default-on** (the bridge is Cherry's only path to live weaving since the host page can't drive CDP into the iframe).

The worker, when serving an HTML response for an `allowLive: true` preview, injects a small inline `<script>` at the top of `<head>`:

```html
<!-- injected by sliccy.ai preview worker; opt-out via serve --no-bridge -->
<script>
  (function () {
    const ws = new WebSocket('wss://<token>.preview.sliccy.ai/__preview/bridge');
    ws.onmessage = (e) => {
      /* tiny command dispatcher */
    };
    window.__sliccPreview = { emit: (name, detail) => ws.send(JSON.stringify({ name, detail })) };
  })();
</script>
```

Worker route `wss://<token>.preview.sliccy.ai/__preview/bridge` upgrades to WS, opens a pair routed through the DO: every message from the bridge becomes a `preview.bridge_event { reqId, data }` to the leader's controller WS; every `preview.bridge_command { data }` from the leader is forwarded to the bridge. The leader-side surface is a new shell command (`preview-emit <name> <detail>`, analogous to `cherry-emit`) and a `lick` channel for bridge events.

**v1 command surface** (the leader can send these as `preview.bridge_command`s; the bridge dispatches them in the preview page):

- `eval(js)` — `indirectEval(js)` in the page realm; governed by the page's own CSP (same shape as Cherry's `Runtime.evaluate`). Maximally expressive; the agent can run arbitrary expressions.
- `setOuterHTML(selector, html)` — `document.querySelector(selector).outerHTML = html`.
- `inject(scriptText)` — append a `<script>` with the given text body to `<head>` so the agent can push runnable JS without needing inline-expression access.
- `requestReload()` — `location.reload()`.
- `host-event(name, detail)` — fire a `CustomEvent` on `window`; the page can listen via `addEventListener('slicc-preview-event', ...)`. Symmetric reverse channel: `window.__sliccPreview.emit(name, detail)` from page → leader as a `cherry`-style `preview` lick.

Trust note: `eval` is in v1 by the user's explicit call (over the reviewer's recommendation to defer). The attack surface is real — a compromised leader can run arbitrary JS in the served-page realm. Mitigations: bridge is opt-in (not implicit on every serve); the served page's own CSP still applies (the indirect `eval` runs in the page's global scope and respects `script-src` restrictions per the Cherry precedent); the served page can `<meta name="slicc-preview" content="no-bridge">` to refuse injection.

The script is **minimal and well-known** (versioned, code-reviewed, served by the worker). The page can opt out (`<meta name="slicc-preview" content="no-bridge">` honored by the worker) or the user can `serve --no-bridge` to mint a token with `allowLive: false`.

**Cherry interplay:** the preview iframe inside a Cherry embed runs the same injected bridge. The bridge's WS connects directly to `sliccy.ai` — it does NOT need to go through Cherry's `host.event`/`slicc.event` channel. So **Cherry's host SDK requires zero changes**: the host's `onOpenUrl` opens the URL in an iframe, the bridge inside takes over. This is the same uniform mechanism for all followers.

### Security model

**Trust boundaries:**

1. **Origin (browser):** each preview is its own origin → site isolation between previews. Cookies/storage/postMessage cannot cross preview origins.
2. **Capability (worker):** `previewToken` is unguessable; possession = view permission; revocable by deleting the DO record. Validated by host-header parse on every request.
3. **Path scope (leader):** every `preview.request` carries `servedRoot` from the DO; the leader's gate **`isPathWithinServedRoot(vfsPath, servedRoot)`** refuses paths outside it. This is a port + rename of the federated branch's `isWithinAllowedRoots`/`leader-preview-reader.ts` security helper — the multi-root `Set` collapses to a single-root signature because each `preview.request` carries exactly one root (the DO knows which preview is being asked about). The full test suite ports from `worktree-federated-preview/packages/webapp/tests/scoops/leader-preview-reader.test.ts` (13 cases: `..`/`.` traversal rejection, sibling-prefix `dist-secret` rejection, trailing-slash normalization, root-`/` fail-closed, empty-real-file vs no-file distinction). The leader applies the gate **before** `vfs.readFile` so out-of-scope paths never touch the filesystem.
4. **Bridge script:** opt-in (`allowLive: true`), inline (no external resources), versioned, served by us, scoped to the preview's own origin. The script's WS auth is the `previewToken` in the URL; it cannot reach other previews or the leader's general controller channel.
5. **TLS:** end-to-end TLS on both hops (browser↔worker, worker↔leader-WS). The worker terminates TLS on both legs and handles **plaintext** between them — that's the deliberate trust delta vs the current P2P preview, where content stays inside the leader's browser. The worker is "us"; it already handles agent chat, tool I/O, webhooks. Preview content joining that set is a continuation of an existing trust assumption, not a new one. **Acknowledge this explicitly** in user-facing docs.
6. **CORS between preview subdomains:** the worker **omits `Access-Control-Allow-Origin` on cross-preview-origin responses** (no header = browser blocks the cross-origin read). No credentialed cross-origin requests are honored. Same-origin requests within a preview subdomain are unrestricted. Cherry-host iframes are governed by `Content-Security-Policy: frame-ancestors` — recommended setting: `*` so any Cherry host can frame a preview (the previewToken is the auth boundary, not the host origin), with `Cache-Control: no-cache` so VFS mutations land immediately on reload.

### Resilience model

Three durations, three distinct user-visible states:

| Duration                                | What happens                                                                                            | URL valid? | User sees                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| Brief flap (< ~2s, WS hiccup)           | Worker holds pending `preview.request`s; controller-WS reconnects via CF Workers' WebSocket hibernation | yes        | slight stall on one asset; transparent                                             |
| Medium gap (page reload, ≤ reclaim TTL) | Existing tray-rejoin logic; same `trayId` + same `previewToken`                                         | yes        | open tabs may need refresh (or auto-recover via bridge `leader-reconnected` event) |
| Long gap (> reclaim TTL, tray expired)  | DO returns `TRAY_EXPIRED`; worker serves a polite "session ended" HTML page with explanation            | **no**     | clear "session ended; ask the agent to `serve` again"                              |

**Bridge auto-recovery:** when `allowLive: true`, the worker emits a synthetic `leader-reconnected` event over the bridge WS on tray reattach; the bridge can choose to reload the page (default behavior) or surface a banner.

Discrete UI states for the bridge to render:

- `connection-lost` (data channel keepalive fired or controller-WS dropped, < ~30s)
- `session-ended` (medium gap, tray reclaimable but currently disconnected)
- `url-expired` (long gap, DO returned TRAY_EXPIRED)

### Per-environment matrix

|                                                            | Byte delivery                               | Live weave (bridge)                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Standalone (the agent's own browser viewing its own serve) | ✅ worker                                   | ✅                                                                                                                          |
| Extension follower                                         | ✅ worker                                   | ✅                                                                                                                          |
| Cloud cone, browser follower                               | ✅ worker                                   | ✅                                                                                                                          |
| Cloud cone, Cherry embed                                   | ✅ worker (host SDK's `onOpenUrl`)          | ✅                                                                                                                          |
| iOS follower                                               | ✅ worker (just opens the URL in WKWebView) | ✅                                                                                                                          |
| Shareable link (random non-SLICC browser)                  | ✅ worker                                   | ⚠️ bytes ✅; bridge active only if `allowLive: true` AND the leader is connected (bridge degrades to no-op silently if not) |

**One mechanism, one matrix row that always says yes.** That's the whole point.

## What transfers from `worktree-federated-preview` (and what doesn't)

### Transfers (re-implementable on this branch — port + adapt)

- **Security gate function** — rename `isWithinAllowedRoots` → `isPathWithinServedRoot(vfsPath, servedRoot)`; same internal logic (traversal `..`/`.` rejection, sibling-prefix rejection, trailing-slash normalization, root-`/` fail-closed). Moves leader-side, applied inside the `preview.request` handler before `vfs.readFile`.
- **The full 13-test security suite** (`worktree-federated-preview/packages/webapp/tests/scoops/leader-preview-reader.test.ts` — reviewer-corrected from the spec's earlier "9-test" claim) — port to `tests/scoops/preview-request-handler.test.ts` against the new leader-side handler. Includes empty-real-file vs no-file distinction.
- **`preview.open` protocol message** — same shape, `url` field replaces `path`/`root`. **Also extend iOS** (`SyncProtocol.swift` union + `AppState.handleDataChannelMessage` dispatcher) — small Swift change, per `packages/ios-app/CLAUDE.md`'s 5-step protocol checklist.
- **`tray-open-preview` panel-rpc op** — payload changes to mint a preview token via the worker, response changes to `{ url, pushed }`.
- **`currentLeaderSync` getter** on `page-leader-tray.ts` — unchanged.
- **`serve` follower-push integration** — same shape; URL is now worker-served. `serve` itself gains auto-enable-tray behavior (see Decisions).
- **iOS `.unknown` decoder safety** — already present; the new `preview.open` case is added explicitly rather than relying on the silent-drop path.

**Honest LoC estimate (revised after reviewer feedback):** Phase 1 totals ~800–1500 LoC across the worker (preview handler, DO mint route + storage, `LeaderToWorkerControlMessage` extension, WS-to-HTTP chunked pump, host parser), the webapp leader (`preview.request` handler in both `page-leader-tray.ts` and `extension-leader-tray.ts`, panel-rpc op repurposed, `serve` auto-enable, `mintPreviewUrl`), iOS (one new case), and **substantial test ports** (security-gate suite + worker DO + extension-float + iOS decode). The earlier "~300 LoC transfer" number was the _transferred portion_, not the full Phase 1 budget.

### Does NOT transfer (vestigial under the unified design)

- `packages/webapp/src/ui/preview-sw-routing.ts` — entire file. No SW classifier any more.
- `packages/webapp/src/ui/preview-sw.ts` `/preview/~leader/*` route, `handleLeaderPreviewRequest`, per-`clientId` state map (it stays for **local non-federated serve which we're also retiring** — see "What we delete from main" below).
- `packages/webapp/src/ui/main.ts` `preview-vfs` BroadcastChannel responder `source:'leader'` branches (×2).
- `packages/chrome-extension/src/offscreen.ts` `preview-vfs` responder + reader install/clear.
- `packages/webapp/src/ui/page-follower-tray.ts` reader install/clear.
- `leader-preview-reader.ts`'s **runtime** (registry, reader factory, chunk reassembly — chunk reassembly moves worker-side; registry is gone). Only the security helpers survive.

### What we delete from `main` itself

The local SW-based `/preview/*` path also goes — once unified, all `serve` invocations (local, federated, Cherry) go through the worker. That's a real **deletion** from main:

- `packages/webapp/src/ui/preview-sw.ts` — entire file (~230 LoC).
- `packages/webapp/src/ui/main.ts` registration of preview-sw (~50 LoC).
- `packages/webapp/src/ui/main.ts` `preview-vfs` BroadcastChannel responders (~30 LoC × 2).
- `packages/webapp/src/ui/llm-proxy-sw.ts` `importScripts('/preview-sw.js')` (single line) and the related root-SW preview interception.
- `packages/webapp/src/shell/supplemental-commands/shared.ts` `toPreviewUrl` (replaced by `mintPreviewUrl` that calls the worker).
- `packages/webapp/vite.config.ts` + `packages/chrome-extension/vite.config.ts` `build-preview-sw` esbuild closeBundle steps (and the corresponding `dist/extension/preview-sw.js` artifact).

This is a _net reduction_ — the unified design removes more code than it adds.

## Worker changes

### Routes / DNS / TLS

1. **Add wildcard binding** in `packages/cloudflare-worker/wrangler.jsonc` — both environments:
   - prod: `routes: [..., "*.preview.sliccy.ai/*"]`
   - staging: `routes: [..., "*.preview.staging.sliccy.ai/*"]`
     CF auto-provisions TLS for subdomains under managed zones; confirm the wildcard cert covers the preview leaf (`*.preview.sliccy.ai`) — typically requires explicit add-on or zone config.
2. **Sub-domain dispatch:** `Worker.fetch(request)` parses `request.headers.get('host')`. If host matches `<token>.preview.<env>.sliccy.ai` (env-aware), route to the preview handler; else the existing handler. The token format is `trayId.<18-byte-hex>` (multi-dot) — parse as `host.split('.')[0]` then verify against the leftmost label only (don't split on every dot or the embedded `.` in the token format breaks).
3. **Pre-Phase-1 prerequisite:** confirm DNS/TLS provisioning with whoever owns the `sliccy.ai` zone (and the staging equivalent) **before** Phase 1 implementation lands. Without the staging wildcard, dev/staging trays mint URLs that 404. Treat as a blocker.

### Routes — preview handler (on `*.preview.<env>.sliccy.ai`)

```
GET   /                          → fetch entry file via DO + worker→leader pipe
GET   /<path>                    → fetch file via DO + worker→leader pipe
GET   /__preview/bridge          → upgrade to WS for the bridge channel (allowLive only)
POST  /__preview/lick (optional) → cooperative lick post (or use webhooks)
OPTIONS *                        → CORS preflight (mirrors the webhook OPTIONS shape if we add it)
```

### Routes — mint API (on the main worker host)

```
POST  /api/tray/:trayId/preview      → mint a new previewToken (controller-capability auth)
POST  /api/tray/:trayId/preview/stop → revoke a previewToken (controller-capability auth)  [Phase 1]
```

Mint request/response shape (consistent with the existing `/controller/:token` capability pattern):

```ts
// POST /api/tray/<trayId>/preview
// Authorization: Bearer <controllerToken>
// body:
type MintPreviewRequest = {
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
};

// response:
type MintPreviewResponse = {
  previewToken: string;
  url: string; // env-derived, fully-qualified
};

// POST /api/tray/<trayId>/preview/stop
// Authorization: Bearer <controllerToken>
// body: { previewToken: string }
// response: { revoked: boolean }
```

Implementation: top-level routes in `cloudflare-worker/src/index.ts` that delegate to the `SessionTrayDurableObject` via the existing stub-fetch pattern; the DO holds `previews: Record<previewToken, PreviewRecord>` keyed under the tray. **Revoke (Phase 1)** deletes the DO record AND broadcasts a `preview.revoked { previewToken }` over the controller WS so the leader can emit a `preview-stopped` bridge event to invalidate any open follower tabs. Subsequent requests for that token return the "session ended" HTML.

Routes-mirror rule applies: `index.ts` routes + `tests/index.test.ts` + `tests/deployed.test.ts` (3-file update, for **both** mint and revoke).

### DO additions

```ts
// in SessionTrayDurableObject
async mintPreview(req: {
  controllerToken: string;       // auth: caller must hold the controller capability
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
}): Promise<{ previewToken: string; url: string }>;

async resolvePreview(previewToken: string): Promise<PreviewRecord | null>;

async revokePreview(previewToken: string): Promise<void>;  // Phase 1; broadcasts preview.revoked over controller WS

// LeaderToWorkerControlMessage union extended (in cloudflare-worker/src/tray-signaling.ts):
//   | { type: 'preview.response'; reqId; ok; ... }            // Phase 1
//   | { type: 'preview.bridge_event'; reqId; data }           // Phase 2
// handleLeaderMessage routes preview.response chunks to the pending-request assembler
// keyed by reqId; preview.bridge_event is fanned to the matching bridge WS.
```

Storage: `previews: Record<previewToken, PreviewRecord>` in the DO's persisted state. Deletion on tray expiry (cleaned up alongside the tray itself) **and** on explicit revoke (Phase 1).

### Coverage and gates

- Per the worker package CLAUDE.md, coverage floor is 75% lines/statements, 65% branches, 85% functions. New code must keep us at/above floor.
- `wrangler deploy --dry-run` gate stays — wildcard binding must not push us over the 25 MiB asset cap (we're nowhere near it).

### CSP / framing

The preview origin is its own subdomain, served only by the worker — no static assets — so default CSP is restrictive by the absence of inline scripts (except the bridge, which is inline-by-injection). The bridge script's source-of-truth is the worker; its hash can be served as `Content-Security-Policy: script-src 'sha256-<bridgehash>' …` so even within the preview origin only the known bridge can inline-execute.

For HTML served to the preview tab: `Content-Security-Policy: frame-ancestors *` (so it can be iframed by Cherry hosts) or a configurable allow-list. Cache discipline: `Cache-Control: no-cache` (matches today's preview-SW behavior); content is leader-VFS-mutable.

## Leader-side changes

### Controller WS handler additions

The leader has the controller WS in either of two realms depending on float:

- **Standalone / cloud cone:** `page-leader-tray.ts` (page realm).
- **Extension:** `extension-leader-tray.ts` (offscreen realm; constructs its own `LeaderSyncManager` at line ~265). Same controller WS, just owned by the offscreen.

Both add the same `preview.request` handler:

```ts
// in a new shared module preview-request-handler.ts, called from both
// page-leader-tray.ts and extension-leader-tray.ts when their controller WS
// receives a preview.request:
function onPreviewRequest(msg: PreviewRequest, ws: ControllerWebSocket, vfs: VirtualFS): void {
  const { reqId, servedRoot, vfsPath, asText } = msg;
  // Security gate: vfsPath must be under servedRoot. Renamed from federated branch.
  if (!isPathWithinServedRoot(vfsPath, servedRoot)) {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }
  // Read VFS; reuse handleReadFile + chunkContent from tray-fs-handler.ts.
  // Reply with one or more PreviewResponse chunks. 404 on miss; 500 on read error.
}
```

The leader stores no per-preview state; `servedRoot` arrives on every request. Survives leader reload trivially (the DO holds the truth).

### Extension float — `tray-open-preview` wiring

The extension's leader runs in the offscreen document, where **`getPanelRpcClient()` is null** (panel-rpc is a standalone page↔kernel-worker bridge). So `tray-open-preview` can't go through panel-rpc in the extension; it needs a dual-path mirror of the existing `leader-tray-reset` / `cherry-emit` envelope pattern:

- **Standalone:** kernel-worker `serve` calls `getPanelRpcClient().call('tray-open-preview', …)` → page-side `panel-rpc-handlers.ts` resolves it via `pageLeaderTray.currentLeaderSync.broadcastPreviewOpen(...)`.
- **Extension:** kernel-worker `serve` posts a `chrome.runtime` envelope `{ source: 'panel', payload: { type: 'tray-open-preview', requestId, servedRoot, entryPath, allowLive } }` → offscreen's `extension-leader-tray.ts` listens (mirroring its existing `leader-tray-reset` listener at line ~423) → resolves via the in-realm `sync.broadcastPreviewOpen(...)`. Replies with `{ source: 'offscreen', payload: { type: 'tray-open-preview-response', requestId, url, pushed } }`.

The `serve` command picks the path with the same `getPanelRpcClient()` null-check that already exists; null → extension envelope path; non-null → panel-rpc path. Both paths reach the in-realm `LeaderSyncManager` and the worker's mint API; the difference is only the bridge transport.

### Worker→page `tray-open-preview` op (panel-rpc, repurposed)

```ts
op 'tray-open-preview' = {
  payload: { entryPath: string; servedRoot: string; allowLive?: boolean };
  result: { url: string; pushed: number };
};
```

The page-side handler (standalone) or offscreen handler (extension):

1. Calls the worker to mint a previewToken: `POST https://<workerBase>/api/tray/<trayId>/preview` with `Authorization: Bearer <controllerToken>` and body `{ servedRoot, entryPath, allowLive }`.
2. Gets back `{ previewToken, url }` (env-derived from `workerBase`).
3. Broadcasts `preview.open { url }` to followers via `LeaderSyncManager.broadcastPreviewOpen` — including the iOS path (the Swift dispatcher reads `url` and opens it in a WKWebView, per the iOS protocol step below).
4. Returns `{ url, pushed }` to the shell.

### iOS protocol step (in-scope)

Add a `preview.open` case to the iOS Swift follower, following the **5-step protocol checklist** in `packages/ios-app/CLAUDE.md`:

1. `SyncProtocol.swift` — add a `case previewOpen(requestId: String, url: String)` to the inbound-message enum; extend the `Codable` decode for `case "preview.open"` (mirror how `tabOpen` is decoded at `SyncProtocol.swift:267`).
2. `AppState.handleDataChannelMessage` (around line 683 where `tabOpen` is handled) — add a `case let .previewOpen(_, url):` arm that opens the URL in a WKWebView (reuse the existing `tabOpen` open-URL path).
3. Document the new case in the iOS-side protocol comment.
4. Add a Swift decode test (or note the inspection check per `packages/ios-app/CLAUDE.md` — Swift test target isn't established).
5. Update `docs/architecture.md`'s tray sync matrix to reflect iOS preview support.

iOS becomes a first-class preview viewer. No `WKURLSchemeHandler` work — iOS just opens the worker URL.

### `serve` command — auto-enable tray

`serve` calls into `tray-open-preview` (panel-rpc or extension-envelope per float). When the leader has no active tray (`pageLeaderTray?.currentLeaderSync` is null), `serve` **auto-enables the tray on first invocation** (calls `leaveTray({ workerBaseUrl, switchTo: 'leader' })` or equivalent — the existing path used by the avatar-popover "Enable multi-browser sync" button), then mints. Zero-config from the user's POV. The user sees a tray come up implicitly and is one click away from disabling it again via the avatar popover. The bridge default-off still holds — `serve` without `--bridge` mints `allowLive: false`.

### `serve --stop <token>` (Phase 1 revocation UX)

Adds a `--stop <previewToken>` flag to `serve` that calls the new worker `POST /api/tray/<trayId>/preview/stop` route (auth: `controllerToken`). The worker deletes the DO record, broadcasts `preview.revoked { previewToken }` over the controller WS; the leader emits a `preview-stopped` bridge event to invalidate any open follower tabs (best-effort — those tabs may also see 404s on subsequent asset fetches). `serve --list` (also Phase 1) prints the active preview tokens + URLs from a worker `GET /api/tray/<trayId>/previews` admin endpoint.

### `--project` flag — obsolete alias (no-op)

The existing `--project` flag in `serve-command.ts` becomes a **no-op alias**: accepted (for backward compatibility with scripts/skills that pass it), but `serve` prints `"--project: obsolete; no longer needed (root-absolute paths work natively under unified preview)"` to stderr and ignores the value. Behavior is identical to omitting the flag. References across the codebase are scrubbed (a single grep pass): `docs/shell-reference.md`, `docs/architecture.md`, `packages/vfs-root/workspace/skills/**/SKILL.md`, agent examples, dip examples. Tracking sub-task: `rg -l -- --project` shows all remaining references at scrub time.

## Documentation updates

- `docs/shell-reference.md` — rewrite `serve`/`preview`/`open` sections for the worker URL model; document `--bridge`, `--stop`, `--list`; mark `--project` obsolete.
- `README.md` — note that previews are served from `sliccy.ai` subdomains and that `serve` auto-enables multi-browser sync on first use.
- `docs/architecture.md` — replace the federated-preview tray-addendum with the unified mechanism; per-environment matrix; iOS row updated for `preview.open`.
- `docs/pitfalls.md` — replace the "Exclude /preview/ URLs" tab-hygiene rule (lines 636/639) with "Exclude `*.preview.<env>.sliccy.ai` URLs from app-tab detection." Drop the preview-SW pitfalls subsection after Phase 3.
- `docs/urls.md` — add `*.preview.sliccy.ai` (prod) + `*.preview.staging.sliccy.ai` (staging).
- `docs/adding-features.md` — if it references the preview SW build, retarget at the worker preview handler.
- `packages/cloudflare-worker/CLAUDE.md` — new wildcard route, mint/revoke API, preview WS messages, DO `PreviewRecord` schema.
- `packages/webapp/CLAUDE.md` — Tray Sync section updated; remove SW-preview references after Phase 3.
- `packages/chrome-extension/CLAUDE.md` — drop preview-SW caveats; mention that previews open in regular tabs.
- `packages/ios-app/CLAUDE.md` — note `preview.open` is now part of the iOS-handled subset; update the protocol matrix.
- root `CLAUDE.md` — remove preview-sw references after Phase 3.
- Mark superseded: the federated-preview tray-addendum + the per-float caveat matrix from the prior spec.

## Testing strategy

### Worker

- DO `mintPreview` issues unguessable tokens, stores the record, validates `controllerToken`; `revokePreview` deletes the record and emits the controller-WS broadcast.
- Host-header parsing extracts the token correctly **including the embedded `.` in the `trayId.<hex>` token format** (leftmost-label only); bogus/unknown tokens → 404.
- `preview.request`/`preview.response` chunk reassembly into HTTP streaming responses (including binary base64 decode → bytes, MIME inference, directory → `index.html`).
- Bridge WS upgrade path; messages routed to the leader's controller WS as `preview.bridge_event` / `preview.bridge_command`. Bridge with `allowLive: false` → upgrade rejected.
- `TRAY_EXPIRED` and `previewToken` not found → "session ended" HTML page (distinct copy).
- Per-request timeout (30 s) → 502 with no leader response.
- CORS between preview subdomains: cross-preview reads denied (no `Access-Control-Allow-Origin`).
- Mint API auth: requests with wrong/missing `controllerToken` → 403; requests against a tray that doesn't exist → 404.
- Env-derived URL minting: tray on staging-worker-base-URL → staging preview host.
- Routes-mirror parity: `index.ts` + `tests/index.test.ts` + `tests/deployed.test.ts` agree on mint + revoke + list routes.
- Coverage above floor (75% L/S, 65% B, 85% F).

### Webapp (leader side)

- `preview.request` handler in both `page-leader-tray.ts` (standalone/cloud) and `extension-leader-tray.ts` (extension): security gate via `isPathWithinServedRoot`; reads chunked; returns 404 on miss; binary base64; UTF-8 path; 500 on read error; `preview.revoked` broadcast invalidates open follower tabs.
- `tray-open-preview` op:
  - **standalone:** panel-rpc path calls the worker mint, gets URL, broadcasts followers.
  - **extension:** `chrome.runtime` envelope path lands in offscreen, calls in-realm `LeaderSyncManager.broadcastPreviewOpen`.
- `serve` auto-enable: when no tray active, calls the existing `leaveTray({ workerBaseUrl, switchTo: 'leader' })` path before minting; with tray active, mints directly.
- `serve --bridge` mints with `allowLive: true`; default mints with `allowLive: false`.
- `serve --stop <token>` and `serve --list` shell paths.
- `--project` no-op: accepted, warning printed to stderr, mint identical to omitting.
- Security gate as a standalone function (`preview-request-handler.test.ts`): port the federated branch's 13 test cases.

### Webapp (follower side)

- `preview.open { url }` follower handler still opens a tab at the given URL (background:true).
- Cherry: `Target.createTarget` is routed to `onOpenUrl`; host renders. Existing cherry tests cover this; verify the interaction on merge.

### iOS

- Swift decode test for `{"type":"preview.open","requestId":"r","url":"https://..."}` → `.previewOpen` case (or inspection check per `packages/ios-app/CLAUDE.md` when no XCTest target).
- `AppState` dispatch of `.previewOpen` opens the URL in a WKWebView (mirroring the existing `.tabOpen` test if any).

### E2E replacement

- `packages/webapp/tests/e2e/preview-serve.test.ts` (today: local SW assumption) is **replaced** during Phase 1b with a new e2e that drives `serve` against either (a) the staging worker with a real wildcard route, or (b) a Miniflare-backed worker stub serving a synthetic `<token>.preview.local` host. Old e2e is deleted with Phase 3.

### Manual (post-implementation)

- Multi-asset SPA with `<script src="./app.js">`, `<link rel="stylesheet" href="/styles.css">` (root-absolute), `import('./chunks/lazy.js')` — verify ALL three asset types load on every follower type.
- Cherry-host harness opens preview URL in an iframe; agent invokes `preview-emit` and the page reacts via the bridge.
- iOS follower receives `preview.open`, opens URL in WKWebView, renders multi-asset SPA.
- Reload the leader page mid-preview; observe the bridge surfaces `connection-lost` → `leader-reconnected`; new requests resume.
- Tray expiry: wait past `TRAY_RECLAIM_TTL_MS`; subsequent request returns "session ended" page.
- Security: from a served page, `fetch('/workspace/.git/github-token')` → 403; the leader is never asked.
- Concurrent serves: open two `serve`s under different roots; verify origin isolation (cross-preview fetch denied).
- Shareable: copy URL to a different browser (no SLICC running) — bytes render, bridge degrades gracefully.
- `serve --stop`: revoke an active token; existing tabs see 404 on next asset; new tabs see session-ended.

## Phasing

Four deployable slices (Phase 1b runs in parallel with Phase 1):

**Phase 1 — wire delivery + revocation.** Worker wildcard route + DO `mintPreview` / `revokePreview` + `preview.request`/`preview.response` over controller WS (extending `LeaderToWorkerControlMessage`) + leader handler with security gate + `serve` auto-enable + mint via the new HTTP API + `preview.open { url }` to followers + **iOS protocol step** (preview.open Swift case + dispatcher) + extension-float `chrome.runtime` envelope wiring + `serve --stop`/`--list`. _No bridge yet; previews are static-render-only._ Includes routes-mirror updates + worker tests at coverage floor. **Prerequisite:** DNS + wildcard cert for prod + staging confirmed with infra.

**Phase 1b — non-serve consumer migration.** In parallel with Phase 1. Covered fully in [Phase 1b — Non-serve preview-consumer migration](#phase-1b--non-serve-preview-consumer-migration) below.

**Phase 2 — bridge channel.** Worker bridge WS endpoint + injected script + full v1 command surface (`eval`, `setOuterHTML`, `inject`, `requestReload`, `host-event`) + leader-side `preview-emit` shell command + lick wire-up. Enables live weaving uniformly. Optional: large-binary streaming via `TransformStream`.

**Phase 3 — delete the SW preview path from main.** Once Phase 1 has soaked in production AND Phase 1b is complete (no surface still depends on the local SW): retire `preview-sw.ts`, `toPreviewUrl`, the vite/esbuild build steps, `llm-proxy-sw`'s `importScripts`. This is the deletion phase — net negative LoC. **Gating criteria:** prod telemetry shows zero non-test traffic on `/preview/*` for ≥ 2 weeks; Phase 1b migration of `open`, dips, e2e replacement is complete; rollback plan documented.

### Phase 1b — Non-serve preview-consumer migration

Several main-line surfaces use the current local SW preview path. They must migrate to non-SW alternatives **before** Phase 3 can safely delete `preview-sw.ts`:

| Consumer                       | Today                                                                                                                  | Phase 1b target                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open <vfs-file>`              | `toPreviewUrl(fullPath)` opens at `/preview/<path>` (SW serves)                                                        | Read file via VFS, open inline (image: view in chat; HTML: `srcdoc` iframe; other: text/hex view). No worker mint per open.                                                                                                  |
| Dips (`.shtml` in chat)        | Inline `<shtml>` rendered as `srcdoc` iframe; relative `/preview/...` references inside dip rely on the root-scoped SW | Already render inline via existing read-shtml VFS helper. Document that root-absolute `/preview/...` inside a dip stops working post-Phase 3; agent prompts/skills should use relative refs or self-contained inline assets. |
| `playwright-cli` / tab hygiene | `BrowserAPI` excludes `/preview/` URLs from "SLICC app tab" detection (`docs/pitfalls.md:636-639`)                     | Update exclude list to `*.preview.<env>.sliccy.ai`.                                                                                                                                                                          |
| `llm-proxy-sw`                 | `importScripts('/preview-sw.js')` (line 60)                                                                            | Remove import after Phase 3. Verify the LLM proxy doesn't depend on preview-sw's fetch handler.                                                                                                                              |
| `preview-serve.test.ts` (e2e)  | Assumes local SW serves `/preview/*`                                                                                   | Replace with worker-driven e2e (Miniflare stub OR staging deploy) during Phase 1b. Old test removed with Phase 3.                                                                                                            |
| Skills / docs                  | References to `--project`, `/preview/...` URLs, "the preview service worker"                                           | Grep + scrub.                                                                                                                                                                                                                |

Phase 1b is _implementation-light_ but _coverage-broad_ — it's the unglamorous work that makes Phase 3 deletion safe.

## Decisions (pinned, reviewer cross-check 2026-06-04)

| #   | Topic                     | Outcome                                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | iOS protocol              | Add `preview.open` to `SyncProtocol.swift` + `AppState.handleDataChannelMessage` (5-step checklist). Phase 1.                              |
| 2   | `serve` without tray      | Auto-enable tray on first invocation (calls existing `leaveTray({ switchTo: 'leader' })` path). Zero-config UX preserved.                  |
| 3   | Bridge default            | Opt-in (`serve --bridge` / `--interactive`); Cherry-opened previews default-on.                                                            |
| 4   | Dips + `open`             | Direct VFS read (no worker mint per dip / per `open`).                                                                                     |
| 5   | Bridge v1 command surface | Full surface: `eval`, `setOuterHTML`, `inject`, `requestReload`, `host-event`. (Larger attack surface accepted; bridge is opt-in.)         |
| 6   | Token revocation timing   | Phase 1. `serve --stop <token>` + `--list` + DO `revokePreview` + controller-WS broadcast invalidate.                                      |
| 7   | `--project` deprecation   | No-op alias with obsolete warning; scrub references from docs/skills/examples (single grep pass).                                          |
| 8   | Domain + staging DNS      | Prod `*.preview.sliccy.ai` + staging `*.preview.staging.sliccy.ai`; env-derived from tray worker base URL. Pre-Phase-1 infra prerequisite. |

## Risks

- **Worker becomes load-bearing for every `serve`.** Today's worker is signaling+coordination; it now handles preview traffic too. Capacity/cost monitoring becomes relevant. CF Workers scale well, but a busy demo could move the cost line. Recommendation: include preview request counts in the worker's existing observability surface (e.g. `/status` admin), and consider per-token rate limits if abuse becomes a concern.
- **TLS termination at the worker on both legs** is the genuine trust delta. The worker sees preview plaintext. Documented loudly; not a regression for "agent UI experimentation" content (the dominant use), is a continuation for everything else.
- **DNS / wildcard cert provisioning** has to land before Phase 1 can be useful in production. **Staging is the bigger risk** — `packages/cloudflare-worker/wrangler.jsonc` has no staging preview route today. Confirm prod + staging wildcards with infra before Phase 1 starts. Pre-flight check: does the existing CF zone allow `*.preview.sliccy.ai` and `*.preview.staging.sliccy.ai`?
- **Phase 3 deletion risk.** Removing `preview-sw.ts` from main is a destructive change. Gated on (a) prod soak of Phase 1, (b) Phase 1b consumer migration complete, (c) e2e replaced, (d) documented rollback plan.
- **Extension float wiring** (new — reviewer-flagged). `getPanelRpcClient()` is null in the extension offscreen; the `chrome.runtime` envelope path for `tray-open-preview` is its own surface to test. Without this, extension `serve` cannot mint or push previews.
- **iOS protocol step** (new — reviewer-flagged). iOS isn't "for free" — requires a Swift change (small but mandatory). 5-step checklist per `packages/ios-app/CLAUDE.md` keeps it routine.
- **Bridge command surface includes `eval`** (decision #5). The agent can run arbitrary expressions in the served-page realm. Mitigations: bridge is opt-in; served page's CSP applies; `<meta name="slicc-preview" content="no-bridge">` opt-out honored. Document in user-facing skills/docs that `--bridge` opens this capability.
- **LoC scale** (new — reviewer-flagged). Phase 1 is closer to 800–1500 LoC plus test ports — not the ~300 LoC "transfer" estimate that referred only to the federated-branch carry-over. Budget accordingly.

## Self-review (revised)

- **Spec covers each goal.** Goal 1 (one mechanism, no `--local`): Non-goals + Phase 3 + Phase 1b consumer migration. Goal 2 (real tabs everywhere): per-env matrix incl. iOS via Swift `preview.open`. Goal 3 (lazy/root-absolute/dynamic): URL scheme + manual checklist. Goal 4 (uniform live weave): bridge section + full v1 surface incl. `eval`. Goal 5 (security): three-layer model + renamed `isPathWithinServedRoot` + CORS detail. Goal 6 (resilience): three durations + timeouts + bridge auto-recovery. Goal 7 (worker takes responsibility): explicit.
- **No placeholders.** All 8 open questions are now in the Decisions section with concrete outcomes. Remaining items (large-binary streaming, observability hooks) are explicitly Phase-2 follow-ups, not unfinished design.
- **Internal consistency.** `preview.open` carries `{ url }` everywhere (TS protocol + iOS Swift). `previewToken` is DO-stored. `servedRoot` is on every leader-request. Bridge is opt-in (Cherry default-on). The `isPathWithinServedRoot` rename is consistent across security model + leader handler + testing. The `--project` no-op-with-warning behavior is consistent across `serve-command.ts` + docs scrub. Env-derived domain ties through URL scheme + worker routes + mint API.
- **Scope.** Single feature; four phases with one parallel slice; each phase independently shippable. Phase 1b is the surface-area completeness slice the reviewer correctly flagged.
- **Honest disclosure.** Seven risks acknowledged (worker capacity, TLS-termination trust delta, DNS/cert prerequisite incl. staging, Phase 3 deletion, extension wiring, iOS step, eval surface, LoC scale). The `eval`-in-v1 decision is documented as a deliberate trade against the reviewer's deferral recommendation, with mitigations.
- **Reviewer cross-check.** All 7 blocking gaps addressed (Phase 1b, extension float, iOS step, `--project` deprecation, dev/staging DNS, controller-WS union extension, mint HTTP API). All 5 important non-blocking items addressed (gate function rename + tests, MIME/dir-index handling, timeouts, CORS, shareable-link matrix tightening). LoC estimate revised honestly. Reviewer's "ready after gaps" verdict is the bar this revision targets.
