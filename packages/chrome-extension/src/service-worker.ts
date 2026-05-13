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

import type {
  ExtensionMessage,
  CdpCommandMsg,
  CdpResponseMsg,
  CdpEventMsg,
  NavigateLickMsg,
  TraySocketCommandMessage,
  TraySocketErrorMsg,
  TraySocketMessageMsg,
  TraySocketOpenMsg,
  TraySocketOpenedMsg,
  OAuthRequestMsg,
  OAuthResultMsg,
} from './messages.js';
import {
  isExtensionMessage,
  DETACHED_RUNTIME_QUERY_NAME,
  DETACHED_RUNTIME_QUERY_VALUE,
} from './messages.js';
import {
  executeDaSignAndForward,
  executeS3SignAndForward,
  type DaSignAndForwardEnvelope,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
  type SignAndForwardReply,
} from '../../webapp/src/fs/mount/sign-and-forward-shared.js';
import { handleFetchProxyConnectionAsync } from './fetch-proxy-shared.js';
import { deleteSecret, listSecrets, listSecretsWithValues, setSecret } from './secrets-storage.js';
import { readOrCreateSwSessionId } from './sw-session-id.js';
import { SecretsPipeline, type FetchProxySecretSource } from '@slicc/shared-ts';
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
  if (clickedTab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: clickedTab.id });
  }
}

chrome.action.onClicked.addListener((tab) => {
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
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Runs the SLICC agent engine so work survives side panel close.',
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
// x-slicc header observer — emit a navigate lick when a main-frame document
// response carries the x-slicc header.
// ---------------------------------------------------------------------------

function findSliccHeader(
  headers: Array<{ name: string; value?: string }> | undefined
): string | null {
  if (!headers) return null;
  for (const h of headers) {
    if (h.name.toLowerCase() === 'x-slicc' && typeof h.value === 'string' && h.value.length > 0) {
      // Producers percent-encode the value so non-Latin1 input survives
      // transport. Decode on read; fall back to raw if malformed.
      try {
        return decodeURIComponent(h.value);
      } catch {
        return h.value;
      }
    }
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const sliccHeader = findSliccHeader(details.responseHeaders);
    if (!sliccHeader) return;
    const payload: NavigateLickMsg = {
      type: 'navigate-lick',
      url: details.url,
      sliccHeader,
      tabId: details.tabId >= 0 ? details.tabId : undefined,
    };
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
        .then((tab) => dispatch(tab.title))
        .catch(() => dispatch());
    } else {
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

  const result = await chrome.debugger.sendCommand({ tabId }, method, params);
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
  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: msg.authorizeUrl,
    interactive: true,
  });

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

async function buildSecretsPipeline(): Promise<SecretsPipeline> {
  const sessionId = await readOrCreateSwSessionId();
  const source: FetchProxySecretSource = {
    get: async (name) => {
      const got = (await chrome.storage.local.get(name)) as Record<string, string | undefined>;
      return got[name];
    },
    listAll: () => listSecretsWithValues(chrome.storage.local as any),
  };
  return new SecretsPipeline({ sessionId, source });
}

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

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    if (
      typeof msg === 'object' &&
      msg != null &&
      'type' in msg &&
      msg.type === 'secrets.list-masked-entries'
    ) {
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
          sendResponse({
            entries: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // The panel-terminal `secret` command can't touch chrome.storage directly:
    // it runs in the offscreen document, which lacks chrome.storage even when
    // the manifest grants it (MV3 quirk). Route the management ops through
    // the SW, which DOES have chrome.storage.
    if (typeof msg === 'object' && msg != null && 'type' in msg && msg.type === 'secrets.list') {
      (async () => {
        try {
          const entries = await listSecrets(chrome.storage.local as any);
          sendResponse({ entries });
        } catch (err) {
          console.error('[sw] secrets.list failed', err);
          sendResponse({
            entries: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    if (
      typeof msg === 'object' &&
      msg != null &&
      'type' in msg &&
      msg.type === 'secrets.set' &&
      'name' in msg &&
      typeof msg.name === 'string' &&
      'value' in msg &&
      typeof msg.value === 'string' &&
      'domains' in msg &&
      Array.isArray(msg.domains)
    ) {
      const name = msg.name;
      const value = msg.value;
      const domains = (msg.domains as unknown[]).filter((d): d is string => typeof d === 'string');
      (async () => {
        try {
          await setSecret(chrome.storage.local as any, name, value, domains);
          sendResponse({ ok: true });
        } catch (err) {
          console.error('[sw] secrets.set failed', err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }
    if (
      typeof msg === 'object' &&
      msg != null &&
      'type' in msg &&
      msg.type === 'secrets.delete' &&
      'name' in msg &&
      typeof msg.name === 'string'
    ) {
      const name = msg.name;
      (async () => {
        try {
          await deleteSecret(chrome.storage.local as any, name);
          sendResponse({ ok: true });
        } catch (err) {
          console.error('[sw] secrets.delete failed', err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }
    if (
      typeof msg === 'object' &&
      msg != null &&
      'type' in msg &&
      msg.type === 'secrets.mask-oauth-token' &&
      'providerId' in msg &&
      typeof msg.providerId === 'string'
    ) {
      const providerId = msg.providerId;
      (async () => {
        try {
          const pipeline = await buildSecretsPipeline();
          await pipeline.reload();
          const name = `oauth.${providerId}.token`;
          const found = pipeline.getMaskedEntries().find((e) => e.name === name);
          sendResponse({ maskedValue: found?.maskedValue });
        } catch (err) {
          console.error('[sw] secrets.mask-oauth-token failed', err);
          sendResponse({
            maskedValue: undefined,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
  }
);
