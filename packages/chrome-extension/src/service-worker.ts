/**
 * Extension service worker — message relay + CDP proxy + offscreen lifecycle.
 *
 * Responsibilities:
 * 1. Open the side panel on action icon click
 * 2. Create/maintain the offscreen document (agent engine)
 * 3. Relay messages between side panel ↔ offscreen document
 * 4. Proxy chrome.debugger CDP calls for the offscreen document
 * 5. Host the leader tray WebSocket for the offscreen document
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  type DaSignAndForwardEnvelope,
  executeDaSignAndForward,
  executeS3SignAndForward,
  type FetchProxySecretSource,
  previewSecret,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
  SecretsPipeline,
  SessionSecretStore,
  type SignAndForwardReply,
  unmaskCdpFrame,
} from '@slicc/shared-ts';
import {
  extractHandoffFromWebRequest,
  handoffFingerprint,
} from '../../webapp/src/net/handoff-link.js';
import { buildDefaultBridgeSwDeps, handleBridgePortConnect } from './bridge-sw.js';
import { handleFetchProxyConnectionAsync } from './fetch-proxy-shared.js';
import type {
  CdpCommandMsg,
  CdpEventMsg,
  CdpResponseMsg,
  ExtensionMessage,
  NavigateLickMsg,
  OAuthRequestMsg,
  OAuthResultMsg,
  TraySocketCommandMessage,
  TraySocketErrorMsg,
  TraySocketMessageMsg,
  TraySocketOpenedMsg,
  TraySocketOpenMsg,
} from './messages.js';
import {
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
  isExtensionMessage,
} from './messages.js';
import { buildWebAuthFlowOptions } from './oauth-flow-options.js';
import { deleteSecret, listSecrets, listSecretsWithValues, setSecret } from './secrets-storage.js';
import { readOrCreateSwSessionId } from './sw-session-id.js';

// ---------------------------------------------------------------------------
// Detached popout state
// ---------------------------------------------------------------------------

const DETACHED_TAB_ID_KEY = 'slicc.detached.tabId';

async function readStoredDetachedTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(DETACHED_TAB_ID_KEY);
    const raw = result[DETACHED_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get failed', err);
    return undefined;
  }
}

async function writeStoredDetachedTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [DETACHED_TAB_ID_KEY]: tabId });
}

async function clearStoredDetachedTabId(): Promise<void> {
  await chrome.storage.session.remove(DETACHED_TAB_ID_KEY);
}

async function reconcileDetachedLockOnBoot(): Promise<void> {
  const storedTabId = await readStoredDetachedTabId();

  if (storedTabId !== undefined) {
    let tabAlive = false;
    try {
      await chrome.tabs.get(storedTabId);
      tabAlive = true;
    } catch {
      // Tab gone (closed/discarded while SW was evicted)
    }

    if (tabAlive) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.sidePanel.setOptions({ enabled: false });
      return;
    }

    await clearStoredDetachedTabId();
  }

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

function isValidClaimUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(chrome.runtime.getURL('index.html')).origin;
  } catch {
    return false;
  }
  // Accept both '/index.html' (explicit) and '/' (root → index.html
  // served by the manifest's default). Both produce the same boot
  // path; reject anything else so e.g. /secrets.html?detached=1
  // cannot claim the lock.
  const isExtensionIndex = u.pathname === '/index.html' || u.pathname === '/';
  return (
    u.origin === expectedOrigin &&
    isExtensionIndex &&
    u.searchParams.get(DETACHED_RUNTIME_QUERY_NAME) === DETACHED_RUNTIME_QUERY_VALUE
  );
}

async function handleDetachedClaim(sender: ChromeMessageSender): Promise<void> {
  const claimingTabId = sender.tab?.id;
  if (claimingTabId === undefined) return;
  if (!isValidClaimUrl(sender.url)) return;

  let step = 'read-stored-tab-id';
  try {
    const storedTabId = await readStoredDetachedTabId();

    if (storedTabId === claimingTabId) {
      // Idempotent reclaim (detached tab reload). No state change.
      return;
    }

    if (storedTabId !== undefined) {
      step = 'check-existing-tab';
      let existing: ChromeTab | undefined;
      try {
        existing = await chrome.tabs.get(storedTabId);
      } catch {
        existing = undefined;
      }
      if (existing !== undefined && existing.id !== undefined) {
        // A different detached tab already holds the lock. Close the new one.
        step = 'remove-claiming-tab';
        await chrome.tabs.remove(claimingTabId);
        step = 'focus-existing-tab';
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) {
          step = 'focus-existing-window';
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return;
      }
      // Stored tab is gone; fall through to lock with the new claimer.
    }

    step = 'write-detached-tab-id';
    await writeStoredDetachedTabId(claimingTabId);
    step = 'set-panel-behavior-locked';
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    step = 'set-options-disabled';
    await chrome.sidePanel.setOptions({ enabled: false });
    step = 'broadcast-detached-active';
    // Fire-and-forget; .catch() suppresses the unhandled-rejection warning
    // that Chrome emits when there are no listeners (e.g., no panel open).
    // Matches the codebase's existing fire-and-forget pattern for
    // chrome.runtime.sendMessage.
    chrome.runtime
      .sendMessage({
        source: 'service-worker',
        payload: { type: 'detached-active' },
      })
      .catch(() => {});

    // Best-effort hard close of any open side panel (Chrome 141+).
    step = 'get-windows';
    const windows = await chrome.windows.getAll();
    step = 'close-side-panels';
    await Promise.all(
      windows.map(async (win) => {
        try {
          await chrome.sidePanel.close({ windowId: win.id });
        } catch {
          // No side panel open in that window — normal case, swallow.
        }
      })
    );
  } catch (err) {
    console.error(`[slicc-sw] handleDetachedClaim failed at step=${step}`, err);
    throw err;
  }
}

async function handleDetachedPopoutRequest(): Promise<void> {
  const detachedUrl = `${chrome.runtime.getURL('index.html')}?${DETACHED_RUNTIME_QUERY_NAME}=${DETACHED_RUNTIME_QUERY_VALUE}`;
  await chrome.tabs.create({ url: detachedUrl, active: true });
  // The lock change is driven by the new tab's detached-claim message,
  // not by tab creation. See spec.
}

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  // Return false explicitly to tell Chrome we will not call sendResponse
  // asynchronously. Returning true keeps sendResponse alive and conflicts
  // with the other SW onMessage listeners that may want to respond.
  if (!isExtensionMessage(message)) return false;
  if (message.source !== 'panel') return false;
  const payloadType = (message.payload as { type?: string }).type;

  if (payloadType === 'detached-claim') {
    handleDetachedClaim(sender).catch((err) => {
      // Step-context already logged by handleDetachedClaim's internal catch.
      // This catch is the final safety net so the rejection doesn't go unhandled.
      console.error('[slicc-sw] handleDetachedClaim unhandled', err);
    });
    return false;
  }

  if (payloadType === 'detached-popout-request') {
    handleDetachedPopoutRequest().catch((err) => {
      console.error('[slicc-sw] handleDetachedPopoutRequest failed', err);
    });
    return false;
  }
  return false;
});

async function handleActionClick(clickedTab: ChromeTab): Promise<void> {
  const storedId = await readStoredDetachedTabId();

  if (storedId !== undefined) {
    let alive: ChromeTab | undefined;
    try {
      alive = await chrome.tabs.get(storedId);
    } catch {
      alive = undefined;
    }
    if (alive !== undefined) {
      await chrome.tabs.update(storedId, { active: true });
      if (alive.windowId !== undefined) {
        await chrome.windows.update(alive.windowId, { focused: true });
      }
      return;
    }
  }

  // Recovery: no detached tab actually exists.
  // Fire-and-forget the cleanup (don't await) so the user-gesture
  // context from chrome.action.onClicked is still active when
  // sidePanel.open() is called below. Awaiting any Promise inside
  // a gesture-triggered listener can consume the activation and
  // cause sidePanel.open to reject.
  chrome.storage.session.remove(DETACHED_TAB_ID_KEY).catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.sidePanel.setOptions({ enabled: true }).catch(() => {});

  // Wave 3b: if a pinned leader tab is alive, focus it instead of opening
  // the side panel. The leader tab is the thin-extension primary UI; the
  // side-panel fallback remains for users still on the fat-extension path
  // (Wave 6 cleanup will remove it).
  const leaderId = await readStoredLeaderTabId();
  if (leaderId !== undefined) {
    let leaderTab: ChromeTab | undefined;
    try {
      leaderTab = await chrome.tabs.get(leaderId);
    } catch {
      leaderTab = undefined;
    }
    if (leaderTab !== undefined && isLeaderTabUrl(leaderTab.url)) {
      await chrome.tabs.update(leaderId, { active: true });
      if (leaderTab.windowId !== undefined) {
        await chrome.windows.update(leaderTab.windowId, { focused: true });
      }
      return;
    }
    // Stored leader tab is gone or has navigated away — clear stale state
    // and fall through to the side-panel fallback below.
    await clearStoredLeaderTabId();
  }

  if (clickedTab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: clickedTab.id });
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.action.setBadgeText({ text: '' });
  handleActionClick(tab).catch((err) => {
    console.error('[slicc-sw] handleActionClick failed', err);
  });
});

async function handleTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredDetachedTabId();
  if (storedId !== tabId) return;
  await clearStoredDetachedTabId();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: true });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch((err) => {
    console.error('[slicc-sw] handleTabRemoved failed', err);
  });
});

// ---------------------------------------------------------------------------
// Leader tab state (Wave 3b — thin extension)
// ---------------------------------------------------------------------------
//
// The thin extension opens https://www.sliccy.ai/?slicc=leader in a pinned
// "home" tab that acts as the tray leader. Per-page injected iframes (the
// `<slicc-launcher>` content script) connect as followers in auto-follow
// mode, so closing a host page never stops the agent.
//
// Lifecycle mirrors the detached-popout pattern above: `chrome.storage.session`
// persists the tab id; reconciliation runs at SW startup + `onStartup` +
// `onInstalled`; `ensureLeaderTab` creates the pinned tab if missing;
// `tabs.onRemoved` clears the storage when the user closes the leader tab.
//
// The bridge transport (sibling task) reads `LEADER_TAB_ID_KEY` from
// `chrome.storage.session` for its three-factor pinning — keep the key
// name and shape stable.

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';
const LEADER_TAB_URL = 'https://www.sliccy.ai/?slicc=leader';
const LEADER_TAB_URL_GLOB = 'https://www.sliccy.ai/*';

async function readStoredLeaderTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get leader tab id failed', err);
    return undefined;
  }
}

async function writeStoredLeaderTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
}

async function clearStoredLeaderTabId(): Promise<void> {
  await chrome.storage.session.remove(LEADER_TAB_ID_KEY);
}

function isLeaderTabUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // Pin to the exact leader origin — `www.sliccy.ai`. The Cloudflare worker
  // 301-redirects bare-host requests to `www`, so any leader URL the user
  // restored from a previous session has settled at the www subdomain.
  if (u.origin !== 'https://www.sliccy.ai') return false;
  return u.searchParams.get('slicc') === 'leader';
}

async function reconcileLeaderTabOnBoot(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId === undefined) return;
  let tab: ChromeTab | undefined;
  try {
    tab = await chrome.tabs.get(storedId);
  } catch {
    // Tab gone (closed while SW was evicted or storage.session restored stale)
  }
  if (tab !== undefined && isLeaderTabUrl(tab.url)) return;
  await clearStoredLeaderTabId();
}

// Serialize concurrent ensureLeaderTab() calls so multiple lifecycle
// triggers (top-level + onStartup + onInstalled) firing in quick
// succession can't race past the storage check and create duplicate
// pinned tabs. Same pattern as `offscreenLock` below.
let leaderTabLock: Promise<void> | null = null;

async function ensureLeaderTab(): Promise<void> {
  if (leaderTabLock) return leaderTabLock;
  leaderTabLock = (async () => {
    try {
      const storedId = await readStoredLeaderTabId();
      if (storedId !== undefined) {
        try {
          const tab = await chrome.tabs.get(storedId);
          if (isLeaderTabUrl(tab.url)) return;
        } catch {
          // fall through to recovery
        }
        await clearStoredLeaderTabId();
      }

      // Adopt a restored leader tab if Chrome's "Continue where you left off"
      // brought one back from the previous session. storage.session is wiped
      // on restart but the tab itself may still be open; claim it instead of
      // spawning a duplicate.
      try {
        const matches = await chrome.tabs.query({ url: LEADER_TAB_URL_GLOB });
        const restored = matches.find((t) => isLeaderTabUrl(t.url) && t.id !== undefined);
        if (restored && restored.id !== undefined) {
          await writeStoredLeaderTabId(restored.id);
          return;
        }
      } catch (err) {
        console.error('[slicc-sw] tabs.query for leader tab failed', err);
      }

      const created = await chrome.tabs.create({
        url: LEADER_TAB_URL,
        active: false,
        pinned: true,
      });
      if (created.id !== undefined) {
        await writeStoredLeaderTabId(created.id);
      }
    } finally {
      leaderTabLock = null;
    }
  })();
  return leaderTabLock;
}

// Top-level: reconcile only (defensive cleanup on SW eviction recovery).
// `ensureLeaderTab` is intentionally NOT called here — that path runs from
// the lifecycle listeners below, so MV3 SW recycles within a session don't
// keep recreating the leader tab.
reconcileLeaderTabOnBoot().catch((err) => {
  console.error('[slicc-sw] reconcile leader tab failed', err);
});

chrome.runtime.onStartup.addListener(() => {
  reconcileLeaderTabOnBoot()
    .then(() => ensureLeaderTab())
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  reconcileLeaderTabOnBoot()
    .then(() => ensureLeaderTab())
    .catch(() => {});
});

async function handleLeaderTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== tabId) return;
  await clearStoredLeaderTabId();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleLeaderTabRemoved(tabId).catch((err) => {
    console.error('[slicc-sw] handleLeaderTabRemoved failed', err);
  });
});

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html';

// Serialize concurrent ensureOffscreen calls to prevent race conditions
// where multiple callers pass hasDocument() before any creates the document.
let offscreenLock: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenLock) return offscreenLock;
  offscreenLock = (async () => {
    try {
      if (!chrome.offscreen) {
        console.error(
          '[slicc-sw] chrome.offscreen API not available — missing "offscreen" permission?'
        );
        return;
      }
      const exists = await chrome.offscreen.hasDocument();
      if (exists) {
        console.log('[slicc-sw] Offscreen document already exists');
        return;
      }
      console.log('[slicc-sw] Creating offscreen document...');
      // `USER_MEDIA` / `DISPLAY_MEDIA` are offscreen-API *reasons* (not
      // manifest permissions): they let the offscreen document touch
      // `navigator.mediaDevices` (e.g. `enumerateDevices`). The actual
      // camera/mic/screen capture still happens in a visible popup window
      // because the offscreen document has no surface to show Chrome's
      // permission prompt / screen picker — see `capture-popup.html` and
      // `packages/webapp/src/shell/supplemental-commands/extension-media-capture.ts`.
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS', 'USER_MEDIA', 'DISPLAY_MEDIA'],
        justification:
          'Runs the SLICC agent engine so work survives side panel close, and enumerates camera/mic/screen devices for media-capture commands.',
      });
      console.log('[slicc-sw] Offscreen document created');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Only a single offscreen document may be created" is benign — another
      // call won the race. Only log unexpected errors.
      if (!msg.includes('single offscreen')) {
        console.error('[slicc-sw] Failed to create offscreen document:', err);
      }
    } finally {
      offscreenLock = null;
    }
  })();
  return offscreenLock;
}

// Create offscreen doc on install/startup
chrome.runtime.onInstalled?.addListener?.(() => {
  ensureOffscreen();
});
ensureOffscreen();

// ---------------------------------------------------------------------------
// Media-capture popup window
// ---------------------------------------------------------------------------
// Media capture (`getUserMedia` / `getDisplayMedia`) needs a *visible* surface
// so Chrome can show its permission prompt / screen picker. The shell command
// requesting the capture runs in the offscreen document (or the side-panel
// shell); the offscreen document can't call `chrome.windows.create`, so it
// asks the service worker to open the capture popup here. The popup performs
// the capture and broadcasts the bytes back over `chrome.runtime` messaging,
// which the requesting context picks up directly (no SW relay needed for the
// result). See `capture-popup.html` / `capture-popup.js`.
function isCaptureOpenWindowMsg(
  msg: unknown
): msg is { type: 'capture-open-window'; url: string; requestId?: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'capture-open-window' &&
    typeof (msg as { url?: unknown }).url === 'string'
  );
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isCaptureOpenWindowMsg(message)) return false;
  const requestId = message.requestId;
  chrome.windows
    .create({ url: message.url, type: 'popup', width: 360, height: 220, focused: true })
    .catch((err) => {
      console.error('[slicc-sw] Failed to open capture popup window:', err);
      // Surface the failure to the requesting context so captureViaPopup
      // rejects promptly instead of waiting out its ~5-minute timeout. The
      // success path never reaches this branch, so there is no double-send.
      if (requestId) {
        chrome.runtime
          .sendMessage({
            source: 'capture-popup',
            requestId,
            ok: false,
            error: `failed to open capture window: ${err?.message || String(err)}`,
          })
          .catch(() => {
            // Requesting context may not be listening — best effort.
          });
      }
    });
  return false;
});

// ---------------------------------------------------------------------------
// Tab grouping — inline copy for service worker (SW can't import shared chunks)
// See packages/chrome-extension/src/tab-group.ts for the canonical implementation used by
// debugger-client.ts in the offscreen document.
// ---------------------------------------------------------------------------

let sliccGroupId: number | null = null;

async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch (err) {
        console.info('[slicc-tab-group] Tab group removed by user, recreating', {
          tabId,
          previousGroupId: sliccGroupId,
          error: err instanceof Error ? err.message : String(err),
        });
        sliccGroupId = null;
      }
    }
    sliccGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(sliccGroupId, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  } catch (err) {
    console.warn('[slicc-tab-group] Tab grouping failed (best-effort, continuing without group)', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Handoff notifications — alert the user when a main-frame document response
// advertises a SLICC handoff via RFC 8288 `Link` header, and open the side
// panel on notification click (user gesture required).
// ---------------------------------------------------------------------------

/** Maps notification ID → windowId so the click handler can open the right panel. */
const handoffNotificationWindows = new Map<string, number>();

