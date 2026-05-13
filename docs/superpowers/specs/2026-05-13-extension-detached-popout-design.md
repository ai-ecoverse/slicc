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
5. As a user, Chrome restores my detached tab when I relaunch the browser (via "Continue where you left off" or session restore). SLICC re-enters detached mode automatically when I focus the restored tab. **Caveat:** Chrome may restore the tab in a discarded state and not run `main.ts` until I activate it; during that window the side panel is available (the lock applies once the discarded tab boots and claims).

## Architecture

The Chrome extension grows a third UI runtime mode alongside `extension` (side panel) and `electron-overlay`: **`extension-detached`**. The agent stays in the offscreen document — same `OffscreenBridge`, same `OffscreenClient` — so chat history, scoops, VFS, sprinkles, and licks survive popping in and out. The detached tab plays the same role as the side panel from the bridge's perspective (a UI client of the offscreen agent), but mutual exclusion ensures only one such client is alive at any time — so the bridge does not need to fan out to multiple panels.

The UI shell is the unified `Layout(root, isExtension)` class in `packages/webapp/src/ui/layout.ts`. The legacy tabbed extension layout has been retired; both extension and standalone runtimes use the same split-pane shell. The `isExtension` flag is not just styling — it drives concrete UX choices: scoops-rail visibility, scoop-switcher use, rail full-page behavior, avatar location, and default debug-tab visibility. Detached mode passes `isExtension = false`, which means the tab gets the full standalone rail UX (visible scoops rail, standalone avatar position, no scoop switcher dropdown, no debug-tab default-hidden behavior). This is the intended behavior — the detached tab is meant to feel like the full standalone app, not a stretched side panel. There is no `TabbedUI` class to swap in.

Mutual exclusion is global across all Chrome windows: at most one detached tab exists at a time, and when it exists the side panel is disabled and any non-detached `index.html` tabs (e.g., the QA recipe surface — see "Non-detached `index.html` tabs" below) self-close. The service worker is the sole coordinator and persists its state in `chrome.storage.session` so it survives MV3 service worker eviction.

The detached tab's URL is `chrome-extension://<id>/index.html?detached=1`. The query parameter is a URL-level runtime-mode signal — analogous to the `runtime=electron-overlay` URL marker in `runtime-mode.ts`, though `extension-detached` is selected on a different branch of `resolveUiRuntimeMode` (the `isExtension === true` branch, which today short-circuits to `'extension'`). The URL is self-describing: bookmarks, paste-into-tab, and Chrome's tab restore all work without any additional state.

## Components

