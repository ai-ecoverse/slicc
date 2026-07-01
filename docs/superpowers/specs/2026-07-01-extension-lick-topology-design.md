# Extension Lick Topology — Design

- **Date:** 2026-07-01
- **Status:** Draft (for review)
- **Branch:** `worktree-feat+extension-lick-topology`
- **Author:** Karl + Claude

## 1. Problem

In the Chrome extension, the SLICC leader runs as a hosted tab
(`https://www.sliccy.ai/?slicc=leader&ext=<id>`). That tab throws a
never-ending console error loop:

```
WebSocket connection to 'wss://www.sliccy.ai/licks-ws' failed
[lick-ws-bridge] Lick WebSocket still down { attempt: N, cause: 'disconnected code=1006', retryInMs: … }
```

The extension leader has **no node-server**. `/licks-ws` is a node-server
route only; the Cloudflare worker that serves `www.sliccy.ai` does not
implement it. So the bridge dials a dead endpoint, 1006s, and retries
forever. After 20 consecutive failures (`RECONNECT_GIVEUP_AT`) it also
emits a spurious `session-reload` lick to the cone (~16 min into a
session).

This is one symptom of a **broader, half-finished migration**. The
extension used to run a `chrome-extension://` offscreen document whose
kernel booted with `isExtension: true`; that layer was removed in commit
`54eb0811` ("strip offscreen + side panel, move to hosted"). Nothing sets
`isExtension: true` anymore, and the leader tab is an _external web page_
where `chrome.runtime.id` is `undefined`. As a result, **two legacy
"am I the extension?" signals are now permanently false in the extension
leader**, and every code path that branched on them misbehaves.

## 2. Root cause

Three "am I the extension?" mechanisms exist; only one is correct for the
current architecture:

| Signal                                                 | Value in extension leader tab | Consumers                                             |
| ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------- |
| `KernelHostConfig.isExtension`                         | `false` (never set anywhere)  | lick-ws bridge gate, NavigationWatcher gate           |
| `!!chrome?.runtime?.id` heuristic                      | `false` (external page)       | webhook, crontask, OAuth, media, sprinkles, speech, … |
| `getExtensionDelegateId()` / `resolveSecretTopology()` | `extension-delegate` ✅       | secret CRUD only                                      |

`core/secret-topology.ts` already documents this exact bug — it _"[replaces]
the scattered `isExtension = !!chrome.runtime.id` heuristic, which
misclassifies the thin-extension hosted-leader tab … as CLI and routes
writes to a node-server that isn't there."_ — but only the **secrets** leg
was migrated. The lick legs (`lick-ws`, `webhook`, `crontask`) were left on
the dead `isExtension` flag / the naive heuristic, so they misroute the
extension leader to a node-server that does not exist.

### What is actually broken (extension leader tab)

| Path                                     | Guard                                              | Status                                                                                          |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| lick-ws bridge (`host.ts`)               | `!isExtension`                                     | 🔴 dials dead `wss://www.sliccy.ai/licks-ws`; console spam + spurious `session-reload`          |
| crontask (`crontask-command.ts`)         | `!!chrome.runtime.id`                              | 🔴 fully broken — `!isExtension` → `apiCall` to absent node-server REST                         |
| webhook URL (`webhook-command.ts`)       | `!!chrome.runtime.id`                              | 🟠 half-broken — dead node-server fallback + honest "connect a leader tray" message unreachable |
| webhook event delivery                   | tray path                                          | 🟢 works (independent of the bug — see §4)                                                      |
| NavigationWatcher / handoffs (`host.ts`) | `!isExtension` **+** `transport.isExtensionBridge` | 🟢 correctly skips via the live transport signal                                                |
| secret CRUD                              | `resolveSecretTopology()`                          | 🟢 already fixed                                                                                |

## 3. Foundational model — Leader/Follower & Float taxonomy

Licks are a **kernel-only** concern: only floats that boot a kernel worker
(`mountWcUiLive`) run a `LickManager` and thus the lick-ws bridge /
webhook / crontask legs. The only floats that boot **no** kernel are the
tray-join `follower` mode and the `cherry` embed; they forward `navigate`
licks to the leader and run no lick legs. **Not every "follower" is
kernel-less** — an electron-overlay auto-follow tab (`?role=follower`)
still boots a full kernel worker (its role only affects `/cdp`), so it is a
lick-bearing `node-rest` float.

