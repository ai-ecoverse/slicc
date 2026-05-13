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

The Chrome extension grows a third UI runtime mode alongside `extension` (tabbed side panel) and `electron-overlay`: **`extension-detached`**. The agent stays in the offscreen document — same `OffscreenBridge`, same `OffscreenClient` — so chat history, scoops, VFS, sprinkles, and licks survive popping in and out. The detached tab plays the same role as the side panel from the bridge's perspective (a UI client of the offscreen agent), but mutual exclusion ensures only one such client is alive at any time — so the bridge does not need to fan out to multiple panels.

Mutual exclusion is global across all Chrome windows: at most one detached tab exists at a time, and when it exists the side panel is disabled. The service worker is the sole coordinator and persists its state in `chrome.storage.session` so it survives MV3 service worker eviction.

The detached tab's URL is `chrome-extension://<id>/index.html?detached=1`. The query parameter is the runtime-mode signal, mirroring the existing `electron-overlay` precedent in `runtime-mode.ts`. The URL is self-describing: bookmarks, paste-into-tab, and Chrome's tab restore all work without any additional state.

## Components

| Component                                           | Change                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                     | No changes. Extension pages don't need `web_accessible_resources` to be navigated to by the extension itself; `tabs` permission is already present.                                                                                                           |
| `packages/webapp/src/ui/runtime-mode.ts`            | Add `'extension-detached'` to `UiRuntimeMode`. Add `DETACHED_RUNTIME_QUERY_NAME = 'detached'` and `DETACHED_RUNTIME_QUERY_VALUE = '1'`. `resolveUiRuntimeMode` returns `'extension-detached'` when `isExtension && url.searchParams.get('detached') === '1'`. |
| `packages/webapp/src/ui/main.ts`                    | Branch on `'extension-detached'` to call `mainExtension(app, { detached: true })`. In detached mode, `mainExtension` instantiates the standalone `Layout` from `layout.ts` instead of `TabbedUI`. On boot, emit `slicc:detached-claim` to the SW.             |
| `packages/chrome-extension/src/service-worker.ts`   | New state machine for detached lifecycle, persisted in `chrome.storage.session`. New message handlers for `slicc:popout` and `slicc:detached-claim`. New `chrome.action.onClicked` handler. New `chrome.tabs.onRemoved` listener that resolves the lock.      |
| `packages/chrome-extension/src/messages.ts`         | Typed envelopes for the three new messages.                                                                                                                                                                                                                   |
| Side panel UI (extension `main.ts` path)            | New header button "Pop out" that sends `slicc:popout` to the SW. Listens for `slicc:detached-active` from the SW and calls `window.close()` on receipt.                                                                                                       |
| `packages/chrome-extension/src/offscreen-bridge.ts` | No changes. Broadcast is already client-agnostic via `chrome.runtime` and tolerates a panel closing and a new panel opening — the same path used today when a user closes and reopens the side panel.                                                         |

The detached layout reuses every existing panel (`ChatPanel`, `FileBrowserPanel`, `MemoryPanel`, `RemoteTerminalView`) without modification.

## Data flow

### Pop out flow (button click)

