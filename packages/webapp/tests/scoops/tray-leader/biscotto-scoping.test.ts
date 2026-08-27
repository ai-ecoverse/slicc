import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import { BroadcastManager } from '../../../src/scoops/tray-leader/broadcast.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createHarness(trust: 'full' | 'biscotto') {
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const registry = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  registry.followers.set('peer', {
    bootstrapId: 'peer',
    trust,
    biscotto: trust === 'biscotto' ? { id: 'seat1', label: 'Anna' } : undefined,
    sync: {
      send: (message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      },
    },
  } as unknown as ConnectedFollower);

  const getMessagesForScoop = vi.fn(async (jid: string) => [
    { id: 'm1', role: 'user' as const, content: `secret transcript of ${jid}`, timestamp: 1 },
  ]);
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [{ id: 'c1', role: 'user', content: 'cone thread', timestamp: 1 }],
    getScoopJid: () => 'cone',
    getScoops: () => [
      { jid: 'cone', name: 'cone' },
      { jid: 'scoop_private', name: 'private' },
    ],
    getMessagesForScoop,
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
  } as unknown as LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers: registry,
    log,
    sendControl: options.sendControl,
  };
  return { broadcast: new BroadcastManager(context), sent, getMessagesForScoop, registry };
}

describe('biscotto snapshot scoping', () => {
  it('ignores a guest-supplied scoopJid and serves only the shared thread', async () => {
    const { broadcast, sent, getMessagesForScoop } = createHarness('biscotto');

    // `scoops.select` is denied by the allowlist, but `request_snapshot`
    // carries its own JID — the hole this closes.
    await broadcast.sendSnapshotToFollower('peer', 'scoop_private');

    expect(getMessagesForScoop).not.toHaveBeenCalled();
    const snapshot = sent.find((m) => m.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain('secret transcript');
    expect(JSON.stringify(snapshot)).toContain('cone thread');
  });

  it('ignores a remembered selectedScoopJid on a guest too', async () => {
    const { broadcast, sent, registry, getMessagesForScoop } = createHarness('biscotto');
    const follower = registry.followers.get('peer');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'scoop_private';

    await broadcast.sendSnapshotToFollower('peer');

    expect(getMessagesForScoop).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toContain('secret transcript');
  });

  it('still honours a scoopJid from a full-trust follower', async () => {
    const { broadcast, getMessagesForScoop } = createHarness('full');
    await broadcast.sendSnapshotToFollower('peer', 'scoop_private');
    expect(getMessagesForScoop).toHaveBeenCalledWith('scoop_private');
  });

  it('sends a guest no scoop inventory to enumerate from', () => {
    const { broadcast, sent } = createHarness('biscotto');
    broadcast.sendScoopsListToFollower('peer');
    expect(sent.find((m) => m.type === 'scoops.list')).toBeUndefined();
  });

  it('still sends the inventory to a full-trust follower', () => {
    const { broadcast, sent } = createHarness('full');
    broadcast.sendScoopsListToFollower('peer');
    expect(sent.find((m) => m.type === 'scoops.list')).toBeDefined();
  });
});