### Axis 1 — Role (primary)

| Float                                                                           | Boots kernel + `LickManager`? | Lick behavior                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Leader** (standalone / electron-overlay leader / hosted / extension-delegate) | yes                           | Handles webhook/cron/navigate; runs (or skips) the lick-ws bridge                                    |
| **electron-overlay follower tab** (`?role=follower`)                            | **yes** (`mountWcUiLive`)     | `node-rest`; `role=follower` only skips the eager `/cdp` dial — untouched by this change             |
| **tray-join `follower`** + **`cherry`** (embedded, limited)                     | **no** (`mountWcUiFollower`)  | Forwards `navigate` to the leader (`FORWARDABLE_TO_LEADER`); never runs lick-ws / webhook / crontask |
| **iOS follower**                                                                | n/a (native app)              | Forwards to the leader; no webapp lick legs                                                          |

Verified: `main.ts` dispatches **only** `follower`/`cherry` to
`mountWcUiFollower` _before_ the kernel/OAuth boot (_"needs neither the
local OAuth bootstrap … nor the kernel worker"_). `electron-overlay` is a
distinct runtime mode that falls through to `mountWcUiLive`; its
`role=follower` handling in `setup-standalone-prelude.ts` only primes-but-
does-not-dial `/cdp`, so the kernel worker still spawns. In the extension,
the content script injects a `<slicc-launcher>` overlay into every page
that opens `…/?cherry=1` as a cherry-follower iframe; the single leader is a
pinned tab at `…/?slicc=leader&ext=<id>` (`service-worker.ts`, keyed by
`slicc_leader_tab_id`).

### Axis 2 — Substrate (for every kernel-bearing float)

| Substrate                                       | node-server reachable?                                                                                                                                                             | lick-ws URL                                                | webhook/cron     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| standalone thin-bridge                          | yes — localhost, `bridgeToken` minted (`THIN_BRIDGE_MODE = !SERVE_ONLY`) → `?bridge=ws://localhost:<port>/cdp`                                                                     | `localLickWsUrl` (`ws://localhost/licks-ws`)               | node-server REST |
| electron-overlay (leader **and** follower tabs) | yes — localhost via `?bridge=`                                                                                                                                                     | `localLickWsUrl`                                           | node-server REST |
| hosted / cloud cone                             | yes — **thin-bridge** (`--hosted` ⇒ `THIN_BRIDGE_MODE=true` ⇒ token minted; page origin = `resolveThinLeaderOrigin()` = hosted origin; `?bridge=ws://localhost:5710/cdp` appended) | `localLickWsUrl` (`ws://localhost:5710/licks-ws`)          | node-server REST |
| serve-only reattach (`--serve-only`)            | yes — localhost, `bridgeToken=null`                                                                                                                                                | **same-origin fallback** (`getLickWebSocketUrl(location)`) | node-server REST |
| **extension-delegate** (`?slicc=leader&ext=`)   | **no** — `useExtensionBridge` suppresses `?bridge=`, so `localLickWsUrl` is `null` and same-origin resolves to `www.sliccy.ai` (no node-server)                                    | — (must skip)                                              | **tray worker**  |

**Critical correctness note (discriminator choice):** the gate is the
**`extension-delegate` topology**, _not_ `localLickWsUrl != null`. Reasons:

1. **Single source of truth.** `resolveSecretTopology()` already treats
   `extension-delegate` as the canonical "no node-server, hosted-leader
   delegate" signal; the lick legs must agree, or the codebase keeps two
   contradictory extension detectors.
2. **Preserve the same-origin fallback for `bridgeToken=null` node-rest
   floats.** `--serve-only` boots a kernel with `localLickWsUrl === null`
   and _depends on_ the lick-ws bridge's same-origin fallback reaching its
   co-located node-server. Gating on `localLickWsUrl != null` would wrongly
   disable that path; gating on `extension-delegate` leaves every node-rest
   float (thin-bridge, electron, hosted, serve-only) exactly as it is today
   and skips only the extension leader.

(An earlier draft wrongly claimed the hosted cone runs same-origin with
`bridgeToken=null`. It is in fact thin-bridge with an explicit
`localLickWsUrl` pointing at `ws://localhost:5710/licks-ws`. The
discriminator is unchanged; only the stated rationale is corrected.)

## 4. Delivery rail (already works — no change)

Inbound webhook events reach the extension leader over the **tray worker**,
not `/licks-ws`:

```
POST <workerBaseUrl>/webhook/<token>/<webhookId>   (session-tray.ts)
  → { type: 'webhook.event', webhookId, headers, body } sent to leaderSocket
  → page-leader-tray.ts (message.type === 'webhook.event')
  → options.sendWebhookEvent(...) → worker LickManager.handleWebhookEvent
```

Cron fires **tab-lifetime**: `LickManager.init()` starts a 60s
`setInterval(runCronScheduler, 60000)` (`lick-manager.ts`). The extension
leader tab's kernel-worker `LickManager` already runs this tick, so routing
crontask CRUD to it makes cron fire while the leader tab is open. Durable
(tab-close-surviving) cron via Cloudflare cron triggers is **out of scope**
(future work).

## 5. Design

### 5.1 Float-topology resolver (generalize the existing one)

Promote the secrets-only resolver into the canonical float discriminator:

- Add `resolveFloatTopology(): FloatTopology` where
  `FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest'`
  (identical value set to today's `SecretTopology`).
- Keep `resolveSecretTopology` / `SecretTopology` as thin re-exports/aliases
  so the secrets leg and its tests do not churn.
- Location: rename/move `core/secret-topology.ts` →
  `core/float-topology.ts`, with `core/secret-topology.ts` re-exporting for
  backward compatibility. (Plan decides exact file mechanics; behavior is
  unchanged for secrets.)
- Resolution order is unchanged: `chrome.runtime.id` → `extension-direct`;
  `getExtensionDelegateId()` → `extension-delegate`; `__slicc_connect_mode`
  → `connect`; else `node-rest`.
- Pure, side-effect-free, and **worker- and page-safe**. It is consulted
  **only by leader-side code**.

The resolver works worker-side because `getExtensionDelegateId()`
(`proxied-fetch.ts`) is plain module state already populated in the kernel
worker at boot via `setExtensionDelegateId(init.extensionDelegateId)`
(`kernel-worker.ts`), and page-side via the boot prelude. No new plumbing.

### 5.2 lick-ws bridge gate (`kernel/host.ts`)

Replace the `!isExtension` gate with a **positive** topology check — start
the bridge **only** when a local node-server exists (`node-rest`):

```ts
if (resolveFloatTopology() === 'node-rest') {
  lickWsBridgeStop = await startLickWsBridgeForHost(
    lickManager,
    log,
    config.localLickWsUrl ?? null
  );
}
```

`=== 'node-rest'` (rather than `!== 'extension-delegate'`) is deliberate:
it also excludes a hypothetical `extension-direct` kernel (a real
`chrome-extension://` page — none ship today, see §5.4), which likewise has
no node-server. `connect` never reaches here (it boots no kernel).

- **Keep** the same-origin fallback in `lick-ws-bridge.ts` — `--serve-only`
  (`bridgeToken=null`) is `node-rest` and relies on it to reach its
  co-located node-server.
- Standalone / electron / hosted / serve-only leaders: unchanged (topology
  `node-rest`; they still start the bridge, via `localLickWsUrl` or the
  same-origin fallback as today).
- Extension-delegate leader: bridge no longer starts → no dead socket, no
  spam, no spurious `session-reload`. Lick delivery uses the tray (§4).

### 5.3 Retire `KernelHostConfig.isExtension`

`isExtension` is dead (never `true`). Remove the field and its two gates:

- lick-ws gate → replaced by the topology check above.
- NavigationWatcher gate (`if (!isExtension)`) → drop the wrapper; the
  watcher already self-skips via `transport.isExtensionBridge`
  (`startNavigationWatcherForHost`), which is the correct live signal.

Update the `createKernelHost` signature/callers (`kernel-worker.ts`) and
the doc comments that reference `isExtension`.

### 5.4 webhook / crontask commands

Both commands today branch on
`const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id`.
Replace that with the **`topology === 'node-rest'`** predicate ("is there a
local node-server REST surface?"). Crucially, the two commands do **not**
have the same shape — do not conflate them:

- **crontask** (`crontask-command.ts`) — CRUD surface **is** topology-gated.
  It has a REST path (`apiCall`, currently the `!isExtension` branch) **and**
  a direct-`LickManager` path (`getExtensionLickManager()` / proxy, currently
  the `isExtension` branch). Map: `node-rest` → `apiCall`; otherwise → the
  worker-resident `LickManager` (which already runs the 60s cron tick). This
  is the fix that makes crontask work in the extension-delegate leader.
- **webhook** (`webhook-command.ts`) — CRUD surface is **not** topology-gated
  and has **no REST path at all**. `createWebhook` / `deleteWebhook` /
  `listWebhooks` always go through the `LickManager` surface directly
  (`getDirectLickManager()` — the worker singleton — or the dead side-panel
  proxy per §5.5). We are **not** migrating webhook CRUD to REST. Topology
  only affects **URL resolution + messaging**, and the precedence is
  **tray-first in every topology** — do not regress that:
  1. **Active tray session → tray capability URL, for ALL topologies.**
     Today `resolveWebhookUrlBase()` reads `getLeaderTrayRuntimeStatus()`;
     standalone-with-a-tray already returns the tray URL (asserted by
     `webhook-command.test.ts`). The **only** change here is to read the tray
     session via the shim-aware `getLeaderStatusWithFallback()`
     (`tray-leader.ts`) so the **worker** also sees a **page-side** leader
     tray (the extension-delegate leader's tray runs on the page; the
     worker's own tray module global stays `inactive`). This mirrors the
     `tray_status` handler in `lick-ws-bridge.ts` and is what makes
     extension-delegate + active tray resolve to the tray URL.
  2. **No tray session → topology-specific fallback.** `node-rest` →
     node-server-origin `/webhooks/<id>` (unchanged). Non-`node-rest`
     (`extension-delegate` / `extension-direct`) → the honest
     "(URL unavailable — connect a leader tray)" message. This replaces the
     current `isExtension`-gated fallback that instead emits a
     plausible-but-dead `https://www.sliccy.ai/webhooks/<id>` in the
     extension leader.

  Net: `{node-rest, non-node-rest} × active-tray → tray URL`;
  `node-rest × no-tray → node-server URL`;
  `non-node-rest × no-tray → honest message`.

**`extension-direct` (real `chrome-extension://` kernel):** no such kernel
ships after `54eb0811` (offscreen + side panel removed), so this topology is
**unreachable** for the lick commands today. The `node-rest`-vs-not framing
handles it safely regardless — `extension-direct` falls on the non-REST
side, identical to `extension-delegate` (direct `LickManager` + tray) — so
there is no dead-branch hazard. Tests assert this equivalence (§7) rather
than relying on it being unreachable.

### 5.5 Obsolete side-panel proxy path

The old side-panel↔offscreen `lick-manager-proxy.ts` BroadcastChannel path
in webhook/crontask exists for a two-realm extension that no longer ships
(side panel removed in `54eb0811`). The plan verifies that in the current
single-kernel-worker leader tab both agent and panel-terminal invocations
reach `getDirectLickManager()` directly, and removes/retires the now-dead
proxy branch if confirmed unused.

## 6. Non-goals / out of scope

- **tray-join `follower` + `cherry`** — boot no kernel and never run
  lick-ws/webhook/crontask; untouched. Only their existing `navigate`-lick
  forwarding connects them to the leader.
- **electron-overlay follower tabs** — boot a kernel but are `node-rest`
  (localhost node-server); the topology gate leaves them exactly as today.
  No behavior change intended.
- **Cloud / hosted cone** — already correct as `node-rest` (thin-bridge
  with `localLickWsUrl` → localhost node-server). No wiring or test changes.
- **Durable cron** surviving tab close (Cloudflare cron triggers on the
  tray worker) — future work.
- **`!!chrome.runtime.id` branches that are not node-server-dependent**
  (OAuth, media capture, sprinkles, speech, mount picker) — they degrade to
  the standalone web path in the leader tab, which functions on a real
  HTTPS page. Migrating them to the resolver is a separate cleanup, not part
  of this fix.

## 7. Testing

- **Resolver** (`float-topology`): unit test each topology
  (`extension-direct` via stubbed `chrome.runtime.id`, `extension-delegate`
  via `setExtensionDelegateId`, `connect` via `__slicc_connect_mode`,
  `node-rest` default), plus precedence order (delegate wins over a set
  `localApiBaseUrl`).
- **`host.ts`**: lick-ws bridge **started** only for `node-rest` — both
  **with** `localLickWsUrl` (thin-bridge / electron / hosted) and **without**
  it (serve-only → same-origin fallback); **not** started for
  `extension-delegate` **nor** `extension-direct`. Assert NavigationWatcher
  still self-skips on `transport.isExtensionBridge`.
- **crontask**: `node-rest` create/list/delete route to `apiCall`;
  non-`node-rest` (`extension-delegate` **and** `extension-direct`) route to
  the worker `LickManager`.
- **webhook**: CRUD always hits the direct `LickManager` (assert **no**
  REST/`apiCall`, for every topology). URL-resolution matrix (2×2):
  - `node-rest` + active tray → tray capability URL (**regression guard** —
    keep the existing standalone-with-tray assertion green).
  - `node-rest` + no tray → node-server-origin `/webhooks/<id>`.
  - non-`node-rest` + active (page-side) tray → tray URL, resolved via the
    shim-aware `getLeaderStatusWithFallback()`.
  - non-`node-rest` + no tray → honest "connect a leader tray" message.
- **`extension-direct` equivalence**: assert `extension-direct` behaves like
  `extension-delegate` for the lick-ws gate (skipped), crontask (direct
  `LickManager`), and webhook (tray URL / honest message).
- **Regression**: reproduce the original defect — an `extension-delegate`
  boot must not attempt `wss://…/licks-ws`.
- Keep each package at/above its coverage floor.

## 8. Documentation (three gates)

- Root `CLAUDE.md` and the webapp `CLAUDE.md`: correct the stale three-layer
  offscreen/side-panel extension description (dead since `54eb0811`);
  document `resolveFloatTopology` as the canonical float discriminator and
  the leader/follower lick model.
- Update the auto-memory notes that still describe the offscreen extension.
- `docs/shell-reference.md`: update webhook/crontask sections if their
  extension behavior is documented there.
- `docs/architecture.md`: reconcile any offscreen-era description of the
  extension float.

## 9. Verification

Full pre-push pass in the worktree: `lint`, `typecheck`, `test`,
`test:coverage`, both `build`s, and the touched-file complexity gate. Manual
smoke: load the extension leader tab, confirm the `/licks-ws` error loop is
gone, `crontask create`/`list` works, and `webhook create` returns a tray
URL (or the honest no-tray message).

## 10. Risks & mitigations

- **Regressing a working kernel-bearing float**
  (standalone / electron leader & follower / hosted / serve-only) by
  over-gating. Mitigation: the gate starts the bridge for **all** `node-rest`
  floats and changes behavior only for non-`node-rest` kernels
  (`extension-delegate`; the unreachable `extension-direct`); explicit
  `host.ts` tests cover `node-rest` with and without `localLickWsUrl` (incl.
  the serve-only same-origin fallback).
- **Worker vs page realm mismatch** for tray-session visibility in webhook.
  Mitigation: use the established `getLeaderStatusWithFallback()` shim
  precedent; add a test asserting the fallback is consulted.
- **Retiring `isExtension` touches shared boot config.** Mitigation:
  it is provably never `true`; typecheck + the full test suite guard the
  callers.

## 11. File-level change inventory (indicative)

- `packages/webapp/src/core/secret-topology.ts` → `float-topology.ts`
  (+ re-export) — generalize resolver.
- `packages/webapp/src/kernel/host.ts` — topology-gated lick-ws bridge;
  remove `isExtension` field + both gates; NavigationWatcher relies on
  `transport.isExtensionBridge`.
- `packages/webapp/src/kernel/kernel-worker.ts` — drop `isExtension` from
  the `createKernelHost` call.
- `packages/webapp/src/shell/supplemental-commands/webhook-command.ts` —
  URL resolution + messaging only (CRUD stays direct `LickManager`, no REST):
  `node-rest` → node-server-origin URL; else shim-aware tray URL / honest
  no-tray message.
- `packages/webapp/src/shell/supplemental-commands/crontask-command.ts` —
  topology-gated CRUD surface: `node-rest` → `apiCall`; else → worker
  `LickManager`.
- Tests mirrored under `packages/webapp/tests/**`.
- Docs per §8.
