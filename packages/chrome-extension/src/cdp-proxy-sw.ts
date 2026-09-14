import { unmaskCdpFrame } from '@slicc/shared-ts';

import type {
  CdpCommandMsg,
  CdpEventMsg,
  CdpResponseMsg,
} from '../../webapp/src/kernel/messages.js';
import { notifyBridgeDebuggerDetached } from './bridge-sw.js';
import { buildSecretsPipeline } from './secrets-sw.js';
import { postServiceWorkerMessage } from './sw-broadcast.js';
import { addToSliccGroup } from './tab-group-sw.js';

const sessionToTab = new Map<string, number>();
type DebuggerAttachmentOwner = 'bridge' | 'legacy';

const debuggerAttachmentOwners = new Map<number, DebuggerAttachmentOwner>();

export async function acquireDebuggerAttachment(
  tabId: number,
  owner: DebuggerAttachmentOwner
): Promise<boolean> {
  if (debuggerAttachmentOwners.has(tabId)) return false;
  await chrome.debugger.attach({ tabId }, '1.3');
  debuggerAttachmentOwners.set(tabId, owner);
  return true;
}

export async function releaseDebuggerAttachment(
  tabId: number,
  owner: DebuggerAttachmentOwner
): Promise<void> {
  if (debuggerAttachmentOwners.get(tabId) !== owner) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function forceReleaseDebuggerAttachment(tabId: number): Promise<void> {
  if (!debuggerAttachmentOwners.has(tabId)) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

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

  for (const [sid, tid] of sessionToTab) {
    if (tid === tabId) sessionToTab.delete(sid);
  }
  await forceReleaseDebuggerAttachment(tabId);

  await chrome.tabs.remove(tabId);
  return { success: true };
}

const CDP_UNMASK_METHODS = new Set<string>([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Input.insertText',
]);

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

function forwardDebuggerEvent(
  source: ChromeDebuggerTarget,
  method: string,
  params?: CdpPayload
): void {
  const sessionId = legacySessionIdForTab(source.tabId);
  if (sessionId === undefined) return;

  postServiceWorkerMessage({
    type: 'cdp-event',
    method,
    params: { ...params, sessionId },
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

export function installCdpProxyListeners(): void {
  chrome.debugger.onEvent.addListener(forwardDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
}
