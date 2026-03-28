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
  PendingHandoff,
  GenericHandoffPayload,
  ExternalHandoffMessage,
  HandoffPendingListMsg,
  HandoffInjectMsg,
} from './messages.js';

// ---------------------------------------------------------------------------
// Side panel behavior
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html';
const ALLOWED_HANDOFF_ORIGIN = 'https://www.sliccy.ai';
const PENDING_HANDOFFS_STORAGE_KEY = 'slicc.pendingHandoffs';
const HANDLED_HANDOFFS_STORAGE_KEY = 'slicc.handledHandoffs';
const MAX_HANDOFF_BYTES = 65536;
const MAX_TITLE_LENGTH = 160;
const MAX_URLS = 100;
const BADGE_COLOR = '#f000a0';
const DEV_HANDOFF_ORIGINS_ENABLED =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : Boolean((globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__);

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
void syncPendingHandoffBadge();

type PendingHandoffStore = Record<string, PendingHandoff>;
type HandledHandoffStore = Record<string, string>;

async function readPendingHandoffStore(): Promise<PendingHandoffStore> {
  const stored = await chrome.storage.local.get(PENDING_HANDOFFS_STORAGE_KEY);
  return (stored[PENDING_HANDOFFS_STORAGE_KEY] as PendingHandoffStore | undefined) ?? {};
}

async function writePendingHandoffStore(store: PendingHandoffStore): Promise<void> {
  await chrome.storage.local.set({ [PENDING_HANDOFFS_STORAGE_KEY]: store });
}

async function readHandledHandoffStore(): Promise<HandledHandoffStore> {
  const stored = await chrome.storage.local.get(HANDLED_HANDOFFS_STORAGE_KEY);
  return (stored[HANDLED_HANDOFFS_STORAGE_KEY] as HandledHandoffStore | undefined) ?? {};
}

async function writeHandledHandoffStore(store: HandledHandoffStore): Promise<void> {
  await chrome.storage.local.set({ [HANDLED_HANDOFFS_STORAGE_KEY]: store });
}

async function listPendingHandoffs(): Promise<PendingHandoff[]> {
  const store = await readPendingHandoffStore();
  return Object.values(store).sort((left, right) =>
    left.receivedAt.localeCompare(right.receivedAt)
  );
}

async function syncPendingHandoffBadge(): Promise<void> {
  const handoffs = await listPendingHandoffs();
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({
    text: handoffs.length === 0 ? '' : handoffs.length > 99 ? '99+' : String(handoffs.length),
  });
}

async function broadcastPendingHandoffList(): Promise<void> {
  const handoffs = await listPendingHandoffs();
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({
    text: handoffs.length === 0 ? '' : handoffs.length > 99 ? '99+' : String(handoffs.length),
  });
  await sendServiceWorkerMessage({
    type: 'handoff-pending-list',
    handoffs,
  } satisfies HandoffPendingListMsg).catch(() => {
    // No panel open — badge/storage still reflect the correct state.
  });
}

function isExternalHandoffMessage(message: unknown): message is ExternalHandoffMessage {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as Partial<ExternalHandoffMessage>;
  return candidate.type === 'handoff_message.v1';
}

function validateExternalSender(sender: ChromeMessageSender): string | null {
  const origin = getSenderOrigin(sender);
  if (!origin) {
    return 'External handoff sender is missing a URL.';
  }
  return isAllowedHandoffOrigin(origin)
    ? null
    : `External handoffs are only allowed from ${describeAllowedOrigins()}.`;
}

function getSenderOrigin(sender: ChromeMessageSender): string | null {
  if (sender.origin) return sender.origin;
  if (!sender.url) return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

function isAllowedHandoffOrigin(origin: string): boolean {
  if (origin === ALLOWED_HANDOFF_ORIGIN) return true;
  if (!DEV_HANDOFF_ORIGINS_ENABLED) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (
    ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
    ['http:', 'https:'].includes(parsed.protocol)
  ) {
    return true;
  }

  return parsed.protocol === 'https:' && parsed.hostname.endsWith('.workers.dev');
}

function describeAllowedOrigins(): string {
  if (!DEV_HANDOFF_ORIGINS_ENABLED) return ALLOWED_HANDOFF_ORIGIN;
  return `${ALLOWED_HANDOFF_ORIGIN}, localhost/127.0.0.1 over http(s), and https://*.workers.dev`;
}

function validateExternalHandoff(message: ExternalHandoffMessage): string | null {
  if (!/^[a-f0-9]{32}$/i.test(message.handoffId)) {
    return 'handoffId must be a 32-character hexadecimal string.';
  }

  if (!isPlainObject(message.payload)) {
    return 'payload must be an object.';
  }

  const allowedKeys = new Set([
    'title',
    'instruction',
    'urls',
    'context',
    'acceptanceCriteria',
    'notes',
    'openUrlsFirst',
  ]);
  for (const key of Object.keys(message.payload)) {
    if (!allowedKeys.has(key)) {
      return `Unsupported handoff field: ${key}.`;
    }
  }

  const normalized = normalizeHandoffPayload(message.payload);
  if (!normalized) {
    return 'payload shape is invalid.';
  }

  const size = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (size > MAX_HANDOFF_BYTES) {
    return `payload exceeds ${MAX_HANDOFF_BYTES} bytes.`;
  }

  return null;
}

function normalizeHandoffPayload(payload: GenericHandoffPayload): GenericHandoffPayload | null {
  if (payload.title !== undefined) {
    if (typeof payload.title !== 'string' || payload.title.trim().length === 0) return null;
    if (payload.title.length > MAX_TITLE_LENGTH) return null;
  }
  if (typeof payload.instruction !== 'string' || payload.instruction.trim().length === 0) {
    return null;
  }
  if (payload.urls !== undefined) {
    if (!Array.isArray(payload.urls) || payload.urls.length > MAX_URLS) return null;
    for (const url of payload.urls) {
      if (typeof url !== 'string' || url.trim().length === 0) return null;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      } catch {
        return null;
      }
    }
  }
  if (payload.context !== undefined && typeof payload.context !== 'string') return null;
  if (payload.notes !== undefined && typeof payload.notes !== 'string') return null;
  if (payload.acceptanceCriteria !== undefined) {
    if (!Array.isArray(payload.acceptanceCriteria)) return null;
    for (const item of payload.acceptanceCriteria) {
      if (typeof item !== 'string' || item.trim().length === 0) return null;
    }
  }
  if (payload.openUrlsFirst !== undefined && typeof payload.openUrlsFirst !== 'boolean')
    return null;

  return {
    title: payload.title?.trim(),
    instruction: payload.instruction.trim(),
    urls: payload.urls?.map((url) => url.trim()),
    context: payload.context,
    acceptanceCriteria: payload.acceptanceCriteria?.map((item) => item.trim()),
    notes: payload.notes,
    openUrlsFirst: payload.openUrlsFirst,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

      if (panelPayload.type === 'handoff-list-request') {
        void broadcastPendingHandoffList();
        return false;
      }

      if (panelPayload.type === 'handoff-dismiss') {
        void dismissPendingHandoff(panelPayload.handoffId).catch((err) => {
          console.error('[slicc-sw] Failed to dismiss handoff:', err);
        });
        return false;
      }

      if (panelPayload.type === 'handoff-accept') {
        void acceptPendingHandoff(panelPayload.handoffId).catch((err) => {
          console.error('[slicc-sw] Failed to accept handoff:', err);
        });
        return false;
      }

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

chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender: ChromeMessageSender, sendResponse: (response?: unknown) => void) => {
    if (!isExternalHandoffMessage(message)) {
      sendResponse({
        status: 'rejected',
        error: 'Unsupported external message.',
      });
      return false;
    }

    void queueExternalHandoff(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          status: 'rejected',
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  }
);

function isExtMsg(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

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

async function queueExternalHandoff(
  message: ExternalHandoffMessage,
  sender: ChromeMessageSender
): Promise<{ status: 'queued' | 'duplicate' }> {
  const senderError = validateExternalSender(sender);
  if (senderError) {
    throw new Error(senderError);
  }

  const validationError = validateExternalHandoff(message);
  if (validationError) {
    throw new Error(validationError);
  }

  const payload = normalizeHandoffPayload(message.payload);
  if (!payload) {
    throw new Error('payload shape is invalid.');
  }

  const [pending, handled] = await Promise.all([
    readPendingHandoffStore(),
    readHandledHandoffStore(),
  ]);

  if (pending[message.handoffId] || handled[message.handoffId]) {
    await broadcastPendingHandoffList();
    return { status: 'duplicate' };
  }

  pending[message.handoffId] = {
    handoffId: message.handoffId,
    receivedAt: new Date().toISOString(),
    sourceUrl: sender.url,
    payload,
  };

  await writePendingHandoffStore(pending);
  await broadcastPendingHandoffList();
  return { status: 'queued' };
}

async function dismissPendingHandoff(handoffId: string): Promise<void> {
  const [pending, handled] = await Promise.all([
    readPendingHandoffStore(),
    readHandledHandoffStore(),
  ]);

  if (pending[handoffId]) {
    delete pending[handoffId];
    handled[handoffId] = new Date().toISOString();
    await Promise.all([writePendingHandoffStore(pending), writeHandledHandoffStore(handled)]);
  }

  await broadcastPendingHandoffList();
}

async function acceptPendingHandoff(handoffId: string): Promise<void> {
  const [pending, handled] = await Promise.all([
    readPendingHandoffStore(),
    readHandledHandoffStore(),
  ]);

  const handoff = pending[handoffId];
  if (!handoff) {
    await broadcastPendingHandoffList();
    return;
  }

  if (handoff.payload.openUrlsFirst) {
    for (const url of handoff.payload.urls ?? []) {
      const tab = await chrome.tabs.create({ url, active: false });
      await addToSliccGroup(tab.id);
    }
  }

  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    source: 'panel' as const,
    payload: {
      type: 'handoff-inject',
      handoff,
    } satisfies HandoffInjectMsg,
  });

  delete pending[handoffId];
  handled[handoffId] = new Date().toISOString();
  await Promise.all([writePendingHandoffStore(pending), writeHandledHandoffStore(handled)]);
  await broadcastPendingHandoffList();
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
