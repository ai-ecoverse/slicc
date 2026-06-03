# Unified Preview — worker-relay + wildcard subdomain

- **Date:** 2026-06-04
- **Status:** Design — pending review
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

1. One mechanism for `serve` across all floats. No `--local` escape hatch. (See [Tradeoffs](#tradeoffs).)
2. Real interactive tabs everywhere — desktop, extension, cloud cone, Cherry-embedded host page, iOS, and arbitrary browsers opening a shared link.
3. **Lazy loads, root-absolute paths, dynamic `import()`** all just work — handled at the network layer.
4. **Live weaving** (agent mutates the rendered page after load) works uniformly via an opt-in **bridge channel** routed through the worker — no per-follower CDP plumbing required.
5. Security boundary: the leader's VFS read surface stays scoped to the agent-served root, including `..`/`.` traversal rejection and sibling-prefix rejection.
6. Resilience: brief leader flaps are absorbed by the worker; medium gaps (page reload within the tray reclaim window) keep URLs working; long gaps (tray expired) return a meaningful "session ended" page instead of an opaque 404.
7. Cloudflare-worker takes the new responsibility, in line with its existing position as the encrypted control plane.

## Non-goals

- **`--local` SW-only preview.** Rejected on the principle that keeping it dilutes every simplification win — see the "if we keep local, we don't get the benefits" thread in design discussion. The current SW-based local serve is replaced, not preserved.
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

- `packages/ios-app/SliccFollower/Models/SyncProtocol.swift` decodes unknown message types to `.unknown(type:)` (line 263) and `AppState.handleDataChannelMessage` has a `case .unknown:` arm. **`preview.open` is safely ignored** today; iOS gets byte-level rendering for free under the new design (it just opens a URL — `WKWebView` handles it).

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

For the **live-weave bridge**, see [Bridge channel](#bridge-channel).

### URL scheme — wildcard subdomain

```
https://<previewToken>.preview.sliccy.ai/<path>
       └─ unguessable, DO-issued capability  └─ path forwarded to leader as-is
```

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

### Protocol — worker ↔ leader (controller WS)

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

Reassembly is the same shape as today's federated FS: defensive sort by `chunkIndex`, concatenate, decode base64 if binary. Worker has an in-memory map `pending = Map<reqId, ResponseAssembler>`.

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

The script is **minimal and well-known** (versioned, code-reviewed, served by the worker). The page can opt out (`<meta name="slicc-preview" content="no-bridge">` honored by the worker) or the user can `serve --no-bridge` to mint a token with `allowLive: false`.

**Cherry interplay:** the preview iframe inside a Cherry embed runs the same injected bridge. The bridge's WS connects directly to `sliccy.ai` — it does NOT need to go through Cherry's `host.event`/`slicc.event` channel. So **Cherry's host SDK requires zero changes**: the host's `onOpenUrl` opens the URL in an iframe, the bridge inside takes over. This is the same uniform mechanism for all followers.

### Security model

**Trust boundaries:**

1. **Origin (browser):** each preview is its own origin → site isolation between previews. Cookies/storage/postMessage cannot cross preview origins.
2. **Capability (worker):** `previewToken` is unguessable; possession = view permission; revocable by deleting the DO record. Validated by host-header parse on every request.
3. **Path scope (leader):** every `preview.request` carries `servedRoot` from the DO; the leader's gate (`isWithinAllowedRoots`, with `..`/`.` traversal rejection and sibling-prefix rejection — the security helpers carried over from `worktree-federated-preview/packages/webapp/src/scoops/leader-preview-reader.ts`) refuses paths outside it. The leader serves nothing the agent didn't authorize via `serve`.
4. **Bridge script:** opt-in (`allowLive: true`), inline (no external resources), versioned, served by us, scoped to the preview's own origin. The script's WS auth is the `previewToken` in the URL; it cannot reach other previews or the leader's general controller channel.
5. **TLS:** end-to-end TLS on both hops (browser↔worker, worker↔leader-WS). The worker terminates TLS on both legs and handles **plaintext** between them — that's the deliberate trust delta vs the current P2P preview, where content stays inside the leader's browser. The worker is "us"; it already handles agent chat, tool I/O, webhooks. Preview content joining that set is a continuation of an existing trust assumption, not a new one. **Acknowledge this explicitly** in user-facing docs.

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

|                                                            | Byte delivery                               | Live weave (bridge)                                                         |
| ---------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Standalone (the agent's own browser viewing its own serve) | ✅ worker                                   | ✅                                                                          |
| Extension follower                                         | ✅ worker                                   | ✅                                                                          |
| Cloud cone, browser follower                               | ✅ worker                                   | ✅                                                                          |
| Cloud cone, Cherry embed                                   | ✅ worker (host SDK's `onOpenUrl`)          | ✅                                                                          |
| iOS follower                                               | ✅ worker (just opens the URL in WKWebView) | ✅                                                                          |
| Shareable link (random non-SLICC browser)                  | ✅ worker                                   | ✅ if `allowLive` and the agent is connected; degrades gracefully otherwise |

**One mechanism, one matrix row that always says yes.** That's the whole point.

## What transfers from `worktree-federated-preview` (and what doesn't)

### Transfers (re-implementable on this branch in ~300 LoC)

- **Security gate functions** (`isWithinAllowedRoots`, traversal rejection, sibling-prefix rejection) — moves leader-side, applied inside the `preview.request` handler.
- **The 9-test security suite** for `leader-preview-reader.test.ts` — port verbatim, target the new leader-side handler.
- **`preview.open` protocol message** — same shape, `url` field replaces `path`/`root`.
- **`tray-open-preview` panel-rpc op** — payload changes to mint a preview token via worker, response changes to `{ url, pushed }`.
- **`currentLeaderSync` getter** on `page-leader-tray.ts` — unchanged.
- **`serve` follower-push integration** — same shape; URL is now worker-served.
- **iOS `.unknown` decoder safety** — unchanged; iOS already ignores `preview.open`.

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

1. **Add wildcard binding** in `packages/cloudflare-worker/wrangler.jsonc`: `routes: ["*.preview.sliccy.ai/*"]` (already-managed CF zone provisions TLS automatically for `*.sliccy.ai` if a wildcard cert is enabled).
2. **Sub-domain dispatch:** `Worker.fetch(request)` parses `request.headers.get('host')`. If host matches `<token>.preview.sliccy.ai`, route to the preview handler; else the existing handler.

### Routes — preview handler

```
GET   /                          → fetch entry file via DO + worker→leader pipe
GET   /<path>                    → fetch file via DO + worker→leader pipe
GET   /__preview/bridge          → upgrade to WS for the bridge channel
POST  /__preview/lick (optional) → cooperative lick post (or use webhooks)
OPTIONS *                        → CORS preflight (mirrors the webhook OPTIONS shape if we add it)
```

Routes-mirror rule applies: `index.ts` routes + `tests/index.test.ts` + `tests/deployed.test.ts` (3-file update). The preview handler delegates to the DO (which holds tray + preview state) via the existing `DurableObjectNamespace` pattern.

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

async revokePreview(previewToken: string): Promise<void>;

// New WS message types received from the leader's controller socket:
// (leader-side responses to worker-issued preview.request)
```

Storage: `previews: Record<previewToken, PreviewRecord>` in the DO's persisted state. Deletion on tray expiry (cleaned up alongside the tray itself).

### Coverage and gates

- Per the worker package CLAUDE.md, coverage floor is 75% lines/statements, 65% branches, 85% functions. New code must keep us at/above floor.
- `wrangler deploy --dry-run` gate stays — wildcard binding must not push us over the 25 MiB asset cap (we're nowhere near it).

### CSP / framing

The preview origin is its own subdomain, served only by the worker — no static assets — so default CSP is restrictive by the absence of inline scripts (except the bridge, which is inline-by-injection). The bridge script's source-of-truth is the worker; its hash can be served as `Content-Security-Policy: script-src 'sha256-<bridgehash>' …` so even within the preview origin only the known bridge can inline-execute.

For HTML served to the preview tab: `Content-Security-Policy: frame-ancestors *` (so it can be iframed by Cherry hosts) or a configurable allow-list. Cache discipline: `Cache-Control: no-cache` (matches today's preview-SW behavior); content is leader-VFS-mutable.

## Leader-side changes

### Controller WS handler additions

```ts
// in page-leader-tray.ts or a new preview-host.ts
function onPreviewRequest(msg: PreviewRequest, ws: ControllerWebSocket): void {
  const { reqId, servedRoot, vfsPath, asText } = msg;
  // Security gate: vfsPath must be inside servedRoot. Existing helpers.
  if (!isWithinAllowedRoots(vfsPath, [servedRoot])) {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }
  // Read VFS; reuse handleReadFile + chunkContent from tray-fs-handler.ts.
  // Reply with one or more PreviewResponse chunks.
}
```

The leader stores no per-preview state; `servedRoot` arrives on every request. Survives leader reload trivially (the DO holds the truth).

### Worker→page `tray-open-preview` op (panel-rpc, repurposed)

```ts
op 'tray-open-preview' = {
  payload: { entryPath: string; servedRoot: string; allowLive?: boolean };
  result: { url: string; pushed: number };
};
```

The page-side handler:

1. Calls the worker to mint a previewToken: `POST https://sliccy.ai/api/tray/<trayId>/preview` (or a similar admin route auth'd with `controllerToken`).
2. Gets back `{ previewToken, url }`.
3. Broadcasts `preview.open { url }` to followers via `LeaderSyncManager.broadcastPreviewOpen`.
4. Returns `{ url, pushed }` to the shell.

### `serve` command — unchanged shape

`serve` still calls `getPanelRpcClient().call('tray-open-preview', ...)` unconditionally. With no rpc bridge (offline / no tray), `serve` reports the bare local URL (degrades to "you have no leader/tray; preview unavailable") — or we can decide to require a tray for `serve`, given the unification. Recommendation: **require a tray**. Without a tray there is no worker-served URL; the agent should `host enable` first. This is a UX call worth pinning in the spec — see Open Questions.

## Documentation updates

- `docs/shell-reference.md` — rewrite `serve`/`preview`/`open` sections for the worker URL model.
- `README.md` — note that previews are served from `sliccy.ai` subdomains and require an active tray.
- `docs/architecture.md` — replace the federated-preview tray-addendum with the unified mechanism; per-environment matrix.
- `packages/cloudflare-worker/CLAUDE.md` — new wildcard route, preview WS messages, DO PreviewRecord schema.
- `packages/webapp/CLAUDE.md` — Tray Sync section updated; remove SW-preview references.
- `packages/chrome-extension/CLAUDE.md` — drop preview-SW caveats; mention that previews open in regular tabs.
- Delete (or mark superseded): the federated-preview tray-addendum + the per-float caveat matrix from the prior spec.

## Testing strategy

### Worker

- DO `mintPreview` issues unguessable tokens, stores the record, validates `controllerToken`.
- Host-header parsing extracts the token correctly; bogus tokens → 404.
- `preview.request`/`preview.response` chunk reassembly into HTTP streaming responses (including binary base64 decode → bytes, MIME inference).
- Bridge WS upgrade path; messages routed to the leader's controller WS.
- `TRAY_EXPIRED` → "session ended" HTML page.
- Routes-mirror parity: `index.test.ts` + `deployed.test.ts` + `index.ts` agree.
- Coverage above floor (75% L/S, 65% B, 85% F).

### Webapp (leader side)

- `preview.request` handler: security gate (traversal/`.`/sibling-prefix); reads chunked; returns 404 on miss; binary base64; UTF-8 path.
- `tray-open-preview` panel-rpc: calls the worker, gets URL, broadcasts to followers.
- `serve` integration: with tray present, mints URL and reports it; without tray, helpful error.

### Webapp (follower side)

- Test that `preview.open { url }` follower handler still opens a tab at the given URL (background:true).
- Cherry: `Target.createTarget` is routed to `onOpenUrl`. Existing tests on the cherry branch already cover this; verify on merge.

### Manual (post-implementation)

- Multi-asset SPA with `<script src="./app.js">`, `<link rel="stylesheet" href="/styles.css">` (root-absolute), `import('./chunks/lazy.js')` — verify ALL three asset types load on every follower type.
- Cherry-host harness opens preview URL in an iframe; agent invokes `preview-emit` and the page reacts via the bridge.
- Reload the leader page mid-preview; observe the bridge surfaces `connection-lost` → `leader-reconnected`; new requests resume.
- Tray expiry: wait past `TRAY_RECLAIM_TTL_MS`; subsequent request returns "session ended" page.
- Security: from a served page, fetch `/workspace/.git/github-token` → 403; the leader is never asked.
- Shareable: copy URL to a different browser (no SLICC running) — bytes render, bridge degrades gracefully.

## Phasing

Three deployable slices:

**Phase 1 — wire delivery.** Worker wildcard route + DO `mintPreview` + `preview.request`/`preview.response` over controller WS + leader handler with security gate + `serve` mints + `preview.open { url }` to followers. _No bridge yet; previews are static-render-only._ This is enough to ship the byte-delivery story for every follower including iOS and Cherry.

**Phase 2 — bridge channel.** Worker bridge WS endpoint + injected script + leader-side `preview-emit` command + lick wire-up. Enables live weaving uniformly.

**Phase 3 — delete the SW preview path.** Once worker delivery is proven in production, retire `preview-sw.ts` from `main`. This is the deletion phase — net negative LoC.

Each phase is independently verifiable. Phase 1 is the bulk of the spec; phases 2 and 3 are clean follow-ons.

## Open questions

1. **`serve` without a tray.** Hard-require tray? Or fall back to a local-only ephemeral path? Recommendation: hard-require; `serve` prompts "enable multi-browser sync first" if no tray. Aligns with the architecture and avoids retaining the SW path as a fallback.
2. **Bridge default — opt-in or opt-out?** Recommendation: **opt-in** (`serve --interactive` or `--bridge`) for transparency, since the bridge injects code into served HTML. Cherry-routed previews could default-on (the bridge is the only path to live weaving there).
3. **Bridge protocol surface.** Minimal command set v1: `eval(js)`, `setOuterHTML(selector, html)`, `inject(scriptText)`, `requestReload()`, and a `host-event` channel mirroring Cherry's. Larger surface = more attack area; pick a tight initial subset.
4. **Token revocation UX.** Should the leader expose a "stop preview" action that revokes the previewToken DO-side? Probably yes, but it's a Phase 2 nicety.
5. **Range / large-binary handling.** Pure chunked-content reassembly is fine to ~few-MB. For larger assets (videos, big bundles), a streaming-mode in the worker that pumps `preview.response` chunks straight into a `TransformStream` body would avoid buffering. Phase 2.
6. **Sliccy.ai domain detail.** Use `*.preview.sliccy.ai` or another subdomain? Confirm with whoever owns DNS / TLS provisioning.

## Risks

- **Worker becomes load-bearing for every `serve`.** Today's worker is signaling+coordination; it now handles preview traffic too. Capacity/cost monitoring becomes relevant. CF Workers scale well, but a busy demo could move the cost line. Recommendation: include preview request counts in the worker's existing observability surface.
- **TLS termination at the worker on both legs** is the genuine trust delta. The worker sees preview plaintext. Documented loudly; not a regression for "agent UI experimentation" content (the dominant use), is a continuation for everything else.
- **DNS / wildcard cert provisioning** has to land before Phase 1 can be useful in production. Pre-flight check: does the existing CF zone allow `*.preview.sliccy.ai`? If not, the spec depends on infra work that's out of band.
- **Phase 3 deletion risk.** Removing `preview-sw.ts` from main is a destructive change for anyone iterating on a non-tray local serve. Phase 3 only after Phase 1 has soaked in production.

## Self-review

- **Spec covers each goal.** Goal 1 (one mechanism, no `--local`): non-goals + Phase 3 explicit. Goal 2 (real tabs everywhere): per-env matrix. Goal 3 (lazy/root-absolute/dynamic): URL scheme section + manual checklist. Goal 4 (uniform live weave): bridge section. Goal 5 (security): three-layer model with the existing gate ported. Goal 6 (resilience): three durations + bridge auto-recovery. Goal 7 (worker takes responsibility): explicit.
- **No placeholders.** "TBD" appears only in clearly-marked Open Questions, each of which is a real decision the implementation needs to land, not unfinished design.
- **Internal consistency.** `preview.open` carries `{ url }` everywhere it appears. `previewToken` is DO-stored everywhere. `servedRoot` is on every leader-request. The bridge is opt-in everywhere. The retire-`preview-sw` decision is consistent with the "one mechanism" goal.
- **Scope.** Single feature, single implementation plan possible. Phasing is clean.
- **Honest disclosure.** Three real risks acknowledged (worker capacity, TLS-termination trust delta, DNS/cert prerequisite). One genuine non-improvement (the `--local` rejection) defended with the "keeps caveats alive" reasoning.