async function showHandoffNotification(windowId: number): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
  if (contexts.length > 0) return;

  const notificationId = `slicc-handoff-${Date.now()}`;
  handoffNotificationWindows.set(notificationId, windowId);
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5f72' });
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'logos/sliccy-color-1scoops-128x128.png',
    title: 'Slicc handoff received',
    message: 'Click to open the Slicc side panel and process the handoff.',
  });
}

chrome.notifications.onClicked.addListener((notificationId: string) => {
  const windowId = handoffNotificationWindows.get(notificationId);
  handoffNotificationWindows.delete(notificationId);
  chrome.action.setBadgeText({ text: '' });
  if (windowId !== undefined) {
    chrome.sidePanel.open({ windowId }).catch(() => {});
  }
  readStoredDetachedTabId()
    .then(async (detachedTabId) => {
      if (detachedTabId !== undefined) {
        const tab = await chrome.tabs.get(detachedTabId);
        await chrome.tabs.update(detachedTabId, { active: true });
        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
    })
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// Handoff `Link` header observer — emits a navigate lick when a main-frame
// document response advertises a SLICC handoff rel via RFC 8288 Link.
// ---------------------------------------------------------------------------

/**
 * Payload fingerprints of handoffs whose OS notification has already been shown
 * this service-worker lifetime. A site can advertise the same SLICC `Link` rel
 * on every page response; without this guard each navigation re-shows the
 * toast.
 *
 * IMPORTANT: this set gates ONLY the notification — never the forward. The
 * durable cone-turn dedup lives in the long-lived offscreen `LickManager`,
 * which records a fingerprint only at the instant it actually fires (in-process,
 * no async delivery gap). The forward here (`chrome.runtime.sendMessage`) is
 * best-effort and silently drops when the offscreen document isn't listening
 * yet (e.g. cold start). If we suppressed the forward on "seen", a first
 * delivery that was dropped before the offscreen came up would lose the handoff
 * permanently. So we always forward and let the offscreen guard dedup the cone
 * turn. MV3 may evict and respawn the worker, resetting this set — an accepted
 * limitation of the in-memory design (a repeat toast can appear once after
 * eviction). See {@link handoffFingerprint}.
 */
const notifiedHandoffFingerprints = new Set<string>();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { match } = extractHandoffFromWebRequest(details.responseHeaders, details.url);
    if (!match) return;
    const fingerprint = handoffFingerprint(match);
    const alreadyNotified = notifiedHandoffFingerprints.has(fingerprint);
    notifiedHandoffFingerprints.add(fingerprint);
    const payload: NavigateLickMsg = {
      type: 'navigate-lick',
      url: details.url,
      verb: match.verb,
      target: match.target,
      tabId: details.tabId >= 0 ? details.tabId : undefined,
    };
    if (match.instruction) payload.instruction = match.instruction;
    if (match.branch) payload.branch = match.branch;
    if (match.path) payload.path = match.path;
    const tabId = details.tabId;
    const dispatch = (title?: string) => {
      if (title) payload.title = title;
      chrome.runtime.sendMessage({ source: 'service-worker' as const, payload }).catch(() => {
        // Offscreen may not be listening yet — best effort.
      });
    };
    if (tabId >= 0) {
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (!alreadyNotified && tab.windowId !== undefined) showHandoffNotification(tab.windowId);
          dispatch(tab.title);
        })
        .catch(() => dispatch());
    } else {
      if (!alreadyNotified) {
        chrome.windows
          .getCurrent()
          .then((w) => showHandoffNotification(w.id!))
          .catch(() => {});
      }
      dispatch();
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// ---------------------------------------------------------------------------
// CDP state for proxying chrome.debugger calls
// ---------------------------------------------------------------------------

/** Maps synthetic sessionId → Chrome tab ID. */
const sessionToTab = new Map<string, number>();
/** Tracks which tab IDs we've attached the debugger to. */
const attachedTabs = new Set<number>();
/** Tracks leader tray WebSockets opened on behalf of the offscreen document. */
const traySockets = new Map<number, WebSocket>();

// ---------------------------------------------------------------------------
// Message relay
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: ChromeMessageSender, _sendResponse: (response?: unknown) => void) => {
    if (!isExtMsg(message)) return false;

    const msg = message as ExtensionMessage;

    if (msg.source === 'panel') {
      chrome.action.setBadgeText({ text: '' });
      const panelPayload = msg.payload;

      // Handle OAuth requests — service worker has chrome.identity access
      if (panelPayload.type === 'oauth-request') {
        const oauthMsg = panelPayload as OAuthRequestMsg;
        handleOAuthRequest(oauthMsg)
          .then((result) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: result,
              })
              .catch((e) => {
                console.error('[slicc-sw] Failed to send OAuth result:', e);
              });
          })
          .catch((err) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: {
                  type: 'oauth-result',
                  providerId: oauthMsg.providerId,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies OAuthResultMsg,
              })
              .catch((e) => {
                console.error('[slicc-sw] Failed to send OAuth error:', e);
              });
          });
        return false;
      }

      // Other panel messages reach the offscreen doc directly via
      // chrome.runtime.sendMessage broadcast — no relay needed.
      return false;
    }

    if (msg.source === 'offscreen') {
      const payload = msg.payload;

      // CDP commands from offscreen need to be handled here (service worker has chrome.debugger)
      if (payload.type === 'cdp-command') {
        // Handle CDP command and send response back as a broadcast message.
        // The offscreen CDP proxy listens for cdp-response via onMessage, not sendMessage return.
        handleCdpCommand(payload as CdpCommandMsg)
          .then((response) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: response,
              })
              .catch(() => {});
          })
          .catch((err) => {
            chrome.runtime
              .sendMessage({
                source: 'service-worker' as const,
                payload: {
                  type: 'cdp-response',
                  id: (payload as CdpCommandMsg).id,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies CdpResponseMsg,
              })
              .catch(() => {});
          });
        return false;
      }

      if (isTraySocketCommand(payload)) {
        void handleTraySocketCommand(payload).catch((err) => {
          void sendServiceWorkerMessage({
            type: 'tray-socket-error',
            id: payload.id,
            error: err instanceof Error ? err.message : String(err),
          } satisfies TraySocketErrorMsg);
        });
        return false;
      }

      // Other offscreen messages reach the side panel directly via
      // chrome.runtime.sendMessage broadcast — no relay needed.
      return false;
    }

    return false;
  }
);

