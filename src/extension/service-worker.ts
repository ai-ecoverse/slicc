/**
 * Extension service worker — message relay + CDP proxy + offscreen lifecycle.
 *
 * Responsibilities:
 * 1. Open the side panel on action icon click
 * 2. Create/maintain the offscreen document (agent engine)
 * 3. Relay messages between side panel ↔ offscreen document
 * 4. Proxy chrome.debugger CDP calls for the offscreen document
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import type {
  ExtensionMessage,
  CdpCommandMsg,
  CdpResponseMsg,
  CdpEventMsg,
  OAuthRequestMsg,
  OAuthResultMsg,
} from './messages.js';

// ---------------------------------------------------------------------------
// Side panel behavior
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
        console.error('[slicc-sw] chrome.offscreen API not available — missing "offscreen" permission?');
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
chrome.runtime.onInstalled?.addListener?.(() => { ensureOffscreen(); });
ensureOffscreen();

// ---------------------------------------------------------------------------
// Tab group — all agent-created tabs go into a "slicc" group
// ---------------------------------------------------------------------------

let sliccGroupId: number | null = null;

async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch {
        // Group was removed by user, create a new one
        sliccGroupId = null;
      }
    }
    sliccGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(sliccGroupId, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  } catch {
    // Best-effort — tab may have been closed already
  }
}

// ---------------------------------------------------------------------------
// CDP state for proxying chrome.debugger calls
// ---------------------------------------------------------------------------

/** Maps synthetic sessionId → Chrome tab ID. */
const sessionToTab = new Map<string, number>();
/** Tracks which tab IDs we've attached the debugger to. */
const attachedTabs = new Set<number>();

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
            chrome.runtime.sendMessage({
              source: 'service-worker' as const,
              payload: result,
            }).catch((e) => {
              console.error('[slicc-sw] Failed to send OAuth result:', e);
            });
          })
          .catch((err) => {
            chrome.runtime.sendMessage({
              source: 'service-worker' as const,
              payload: {
                type: 'oauth-result',
                providerId: oauthMsg.providerId,
                error: err instanceof Error ? err.message : String(err),
              } satisfies OAuthResultMsg,
            }).catch((e) => {
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
            chrome.runtime.sendMessage({
              source: 'service-worker' as const,
              payload: response,
            }).catch(() => {});
          })
          .catch((err) => {
            chrome.runtime.sendMessage({
              source: 'service-worker' as const,
              payload: {
                type: 'cdp-response',
                id: (payload as CdpCommandMsg).id,
                error: err instanceof Error ? err.message : String(err),
              } satisfies CdpResponseMsg,
            }).catch(() => {});
          });
        return false;
      }

      // Non-CDP offscreen messages reach the side panel directly via
      // chrome.runtime.sendMessage broadcast — no relay needed.
      return false;
    }

    return false;
  },
);

function isExtMsg(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'source' in msg &&
    'payload' in msg
  );
}

// Note: No relay functions needed. chrome.runtime.sendMessage broadcasts to
// all extension contexts (except the sender). Panel ↔ offscreen messages
// reach each other directly. The service worker only handles CDP proxy commands.

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
  const targetInfos = tabs.map((tab) => ({
    targetId: String(tab.id),
    type: 'page',
    title: tab.title ?? '',
    url: tab.url ?? '',
    attached: attachedTabs.has(tab.id!),
    active: activeTabIds.has(tab.id!),
  }));
  return { targetInfos };
}

async function cdpAttachToTarget(
  params: Record<string, unknown>,
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
  params: Record<string, unknown>,
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

async function cdpCreateTarget(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = (params['url'] as string) ?? 'about:blank';
  const tab = await chrome.tabs.create({ url, active: false });
  await addToSliccGroup(tab.id);
  return { targetId: String(tab.id) };
}

async function cdpCloseTarget(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  await chrome.tabs.remove(tabId);
  return { success: true };
}

async function cdpSendCommand(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  const tabId = sessionId ? sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`,
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
    chrome.runtime.sendMessage({
      source: 'service-worker' as const,
      payload: cdpEvent,
    }).catch(() => {
      // Offscreen may not be listening
    });
  },
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

chrome.debugger.onDetach.addListener(
  (source: { tabId: number }, _reason: string) => {
    attachedTabs.delete(source.tabId);
    for (const [sessionId, tabId] of sessionToTab) {
      if (tabId === source.tabId) {
        sessionToTab.delete(sessionId);
      }
    }
  },
);
