# Extension detached popout — design spec

**Date:** 2026-05-13
**Status:** Draft
**Branch:** `feat/extension-detached-popout`

## Goal

Allow a user of the SLICC Chrome extension to "pop out" the side panel into a full-page Chrome tab during a session, so they can work with the standalone split-pane layout when they want more screen real estate. The popout is transient — the side panel remains the default surface; popping out is a per-session choice, restored automatically if Chrome restores the detached tab on next launch.

## Non-goals

- Multi-monitor management or window placement.
- Replacing the side panel as the primary surface.
- Persisting "user prefers detached" as a setting across browser sessions.
- Running multiple UI clients (side panel + detached tab) against the same agent simultaneously.
- Detaching the agent itself — the agent stays in the offscreen document regardless of which UI surface is in use.

## User stories

1. As a user with a side panel open, I click a "pop out" button in the side panel header and SLICC opens in a new tab with the full split-pane layout, sharing the same chat history, scoops, and VFS state. The side panel closes itself.
2. As a user with a detached tab open, I close the tab and the side panel availability is restored. Next time I click the toolbar icon, the side panel opens normally.
3. As a user with a detached tab open, I click the SLICC toolbar icon and Chrome focuses my existing detached tab instead of opening another side panel.
4. As a user, I can drag the detached tab into its own Chrome window for a multi-monitor setup. No extra code path is needed — Chrome's native tab-drag behavior handles this.
5. As a user, Chrome restores my detached tab when I relaunch the browser (via "Continue where you left off" or session restore). SLICC re-enters detached mode automatically and the side panel stays locked.

## Architecture

The Chrome extension grows a third UI runtime mode alongside `extension` (side panel) and `electron-overlay`: **`extension-detached`**. The agent stays in the offscreen document — same `OffscreenBridge`, same `OffscreenClient` — so chat history, scoops, VFS, sprinkles, and licks survive popping in and out. The detached tab plays the same role as the side panel from the bridge's perspective (a UI client of the offscreen agent), but mutual exclusion ensures only one such client is alive at any time — so the bridge does not need to fan out to multiple panels.

The UI shell is the unified `Layout(root, isExtension)` class in `packages/webapp/src/ui/layout.ts`. The legacy tabbed extension layout has been retired; both extension and standalone runtimes use the same split-pane shell with `isExtension` toggling header/scoops-rail density. Detached mode passes `isExtension = false` so the tab gets the roomier standalone styling that matches its full-viewport surface. There is no `TabbedUI` class to swap in.

Mutual exclusion is global across all Chrome windows: at most one detached tab exists at a time, and when it exists the side panel is disabled and any non-detached `index.html` tabs (e.g., the QA recipe surface — see "Non-detached `index.html` tabs" below) self-close. The service worker is the sole coordinator and persists its state in `chrome.storage.session` so it survives MV3 service worker eviction.

The detached tab's URL is `chrome-extension://<id>/index.html?detached=1`. The query parameter is a URL-level runtime-mode signal — analogous to the `runtime=electron-overlay` URL marker in `runtime-mode.ts`, though `extension-detached` is selected on a different branch of `resolveUiRuntimeMode` (the `isExtension === true` branch, which today short-circuits to `'extension'`). The URL is self-describing: bookmarks, paste-into-tab, and Chrome's tab restore all work without any additional state.

## Components

