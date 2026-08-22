import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { RemoteExecRouter } from '../../../src/scoops/tray-leader/remote-exec.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  return { followers, router: new RemoteExecRouter(context) };
}

function addFollower(registry: FollowerRegistry, bootstrapId: string) {
  const sent: LeaderToFollowerMessage[] = [];
  registry.followers.set(bootstrapId, {
    bootstrapId,
    peerCapabilities: { exec: true },
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
  registry.setRuntimeId(`runtime-${bootstrapId}`, bootstrapId);
  return sent;
}

function encoded(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RemoteExecRouter', () => {
  it('includes base64 stdin on exec.request when provided', async () => {
    const { followers, router } = createHarness();
    const sent = addFollower(followers, 'target');
    const stdin = encoded('hello\n');
    void router.execOnRemote('runtime-target', 'cat', { stdin });
    const request = sent.find((message) => message.type === 'exec.request');
    if (request?.type !== 'exec.request') throw new Error('missing exec request');
    expect(request.stdin).toBe(stdin);
  });

  it('streams follower chunks to a leader caller in arrival order', async () => {
    const { followers, router } = createHarness();
    const sent = addFollower(followers, 'target');
    const onChunk = vi.fn();
    const pending = router.execOnRemote('runtime-target', 'printf output', { onChunk });
    const request = sent.find((message) => message.type === 'exec.request');
    if (request?.type !== 'exec.request') throw new Error('missing exec request');

    router.handleFollowerExecMessage('target', {
      type: 'exec.chunk',
      requestId: request.requestId,
      stream: 'stdout',
      data: encoded('first'),
    });
    router.handleFollowerExecMessage('target', {
      type: 'exec.chunk',
      requestId: request.requestId,
      stream: 'stderr',
      data: encoded('second'),
    });
    router.handleFollowerExecMessage('target', {
      type: 'exec.response',
      requestId: request.requestId,
      exitCode: 0,
    });

    await expect(pending).resolves.toEqual({
      stdout: 'first',
      stderr: 'second',
      exitCode: 0,
      error: undefined,
    });
    expect(onChunk.mock.calls).toEqual([
      ['stdout', 'first'],
      ['stderr', 'second'],
    ]);
  });

  it('streams leader shell chunks back to the requesting follower', async () => {
    const execInShell = vi.fn(async (_command, opts) => {
      opts.onChunk('stdout', 'out');
      opts.onChunk('stderr', 'err');
      return { exitCode: 7 };
    });
    const { followers, router } = createHarness({ execInShell });
    const sent = addFollower(followers, 'requester');

    router.handleFollowerExecMessage('requester', {
      type: 'exec.request',
      requestId: 'local-1',
      command: 'run',
    });

    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === 'exec.response')).toBe(true)
    );
    expect(execInShell.mock.calls[0]?.[1].sessionId).toBe('requester');
    expect(sent.filter((message) => message.type === 'exec.chunk')).toEqual([
      { type: 'exec.chunk', requestId: 'local-1', stream: 'stdout', data: encoded('out') },
      { type: 'exec.chunk', requestId: 'local-1', stream: 'stderr', data: encoded('err') },
    ]);
  });

  it('forwards stdin from follower exec.request to execInShell', async () => {
    const execInShell = vi.fn(async () => ({ exitCode: 0 }));
    const { followers, router } = createHarness({ execInShell });
    addFollower(followers, 'requester');

    router.handleFollowerExecMessage('requester', {
      type: 'exec.request',
      requestId: 'local-stdin',
      command: 'cat',
      stdin: encoded('piped\n'),
    });

    await vi.waitFor(() => expect(execInShell).toHaveBeenCalled());
    expect(execInShell).toHaveBeenCalledWith(
      'cat',
      expect.objectContaining({ stdin: encoded('piped\n') })
    );
  });

  it('kills and rejects a leader request when its timeout expires', async () => {
    vi.useFakeTimers();
    const { followers, router } = createHarness();
    const sent = addFollower(followers, 'target');
    const pending = router.execOnRemote('runtime-target', 'sleep 30', { timeoutMs: 25 });
    const rejection = expect(pending).rejects.toThrow('timed out after 25ms');

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(sent.find((message) => message.type === 'exec.signal')).toMatchObject({
      type: 'exec.signal',
      signal: 'SIGKILL',
    });
  });

  it('rejects a leader request and clears its timeout on follower disconnect', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { followers, router } = createHarness();
    addFollower(followers, 'target');
    const pending = router.execOnRemote('runtime-target', 'sleep 30', { timeoutMs: 500 });

    followers.removeFollower('target');

    await expect(pending).rejects.toThrow('disconnected');
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
  });

  it('aborts follower-initiated shell work when that follower disconnects', async () => {
    let localSignal: AbortSignal | undefined;
    const execInShell = vi.fn(
      (_command, opts) =>
        new Promise<{ exitCode: number }>((_resolve, reject) => {
          localSignal = opts.signal;
          opts.signal.addEventListener('abort', () => reject(new Error('disconnected')), {
            once: true,
          });
        })
    );
    const closeExecShell = vi.fn();
    const { followers, router } = createHarness({ execInShell, closeExecShell });
    addFollower(followers, 'requester');
    router.handleFollowerExecMessage('requester', {
      type: 'exec.request',
      requestId: 'local-2',
      command: 'sleep 30',
    });
    await vi.waitFor(() => expect(localSignal).toBeDefined());

    followers.removeFollower('requester');

    expect(localSignal?.aborted).toBe(true);
    expect(closeExecShell).toHaveBeenCalledWith('requester');
  });
});
