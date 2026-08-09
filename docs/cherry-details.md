# Cherry SDK details

Deep-dive material for `packages/cherry/`. The package guide
(`packages/cherry/CLAUDE.md`) is the entry point; this file expands the
sections that did not fit its size budget.

## `mountSlicc` field notes

- **`features` (`CherryFeatures`)** controls which UI panels the follower
  renders. Every field defaults to `true` when omitted. Setting a feature to
  `false` removes the panel entirely from the DOM — no tab, no placeholder.
  Features are static — resolved at mount time and sent in
  `handshake.welcome`; there is no runtime toggle. Separate from
  `capabilities` (which gates agent _powers_ over the host page); features
  gate _UI surfaces_ shown to the user.
- **Feature flags are separate from `CherryFeatures`.** The `?cherry=1` boot
  uses the shared registry in `feature-flags.ts` (Cherry default:
  `experimental-settings` off, hiding the dialog that would toggle these).
  `flags` on `mountSlicc` is the host's session-only bridge into that
  registry — same `userToggleable`-and-float gate a local override must pass;
  see `docs/layouts.md`. Not `SIDE_PANEL_FEATURES` in
  `cherry-panel-protocol.ts` (extension), which is mount-time `CherryFeatures`
  panel visibility, not a registry flag.
- **`theme`** accepts a `SliccTheme` object
  (`{ id, name, base, tokens, css?, disableShader?, components? }`) that the
  SDK serializes as JSON in the handshake welcome. The follower applies it on
  boot via `applyCherryTheme`, overriding its default appearance. Static —
  resolved at mount time; there is no runtime re-theme. The
  `examples/host.html` harness includes a dropdown with hardcoded brand
  presets, plus a custom-JSON textarea, for manual testing.
- **CSS-injection guard:** `theme.tokens`, `theme.css`, and every
  `components` property flow through `sanitizeTheme`
  (`packages/webapp/src/ui/theme-engine.ts`) before reaching the follower's
  `<style>` element — any value containing `url(`, `@import`, `expression(`,
  `javascript:`, angle brackets, or a call to a CSS function outside a small
  allowlist (`rgb`/`rgba`/`hsl`/`hsla`/`hwb`/`var`/`calc`/`clamp`/`min`/`max`)
  is dropped rather than partially escaped. This blocks the classic
  CSS-exfiltration vector (a host beaconing DOM state out via a themed
  `url(...)`) without requiring the host page itself to be trusted.
- **`layout`** pushes an arrangement into the follower, serialized as JSON in
  the handshake welcome and applied ONCE at boot — static, like `theme`.
  Structurally typed as `unknown` (this SDK ships independently, so no
  cross-package import). `wc-follower.ts` accepts EITHER shape, sniffed on
  the object: a `LayoutDocument` (has `base`) or the older `DockTreeSpec`
  (has `zones`) — embedders vendor the SDK and upgrade on their own
  schedule, so a version field older hosts never sent would be more brittle
  than sniffing. See `docs/layouts.md`. Set `locked: true` — tree-wide or
  per panel — so the user can't rearrange what was pushed. Applied WITHOUT a
  filesystem, so it can't persist or drift, and `layout save` in an embed
  reports it needs one rather than writing your arrangement into the user's
  profile. An invalid document falls back to the default.
  `examples/host.html` has a custom-JSON textarea for testing.

## Preview bootstrap (`serve --bridge`)

`src/preview-bootstrap.ts` is the injected bootstrap for driveable previews.
It opens the `/__slicc/bridge` WebSocket, runs `createCdpHostHandler` against
its **own** `document` (same-origin, no postMessage hop), and exposes
`window.slicc.emit(name, detail?)` / `window.slicc.on(name, cb)` to the page.
`emit` sends a `{ t:'emit', … }` frame over that same WebSocket (so the DO can
attribute it to this tab), falling back to
`navigator.sendBeacon('/__slicc/emit', …)` only when the socket isn't `OPEN`
— e.g. during page unload. Builds as a single classic IIFE (html2canvas-pro
bundled in) embedded into the worker, served at `/__slicc/preview-bridge.js`.

## Protocol version negotiation

