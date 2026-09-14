import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { FsRouter } from '../../../src/scoops/tray-leader/fs-router.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type {
  LeaderToFollowerMessage,
  TrayFsRequest,
  TrayFsResponse,
} from '../../../src/scoops/tray-sync-protocol.js';

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  };
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
  it.each(['/proc', '/proc/1/status', '/workspace/../proc/1/status'])(
    'refuses follower access to proc: %s',
    async (path) => {
      const readFile = vi.fn();
      const { followers, router } = createHarness({
        vfs: { readFile } as unknown as NonNullable<LeaderSyncManagerOptions['vfs']>,
      });
      const sent = addFollower(followers, 'requester');

      await router.executeLocalFs('denied-read', { op: 'readFile', path }, 'requester');

      expect(readFile).not.toHaveBeenCalled();
      expect(sent).toEqual([
        {
          type: 'fs.response',
          requestId: 'denied-read',
          response: {
            ok: false,
            error: 'Follower filesystem access denied',
            code: 'EACCES',
          },
        },
      ]);
    }
  );

  it('allows follower mutations outside proc', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const { followers, router } = createHarness({
      vfs: { writeFile } as unknown as NonNullable<LeaderSyncManagerOptions['vfs']>,
    });
    const sent = addFollower(followers, 'requester');
    const request: TrayFsRequest = {
      op: 'writeFile',
      path: '/etc/follower.txt',
      content: 'allowed',
      encoding: 'utf-8',
    };

    await router.executeLocalFs('allowed-write', request, 'requester');

    expect(writeFile).toHaveBeenCalledWith('/etc/follower.txt', 'allowed');
    expect(sent[0]).toMatchObject({
      type: 'fs.response',
      requestId: 'allowed-write',
      response: { ok: true, data: { type: 'void' } },
    });
  });

  it('reassembles multi-chunk responses in arrival order', async () => {
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

    await expect(pending).resolves.toEqual([second, first]);
  });

  it('counts duplicate chunk indexes toward completion', async () => {
    const { followers, router } = createHarness();
    const sent = addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    const pending = router.sendFsRequest('runtime-target', { op: 'readFile', path: '/large' });
    const request = sent.find((message) => message.type === 'fs.request');
    if (request?.type !== 'fs.request') throw new Error('missing fs request');
    const duplicate: TrayFsResponse = {
      ok: true,
      data: { type: 'file', content: 'same', encoding: 'utf-8' },
      chunkIndex: 0,
      totalChunks: 2,
    };

    router.handleFsResponse(request.requestId, duplicate);
    router.handleFsResponse(request.requestId, duplicate);

    await expect(pending).resolves.toEqual([duplicate, duplicate]);
  });

  it('completes when the current response decreases totalChunks to the received count', async () => {
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
      totalChunks: 3,
    };
    const second: TrayFsResponse = {
      ok: true,
      data: { type: 'file', content: 'second', encoding: 'utf-8' },
      chunkIndex: 1,
      totalChunks: 2,
    };
    const onResolve = vi.fn();
    void pending.then(onResolve);

    router.handleFsResponse(request.requestId, first);
    router.handleFsResponse(request.requestId, second);
    await Promise.resolve();

    expect(onResolve).toHaveBeenCalledWith([first, second]);
  });

  it('remains pending when the current response increases totalChunks above the received count', async () => {
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
      totalChunks: 3,
    };
    const onResolve = vi.fn();
    void pending.then(onResolve);

    router.handleFsResponse(request.requestId, first);
    router.handleFsResponse(request.requestId, second);
    await Promise.resolve();

    expect(onResolve).not.toHaveBeenCalled();
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