function isExtMsg(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

// ---------------------------------------------------------------------------
// Mount sign-and-forward — keep credentials out of the offscreen agent.
//
// Browser-side mount backends (running in the offscreen document for the
// agent's bash tool, or the side panel for terminal-typed `mount` commands)
// post envelopes here. The service worker owns the credential channel:
//
//   - S3: reads `s3.<profile>.*` from chrome.storage.local
//   - DA: takes a transient IMS bearer in the envelope (Adobe LLM provider's
//         token, browser-side; v2 will move OAuth here)
//
// The agent's tools never reach chrome.storage (their `bash` runs in a WASM
// context with no chrome APIs; `node -e` runs in a CSP-locked sandbox iframe
// with opaque origin) so secrets stay out of the agent's reach.
//
// Promise-return + sendResponse pattern keeps client code awaitable. Returns
// `false` for unrelated messages so the existing relay listener still runs.
// ---------------------------------------------------------------------------

interface MountSignAndForwardRequest {
  type: 'mount.s3-sign-and-forward' | 'mount.da-sign-and-forward';
  envelope: unknown;
}

function isMountSignAndForwardRequest(msg: unknown): msg is MountSignAndForwardRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    'envelope' in msg &&
    ((msg as { type: string }).type === 'mount.s3-sign-and-forward' ||
      (msg as { type: string }).type === 'mount.da-sign-and-forward')
  );
}

