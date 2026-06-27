/**
 * Worker-realm rendezvous for the lick-back channel. Two worker-side modules
 * need to meet but are constructed independently and in an undefined order:
 *
 *   - the `/licks-ws` bridge (`host.ts`) owns the socket to the node-server — it
 *     registers the outbound push and delivers inbound replies;
 *   - the `OffscreenBridge` posts to the page — it registers the page-ward reply
 *     forwarder and pushes browser-originated outbound events.
 *
 * Both resolve the SAME singleton via {@link getLickbackChannel} (memoized on
 * `globalThis`, mirroring `__slicc_lickManager`), so whichever boots first
 * creates it and wiring is order-independent — a reply handler registered before
 * the socket push impl still fires once the bridge delivers.
 *
 * Parity: N/A — substrate is standalone-only; the extension float has no
 * node-server, so the push impl is never registered there and `push`/
 * `deliverReply` stay inert (spec §11).
 */
// tva

/** A streamed reply frame from the external brain (mirror of the node-server
 *  `/api/lickback/reply` body, sans the `type` tag). */
export interface LickbackReplyFrame {
  channel: string;
  replyTo: string;
  delta?: string;
  text?: string;
  done?: boolean;
}

export interface LickbackWorkerChannel {
  /** The `/licks-ws` bridge registers the socket push here (null clears it on stop). */
  setPushImpl(fn: ((channel: string, event: unknown) => void) | null): void;
  /** Push a browser-originated outbound event toward the node-server. No-op
   *  until a push impl is registered (e.g. socket not yet up). */
  push(channel: string, event: unknown): void;
  /** The OffscreenBridge registers the page-ward reply forwarder (null clears it). */
  setReplyHandler(fn: ((reply: LickbackReplyFrame) => void) | null): void;
  /** The `/licks-ws` bridge delivers an inbound reply from the node-server. */
  deliverReply(reply: LickbackReplyFrame): void;
}

class LickbackChannelImpl implements LickbackWorkerChannel {
  private pushImpl: ((channel: string, event: unknown) => void) | null = null;
  private replyHandler: ((reply: LickbackReplyFrame) => void) | null = null;

  setPushImpl(fn: ((channel: string, event: unknown) => void) | null): void {
    this.pushImpl = fn;
  }
  push(channel: string, event: unknown): void {
    this.pushImpl?.(channel, event);
  }
  setReplyHandler(fn: ((reply: LickbackReplyFrame) => void) | null): void {
    this.replyHandler = fn;
  }
  deliverReply(reply: LickbackReplyFrame): void {
    this.replyHandler?.(reply);
  }
}

const KEY = '__slicc_lickbackChannel';

export function getLickbackChannel(): LickbackWorkerChannel {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new LickbackChannelImpl();
  return g[KEY] as LickbackWorkerChannel;
}

/** Test-only: drop the singleton so each test starts from a clean channel. */
export function __resetLickbackChannel(): void {
  delete (globalThis as Record<string, unknown>)[KEY];
}
