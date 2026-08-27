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

/**
 * Most messages one seat may have waiting on a human at once.
 *
 * A guest sends as fast as it likes while reviews serialize behind prompts that
 * can sit for minutes, and a single wire message may approach
 * `TRAY_MAX_MESSAGE_BYTES`. Unbounded, one guest exhausts the leader TAB's
 * memory — taking down the owner's session, not just its own.
 */
export const MAX_QUEUED_PER_SEAT = 8;

export class BiscottoReview {
  /** One serialized queue per seat, keyed by bootstrapId. */
  private readonly queues = new Map<string, PendingGuestMessage[]>();
  /** Seats with a review currently on screen. */
  private readonly inFlight = new Set<string>();
  /**
   * Bumped whenever a seat goes away. A review that resolves against a stale
   * epoch is discarded rather than delivered — see {@link handleFollowerRemoved}.
   */
  private readonly epochs = new Map<string, number>();

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
    // A guest never interrupts the owner's running turn. `steer` aborts work in
    // progress, and a reviewer approving the TEXT is not thereby approving an
    // interruption — the two are not visible as one decision. Stripped here so
    // no downstream caller can honour it; the message queues normally instead.
    const queued: PendingGuestMessage = { ...message, steer: false };

    if (queued.biscotto.gates.message.approver === 'off') {
      this.deps.deliver(queued);
      this.deps.notify(bootstrapId, queued.messageId, 'approved');
      return;
    }
    const queue = this.queues.get(bootstrapId) ?? [];
    if (queue.length >= MAX_QUEUED_PER_SEAT) {
      // Reported as `unanswered` rather than `rejected`: nobody refused this,
      // it was never put in front of anyone. Truthful, and it tells the guest
      // that retrying later may work.
      this.context.log.warn('Guest review queue full — dropping message', {
        bootstrapId,
        biscottoId: queued.biscotto.id,
        queued: queue.length,
      });
      this.deps.notify(bootstrapId, queued.messageId, 'unanswered');
      return;
    }
    queue.push(queued);
    this.queues.set(bootstrapId, queue);
    this.deps.notify(bootstrapId, queued.messageId, 'pending');
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
        const epoch = this.epochs.get(bootstrapId) ?? 0;
        const outcome = await this.review(bootstrapId, next);
        // The seat may have been REVOKED, expired or disconnected while the
        // prompt sat on screen. Delivering now would let a revoked guest still
        // reach the cone minutes later — the exact thing revocation exists to
        // stop — so a stale epoch discards the verdict, allow or not.
        if ((this.epochs.get(bootstrapId) ?? 0) !== epoch) {
          this.context.log.info('Discarding a review that outlived its seat', {
            bootstrapId,
            messageId: next.messageId,
            outcome,
          });
          break;
        }
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
        detail: describeGuestSubmission(message),
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
   * A seat went away — revoked, expired, disconnected, or the leader stopping.
   *
   * Clears the backlog AND bumps the epoch, which invalidates any review still
   * on screen. Clearing the queue alone was not enough: an `allow` arriving
   * after a revocation would still have delivered, so `biscotto revoke` would
   * have had a minutes-long tail during which the guest could still reach the
   * cone.
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
    this.epochs.set(bootstrapId, (this.epochs.get(bootstrapId) ?? 0) + 1);
  }
}

/**
 * Everything about a guest submission a reviewer must see to decide.
 *
 * Showing `text` alone was not enough: approval also delivers ATTACHMENTS,
 * whose content the reviewer never saw, so innocuous prose could carry a
 * hostile file past a human who believed they were approving one sentence.
 * Attachments are summarised by name and size — the reviewer at least knows
 * what is riding along, and how much of it.
 *
 * The attachment summary goes ABOVE the text and is the only part of this
 * string the guest does not control. The text is fenced so guest prose cannot
 * pass itself off as that summary.
 */
export function describeGuestSubmission(message: PendingGuestMessage): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return message.text;
  const summary = attachments
    .map((attachment, index) => `  ${index + 1}. ${describeAttachment(attachment)}`)
    .join('\n');
  return [
    `Attachments delivered with this message (${attachments.length}):`,
    summary,
    '',
    '--- message text ---',
    message.text,
  ].join('\n');
}

function describeAttachment(attachment: MessageAttachment): string {
  // Names are guest-chosen; flatten so one cannot forge extra summary rows or
  // a fake "--- message text ---" divider.
  const flat = (attachment.name || 'unnamed')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening is the point.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${flat.slice(0, 120) || 'unnamed'} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes)`;
}

/** How the seat is named on the approval prompt the owner sees. */
export function describeSeat(biscotto: FollowerBiscottoIdentity): string {
  const label = biscotto.label.trim();
  return label ? `biscotto “${label}”` : 'an unnamed biscotto';
}
