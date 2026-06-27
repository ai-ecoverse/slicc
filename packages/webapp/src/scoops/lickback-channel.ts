/**
 * LickbackAgentHandle — the page-side `AgentHandle` that drives the chat panel
 * from an EXTERNAL Claude brain over the lick-back wire, the same seam tray
 * followers use to drive the panel from a remote leader
 * (`WcChatController.setAgent`). In cup mode the webapp runs no internal
 * cone, so the chat panel is a dead socket ("No scoop selected"); this handle
 * fills it.
 *
 * - `sendMessage` emits a `chat` push (page → worker → `/licks-ws` → node-server
 *   → the claimed orchestrator session).
 * - inbound `lickback-reply` frames (the brain's streamed reply) translate into
 *   the panel's existing streaming AgentEvents:
 *   `message_start → content_delta* → content_done → turn_end`.
 *
 * Transport is provided by {@link LickbackClient} (a slice of `OffscreenClient`)
 * so the page→worker hop stays out of this state machine and the handle is
 * unit-testable with a plain fake.
 *
 * Parity: N/A — cup is standalone-only (spec §11).
 */
// tva
import type { MessageAttachment } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { AgentEvent, AgentHandle } from '../ui/types.js';
import type { LickbackReplyFrame } from './lickback-worker-channel.js';

const log = createLogger('lickback-channel');

/** The MVP ships a single channel; the wire carries it so more slot in later. */
const CHANNEL = 'chat';

/** The page-side transport the handle drives — a slice of `OffscreenClient`. */
export interface LickbackClient {
  /** Push a browser-originated outbound event to the worker (→ node-server). */
  sendLickbackEvent(channel: string, event: unknown): void;
  /** Register (or clear) the inbound `lickback-reply` handler. */
  setLickbackReplyHandler(handler: ((reply: LickbackReplyFrame) => void) | null): void;
}

function uid(): string {
  return `lb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LickbackAgentHandle implements AgentHandle {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  /** Assistant message id for the in-flight reply turn, or null between turns. */
  private streamMsgId: string | null = null;
  /** The user msgId the in-flight reply answers — guards turn boundaries. */
  private streamReplyTo: string | null = null;

  constructor(private readonly client: LickbackClient) {
    client.setLickbackReplyHandler((reply) => this.handleReply(reply));
  }

  // ---------------------------------------------------------------------------
  // AgentHandle
  // ---------------------------------------------------------------------------

  sendMessage(text: string, messageId?: string, _attachments?: MessageAttachment[]): void {
    const msgId = messageId ?? uid();
    // Attachments are not carried over the lick-back wire in the MVP — the
    // external brain has no path to the page's VFS blobs. Chat text only; the
    // local user bubble (rendered by the controller before this call) is free.
    this.client.sendLickbackEvent(CHANNEL, { kind: 'chat', text, msgId });
    // Open the reply turn OPTIMISTICALLY so the panel enters its "working"
    // state (the composer's send arrow flips to a stop control) for the whole
    // round-trip to the external brain. A local cone emits `message_start`
    // itself and a tray follower gets the leader's `status:processing`
    // broadcast — but the brain sends nothing until it has content, so without
    // this the spinner would never appear and `stop()` would have no in-flight
    // turn to cancel (the bug this fixes). The brain's reply frames reuse this
    // bubble (same `replyTo`). Guarded so a second send mid-turn doesn't open a
    // duplicate; that message's reply (a different `replyTo`) rotates the turn
    // via `handleReply`'s boundary guard.
    if (!this.streamMsgId) {
      this.streamMsgId = uid();
      this.streamReplyTo = msgId;
      this.emit({ type: 'message_start', messageId: this.streamMsgId });
    }
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  stop(): void {
    // The MVP has no abort path to the external brain. Finalize any in-flight
    // reply locally so the panel's "working" spinner clears rather than hangs.
    this.finalizeTurn();
  }

  /** Detach from the transport (called when the handle is swapped out). */
  dispose(): void {
    this.client.setLickbackReplyHandler(null);
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Inbound reply → AgentEvent state machine
  // ---------------------------------------------------------------------------

  private handleReply(reply: LickbackReplyFrame): void {
    if (reply.channel !== CHANNEL) return;
    // A frame for a different user turn than the one in flight closes the old
    // turn first — the brain shouldn't interleave, but a stream must never be
    // left stranded (which would pin the panel spinner forever).
    if (this.streamMsgId && this.streamReplyTo !== reply.replyTo) {
      this.finalizeTurn();
    }
    let msgId = this.streamMsgId;
    if (!msgId) {
      msgId = uid();
      this.streamMsgId = msgId;
      this.streamReplyTo = reply.replyTo;
      this.emit({ type: 'message_start', messageId: msgId });
    }
    // A delta frame carries an incremental chunk; a one-shot reply carries the
    // whole text. Either way it is appended to the active assistant bubble.
    const chunk =
      typeof reply.delta === 'string' && reply.delta
        ? reply.delta
        : typeof reply.text === 'string' && reply.text
          ? reply.text
          : '';
    if (chunk) this.emit({ type: 'content_delta', messageId: msgId, text: chunk });
    if (reply.done) this.finalizeTurn();
  }

  private finalizeTurn(): void {
    const msgId = this.streamMsgId;
    if (!msgId) return;
    this.streamMsgId = null;
    this.streamReplyTo = null;
    this.emit({ type: 'content_done', messageId: msgId });
    this.emit({ type: 'turn_end', messageId: msgId });
  }

  private emit(event: AgentEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Lickback listener error', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
