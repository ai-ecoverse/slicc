import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  BroadcastManager,
  PARENT_ID_ONLY_PROTOCOL_VERSION_MIN,
  scoopsListForPeer,
} from '../../../src/scoops/tray-leader/broadcast.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type {
  LeaderToFollowerMessage,
  ScoopSummary,
} from '../../../src/scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { toScoopSummaries } from '../../../src/ui/wc/wc-tray-scoops.js';

/** What `toScoopSummaries` projects today: the edge PLUS the deprecated flag. */
const ROSTER: ScoopSummary[] = [
  {
    jid: 'cone_1',
    name: 'sliccy',
    folder: 'cone',
    isCone: true,
    parentId: null,
    assistantLabel: 'sliccy',
  },
  {
    jid: 'scoop_1',
    name: 'helper',
    folder: 'helper',
    isCone: false,
    parentId: 'cone_1',
    assistantLabel: 'helper',
  },
];

interface PeerSpec {
  bootstrapId: string;
  peerProtocolVersion?: number;
  trust?: 'full' | 'biscotto';
}

function createHarness(peers: readonly PeerSpec[]) {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registry = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent = new Map<string, LeaderToFollowerMessage[]>();
  for (const peer of peers) {
    const received: LeaderToFollowerMessage[] = [];
    sent.set(peer.bootstrapId, received);
    registry.followers.set(peer.bootstrapId, {
      bootstrapId: peer.bootstrapId,
      trust: peer.trust ?? 'full',
      peerProtocolVersion: peer.peerProtocolVersion,
      sync: {
        send: (message: LeaderToFollowerMessage) => {
          received.push(message);
          return true;
        },
      },
    } as unknown as ConnectedFollower);
  }
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone_1',
    getScoops: () => ROSTER.map((scoop) => ({ ...scoop })),
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
  };
  const context: LeaderSyncContext = {
    options,
    followers: registry,
    log,
    sendControl: options.sendControl,
  };
  return { broadcast: new BroadcastManager(context), sent, log };
}

/** The `scoops.list` payloads one peer received. */
function rostersFor(
  sent: Map<string, LeaderToFollowerMessage[]>,
  bootstrapId: string
): ScoopSummary[][] {
  return (sent.get(bootstrapId) ?? [])
    .filter((message) => message.type === 'scoops.list')
    .map((message) => (message as LeaderToFollowerMessage & { type: 'scoops.list' }).scoops);
}

describe('scoopsListForPeer (#2358 stage 2)', () => {
  it('strips isCone for a peer at the parentId-only version', () => {
    const gated = scoopsListForPeer(ROSTER, PARENT_ID_ONLY_PROTOCOL_VERSION_MIN);
    expect(gated.every((scoop) => !('isCone' in scoop))).toBe(true);
    // The edge — the field that actually answers the role — survives untouched.
    expect(gated.map((scoop) => [scoop.jid, scoop.parentId])).toEqual([
      ['cone_1', null],
      ['scoop_1', 'cone_1'],
    ]);
  });

  it('keeps isCone for an older peer and for one that never said hello', () => {
    for (const version of [undefined, 1, PARENT_ID_ONLY_PROTOCOL_VERSION_MIN - 1]) {
      const kept = scoopsListForPeer(ROSTER, version);
      expect(kept.map((scoop) => scoop.isCone)).toEqual([true, false]);
    }
  });

  it('never mutates the projection it was handed', () => {
    const source = ROSTER.map((scoop) => ({ ...scoop }));
    scoopsListForPeer(source, PARENT_ID_ONLY_PROTOCOL_VERSION_MIN);
    expect(source.map((scoop) => scoop.isCone)).toEqual([true, false]);
  });
});

