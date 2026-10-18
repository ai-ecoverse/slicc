# CLAUDE.md

Embedded-follower host SDK in `packages/cherry/`. Deep-dives (field
notes, preview bootstrap, version negotiation, harness):
[`docs/cherry-details.md`](../../docs/cherry-details.md).

## Scope

Dependency-light host-side SDK a **third-party web page** embeds. Mounts
a SLICC follower iframe (webapp with `?cherry=1`) and lends the host
page to a remote cloud-cone **leader** as a driveable, capability-limited
CDP target over postMessage-backed _synthetic_ CDP. Agent may navigate /
screenshot / open-url, never raw `Network.*`. Ships to third-party
origins; must NOT import `@slicc/webapp`.

## Main Files

- `src/index.ts` — public surface: `mountSlicc(options)`,
  `MountSliccOptions`, `HostCapabilities`, `HostHooks`, `SliccHandle`.
- `src/mount.ts` — `mountSliccImpl`: creates `?cherry=1` iframe, runs
  handshake, dispatches `cdp.request` via an injected host handler, posts
  `cdp.response` back. Holds `channelId` + `message` listener. No handler
  (ui-only) → every CDP method → `CherryUnsupportedError`.
- `src/embed-ui.ts` — side-panel `mountSlicc`; does **not** import
  `cdp-host-handlers.ts` (extension `sidepanel.js` 14 kB budget).
- `src/cdp-errors.ts` — `CherryUnsupportedError` (`code -32601`).
- `src/cdp-host-handlers.ts` — `createCdpHostHandler`: host-realm
  execution of the synthetic CDP subset. Injected by public `mountSlicc`
  (`index.ts`); also by `preview-bootstrap.ts`.
- `src/preview-bootstrap.ts` — driveable-preview bootstrap (same-origin
  previews for `serve --bridge`); opens `/__slicc/bridge` WS, runs
  `createCdpHostHandler` against its **own** `document` (no postMessage
  hop), exposes `window.slicc.emit`/`.on`.
- `scripts/build-preview-bootstrap.mjs` — esbuilds the IIFE → `PREVIEW_BRIDGE_JS`
  at `packages/cloudflare-worker/src/preview-bridge-assets.ts`. Runs at
  end of cherry `build` (also root `postinstall`; before worker).
  **`.gitignored` — never commit it** (~232 KiB minified).
- `src/protocol.ts` — postMessage envelope contract + three-factor
  `acceptEnvelope` gate. **Structural MIRROR** of the webapp copy.

## The `mountSlicc` surface

```ts
mountSlicc({
  container, // HTMLElement (optional when `iframe` provided)
  iframe, // Caller-provided iframe (opt-in)
  sliccOrigin, // worker-hosted webapp origin, e.g. https://app.sliccy.ai
  capabilities, // { navigate; screenshot: 'html2canvas'|'none'; openUrl }
  features, // CherryFeatures — per-panel toggles, default true
  theme, // SliccTheme — optional brand theme
  layout, // DockTreeSpec-shaped — optional pushed layout, usually locked
  flags, // { [flagId]: value } — feature-flag overrides
  hooks, // { onOpenUrl?, onSliccEvent?, onPermissionRequest?, onHandshakeComplete? }
  joinToken, // REQUIRED: existing tray join URL host provisioned
  uiOnly, // Opt-in: `ui-only=1` AFTER `cherry=1` (UI, no target)
}): SliccHandle; // { iframe, emitHostEvent(name, detail?), destroy() }
```

Field notes (theme, layout, screenshot) in the details doc. Invariants:

- **Scope:** SDK only **embeds** against a provisioned leader; host
  supplies a ready `joinToken`. Cone creation
  (`imsToken`/`coneName`/`createIfMissing`) is out of scope.
- **`iframe?`:** SDK uses the caller-placed iframe; `container` becomes
  optional. Used by the extension managed-launcher sidebar.
- **`uiOnly?`:** `ui-only=1` AFTER `cherry=1`; follower renders UI but
  advertises no CDP target. `cherry=1` MUST be present — the worker's
  `frame-ancestors` CSP relaxation and the follower's cherry-mode boot
  both key on it (CSP, not DNR).
- **Three axes:** `capabilities` gate _powers_ (sandbox-escaping — see
  boundary). `features` (`CherryFeatures`) gate _UI panels_ statically
  in `handshake.welcome`. `flags` bridge into `feature-flags.ts` (Cherry
  default: `experimental-settings` off) under the same
  `userToggleable`-and-float gate as local overrides (`docs/layouts.md`).
  Distinct from `SIDE_PANEL_FEATURES` (`cherry-panel-protocol.ts`):
  mount-time visibility, not a flag.
- **`theme`** flows through `sanitizeTheme`
  (`packages/webapp/src/ui/theme-engine.ts`) — blocks CSS-exfiltration
  via themed `url(...)`. **`layout`** applied ONCE at boot, no FS;
  `locked: true` blocks rearrange.
- **Hooks:** `onHandshakeComplete()` fires once per hello.
  `onPermissionRequest(domain)` gates each CDP domain (`false` →
  `-32601`). `onSliccEvent` observes `slicc.event` (**cone → host**).
  Transport sentinels `slicc.follower.ready`/`.disconnected`
  (`wc-follower.ts:onConnectionChange`); defer `emitHostEvent` until
  `ready`.
