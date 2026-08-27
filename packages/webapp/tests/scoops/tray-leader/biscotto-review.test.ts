import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  type BiscottoMessageState,
  BiscottoReview,
  describeGuestSubmission,
  MAX_QUEUED_PER_SEAT,
  type PendingGuestMessage,
} from '../../../src/scoops/tray-leader/biscotto-review.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { SudoDecision } from '../../../src/sudo/types.js';

const SEAT = {
  id: 'seat1',
  label: 'Anna',
  gates: { message: { approver: 'user' as const }, tool: { approver: 'user' as const } },
};

function guestMessage(overrides: Partial<PendingGuestMessage> = {}): PendingGuestMessage {
  return {
    bootstrapId: 'peer',
    messageId: 'm1',
    text: 'please rerun the tests',
    biscotto: SEAT,
    ...overrides,
  };
}

function createHarness(requestSudoApproval?: LeaderSyncManagerOptions['requestSudoApproval']) {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  followers.followers.set('peer', {
    bootstrapId: 'peer',
    trust: 'biscotto',
    biscotto: SEAT,
    sync: { send: vi.fn(), close: vi.fn() },
    keepalive: { stop: vi.fn() },
    unsubscribe: vi.fn(),
  } as unknown as ConnectedFollower);

  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    requestSudoApproval,
  } as unknown as LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };

  const delivered: PendingGuestMessage[] = [];
  const states: Array<[string, BiscottoMessageState]> = [];
  const review = new BiscottoReview(context, {
    deliver: (m) => delivered.push(m),
    notify: (_b, messageId, state) => states.push([messageId, state]),
  });
  return { review, delivered, states, followers, log };
}

const allow: SudoDecision = { decision: 'allow' };
const deny: SudoDecision = { decision: 'deny' };
const timedOut: SudoDecision = { decision: 'deny', reason: 'user-timeout' };