const chromeStorageSecretGetter: SecretGetter = {
  async get(key: string): Promise<string | undefined> {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === 'string' ? value : undefined;
  },
};

async function handleMountSignAndForward(
  msg: MountSignAndForwardRequest
): Promise<SignAndForwardReply> {
  if (msg.type === 'mount.s3-sign-and-forward') {
    return executeS3SignAndForward(
      msg.envelope as Partial<S3SignAndForwardEnvelope> | undefined,
      chromeStorageSecretGetter
    );
  }
  return executeDaSignAndForward(msg.envelope as Partial<DaSignAndForwardEnvelope> | undefined);
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    if (!isMountSignAndForwardRequest(message)) return false;
    // Wrap the handler call in a sync try/catch in addition to the promise
    // .catch. If the handler throws synchronously *before* returning a
    // promise (e.g. a cast on a malformed envelope that passed the type
    // guard but fails at first access), the .then().catch() chain never
    // runs and sendResponse is never called → caller hangs forever on
    // chrome.runtime.sendMessage. Belt-and-suspenders.
    const respondError = (err: unknown): void => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'internal' as const,
      });
    };
    try {
      handleMountSignAndForward(message)
        .then((reply) => sendResponse(reply))
        .catch(respondError);
    } catch (err) {
      respondError(err);
    }
    // Keep the channel open so sendResponse can be called asynchronously.
    return true;
  }
);