| Component                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                     | No changes. Extension pages don't need `web_accessible_resources` to be navigated to by the extension itself; `tabs` permission is already present.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/webapp/src/ui/runtime-mode.ts`            | Add `'extension-detached'` to `UiRuntimeMode`. Add `DETACHED_RUNTIME_QUERY_NAME = 'detached'` and `DETACHED_RUNTIME_QUERY_VALUE = '1'`. `resolveUiRuntimeMode` returns `'extension-detached'` when `isExtension && url.searchParams.get('detached') === '1'`.                                                                                                                                                                                                                                                                                                           |
| `packages/webapp/src/ui/main.ts`                    | Branch on `'extension-detached'` to call `mainExtension(app, { detached: true })`. In detached mode, `mainExtension` instantiates `new Layout(app, false)` (standalone density) instead of the current `new Layout(app, true)`. On boot, emit a `detached-claim` envelope to the SW. Unconditionally install the `detached-active` listener (so plain `index.html` tabs without `?detached=1` also self-close when a detached tab claims the lock).                                                                                                                     |
| `packages/chrome-extension/src/service-worker.ts`   | New state machine for detached lifecycle, persisted in `chrome.storage.session`. New message handlers for the `detached-popout-request` and `detached-claim` envelopes (see protocol section below). New `chrome.action.onClicked` handler. New `chrome.tabs.onRemoved` listener that resolves the lock when the detached tab disappears.                                                                                                                                                                                                                               |
| `packages/chrome-extension/src/messages.ts`         | Extend the existing `ServiceWorkerEnvelope` and `PanelEnvelope` payload unions with the three new discriminator types (`detached-popout-request`, `detached-claim`, `detached-active`). The envelope infrastructure itself is already in place (`ServiceWorkerEnvelope` at `messages.ts:539–544`); only payload-union additions are required.                                                                                                                                                                                                                           |
| `packages/chrome-extension/src/chrome.d.ts`         | Type surface additions required by the SW flow: `sidePanel.setOptions({ enabled?, path?, tabId? })`, `sidePanel.open({ tabId })`, `action.onClicked.addListener(callback: (tab) => void)`, `tabs.onRemoved.addListener(callback: (tabId, removeInfo) => void)`, `tabs.update(tabId, { active })`, `windows.update(windowId, { focused })`, `storage.session` (same shape as `storage.local`). Plus `chrome.runtime.onMessage` already provides `sender.tab.id` and `sender.url` — those are already in `ChromeMessageSender` and `ChromeTab` but verify field coverage. |
| Side panel UI (extension `main.ts` path)            | New header button "Pop out" that sends a `detached-popout-request` envelope to the SW. Listens for `detached-active` and calls `window.close()` on receipt (with a fallback documented in error-handling).                                                                                                                                                                                                                                                                                                                                                              |
| `packages/chrome-extension/src/offscreen-bridge.ts` | No changes. Broadcast is already client-agnostic via `chrome.runtime` and tolerates a panel closing and a new panel opening — the same path used today when a user closes and reopens the side panel. Mutual exclusion ensures the bridge only ever fans out to one live UI client at a time.                                                                                                                                                                                                                                                                           |
| `packages/webapp/src/ui/runtime-mode.ts` (more)     | `shouldUseRuntimeModeTrayDefaults` classifies `'extension-detached'` like `'extension'` (returns `false` — no tray defaults). Detached is still an extension runtime, just with a different UI surface.                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/webapp/src/ui/telemetry.ts`               | `getModeLabel()` either continues to return `'extension'` for detached (acceptable — same runtime), or extends to `'extension-detached'` if product wants RUM segmentation. Decision documented in the implementation plan; default is no change to keep this spec scope-bounded.                                                                                                                                                                                                                                                                                       |

The detached layout reuses every existing panel (`ChatPanel`, `FileBrowserPanel`, `MemoryPanel`, `RemoteTerminalView`) without modification.

## Message protocol

All new messages follow the existing `ExtensionMessage` envelope (`{ source, payload }`) defined in `packages/chrome-extension/src/messages.ts`. Bare `{ type: 'detached-popout-request' }` shapes are NOT used — they would be filtered out by the SW's `isExtMsg()` gate at `service-worker.ts:299`.

Three new envelope payloads:

```ts
// Panel → SW: user clicked the "Pop out" button.
{ source: 'panel', payload: { type: 'detached-popout-request' } }

// Detached tab → SW (on boot): claim the lock.
{ source: 'panel', payload: { type: 'detached-claim' } }

// SW → all panels (broadcast): a detached tab has claimed the lock.
//   Side panel handler: window.close().
//   Non-detached index.html tab handler: window.close().
//   Detached tab handler: ignore (it's the claimer).
{ source: 'service-worker', payload: { type: 'detached-active' } }
```

The `detached-active` listener installed in `mainExtension` must guard its `window.close()` call on the runtime mode — specifically, it MUST NOT close itself when running with `?detached=1`. The simplest form:

```ts
if (runtimeMode !== 'extension-detached') {
  window.close();
}
```

This ensures the claimer tab never inadvertently closes itself when its own broadcast echoes back, and it keeps the listener logic identical between the side panel and non-detached `index.html` surfaces.

The `payload.type` values use the existing convention of kebab-case discriminators with no `slicc:` prefix, matching the codebase pattern (e.g., `refresh-tray-runtime`, `navigate-lick`).

## Non-detached `index.html` tabs

The QA recipe in `packages/chrome-extension/CLAUDE.md` opens `chrome-extension://<id>/index.html` directly in a regular tab — this is documented as the way to drive the side-panel UI via CDP for headless testing. That tab boots `mainExtension` and becomes a UI client of the offscreen agent. The spec MUST account for this surface or the mutual-exclusion invariant breaks.

