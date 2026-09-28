import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import { BroadcastManager } from '../../../src/scoops/tray-leader/broadcast.js';
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

const ROSTER: ScoopSummary[] = [
  {
    jid: 'cone_1',
    name: 'sliccy',
    folder: 'cone',
    parentId: null,
    assistantLabel: 'sliccy',
  },
  {
    jid: 'scoop_1',
    name: 'helper',
    folder: 'helper',
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

function rostersFor(
  sent: Map<string, LeaderToFollowerMessage[]>,
  bootstrapId: string
): ScoopSummary[][] {
  return (sent.get(bootstrapId) ?? [])
    .filter((message) => message.type === 'scoops.list')
    .map((message) => (message as LeaderToFollowerMessage & { type: 'scoops.list' }).scoops);
}

describe('BroadcastManager scoops.list (#2358 stage 3)', () => {
  it('sends every full peer the same parentId-only roster', () => {
    const { broadcast, sent } = createHarness([
      { bootstrapId: 'a', peerProtocolVersion: 10 },
      { bootstrapId: 'b', peerProtocolVersion: 7 },
      { bootstrapId: 'silent' },
    ]);

    broadcast.broadcastScoopsList();

    for (const id of ['a', 'b', 'silent']) {
      const roster = rostersFor(sent, id)[0];
      expect(roster?.every((scoop) => !('isCone' in scoop))).toBe(true);
      expect(roster?.map((scoop) => [scoop.jid, scoop.parentId])).toEqual([
        ['cone_1', null],
        ['scoop_1', 'cone_1'],
      ]);
    }
  });

  it('applies the same shape on the targeted send', () => {
    const { broadcast, sent } = createHarness([{ bootstrapId: 'peer', peerProtocolVersion: 10 }]);

    broadcast.sendScoopsListToFollower('peer');

    expect(rostersFor(sent, 'peer')[0]?.every((scoop) => !('isCone' in scoop))).toBe(true);
  });

  it('still withholds the inventory from a biscotto seat', () => {
    const { broadcast, sent } = createHarness([
      { bootstrapId: 'guest', trust: 'biscotto', peerProtocolVersion: 8 },
    ]);

    broadcast.sendScoopsListToFollower('guest');
    expect(rostersFor(sent, 'guest')).toEqual([]);
  });

  it('reports a follower whose channel refuses the roster', () => {
    const { broadcast, log } = createHarness([{ bootstrapId: 'peer', peerProtocolVersion: 8 }]);
    const registry = (broadcast as unknown as { context: LeaderSyncContext }).context.followers;
    const follower = registry.followers.get('peer') as ConnectedFollower;
    follower.sync = { send: () => false } as unknown as ConnectedFollower['sync'];

    broadcast.broadcastScoopsList();

    expect(log.error).toHaveBeenCalledWith(
      'Broadcast send to follower failed',
      expect.objectContaining({ bootstrapId: 'peer', messageType: 'scoops.list' })
    );
  });
});

describe('toScoopSummaries projects the edge alone (#2358 stage 3)', () => {
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

  it('never projects isCone; parentId answers the role', () => {
    const projected = toScoopSummaries(RECORDS, []);
    expect(projected.every((scoop) => !('isCone' in scoop))).toBe(true);
    expect(projected.map((scoop) => [scoop.jid, scoop.parentId])).toEqual([
      ['cone_1', null],
      ['scoop_1', 'cone_1'],
    ]);
  });
});
