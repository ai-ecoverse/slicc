/**
 * CDP proxy — chrome.debugger attachment bookkeeping and outbound frame
 * unmasking, shared between the bridge-sw (leader-tab CDP pass-through)
 * and the service-worker tab-monitoring listener.
 *
 * Only the SW may call `chrome.debugger`. The bridge is the sole active
 * consumer (owner `'bridge'`, wired in `bridge-sw.ts`).
 *
 * B24-3: The legacy offscreen compatibility path (`cdp-command` messages,
 * owner `'legacy'`) and the tray-socket relay have been removed — the
 * offscreen document no longer exists. `handleCdpCommand` and its private
 * helpers (`cdpGetTargets`, `cdpAttachToTarget`, `cdpDetachFromTarget`,
 * `cdpCreateTarget`, `cdpCloseTarget`, `cdpSendCommand`, `tabHostname`,
 * `tabIdFromTargetId`, `forceReleaseDebuggerAttachment`) were the dead
 * entry points.
 *
 * `CdpPayload` is declared globally in ./chrome.d.ts, along with the rest of
 * the Chrome extension API types.
 */

import { unmaskCdpFrame } from '@slicc/shared-ts';
import { notifyBridgeDebuggerDetached } from './bridge-sw.js';
import { buildSecretsPipeline } from './secrets-sw.js';

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

function handleDebuggerDetach(source: ChromeDebuggerTarget): void {
  debuggerAttachmentOwners.delete(source.tabId);
  notifyBridgeDebuggerDetached(source.tabId);
}

/** Register the `chrome.debugger` event + detach listeners. */
export function installCdpProxyListeners(): void {
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
}