Embedders **vendor** this SDK, so the two sides of the handshake routinely
run different builds. The contract that keeps that safe:

- The follower iframe posts one `handshake.hello` per entry in
  `SUPPORTED_CHERRY_PROTOCOL_VERSIONS` (newest first, same `channelId`) and
  pins the negotiated version from whichever `handshake.welcome` the host
  answers with. All subsequent envelopes — both directions — are stamped
  with the negotiated version. Version-gated envelope kinds (e.g.
  `session.export.*`, v2+) must not be used on a lower-negotiated channel.
- The host SDK accepts only its own `CHERRY_PROTOCOL_VERSION`. When a
  handshake attempt arrives at a version it cannot speak (and origin + source
  prove it is our iframe), it replies `handshake.version-mismatch` so the
  follower fails `connect()` fast with an actionable error instead of eating
  the handshake timeout, and fires `hooks.onProtocolMismatch`.
- **When bumping `CHERRY_PROTOCOL_VERSION`:** keep the previous version in
  `SUPPORTED_CHERRY_PROTOCOL_VERSIONS` and gate any new envelope kinds on
  the negotiated version. Removing a version from the supported set
  hard-breaks every embedder still shipping a vendored SDK at that version —
  do it only for a genuinely breaking wire change, and say so in the
  changelog. The 2026-07-27 labs incident (P1: every embed failed with an
  opaque 30s "Cherry handshake timed out") was caused by bumping 1 → 2 for
  an _additive_ feature while both sides still validated with strict
  equality.

## Manual end-to-end embed harness

`examples/host.html` is a throwaway host page for exercising a real embed.
It imports the built SDK (`../dist/index.js`), so run
`npm run build -w @ai-ecoverse/cherry` first. Steps:

1. `npm run dev` (webapp at `http://localhost:5710`); in that browser, avatar
   popover → **Enable multi-browser sync** to become a tray **leader**, and
   copy the `/join/…` URL it shows — that string is the `joinToken`.
2. Serve the repo root on a **different** origin
   (`npx http-server . -p 8080`) and open
   `http://localhost:8080/packages/cherry/examples/host.html`.
3. Paste the join URL, press **Mount**. The right-hand log shows handshake
   progress and `onSliccEvent` / `onOpenUrl` / `onPermissionRequest`
   callbacks. The **send event** row drives
   `handle.emitHostEvent(name, detail)` (detail is parsed as JSON, falling
   back to a string) so you can exercise the host → cone direction and
   watch the `[cherry]` lick land on the leader.

The host-page origin must differ from `sliccOrigin`, and `sliccOrigin` must
exactly match where the webapp is served — a mismatch fails the three-factor
`acceptEnvelope` gate (surfaces as a 30s handshake timeout, now logged). The
dev server does not apply the `frame-ancestors` CSP (only the worker does),
so local framing works without worker config.

**The harness mirrors real embedder code.** `host.html` is authored exactly
as a real consumer would write it —
`import { mountSlicc } from '@ai-ecoverse/cherry'`. A real embedder
`npm install`s the package and their bundler (or a CDN like esm.sh) resolves
it plus its `html2canvas-pro` dependency automatically. Since this SDK isn't
published yet and the harness has no bundler, `host.html` carries an
`importmap` (clearly labelled as plumbing) that maps the
`@ai-ecoverse/cherry` specifier to the local `dist/` and the
`html2canvas-pro` specifier to the copy in the repo's `node_modules` — the
same file a bundler would resolve. **Serve from the repo root**
(`npx http-server . -p 8080`) so both relative map paths resolve.

**Screenshots:** set the **screenshot** dropdown to `html2canvas` (it
defaults to `none`) _before_ Mount — capabilities are fixed at mount time.
The SDK is built with `tsc` (no bundling), so the screenshot path keeps a
bare `await import('html2canvas-pro')` (resolved per the import map above).
The renderer is the maintained **`html2canvas-pro`** fork — the original
`html2canvas@1.4.1` throws on CSS Color 4 syntax (`color()`, `oklch`, …);
the capability value stays `'html2canvas'`, only the implementation lib
differs. Cherry's screenshot is a best-effort DOM raster of `document.body`,
not a pixel-level CDP capture.