| Component                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                     | No changes. Extension pages don't need `web_accessible_resources` to be navigated to by the extension itself; `tabs` permission is already present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/webapp/src/ui/runtime-mode.ts`            | Add `'extension-detached'` to `UiRuntimeMode`. Add `DETACHED_RUNTIME_QUERY_NAME = 'detached'` and `DETACHED_RUNTIME_QUERY_VALUE = '1'`. `resolveUiRuntimeMode` returns `'extension-detached'` when `isExtension && url.searchParams.get('detached') === '1'`. **No change** to `shouldUseRuntimeModeTrayDefaults` — the function's existing conditions (`'electron-overlay'` or `'standalone' + endpoint`) already return `false` for `'extension-detached'`. A test row exists below to lock this in.                                                                                                                                                                                                                                                                  |
| `packages/webapp/src/ui/main.ts` (dispatcher)       | Add a new branch in `main()` (currently at `main.ts:2386`): before the existing `if (runtimeMode === 'extension')`, add `if (runtimeMode === 'extension-detached') return mainExtension(app, { detached: true });`. Also fix the stale inline comment `// Build the layout — tabbed in extension mode, split panels in standalone` since the tabbed layout no longer exists.                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/webapp/src/ui/main.ts` (`mainExtension`)  | Change signature from `mainExtension(app: HTMLElement)` to `mainExtension(app: HTMLElement, options?: { detached?: boolean })`. Inside: instantiate `new Layout(app, options?.detached ? false : true)`. Detached mode also emits the `detached-claim` envelope on boot (after `OffscreenClient` connects). Both detached and non-detached paths install the `detached-active` listener (see "Mutual exclusion enforcement" below for the listener body and the hard lock check this listener integrates with).                                                                                                                                                                                                                                                         |
| `packages/chrome-extension/src/service-worker.ts`   | (a) Replace the unconditional top-level `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at `service-worker.ts:44` with a `reconcileDetachedLockOnBoot()` call that reads `chrome.storage.session`, verifies the tab still exists, and re-applies the lock state. See "Startup reconciliation" below. (b) New state machine for detached lifecycle. New message handlers for `detached-popout-request` and `detached-claim` envelopes. New `chrome.action.onClicked` handler. New `chrome.tabs.onRemoved` listener that resolves the lock when the detached tab disappears. New `chrome.runtime.onStartup` and `chrome.runtime.onInstalled` listeners that also call `reconcileDetachedLockOnBoot()` to cover the discarded/restored-tab path.     |
| `packages/chrome-extension/src/messages.ts`         | Add three named payload interfaces (matching the existing per-message-interface convention): `DetachedPopoutRequestMsg`, `DetachedClaimMsg`, `DetachedActiveMsg`. Add `DetachedPopoutRequestMsg \| DetachedClaimMsg` to the `PanelToOffscreenMessage` union (which `PanelEnvelope.payload` resolves to). Add `DetachedActiveMsg` to `ServiceWorkerEnvelope.payload`. **Note on naming:** `PanelToOffscreenMessage` is a historical name — several existing variants (`OAuthRequestMsg`, terminal-control) are panel-to-SW rather than panel-to-offscreen. The new detached messages follow that existing pattern. The union is not renamed in this spec; doing so is a separate cleanup.                                                                                |
| `packages/chrome-extension/src/chrome.d.ts`         | **Mandatory** type surface additions (not "verify field coverage" — these are currently absent): add `url?: string` to `ChromeMessageSender`; add `windowId?: number` to `ChromeTab`; add `sidePanel.setOptions({ enabled?, path?, tabId? })` and `sidePanel.open({ tabId })` and (Chrome 141+) `sidePanel.close({ windowId })`; add `action.onClicked.addListener(callback: (tab: ChromeTab) => void)`; add `tabs.onRemoved.addListener(callback: (tabId, removeInfo) => void)` and `tabs.update(tabId, { active })`; add `windows.update(windowId, { focused })`; add `storage.session` (same `ChromeStorageArea` shape as `local`); add `runtime.onStartup.addListener` and `runtime.onInstalled.addListener` (the existing `onInstalled?` partial is insufficient). |
| `mainExtension` UI surface (header button)          | New header button "Pop out" that sends the `detached-popout-request` envelope to the SW. **Visibility:** the button is rendered only when `runtimeMode === 'extension'` (i.e., true side panel or QA-recipe plain `index.html` tab). When `runtimeMode === 'extension-detached'` it is hidden — a detached tab does not need its own pop-out button. (Alternatively, render it as "Return to side panel" in detached mode; the spec leaves this to UX preference and treats hidden as the default.)                                                                                                                                                                                                                                                                     |
| `OffscreenClient` lock check                        | When the panel receives `detached-active` and `window.close()` is attempted but does not complete (Chrome version variance — see error-handling), the panel must enter a "soft-disabled" state that prevents `OffscreenClient.createAgentHandle().sendMessage` (and any other outbound user-action send) from reaching the SW. See "Mutual exclusion enforcement" below for the concrete shape.                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/chrome-extension/src/offscreen-bridge.ts` | No code change required. The bridge's `handlePanelMessage` switch ignores unknown `payload.type` values today (no exhaustive default-throw), so `detached-popout-request` / `detached-claim` arriving on the broadcast path fall through harmlessly. The spec asserts this dependency explicitly so a future exhaustive switch refactor does not silently regress detached mode. If `handlePanelMessage` is later refactored to throw on unknown types, an explicit `if (payload.type === 'detached-popout-request' \|\| payload.type === 'detached-claim') return;` early-return must be added.                                                                                                                                                                        |
| `packages/webapp/src/ui/telemetry.ts`               | **No change in this spec.** `getModeLabel()` returns `'cli' \| 'extension' \| 'electron'` — note `'electron'`, not `'electron-overlay'`. It takes no arguments and cannot distinguish side-panel from detached at the moment of call. Adding a four-way label (`'extension-detached'`) would require a URL/state check and is out of scope here; if product wants RUM segmentation later, that work is tracked separately.                                                                                                                                                                                                                                                                                                                                              |

The detached layout reuses every existing panel (`ChatPanel`, `FileBrowserPanel`, `MemoryPanel`, `RemoteTerminalView`) without modification.

## Message protocol

All new messages follow the existing `ExtensionMessage` envelope (`{ source, payload }`) defined in `packages/chrome-extension/src/messages.ts`. Bare `{ type: 'detached-popout-request' }` shapes are NOT used — they would be filtered out by the SW's `isExtMsg()` gate at `service-worker.ts:299`.

Three new named payload interfaces:

```ts
// Panel → SW: user clicked the "Pop out" button.
export interface DetachedPopoutRequestMsg {
  type: 'detached-popout-request';
}

