import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import { CherryRouter } from '../../../src/scoops/tray-leader/cherry-router.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  followers.followers.set('bootstrap', {
    bootstrapId: 'bootstrap',
    sync: {
      send: vi.fn((message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      }),
    },
  } as unknown as ConnectedFollower);
  followers.setRuntimeId('runtime', 'bootstrap');
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    onCherryHostEvent: vi.fn(),
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  return { options, router: new CherryRouter(context), sent };
}

describe('CherryRouter', () => {
  it('routes host events and sends slicc events through the owning follower', () => {
    const { options, router, sent } = createHarness();
    router.routeCherryHostEvent('bootstrap', {
      type: 'cherry.host_event',
      targetId: 'runtime:host',
      name: 'cart.updated',
      detail: { items: 2 },
    });
    expect(options.onCherryHostEvent).toHaveBeenCalledWith('runtime', 'cart.updated', { items: 2 });

    expect(router.emitCherrySliccEvent('runtime:host', 'open', { source: 'test' })).toBe(true);
    expect(sent).toEqual([
      {
        type: 'cherry.slicc_event',
        targetId: 'runtime:host',
        name: 'open',
        detail: { source: 'test' },
      },
    ]);
  });
});