**Rule:** non-detached `index.html` tabs are treated as side-panel-equivalent for purposes of mutual exclusion. They do NOT claim the lock and they do NOT count as the canonical detached tab, but they DO listen for the `detached-active` broadcast and close themselves on receipt. This is achieved by installing the `detached-active` listener unconditionally in `mainExtension` (i.e., in both `detached: true` and `detached: false` calls).

When a detached tab claims the lock, any open side panel AND any open non-detached `index.html` tab self-closes via the same broadcast. The detached tab is the sole surviving UI client.

## Data flow

### Pop out flow (button click)

```
Side panel: button click
  → chrome.runtime.sendMessage({
      source: 'panel',
      payload: { type: 'detached-popout-request' }
    }) → SW

SW: receives detached-popout-request
  → chrome.tabs.create({ url: chrome.runtime.getURL('index.html?detached=1') })
  → returns; the lock change is driven by the tab's boot, not by tab creation

Detached tab: main() boots, detects ?detached=1
  → resolveUiRuntimeMode → 'extension-detached'
  → mainExtension(app, { detached: true }) constructs new Layout(app, false)
    + OffscreenClient
  → chrome.runtime.sendMessage({
      source: 'panel',
      payload: { type: 'detached-claim' }
    })

SW: receives detached-claim with sender.tab.id = T,
    and validates sender.url:
      if (!sender.url) reject;            // belt-and-suspenders for tests/mocks
      let u: URL;
      try { u = new URL(sender.url); }
      catch { reject; }
      const expectedOrigin = new URL(chrome.runtime.getURL('index.html')).origin;
      u.origin === expectedOrigin
        && u.pathname === '/index.html'
        && u.searchParams.get('detached') === '1'
  → if !storage.detachedTabId or chrome.tabs.get(storage.detachedTabId) rejects:
      storage.detachedTabId = T
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      chrome.sidePanel.setOptions({ enabled: false })  // see UX caveat below
      chrome.runtime.sendMessage({
        source: 'service-worker',
        payload: { type: 'detached-active' }
      })
  → else (a different detached tab is already the official one):
      chrome.tabs.remove(T)
      chrome.tabs.update(storage.detachedTabId, { active: true })

Side panel + any non-detached index.html tab:
  receives { source: 'service-worker', payload: { type: 'detached-active' } }
  → window.close()  // fallback if unreliable: see Error handling
```

### Return flow (close the tab)

```
User: closes the detached tab

SW: chrome.tabs.onRemoved fires for T
  → if T === storage.detachedTabId:
      clear storage.detachedTabId
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      chrome.sidePanel.setOptions({ enabled: true })

User: next click on the toolbar icon → side panel opens via Chrome's default behavior
```

### Toolbar icon click while detached open

```
User: clicks toolbar icon

SW: chrome.action.onClicked fires
    (because openPanelOnActionClick is false while the lock is active)
  → if storage.detachedTabId exists and chrome.tabs.get(detachedTabId) resolves:
      chrome.tabs.update(detachedTabId, { active: true })
      chrome.windows.update(tab.windowId, { focused: true })
  → else (stale storage, tab gone but onRemoved missed somehow):
      clear storage.detachedTabId
      restore sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      restore sidePanel.setOptions({ enabled: true })
      chrome.sidePanel.open({ tabId: clickedTab.id })
        // permitted because we're inside a user-gesture handler
```

### Direct URL access (bookmark, paste, Chrome tab restore)

Identical to the second half of the pop out flow. The boot of a tab with `?detached=1` is the canonical lock event — there is no separate "trusted popout" path. The popout button could call `chrome.tabs.create` from the side panel directly (the side panel has full extension-origin `chrome.*` access), but routing through the SW keeps all coordination logic in one place and is easier to test.

This means:

- Bookmarks of the detached URL work.
- Pasting the URL into a new tab works.
- Chrome's "Continue where you left off" tab restore works.
- Programmatic navigation to the URL works (e.g., from a future feature, debug recipe, or external launcher).

In every case, if a side panel (or non-detached `index.html` tab) is open at the moment the detached tab boots, the SW broadcasts `detached-active` and those surfaces close themselves.

## State persistence

The SW persists exactly one piece of state: the current detached `tabId`, stored in `chrome.storage.session` under a single key (e.g., `slicc.detached.tabId`). `chrome.storage.session` is intentionally chosen over `chrome.storage.local` because:

- It survives MV3 service worker eviction within the same browser session.
- It is cleared on browser restart, which is exactly the behavior we want — a "restored" detached tab from Chrome's tab-restore feature will re-claim on boot rather than relying on stale storage.

