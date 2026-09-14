import type { PlaywrightHandlerCtx } from './types.js';

type Browser = PlaywrightHandlerCtx['browser'];

type CDPTransport = ReturnType<Browser['getTransport']>;
type CDPEventListener = Parameters<CDPTransport['on']>[1];

export type SessionReplacedListener = Parameters<Browser['onSessionReplaced']>[1];

export type CaptureListener = readonly [event: string, listener: CDPEventListener];

export interface TabCaptureOptions {
  browser: Browser;

  targetId: string;

  transport: CDPTransport;

  sessionId: string;

  listeners: readonly CaptureListener[];

  enable?: (transport: CDPTransport, sessionId: string) => Promise<unknown>;
}

export interface TabCaptureBinding {
  readonly sessionId: string;

  readonly transport: CDPTransport;

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

export function bindTabCapture(opts: TabCaptureOptions): TabCaptureBinding {
  const { browser, targetId, listeners, enable } = opts;
  let activeTransport = opts.transport;
  let activeSessionId = opts.sessionId;

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

  const unsubscribeReplaced = onSessionReplaced(browser, targetId, (newSessionId, newTransport) => {
    if (newTransport !== activeTransport) disarm(activeTransport);
    activeTransport = newTransport;
    activeSessionId = newSessionId;
    arm(activeTransport);
    if (!enable) return;
    try {
      void Promise.resolve(enable(activeTransport, activeSessionId)).catch(() => undefined);
    } catch {}
  });

  return {
    get sessionId(): string {
      return activeSessionId;
    },
    get transport(): CDPTransport {
      return activeTransport;
    },
    stop(): void {
      unsubscribeReplaced();
      disarm(activeTransport);
    },
  };
}