```
Side panel: button click
  → chrome.runtime.sendMessage({ type: 'slicc:popout' }) → SW

SW: receives popout
  → chrome.tabs.create({ url: chrome.runtime.getURL('index.html?detached=1') })
  → returns; the lock change is driven by the tab's boot, not by tab creation

Detached tab: main() boots, detects ?detached=1
  → resolveUiRuntimeMode → 'extension-detached'
  → mainExtension(app, { detached: true }) constructs Layout + OffscreenClient
  → chrome.runtime.sendMessage({ type: 'slicc:detached-claim' })

SW: receives claim with sender.tab.id = T
  → if !storage.detachedTabId or that tab no longer exists:
      storage.detachedTabId = T
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      chrome.sidePanel.setOptions({ enabled: false })
      chrome.runtime.sendMessage({ type: 'slicc:detached-active' })
  → else (a different detached tab is already the official one):
      chrome.tabs.remove(T)
      chrome.tabs.update(storage.detachedTabId, { active: true })

Side panel: receives slicc:detached-active → window.close()
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

In every case, if a side panel is open at the moment the detached tab boots, the SW broadcasts `slicc:detached-active` and the side panel closes itself.

## State persistence

The SW persists exactly one piece of state: the current detached `tabId`, stored in `chrome.storage.session` under a single key (e.g., `slicc.detached.tabId`). `chrome.storage.session` is intentionally chosen over `chrome.storage.local` because:

- It survives MV3 service worker eviction within the same browser session.
- It is cleared on browser restart, which is exactly the behavior we want — a "restored" detached tab from Chrome's tab-restore feature will re-claim on boot rather than relying on stale storage.

All SW event handlers (`onMessage`, `onClicked`, `onRemoved`) read storage on entry rather than relying on in-memory state, so eviction is transparent.

## Error handling and edge cases

| Case                                                                                        | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached tab fails to load (network error, extension reload mid-boot)                       | Side panel never receives `slicc:detached-active`, stays open. SW has no half-locked state because the lock only sets on `slicc:detached-claim`, not on `chrome.tabs.create`. User can retry.                                                                                                                                                                                                                                                                   |
| SW evicted while detached tab is open                                                       | `chrome.storage.session` survives eviction. Next event handler entry re-reads it. No drift.                                                                                                                                                                                                                                                                                                                                                                     |
| Storage cleared but detached tab still alive                                                | Tab continues to function as a UI client (offscreen still serves it). The side panel may briefly be unlocked. Accept this small window rather than build a heartbeat — recovery happens naturally on the next message round trip if the tab does anything that goes through the SW.                                                                                                                                                                             |
| Two detached URLs opened in rapid succession                                                | First claim wins via the `storage.detachedTabId` check; second tab's claim is rejected and the SW closes that tab and focuses the first.                                                                                                                                                                                                                                                                                                                        |
| User reloads detached tab (Ctrl-R)                                                          | URL preserved → re-detects mode → re-emits claim. SW sees existing storage entry for the same `tabId` → idempotent.                                                                                                                                                                                                                                                                                                                                             |
| Chrome tab-restore on browser startup with detached tab open                                | Tab restores with URL intact. SW storage was cleared on browser restart but is repopulated by the claim. No side panel is open to interfere.                                                                                                                                                                                                                                                                                                                    |
| User closes the window containing the detached tab                                          | `chrome.tabs.onRemoved` fires for the detached tab → normal return flow.                                                                                                                                                                                                                                                                                                                                                                                        |
| `chrome.sidePanel.open({ tabId })` in `chrome.action.onClicked` stale-storage path          | Permitted because the handler is invoked from a user gesture.                                                                                                                                                                                                                                                                                                                                                                                                   |
| User clicks the popout button while the SW has just been evicted and is still cold-starting | `chrome.runtime.sendMessage` waits for the SW to come up. The message is delivered.                                                                                                                                                                                                                                                                                                                                                                             |
| User clicks the popout button twice in quick succession before the first tab boots          | Two tabs are created. Both boot and emit `slicc:detached-claim`. First claim wins; second is closed by the SW and the first is focused.                                                                                                                                                                                                                                                                                                                         |
| Spoofing: page script tries to send a fake `slicc:detached-claim` to lock the SW            | The SW uses `sender.tab.id` from `chrome.runtime.onMessage` — the tab-identity is provided by Chrome, not by the message payload. A page outside the extension origin cannot send to the extension SW. A page inside the extension origin that isn't a detached tab would still legitimately bind a `tabId`, but the claim is harmless because the SW additionally validates the sender's URL matches `chrome.runtime.getURL('index.html')` with `?detached=1`. |

## Security considerations

- All new message types use `sender.tab.id` from `chrome.runtime.onMessage`, never values supplied in the message body, for tab identity.
- The SW additionally checks `sender.url` on `slicc:detached-claim` to verify the message originates from the extension's own `index.html?detached=1`. This is defense-in-depth — Chrome already restricts cross-origin senders, but the check makes the contract explicit.
- No new permissions required. `tabs`, `sidePanel`, `storage` are already in the manifest.

## Testing

| Layer                         | What to test                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `runtime-mode.ts`             | `resolveUiRuntimeMode` returns `'extension-detached'` for `?detached=1` only when `isExtension=true`; returns `'standalone'`/`'extension'` otherwise; precedence with `electron-overlay` value                                                                                                                                                                                                                                     | `packages/webapp/tests/ui/runtime-mode.test.ts` (extend existing)                                     |
| SW state machine              | Claim while empty → locks. Claim while occupied (different tab) → closes new tab, focuses existing. Claim while occupied (same tab — reload) → idempotent. `tabs.onRemoved` of locked tab → unlocks. `tabs.onRemoved` of unrelated tab → no change. `action.onClicked` while locked → focuses tab. `action.onClicked` while locked but tab is gone → recovers and opens side panel. Storage persists across simulated SW eviction. | `packages/chrome-extension/tests/service-worker-detached.test.ts` (new)                               |
| Side panel popout request     | Button click sends `slicc:popout`; receiving `slicc:detached-active` triggers `window.close()`                                                                                                                                                                                                                                                                                                                                     | Extend existing side panel UI tests                                                                   |
| Layout selection in `main.ts` | When mode is `'extension-detached'`, `mainExtension` instantiates `Layout` not `TabbedUI`                                                                                                                                                                                                                                                                                                                                          | Acceptable to lean on manual QA plus the runtime-mode unit test, given `main.ts` resists unit testing |
| Manual QA recipe              | The existing `packages/chrome-extension/CLAUDE.md` recipe (load Chrome for Testing with `--load-extension`) extended: open `chrome-extension://<id>/index.html?detached=1` directly and verify the locking flow end-to-end. Also: click the popout button from the side panel; close the detached tab; reload the detached tab; restart Chrome with the detached tab open.                                                         | Documented in `packages/chrome-extension/CLAUDE.md`                                                   |
| Coverage                      | New SW code must keep the `chrome-extension` package above its existing coverage floor (55% lines/statements, 45% branches, 60% functions).                                                                                                                                                                                                                                                                                        | Existing CI gate                                                                                      |

