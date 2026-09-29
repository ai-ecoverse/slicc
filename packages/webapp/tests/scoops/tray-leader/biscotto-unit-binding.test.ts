import type { FollowerBiscottoIdentity } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { ChatMessage } from '../../../src/scoops/chat-types.js';
import {
  type BiscottoMessageState,
  BiscottoReview,
  type PendingGuestMessage,
} from '../../../src/scoops/tray-leader/biscotto-review.js';
import { BroadcastManager } from '../../../src/scoops/tray-leader/broadcast.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import { FollowerRegistry } from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';
import type { SudoDecision } from '../../../src/sudo/types.js';

const SEAT: FollowerBiscottoIdentity = {
  id: 'seat1',
  label: 'blog-review-guest',
  unitJid: 'helix',
  gates: { message: { approver: 'user' }, tool: { approver: 'user' } },
};

const TRANSCRIPTS: Record<string, ChatMessage[]> = {
  helix: [{ id: 'h1', role: 'user', content: 'HELIX-THREAD', timestamp: 1 }],
  sliccy: [{ id: 's1', role: 'user', content: 'SLICCY-PRIVATE', timestamp: 1 }],
};

function channel(): TrayDataChannelLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    readyState: 'open',
    send: (data: string) => sent.push(data),
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
  } as unknown as TrayDataChannelLike & { sent: string[] };
}

function harness(opts: { seat?: FollowerBiscottoIdentity; displayed?: string } = {}) {
  const displayed = { jid: opts.displayed ?? 'sliccy' };
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const requestSudoApproval = vi.fn(async (): Promise<SudoDecision> => ({ decision: 'allow' }));
  const options = {
    getScoopJid: () => displayed.jid,
    getMessages: () => TRANSCRIPTS[displayed.jid] ?? [],
    getMessagesForScoop: vi.fn(async (jid: string) => TRANSCRIPTS[jid] ?? []),
    getScoops: () => [
      { jid: 'helix', name: 'helix', parentId: null },
      { jid: 'sliccy', name: 'sliccy', parentId: null },
      { jid: 'scoop_reviewer', name: 'reviewer', parentId: 'helix' },
    ],
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    requestSudoApproval,
  } as unknown as LeaderSyncManagerOptions;
  const context: LeaderSyncContext = { options, followers, log, sendControl: options.sendControl };
  const guest = channel();
  const seat = opts.seat ?? SEAT;
  followers.addFollower('guest', guest, { trust: 'biscotto', biscotto: seat });
  const delivered: PendingGuestMessage[] = [];
  const states: Array<[string, BiscottoMessageState]> = [];
  const review = new BiscottoReview(context, {
    deliver: (m) => delivered.push(m),
    notify: (_b, messageId, state) => states.push([messageId, state]),
  });
  const stop = () => {
    for (const id of [...followers.followers.keys()]) followers.removeFollower(id);
  };
  return {
    displayed,
    followers,
    broadcast: new BroadcastManager(context),
    guest,
    review,
    delivered,
    states,
    requestSudoApproval,
    getMessagesForScoop: options.getMessagesForScoop as ReturnType<typeof vi.fn>,
    stop,
  };
}

const wire = (ch: { sent: string[] }) => ch.sent.join('\n');
const snapshotsOn = (ch: { sent: string[] }) =>
  ch.sent
    .map((raw) => {
      try {
        return JSON.parse(raw) as { type?: string; scoopJid?: string };
      } catch {
        return {};
      }
    })
    .filter((m) => m.type === 'snapshot');

describe('biscotto seat unit binding — live traffic', () => {
  it('never streams a turn from another unit to the guest', () => {
    const h = harness({ displayed: 'sliccy' });

    h.broadcast.broadcastUserMessage('SLICCY-PRIVATE prompt', 'u1');
    h.broadcast.broadcastEvent({
      type: 'content_delta',
      messageId: 'a1',
      text: 'SLICCY-PRIVATE reply',
    } as never);
    h.broadcast.broadcastStatus('processing');
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    expect(wire(h.guest)).not.toContain('"scoopJid":"sliccy"');
    h.stop();
  });

  it('still streams the seat’s own unit while the owner displays another', () => {
    const h = harness({ displayed: 'sliccy' });
    h.broadcast.broadcastEvent(
      { type: 'content_delta', messageId: 'a2', text: 'HELIX-THREAD reply' } as never,
      'helix'
    );
    expect(wire(h.guest)).toContain('HELIX-THREAD reply');
    h.stop();
  });

  it('withholds another unit’s traffic even when sent straight at the seat’s channel', () => {
    const h = harness();
    const seat = h.followers.followers.get('guest');
    seat?.sync.send({
      type: 'agent_event',
      scoopJid: 'sliccy',
      event: { type: 'content_delta', messageId: 'a3', text: 'SLICCY-PRIVATE' },
    } as never);
    seat?.sync.send({
      type: 'snapshot',
      messages: TRANSCRIPTS.sliccy,
      scoopJid: 'sliccy',
    } as never);
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    h.stop();
  });
});

