/**
 * Cross-realm liveness for cone screen-share approval.
 *
 * The worker owns the 2-minute `showToolUI` timeout; `getDisplayMedia` runs
 * on the page and cannot be aborted. A BroadcastChannel tells the page when
 * the approval is still live so a late OS-picker grant can be dropped.
 */

export const SCREEN_SHARE_APPROVAL_CHANNEL = 'slicc-screen-share-approval';

interface ScreenShareApprovalMsg {
  type: 'begin' | 'end';
  id: string;
}

const live = new Set<string>();
let sawTerminalEvent = false;
let channel: BroadcastChannel | null | undefined;

function isApprovalMsg(value: unknown): value is ScreenShareApprovalMsg {
  if (typeof value !== 'object' || value === null) return false;
  const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
  const id = Object.getOwnPropertyDescriptor(value, 'id')?.value;
  return (type === 'begin' || type === 'end') && typeof id === 'string';
}

function applyMsg(msg: ScreenShareApprovalMsg): void {
  sawTerminalEvent = true;
  if (msg.type === 'begin') live.add(msg.id);
  else live.delete(msg.id);
}

export function listenScreenShareApprovalChannel(): void {
  if (channel !== undefined) return;
  if (typeof BroadcastChannel !== 'function') {
    channel = null;
    return;
  }
  try {
    channel = new BroadcastChannel(SCREEN_SHARE_APPROVAL_CHANNEL);
  } catch {
    channel = null;
    return;
  }
  channel.onmessage = (ev: MessageEvent<unknown>) => {
    if (isApprovalMsg(ev.data)) applyMsg(ev.data);
  };
}

function post(msg: ScreenShareApprovalMsg): void {
  listenScreenShareApprovalChannel();
  applyMsg(msg);
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed */
  }
}

export function beginScreenShareApproval(id: string): void {
  post({ type: 'begin', id });
}

export function endScreenShareApproval(id: string): void {
  post({ type: 'end', id });
}

/** True when a grant should still be adopted (no end, or a begin still live). */
export function shouldAdoptScreenShare(): boolean {
  listenScreenShareApprovalChannel();
  return live.size > 0 || !sawTerminalEvent;
}

export function keepAdoptedScreenShare(handle: string, stop: (handle: string) => boolean): boolean {
  if (shouldAdoptScreenShare()) return true;
  stop(handle);
  return false;
}

export function resetScreenShareApprovalLiveForTests(): void {
  live.clear();
  sawTerminalEvent = false;
}
