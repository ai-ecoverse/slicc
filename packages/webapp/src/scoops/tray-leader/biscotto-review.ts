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
import type { SudoApproverDirective, SudoDecision, TurnGuestGate } from '../../sudo/types.js';
import type { FollowerBiscottoGate, FollowerBiscottoIdentity } from '../tray-sync-protocol.js';
import { toolGateForSeat } from './biscotto-gate.js';
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

/**
 * What the wire dispatcher hands in — the guest's message and nothing derived.
 * Everything the gate decides (which unit it is bound to, which tool gate
 * applies) is computed by {@link BiscottoReview.submit}, so a caller cannot
 * supply it and cannot get it wrong.
 */
export interface GuestSubmission {
  bootstrapId: string;
  messageId: string;
  text: string;
  attachments?: MessageAttachment[];
  steer?: boolean;
  biscotto: FollowerBiscottoIdentity;
}

/** A submission the gate has bound to a unit and a tool gate. */
export interface PendingGuestMessage extends GuestSubmission {
  /** Which connected seat sent it; needed to attribute the delivered turn. */
  /**
   * Tool gate for the turn this message starts. Resolved at SUBMIT time, not
   * at delivery: it names a unit, and the owner can switch units while a review
   * sits on screen.
   */
  toolGate?: TurnGuestGate;
  /**
   * The unit that was active when the guest sent this. Everything about the
   * message is bound to it, and delivery refuses if the owner has since moved
   * on — an approved message landing in a different conversation is not the
   * message anyone approved.
   */
  unitJid: string;
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
   * Bumped whenever a connection for a seat goes away. A review that resolves
   * against a stale epoch is discarded rather than delivered — see
   * {@link handleFollowerRemoved}.
   */
  private readonly epochs = new Map<string, number>();
  /**
   * Which seat each live connection belongs to.
   *
   * `handleFollowerRemoved` is called AFTER the registry entry is gone, so the
   * seat cannot be looked up from the follower by then — this is the only way
   * back from a connection to the queue it was feeding.
   */
  private readonly seatByBootstrap = new Map<string, string>();

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
  /**
   * The key everything is bucketed under: the SEAT, not the connection.
   *
   * One guest URL opened in three tabs is three connections but one seat. Keyed
   * by connection, each tab got its own queue — so the per-seat message bound
   * multiplied by the number of tabs, and reviews from the same guest ran
   * concurrently and could be delivered out of order.
   */
  private seatKey(message: PendingGuestMessage): string {
    return message.biscotto.id;
  }

  submit(bootstrapId: string, message: GuestSubmission): void {
    // A guest never interrupts the owner's running turn. `steer` aborts work in
    // progress, and a reviewer approving the TEXT is not thereby approving an
    // interruption — the two are not visible as one decision. Stripped here so
    // no downstream caller can honour it; the message queues normally instead.
    const unitJid = this.context.options.getScoopJid();
    const toolGate = toolGateForSeat(message.biscotto, unitJid);
    if (toolGate === null) {
      // The seat configures tool gating this leader cannot route to its named
      // approver. Delivering the message would start a turn whose tool calls
      // cannot be reviewed by the principal the owner chose, so the message
      // itself is refused. Reported as `rejected` — the host's configuration
      // genuinely did not forward it, which is what the guest is told.
      this.context.log.warn('Seat has unroutable tool gating — refusing its message', {
        bootstrapId,
        biscottoId: message.biscotto.id,
      });
      this.deps.notify(bootstrapId, message.messageId, 'rejected');
      return;
    }
    const queued: PendingGuestMessage = { ...message, steer: false, unitJid, toolGate };

    if (queued.biscotto.gates.message.approver === 'off') {
      // An ungated MESSAGE still gets a gated TURN when the seat says so — the
      // two gates are independent by design.
      this.deps.deliver(queued);
      this.deps.notify(bootstrapId, queued.messageId, 'approved');
      return;
    }
    const seat = this.seatKey(queued);
    this.seatByBootstrap.set(bootstrapId, seat);
    const queue = this.queues.get(seat) ?? [];
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
    this.queues.set(seat, queue);
    this.deps.notify(bootstrapId, queued.messageId, 'pending');
    void this.drain(seat);
  }

