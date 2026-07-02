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
Toolbar icon (chrome.action.onClicked)
  → sidePanel.open({ windowId })         [synchronous, in the user gesture]
  → ensureLeaderTab()                    [async, after open — pinned, background]

sidepanel.html  (chrome-extension://<id>/ — trusted extension page)
  └─ sidepanel-entry.ts
       ├─ chrome.runtime.connect({ name: 'cherry-panel' })  → Service Worker
       │     ← { kind: 'join-url', joinUrl }  (cached leader tray joinUrl, or push when ready)
       │     ← { kind: 'join-url', joinUrl: null }  (leader gone → disconnected)
       └─ mountSlicc({ iframe, joinToken: joinUrl, uiOnly: true, features: CHAT_FOCUSED })
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
(already a legacy no-op for cherry). The DNR `frame_ancestors_sliccy` rule +
`declarativeNetRequestWithHostAccess` are handled under **CSP & Framing** below
(kept or removed based on a framing verification, not assumed).

### Add (side panel)

- **`packages/chrome-extension/sidepanel.html`** — minimal shell hosting a
  single follower iframe container + a small connection-status affordance.
- **`packages/chrome-extension/src/sidepanel-entry.ts`** — the panel host:
  opens the `cherry-panel` Port to the SW, receives the joinUrl, calls
  `mountSlicc({ iframe, joinToken, uiOnly: true, sliccOrigin, capabilities,
features })`, and renders connection state (connecting / connected /
  disconnected). Bundled by an esbuild `closeBundle` plugin in `vite.config.ts`
  (same pattern as `secrets-entry`).
- **SW side-panel wiring** (in `cherry-sidebar-sw.ts`, repurposed): register the
  `cherry-panel` `chrome.runtime.onConnect` handler → on connect, call
  `ensureLeaderTab()` and reply with the cached leader joinUrl (or push it when
  the leader later delivers `leader.join-url`); forward `joinUrl: null` on
  leader teardown. `chrome.action.onClicked` (in `service-worker.ts`) →
  `sidePanel.open({ windowId })` then `ensureLeaderTab()`.
- **Manifest:** `sidePanel` permission; `side_panel.default_path =
"sidepanel.html"`; CSP `extension_pages` gains `frame-src <hosted-origins>`
  (prod `https://www.sliccy.ai` + dev `http://localhost:8787`).
- **`chrome.d.ts`:** `chrome.sidePanel` typings (`open`, `setOptions`,
  `setPanelBehavior`).

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

1. User clicks the toolbar icon.
2. `action.onClicked` calls `sidePanel.open({ windowId })` **synchronously**
   (Chrome requires `open()` within the user-gesture task), then `await
ensureLeaderTab()`.
3. `sidepanel.html` loads; `sidepanel-entry.ts` connects the `cherry-panel` Port.
4. SW receives the Port → calls `ensureLeaderTab()` (idempotent, serialized) →
   if a leader joinUrl is cached, sends `{ kind: 'join-url', joinUrl }`; else
   waits and sends it when the leader delivers `leader.join-url`.
5. Panel receives the joinUrl → `mountSlicc({ iframe, joinToken, uiOnly: true,
… })` → sets the iframe `src` to `<hosted>/?cherry=1&ui-only=1`.
6. Follower iframe boots, completes the cherry handshake with the panel, reads
   the joinUrl, and joins the leader's tray over WebRTC.
7. Chat mirrors the leader; the follower advertises **no** CDP target. The agent
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

1. **Extension CSP (`extension_pages`)** must add `frame-src` for the hosted
   origin(s) so the panel is _allowed to_ iframe the follower: prod
   `https://www.sliccy.ai` and dev `http://localhost:8787`.
   `script-src 'self' 'wasm-unsafe-eval'` is unchanged (the panel shell script
   is bundled/self; the follower runs in its own hosted origin inside the
   iframe). Because the manifest CSP is static, both origins are listed (the dev
   origin is harmless in prod builds), matching how the `key` strip differs
   dev/prod via `SLICC_EXT_DEV`.

2. **Follower `frame-ancestors`** — the follower response must _allow being
   framed by_ `chrome-extension://<id>`. This is the load-bearing unknown:
   whether the cloudflare-worker's `frame-ancestors *` (dev/staging
   `ALLOWED_CHERRY_HOST_ORIGINS=*`) actually authorizes a `chrome-extension://`
   ancestor is **version/spec-sensitive** (`*` is not guaranteed to cover
   non-network schemes). The implementation plan **verifies this in the live
   harness** and keeps exactly one mechanism:
   - **(a) Server CSP:** `resolveCherryFrameAncestors` /
     `ALLOWED_CHERRY_HOST_ORIGINS` includes the extension origin (or `*` if
     Chrome honors it for extension framers). Preferred if it works.
   - **(b) DNR fallback:** retain a `declarativeNetRequest` rule (like today's
     `dnr-frame-ancestors.json`, but its `urlFilter` widened to also match the
     dev origin) that **strips** `frame-ancestors` from the `?cherry=1` follower
     response so the extension can frame it regardless of server CSP. If (a)
     works, this rule and `declarativeNetRequestWithHostAccess` are removed; if
     not, they are kept and repurposed.

   Exactly one of (a)/(b) ships; the plan decides based on the live check.

