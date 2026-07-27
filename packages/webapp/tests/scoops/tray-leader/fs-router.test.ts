import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { FsRouter } from '../../../src/scoops/tray-leader/fs-router.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type {
  LeaderToFollowerMessage,
  TrayFsResponse,
} from '../../../src/scoops/tray-sync-protocol.js';

function createHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  return { followers, router: new FsRouter(context) };
}

function addFollower(registry: FollowerRegistry, bootstrapId: string) {
  const sent: LeaderToFollowerMessage[] = [];
  registry.followers.set(bootstrapId, {
    bootstrapId,
    sync: {
      send: vi.fn((message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      }),
      close: vi.fn(),
    },
    unsubscribe: vi.fn(),
    keepalive: { stop: vi.fn() },
  } as unknown as ConnectedFollower);
  return sent;
}

describe('FsRouter', () => {
  it('reassembles multi-chunk responses in chunk-index order', async () => {
    const { followers, router } = createHarness();
    const sent = addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    const pending = router.sendFsRequest('runtime-target', { op: 'readFile', path: '/large' });
    const request = sent.find((message) => message.type === 'fs.request');
    if (request?.type !== 'fs.request') throw new Error('missing fs request');
    const first: TrayFsResponse = {
      ok: true,
      data: { type: 'file', content: 'first', encoding: 'utf-8' },
      chunkIndex: 0,
      totalChunks: 2,
    };
    const second: TrayFsResponse = {
      ok: true,
      data: { type: 'file', content: 'second', encoding: 'utf-8' },
      chunkIndex: 1,
      totalChunks: 2,
    };

    router.handleFsResponse(request.requestId, second);
    router.handleFsResponse(request.requestId, first);

    await expect(pending).resolves.toEqual([first, second]);
  });

  it('rejects a leader request when its target follower disconnects', async () => {
    const { followers, router } = createHarness();
    addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    const pending = router.sendFsRequest('runtime-target', { op: 'exists', path: '/' });

    followers.removeFollower('target');

    await expect(pending).rejects.toThrow('disconnected');
    expect(followers.runtimeToBootstrap.has('runtime-target')).toBe(false);
  });
});