All SW event handlers (`onMessage`, `onClicked`, `onRemoved`) read storage on entry rather than relying on in-memory state, so eviction is transparent.

## Error handling and edge cases

| Case                                                                                        | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached tab fails to load (network error, extension reload mid-boot)                       | Side panel never receives `detached-active`, stays open. SW has no half-locked state because the lock only sets on `detached-claim`, not on `chrome.tabs.create`. User can retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SW evicted while detached tab is open                                                       | `chrome.storage.session` survives eviction. Next event handler entry re-reads it. No drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Storage cleared but detached tab still alive                                                | Tab continues to function as a UI client (offscreen still serves it). The side panel may briefly be unlocked. Accept this small window rather than build a heartbeat — recovery happens naturally on the next message round trip if the tab does anything that goes through the SW.                                                                                                                                                                                                                                                                                                                                                         |
| Two detached URLs opened in rapid succession                                                | First claim wins via the `storage.detachedTabId` check; second tab's claim is rejected and the SW closes that tab and focuses the first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| User reloads detached tab (Ctrl-R)                                                          | URL preserved → re-detects mode → re-emits claim. SW sees existing storage entry for the same `tabId` → idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Chrome tab-restore on browser startup with detached tab open                                | Tab restores with URL intact. SW storage was cleared on browser restart but is repopulated by the claim. No side panel is open to interfere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| User closes the window containing the detached tab                                          | `chrome.tabs.onRemoved` fires for the detached tab → normal return flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `chrome.sidePanel.open({ tabId })` in `chrome.action.onClicked` stale-storage path          | Permitted because the handler is invoked from a user gesture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| User clicks the popout button while the SW has just been evicted and is still cold-starting | `chrome.runtime.sendMessage` waits for the SW to come up. The message is delivered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| User clicks the popout button twice in quick succession before the first tab boots          | Two tabs are created. Both boot and emit `detached-claim`. First claim wins; second is closed by the SW and the first is focused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Spoofing: page script tries to send a fake `detached-claim` to lock the SW                  | The SW uses `sender.tab.id` from `chrome.runtime.onMessage` — the tab-identity is provided by Chrome, not by the message payload. A page outside the extension origin cannot send to the extension SW. The SW additionally parses `sender.url` and validates the origin, pathname, and `searchParams.get('detached') === '1'` (not a substring match) before accepting the claim.                                                                                                                                                                                                                                                           |
| `window.close()` may be unreliable in the side panel context                                | Chrome's documented side-panel close behavior has varied across versions; in practice `window.close()` from inside the panel works but the spec should not assume it. Fallback: the SW's `chrome.sidePanel.setOptions({ enabled: false })` call already removes the panel from the action-click flow; an open side panel persists until the user closes it, but it is no longer authoritative (its `detached-active` listener has fired and the panel can render a "Detached in another tab — click to dismiss" state if `window.close()` failed). Verify in manual QA; treat any persistent open panel as a separate bug to address there. |
| `chrome.sidePanel.setOptions({ enabled: false })` UX risk                                   | Disabling the side panel globally can affect Chrome's side-panel entry point UI (the side panel may not appear in the "Open in side panel" menu while disabled). For our flow this is the correct behavior — the user shouldn't be able to open a side panel while detached is the canonical surface — but document the UX implication so it isn't a surprise. If product wants per-tab scoping, `setOptions({ tabId, enabled: false })` is per-tab; that does NOT meet the "global lock" requirement and would require iterating every open tab. Global is the chosen tradeoff.                                                            |
| Tray runtime config sync                                                                    | Detached tab and side panel both run from the same extension origin and share `localStorage`. Tray runtime config sync (the `refresh-tray-runtime` message pattern in `offscreen.ts`) works identically whether the UI client is a side panel or a detached tab. Verified by code structure; confirm in manual QA.                                                                                                                                                                                                                                                                                                                          |

## Security considerations

- All new message types use `sender.tab.id` from `chrome.runtime.onMessage`, never values supplied in the message body, for tab identity.
- The SW additionally parses `sender.url` as a `URL` and validates `origin`, `pathname === '/index.html'`, and `searchParams.get('detached') === '1'`. Substring matches like `url.includes('?detached=1')` MUST NOT be used — they are brittle to query reordering and additional parameters. A missing `sender.url` or a `new URL()` throw MUST reject the claim outright (defensive against test mocks and unexpected sender shapes).
- The "non-detached `index.html` tabs are side-panel-equivalent" rule above is what makes the spec's mutual-exclusion guarantee real: without it, a plain `index.html` tab would silently become a second UI client and concurrent user actions (sending messages, navigating scoops) would be duplicated by the offscreen agent.
- No new permissions required. `tabs`, `sidePanel`, `storage` are already in the manifest.