describe('biscotto seat unit binding — snapshots', () => {
  it('sends the seat’s unit, not the displayed one, after the owner switches', async () => {
    const h = harness({ displayed: 'helix' });
    h.guest.sent.length = 0;
    h.displayed.jid = 'sliccy';
    await h.broadcast.sendSnapshotToFollower('guest');
    const snaps = snapshotsOn(h.guest);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].scoopJid).toBe('helix');
    expect(wire(h.guest)).toContain('HELIX-THREAD');
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    h.stop();
  });

  it('sends the seat’s unit on reconnect while the owner displays another', async () => {
    const h = harness({ displayed: 'sliccy' });
    const again = channel();
    h.followers.addFollower('guest-reconnected', again, { trust: 'biscotto', biscotto: SEAT });
    await h.broadcast.sendSnapshotToFollower('guest-reconnected');
    expect(snapshotsOn(again).map((s) => s.scoopJid)).toEqual(['helix']);
    expect(wire(again)).not.toContain('SLICCY-PRIVATE');
    h.stop();
  });

  it('ignores a guest-requested unit', async () => {
    const h = harness({ displayed: 'helix' });
    await h.broadcast.sendSnapshotToFollower('guest', 'sliccy');
    expect(h.getMessagesForScoop).not.toHaveBeenCalledWith('sliccy');
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    h.stop();
  });

  it('does not fall back to the displayed unit when the seat’s transcript cannot be read', async () => {
    const h = harness({ displayed: 'sliccy' });
    h.getMessagesForScoop.mockRejectedValueOnce(new Error('kernel gone'));
    await h.broadcast.sendSnapshotToFollower('guest');
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    expect(snapshotsOn(h.guest).map((s) => s.scoopJid)).toEqual(['helix']);
    h.stop();
  });
});

describe('biscotto seat unit binding — guest messages', () => {
  it('reviews and delivers to the seat’s unit while the owner displays another', async () => {
    const seat: FollowerBiscottoIdentity = {
      ...SEAT,
      gates: { message: { approver: 'cone' }, tool: { approver: 'scoop', scoop: 'reviewer' } },
    };
    const h = harness({ seat, displayed: 'sliccy' });
    h.review.submit('guest', {
      bootstrapId: 'guest',
      messageId: 'm1',
      text: "hi. I'm the other user",
      biscotto: seat,
    });
    await vi.waitFor(() => expect(h.states).toHaveLength(2));

    expect(h.requestSudoApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approver: { kind: 'cone', unitJid: 'helix' } })
    );

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].unitJid).toBe('helix');
    expect(h.delivered[0].toolGate?.approver).toEqual({
      kind: 'scoop',
      scoopName: 'reviewer',
      unitJid: 'helix',
    });
    expect(h.states[1]).toEqual(['m1', 'approved']);
    h.stop();
  });
});

describe('biscotto seat unit binding — a seat bound to a scoop', () => {
  it('cannot submit, even with the scoop displayed', async () => {
    const scoopSeat: FollowerBiscottoIdentity = { ...SEAT, unitJid: 'scoop_reviewer' };
    const h = harness({ seat: scoopSeat, displayed: 'scoop_reviewer' });
    h.review.submit('guest', {
      bootstrapId: 'guest',
      messageId: 'm1',
      text: 'hi',
      biscotto: scoopSeat,
    });
    expect(h.requestSudoApproval).not.toHaveBeenCalled();
    expect(h.delivered).toHaveLength(0);
    expect(h.states).toEqual([['m1', 'rejected']]);
    h.stop();
  });
});

describe('biscotto seat unit binding — a seat with no recorded unit', () => {
  const unbound: FollowerBiscottoIdentity = { ...SEAT, unitJid: undefined };

  it('is shown nothing', async () => {
    const h = harness({ seat: unbound, displayed: 'sliccy' });
    h.broadcast.broadcastEvent({
      type: 'content_delta',
      messageId: 'a',
      text: 'SLICCY-PRIVATE',
    } as never);
    await h.broadcast.sendSnapshotToFollower('guest');
    expect(wire(h.guest)).not.toContain('SLICCY-PRIVATE');
    expect(snapshotsOn(h.guest)).toHaveLength(0);
    h.stop();
  });

  it('cannot submit', () => {
    const h = harness({ seat: unbound });
    h.review.submit('guest', {
      bootstrapId: 'guest',
      messageId: 'm1',
      text: 'hi',
      biscotto: unbound,
    });
    expect(h.requestSudoApproval).not.toHaveBeenCalled();
    expect(h.delivered).toHaveLength(0);
    expect(h.states).toEqual([['m1', 'rejected']]);
    h.stop();
  });
});