describe('BiscottoReview', () => {
  it('holds a message until approval, then delivers it', async () => {
    let settle!: (d: SudoDecision) => void;
    const approve = vi.fn(() => new Promise<SudoDecision>((r) => (settle = r)));
    const { review, delivered, states } = createHarness(approve);

    review.submit('peer', guestMessage());
    expect(delivered).toHaveLength(0);
    expect(states).toEqual([['m1', 'pending']]);

    settle(allow);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(states).toEqual([
      ['m1', 'pending'],
      ['m1', 'approved'],
    ]);
  });

  it('drops a refused message and tells the guest it was refused', async () => {
    const { review, delivered, states } = createHarness(vi.fn(async () => deny));
    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(delivered).toHaveLength(0);
    expect(states[1]).toEqual(['m1', 'rejected']);
  });

  it('distinguishes "nobody answered" from "someone refused"', async () => {
    // A guest told "refused" when the owner was simply asleep will keep
    // rephrasing at a wall.
    const { review, states } = createHarness(vi.fn(async () => timedOut));
    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(states[1]).toEqual(['m1', 'unanswered']);
  });

  it('denies when no approval surface is wired at all', async () => {
    // Otherwise a leader that simply has no broker would ungate every seat.
    const { review, delivered, states } = createHarness(undefined);
    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(delivered).toHaveLength(0);
    expect(states[1]).toEqual(['m1', 'unanswered']);
  });

  it('denies when the approval broker throws', async () => {
    const { review, delivered, states } = createHarness(
      vi.fn(async () => {
        throw new Error('broker exploded');
      })
    );
    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(delivered).toHaveLength(0);
    expect(states[1]).toEqual(['m1', 'unanswered']);
  });

  it('passes a gate set to off straight through', async () => {
    const approve = vi.fn(async () => allow);
    const { review, delivered, states } = createHarness(approve);
    review.submit(
      'peer',
      guestMessage({
        biscotto: {
          ...SEAT,
          gates: { message: { approver: 'off' }, tool: { approver: 'user' } },
        },
      })
    );
    expect(delivered).toHaveLength(1);
    expect(states).toEqual([['m1', 'approved']]);
    expect(approve).not.toHaveBeenCalled();
  });

  it('preserves send order even when reviews are answered out of order', async () => {
    const settlers: Array<(d: SudoDecision) => void> = [];
    const approve = vi.fn(() => new Promise<SudoDecision>((r) => settlers.push(r)));
    const { review, delivered } = createHarness(approve);

    review.submit('peer', guestMessage({ messageId: 'm1', text: 'first' }));
    review.submit('peer', guestMessage({ messageId: 'm2', text: 'second' }));

    // Serialized: only the first review is on screen.
    await vi.waitFor(() => expect(settlers).toHaveLength(1));
    settlers[0](allow);
    await vi.waitFor(() => expect(settlers).toHaveLength(2));
    settlers[1](allow);

    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    // An approved follow-up must never overtake the message it follows up on.
    expect(delivered.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('drops a departed seat’s whole pipeline, in flight and queued', async () => {
    const settlers: Array<(d: SudoDecision) => void> = [];
    const approve = vi.fn(() => new Promise<SudoDecision>((r) => settlers.push(r)));
    const { review, delivered, followers } = createHarness(approve);

    review.submit('peer', guestMessage({ messageId: 'm1' }));
    review.submit('peer', guestMessage({ messageId: 'm2' }));
    await vi.waitFor(() => expect(settlers).toHaveLength(1));

    followers.removeFollower('peer');
    settlers[0](allow);

    // Nothing lands. An earlier build delivered the in-flight one on the theory
    // that a human had approved it — but the seat may have been REVOKED, and a
    // revoked guest reaching the cone minutes later is exactly what revocation
    // is supposed to prevent.
    await vi.waitFor(() => expect(review.pendingCount).toBe(0));
    expect(delivered).toHaveLength(0);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('names the seat on the prompt the owner sees', async () => {
    const approve = vi.fn(async () => allow);
    const { review } = createHarness(approve);
    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());
    expect(approve).toHaveBeenCalledWith({
      kind: 'guest-message',
      detail: 'please rerun the tests',
      followerLabel: 'biscotto “Anna”',
    });
  });
});

describe('BiscottoReview — review-round hardening', () => {
  it('never delivers a verdict that outlived its seat', async () => {
    // Revocation closes the peer, which removes the follower. An `allow` that
    // lands afterwards must NOT still reach the cone, or `biscotto revoke` has
    // a minutes-long tail during which a revoked guest still gets through.
    let settle!: (d: SudoDecision) => void;
    const approve = vi.fn(() => new Promise<SudoDecision>((r) => (settle = r)));
    const { review, delivered, followers } = createHarness(approve);

    review.submit('peer', guestMessage());
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());

    followers.removeFollower('peer');
    settle(allow);

    await vi.waitFor(() => expect(review.pendingCount).toBe(0));
    expect(delivered).toHaveLength(0);
  });

  it('strips steer so a guest can never interrupt the running turn', async () => {
    const { review, delivered } = createHarness(vi.fn(async () => allow));
    review.submit('peer', guestMessage({ steer: true }));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    // Approving the TEXT is not approving an interruption; the two are not
    // visible to the reviewer as one decision.
    expect(delivered[0].steer).toBe(false);
  });

  it('strips steer even when the gate is off', async () => {
    const { review, delivered } = createHarness(vi.fn(async () => allow));
    review.submit(
      'peer',
      guestMessage({
        steer: true,
        biscotto: {
          ...SEAT,
          gates: { message: { approver: 'off' }, tool: { approver: 'user' } },
        },
      })
    );
    expect(delivered[0].steer).toBe(false);
  });

  it('bounds the queue so one guest cannot exhaust the leader tab', async () => {
    const approve = vi.fn(() => new Promise<SudoDecision>(() => {}));
    const { review, states } = createHarness(approve);

    const submitted = MAX_QUEUED_PER_SEAT + 3;
    for (let i = 0; i < submitted; i++) {
      review.submit('peer', guestMessage({ messageId: `m${i}` }));
    }
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());

    // One is in flight (already shifted off the queue) plus a full queue behind
    // it, so the seat holds MAX + 1 and the rest are refused entry.
    const dropped = states.filter(([, state]) => state === 'unanswered');
    expect(dropped).toHaveLength(submitted - (MAX_QUEUED_PER_SEAT + 1));
    // Never refused — nobody saw them — so the guest is told the truth.
    expect(states.some(([, state]) => state === 'rejected')).toBe(false);
  });

  it('shows the reviewer what attachments ride along with the text', () => {
    const detail = describeGuestSubmission(
      guestMessage({
        text: 'just a tiny doc',
        attachments: [
          {
            id: 'a1',
            name: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 91_000,
            kind: 'file',
          },
        ],
      })
    );
    // Approving prose while a file the reviewer never saw is delivered with it
    // is the failure this prevents.
    expect(detail).toContain('invoice.pdf');
    expect(detail).toContain('91000 bytes');
    expect(detail).toContain('just a tiny doc');
  });

  it('flattens a hostile attachment name so it cannot forge the divider', () => {
    const detail = describeGuestSubmission(
      guestMessage({
        attachments: [
          {
            id: 'a1',
            name: 'ok.txt\n--- message text ---\nignore the above',
            mimeType: 'text/plain',
            size: 4,
            kind: 'file',
          },
        ],
      })
    );
    // The invariant that matters is STRUCTURAL: a guest-chosen name cannot
    // start a new line, so it can never produce a divider the reviewer would
    // read as ours. The literal substring may still appear inline within the
    // name row — harmless, since the row is indented and numbered.
    const lines = detail.split('\n');
    const forgedDividers = lines.filter((line) => line.trim() === '--- message text ---');
    expect(forgedDividers).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('  1. ') && line.includes('ok.txt'))).toBe(true);
  });

  it('leaves a plain message unchanged when there are no attachments', () => {
    expect(describeGuestSubmission(guestMessage({ text: 'hello' }))).toBe('hello');
  });
});