  /**
   * Run this seat's queue one message at a time.
   *
   * Serialized so an approved message is delivered before the next is shown:
   * reviewing in parallel would let a human answering out of order reorder the
   * guest's own messages on the way into the cone.
   */
  private async drain(seat: string): Promise<void> {
    if (this.inFlight.has(seat)) return;
    this.inFlight.add(seat);
    try {
      for (;;) {
        const queue = this.queues.get(seat);
        const next = queue?.shift();
        if (!next) break;
        if (queue?.length === 0) this.queues.delete(seat);
        const bootstrapId = next.bootstrapId;
        const epoch = this.epochs.get(seat) ?? 0;
        const outcome = await this.review(bootstrapId, next);
        // The seat may have been REVOKED, expired or disconnected while the
        // prompt sat on screen. Delivering now would let a revoked guest still
        // reach the cone minutes later — the exact thing revocation exists to
        // stop — so a stale epoch discards the verdict, allow or not.
        if ((this.epochs.get(seat) ?? 0) !== epoch) {
          this.context.log.info('Discarding a review that outlived its seat', {
            bootstrapId,
            messageId: next.messageId,
            outcome,
          });
          // Do NOT stop draining. A seat that reconnects on the same
          // `bootstrapId` may already have queued fresh messages behind this
          // discarded one; breaking here cleared `inFlight` with a non-empty
          // queue, so those sat pending forever unless a later submit happened
          // to restart the loop. Skip the stale verdict and keep going.
          continue;
        }
        if (outcome === 'approved') {
          // The owner may have switched units while this sat on screen. The
          // message, its tool gate and its approver were all bound to the unit
          // that was active when the guest sent it; delivering into a different
          // conversation is not the message anyone approved.
          const current = this.context.options.getScoopJid();
          if (current !== next.unitJid) {
            this.context.log.warn('Selected unit changed during review — not delivering', {
              submittedFor: next.unitJid,
              current,
            });
            this.deps.notify(bootstrapId, next.messageId, 'rejected');
            continue;
          }
          this.deps.deliver(next);
        }
        this.deps.notify(bootstrapId, next.messageId, outcome);
      }
    } finally {
      this.inFlight.delete(seat);
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

    const directive = this.approverDirective(message.biscotto.gates.message, message.unitJid);
    if (directive === null) {
      // The seat names an approver this leader cannot route to. Denying is the
      // only safe reading — the alternative is quietly downgrading to a
      // different approver than the owner configured.
      this.context.log.warn('Unroutable approver on a guest seat — denying', {
        bootstrapId,
        approver: message.biscotto.gates.message.approver,
      });
      return 'unanswered';
    }

    let decision: SudoDecision;
    try {
      decision = await requestSudoApproval({
        kind: 'guest-message',
        detail: describeGuestSubmission(message),
        followerLabel: describeSeat(message.biscotto),
        // From the seat record the hub stamped — never from anything the guest
        // sent. A guest that could name its own approver would name itself.
        ...(directive ? { approver: directive } : {}),
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
   * Translate a seat's configured gate into a routing directive.
   *
   * `undefined` means "the owner's own broker" (the `user` tier, and the
   * historical path). `null` means the tier cannot be routed from here and the
   * caller must DENY — never silently fall back to a different approver than
   * the owner chose, which is exactly what routing `cone` to the human broker
   * was doing.
   */
  private approverDirective(
    gate: FollowerBiscottoGate,
    unitJid: string
  ): SudoApproverDirective | undefined | null {
    switch (gate.approver) {
      case 'user':
        return undefined;
      case 'cone':
        return { kind: 'cone', unitJid };
      case 'agent':
        return { kind: 'agent', unitJid };
      case 'scoop':
        return gate.scoop ? { kind: 'scoop', scoopName: gate.scoop, unitJid } : null;
      default:
        // `off` never reaches a review; anything else is a seat written by a
        // newer build than this leader speaks.
        return null;
    }
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
    const seat = this.seatByBootstrap.get(bootstrapId);
    this.seatByBootstrap.delete(bootstrapId);
    if (!seat) return;
    const dropped = this.queues.get(seat)?.length ?? 0;
    if (dropped > 0) {
      this.context.log.info('Dropped queued guest messages for a departed seat', {
        bootstrapId,
        seat,
        dropped,
      });
    }
    this.queues.delete(seat);
    // Epoch is per SEAT, so a revocation — which closes every peer holding the
    // seat — invalidates whatever was on screen for any of them. One tab of a
    // multi-tab guest closing also invalidates the seat's pending review, which
    // is stricter than strictly necessary and the right way to be wrong.
    this.epochs.set(seat, (this.epochs.get(seat) ?? 0) + 1);
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
export function describeGuestSubmission(message: GuestSubmission): string {
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