function isTraySocketCommand(
  payload: ExtensionMessage['payload']
): payload is TraySocketCommandMessage {
  return (
    payload.type === 'tray-socket-open' ||
    payload.type === 'tray-socket-send' ||
    payload.type === 'tray-socket-close'
  );
}

// Note: No relay functions needed. chrome.runtime.sendMessage broadcasts to
// all extension contexts (except the sender). Panel ↔ offscreen messages
// reach each other directly. The service worker only handles CDP + tray socket proxy commands.

async function handleTraySocketCommand(command: TraySocketCommandMessage): Promise<void> {
  switch (command.type) {
    case 'tray-socket-open':
      openTraySocket(command);
      return;
    case 'tray-socket-send': {
      const socket = traySockets.get(command.id);
      if (!socket) {
        throw new Error(`Tray socket ${command.id} is not open`);
      }
      socket.send(command.data);
      return;
    }
    case 'tray-socket-close': {
      const socket = traySockets.get(command.id);
      traySockets.delete(command.id);
      socket?.close(command.code, command.reason);
      return;
    }
  }
}

function openTraySocket(command: TraySocketOpenMsg): void {
  traySockets.get(command.id)?.close(1000, 'replaced');
  const socket = new WebSocket(command.url);
  traySockets.set(command.id, socket);

  socket.addEventListener('open', () => {
    void sendServiceWorkerMessage({
      type: 'tray-socket-opened',
      id: command.id,
    } satisfies TraySocketOpenedMsg);
  });
  socket.addEventListener('message', (event) => {
    void sendServiceWorkerMessage({
      type: 'tray-socket-message',
      id: command.id,
      data: typeof event.data === 'string' ? event.data : String(event.data),
    } satisfies TraySocketMessageMsg);
  });
  socket.addEventListener('error', () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({
      type: 'tray-socket-error',
      id: command.id,
      error: 'Tray leader WebSocket failed in extension service worker',
    } satisfies TraySocketErrorMsg);
  });
  socket.addEventListener('close', () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({ type: 'tray-socket-closed', id: command.id });
  });
}

async function sendServiceWorkerMessage(payload: ExtensionMessage['payload']): Promise<void> {
  await chrome.runtime.sendMessage({
    source: 'service-worker' as const,
    payload,
  });
}

// ---------------------------------------------------------------------------
// CDP proxy — translate offscreen CDP commands to chrome.debugger calls
// ---------------------------------------------------------------------------

