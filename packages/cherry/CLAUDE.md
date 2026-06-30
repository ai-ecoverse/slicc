# CLAUDE.md

This file covers the embedded-follower host SDK in `packages/cherry/`.

## Scope

`@ai-ecoverse/cherry` is a tiny, dependency-light host-side SDK that a **third-party
web page** embeds. It mounts a SLICC follower in an iframe (the webapp loaded
with `?cherry=1`) and lends the host page to a remote cloud-cone **leader** as a
driveable, capability-limited CDP target — over cooperative, postMessage-backed
_synthetic_ CDP. The host page becomes a browser target the remote agent can
navigate / screenshot / open-url on, but **never** drive raw `Network.*` against.

This package ships independently to third-party origins, so it must NOT import
from `@slicc/webapp`.

## Main Files

- `src/index.ts` — public surface: `mountSlicc(options)`, `MountSliccOptions`,
  `HostCapabilities`, `HostHooks`, `SliccHandle`.
- `src/mount.ts` — `mountSliccImpl`: creates the `?cherry=1` iframe, runs the
  handshake, dispatches inbound `cdp.request` envelopes through the host
  handlers, and posts `cdp.response` back. Holds the per-mount `channelId` and
  the `window` `message` listener.
- `src/cdp-host-handlers.ts` — `createCdpHostHandler`: host-realm execution of
  the synthetic CDP subset, plus `CherryUnsupportedError` (`code = -32601`).
- `src/protocol.ts` — the postMessage envelope contract and the three-factor
  `acceptEnvelope` gate. **Structural MIRROR** of the canonical webapp copy (see
  below).

## The `mountSlicc` surface

```ts
mountSlicc({
  container, // HTMLElement the follower iframe is appended to (required)
  sliccOrigin, // origin serving the worker-hosted webapp, e.g. https://app.sliccy.ai
  capabilities, // { navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean }
  features, // { terminal?: boolean; files?: boolean; memory?: boolean } — all default true
  hooks, // { onOpenUrl?, onSliccEvent?, onPermissionRequest?, onHandshakeComplete? }
  joinToken, // REQUIRED: existing tray join URL the host (or its backend) provisioned
}): SliccHandle; // { iframe, emitHostEvent(name, detail?), destroy() }
```

> **Scope:** this SDK only **embeds** against an already-provisioned leader —
> the host supplies a ready `joinToken` (a tray join URL). Creating/provisioning
> a cloud cone from the SDK (the old `imsToken` / `coneName` / `createIfMissing`
> path) is deliberately **out of scope** and tracked as future work. See the
> design doc's descope note.

- `CherryFeatures` controls which UI panels the follower renders. Each field
  defaults to `true` when omitted. Setting a feature to `false` removes the panel
  entirely from the DOM (no tab, no placeholder). Features are static — resolved
  at mount time and sent in `handshake.welcome`; there is no runtime toggle.
  Separate from `capabilities` (which gates agent _powers_ over the host page);
  features gate _UI surfaces_ shown to the user.
- `HostCapabilities.screenshot` is `'html2canvas' | 'none'` — a strategy, not a
  boolean. The host SDK lazily `import()`s `html2canvas` only when a screenshot
  is requested under the `'html2canvas'` strategy.
- `hooks.onHandshakeComplete()` fires once after the handshake completes and the
  channelId is pinned (synchronous, single-shot per hello).
- `hooks.onPermissionRequest(domain)` gates each synthetic CDP domain the leader
  tries to use (return `false` to deny — the SDK answers `-32601`).
