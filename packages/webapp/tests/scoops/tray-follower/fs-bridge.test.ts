import { describe, expect, it, vi } from 'vitest';
import { FollowerSyncManager } from '../../../src/scoops/tray-follower-sync.js';
import { FakeChannel } from './fake-channel.js';

describe('FollowerFsBridge (via FollowerSyncManager)', () => {
  it('sendFsRequest resolves when the leader returns a complete response', async () => {
    const channel = new FakeChannel();
    const follower = new FollowerSyncManager(channel);
    const pending = follower.sendFsRequest('runtime-1', { op: 'readFile', path: '/workspace/x' });
    const sent = channel.parseSent().find((m) => m.type === 'fs.request');
    if (sent?.type !== 'fs.request') throw new Error('expected fs.request');
    channel.simulateLeaderMessage({
      type: 'fs.response',
      requestId: sent.requestId,
      response: { ok: true, data: { type: 'file', content: 'hello', encoding: 'utf-8' } },
    });
    await expect(pending).resolves.toEqual([
      { ok: true, data: { type: 'file', content: 'hello', encoding: 'utf-8' } },
    ]);
  });

  it('executeLocalFs replies with an error when the follower has no VFS', async () => {
    const channel = new FakeChannel();
    new FollowerSyncManager(channel);
    channel.simulateLeaderMessage({
      type: 'fs.request',
      requestId: 'fs-1',
      request: { op: 'readFile', path: '/workspace/x' },
    });
    await vi.waitFor(() => {
      expect(channel.parseSent()).toContainEqual({
        type: 'fs.response',
        requestId: 'fs-1',
        response: { ok: false, error: 'Follower has no VFS' },
      });
    });
  });
});
