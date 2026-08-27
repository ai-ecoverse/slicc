/**
 * The biscotto message gate — a guest's message is reviewed before the cone
 * ever sees it.
 *
 * Phase 1 gave a guest seat a narrow wire allowlist, but `user_message` passed
 * through it ungated: the text reached `onFollowerMessage` and was submitted
 * like any other. This module holds it instead, asks whoever the seat names as
 * approver, and forwards it only on an explicit allow.
 *
 * ## Fail-closed, everywhere
 *
 * Every way this can end without a human saying yes is a denial: timeout, no
 * approval surface configured, the guest disconnecting mid-review, a broker
 * that throws, a leader shutting down. `SudoDecision.reason` distinguishes
 * "nobody answered" from "someone refused" so the guest can be told the truth,
 * but both drop the message.
 *
 * ## Why it routes through sudo
 *
 * `LeaderSyncManagerOptions.requestSudoApproval` already owns the hard parts:
 * the kernel policy check, routing to whichever surface has a human (including
 * delegating to a phone), and `withApprovalTimeout`'s fail-closed settle. A
 * bespoke approval path would have to re-earn all of that. The one thing sudo
 * must NOT do here is persist an `always` — see the `guest-message` note on
 * `TraySudoKind` and the guard in `SudoManager.approve`.
 *
 * ## Ordering
 *
 * Reviews resolve in whatever order the human answers them, but a guest's
 * messages must reach the cone in the order they were sent — an approved
 * follow-up must not overtake the message it was following up on. Each seat
 * therefore has a serialized queue: one review in flight per seat, and an
 * approved message is delivered before the next one is even shown.
 */

import type { MessageAttachment } from '../../core/attachments.js';
import type { SudoDecision } from '../../sudo/types.js';
import type { FollowerBiscottoIdentity } from '../tray-sync-protocol.js';
import type { LeaderSyncContext } from './context.js';

/**
 * What the guest is told about its message.
 *
 * `rejected` means a human refused it; `unanswered` means nobody ever did —
 * a timeout, a missing approval surface, a broker error. Both drop the
 * message, but a guest that is told "refused" when in truth nobody was
 * looking will keep rephrasing at a wall.
 */
export type BiscottoMessageState = 'pending' | 'approved' | 'rejected' | 'unanswered';

/** How a review ENDED — every state except the transient one. */
export type BiscottoReviewOutcome = Exclude<BiscottoMessageState, 'pending'>;

export interface PendingGuestMessage {
  /** Which connected seat sent it; needed to attribute the delivered turn. */
  bootstrapId: string;
  messageId: string;
  text: string;
  attachments?: MessageAttachment[];
  steer?: boolean;
  biscotto: FollowerBiscottoIdentity;
}

export interface BiscottoReviewDeps {
  /**
   * Deliver an approved message. Same contract as the ungated path — the
   * gate decides IF, never WHAT.
   */
  deliver(message: PendingGuestMessage): void;
  /** Tell the guest where its message got to. */
  notify(bootstrapId: string, messageId: string, state: BiscottoMessageState): void;
}

export class BiscottoReview {
  /** One serialized queue per seat, keyed by bootstrapId. */
  private readonly queues = new Map<string, PendingGuestMessage[]>();
  /** Seats with a review currently on screen. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly deps: BiscottoReviewDeps
  ) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.handleFollowerRemoved(bootstrapId),
    });
  }

  /** Messages waiting on a human, across all seats (tests / diagnostics). */
  get pendingCount(): number {
    let total = this.inFlight.size;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /**
   * Gate one guest message.
   *
   * When the seat's message gate is `off` the message is delivered straight
   * through — that is the owner's explicit choice at mint time, and it is
   * scoped to the seat rather than to the sudoers table.
   */
  submit(bootstrapId: string, message: PendingGuestMessage): void {
    if (message.biscotto.gates.message.approver === 'off') {
      this.deps.deliver(message);
      this.deps.notify(bootstrapId, message.messageId, 'approved');
      return;
    }
    const queue = this.queues.get(bootstrapId) ?? [];
    queue.push(message);
    this.queues.set(bootstrapId, queue);
    this.deps.notify(bootstrapId, message.messageId, 'pending');
    void this.drain(bootstrapId);
  }

  /**
   * Run this seat's queue one message at a time.
   *
   * Serialized so an approved message is delivered before the next is shown:
   * reviewing in parallel would let a human answering out of order reorder the
   * guest's own messages on the way into the cone.
   */
  private async drain(bootstrapId: string): Promise<void> {
    if (this.inFlight.has(bootstrapId)) return;
    this.inFlight.add(bootstrapId);
    try {
      for (;;) {
        const queue = this.queues.get(bootstrapId);
        const next = queue?.shift();
        if (!next) break;
        if (queue?.length === 0) this.queues.delete(bootstrapId);
        const outcome = await this.review(bootstrapId, next);
        if (outcome === 'approved') this.deps.deliver(next);
        this.deps.notify(bootstrapId, next.messageId, outcome);
      }
    } finally {
      this.inFlight.delete(bootstrapId);
    }
  }

  private async review(
    bootstrapId: string,
    message: PendingGuestMessage
  ): Promise<BiscottoReviewOutcome> {
    const requestSudoApproval = this.context.options.requestSudoApproval;
    if (!requestSudoApproval) {
      // No approval surface wired means nobody CAN say yes. Delivering would
      // silently ungate every seat on a leader that simply has no broker.
      this.context.log.warn('No approval surface for a guest message — denying', {
        bootstrapId,
        biscottoId: message.biscotto.id,
      });
      return 'unanswered';
    }
    // A guest that vanished mid-queue gets nothing delivered on its behalf:
    // the human would be answering for a participant who is no longer there.
    if (!this.context.followers.followers.has(bootstrapId)) return 'unanswered';

    let decision: SudoDecision;
    try {
      decision = await requestSudoApproval({
        kind: 'guest-message',
        detail: message.text,
        followerLabel: describeSeat(message.biscotto),
      });
    } catch (err) {
      this.context.log.warn('Guest message approval threw — denying', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'unanswered';
    }

    // The guest may have left while the prompt was on screen. Its message is
    // still legitimate and the human still approved it, so it IS delivered —
    // dropping approved work because the sender closed a laptop would lose
    // real contributions. Only the notification has nowhere to go.
    if (decision.decision === 'deny') {
      return decision.reason ? 'unanswered' : 'rejected';
    }
    return 'approved';
  }

  /**
   * Drop everything queued for a seat that went away. Anything already in
   * flight is settled by its own broker timeout; this only clears the backlog
   * so a reconnecting guest does not find old messages replayed at the cone.
   */
  private handleFollowerRemoved(bootstrapId: string): void {
    const dropped = this.queues.get(bootstrapId)?.length ?? 0;
    if (dropped > 0) {
      this.context.log.info('Dropped queued guest messages for a departed seat', {
        bootstrapId,
        dropped,
      });
    }
    this.queues.delete(bootstrapId);
  }
}

/** How the seat is named on the approval prompt the owner sees. */
export function describeSeat(biscotto: FollowerBiscottoIdentity): string {
  const label = biscotto.label.trim();
  return label ? `biscotto “${label}”` : 'an unnamed biscotto';
}
