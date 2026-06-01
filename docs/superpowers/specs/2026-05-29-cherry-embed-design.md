# Cherry — Embedded SLICC Follower (`@slicc/cherry`)

**Status:** Design / approved through brainstorming (revised after design review)
**Date:** 2026-05-29
**Owner:** Karl
**Spec:** this document

> **Descope note (2026-06-01):** The shipped PR implements **embedding only** —
> the host (or its own backend) supplies a ready tray join URL as the required
> `joinToken`, and the follower embeds against that already-provisioned leader.
> The **cloud-cone creation / provisioning** path documented below (the
> `imsToken` / `coneName` / `createIfMissing` options, `handshake.welcome.auth`,
> the iframe-side `/api/cloud/*` orchestration in `resolveCherryJoinUrl`, and the
> `CherryHostTransport.provisioningAuth` field) was **removed before merge** and
> is deferred to a separate future PR.
>
> Two reasons drove the descope: (1) a third-party host's IMS token is issued to
> a different client than the cloud LLM proxy, so it fails `validateBearer`
> (`packages/cloudflare-worker/src/cloud/auth.ts`) and cannot double as the
> sandbox inference credential; and (2) passing any secret through the browser
> handshake exposes it to the host page's user. A future creation PR must solve
> identity-vs-inference-credential decoupling and a server-side secret-hiding
> path (e.g. a worker-side per-user vault + claim-check) before reintroducing
> provisioning. The provisioning design below is retained as the historical
> record for that future work.

## Summary

Cherry lets a third-party web page embed a live SLICC follower inside an
iframe and **lend its own page to the agent as a driveable CDP target**. The
embedding host loads a small SDK (`@slicc/cherry`), drops a SLICC iframe into a
container, and wires a handful of host capabilities (navigate, screenshot,
permission prompt). From that point a remote SLICC **leader** (a cloud cone)
drives the host page through the existing federated-CDP / tray machinery.

The garnish metaphor: a **cherry** sits on top of someone else's sundae (their
page) and is driven by the cone underneath.

### What this is, precisely

- **Cherry is an ordinary tray _follower_** (the `page-follower-tray.ts` code
  path) with a **new `CDPTransport` whose backend is the host page reached over
  `postMessage`** — not a WebSocket (CLI) or `chrome.debugger` (extension).