async function handleCdpCommand(cmd: CdpCommandMsg): Promise<CdpResponseMsg> {
  const { id, method, params, sessionId } = cmd;

  try {
    let result: Record<string, unknown>;

    switch (method) {
      case 'Target.getTargets':
        result = await cdpGetTargets();
        break;
      case 'Target.attachToTarget':
        result = await cdpAttachToTarget(params!);
        break;
      case 'Target.detachFromTarget':
        result = await cdpDetachFromTarget(params!);
        break;
      case 'Target.createTarget':
        result = await cdpCreateTarget(params!);
        break;
      case 'Target.closeTarget':
        result = await cdpCloseTarget(params!);
        break;
      default:
        result = await cdpSendCommand(method, params, sessionId);
        break;
    }

    return { type: 'cdp-response', id, result };
  } catch (err) {
    return {
      type: 'cdp-response',
      id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cdpGetTargets(): Promise<Record<string, unknown>> {
  const [tabs, activeTabs] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const activeTabIds = new Set(activeTabs.map((t) => t.id));
  // Skip tabs without a numeric id (devtools, anonymous pages). They
  // can't be CDP-attached targets — without this filter, String(undefined)
  // would surface "undefined" as a targetId and tab.id! would crash.
  const targetInfos = tabs
    .filter((tab): tab is typeof tab & { id: number } => typeof tab.id === 'number')
    .map((tab) => ({
      targetId: String(tab.id),
      type: 'page',
      title: tab.title ?? '',
      url: tab.url ?? '',
      attached: attachedTabs.has(tab.id),
      active: activeTabIds.has(tab.id),
    }));
  return { targetInfos };
}

async function cdpAttachToTarget(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }

  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  }

  const sessionId = targetId;
  sessionToTab.set(sessionId, tabId);
  return { sessionId };
}

async function cdpDetachFromTarget(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const sessionId = params['sessionId'] as string;
  const tabId = sessionToTab.get(sessionId);

  if (tabId !== undefined) {
    sessionToTab.delete(sessionId);
    const stillReferenced = [...sessionToTab.values()].includes(tabId);
    if (!stillReferenced) {
      attachedTabs.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {
        // Tab may already be closed
      });
    }
  }

  return {};
}

async function cdpCreateTarget(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = (params['url'] as string) ?? 'about:blank';
  const tab = await chrome.tabs.create({ url, active: false });
  await addToSliccGroup(tab.id);
  return { targetId: String(tab.id) };
}

async function cdpCloseTarget(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }

  // Clean up session/attach state for this tab
  for (const [sid, tid] of sessionToTab) {
    if (tid === tabId) sessionToTab.delete(sid);
  }
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {
      // Tab may already be closed
    });
  }

  await chrome.tabs.remove(tabId);
  return { success: true };
}

/**
 * CDP methods that carry whole-token secret fields on outgoing frames
 * (Wave A D1). Anything else is forwarded verbatim to chrome.debugger.
 * Kept in sync with `unmaskCdpFrame` in `@slicc/shared-ts`.
 */
const CDP_UNMASK_METHODS = new Set<string>([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Input.insertText',
]);

/**
 * Resolve the target tab's CURRENT URL hostname and unmask whole-token
 * secret fields against it. Fail-closed: any failure to resolve the URL
 * (tab gone, missing url, unparseable) leaves the frame untouched.
 */
async function maybeUnmaskCdpFrame(
  tabId: number,
  method: string,
  params: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!CDP_UNMASK_METHODS.has(method)) return params;
  if (!params || typeof params !== 'object') return params;

  let hostname: string | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    if (typeof url === 'string' && url.length > 0) {
      try {
        hostname = new URL(url).hostname || null;
      } catch {
        hostname = null;
      }
    }
  } catch {
    hostname = null;
  }
  if (!hostname) return params;

  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  if (!pipeline.hasSecrets()) return params;

  const { frame, changed } = unmaskCdpFrame({ method, params }, hostname, pipeline);
  if (!changed) return params;
  const nextParams = (frame as { params?: Record<string, unknown> }).params;
  return nextParams ?? params;
}

async function cdpSendCommand(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): Promise<Record<string, unknown>> {
  const tabId = sessionId ? sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }

  const effectiveParams = await maybeUnmaskCdpFrame(tabId, method, params);
  const result = await chrome.debugger.sendCommand({ tabId }, method, effectiveParams);
  return result ?? {};
}

// ---------------------------------------------------------------------------
// Forward chrome.debugger events to offscreen as cdp-event messages
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener(
  (source: { tabId: number }, method: string, params?: Record<string, unknown>) => {
    if (!attachedTabs.has(source.tabId)) return;

    // Find sessionId for this tabId
    let sessionId: string | undefined;
    for (const [sid, tabId] of sessionToTab) {
      if (tabId === source.tabId) {
        sessionId = sid;
        break;
      }
    }

    const cdpEvent: CdpEventMsg = {
      type: 'cdp-event',
      method,
      params: sessionId ? { ...params, sessionId } : (params ?? {}),
    };

    // Send to offscreen document
    chrome.runtime
      .sendMessage({
        source: 'service-worker' as const,
        payload: cdpEvent,
      })
      .catch(() => {
        // Offscreen may not be listening
      });
  }
);

// ---------------------------------------------------------------------------
// OAuth handler — generic chrome.identity.launchWebAuthFlow for any OAuth provider
// ---------------------------------------------------------------------------

async function handleOAuthRequest(msg: OAuthRequestMsg): Promise<OAuthResultMsg> {
  const redirectUrl = await chrome.identity.launchWebAuthFlow(
    buildWebAuthFlowOptions(msg.authorizeUrl, msg.interactive ?? true)
  );

  if (!redirectUrl) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: 'OAuth flow was cancelled or returned no URL',
    };
  }

  const parsed = new URL(redirectUrl);
  const params = parsed.searchParams;
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const error = params.get('error') || hashParams.get('error');
  if (error) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: params.get('error_description') || hashParams.get('error_description') || error,
    };
  }

  return {
    type: 'oauth-result',
    providerId: msg.providerId,
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    redirectUrl,
  };
}

chrome.debugger.onDetach.addListener((source: { tabId: number }, _reason: string) => {
  attachedTabs.delete(source.tabId);
  for (const [sessionId, tabId] of sessionToTab) {
    if (tabId === source.tabId) {
      sessionToTab.delete(sessionId);
    }
  }
});

// ---------------------------------------------------------------------------
// Secrets-aware fetch-proxy connection handler
// ---------------------------------------------------------------------------

// Session-only secrets: in-memory, never written to chrome.storage. Lives for
// the service worker's lifetime (MV3 may evict it — that matches the
// "vanish on session end" semantics). Layered into every pipeline build so the
// fetch proxy unmasks session secrets like persisted ones.
const sessionSecretStore = new SessionSecretStore();

