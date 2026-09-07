/**
 * CDP proxy — translate the offscreen document's CDP commands into
 * `chrome.debugger` calls, own the per-tab attachment bookkeeping shared with
 * `bridge-sw.ts`, and forward debugger events back.
 *
 * Only the SW may call `chrome.debugger`. Two consumers share it: the legacy
 * offscreen compatibility path (`cdp-command` messages, tracked as owner
 * `'legacy'` with a synthetic `sessionId === targetId`) and the hosted leader
 * tab's pass-through bridge (owner `'bridge'`, wired in `bridge-sw.ts`, which
 * forwards its own events per-Port). Ownership keeps one consumer from
 * detaching a session the other established.
 *
 * `CdpPayload` is declared globally in ./chrome.d.ts, along with the rest of
 * the Chrome extension API types.
 */

import { unmaskCdpFrame } from '@slicc/shared-ts';
// `import type` only — see the import-boundary note in
// packages/chrome-extension/CLAUDE.md.
import type {
  CdpCommandMsg,
  CdpEventMsg,
  CdpResponseMsg,
} from '../../webapp/src/kernel/messages.js';
import { notifyBridgeDebuggerDetached } from './bridge-sw.js';
import { buildSecretsPipeline } from './secrets-sw.js';
import { postServiceWorkerMessage } from './sw-broadcast.js';
import { addToSliccGroup } from './tab-group-sw.js';

/** Maps synthetic sessionId → Chrome tab ID (legacy offscreen path only). */
const sessionToTab = new Map<string, number>();
type DebuggerAttachmentOwner = 'bridge' | 'legacy';
/** Tracks which consumer performed each underlying debugger attachment. */
const debuggerAttachmentOwners = new Map<number, DebuggerAttachmentOwner>();

/** Attach unless someone already holds this tab. Returns true when THIS call
 *  performed the attach, so the caller knows whether it may detach later. */
export async function acquireDebuggerAttachment(
  tabId: number,
  owner: DebuggerAttachmentOwner
): Promise<boolean> {
  if (debuggerAttachmentOwners.has(tabId)) return false;
  await chrome.debugger.attach({ tabId }, '1.3');
  debuggerAttachmentOwners.set(tabId, owner);
  return true;
}

/** Detach only when `owner` is the recorded owner — never steal the other
 *  consumer's session. */
export async function releaseDebuggerAttachment(
  tabId: number,
  owner: DebuggerAttachmentOwner
): Promise<void> {
  if (debuggerAttachmentOwners.get(tabId) !== owner) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {
    // Tab may already be closed
  });
}

/** Detach regardless of owner — used when the target tab itself goes away. */
async function forceReleaseDebuggerAttachment(tabId: number): Promise<void> {
  if (!debuggerAttachmentOwners.has(tabId)) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {
    // Tab may already be closed
  });
}

/** The legacy sessionId mapped to `tabId`, or undefined when the offscreen path
 *  holds no session for it (e.g. the bridge owns the attachment). */
function legacySessionIdForTab(tabId: number): string | undefined {
  for (const [sessionId, mapped] of sessionToTab) {
    if (mapped === tabId) return sessionId;
  }
  return undefined;
}

export async function handleCdpCommand(cmd: CdpCommandMsg): Promise<CdpResponseMsg> {
  const { id, method, params, sessionId } = cmd;

  try {
    let result: CdpPayload;

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

async function cdpGetTargets(): Promise<CdpPayload> {
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
      attached: debuggerAttachmentOwners.has(tab.id),
      active: activeTabIds.has(tab.id),
    }));
  return { targetInfos };
}

/** Parse a synthetic targetId (the stringified tab id) or throw. */
function tabIdFromTargetId(targetId: string): number {
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  return tabId;
}

async function cdpAttachToTarget(params: CdpPayload): Promise<CdpPayload> {
  const targetId = params['targetId'] as string;
  const tabId = tabIdFromTargetId(targetId);

  await acquireDebuggerAttachment(tabId, 'legacy');

  const sessionId = targetId;
  sessionToTab.set(sessionId, tabId);
  return { sessionId };
}

async function cdpDetachFromTarget(params: CdpPayload): Promise<CdpPayload> {
  const sessionId = params['sessionId'] as string;
  const tabId = sessionToTab.get(sessionId);

  if (tabId !== undefined) {
    sessionToTab.delete(sessionId);
    const stillReferenced = legacySessionIdForTab(tabId) !== undefined;
    if (!stillReferenced) {
      await releaseDebuggerAttachment(tabId, 'legacy');
    }
  }

  return {};
}

async function cdpCreateTarget(params: CdpPayload): Promise<CdpPayload> {
  const url = (params['url'] as string) ?? 'about:blank';
  const tab = await chrome.tabs.create({ url, active: false });
  await addToSliccGroup(tab.id);
  return { targetId: String(tab.id) };
}

async function cdpCloseTarget(params: CdpPayload): Promise<CdpPayload> {
  const targetId = params['targetId'] as string;
  const tabId = tabIdFromTargetId(targetId);

  // Clean up session/attach state for this tab
  for (const [sid, tid] of sessionToTab) {
    if (tid === tabId) sessionToTab.delete(sid);
  }
  await forceReleaseDebuggerAttachment(tabId);

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

/** Resolve the target tab's CURRENT URL hostname. Fail-closed: any failure
 *  (tab gone, missing url, unparseable) yields null so the caller leaves the
 *  frame untouched. */
async function tabHostname(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    if (typeof url !== 'string' || url.length === 0) return null;
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Unmask whole-token secret fields on an outgoing CDP frame against the target
 * tab's current hostname. Fail-closed: the frame is returned untouched unless
 * the hostname resolves AND the pipeline holds secrets AND the unmask changed
 * something.
 */
export async function maybeUnmaskCdpFrame(
  tabId: number,
  method: string,
  params: CdpPayload | undefined
): Promise<CdpPayload | undefined> {
  if (!CDP_UNMASK_METHODS.has(method)) return params;
  if (!params || typeof params !== 'object') return params;

  const hostname = await tabHostname(tabId);
  if (!hostname) return params;

  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  if (!pipeline.hasSecrets()) return params;

  const { frame, changed } = unmaskCdpFrame({ method, params }, hostname, pipeline);
  if (!changed) return params;
  const nextParams = (frame as { params?: CdpPayload }).params;
  return nextParams ?? params;
}

async function cdpSendCommand(
  method: string,
  params?: CdpPayload,
  sessionId?: string
): Promise<CdpPayload> {
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

/** Forward `chrome.debugger` events to the offscreen document. */
function forwardDebuggerEvent(
  source: ChromeDebuggerTarget,
  method: string,
  params?: CdpPayload
): void {
  if (!debuggerAttachmentOwners.has(source.tabId)) return;
  const sessionId = legacySessionIdForTab(source.tabId);

  postServiceWorkerMessage({
    type: 'cdp-event',
    method,
    params: sessionId ? { ...params, sessionId } : (params ?? {}),
  } satisfies CdpEventMsg);
}

function handleDebuggerDetach(source: ChromeDebuggerTarget): void {
  debuggerAttachmentOwners.delete(source.tabId);
  for (const [sessionId, tabId] of sessionToTab) {
    if (tabId === source.tabId) {
      sessionToTab.delete(sessionId);
    }
  }
  notifyBridgeDebuggerDetached(source.tabId);
}

/** Register the `chrome.debugger` event + detach listeners. */
export function installCdpProxyListeners(): void {
  chrome.debugger.onEvent.addListener(forwardDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
}
