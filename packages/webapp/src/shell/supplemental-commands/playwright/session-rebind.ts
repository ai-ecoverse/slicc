/**
 * Re-binding helper for the per-tab CDP event captures (`console`,
 * `requests`, `route`).
 *
 * Those captures subscribe to transport events once and filter by the session
 * id they saw first. That was safe only while a session, once attached, lived
 * forever. The bridge now keeps ONE session per tab and heals a stale one by
 * re-attaching (issue #2417), so a capture that never re-binds keeps filtering
 * on a dead session id and silently stops recording.
 *
 * Wrapped rather than called directly so a duck-typed browser port (or a test
 * double) without the hook degrades to today's behaviour instead of throwing.
 */

import type { PlaywrightHandlerCtx } from './types.js';

type Browser = PlaywrightHandlerCtx['browser'];

/** `(sessionId, transport, targetId)` — the replacement session for a tab. */
export type SessionReplacedListener = Parameters<Browser['onSessionReplaced']>[1];

export function onSessionReplaced(
  browser: Browser,
  targetId: string,
  listener: SessionReplacedListener
): () => void {
  if (typeof browser.onSessionReplaced !== 'function') return () => undefined;
  return browser.onSessionReplaced(targetId, listener);
}