- **`emitHostEvent(name, detail?)`** — **host → cone**: posts
  `host.event` → `cherry.host_event`; leader emits a `cherry` lick
  (**Cherry Event**).

## Host-SDK ↔ iframe synthetic-CDP boundary

SDK on the **host page**; follower in the **iframe**. Iframe side:
`CherryHostTransport` (`packages/webapp/src/cdp/cherry-host-transport.ts`),
the **third** `CDPTransport`. Synthesizes session lifecycle locally
(`Target.*`, `Page`/`Runtime`/`DOM.enable`, `Page.getFrameTree`);
forwards the rest as `cdp.request`. SDK runs `createCdpHostHandler` in
the host realm; unimplemented methods → `CherryUnsupportedError`
(`-32601`).

**Two-tier gating**: `capabilities` gate sandbox-escaping effects
(`navigate`, `screenshot`, `openUrl`) — fail closed. DOM read/query and
`Input` (_within_ the page) are baseline; per-domain auth via
`onPermissionRequest`. **`Runtime.evaluate` governed by host CSP** —
_indirect_ `eval` in the host global scope; forbidden dynamic eval
throws → `exceptionDetails`. No escape hatch.

## Three-factor postMessage pinning

`acceptEnvelope()` validates every inbound message against three
independent factors before synthetic CDP acts:

1. **Origin allowlist** — `event.origin` ∈ `allowOrigins` (host passes
   `[sliccOrigin]`; iframe derives it from `document.referrer`, NOT
   `location.ancestorOrigins` — Chromium-only, not a portable trust root).
2. **Source identity** — `event.source` identity-equal to the expected
   window (`iframe.contentWindow` host-side; `window.parent` iframe-side).
   `null` accepts any source — pre-handshake only.
3. **`channelId` nonce** — `envelope.channelId` equals the pinned
   per-mount nonce (iframe mints `cherry-<uuid>` in `handshake.hello`).
   `null` skips factor 3 — pre-handshake only.

## Embedding only + iframe reload

SDK forwards `joinToken` over the handshake (→
`handshake.welcome.joinUrl`); follower embeds against the provisioned
leader. The SDK **never calls `/api/cloud/*` itself** — that is
cross-origin with a third-party `Authorization` header.

SDK survives an iframe reload without `destroy()` + `mountSlicc()`:
`onMessage` detects a **re-hello** (trusted-peer `handshake.hello`, new
channelId) and re-runs the handshake. Acceptance is host-side policy in
`mount.ts`, not `acceptEnvelope`; the gate stays strict (only
`handshake.hello` bypasses factor 3).

## Protocol mirror & version negotiation

`packages/cherry/src/protocol.ts` is a structural **MIRROR** of
`packages/webapp/src/cdp/cherry-host-protocol.ts` (same `CherryEnvelope`
union, `CHERRY_PROTOCOL_VERSION`, `SUPPORTED_CHERRY_PROTOCOL_VERSIONS`,
`isCherryEnvelope`, `AcceptContext`, `acceptEnvelope`; SDK copy has no
webapp import). **Change one → change the other.**

Embedders **vendor** this SDK; both sides run different builds (contract:
docs/cherry-details.md). Rules:

- Follower posts one `handshake.hello` per entry in
  `SUPPORTED_CHERRY_PROTOCOL_VERSIONS` (newest first, same `channelId`);
  pins the `handshake.welcome` the host answers. Version-gated kinds
  (e.g. `session.export.*`, v2+) must not run on lower channels.
- Host SDK accepts only its own `CHERRY_PROTOCOL_VERSION`; mismatch →
  `handshake.version-mismatch` (fires `hooks.onProtocolMismatch` so the
  follower fails fast, not on the 30s timeout).
- **Bumping:** keep the prior in `SUPPORTED_CHERRY_PROTOCOL_VERSIONS`,
  gate new kinds on the negotiated version. Removing one hard-breaks
  vendored SDKs — reserve for breaking wire changes.

## Build and test

```bash
npm run build -w @ai-ecoverse/cherry   # tsc -p tsconfig.build.json → dist/
npm test -w @ai-ecoverse/cherry        # vitest (jsdom)
```

Published to npm as `@ai-ecoverse/cherry` from the root release
(`release` job of `.github/workflows/release.yml`, gated by
`release-native.mjs --gate=cherry`; `docs/development.md`). Version
stamped at release time — leave `version` alone. Exports → `dist/`;
`README.md` is the npm page.

Default `tsconfig.json` is the noEmit typecheck config (incl. tests/).
`mountSliccImpl` and `CherryHostTransport` expose `test*` seams
(`__test_post`, `testReceive`) exercising the postMessage round-trip
without a real cross-origin window. Harness: `examples/host.html`.

## Transcript export

`handle.exportSession()` → `session.export.*` (request → one-time
leader approval → progress → response/error). Protocol, error codes,
`TranscriptExportError`:
[`docs/transcript-export.md`](../../docs/transcript-export.md).

## Related Guides

- `packages/webapp/CLAUDE.md` — `CherryHostTransport`, `?cherry=1` boot,
  `'cherry'` lick.
- `packages/cloudflare-worker/CLAUDE.md` — `?cherry=1` `frame-ancestors`
  CSP, `ALLOWED_CHERRY_HOST_ORIGINS`, cache isolation.
- `packages/vfs-root/workspace/skills/cherry/SKILL.md` — cone skill.
- `docs/cherry-details.md`, `docs/transcript-export.md`,
  `docs/architecture.md` (topology/matrix).