// Detached tab → SW (on boot): claim the lock.
export interface DetachedClaimMsg {
  type: 'detached-claim';
}

// SW → all panels (broadcast): a detached tab has claimed the lock.
export interface DetachedActiveMsg {
  type: 'detached-active';
}
```

Wire shape:

```ts
// Panel → SW
{ source: 'panel', payload: DetachedPopoutRequestMsg }
{ source: 'panel', payload: DetachedClaimMsg }

// SW → all panels (broadcast)
{ source: 'service-worker', payload: DetachedActiveMsg }
```

**Top-frame requirement.** `detached-claim` MUST be sent from the detached tab's top frame, not from a sprinkle iframe or any other nested context. The SW's `sender.url` validation uses the sender's document URL, and a nested iframe will not carry `?detached=1`. The detached tab boot path emits the claim from `mainExtension` (which runs in the top frame), so this is satisfied by default; the constraint is documented here so a future feature that moves the claim emission point preserves it.

**Listener body in `mainExtension`.** The `detached-active` listener installed by `mainExtension` must guard its close behavior on the runtime mode — specifically, it MUST NOT close itself when running as the claimer. The full body is:

```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (!isExtMsg(msg)) return;
  if (msg.source !== 'service-worker') return;
  if ((msg.payload as { type?: string }).type !== 'detached-active') return;
  if (runtimeMode === 'extension-detached') return; // I am the claimer; ignore
  enterDetachedActiveState(); // see "Mutual exclusion enforcement" below
});
```

`enterDetachedActiveState()` does two things: attempts `window.close()` and, regardless of whether the close completed, flips a module-scoped `detachedLockActive = true` flag that `OffscreenClient` consults before sending any outbound user-action message.

**Discriminator convention.** The `payload.type` values use kebab-case with no prefix, matching the codebase's convention for messages on the `chrome.runtime` envelope channel (e.g., `refresh-tray-runtime`, `navigate-lick`). Note that prefixed forms like `slicc-electron-overlay:set-tab` (`runtime-mode.ts:11`) do exist elsewhere in the codebase — those are cross-realm `window.postMessage` traffic where the envelope channel doesn't carry a `source` field and the prefix substitutes for it. The convention is "no prefix on the SW envelope channel because the envelope already carries `source`," not "no prefix anywhere."

**Naming note on `PanelEnvelope.payload`.** `PanelEnvelope.payload` resolves to a union currently called `PanelToOffscreenMessage`. That name is historical — several existing variants (`OAuthRequestMsg`, terminal-control) already use the panel envelope to reach the SW rather than the offscreen document. The new detached messages follow that existing pattern. Renaming the union is a separate cleanup and is not in this spec's scope.

## Startup reconciliation

The current SW at `service-worker.ts:44` unconditionally executes `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at top level. This runs on every SW cold start, including after MV3 eviction with a detached tab still alive. Without reconciliation, eviction silently reverts `openPanelOnActionClick` to `true` while `setOptions({ enabled: false })` persists (Chrome's `setOptions` settings are persistent), leaving the lock half-applied: `action.onClicked` no longer fires (so the toolbar-icon-while-detached flow is dead code), and clicking the icon may attempt to open a disabled side panel ("nothing happens" UX).

**Required boot sequence:**

```ts
// Replace the top-level setPanelBehavior call with:
async function reconcileDetachedLockOnBoot(): Promise<void> {
  const { 'slicc.detached.tabId': storedTabId } =
    await chrome.storage.session.get('slicc.detached.tabId');

  if (typeof storedTabId === 'number') {
    let tabAlive = false;
    try {
      await chrome.tabs.get(storedTabId);
      tabAlive = true;
    } catch {
      // Tab gone (closed/discarded by Chrome while SW was evicted)
    }

    if (tabAlive) {
      // Detached is still canonical — re-apply both lock settings
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.sidePanel.setOptions({ enabled: false });
      return;
    }

    // Tab is gone — clear stale state and fall through to default
    await chrome.storage.session.remove('slicc.detached.tabId');
  }

  // Default (no detached tab)
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: true });
}

reconcileDetachedLockOnBoot().catch((err) => {
  console.error('[slicc-sw] reconcile detached lock failed', err);
});

chrome.runtime.onStartup.addListener(() => {
  reconcileDetachedLockOnBoot().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  reconcileDetachedLockOnBoot().catch(() => {});
});
```

`onStartup` covers browser cold start. `onInstalled` covers extension install/update/refresh. Top-level invocation covers SW wake-up from event delivery. Together they ensure the SW never leaves the lock half-applied.

**Chrome restore caveat.** Chrome may restore the detached tab in a discarded state (not actually running `main.ts` until the user focuses the tab). In that case, `chrome.tabs.get(storedTabId)` resolves (the tab object exists) but no `detached-claim` will arrive until the user activates it. The reconcile path above already covers this — the discarded tab still exists, so the lock stays applied. If the user never activates the tab and instead clicks the toolbar icon, `action.onClicked` fires and `tabs.update(storedTabId, { active: true })` will materialize the discarded tab, which then boots and emits an (idempotent) claim. Worst case: a small UX delay while the tab boots, after which the system converges.

## Mutual exclusion enforcement

Three layers, in order of preference:

**Layer 1 — Side panel close.** `enterDetachedActiveState()` calls `window.close()`. On current Chrome target versions this typically works from inside a side panel, but historical behavior has varied. The implementation should also attempt `chrome.sidePanel.close({ windowId })` (Chrome 141+) from the SW immediately after the `detached-active` broadcast — for the side panel surface specifically — as a more deterministic close. Manual QA must verify which path actually closes the panel on the targeted Chrome build.

**Layer 2 — UI hard-disable.** Regardless of whether the close actually happens, `enterDetachedActiveState()` flips a module-scoped `detachedLockActive = true` and visually marks the page as "Detached in another tab — close this one" (an overlay or a banner; UX detail). The Layout's chat composer and any "send"-style affordances render as disabled.

**Layer 3 — Send-path lock check.** `OffscreenClient.createAgentHandle().sendMessage` (and the matching paths for any other user-originated SW/offscreen traffic) consult `detachedLockActive` before calling `this.send(...)` and silently drop or surface an error if the lock is held. This is the load-bearing guarantee — even if the user finds a way to interact with a stuck UI, no user-action message reaches the offscreen agent.

All three layers cooperate: layer 1 is the happy path; layer 2 is the visible UX; layer 3 is the invariant that makes the spec's "single UI client" claim actually true. Tests target layer 3 directly because it is deterministic; layers 1 and 2 are covered by manual QA.

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
  → const detachedUrl = `${chrome.runtime.getURL('index.html')}?detached=1`;
    chrome.tabs.create({ url: detachedUrl })
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
      if (!sender.url) reject;            // tests/mocks / unknown sender shape
      let u: URL;
      try { u = new URL(sender.url); }
      catch { reject; }
      const expectedOrigin = new URL(chrome.runtime.getURL('index.html')).origin;
      const isExtensionIndex =
        u.pathname === '/index.html' || u.pathname === '/';
      u.origin === expectedOrigin
        && isExtensionIndex
        && u.searchParams.get('detached') === '1'
      // Accept both /index.html and /; Chrome can serve the extension's
      // default page at the bare origin in some versions.
  → if !storage.detachedTabId or chrome.tabs.get(storage.detachedTabId) rejects:
      storage.detachedTabId = T
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      await chrome.sidePanel.setOptions({ enabled: false })
      chrome.runtime.sendMessage({
        source: 'service-worker',
        payload: { type: 'detached-active' }
      })
      // Optionally also attempt chrome.sidePanel.close({ windowId }) for
      // each open window if available (Chrome 141+) — see Mutual exclusion.
  → else if storage.detachedTabId === T:
      // Idempotent reclaim (e.g., detached tab reload). No-op.
  → else (a different detached tab is already the official one):
      chrome.tabs.remove(T)
      const existing = await chrome.tabs.get(storage.detachedTabId);
      chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId !== undefined) {
        chrome.windows.update(existing.windowId, { focused: true })
      }