- **But the transport is not the hard part.** The real work is a **synthetic
  CDP session model**: `BrowserAPI` opens every target with
  `Target.getTargets` → `attachToTarget` → `Page.enable`/`Runtime.enable` →
  `Page.getFrameTree`, _before_ any `Runtime.evaluate`. Cherry must emulate that
  whole session lifecycle, plus **advertise target capability metadata** so the
  leader never routes a flow (teleport, tab-open, cookie ops) to a Cherry
  target that cannot satisfy it. See [Synthetic CDP session
  model](#synthetic-cdp-session-model) and [Target capability
  metadata](#target-capability-metadata).
- **The driver is remote.** The embedded follower does not run the cone. A
  remote leader (cloud cone) issues CDP over the WebRTC tray data channel; the
  follower translates those CDP calls into operations on the host page via the
  host SDK. Topologically identical to how the iOS and browser tray followers
  already advertise and serve targets to the leader.
- **The host page is a single target.** The host page's top frame is the one
  and only CDP target Cherry exposes. Same-origin nested iframes are reached
  via `Runtime.evaluate` against the top frame, not as separate targets.
  Cross-origin frames are not driveable (browser security; no extension
  present).

**Skill compatibility is a subset, not "unchanged."** The common DOM / input /
evaluate / screenshot / aria-snapshot skills work as-is against a Cherry
target. Skills that depend on `Network.*` (cookie import/export, teleport) and
on multi-target / cross-origin frame stitching (`Page.createIsolatedWorld`
across origins, remote tab opening) are **unsupported on Cherry targets** in v1
and must be capability-gated and documented, not silently broken. See [Skill
compatibility](#skill-compatibility-explicit).

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
   target — the common DOM/input/evaluate/screenshot skills work against it
   unmodified; unsupported domains fail cleanly and visibly.
3. Provisioning works from either a `joinUrl` **or** an IMS token (creating /
   resuming a cloud cone via the existing `/api/cloud/*` worker API), with the
   provisioning fetches issued **from inside the iframe** (same-origin with the
   worker) so no third-party CORS surface is introduced.
4. Bidirectional application events: host → SLICC and SLICC → host, riding the
   existing tray data channel to the remote leader, addressed by runtime/mount
   so they survive multi-follower topologies.
5. Strict origin pinning **plus** `event.source` identity **plus** a per-mount
   channel nonce on every `postMessage` envelope, both directions.
6. Dual-mode parity is **not** required of the host page (the host is neither
   "CLI" nor "extension" SLICC) — but the SLICC build that runs _inside_ the
   Cherry iframe is the ordinary webapp build and must keep working in its
   normal floats.

## Non-Goals (v1)

- **Cross-origin frame driving.** Only the host top frame (+ same-origin
  reachable DOM) is driveable. Cross-origin iframes inside the host are opaque.
- **`Network.*` CDP domain.** No request interception / network emulation, and
  therefore **no cookie import/export and no teleport** on Cherry targets.
- **New cloudflare-worker _endpoints_.** Provisioning reuses `/api/cloud/*`
  verbatim, so the routes-mirror rule is not triggered. (This is distinct from
  the worker **header/CSP** change Cherry does require — see [Cherry boot mode
  - worker framing policy](#cherry-boot-mode--worker-framing-policy).)
- **Multiple host-page targets.** Exactly one target per Cherry mount.
- **Driveable agent-opened tabs.** `Target.createTarget` is a clean unsupported
  error; an optional courtesy `window.open` is a host _application event_, not a
  CDP target (see [createTarget](#createtarget-clean-error--courtesy-window-open-as-an-app-event)).
- **Pixel-perfect / full-fidelity screenshots.** `html2canvas` cannot read
  cross-origin-tainted pixels and misses canvas/video/WebGL/shadow-DOM cases;
  screenshots are explicitly best-effort.
- **Driving native/OS surfaces** the host page itself cannot reach.

## Architecture

### Topology

```
┌─────────────────────────── Host page (e.g. AEM, https://author.example.com) ──┐
│                                                                                │
│   @slicc/cherry SDK  ──postMessage(origin + source + nonce pinned)──┐          │
│   (host realm: DOM, router, html2canvas)                            │          │
│                                                                     ▼          │
│        ┌──── <iframe src=sliccy.ai/?cherry=1>  (webapp, Cherry boot mode) ──┐  │
│        │  CherryHostTransport (CDPTransport impl + synthetic CDP session)   │  │
│        │  iframe-side cloud provisioning (same-origin /api/cloud/*)         │  │
│        │            │                                                       │  │
│        │            ▼  serves a synthetic CDP session for the host target   │  │
│        │  FollowerTrayManager  ── WebRTC data channel ─────────────────────┼──┼──▶ Cloud cone (LEADER)
│        └────────────────────────────────────────────────────────────────────┘  │   - runs the cone/orchestrator
│                                                                                │   - BrowserAPI drives the
└────────────────────────────────────────────────────────────────────────────┘     advertised host target
```

- **Host realm:** owns the DOM, the SPA router, screenshots. Speaks the inner
  Cherry envelope over `postMessage` to the iframe.
- **Cherry iframe:** the standard webapp booted in Cherry mode, running as a
  tray follower. Hosts `CherryHostTransport` (incl. the synthetic CDP session),
  does cloud provisioning same-origin, and advertises the host page as a
  capability-tagged CDP target. Holds no agent — it is a pass-through driver
  surface.
- **Leader (cloud cone):** the actual agent. Issues CDP over the data channel;
  receives host application events; emits SLICC application events.

### The reuse, and where it stops

`packages/webapp/src/ui/page-follower-tray.ts` already boots a follower with
auto-reconnect, wires a `FollowerSyncManager`, and **advertises local CDP
targets to the leader on an interval** (`refreshTargets` → `advertiseTargets`).
The leader's `BrowserAPI` then drives those targets via `cdp.request` /
`cdp.response` over the data channel (federated CDP). Everything north of the
transport — target advertisement, federation, the leader's `BrowserAPI`,
`playwright-cli` — is reused.

What Cherry must build (this is the bulk of the work):

1. A `CherryHostTransport` whose backend is the host SDK over `postMessage`.
2. A **synthetic CDP session** inside that transport (target/session/enable
   lifecycle), not just leaf-method translation.
3. **Target capability metadata** on the advertised target + a distinct
   `slicc-cherry` runtime, so the leader's selection logic (teleport,
   tab-open) skips Cherry for flows it cannot satisfy.
4. Host-side CDP emulation with an explicit supported subset and failure shapes.

## Cherry boot mode + worker framing policy

**No new route.** The iframe loads the existing webapp (already served by the
worker as static assets) in a **boot variant**, signaled by `?cherry=1` (peer
of the existing `?detached=1`). `main.ts` branches into Cherry follower wiring
when the flag is present (and it is framed with a pending handshake). This keeps
"no new worker endpoints" true.

**Framing policy is a real worker change (headers, not routes).** Today `/cloud`
sends `frame-ancestors 'none'` and the generic SPA fallback's framing policy is
unspecified. The Cherry boot response needs an **intentional
`Content-Security-Policy: frame-ancestors`** allowing the configured host
origins (and the rest of the app must stay `frame-ancestors 'none'` so the full
app cannot be framed broadly). The allowed-ancestor origin list is worker
config (env var, CSV — same shape as the cloud-cone allowlist vars). This is a
header/CSP change in `packages/cloudflare-worker/src/index.ts`, **not** a new
route, so the routes-mirror rule does not apply — but it must be deliberate and
tested.

**The header must be applied with cache discipline, because the SPA is served
unwrapped.** `serveSPA(request, env)` is just `return env.ASSETS.fetch(request)`
(`index.ts:52`) — it returns the asset response directly, so there is no
existing seam to attach a header and the same underlying asset backs both `/`
and `/?cherry=1`. Cherry must:

- **Clone the response** (`new Response(res.body, res)`) before mutating headers
  — `ASSETS.fetch` responses have immutable headers.
- **Branch on `?cherry=1`**: set `frame-ancestors <host origins>` only on the
  Cherry variant; leave (or set) `frame-ancestors 'none'` for the bare app so a
  cache bleed can never make the full app framable.
- **Keep the two variants from sharing a cache entry.** The query string differs
  (`/` vs `/?cherry=1`), but the CSP header now varies on a request property, so
  set `Vary` / an explicit cache key (or `Cache-Control: no-store` on the Cherry
  variant) so an edge/browser cache cannot serve the `'none'` body where the
  `frame-ancestors <hosts>` body is required, or vice-versa. The worker framing
  test must assert both variants independently.

## New & changed components

### New package: `packages/cherry/` (`@slicc/cherry`)

The host-side SDK. A new npm workspace ships a tiny, dependency-light ES module
(plus an optional `html2canvas` lazy import) with entry point `mountSlicc()`.

**Adding a workspace touches more than `workspaces` — every explicit list in the
repo must be updated or the package silently misses a gate.** This repo does not
rely on globs for its gates; the build, typecheck, and test wiring are all
explicit enumerations (see the root `CLAUDE.md` build/typecheck commands and
`vitest.config.ts` `projects`). Concretely, adding `packages/cherry` requires:

1. **`package.json` `workspaces`** — add `packages/cherry`.
2. **`package.json` `build` script** — the build is an explicit `-w` chain
   (`shared-ts → … → cloudflare-worker → …`); insert `@slicc/cherry` at the
   right point (after `shared-ts`, before anything that would consume it).
3. **`package.json` `typecheck` script** — the explicit tsconfig list must gain
   `packages/cherry/tsconfig.json` (a **new** tsconfig for the package).
4. **`vitest.config.ts` `projects`** — add a `packages/cherry` project so its
   tests actually run.
5. **`package.json` `test:coverage:cherry` script** + a per-package **coverage
   floor** and a **CI job** in `.github/workflows/ci.yml` (and the CI
   path-filter buckets), mirroring how the other packages are gated.
6. **`package-lock.json`** — regenerated via `npm install` so the new workspace
   is locked.
7. **`knip`** config (if the repo's dead-code check enumerates entry points) so
   the SDK entry/exports are not flagged as unused.

```ts
export interface MountSliccOptions {
  /** URL of the SLICC webapp booted in Cherry mode (e.g.
   *  https://sliccy.ai/?cherry=1). Defaults to the canonical sliccy.ai boot. */
  iframeUrl?: string;

  /** Provision via an existing tray join URL … */
  joinUrl?: string;
  /** … OR provision a cloud cone from an IMS token. Exactly one of
   *  joinUrl / auth is required. The token is handed to the iframe over the
   *  pinned handshake; the iframe (same-origin with the worker) does the
   *  /api/cloud/* calls. The host page never calls the cloud API directly. */
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
   *  Omit to make Page.navigate a clean unsupported error. */
  navigate?: (url: string) => void | Promise<void>;
  /** Page.captureScreenshot strategy. Default 'html2canvas'. */
  screenshot?: 'html2canvas' | 'none';
  /** Optional handler for the cone's courtesy "open this URL" application
   *  event (NOT CDP Target.createTarget — see spec). Omit to ignore the
   *  request. Typically `(url) => window.open(url, '_blank')`. */
  openUrl?: (url: string) => void;
}

export interface HostHooks {
  onAgentReady?: () => void;
  onAgentDisconnect?: (reason: string) => void;
  /** Gate sensitive CDP verbs (navigate, …). Return false to deny.
   *  Default-allow when omitted. */
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

**Provisioning happens iframe-side (kills CORS).** When `auth` is given, the
host SDK passes `{ token, coneName, createIfMissing }` into the iframe over the
pinned handshake. The iframe — same-origin with the worker — runs the
orchestration against the existing API (no new endpoints):

1. `GET /api/cloud/list` (Bearer = `auth.token`).
2. If `coneName` matches an existing cone:
   - `paused` → `POST /api/cloud/resume { sandboxId }`.
   - `running` → use its `joinUrl`.
3. If no match and `createIfMissing` → `POST /api/cloud/start { name: coneName }`.
4. Otherwise report a "no cone" error back to the host (`onAgentDisconnect`).
5. The iframe starts the follower against the resolved `joinUrl`.

Because these fetches are same-origin (sliccy.ai → sliccy.ai), there is **no
preflight and no third-party `Authorization` CORS surface**. Caps
(`CONE_CAP_RUNNING/PAUSED`) and auth are enforced worker-side as today.
`E2B_API_KEY` never touches the browser.

### New: `packages/webapp/src/cdp/cherry-host-transport.ts`

A `CDPTransport` implementation (peer of `cdp-client.ts` / `debugger-client.ts`)
that runs inside the Cherry iframe. It owns the [synthetic CDP session
model](#synthetic-cdp-session-model). Responsibilities:

- Advertise a single capability-tagged target for the host top frame.
- Answer CDP session/handshake methods locally (synthetic), forward leaf
  methods to the host SDK as `cdp.request` envelopes and await `cdp.response`.
- Surface host-pushed `cdp.event` envelopes (`Page.frameNavigated`,
  `Runtime.consoleAPICalled`) as CDP events to `BrowserAPI`.
- Enforce handshake + origin + source + nonce before any CDP flows.

### Synthetic CDP session model

`BrowserAPI` does not start at `Runtime.evaluate`. Its target lifecycle is
`Target.getTargets` → `Target.attachToTarget` (yields a `sessionId`) →
`Page.enable` / `Runtime.enable` / `DOM.enable` → `Page.getFrameTree`, and it
also uses `Target.detachFromTarget`, `Target.closeTarget`,
`Page.bringToFront`, and `Page.createIsolatedWorld`. `CherryHostTransport` must
emulate this session lifecycle:

| CDP method                                      | Synthetic handling                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Target.getTargets`                             | Return the single synthetic `targetInfo` for the host top frame                                                             |
| `Target.attachToTarget`                         | Mint and return a synthetic `sessionId`; bind it to the one target                                                          |
| `Target.detachFromTarget` / `closeTarget`       | Tear down the synthetic session; `closeTarget` on the host page is a no-op + clean response (we don't close the host's tab) |
| `Page.enable` / `Runtime.enable` / `DOM.enable` | Ack (no-op success); begin emitting the corresponding events                                                                |
| `Page.getFrameTree`                             | Synthesize a single-frame tree for the host top frame                                                                       |
| `Page.bringToFront`                             | Ack (no-op success)                                                                                                         |
| `Page.createIsolatedWorld`                      | Synthesize an execution-context id bound to the host realm; **cross-origin frames yield an unsupported error**              |

The session id, frame id, and execution-context id are minted by the transport
and kept stable for the life of the attachment (re-minted on navigation — see
NodeId/world lifecycle in [open questions](#open-questions-to-settle-during-planning)).

**Lifecycle events are mandatory, not optional.** `BrowserAPI.navigate()` sends
`Page.navigate` and then **awaits `Page.loadEventFired`** before resolving
(`browser-api.ts:415`). If the synthetic transport never emits that event, every
navigation hangs forever. So after the host `navigate(url)` promise settles, the
transport must synthesize the lifecycle: emit `Page.frameNavigated` then
`Page.loadEventFired` (and, for `Runtime`/console consumers, re-mint the
execution-context). The same applies to any other leader-side flow that blocks
on a lifecycle event — the supported subset must each have a synthetic
completion event or a documented timeout, never a silent hang.

### New: `packages/webapp/src/cdp/cherry-host-protocol.ts`

The **inner** iframe↔host envelope types (distinct from the tray wire
protocol). Pure types + guards, no logic. Every envelope carries `channelId`
(per-mount nonce) and is validated against pinned `origin` + `event.source`:

- `handshake.hello` / `handshake.welcome` — version + capability negotiation,
  origin pinning, nonce exchange, and (host→iframe) the provisioning payload.
- `cdp.request` / `cdp.response` / `cdp.event` — CDP transport.
- `permission.request` / `permission.response` — host gating of sensitive verbs.
- `host.event` / `slicc.event` — application messaging (the _iframe-local_ leg;
  the cross-network leg uses the tray protocol).

### Changed: `packages/webapp/src/scoops/tray-sync-protocol.ts` (CANONICAL wire protocol)

Three changes here, all mirrored to iOS (see invariant below):

<a id="target-capability-metadata"></a>

**(a) Target capability metadata.** `RemoteTargetInfo` (today `targetId` /
`title` / `url`) and `TrayTargetEntry` (today no `kind`/capabilities) gain a
capability descriptor so the leader can reason about what a target supports:

```ts
interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
  kind?: 'browser' | 'cherry'; // absent ⇒ 'browser' (back-compat)
  capabilities?: {
    navigate: boolean;
    network: boolean; // Cherry: false
    screenshot: boolean;
  };
}
```

**Capability metadata must propagate end-to-end — three sites drop it today.**
Adding fields to the wire type is necessary but not sufficient:

1. `TrayTargetRegistry.getEntries()` (`tray-target-registry.ts:37`) builds
   `TrayTargetEntry`s with a fixed field set and **drops unknown fields**. It
   must carry `kind`/`capabilities` through.
2. `BrowserAPI.listAllTargets()` (`browser-api.ts:176`) maps remote entries down
   to `{ targetId, title, url }`. It must preserve `kind`/`capabilities` so the
   leader's selection logic can read them.
3. `createTarget` is **runtime-level, not target-level**:
   `BrowserAPI.createRemotePage(runtimeId)` (`browser-api.ts:217`) opens a tab on
   a _runtime_, not a specific target. So "can this create tabs?" belongs on the
   runtime (the `slicc-cherry` runtime ⇒ no), derived from its targets — not on a
   per-target boolean. The capabilities object above is therefore per-target
   (`navigate`/`network`/`screenshot`); tab-creation is gated by runtime kind.

**(b) Application events, addressed.** Carry runtime/mount/origin identity so
they survive multi-follower topologies and the leader's broadcast-by-default
behavior:

```ts
type FollowerToLeaderMessage =
  | /* …existing… */
  | { type: 'cherry.host_event'; runtimeId: string; origin: string; name: string; data: unknown };

type LeaderToFollowerMessage =
  | /* …existing… */
  | { type: 'cherry.slicc_event'; runtimeId: string; name: string; data: unknown };
```

**(c) Runtime type + canonical runtime identity.** Cherry followers join as
`runtime: 'slicc-cherry'` (today `page-follower-tray` hardcodes
`'slicc-standalone'`), so leader-side selection can distinguish them.

There is also a **latent identity bug to fix, not inherit**: the advertisement
side builds `runtimeId = \`follower-${connection.bootstrapId}\``
(`page-follower-tray.ts:161`) while the leader's bookkeeping stores the raw
`bootstrapId` (`main.ts:2587`). For browser followers this inconsistency is
mostly invisible; for Cherry it is load-bearing, because `cherry-emit --runtime
<id>` and the `cherry.host_event`/`cherry.slicc_event` `runtimeId` field must
address exactly one stable id. The spec mandates a **single canonical form**:
the `follower-${bootstrapId}`advertisement id is authoritative, and the leader
must key its runtime map on the same value (or both must be reconciled to the
raw id) so`--runtime` resolves deterministically. This is enumerated as a
concrete fix in the implementation plan, not assumed to already work.

**Protocol mirror invariant (5-step checklist).** `tray-sync-protocol.ts` is
mirrored by the iOS Swift follower; all three changes must be mirrored:

1. Add the TS union members / fields (above).
2. Add encode/handle paths in `tray-leader-sync.ts` / `tray-follower-sync.ts`.
3. Mirror in `packages/ios-app/SliccFollower/Models/SyncProtocol.swift`
   (including the new `RemoteTargetInfo` fields and `slicc-cherry` runtime).
4. Add a **no-op** `cherry.slicc_event` case to
   `AppState.handleDataChannelMessage` so it is not silently dropped via
   `.unknown`. iOS never originates `cherry.host_event` and never advertises
   `kind: 'cherry'`.
5. Update protocol tests on both sides.

### Changed: `packages/webapp/src/scoops/tray-leader-sync.ts`

- **Tab-open / createTarget:** the follower-`tab.open` federation branch
  (≈ line 1062–1094) and `BrowserAPI.createRemotePage()` (returns
  `Promise<string>`; `tab.opened` carries `targetId: string`; follower treats a
  missing id as an error) must **reject createTarget against a `kind:'cherry'`
  target with a clean unsupported error**, rather than attempting it or
  producing a malformed empty-id `tab.opened`.
- **Selection logic:** teleport currently prefers `slicc-standalone` followers
  (≈ line 851). It (and any cookie/network flow) must **not** select a
  `slicc-cherry` target, using the new capability metadata. Cherry is chosen
  only for flows its capabilities cover.
- **Application events:** route inbound `cherry.host_event` to the leader's
  LickManager (carrying `runtimeId`/`origin`), and emit `cherry.slicc_event`
  addressed to the originating runtime.

### Changed: `lick-manager.ts` + `lick-formatting.ts` — the host-event lick

Routing `cherry.host_event` "to the LickManager" is only real if a concrete
lick shape exists. Today `LickEvent.type` is a fixed union
(`webhook | cron | sprinkle | fswatch | session-reload | navigate | upgrade`,
`lick-manager.ts:35`) and `formatLickEventForCone` has a per-type formatting
chain with no Cherry path (`lick-formatting.ts:50`). So host → cone delivery
needs:

1. **New `LickEvent` type `'cherry'`** with fields `cherryEventName: string`,
   `cherryRuntimeId: string`, `cherryOrigin: string`, and the payload in the
   existing `body: unknown`.
2. **Formatter path** in `formatLickEventForCone`: a human-readable label
   (`eventName = cherryEventName`) and a body the cone can act on (event name +
   origin + JSON payload). Add `'cherry'` to `EXTERNAL_LICK_CHANNELS` if the
   cone should be able to address a scoop by this channel.
3. **Target scoop behavior:** by default the host event lands on the cone (no
   `targetScoop`), matching how `navigate` licks surface; the SKILL documents
   how the cone reacts. (A future `cherry-emit`-style host→scoop addressing is
   out of scope for v1.)
4. **Tests** for the new type and its formatter output.

Without this the host→cone leg is specified at the tray layer but not actually
deliverable to the agent.

### createTarget: clean error + courtesy window.open as an app event

`Target.createTarget` on a Cherry target is a **clean unsupported error**. This
avoids bending the tab-open protocol (which is string-target-id shaped and
treats a missing id as failure). The courtesy "open this URL" the host may want
is delivered **off CDP** as a SLICC → host application event: the cone runs
`cherry-emit open-url <url>`, which arrives at `hooks` via `capabilities.openUrl`
(host decides whether to `window.open`). This honors the courtesy-open intent
without a non-driveable phantom target, and keeps the agent's `createPage()`
contract honest (it rejects, because Cherry genuinely cannot create a driveable
target).

### New: `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`

`cherry-emit <name> <json>` — a leader-side shell command (and
`globalThis.__cherry.emit(name, data)` binding) the cone uses to push a SLICC →
host event, addressed to a specific Cherry runtime (defaulting to the sole
connected Cherry follower; explicit `--runtime <id>` when several are present).
It enqueues a `cherry.slicc_event` on the data channel. The courtesy open is
just the well-known event name `open-url`. Dual-mode: extension-float leaders
relay panel→offscreen as other UI-affecting commands do; the normal Cherry
leader is a cloud cone (node-server hosted float), the primary path.

### New: `/workspace/skills/cherry/SKILL.md`

Documents, for the cone, the host event vocabulary (including the `open-url`
courtesy event): how to read incoming `cherry.host_event`s and how to emit with
`cherry-emit`. Lives in the leader's VFS (bundled via `packages/vfs-root/`).

## CDP translation matrix (host-SDK side)

Leaf methods forwarded to the host realm (session/handshake methods are handled
synthetically — see [Synthetic CDP session
model](#synthetic-cdp-session-model)):

| CDP method                                        | Host-side implementation                                                                                   | Notes / failure shape                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Runtime.evaluate` / `Runtime.callFunctionOn`     | Run in host realm; return a **constrained** RemoteObject (primitives, JSON-able objects, simple node refs) | Not a full CDP RemoteObject model; unsupported result types return a typed error, not a half-object |
| `DOM.*` (getDocument, querySelector, boxModel, …) | Direct DOM, weak-mapped synthetic node IDs                                                                 | NodeId↔Node via `WeakMap`; stable within a navigation                                               |
| `Input.dispatchMouseEvent`                        | `elementFromPoint` + synthetic `MouseEvent`                                                                | **Untrusted** events; some native controls won't react — documented limit                           |
| `Input.dispatchKeyEvent`                          | Dispatch to `document.activeElement`                                                                       | Untrusted; same caveat                                                                              |
| `Page.captureScreenshot`                          | Lazy `html2canvas`                                                                                         | Best-effort; cross-origin/canvas/video/WebGL/shadow gaps; `screenshot:'none'` → error               |
| `Page.navigate`                                   | `capabilities.navigate(url)` (SPA router)                                                                  | Omitted capability → clean unsupported error; gated by `onPermissionPrompt`                         |
| `Target.createTarget`                             | **Clean unsupported error** (courtesy open is an app event)                                                | See [createTarget](#createtarget-clean-error--courtesy-window-open-as-an-app-event)                 |
| `Accessibility.getFullAXTree`                     | Existing `injected-aria-snapshot.ts` evaluated in host realm                                               | Reuses current snapshot code                                                                        |
| `Page.frameNavigated`, `Runtime.consoleAPICalled` | Host pushes as `cdp.event`                                                                                 | Powers leader-side waits/logging                                                                    |
| `Network.*`                                       | **Unsupported (v1)** — clean error                                                                         | No interception/cookies; teleport + cookie skills gated off                                         |

## Skill compatibility (explicit)

- **Work as-is on Cherry:** DOM query/inspection, click/type via synthetic
  input (with the untrusted-event caveat), `Runtime.evaluate` of JSON-able
  expressions, aria snapshots, best-effort screenshots, SPA navigation when the
  host wires `navigate`.
- **Unsupported on Cherry (capability-gated + documented):**
  - `playwright-cli` iframe stitching that relies on `Page.getFrameTree` +
    `Page.createIsolatedWorld` across **cross-origin** frames.
  - teleport (uses remote tab opening + `Network.getCookies`/`setCookies`).
  - any cookie import/export flow.

The leader uses the [target capability
metadata](#target-capability-metadata) to refuse
these against Cherry targets with a clear message rather than a confusing
mid-flow CDP failure.

## Data flow (end-to-end, agent drives host page)

```
cone (leader) playwright-cli click
  → BrowserAPI.click → CDP Input.dispatchMouseEvent
  → leader sends cdp.request over tray data channel
  → Cherry follower CherryHostTransport receives it
  → postMessage cdp.request to host SDK (origin + source + nonce pinned)
  → host SDK: onPermissionPrompt? → elementFromPoint + synthetic event
  → postMessage cdp.response back to iframe
  → follower returns cdp.response over data channel
  → leader BrowserAPI resolves; cone sees the result
```

## Security model

- **Three-factor message pinning, both directions, no wildcards.** Every
  `postMessage` envelope is accepted only when (1) `event.origin` is in the
  pinned allowlist, (2) `event.source` matches the bound window (iframe's
  `contentWindow` on the host side; `window.parent` captured at handshake on the
  iframe side), and (3) `channelId` matches the per-mount nonce minted at
  handshake. Origin alone is insufficient — multiple same-origin frames or a
  stale iframe could otherwise inject valid-looking messages.
- **Handshake gate.** No CDP or event traffic flows before
  `handshake.hello`/`handshake.welcome` completes, pinning origin/source,
  exchanging the nonce, and negotiating capabilities.
- **Capability defaults — mounting is the grant.** Cherry is a powerful
  remote-control grant, not a read-only viewer: a host that calls `mountSlicc`
  is handing the remote cone the ability to read and act on its page. Be precise
  about what is on by default vs opt-in:
  - **On the moment a mount handshake completes** (no extra wiring): DOM
    read/inspect, `Runtime.evaluate` of JSON-able expressions, aria snapshots,
    synthetic mouse/keyboard input, and best-effort `html2canvas` screenshots
    (`screenshot` defaults to `'html2canvas'`). Set `screenshot: 'none'` to turn
    screenshots into a clean unsupported error.
  - **Off unless the host wires a handler:** `Page.navigate` (needs
    `capabilities.navigate`) and the courtesy open-url app event (needs
    `capabilities.openUrl`). Omitted ⇒ clean unsupported error / ignored.
  - **Never available in v1:** `Network.*`, cookies, teleport, cross-origin
    frames, driveable agent-opened tabs — capability-gated off regardless of
    host wiring.
  - Every sensitive verb (and, if the host wants, every verb) can still be
    vetoed per-call through `onPermissionPrompt`, which is the host's runtime
    kill-switch on top of the static capability set.
- **Single target, single origin.** Cherry cannot reach cross-origin frames;
  the browser's same-origin policy is the backstop, not Cherry's good behaviour.
- **Framing policy.** The Cherry boot response sets `frame-ancestors` to the
  configured host origins; the rest of the app stays `frame-ancestors 'none'`.
- **Token handling (the IMS bearer _is_ browser-resident — be honest about
  it).** This is not a "no secrets in the browser" design: the host already
  holds an IMS access token and hands it to the iframe over the pinned channel.
  What Cherry guarantees is narrower and must be stated as such:
  - The token is used **only** for **same-origin** `/api/cloud/*` calls from the
    iframe — it is never exposed to a third-party CORS surface and never reaches
    E2B (`E2B_API_KEY` stays worker-only; the cone runs remotely).
  - The SDK and iframe **do not persist** the token (no `localStorage` /
    `IndexedDB` / cookie); it lives only in memory for the provisioning call.
  - Hosts should pass **short-lived, narrowly-scoped** tokens and must **redact**
    the bearer from any logging on both sides. The token must never appear in a
    `postMessage` envelope that is logged, nor in CDP `Runtime.evaluate` output.
- **Tray transport unchanged.** WebRTC + DTLS as today; Cherry adds no new
  network trust boundary beyond the host↔iframe `postMessage` channel.

## Testing strategy

- **`cherry-host-protocol.ts`** — pure type guards / envelope encode-decode,
  including rejection on bad origin / wrong source / mismatched nonce
  (`packages/webapp/tests/cdp/cherry-host-protocol.test.ts`).
- **`CherryHostTransport` + synthetic session** — unit tests with a fake host
  (`MessagePort` / stubbed `postMessage`) asserting: handshake gating, the full
  `getTargets → attachToTarget → enable → getFrameTree` lifecycle, sessionId
  binding, request/response correlation, event delivery, single capability-
  tagged target advertisement.
- **CDP translation** — per-method tests against a jsdom host realm: evaluate
  (incl. unsupported-result error), DOM query, synthetic input,
  navigate-via-router vs unsupported error, `createTarget` clean error,
  `screenshot:'none'` error, `Network.*` clean error,
  cross-origin `createIsolatedWorld` error.
- **Tray protocol** — extend `tray-sync-protocol` tests for the capability
  metadata, the `slicc-cherry` runtime, and the two addressed event kinds;
  verify leader↔follower round-trip and that teleport/tab-open selection skips
  Cherry targets. Mirror tests in the iOS Swift suite (no-op handler does not
  drop to `.unknown`).
- **`@slicc/cherry` SDK** — provisioning orchestration tests with a mocked
  `/api/cloud/*` (list→resume, list→start, no-cone error), handshake/nonce
  pinning, mount/destroy lifecycle with a stubbed iframe, and the `open-url`
  courtesy event reaching `capabilities.openUrl`.
- **Worker framing** — test that the Cherry boot response carries
  `frame-ancestors <hosts>` while the rest of the app stays `'none'`.
- **Coverage floors** — `packages/cherry` gets its own CI floor wired in
  alongside its first tests; existing per-package floors (webapp 50/40, worker
  75/65/85, etc.) must not regress.

## Docs impact (part of implementation, not follow-up)

- **Root `CLAUDE.md`** — add Cherry to the Floats vocabulary and a
  `packages/cherry/` module-map row; note it is a new npm workspace.
- **`packages/webapp/CLAUDE.md`** — `CherryHostTransport` as a third
  `CDPTransport` (with synthetic session); the `?cherry=1` boot mode; the
  tray-protocol additions (capability metadata, `slicc-cherry` runtime, the two
  event kinds).
- **`packages/cherry/CLAUDE.md`** (new) — SDK contract, iframe-side provisioning
  flow, three-factor message pinning, capability/skill-support matrix.
- **`packages/cloudflare-worker/CLAUDE.md`** — Cherry consumes existing
  `/api/cloud/*` (no new routes) but requires the `frame-ancestors` policy +
  the host-origin allowlist env var.
- **`packages/ios-app/CLAUDE.md`** — the no-op `cherry.slicc_event` mirror, the
  new `RemoteTargetInfo` fields, and that iOS never advertises `kind:'cherry'`.
- **`docs/architecture.md`** — Cherry topology + single-host-target CDP contract
  - synthetic session model.
- **`README.md`** — user-facing "embed SLICC in your page" blurb.
- **`/workspace/skills/cherry/SKILL.md`** — cone-facing host-event vocabulary.

## Open questions (to settle during planning)

1. Exact synthetic `targetInfo` shape — minimal fields `BrowserAPI` needs to
   treat the Cherry target as a normal page target.
2. NodeId + isolated-world lifecycle across SPA soft-navigations — flush the
   `WeakMap` and re-mint the execution-context id on `frameNavigated`?
3. Whether `cherry-emit` should also accept stdin JSON for large payloads.
4. `html2canvas` bundle cost in the webapp build — lazy-import only when a
   screenshot is first requested; confirm it does not regress the
   Cloudflare 25 MiB per-asset cap.
5. Where the host-origin allowlist for `frame-ancestors` lives (single CSV env
   var vs per-tenant) and how it relates to the cloud-cone `ALLOWED_EMAIL_DOMAIN`
   gating.

## Out of scope / explicitly deferred

- Cross-origin frame driving (needs the extension).
- `Network.*` interception/emulation, cookies, teleport on Cherry targets.
- Driveable agent-opened tabs (createTarget); only the courtesy `open-url` app
  event ships.
- Multiple targets per mount.
- New worker **endpoints** (the `frame-ancestors` header change is in scope).
- A non-IMS provider in `auth` (the shape allows future providers; only `ims`
  ships in v1).