## Documentation impact

The following files need updates as part of this change (per the project's "tests, docs, verification" gate):

- `packages/chrome-extension/CLAUDE.md` — add a section on detached mode, the SW state machine, and an updated local QA recipe step.
- `packages/webapp/CLAUDE.md` — note the third `UiRuntimeMode` value in the UI section, and the `Layout`-vs-`TabbedUI` selection.
- `docs/architecture.md` — extend the extension three-layer architecture description to mention the detached tab as a second valid panel surface.
- `docs/pitfalls.md` — add an entry on the "boot is the lock event" model (specifically: the popout button is convenience, not a trust signal; direct URL access is a first-class entry path).
- Root `CLAUDE.md` — minor mention in the extension build/run notes if relevant.
- `README.md` — user-facing description of the popout feature.

## Open questions

None. All decisions captured.

## Out of scope (future work)

- A configurable "always start detached" user preference. The current design intentionally lets Chrome's session-restore drive this implicitly — if the detached tab is open when the user closes Chrome, it comes back detached.
- Multi-window support (side panel in window A, separate detached in window B). The "global lock" decision rules this out; revisiting would require reintroducing the multi-client handling that the current design eliminates.
- A `chrome.commands` keyboard shortcut. Easy to add later without disturbing the design — the trigger is just one extra entry point that calls the same `slicc:popout` message.