Side panel + any non-detached index.html tab:
  receives { source: 'service-worker', payload: { type: 'detached-active' } }
  → if (runtimeMode !== 'extension-detached'):
      enterDetachedActiveState()   // window.close() + UI disable + send-path lock
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
  → const storedId = await readStoredDetachedTabId();
    if (storedId !== undefined):
      try:
        const tab = await chrome.tabs.get(storedId);
        // Tab exists — focus it (whether discarded or not).
        chrome.tabs.update(storedId, { active: true });
        if (tab.windowId !== undefined) {
          chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      catch:
        // Stored tabId no longer resolves — fall through to recovery.
        // (chrome.tabs.onRemoved should normally have caught this, but
        //  Chrome occasionally drops the event under crash/discard paths.)
  → // Recovery: no detached tab actually exists.
    await chrome.storage.session.remove('slicc.detached.tabId');
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({ enabled: true });
    await chrome.sidePanel.open({ tabId: clickedTab.id });
    // permitted because we're inside a user-gesture handler
```

The recovery path enters only when `chrome.tabs.get(storedId)` rejects — i.e., the detached tab is genuinely gone. There is no path where the recovery opens a side panel while a detached tab is still alive: either the tab exists (we focus it and return) or it does not (we recover). This closes the dual-client gap noted in earlier review feedback.

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

| Case                                                                                        | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached tab fails to load (network error, extension reload mid-boot)                       | Side panel never receives `detached-active`, stays open. SW has no half-locked state because the lock only sets on `detached-claim`, not on `chrome.tabs.create`. User can retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SW evicted while detached tab is open                                                       | The top-level lock setting at boot is replaced by `reconcileDetachedLockOnBoot()` (see "Startup reconciliation"). On every SW wake — top-level boot, `onStartup`, `onInstalled` — the SW reads `chrome.storage.session.detachedTabId`, verifies the tab still exists, and re-applies `setPanelBehavior` + `setOptions`. `setOptions({ enabled: ... })` persists across SW restarts per Chrome docs; `setPanelBehavior({ openPanelOnActionClick: ... })` does not. The reconciler addresses that asymmetry by always re-applying both.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Storage cleared but detached tab still alive                                                | Side panel lock becomes unset (because the reconciler treats missing storage as "no detached"). The detached tab keeps functioning. If the user opens a side panel in this window, both surfaces are connected. **Send-path lock (layer 3) keeps this safe** — the detached tab's `OffscreenClient` still has its lock flag set from the original `detached-active` it received, so user actions there continue to send normally; the newly opened side panel does not have the lock flag set, but its own concurrent send would create exactly the duplicate-message problem we are guarding against. Mitigations: (a) detached tab's listener on `chrome.tabs.onActivated` re-emits a claim, re-locking the SW promptly on focus; (b) treat this as an internal drift bug and require manual QA to verify storage isn't being cleared by anything other than browser restart or explicit `tabs.onRemoved`. Documented but not actively defended against. |
| Two detached URLs opened in rapid succession                                                | First claim wins via the `storage.detachedTabId` check; second tab's claim is rejected. The SW closes the second tab and focuses the first using BOTH `chrome.tabs.update({ active: true })` AND `chrome.windows.update({ focused: true })` so cross-window focus works correctly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| User reloads detached tab (Ctrl-R)                                                          | URL preserved → re-detects mode → re-emits claim. SW sees existing storage entry for the same `tabId` → idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Chrome tab-restore on browser startup with detached tab open                                | Tab restores with URL intact; `chrome.storage.session` was cleared on browser restart. **Two restore paths:** (a) Chrome restores tab in active state → it boots `main.ts`, emits `detached-claim`, SW locks normally. (b) Chrome restores tab in discarded state (a real possibility for background restored tabs) → tab exists but `main.ts` does not run until activated. `reconcileDetachedLockOnBoot()` (via `chrome.runtime.onStartup`) finds no `storedTabId` and starts in the unlocked default. The discarded tab boots and claims when the user activates it; from that moment forward the lock applies. Window between browser start and discarded-tab activation is unlocked. Acceptable because no user action is happening then. User story has been weakened accordingly (see "User stories"). Future improvement: scan open tabs for `?detached=1` on `onStartup` and pre-populate storage.                                                |
| User closes the window containing the detached tab                                          | `chrome.tabs.onRemoved` fires for the detached tab → normal return flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `chrome.sidePanel.open({ tabId })` in `chrome.action.onClicked` stale-storage path          | Permitted because the handler is invoked from a user gesture. Entered only when `chrome.tabs.get(storedTabId)` rejects (detached tab genuinely gone), so this path never opens a side panel while a detached tab is still alive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| User clicks the popout button while the SW has just been evicted and is still cold-starting | `chrome.runtime.sendMessage` waits for the SW to come up. The message is delivered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| User clicks the popout button twice in quick succession before the first tab boots          | Two tabs are created. Both boot and emit `detached-claim`. First claim wins; second is closed by the SW and the first is focused with both `tabs.update({ active: true })` and `windows.update({ focused: true })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Spoofing: page script tries to send a fake `detached-claim` to lock the SW                  | The SW uses `sender.tab.id` from `chrome.runtime.onMessage` — Chrome supplies it, not the message body. Cross-origin senders cannot reach the extension SW. The SW additionally parses `sender.url` and validates origin, pathname (`/index.html` or `/`), and `searchParams.get('detached') === '1'`. Top-frame requirement: claims sent from sprinkle iframes will fail validation because the iframe URL won't carry `?detached=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `window.close()` may be unreliable in the side panel context                                | Three-layer mutual exclusion (see "Mutual exclusion enforcement") makes this non-load-bearing: layer 1 (`window.close()` + optional `chrome.sidePanel.close({ windowId })` from the SW on Chrome 141+) is the happy path; layer 2 (UI disabled state) makes a stuck panel visibly inert; layer 3 (send-path lock check in `OffscreenClient`) ensures no user-action message reaches the offscreen agent even if the user interacts with a stuck UI. Manual QA verifies layer 1 on the current Chrome target build.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `chrome.sidePanel.setOptions({ enabled: false })` UX risk                                   | Disabling the side panel globally can affect Chrome's side-panel entry-point UI (the panel may not appear in the "Open in side panel" menu while disabled). For our flow this is the correct behavior. **Persistence asymmetry:** `setOptions` settings persist across SW restarts; `setPanelBehavior` does not. The reconciler always re-applies both, so the asymmetry does not produce drift. If product wants per-tab scoping, `setOptions({ tabId, enabled: false })` is per-tab; that does NOT meet the "global lock" requirement and would require iterating every open tab. Global is the chosen tradeoff.                                                                                                                                                                                                                                                                                                                                         |
| Tray runtime config sync                                                                    | `refresh-tray-runtime` exists because the offscreen document has its own `localStorage` partition that must be kept in sync with the panel's writes (see comment near `messages.ts:111–115`). Whether the panel is a side panel or a detached tab does not change this: the detached tab writes tray config to its `localStorage` (shared with the side panel due to same extension origin) AND emits `refresh-tray-runtime` to the offscreen, exactly as the side panel does today. Confirm in manual QA that the panel→SW→offscreen relay still fires from the detached-tab context.                                                                                                                                                                                                                                                                                                                                                                     |

## Security considerations

- All new message types use `sender.tab.id` from `chrome.runtime.onMessage`, never values supplied in the message body, for tab identity.
- The SW additionally parses `sender.url` as a `URL` and validates `origin`, `pathname === '/index.html'`, and `searchParams.get('detached') === '1'`. Substring matches like `url.includes('?detached=1')` MUST NOT be used — they are brittle to query reordering and additional parameters. A missing `sender.url` or a `new URL()` throw MUST reject the claim outright (defensive against test mocks and unexpected sender shapes).
- The "non-detached `index.html` tabs are side-panel-equivalent" rule above is what makes the spec's mutual-exclusion guarantee real: without it, a plain `index.html` tab would silently become a second UI client and concurrent user actions (sending messages, navigating scoops) would be duplicated by the offscreen agent.
- No new permissions required. `tabs`, `sidePanel`, `storage` are already in the manifest.

## Testing

| Layer                                      | What to test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `runtime-mode.ts`                          | `resolveUiRuntimeMode` returns `'extension-detached'` for `isExtension=true` with `?detached=1`; returns `'extension'` for `isExtension=true` with any other query (including no query and unrelated params); returns `'standalone'`/`'electron-overlay'` only when `isExtension=false`. The `electron-overlay` value is not reachable from the `isExtension=true` branch — test only the boundary cases, not "precedence" between extension and overlay. Separately, assert `shouldUseRuntimeModeTrayDefaults('extension-detached', false) === false` and `shouldUseRuntimeModeTrayDefaults('extension-detached', true) === false` (the existing two-arg signature must be respected); no code change to that function is required — the new mode falls through to the default `false`. | `packages/webapp/tests/ui/runtime-mode.test.ts` (extend existing)         |
| SW state machine                           | Claim while empty → locks. Claim while occupied (different tab) → closes new tab and focuses existing across windows. Claim while occupied (same tab — reload) → idempotent (same-tab short-circuit). `tabs.onRemoved` of locked tab → unlocks. `tabs.onRemoved` of unrelated tab → no change. `action.onClicked` while locked and tab alive → focuses tab + window. `action.onClicked` while locked but `tabs.get` rejects → recovers and opens side panel. `sender.url` validation rejects missing/malformed URLs and URLs missing the `detached=1` searchParam. Accepts pathname `/` as well as `/index.html`.                                                                                                                                                                        | `packages/chrome-extension/tests/service-worker-detached.test.ts` (new)   |
| SW startup reconciliation                  | (a) Top-level boot with empty storage → applies default (`openPanelOnActionClick: true`, `enabled: true`). (b) Top-level boot with `storedTabId` pointing at a live tab → applies lock (`openPanelOnActionClick: false`, `enabled: false`). (c) Top-level boot with `storedTabId` pointing at a non-existent tab → clears storage and applies default. (d) `onStartup` and `onInstalled` listeners trigger the same reconciler.                                                                                                                                                                                                                                                                                                                                                          | `packages/chrome-extension/tests/service-worker-detached.test.ts` (new)   |
| Send-path lock check                       | `OffscreenClient.createAgentHandle().sendMessage` consults the `detachedLockActive` flag and drops/errors when the flag is set. The flag is set by the `detached-active` listener entering the active state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/webapp/tests/ui/offscreen-client.test.ts` (extend or new)       |
| Popout button visibility + request         | Button renders when `runtimeMode === 'extension'`, does not render when `runtimeMode === 'extension-detached'`. Button click sends the `detached-popout-request` envelope; receiving `detached-active` triggers `enterDetachedActiveState()`. Non-detached `index.html` tabs also self-close on `detached-active`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Extend existing side panel UI tests; new test for the non-detached path   |
| Layout selection in `main.ts`              | When mode is `'extension-detached'`, `mainExtension` instantiates `new Layout(app, false)`; in `'extension'` mode it still instantiates `new Layout(app, true)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Lean on manual QA plus the runtime-mode unit test                         |
| `docs/testing.md` exception                | The existing "Chrome API: DebuggerClient, service workers" allow-skip clause at `docs/testing.md:322` must be amended: SW state-machine logic and lifecycle reconciliation MUST be unit-tested (mocked `chrome.*` APIs are acceptable). Document this carve-out so future contributors don't read the broad clause as permission to skip these tests.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Update `docs/testing.md` and reference from the new SW test file's header |
| Manual QA recipe                           | Existing `packages/chrome-extension/CLAUDE.md` recipe extended: open `chrome-extension://<id>/index.html?detached=1` directly and verify locking end-to-end. Also: click the popout button; close the detached tab; reload the detached tab; restart Chrome with the detached tab open (verify both active-restore and discarded-restore paths). Verify `window.close()` from the side panel under the current Chrome target build. Verify tray runtime config survives a popout. Verify a popped-out tab opened in window A → tab dragged to window B → clicking the toolbar icon in either window focuses the detached tab + its window correctly.                                                                                                                                     | Documented in `packages/chrome-extension/CLAUDE.md`                       |
| Manual QA — extension-page capability diff | Detached tab is a normal extension page, not a side panel. Verify behaviors that are known to differ: `showDirectoryPicker()` user-gesture handling (for `mount --source local` flows), `chrome.runtime.connect` Port behavior, and any mic/voice input that historically had side-panel-specific fallbacks (see `docs/pitfalls.md` for the side-panel-specific entries). Anything that works in the side panel but not in a regular tab is a regression to file.                                                                                                                                                                                                                                                                                                                        | Documented in `packages/chrome-extension/CLAUDE.md`                       |
| Coverage                                   | New SW code must keep the `chrome-extension` package above its existing coverage floor (55% lines/statements, 45% branches, 60% functions). The new test file should land enough coverage that the floor doesn't slip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Existing CI gate                                                          |

## Documentation impact

The following files need updates as part of this change (per the project's "tests, docs, verification" gate):

- `packages/chrome-extension/CLAUDE.md` — add a section on detached mode, the SW state machine + startup reconciliation, the `chrome.d.ts` additions, and an updated local QA recipe step. Document the QA recipe's plain `index.html` tab as side-panel-equivalent for purposes of mutual exclusion. Replace stale "tabbed UI" references in the Three-Layer Architecture diagram (`packages/chrome-extension/CLAUDE.md:15`) and any other places the file still mentions tabbed UI.
- `packages/webapp/CLAUDE.md` — note the third `UiRuntimeMode` value in the UI section. Replace the brief description of `Layout` to acknowledge `isExtension` drives more than density (scoops rail, scoop switcher, avatar location, default debug-tab visibility).
- `docs/architecture.md` — extend the extension three-layer architecture description to mention the detached tab as a second valid UI client surface. Correct EVERY occurrence of the stale "Split-pane (CLI) or tabbed (extension)" framing — including the "Change layout (split vs tabbed)" row near line 582 and the layer-stack description — not just the one occurrence on the file-finding guide line.
- `docs/pitfalls.md` — add an entry on the "boot is the lock event" model (the popout button is convenience, not a trust signal; direct URL access is a first-class entry path). Document the `sender.url` parsing requirement (parse as `URL`, no substring matches, must validate origin + pathname + searchParam, reject missing URL). Document the top-frame requirement for `detached-claim` emission.
- `docs/testing.md` — amend the "Chrome API: DebuggerClient, service workers" allow-skip clause (line ~322) with an explicit carve-out: SW state-machine and lifecycle-reconciliation logic MUST be unit-tested with mocked `chrome.*` APIs.
- `packages/webapp/src/ui/layout.ts` — update the file-header diagram (lines ~1–21) which still depicts the retired tabbed extension layout.
- `packages/webapp/src/ui/main.ts` — replace the stale inline comment `// Build the layout — tabbed in extension mode, split panels in standalone` near line 2385 with accurate text.
- Root `CLAUDE.md` — update any "extension mode: compact tabbed interface" wording in the navigation/architecture section to match current code (split rail layout, density-toggled by `isExtension`).
- `README.md` — user-facing description of the popout feature.

## Open questions

The following are documented design decisions rather than truly open issues, but they each have a non-obvious tradeoff that future review or implementation may want to revisit:

1. **Discarded-tab restore window.** Chrome may restore the detached tab in a discarded state; the lock applies only after the user activates it. Acceptable because no user action happens in that window, but an `onStartup` tab-scan that pre-populates storage from any open `?detached=1` tabs would close the gap. Tracked as a future improvement.
2. **Hard-disable UX copy.** Layer 2 of mutual-exclusion enforcement (UI disabled state when `detached-active` fires) needs a concrete visual: full-screen overlay vs. composer-only disable vs. banner. Spec assumes overlay; product can revisit during implementation.
3. **`getModeLabel()` extension.** Whether to add `'extension-detached'` as a fourth telemetry label depends on whether product wants RUM segmentation between side panel and detached. Out of scope here; would need a URL/state check inside `getModeLabel()` since it currently takes no arguments.
4. **`PanelToOffscreenMessage` rename.** The union name is historically misleading (several existing entries are panel-to-SW). Not renamed in this spec; should be revisited as a separate cleanup once detached lands.

## Out of scope (future work)

- A configurable "always start detached" user preference. The current design intentionally lets Chrome's session-restore drive this implicitly — if the detached tab is open when the user closes Chrome, it comes back detached.
- Multi-window support (side panel in window A, separate detached in window B). The "global lock" decision rules this out; revisiting would require reintroducing the multi-client handling that the current design eliminates.
- A `chrome.commands` keyboard shortcut. Easy to add later without disturbing the design — the trigger is just one extra entry point that calls the same `detached-popout-request` envelope.
