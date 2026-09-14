import type { MessageAttachment } from '../../core/attachments.js';
import type { SudoApproverDirective, SudoDecision, TurnGuestGate } from '../../sudo/types.js';
import type { FollowerBiscottoGate, FollowerBiscottoIdentity } from '../tray-sync-protocol.js';
import { toolGateForSeat } from './biscotto-gate.js';
import type { LeaderSyncContext } from './context.js';

export type BiscottoMessageState = 'pending' | 'approved' | 'rejected' | 'unanswered';

export type BiscottoReviewOutcome = Exclude<BiscottoMessageState, 'pending'>;

export interface GuestSubmission {
  bootstrapId: string;
  messageId: string;
  text: string;
  attachments?: MessageAttachment[];
  steer?: boolean;
  biscotto: FollowerBiscottoIdentity;
}

export interface PendingGuestMessage extends GuestSubmission {
  toolGate?: TurnGuestGate;

  unitJid: string;
}

export interface BiscottoReviewDeps {
  deliver(message: PendingGuestMessage): void;

  notify(bootstrapId: string, messageId: string, state: BiscottoMessageState): void;
}

export const MAX_QUEUED_PER_SEAT = 8;

export class BiscottoReview {
  private readonly queues = new Map<string, PendingGuestMessage[]>();

  private readonly inFlight = new Set<string>();

  private readonly epochs = new Map<string, number>();

  private readonly seatByBootstrap = new Map<string, string>();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly deps: BiscottoReviewDeps
  ) {
    context.followers.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) => this.handleFollowerRemoved(bootstrapId),
    });
  }

  get pendingCount(): number {
    let total = this.inFlight.size;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  private seatKey(message: PendingGuestMessage): string {
    return message.biscotto.id;
  }

  submit(bootstrapId: string, message: GuestSubmission): void {
    const unitJid = this.context.options.getScoopJid();
    const toolGate = toolGateForSeat(message.biscotto, unitJid);
    if (toolGate === null) {
      this.context.log.warn('Seat has unroutable tool gating — refusing its message', {
        bootstrapId,
        biscottoId: message.biscotto.id,
      });
      this.deps.notify(bootstrapId, message.messageId, 'rejected');
      return;
    }
    const queued: PendingGuestMessage = { ...message, steer: false, unitJid, toolGate };

    if (queued.biscotto.gates.message.approver === 'off') {
      this.deps.deliver(queued);
      this.deps.notify(bootstrapId, queued.messageId, 'approved');
      return;
    }
    const seat = this.seatKey(queued);
    this.seatByBootstrap.set(bootstrapId, seat);
    const queue = this.queues.get(seat) ?? [];
    if (queue.length >= MAX_QUEUED_PER_SEAT) {
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

        if ((this.epochs.get(seat) ?? 0) !== epoch) {
          this.context.log.info('Discarding a review that outlived its seat', {
            bootstrapId,
            messageId: next.messageId,
            outcome,
          });

          continue;
        }
        if (outcome === 'approved') {
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
      this.context.log.warn('No approval surface for a guest message — denying', {
        bootstrapId,
        biscottoId: message.biscotto.id,
      });
      return 'unanswered';
    }

    if (!this.context.followers.followers.has(bootstrapId)) return 'unanswered';

    const directive = this.approverDirective(message.biscotto.gates.message, message.unitJid);
    if (directive === null) {
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

        ...(directive ? { approver: directive } : {}),
      });
    } catch (err) {
      this.context.log.warn('Guest message approval threw — denying', {
        bootstrapId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'unanswered';
    }

    if (decision.decision === 'deny') {
      return decision.reason ? 'unanswered' : 'rejected';
    }
    return 'approved';
  }

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
        return null;
    }
  }

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

    this.epochs.set(seat, (this.epochs.get(seat) ?? 0) + 1);
  }
}

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
  const flat = (attachment.name || 'unnamed')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening is the point.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${flat.slice(0, 120) || 'unnamed'} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes)`;
}

export function describeSeat(biscotto: FollowerBiscottoIdentity): string {
  const label = biscotto.label.trim();
  return label ? `biscotto “${label}”` : 'an unnamed biscotto';
}
