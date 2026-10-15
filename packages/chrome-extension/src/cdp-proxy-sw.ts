import { unmaskCdpFrame } from '@slicc/shared-ts';
import { notifyBridgeDebuggerDetached } from './bridge-sw.js';
import { buildSecretsPipeline } from './secrets-sw.js';

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

function handleDebuggerDetach(source: ChromeDebuggerTarget): void {
  debuggerAttachmentOwners.delete(source.tabId);
  notifyBridgeDebuggerDetached(source.tabId);
}

export function installCdpProxyListeners(): void {
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
}
