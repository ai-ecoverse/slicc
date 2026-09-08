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
 * Two things have to happen on a replacement, and BOTH are unconditional:
 *
 *  1. **Re-arm the listeners**, even when the transport object is the same
 *     one. A transport whose connection dropped and came back in place —
 *     `ExtensionBridgeTransport` after an MV3 service-worker eviction kills
 *     its Port — is the identical object with an emptied listener registry,
 *     because the reconnect path runs `CdpTransportBridge.disconnect()`. An
 *     identity check would skip exactly that case and leave the capture deaf
 *     for the rest of the run. `off` before `on` keeps re-arming idempotent
 *     when the registry did survive.
 *  2. **Re-enable the CDP domain** on the replacement session. A fresh session
 *     starts with every domain disabled, so `Runtime` / `Network` / `Fetch`
 *     events would never be emitted for it.
 *
 * Wrapped rather than called directly so a duck-typed browser port (or a test
 * double) without the hook degrades to today's behaviour instead of throwing.
 */

import type { PlaywrightHandlerCtx } from './types.js';

type Browser = PlaywrightHandlerCtx['browser'];

// Derived from the handler context rather than imported from `cdp/` so this
// module stays inside the shell layer (see layer-stack import direction).
type CDPTransport = ReturnType<Browser['getTransport']>;
type CDPEventListener = Parameters<CDPTransport['on']>[1];

/** `(sessionId, transport, targetId)` — the replacement session for a tab. */
export type SessionReplacedListener = Parameters<Browser['onSessionReplaced']>[1];

/** One CDP event method and the listener that services it. */
export type CaptureListener = readonly [event: string, listener: CDPEventListener];

export interface TabCaptureOptions {
  browser: Browser;
  /** Tab whose session this capture follows. */
  targetId: string;
  /** Transport the capture starts on. */
  transport: CDPTransport;
  /** Session id the capture starts on. */
  sessionId: string;
  /** Event methods to keep registered across session replacements. */
  listeners: readonly CaptureListener[];
  /**
   * Re-enable the CDP domain(s) this capture needs on a replacement session.
   * Not called for the initial bind — the caller has already enabled the
   * domain inside its `withTab` before constructing the capture. Failures are
   * swallowed: a tab that closed under us must not reject anything here.
   */
  enable?: (transport: CDPTransport, sessionId: string) => Promise<unknown>;
  /**
   * Called once when re-enabling the domain on a replacement session failed
   * twice. The binding has already torn itself down (listeners removed, no
   * further replacements followed) so the owner can drop its registration
   * instead of reporting a capture that is silently inactive.
   */
  onDisarmed?: (error: unknown) => void;
}

export interface TabCaptureBinding {
  /**
   * Session id incoming events must match RIGHT NOW. Read it inside the
   * listener (not once at construction) so a replacement takes effect.
   */
  readonly sessionId: string;
  /** Transport the listeners are currently registered on. */
  readonly transport: CDPTransport;
  /** False once re-enabling failed and the binding tore itself down. */
  readonly armed: boolean;
  /** Remove the listeners and stop following session replacements. */
  stop(): void;
}

export function onSessionReplaced(
  browser: Browser,
  targetId: string,
  listener: SessionReplacedListener
): () => void {
  if (typeof browser.onSessionReplaced !== 'function') return () => undefined;
  return browser.onSessionReplaced(targetId, listener);
}

/**
 * Register `listeners` on `transport` and keep them — and the tab's enabled
 * CDP domains — bound to whatever session the tab has, across replacements.
 */
export function bindTabCapture(opts: TabCaptureOptions): TabCaptureBinding {
  const { browser, targetId, listeners, enable, onDisarmed } = opts;
  let activeTransport = opts.transport;
  let activeSessionId = opts.sessionId;
  let armed = true;

  const arm = (transport: CDPTransport): void => {
    for (const [event, listener] of listeners) {
      transport.off(event, listener);
      transport.on(event, listener);
    }
  };
  const disarm = (transport: CDPTransport): void => {
    for (const [event, listener] of listeners) transport.off(event, listener);
  };

  arm(activeTransport);

  // Re-enable on the replacement session: once, then one retry. A capture
  // whose domain could not be re-enabled must not look armed — `route` would
  // report a mock that lets every request through — so on the second failure
  // the binding tears itself down and tells its owner.
  const reenable = async (transport: CDPTransport, sessionId: string): Promise<void> => {
    if (!enable) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await enable(transport, sessionId);
        return;
      } catch (err) {
        lastError = err;
      }
      // The replacement may have been superseded meanwhile; stop retrying then.
      if (sessionId !== activeSessionId || !armed) return;
    }
    if (sessionId !== activeSessionId || !armed) return;
    armed = false;
    unsubscribeReplaced();
    disarm(activeTransport);
    onDisarmed?.(lastError);
  };

  const unsubscribeReplaced = onSessionReplaced(browser, targetId, (newSessionId, newTransport) => {
    if (!armed) return;
    if (newTransport !== activeTransport) disarm(activeTransport);
    activeTransport = newTransport;
    activeSessionId = newSessionId;
    arm(activeTransport);
    void reenable(activeTransport, activeSessionId);
  });

  return {
    get sessionId(): string {
      return activeSessionId;
    },
    get transport(): CDPTransport {
      return activeTransport;
    },
    get armed(): boolean {
      return armed;
    },
    stop(): void {
      armed = false;
      unsubscribeReplaced();
      disarm(activeTransport);
    },
  };
}
