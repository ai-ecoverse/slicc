# Cherry Side Panel — Design

**Status:** Approved (brainstorming complete 2026-07-02)
**Branch:** `worktree-feat+on-demand-cherry-sidebar` (reworks PR #1287 in place)
**Supersedes:** `docs/superpowers/specs/2026-07-02-on-demand-cherry-sidebar-design.md` (the page-injection approach)

## Goal

Replace the extension's on-demand **page-injected** cherry sidebar with a
**Chrome side panel** that hosts the cherry UI-only follower. Clicking the
toolbar icon opens a window-level cockpit panel connected to the sticky hosted
leader tab. Nothing is injected into the third-party page.

## Motivation

The injection approach (PR #1287) embeds the follower iframe into the current
page's MAIN world via a content script + `<slicc-launcher>` overlay. That design
forced a large amount of fragile machinery and carries real hazards:

- **MAIN-world forgery risk** — the injected host shares the realm with a
  possibly-hostile page, so the joinUrl had to be plumbed via an unforgeable
  `chrome.scripting.executeScript` channel (`plumbTrustedOrigin`) and validated
  fail-closed.
- **Handshake fragility** — the follower derived the parent origin from
  `document.referrer`, which is stripped on HTTPS-host → HTTP-iframe downgrades
  and by strict `Referrer-Policy` host pages (fixed this session via
  `location.ancestorOrigins`, but the fragility is inherent to injecting into
  arbitrary pages).
- **Lifecycle complexity** — per-tab generation counters, teardown races,
  reconnect/`pendingClose` replay, identity-guarded relay-Port deregistration.
- **Third-party footprint** — DNR `frame-ancestors` relaxation on arbitrary
  pages and the broad `scripting` permission (a Chrome Web Store review
  liability).

Hosting the follower in a side panel — an **extension-origin** page — removes
all of the above while reusing the proven follower + tray core.

## Non-Goals

- No new chat-sync transport. The follower connects to the leader over the
  existing tray (WebRTC) path, exactly as it does today.
- No bundled follower UI. The panel iframes the **hosted** webapp
  (`?cherry=1&ui-only=1`), preserving the thin-extension principle (no bundled
  agent engine / UI).
- No change to how the agent drives pages: the leader continues to drive
  whatever tab is active via the real `chrome.debugger` CDP bridge.
- Not touching the standalone/CLI or Electron floats (side panel is
  extension-only). Cross-runtime parity note: N/A for those floats.

## UX

- **Icon click** toggles a **window-level** side panel (the cockpit). Opening it
  keeps focus on the current page — the leader tab is created pinned in the
  background if missing and is **never auto-focused**.
- The panel persists across page navigations within the window (it is not tied
  to page DOM, unlike the injected overlay).
- Re-clicking the icon (or the panel's built-in close) closes the panel.

## Connection Mechanism

**Chosen: panel iframes the hosted `?cherry=1&ui-only=1` follower; follower
connects to the leader over the tray.** This reuses 100% of the follower + tray
core proven working this session (same-origin tray, `leader.join-url` bridge,
`ui-only` advertise suppression). Alternatives considered and rejected:

- **Direct `chrome.runtime` sync (no tray):** the cherry follower only speaks
  the tray protocol, and the leader tab is a web page (not extension origin);
  a new sync transport is a large surface for no user-visible benefit. YAGNI.
- **Bundle the follower UI into the panel:** violates the thin-extension
  principle and cannot run the webapp bundle under extension CSP without major
  work.

## Architecture

```
Toolbar icon → Chrome toggles the side panel
  (setPanelBehavior({ openPanelOnActionClick: true }); Chrome owns open/closed
   state — SW keeps none. The old injection action.onClicked listener is REMOVED;
   the leader is ensured from the panel port-connect regardless of whether
   onClicked still fires — harness-verified.)

sidepanel.html  (chrome-extension://<id>/ — trusted extension page)
  └─ sidepanel-entry.ts
       ├─ chrome.runtime.connect({ name: 'cherry-panel' })  → Service Worker
       │        (SW: ensureLeaderTab() [pinned, background, not focused])
       │     → { kind: 'hello', windowId }                        (panel registers on connect)
       │     ← { kind:'join-url', state:'booting' }               (leader up, no joinUrl yet → "starting…")
       │     ← { kind:'join-url', state:'ready', joinUrl }        (→ mount)
       │     ← { kind:'join-url', state:'disconnected' }          (leader/tray gone → "disconnected")
       └─ mountSlicc({ iframe, joinToken: joinUrl, uiOnly: true, features: SIDE_PANEL_FEATURES })
             └─ <iframe src="<hosted>/?cherry=1&ui-only=1">   (the follower)
                   → cherry handshake with the panel (host)
                   → follower joins the leader's tray over WebRTC
                   → mirrors the leader's chat; advertises NO CDP target

Hosted leader tab (?slicc=leader&ext=<id>, pinned/background)
  = tray leader (runtime + kernel worker); drives the active tab via real
    chrome.debugger CDP, resolving "this page" via the active-tab marker.
```

## Components

### Remove (injection machinery)

- `packages/chrome-extension/src/relay-isolated.ts`
- `packages/chrome-extension/src/cherry-relay-protocol.ts`
- `packages/chrome-extension/src/cherry-sidebar-main.ts`
- `packages/chrome-extension/src/cherry-sidebar-sw.ts` injection surface:
  `toggleCherryTab`, `injectCherry`, `canInjectInto`, `plumbTrustedOrigin`, the
  per-tab `tabGeneration` map, and the relay-Port registry. (Keep only the parts
  that migrate to the panel path — see "Add".)
- Manifest `scripting` permission (the SW no longer calls
  `chrome.scripting.executeScript`).
- Vite `buildRelayIsolatedPlugin()` and `buildCherrySidebarMainPlugin()`; the
  `knip.json` entries for the removed files.
- Tests for the removed surface (relay, MAIN entry, injection SW wiring,
  generation counters, `plumbTrustedOrigin`).

**Not touched:** `content-script.ts` is unrelated to this feature — the cherry
injection ran via the SW's `chrome.scripting.executeScript` (relay-isolated +
cherry-sidebar-main), not the content script. `content-script.ts` stays as-is
(dormant — not manifest-injected; it still bootstraps a bare launcher if ever
executed, but nothing runs it). Only the static DNR `frame_ancestors_sliccy`
**rule resource** is revisited (see **CSP & Framing**); the
`declarativeNetRequestWithHostAccess` **permission** stays — the fetch proxy
needs it independently.

### Add (side panel)

- **`packages/chrome-extension/sidepanel.html`** — minimal shell hosting a
  single follower iframe container + a small connection-status affordance.
- **`packages/chrome-extension/src/sidepanel-entry.ts`** — the panel host:
  opens the `cherry-panel` Port to the SW, receives the joinUrl, calls
  `mountSlicc({ iframe, joinToken, uiOnly: true, sliccOrigin, capabilities: {
navigate: false, screenshot: 'none', openUrl: false }, features:
SIDE_PANEL_FEATURES })`, and renders connection state (connecting / connected /
  disconnected). The capabilities are all-off (the agent drives pages via real
  `chrome.debugger` CDP, so the follower needs no page powers and never runs
  html2canvas). `SIDE_PANEL_FEATURES` is the concrete chat-focused
  `CherryFeatures` object — `{ terminal:false, files:false, memory:false,
browser:false, newSprinkle:false, monitor:false, modelPicker:true,
history:true, nav:true }` — carried over from the removed
  `cherry-sidebar-main.ts`'s `CHERRY_SIDEBAR_FEATURES` (defined here or in a
  small shared module). Bundled by an esbuild `closeBundle` plugin in
  `vite.config.ts` (same pattern as `secrets-entry`); `sidepanel.html` is added
  to the `closeBundle` static-asset copy list; `sidepanel-entry.ts` is registered
  as a `knip.json` production entry (`!`) so knip doesn't flag it — replacing the
  removed `relay-isolated`/`cherry-sidebar-main` entries.
- **SW side-panel wiring** (in `cherry-sidebar-sw.ts`, repurposed): register the
  `cherry-panel` `chrome.runtime.onConnect` handler. On connect, read the
  panel's `{ kind:'hello', windowId }`, call `ensureLeaderTab()` (idempotent),
  and reply with the current **tri-state** joinUrl status; push status changes as
  the leader delivers `leader.join-url` / tears down.
  - **Tri-state joinUrl protocol** — replaces the current `string | null` cache
    (which cannot tell first-run wait from teardown):
    - **`booting`** — leader tab ensured but no joinUrl has arrived yet → panel
      shows "starting SLICC…".
    - **`ready`** (carries the string `joinUrl`) → panel mounts.
    - **`disconnected`** — leader/tray went away (explicit teardown / reconnect
      gave up) → panel tears down + shows "disconnected".

    The SW tracks which of `booting`/`disconnected` a "no joinUrl" means so the
    panel renders the right state. **Extend `handleLeaderTabRemoved()`** (today
    it only clears the stored tab id) to move to `disconnected` and broadcast it
    to every connected `cherry-panel` port.

- **Toggle** (in `service-worker.ts`):
  `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` — Chrome
  natively toggles the panel open/closed on icon click. This is **immune to SW
  eviction** (Chrome owns the open/closed state; the SW keeps none) and avoids
  the `open()` user-gesture juggling. **The current cherry-injection
  `chrome.action.onClicked` listener (`service-worker.ts:353` → `toggleCherryTab`)
  MUST be removed** — it is replaced entirely by the native toggle.
  `ensureLeaderTab()` runs from the panel's `cherry-panel` port-connect (above),
  so the leader is ensured on panel open regardless of whether `onClicked` still
  fires under `openPanelOnActionClick` (a Load-Bearing Verification, not
  asserted). See **Deferred Decision** for the toggle-close fallback.
- **Manifest:** `sidePanel` permission; `side_panel.default_path =
"sidepanel.html"`; set `minimum_chrome_version` (see Deferred Decision — `114`
  for sidePanel; the `close()`/`onClosed` fallback needs `141`/`142`). **No
  extension-CSP change is expected for framing:** the
  current `extension_pages` CSP is only `script-src 'self' 'wasm-unsafe-eval';
object-src 'self'` — with no `default-src`/`child-src`/`frame-src`, frames are
  unrestricted, so the panel may iframe the hosted follower as-is. The plan
  verifies this in the harness and adds `frame-src 'self' <hosted-origins>`
  (keeping `'self'`) **only if** Chrome actually blocks the iframe.
- **`chrome.d.ts`:** `chrome.sidePanel` typings — `open`, `close`, `setOptions`,
  `setPanelBehavior`, and the `onOpened` / `onClosed` events used for toggle
  state.

### Keep / reuse (unchanged)

- Cherry `mountSlicc` `iframe` / `uiOnly` options
  (`packages/cherry/src/index.ts`, `mount.ts`).
- UI-only advertise suppression in `page-follower-tray.ts` / `wc-follower.ts`.
- `main-cherry.ts` follower boot, including the `ancestorOrigins` parent-origin
  fix from this session.
- The `leader.join-url` bridge (`extension-bridge-protocol.ts`,
  `extension-bridge-transport.ts`, `page-leader-tray.ts`) and the SW cache of
  the leader joinUrl + reconnect replay (survives MV3 SW eviction).
- The active-tab marker in `bridge-sw.ts` (`cdpGetTargets` +
  `queryActiveTabId` via `lastFocusedWindow`).

### Drop

- The spoon `<slicc-launcher>` managed-iframe surface added for the injected
  overlay: the panel IS the container, so the launcher is not needed here. (The
  spoon package changes for `managed`/`requestClose` may be reverted if nothing
  else consumes them.)

## Data Flow (boot sequence)

1. User clicks the toolbar icon → **Chrome toggles the side panel** (via
   `setPanelBehavior({ openPanelOnActionClick: true })`); Chrome owns open/closed
   state. The old injection `action.onClicked` listener is removed; the leader is
   ensured from the panel port-connect (step 3) regardless of whether `onClicked`
   still fires (harness-verified). (Toggle-close fallback: see Deferred Decision.)
2. `sidepanel.html` loads; `sidepanel-entry.ts` connects the `cherry-panel` Port
   and sends `{ kind: 'hello', windowId }`.
3. SW receives the Port → calls `ensureLeaderTab()` (idempotent, serialized;
   pinned, background, **not focused** — user stays on their page) → replies with
   the current tri-state status: `booting` (no joinUrl yet), `ready` (+joinUrl),
   or `disconnected`. It pushes status changes as the leader delivers
   `leader.join-url` / tears down.
4. On `ready`, the panel calls `mountSlicc({ iframe, joinToken, uiOnly: true, … })`
   → sets the iframe `src` to `<hosted>/?cherry=1&ui-only=1`.
5. Follower iframe boots, completes the cherry handshake with the panel (parent
   origin from `ancestorOrigins` — see Load-Bearing Verifications), reads the
   joinUrl, and joins the leader's tray over WebRTC.
6. Chat mirrors the leader; the follower advertises **no** CDP target. The agent
   drives the active tab via the real `chrome.debugger` CDP bridge.

## Security Model

Because the panel host is an **extension-origin** page (not a third-party
page's MAIN world), the joinUrl-forgery attack that required `plumbTrustedOrigin`
does not exist here:

- The joinUrl travels SW → panel over an **internal** `chrome.runtime` Port
  (same-extension, unforgeable by web content).
- The panel hands the joinUrl to the follower iframe via the cherry handshake.
  The follower is the hosted origin; there is no hostile realm in the loop.
- No `chrome.scripting`, no MAIN-world execution, no per-page trusted-origin
  plumbing.

## CSP & Framing

Two independent CSP directions must both permit the relationship:

1. **Extension CSP (`extension_pages`) — likely no change.** The current policy
   is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` with no
   `default-src`/`child-src`/`frame-src`, so framing is unrestricted and the
   panel can iframe the hosted follower without any CSP edit. If (and only if)
   the harness shows Chrome blocking the iframe, add
   `frame-src 'self' https://www.sliccy.ai http://localhost:8787` (**keeping
   `'self'`** so other extension-page iframes — sandbox shells — still load; the
   dev origin is harmless in prod builds).

2. **Follower `frame-ancestors`** — the follower response must _explicitly allow
   being framed by_ `chrome-extension://<id>`. Per CSP3, `frame-ancestors *`
   matches only HTTP(S)/same-scheme URLs; a `chrome-extension://` parent is
   **not** covered by `*` and must be named explicitly. So **neither** the
   worker's current `frame-ancestors *` (dev/staging
   `ALLOWED_CHERRY_HOST_ORIGINS=*`, `index.ts`) **nor** the current DNR rule
   (`dnr-frame-ancestors.json` — which _overwrites_ the response CSP to
   `frame-ancestors *` and only matches prod `sliccy.ai`, not dev localhost)
   authorizes the extension parent as-is.

   **Primary mechanism — (a) server CSP names the extension origin.** Committed
   default (deterministic, no header-stripping). **Resolver caveat (must fix):**
   `resolveCherryFrameAncestors()` today **short-circuits to `*`** whenever the
   `ALLOWED_CHERRY_HOST_ORIGINS` list contains a bare `*` (current config _is_
   `"*"`), so merely appending the extension origin to that list still emits
   `frame-ancestors *` — which does **not** authorize the extension. Two ways to
   make (a) real:
   - **Amend the resolver** so explicit `chrome-extension://…` origins are
     **always appended even when `*` is present** — emitting
     `frame-ancestors * chrome-extension://<id>` (valid: `*` covers HTTP(S)
     ancestors, the explicit token covers the extension). Then set
     `ALLOWED_CHERRY_HOST_ORIGINS = "*, chrome-extension://<id>"`. Preserves the
     existing wildcard third-party-embed behavior. **Preferred.**
   - **Or drop `*`** and use an explicit allowlist that includes
     `chrome-extension://<id>` (removes wildcard third-party embedding — only do
     this if that capability is unwanted).

   Prod id is fixed (from the manifest `key`); the dev harness id is
   path-derived but stable (fixed `--load-extension` path), so the local
   wrangler config lists the dev id. The plan confirms in the harness that
   Chrome honors a named `chrome-extension://<id>` ancestor (expected per CSP3,
   unlike `*`). **Fallback — (b)** below — is used only if (a) fails.
   - **(b) DNR fallback — rule that _removes_ the framing restriction on the
     `?cherry=1` follower sub-frame response** — delete the CSP header (or
     replace it _without_ `frame-ancestors`); **not** set `frame-ancestors *`.
     Must be scoped narrowly (`resourceTypes: ["sub_frame"]`, `urlFilter`
     covering **both** prod `sliccy.ai` and dev `localhost:8787`) so it never
     broadly relaxes arbitrary pages. Origin-independent, so it handles the
     varying dev extension id. If (b) ships, the `dnr-frame-ancestors.json`
     rule + its tests are updated accordingly (the current rule sets
     `frame-ancestors *` prod-only and must not be shipped as the framing
     mechanism).

   **Independent of this choice:** the `declarativeNetRequestWithHostAccess`
   permission is **retained unconditionally** — the fetch proxy uses DNR session
   rules to restore forbidden request headers (`fetch-proxy-shared.ts`), an
   already-documented independent use. Only the static frame-ancestors **rule
   resource** is added/modified/removed by this decision.