## Testing

| Layer                         | What to test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `runtime-mode.ts`             | `resolveUiRuntimeMode` returns `'extension-detached'` for `isExtension=true` with `?detached=1`; returns `'extension'` for `isExtension=true` with any other query (including no query and unrelated params); returns `'standalone'`/`'electron-overlay'` only when `isExtension=false`. The `electron-overlay` value is not reachable from the `isExtension=true` branch — test only the boundary cases, not "precedence" between extension and overlay. `shouldUseRuntimeModeTrayDefaults('extension-detached')` returns `false` (matches `'extension'`). | `packages/webapp/tests/ui/runtime-mode.test.ts` (extend existing)                                     |
| SW state machine              | Claim while empty → locks. Claim while occupied (different tab) → closes new tab, focuses existing. Claim while occupied (same tab — reload) → idempotent. `tabs.onRemoved` of locked tab → unlocks. `tabs.onRemoved` of unrelated tab → no change. `action.onClicked` while locked → focuses tab. `action.onClicked` while locked but tab is gone → recovers and opens side panel. Storage persists across simulated SW eviction. `sender.url` validation rejects malformed URLs and URLs missing the `detached=1` searchParam.                            | `packages/chrome-extension/tests/service-worker-detached.test.ts` (new)                               |
| Side panel popout request     | Button click sends the `detached-popout-request` envelope; receiving `detached-active` triggers `window.close()`. Non-detached `index.html` tabs also self-close on `detached-active`.                                                                                                                                                                                                                                                                                                                                                                      | Extend existing side panel UI tests; new test for the non-detached tab path                           |
| Layout selection in `main.ts` | When mode is `'extension-detached'`, `mainExtension` instantiates `new Layout(app, false)`; in `'extension'` mode it still instantiates `new Layout(app, true)`.                                                                                                                                                                                                                                                                                                                                                                                            | Acceptable to lean on manual QA plus the runtime-mode unit test, given `main.ts` resists unit testing |
| Manual QA recipe              | The existing `packages/chrome-extension/CLAUDE.md` recipe (load Chrome for Testing with `--load-extension`) extended: open `chrome-extension://<id>/index.html?detached=1` directly and verify the locking flow end-to-end. Also verify: click the popout button from the side panel; close the detached tab; reload the detached tab; restart Chrome with the detached tab open. Specifically verify that `window.close()` from the side panel works under the current Chrome target version, and that tray runtime config survives a popout.              | Documented in `packages/chrome-extension/CLAUDE.md`                                                   |
| Coverage                      | New SW code must keep the `chrome-extension` package above its existing coverage floor (55% lines/statements, 45% branches, 60% functions).                                                                                                                                                                                                                                                                                                                                                                                                                 | Existing CI gate                                                                                      |

## Documentation impact

The following files need updates as part of this change (per the project's "tests, docs, verification" gate):

- `packages/chrome-extension/CLAUDE.md` — add a section on detached mode, the SW state machine, the `chrome.d.ts` additions, and an updated local QA recipe step. Document that the QA recipe's plain `index.html` tab is now treated as side-panel-equivalent for purposes of mutual exclusion.
- `packages/webapp/CLAUDE.md` — note the third `UiRuntimeMode` value in the UI section, and the `Layout(root, isExtension)` density distinction.
- `docs/architecture.md` — extend the extension three-layer architecture description to mention the detached tab as a second valid UI client surface. Also correct the stale "Split-pane (CLI) or tabbed (extension)" description of `layout.ts` (the tabbed layout has been retired and both modes share a split shell with density toggled by `isExtension`).
- `docs/pitfalls.md` — add an entry on the "boot is the lock event" model (the popout button is convenience, not a trust signal; direct URL access is a first-class entry path). Also document the `sender.url` parsing requirement.
- Root `CLAUDE.md` — minor mention in the extension build/run notes if relevant.
- `README.md` — user-facing description of the popout feature.

## Open questions

None. All decisions captured.

## Out of scope (future work)

- A configurable "always start detached" user preference. The current design intentionally lets Chrome's session-restore drive this implicitly — if the detached tab is open when the user closes Chrome, it comes back detached.
- Multi-window support (side panel in window A, separate detached in window B). The "global lock" decision rules this out; revisiting would require reintroducing the multi-client handling that the current design eliminates.
- A `chrome.commands` keyboard shortcut. Easy to add later without disturbing the design — the trigger is just one extra entry point that calls the same `detached-popout-request` envelope.
