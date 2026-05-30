# CLAUDE.md

This file covers the embedded-follower host SDK in `packages/cherry/`.

## Scope

`@slicc/cherry` is a tiny, dependency-light host-side SDK that a **third-party
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
  hooks, // { onOpenUrl?, onSliccEvent?, onPermissionRequest? }
  imsToken, // optional IMS bearer forwarded into the iframe for provisioning
  coneName, // target cone to resume/start
  createIfMissing, // start a new cone when none matches
  joinToken, // existing tray join URL — bypasses provisioning entirely
}): SliccHandle; // { iframe, destroy() }
```

- `HostCapabilities.screenshot` is `'html2canvas' | 'none'` — a strategy, not a
  boolean. The host SDK lazily `import()`s `html2canvas` only when a screenshot
  is requested under the `'html2canvas'` strategy.
- `hooks.onPermissionRequest(domain)` gates each synthetic CDP domain the leader
  tries to use (return `false` to deny — the SDK answers `-32601`).
- `hooks.onSliccEvent(name, detail)` observes `slicc.event` envelopes (telemetry, plus the host's `open-url` convenience path).

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

## Provisioning runs iframe-side, same-origin

The SDK **never calls `/api/cloud/*` itself** — that would be a cross-origin call
from the third-party host carrying a third-party `Authorization` header. Instead:

- The host SDK forwards either a ready `joinToken` (→ `handshake.welcome.joinUrl`)
  OR the `imsToken` + `coneName` + `createIfMissing` (→ `handshake.welcome.auth`)
  into the iframe over the handshake.
- The iframe is **same-origin with the worker**, so it runs the `/api/cloud/*`
  orchestration (`packages/webapp/src/ui/main-cherry.ts:resolveCherryJoinUrl`):
  `list` → resume/use-running → start-if-missing → join URL.

### IMS-token-never-leaves-the-browser invariant

The IMS bearer is **browser-resident only**. It flows from the host page into the
iframe over the handshake and is used solely for the iframe's same-origin
`/api/cloud/*` calls. It is **never persisted, never logged, never re-emitted**,
and **never forwarded to any third-party origin or E2B sandbox**. On the iframe
side it is held in memory on `CherryHostTransport.provisioningAuth` and consumed
once.

## Protocol mirror invariant

`packages/cherry/src/protocol.ts` is a structural **MIRROR** of the canonical
`packages/webapp/src/cdp/cherry-host-protocol.ts`. The two must stay in sync —
same `CherryEnvelope` union, `CHERRY_PROTOCOL_VERSION`, `isCherryEnvelope`,
`AcceptContext`, and the three-factor `acceptEnvelope` gate. The ONLY intended
difference is the package location (the SDK copy carries no webapp import). When
you change one, change the other.

## Build and test

```bash
npm run build -w @slicc/cherry   # tsc -p tsconfig.json → dist/
npm test -w @slicc/cherry        # vitest (jsdom)
```

`mountSliccImpl` and `CherryHostTransport` both expose `__test_*` seams (e.g.
`__test_post`, `__test_receive`) so the postMessage round-trip can be exercised
without a real cross-origin window.

## Related Guides

- `packages/webapp/CLAUDE.md` — `CherryHostTransport`, the `?cherry=1` boot mode,
  and the `'cherry'` lick type.
- `packages/cloudflare-worker/CLAUDE.md` — the `?cherry=1` `frame-ancestors` CSP,
  `ALLOWED_CHERRY_HOST_ORIGINS`, and cache isolation.
- `packages/vfs-root/workspace/skills/cherry/SKILL.md` — the cone-facing skill.
- `docs/architecture.md` — float topology + the synthetic-CDP translation matrix.