- `hooks.onSliccEvent(name, detail)` observes `slicc.event` envelopes (telemetry, plus the host's `open-url` convenience path) — the **cone → host** direction. The follower also emits two transport-layer (not cone-routed) sentinels: `slicc.follower.ready` when the WebRTC channel to the leader connects, and `slicc.follower.disconnected` on transient drops AND on terminal `onGaveUp` (so the host always gets an authoritative "stop emitting" signal — see `wc-follower.ts:onConnectionChange` and `onGaveUp`). Hosts should defer `emitHostEvent` calls until `ready` arrives, since `emitHostEvent` calls that reach the follower before the tray channel is open are silently dropped.
- `SliccHandle.emitHostEvent(name, detail?)` is the **host → cone** direction: the host page emits a named event that posts a `host.event` envelope to the follower, which forwards it over the tray channel as `cherry.host_event`; the leader turns it into a `cherry` lick (labeled **Cherry Event**) on the cone. No-ops with a warning before the handshake completes (no `channelId` to pin it to).

## Host-SDK ↔ iframe synthetic-CDP boundary

- The SDK runs on the **host page**; the follower runs in the **iframe**. They
  speak the cherry envelope protocol over `postMessage`.
- The iframe side is `CherryHostTransport`
  (`packages/webapp/src/cdp/cherry-host-transport.ts`) — the **third**
  `CDPTransport`. It synthesizes the session lifecycle `BrowserAPI` expects
  (`Target.getTargets` / `attachToTarget`, `Page`/`Runtime`/`DOM.enable`,
  `Page.getFrameTree`) locally and forwards everything else to the host SDK as
  `cdp.request`.
- The SDK answers `cdp.request` by running `createCdpHostHandler` against the
  host page realm. Methods the host did not opt into (or Cherry does not
  implement) throw `CherryUnsupportedError` → `cdp.response.error` with code
  `-32601`.
- **Two-tier gating** (by design): the `capabilities` booleans gate side effects
  that ESCAPE the page sandbox — `navigate`, `screenshot`, `openUrl` — and fail
  closed in the handler. DOM read/query and `Input` (clicking/typing _within_ the
  page) are the baseline driveable contract; per-domain authorization is enforced
  upstream by `onPermissionRequest` at the mount layer, so the handler does not
  re-gate them.
- **`Runtime.evaluate` is governed by the host page's CSP.** The handler runs an
  _indirect_ `eval` in the host global scope; if the host CSP forbids dynamic
  eval it throws natively and surfaces as `exceptionDetails`. Cherry adds no
  escape hatch.

## Three-factor postMessage pinning

Every inbound message is validated by `acceptEnvelope()` against three
independent factors before any synthetic CDP is acted on:

1. **Origin allowlist** — `event.origin` must be in `allowOrigins` (the host
   passes `[sliccOrigin]`; the iframe derives it from `document.referrer`).
2. **Source identity** — `event.source` must be identity-equal to the expected
   window (`iframe.contentWindow` on the host side; `window.parent` on the iframe
   side). `null` accepts any source — only used pre-handshake.
3. **`channelId` nonce** — `envelope.channelId` must equal the pinned per-mount
   nonce (the iframe mints `cherry-<uuid>` in `handshake.hello`). `null` skips
   this factor, only during the pre-handshake window.

## Embedding only — the host supplies the join URL

The SDK forwards the host-supplied `joinToken` over the handshake
(→ `handshake.welcome.joinUrl`); the follower embeds against that
already-provisioned leader. The SDK **never calls `/api/cloud/*` itself** — that
would be a cross-origin call from the third-party host carrying a third-party
`Authorization` header.

Cone creation/provisioning from the SDK is **out of scope** for now. The host
page (or its own backend) is responsible for obtaining a join URL and passing it
in as `joinToken`. The earlier in-iframe provisioning path (forwarding an IMS
bearer + `coneName` + `createIfMissing` so the same-origin iframe could drive
`/api/cloud/*`) was removed because a third-party host's IMS token is issued to a
different client than the cloud LLM proxy and so fails `validateBearer`, and
because passing secrets through the browser handshake exposes them to the host
page's user. Reintroducing creation is tracked as a separate future PR; see the
design doc's descope note.

## Protocol mirror invariant

`packages/cherry/src/protocol.ts` is a structural **MIRROR** of the canonical
`packages/webapp/src/cdp/cherry-host-protocol.ts`. The two must stay in sync —
same `CherryEnvelope` union, `CHERRY_PROTOCOL_VERSION`, `isCherryEnvelope`,
`AcceptContext`, and the three-factor `acceptEnvelope` gate. The ONLY intended
difference is the package location (the SDK copy carries no webapp import). When
you change one, change the other.

## Build and test

```bash
npm run build -w @ai-ecoverse/cherry   # tsc -p tsconfig.json → dist/
npm test -w @ai-ecoverse/cherry        # vitest (jsdom)
```

`mountSliccImpl` and `CherryHostTransport` both expose `__test_*` seams (e.g.
`__test_post`, `__test_receive`) so the postMessage round-trip can be exercised
without a real cross-origin window.

### Manual end-to-end embed harness

`examples/host.html` is a throwaway host page for exercising a real embed. It
imports the built SDK (`../dist/index.js`), so run `npm run build -w @ai-ecoverse/cherry`
first. Steps:

1. `npm run dev` (webapp at `http://localhost:5710`); in that browser, avatar
   popover → **Enable multi-browser sync** to become a tray **leader**, and copy
   the `/join/…` URL it shows — that string is the `joinToken`.
2. Serve the repo root on a **different** origin (`npx http-server . -p 8080`)
   and open `http://localhost:8080/packages/cherry/examples/host.html`.
3. Paste the join URL, press **Mount**. The right-hand log shows handshake
   progress and `onSliccEvent` / `onOpenUrl` / `onPermissionRequest` callbacks.
   The **send event** row drives `handle.emitHostEvent(name, detail)` (detail is
   parsed as JSON, falling back to a string) so you can exercise the host → cone
   direction and watch the `[cherry]` lick land on the leader.

The host-page origin must differ from `sliccOrigin`, and `sliccOrigin` must
exactly match where the webapp is served — a mismatch fails the three-factor
`acceptEnvelope` gate (surfaces as a 30s handshake timeout, now logged). The dev
server does not apply the `frame-ancestors` CSP (only the worker does), so local
framing works without worker config.

**The harness mirrors real embedder code.** `host.html` is authored exactly as a
real consumer would write it — `import { mountSlicc } from '@ai-ecoverse/cherry'`.
A real embedder `npm install`s the package and their bundler (or a CDN like
esm.sh) resolves it plus its `html2canvas-pro` dependency automatically. Since
this SDK isn't published yet and the harness has no bundler, `host.html` carries
an `importmap` (clearly labelled as plumbing) that maps the `@ai-ecoverse/cherry`
specifier to the local `dist/` and the `html2canvas-pro` specifier to the copy in
the repo's `node_modules` — the same file a bundler would resolve. **Serve from
the repo root** (`npx http-server . -p 8080`) so both relative map paths resolve.

**Screenshots:** set the **screenshot** dropdown to `html2canvas` (it defaults to
`none`) _before_ Mount — capabilities are fixed at mount time, so changing it
afterward does nothing. The SDK is built with `tsc` (no bundling), so the
screenshot path keeps a bare `await import('html2canvas-pro')` (resolved per the
import map above). The renderer is the maintained **`html2canvas-pro`** fork —
the original `html2canvas@1.4.1` throws on CSS Color 4 syntax (`color()`,
`oklch`, …), which is common on real host pages; the capability value stays
`'html2canvas'` (the strategy), only the implementation lib differs. Cherry's
screenshot is a best-effort DOM raster of `document.body`, not a pixel-level CDP
capture.

## Related Guides

- `packages/webapp/CLAUDE.md` — `CherryHostTransport`, the `?cherry=1` boot mode,
  and the `'cherry'` lick type.
- `packages/cloudflare-worker/CLAUDE.md` — the `?cherry=1` `frame-ancestors` CSP,
  `ALLOWED_CHERRY_HOST_ORIGINS`, and cache isolation.
- `packages/vfs-root/workspace/skills/cherry/SKILL.md` — the cone-facing skill.
- `docs/architecture.md` — float topology + the synthetic-CDP translation matrix.