async function buildSecretsPipeline(): Promise<SecretsPipeline> {
  const sessionId = await readOrCreateSwSessionId();
  const source: FetchProxySecretSource = {
    get: async (name) => {
      const fromSession = sessionSecretStore.get(name);
      if (fromSession !== undefined) return fromSession;
      const got = (await chrome.storage.local.get(name)) as Record<string, string | undefined>;
      return got[name];
    },
    listAll: () => listSecretsWithValues(chrome.storage.local as any),
  };
  return new SecretsPipeline({ sessionId, source, sessionStore: sessionSecretStore });
}

// ---------------------------------------------------------------------------
// Wave 3b: full CDP pass-through bridge for the sliccy.ai leader tab.
//
// The leader opens a long-lived Port via `chrome.runtime.connect(EXT_ID,
// { name: 'slicc.cdp-bridge' })`, gated here by externally_connectable + the
// three-factor pin enforced inside `handleBridgePortConnect` (origin
// allowlist + sender.tab.id === storedLeaderTabId + sender.frameId === 0).
// `slicc_leader_tab_id` is owned by the sibling leader-tab task; absent →
// pin fails closed. The deps here delegate attach/detach to the existing
// `attachedTabs` accounting so the bridge and the offscreen CDP proxy never
// trample each other, and route outbound commands through `maybeUnmaskCdpFrame`
// so raw CDP secrets MUST NEVER reach the leader tab.
// ---------------------------------------------------------------------------

const bridgeSwDeps = buildDefaultBridgeSwDeps({
  attachDebugger: async (tabId) => {
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
    }
  },
  detachDebugger: async (tabId) => {
    if (!attachedTabs.has(tabId)) return;
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {
      /* tab may already be closed */
    });
  },
  sendDebuggerCommand: async (tabId, method, params) => {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result ?? {};
  },
  maybeUnmaskCdpFrame,
});

chrome.runtime.onConnectExternal.addListener((port: ChromeRuntimePort) => {
  handleBridgePortConnect(port, bridgeSwDeps).catch((err) => {
    console.error('[slicc-sw] CDP bridge connect failed', err);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fetch-proxy.fetch') return;
  // Chrome drops port messages that arrive before any onMessage listener
  // is attached. The page-side caller posts its `request` message right
  // after `chrome.runtime.connect(...)` resolves, which is BEFORE this
  // async buildSecretsPipeline finishes. Attaching the listener inside
  // the .then() is too late — the message has already been dropped and
  // the caller hangs forever.
  //
  // Solution: hand the pipeline-build promise to a variant that attaches
  // the listener SYNCHRONOUSLY and awaits the pipeline INSIDE the handler.
  // The catch path on the promise just propagates into the handler's
  // try/catch, which posts response-error back to the page.
  const pipelinePromise = buildSecretsPipeline().then(async (p) => {
    await p.reload();
    return p;
  });
  pipelinePromise.catch((err) => {
    console.error('[sw] fetch-proxy init failed', err);
    // The handler's await pipelinePromise will throw and post response-error,
    // so we just log here. Don't disconnect — the handler needs the port.
  });
  handleFetchProxyConnectionAsync(port as any, pipelinePromise);
});

// ---------------------------------------------------------------------------
// Secrets message handlers
// ---------------------------------------------------------------------------

type SendResponse = (response?: unknown) => void;
type SecretsHandler = (msg: unknown, sendResponse: SendResponse) => boolean;

function getMsgType(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return undefined;
  const t = (msg as { type: unknown }).type;
  return typeof t === 'string' ? t : undefined;
}

function getStringField(msg: unknown, field: string): string | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = (msg as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : undefined;
}

function getStringArrayField(msg: unknown, field: string): string[] | undefined {
  if (typeof msg !== 'object' || msg === null || !(field in msg)) return undefined;
  const v = (msg as Record<string, unknown>)[field];
  if (!Array.isArray(v)) return undefined;
  return v.filter((d): d is string => typeof d === 'string');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runSecretsListMaskedEntries(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ entries: pipeline.getMaskedEntries() });
    } catch (err) {
      // Without this catch, the unhandled rejection closes the
      // message port and the caller resolves with `undefined` —
      // indistinguishable from "no entries", which silently
      // populates the agent shell with an empty env.
      console.error('[sw] secrets.list-masked-entries failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}
// Tool-output real→masked scrub. The offscreen agent realm holds
// only masked entries (no real values), so the scrub runs here
// against the SW-owned `SecretsPipeline`. Direction is real→masked
// ONLY; idempotent for already-masked tokens and secret-free
// output. Errors degrade to the input text so a transient SW issue
// never blocks a tool result from reaching the agent loop.
function runSecretsScrubToolResult(msg: unknown, sendResponse: SendResponse): boolean {
  const text = getStringField(msg, 'text');
  if (text === undefined) return false;
  (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ text: pipeline.scrubResponse(text) });
    } catch (err) {
      console.error('[sw] secrets.scrub-tool-result failed', err);
      sendResponse({ text, error: errMsg(err) });
    }
  })();
  return true;
}

