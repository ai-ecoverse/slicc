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
  TraySocketCommandMessage,
  TraySocketErrorMsg,
  TraySocketMessageMsg,
  TraySocketOpenMsg,
  TraySocketOpenedMsg,
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

async function ensureOffscreen(): Promise<void> {
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
    console.error('[slicc-sw] Failed to create offscreen document:', err);
  }
}

// Create offscreen doc on install/startup
chrome.runtime.onInstalled?.addListener?.(() => { ensureOffscreen(); });
ensureOffscreen();

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

      if (isTraySocketCommand(payload)) {
        void handleTraySocketCommand(payload)
          .catch((err) => {
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

function isTraySocketCommand(payload: ExtensionMessage['payload']): payload is TraySocketCommandMessage {
  return payload.type === 'tray-socket-open' || payload.type === 'tray-socket-send' || payload.type === 'tray-socket-close';
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
    void sendServiceWorkerMessage({ type: 'tray-socket-opened', id: command.id } satisfies TraySocketOpenedMsg);
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
  return { targetId: String(tab.id) };
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