## Error Handling & Lifecycle

- **No joinUrl yet** (leader still booting / creating the tray): panel shows
  "starting SLICC…" and mounts the follower once the SW pushes the joinUrl.
- **Leader tab closed while panel open:** SW sends `{ joinUrl: null }` → panel
  shows disconnected; `ensureLeaderTab()` re-creates it on the next icon click /
  Port reconnect and the SW re-pushes the new joinUrl.
- **MV3 SW eviction:** handled by the existing `#lastJoinUrl` reconnect replay
  (the leader re-sends `leader.join-url` when its bridge Port reconnects to a
  woken SW). The panel Port re-connects on SW wake and re-requests the joinUrl.
- **Follower disconnect / gave up:** the follower's existing
  `onConnectionChange` / `onGaveUp` drive the panel status; no page teardown
  races (there is no page injection).
- **`sidePanel.open()` gesture rule:** `open()` must be called before any async
  gap in `onClicked`; `ensureLeaderTab()` runs after. Documented so the
  implementer preserves ordering.

## Permissions Delta

- **Add:** `sidePanel`.
- **Remove:** `scripting` (no more `executeScript`).
- **Evaluate for removal:** `activeTab` — it was added for the executeScript
  injection; the active-tab marker uses `chrome.tabs.query({ lastFocusedWindow:
true })` (the `tabs` permission), not `activeTab`, and `chrome.debugger`
  attach uses the `debugger` permission. The plan confirms nothing else needs
  `activeTab` and drops it if unused.
- **Conditional:** `declarativeNetRequestWithHostAccess` + the framing rule —
  kept or removed per the CSP & Framing verification (mechanism (a) vs (b)).
- `host_permissions: <all_urls>` is retained (fetch-proxy sign-and-forward,
  `webRequest` handoff, CDP).
- Update `docs/chrome-web-store-submission.md` justifications: drop `scripting`
  (and `activeTab`/DNR if removed), add `sidePanel`, reconcile the
  single-purpose statement.

## Testing Strategy

- **Unit (`packages/chrome-extension/tests/`):**
  - `sidepanel-entry`: connects the Port, receives a joinUrl, calls `mountSlicc`
    with `uiOnly: true` and the chat-focused feature set; renders connection
    states (connecting on no-joinUrl, connected on joinUrl, disconnected on
    `null`).
  - SW: `cherry-panel` Port connect → `ensureLeaderTab()` + joinUrl reply;
    joinUrl push on `leader.join-url`; `null` push on teardown; `onClicked` →
    `sidePanel.open()` ordering (open before the async ensure).
  - `setPanelBehavior` / manifest wiring.
- **Reuse:** the ui-only follower tests (`page-follower-tray-uionly`,
  `wc-follower`), the active-tab marker test, and `main-cherry` tests
  (including the ancestorOrigins cases).
- **Remove:** injection/relay/generation/`plumbTrustedOrigin` tests.
- **Coverage:** keep each package at/above its `coverage-thresholds.json` floor.
- **Live (manual):** icon → panel opens, stays on page → follower connects over
  the tray → chat mirrors the leader → **no `cherry`/`slicc-cherry` target is
  federated** (verified via the leader's `listAllTargets`) → the agent drives the
  active tab via real `chrome.debugger` CDP → re-click closes the panel.

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

- **Toggle mechanism.** Primary plan: `openPanelOnActionClick: false` +
  `action.onClicked` → `sidePanel.open()` (gesture-safe) with SW-tracked
  per-window open state; close via `setOptions({ enabled: false })` (then
  re-enable). The exact close semantics are version-sensitive; the plan will pin
  this against real Chrome behavior in the live harness. The **behavior** (icon
  toggles the cockpit) is fixed regardless of mechanism.

## Success Criteria

1. Clicking the icon opens a window-level side panel and leaves the current page
   focused; the leader tab is created pinned in the background, not focused.
2. The panel's follower connects to the leader over the tray and mirrors chat.
3. No `cherry`/`slicc-cherry` CDP target is federated (ui-only holds).
4. The agent drives the active tab via real `chrome.debugger` CDP.
5. Nothing is injected into any third-party page; the `scripting` permission is
   gone (DNR framing rule kept or removed per the CSP & Framing verification).
6. All gates green (lint, typecheck, test, coverage, both builds); docs updated.