// Offscreen-only: snapshot the secrets needed to seed the outbound-scrub
// pipeline (defense-in-depth real → masked scrub on the LLM-wire `fetch`
// leg). The offscreen has no `chrome.storage`, so it RPCs here for the
// sessionId + merged {persisted, session} entry list. Mirrors
// `buildSecretsPipeline()` above so the offscreen's pipeline produces the
// same masked values as the SW fetch-proxy pipeline.
function runSecretsListWithValuesForPipeline(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const sessionId = await readOrCreateSwSessionId();
      const persisted = await listSecretsWithValues(chrome.storage.local as any);
      const persistedNames = new Set(persisted.map((e) => e.name));
      const session = sessionSecretStore.listAll().filter((s) => !persistedNames.has(s.name));
      const entries = [...persisted, ...session];
      sendResponse({ sessionId, entries });
    } catch (err) {
      console.error('[sw] secrets.list-with-values-for-pipeline failed', err);
      sendResponse({ sessionId: undefined, entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

// The panel-terminal `secret` command can't touch chrome.storage directly:
// it runs in the offscreen document, which lacks chrome.storage even when
// the manifest grants it (MV3 quirk). Route the management ops through
// the SW, which DOES have chrome.storage.
function runSecretsList(_msg: unknown, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const entries = await listSecrets(chrome.storage.local as any);
      sendResponse({ entries });
    } catch (err) {
      console.error('[sw] secrets.list failed', err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  (async () => {
    try {
      await setSecret(chrome.storage.local as any, name, value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[sw] secrets.set failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

function runSecretsDelete(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  (async () => {
    try {
      // Session secrets win over persisted on name collision (mirrors the
      // node-server endpoint), so they are also checked first on delete.
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.delete(name);
        sendResponse({ ok: true, removed: true, fromSession: true });
        return;
      }
      const existing = await listSecrets(chrome.storage.local as any);
      if (!existing.some((e) => e.name === name)) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      await deleteSecret(chrome.storage.local as any, name);
      sendResponse({ ok: true, removed: true, fromSession: false });
    } catch (err) {
      console.error('[sw] secrets.delete failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

// Session-secret set — in-memory only, never written to chrome.storage.
function runSecretsSessionSet(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const value = getStringField(msg, 'value');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || value === undefined || domains === undefined) return false;
  sessionSecretStore.set(name, value, domains);
  sendResponse({ ok: true });
  return true;
}

function runSecretsSessionList(_msg: unknown, sendResponse: SendResponse): boolean {
  sendResponse({ entries: sessionSecretStore.list() });
  return true;
}

// Peek — returns an elided preview of the unmasked value (session or
// persisted). The full value never leaves the SW.
function runSecretsPeek(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  if (name === undefined) return false;
  (async () => {
    try {
      const sessionRec = sessionSecretStore.getRecord(name);
      if (sessionRec) {
        sendResponse({
          record: {
            name,
            preview: previewSecret(sessionRec.value),
            domains: sessionRec.domains,
          },
        });
        return;
      }
      const all = await listSecretsWithValues(chrome.storage.local as any);
      const found = all.find((e) => e.name === name);
      sendResponse({
        record: found
          ? { name, preview: previewSecret(found.value), domains: found.domains }
          : undefined,
      });
    } catch (err) {
      console.error('[sw] secrets.peek failed', err);
      sendResponse({ record: undefined, error: errMsg(err) });
    }
  })();
  return true;
}

// Scope edit — update the allowed domains of an existing secret (session or
// persisted), preserving the value.
function runSecretsSetDomains(msg: unknown, sendResponse: SendResponse): boolean {
  const name = getStringField(msg, 'name');
  const domains = getStringArrayField(msg, 'domains');
  if (name === undefined || domains === undefined) return false;
  (async () => {
    try {
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.setDomains(name, domains);
        sendResponse({ ok: true });
        return;
      }
      const all = await listSecretsWithValues(chrome.storage.local as any);
      const found = all.find((e) => e.name === name);
      if (!found) {
        sendResponse({ ok: false, error: `no secret named "${name}"` });
        return;
      }
      await setSecret(chrome.storage.local as any, name, found.value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[sw] secrets.set-domains failed', err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}

async function runMaskOauthTokenWrite(
  providerId: string,
  accessToken: string | undefined,
  domains: string | undefined
): Promise<string | undefined> {
  // #847: the caller may be the offscreen document, which has
  // `chrome.runtime` but NOT `chrome.storage` (MV3 quirk — same reason
  // `secrets.set` proxies through the SW). Write the secret here, where
  // the SW owns `chrome.storage`, before building the pipeline that
  // masks it. `domains` is the comma-joined `_DOMAINS` companion.
  if (accessToken && domains) {
    await chrome.storage.local.set({
      [`oauth.${providerId}.token`]: accessToken,
      [`oauth.${providerId}.token_DOMAINS`]: domains,
    });
  }
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  const name = `oauth.${providerId}.token`;
  return pipeline.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
}

function runSecretsMaskOauthToken(msg: unknown, sendResponse: SendResponse): boolean {
  const providerId = getStringField(msg, 'providerId');
  if (providerId === undefined) return false;
  const accessToken = getStringField(msg, 'accessToken');
  const domains = getStringField(msg, 'domains');
  (async () => {
    try {
      const maskedValue = await runMaskOauthTokenWrite(providerId, accessToken, domains);
      // We just wrote the secret above, so a missing entry here is NOT a
      // cold-start miss — it's a real fault (write didn't land, or the
      // pipeline stopped emitting it). Surface it so the page side can
      // distinguish "not warm yet" from "wrote it and still missing".
      if (accessToken && domains && maskedValue === undefined) {
        const name = `oauth.${providerId}.token`;
        // Real fault (not a cold miss): surface a reason so the page can
        // distinguish it and the give-up log isn't reason-less (#847).
        console.warn('[sw] secrets.mask-oauth-token: entry missing after write', { name });
        sendResponse({ maskedValue: undefined, error: 'entry missing after write' });
        return;
      }
      sendResponse({ maskedValue });
    } catch (err) {
      console.error('[sw] secrets.mask-oauth-token failed', err);
      sendResponse({ maskedValue: undefined, error: errMsg(err) });
    }
  })();
  return true;
}

const SECRETS_HANDLERS: Record<string, SecretsHandler> = {
  'secrets.list-masked-entries': runSecretsListMaskedEntries,
  'secrets.scrub-tool-result': runSecretsScrubToolResult,
  'secrets.list-with-values-for-pipeline': runSecretsListWithValuesForPipeline,
  'secrets.list': runSecretsList,
  'secrets.set': runSecretsSet,
  'secrets.delete': runSecretsDelete,
  'secrets.session.set': runSecretsSessionSet,
  'secrets.session.list': runSecretsSessionList,
  'secrets.peek': runSecretsPeek,
  'secrets.set-domains': runSecretsSetDomains,
  'secrets.mask-oauth-token': runSecretsMaskOauthToken,
};

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    const type = getMsgType(msg);
    if (type === undefined) return false;
    const handler = SECRETS_HANDLERS[type];
    return handler ? handler(msg, sendResponse) : false;
  }
);