## Error Handling & Lifecycle

- **No joinUrl yet** (leader still booting / creating the tray): panel shows
  "starting SLICC…" and mounts the follower once the SW pushes the joinUrl.
- **Leader tab closed while panel open:** SW moves to `disconnected` and
  broadcasts it → panel shows disconnected; `ensureLeaderTab()` re-creates the
  leader on the next panel port-connect and the SW pushes `booting` → `ready`.
- **MV3 SW eviction:** the SW's joinUrl cache is **in-memory only** — it is lost
  when the SW is evicted. Recovery is not automatic-instant: it depends on the
  **leader-side `#lastJoinUrl` replay**, which fires when the leader's external
  bridge Port reconnects to the woken SW — and that reconnect is normally
  induced by the leader's **periodic target refresh** (`listPages()` /
  `ensureConnected()` in `page-leader-tray.ts`), not by the panel. So after
  eviction the panel Port re-connects, finds an empty cache (state `booting`),
  and shows "starting SLICC…" until the leader's next refresh reconnects the
  bridge and replays the joinUrl. The plan should make this dependency explicit
  and MAY add
  an explicit SW→leader nudge (or shorten the gap) if the wait is too long in
  practice; it must not assume the cache survives eviction.
- **Panel Port (`cherry-panel`) lifecycle — specify explicitly:**
  - On `port.onDisconnect` (SW evicted / SW restart), the panel **reconnects**
    with backoff and re-sends `hello`; the SW replays the current tri-state
    status to the fresh Port (`booting` if the cache was cleared by eviction,
    until the leader's replay lands).
  - On a **`ready` with a new joinUrl** (leader restarted → new tray token), the
    panel **destroys the current `SliccHandle`, blanks the iframe, then
    remounts** `mountSlicc` with the new joinToken.
  - On **`disconnected`** (leader gone / reconnect gave up), the panel destroys
    the handle, **blanks the iframe**, and shows "disconnected"; it remounts on a
    subsequent `ready`. (`booting` shows the spinner — it is not teardown.)
  - **Critical:** `mountSlicc().destroy()` does **not** remove a
    caller-provided iframe (`packages/cherry/src/mount.ts` — it only removes an
    SDK-created one). The panel owns the iframe, so it MUST explicitly blank it
    (`iframe.src = 'about:blank'`, or replace the element) after every
    `destroy()` — otherwise the stale follower keeps running. (The old injected
    sidebar avoided this only because it removed the whole launcher host.)
  - The panel is **idempotent**: duplicate identical joinUrls are ignored (no
    remount) to avoid flapping from reconnect replays.
- **Follower disconnect / gave up:** the follower's existing
  `onConnectionChange` / `onGaveUp` drive the panel status; no page teardown
  races (there is no page injection).
- **`sidePanel.open()` gesture rule (fallback path only):** in the
  `openPanelOnActionClick:false` fallback, `open()` must be called before any
  async gap in `onClicked`. The committed Chrome-native path
  (`openPanelOnActionClick:true`) has no gesture juggling — Chrome opens the
  panel and `ensureLeaderTab()` runs from the panel port-connect.

## Permissions Delta

- **Add:** `sidePanel`.
- **Remove:** `scripting` (no more `executeScript`).
- **Evaluate for removal:** `activeTab` — it was added for the executeScript
  injection; the active-tab marker uses `chrome.tabs.query({ lastFocusedWindow:
true })` (the `tabs` permission), not `activeTab`, and `chrome.debugger`
  attach uses the `debugger` permission. The plan confirms nothing else needs
  `activeTab` and drops it if unused.
- **Retain:** `declarativeNetRequestWithHostAccess` (the fetch proxy needs it
  for forbidden-header restoration — independent of framing). Only the static
  frame-ancestors **rule resource** is modified/removed per CSP & Framing.
- `host_permissions: <all_urls>` is retained (fetch-proxy sign-and-forward,
  `webRequest` handoff, CDP).
- Update `docs/chrome-web-store-submission.md` justifications: drop `scripting`
  (and `activeTab` if removed), add `sidePanel`, reconcile the single-purpose
  statement. Do **not** drop the `declarativeNetRequestWithHostAccess`
  justification.

## Load-Bearing Verifications (do these first in the harness)

Three empirical unknowns gate the design; the plan verifies each **before**
building the rest, since a "no" changes the approach:

1. **Cherry handshake under a `chrome-extension://` parent.** The follower's
   `resolveParentOrigin()` (`main-cherry.ts`) uses
   `location.ancestorOrigins[0]` → `document.referrer` → same-origin. Confirm
   that, inside the follower iframe hosted in the **side panel**,
   `ancestorOrigins[0]` reports `chrome-extension://<id>`. If it does, the
   handshake targets the panel correctly. **If it does NOT** (follower would
   post the handshake to itself and time out — the same failure class as the
   referrer bug), the **contingency** is: the panel appends a trusted
   `&parent-origin=<its own origin>` hint to the follower iframe URL, and
   `resolveParentOrigin()` consumes it first. (Safe: a wrong value only breaks
   the follower's own handshake; the panel's `mountSlicc` `allowOrigins` still
   pins the follower's hosted origin.)
2. **Named `chrome-extension://<id>` in `frame-ancestors`** (CSP mechanism (a))
   is honored by Chrome for the side-panel parent. If not → DNR fallback (b).
3. **Extension side panel can iframe the remote hosted origin** with the current
   CSP (no `frame-src`). Expected yes; if blocked, add `frame-src 'self'
<hosted-origins>`.
4. **Icon-click behavior under `openPanelOnActionClick: true`.** Assert in the
   harness that the icon click (a) toggles the panel open/closed, and (b) whether
   `action.onClicked` still fires. The design must not depend on `onClicked`
   firing (the leader is ensured from the panel port-connect); this check just
   pins the real behavior and confirms the removed injection listener isn't
   silently re-invoked.

## Local Development (`dev:extension:fresh`) — first-class deliverable

`npm run dev:extension:fresh`
(`packages/dev-tools/tools/dev-extension-fresh.sh`) MUST stand up a **fully
working** local environment where the side-panel follower connects end-to-end,
with **no manual intervention**. This is a deliverable, not just a test
convenience — getting a connected follower locally was the single largest time
sink while building the injection version, for the reason below.

**The problem it must solve.** The follower iframe loads from the app origin
(`http://localhost:8787` in dev) and is controlled by the `llm-proxy-sw` service
worker (scope `/`). That SW passes **same-origin** fetches through but routes
**cross-origin** fetches through `/api/fetch-proxy` — an endpoint that exists
only on a node-server, not on the worker-served app. The current harness forces
the tray to the **deployed staging** worker via
`TRAY_WORKER_BASE_URL_OVERRIDE`, so the follower's tray fetch is cross-origin →
intercepted → `{"error":"Fetch proxy not available in worker mode"}` → the
follower never connects. (Staging's capability-route CORS allowlist also
excludes `localhost:8787`, so even bypassing the SW would not help.) The
side-panel follower hits this identically — its iframe is still
`localhost:8787/?cherry=1&ui-only=1`.

**The fix (verified this session).** Run the tray **locally and same-origin** on
`localhost:8787` with functional Durable Objects instead of pointing at deployed
staging. Concretely, `wrangler dev --env staging` works because the `staging`
env has `routes: []`, so the worker's `url.origin` resolves to
`http://localhost:8787`. (The default env's `routes: www.sliccy.ai/*` otherwise
bakes `www.sliccy.ai` into the `/tray` join/controller capability URLs, so the
local leader attaches its controller WebSocket to prod and the tray never goes
active.) The `TRAY_WORKER_BASE_URL_OVERRIDE` staging var is dropped (never set
to a cross-origin value). No TURN secrets are needed — same-machine leader-tab ↔
side-panel-follower WebRTC establishes on host/STUN candidates.

With this, `runtime-config` + `/tray` capability URLs are all
`http://localhost:8787`, the leader auto-becomes an active tray leader with a
`localhost` joinUrl, and the follower's tray fetch is same-origin → the
`llm-proxy-sw` passes it through → the follower connects.

**Deliverable:** rework `dev-extension-fresh.sh` — specifically the wrangler
launch that currently passes `TRAY_WORKER_BASE_URL_OVERRIDE=<staging>`
(`dev-extension-fresh.sh:180`) — to instead launch a working local same-origin
tray: drop that override and run either `wrangler dev --env staging` (its
`routes: []` makes `url.origin` = `localhost:8787`) or (cleaner) a dedicated
local wrangler env with `routes: []`; the plan picks. Leader must come up active
and the panel follower must connect with zero manual steps. Document it in
`packages/chrome-extension/CLAUDE.md`.

## Testing Strategy

- **Unit (`packages/chrome-extension/tests/`):**
  - `sidepanel-entry`: sends `hello` + `windowId`, then on each tri-state
    message renders the right state — `booting` → spinner (no `mountSlicc`),
    `ready` → `mountSlicc` with `uiOnly: true` + the chat-focused feature set,
    `disconnected` → handle destroyed + iframe blanked; a **new** `ready` joinUrl
    remounts (destroy + blank + mount); a duplicate `ready` is a no-op.
  - SW: `cherry-panel` Port connect → `ensureLeaderTab()` + tri-state reply;
    `booting`→`ready` push on `leader.join-url`; `disconnected` push on
    `handleLeaderTabRemoved()` / teardown, broadcast to all panel ports.
  - `setPanelBehavior({ openPanelOnActionClick: true })` wiring (Chrome-native
    toggle; the leader is ensured from the port-connect, not `onClicked`).
    Fallback `onClicked` → `open()`/`close()` is tested only if it ships.
- **Reuse:** the ui-only follower tests (`page-follower-tray-uionly`,
  `wc-follower`), the active-tab marker test, and `main-cherry` tests
  (including the ancestorOrigins cases).
- **Remove:** injection/relay/generation/`plumbTrustedOrigin` tests.
- **Coverage:** keep each package at/above its `coverage-thresholds.json` floor.
- **Live (via `npm run dev:extension:fresh`, no manual hacks):** icon → panel
  opens, stays on page → follower connects over the local same-origin tray →
  chat mirrors the leader → **no `cherry`/`slicc-cherry` target is federated**
  (verified via the leader's `listAllTargets`) → the agent drives the active tab
  via real `chrome.debugger` CDP → re-click closes the panel.

## Reuse Mapping (old injection tasks → new)

| Old task (injection)                         | Fate in side-panel rework                      |
| -------------------------------------------- | ---------------------------------------------- |
| 1 — cherry `mountSlicc` iframe/uiOnly        | **Keep** (panel calls `mountSlicc`)            |
| 2 — ui-only advertise suppression            | **Keep**                                       |
| 3 — spoon launcher open/close/managed-iframe | **Drop** (panel is the container)              |
| 4 — active-tab marker                        | **Keep** (more central)                        |
| 5 — leader→SW joinUrl over bridge Port       | **Keep** (SW serves it to the panel)           |
| 6 — manifest `scripting`+`activeTab`         | **Rework** (drop `scripting`, add `sidePanel`) |
| 7 — ISOLATED relay + protocol                | **Remove**                                     |
| 8 — MAIN entry `cherry-sidebar-main`         | **Replace** with `sidepanel-entry`             |
| 9 — SW injection wiring                      | **Replace** with SW panel wiring               |
| 10 — build wiring + docs                     | **Rework** (panel bundle; docs)                |

## Deferred (implementation-time) Decision

- **Toggle mechanism — committed primary: Chrome-native.**
  `setPanelBehavior({ openPanelOnActionClick: true })` — Chrome opens/closes the
  panel on icon click and **owns the open/closed state**, so there is no
  SW-tracked open-state to lose on eviction and no `open()` user-gesture timing
  to manage. `ensureLeaderTab()` + joinUrl delivery run from the panel's
  `cherry-panel` port-connect (the panel loads → connects → SW ensures the
  leader), so the leader comes up when the panel opens regardless of `onClicked`.
  This is the design's toggle mechanism. The current cherry-injection
  `action.onClicked` listener is removed as part of the switch.
  - **Minimum Chrome version.** sidePanel + `open()` are Chrome 114+;
    `sidePanel.close()` is 141+ and `onClosed` is 142+. The plan sets
    `minimum_chrome_version` in the manifest to the chosen floor and picks the
    toggle path against it:
    - **Chrome ≥ target that natively toggle-closes on `openPanelOnActionClick`:**
      done — no extra close code.
    - **If native toggle-close proves unreliable AND floor ≥ 141:** wire
      `openPanelOnActionClick: false` + `action.onClicked` → `open({ windowId })`
      if closed / `close({ windowId })` if open (**not**
      `setOptions({ enabled:false })`), deriving open-state from live
      `cherry-panel` ports. Known degradation: the **first** action-click right
      after an SW eviction (before the open panel's port reconnected) may re-open
      an already-open panel instead of closing; the next click closes it.
    - **Floor < 141 with unreliable native toggle-close:** there is **no
      programmatic close** (`close()` doesn't exist) — the icon opens and the
      user closes via the panel's built-in control. Only relevant if the floor is
      set below 141.

    The plan confirms native toggle-close in the harness (Chrome 149) and only
    adds the manual path if that check fails.

## Success Criteria

1. Clicking the icon opens a window-level side panel and leaves the current page
   focused; the leader tab is created pinned in the background, not focused.
2. The panel's follower connects to the leader over the tray and mirrors chat.
3. No `cherry`/`slicc-cherry` CDP target is federated (ui-only holds).
4. The agent drives the active tab via real `chrome.debugger` CDP.
5. Nothing is injected into any third-party page; the `scripting` permission is
   gone. The follower is framed via **committed mechanism (a)** — server CSP
   emits `frame-ancestors … chrome-extension://<id>` (resolver amended so
   explicit extension origins survive a `*` list) — and the static
   `frame_ancestors_sliccy` DNR rule is removed (the DNR remove/replace fallback
   (b) ships only if (a) is shown not to work in the harness).
6. `npm run dev:extension:fresh` stands up a working local environment
   (same-origin local tray) where the panel follower connects end-to-end with
   **zero manual steps**.
7. All gates green (lint, typecheck, test, coverage, both builds); docs updated.