describe('BroadcastManager scoops.list per-peer gating (#2358 stage 2)', () => {
  it('sends each follower the shape its own hello version asked for', () => {
    const { broadcast, sent } = createHarness([
      { bootstrapId: 'modern', peerProtocolVersion: PARENT_ID_ONLY_PROTOCOL_VERSION_MIN },
      { bootstrapId: 'legacy', peerProtocolVersion: 7 },
      { bootstrapId: 'silent' },
    ]);

    broadcast.broadcastScoopsList();

    expect(rostersFor(sent, 'modern')[0]?.every((scoop) => !('isCone' in scoop))).toBe(true);
    expect(rostersFor(sent, 'legacy')[0]?.map((scoop) => scoop.isCone)).toEqual([true, false]);
    expect(rostersFor(sent, 'silent')[0]?.map((scoop) => scoop.isCone)).toEqual([true, false]);
    // Every peer still gets the same roster and the same selection.
    for (const id of ['modern', 'legacy', 'silent']) {
      expect(rostersFor(sent, id)[0]?.map((scoop) => scoop.jid)).toEqual(['cone_1', 'scoop_1']);
    }
  });

  it('applies the same gate on the targeted send', () => {
    const { broadcast, sent } = createHarness([
      { bootstrapId: 'modern', peerProtocolVersion: PARENT_ID_ONLY_PROTOCOL_VERSION_MIN },
      { bootstrapId: 'legacy', peerProtocolVersion: 7 },
    ]);

    broadcast.sendScoopsListToFollower('modern');
    broadcast.sendScoopsListToFollower('legacy');

    expect(rostersFor(sent, 'modern')[0]?.every((scoop) => !('isCone' in scoop))).toBe(true);
    expect(rostersFor(sent, 'legacy')[0]?.map((scoop) => scoop.isCone)).toEqual([true, false]);
  });

  it('still withholds the inventory from a biscotto seat', () => {
    const { broadcast, sent } = createHarness([
      { bootstrapId: 'guest', trust: 'biscotto', peerProtocolVersion: 8 },
    ]);

    broadcast.sendScoopsListToFollower('guest');
    expect(rostersFor(sent, 'guest')).toEqual([]);
  });

  it('reports a follower whose channel refuses the roster', () => {
    const { broadcast, log } = createHarness([{ bootstrapId: 'modern', peerProtocolVersion: 8 }]);
    const registry = (broadcast as unknown as { context: LeaderSyncContext }).context.followers;
    const follower = registry.followers.get('modern') as ConnectedFollower;
    follower.sync = { send: () => false } as unknown as ConnectedFollower['sync'];

    broadcast.broadcastScoopsList();

    expect(log.error).toHaveBeenCalledWith(
      'Broadcast send to follower failed',
      expect.objectContaining({ bootstrapId: 'modern', messageType: 'scoops.list' })
    );
  });
});

describe('the leader projection feeds the gate (#2358 stage 2)', () => {
  /** The records the leader actually holds — no hand-written wire fields. */
  const RECORDS: RegisteredScoop[] = [
    {
      jid: 'cone_1',
      name: 'sliccy',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      jid: 'scoop_1',
      name: 'helper',
      folder: 'helper',
      parentJid: 'cone_1',
      requiresTrigger: true,
      assistantLabel: 'helper',
      addedAt: '2026-09-02T00:00:00.000Z',
    },
  ];

  /**
   * The gate is only half the contract: an older peer needs the flag to be
   * PRESENT and correct, which is the projection's job. Asserting that here,
   * over real records, is what makes deleting `isCone: isRootUnit(scoop)` from
   * `toScoopSummaries` a test failure rather than a silent break of every
   * shipped native follower — the field is optional now, so the compiler will
   * not say a word.
   */
  it('projects an explicit isCone for a peer below v8', () => {
    for (const version of [undefined, 7]) {
      const projected = scoopsListForPeer(toScoopSummaries(RECORDS, []), version);
      expect(projected.map((scoop) => [scoop.jid, scoop.isCone])).toEqual([
        ['cone_1', true],
        ['scoop_1', false],
      ]);
    }
  });

  it('leaves a v8 peer no isCone property at all, edge intact', () => {
    const projected = scoopsListForPeer(
      toScoopSummaries(RECORDS, []),
      PARENT_ID_ONLY_PROTOCOL_VERSION_MIN
    );
    expect(projected.every((scoop) => !('isCone' in scoop))).toBe(true);
    expect(projected.map((scoop) => [scoop.jid, scoop.parentId])).toEqual([
      ['cone_1', null],
      ['scoop_1', 'cone_1'],
    ]);
  });
});
