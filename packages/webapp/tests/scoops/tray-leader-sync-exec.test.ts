import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
} from '../../src/scoops/tray-leader-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners: Array<(event: { data: string }) => void> = [];

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  simulateMessage(msg: FollowerToLeaderMessage): void {
    const data = JSON.stringify(msg);
    for (const l of this.listeners) l({ data });
  }
  parseSent(): LeaderToFollowerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as LeaderToFollowerMessage);
  }
  ofType<T extends LeaderToFollowerMessage['type']>(
    type: T
  ): Extract<LeaderToFollowerMessage, { type: T }>[] {
    return this.parseSent().filter((m) => m.type === type) as Extract<
      LeaderToFollowerMessage,
      { type: T }
    >[];
  }
}

function createManager(overrides?: Partial<LeaderSyncManagerOptions>) {
  const options: LeaderSyncManagerOptions = {
    sendControl: () => {},
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    ...(overrides ?? {}),
  };
  return new LeaderSyncManager(options);
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
const tick = () => new Promise((r) => setTimeout(r, 0));

// Register a follower and advertise exec capability via hello.
function addExecFollower(manager: LeaderSyncManager, bootstrapId: string): FakeChannel {
  const ch = new FakeChannel();
  manager.addFollower(bootstrapId, ch);
  ch.simulateMessage({ type: 'hello', protocolVersion: 1, capabilities: { exec: true } });
  return ch;
}

describe('leader exec — CLI exec (follower → leader, runs in leader shell)', () => {
  it('runs exec.request in the leader shell and streams chunks + response', async () => {
    const execInShell = vi.fn(
      async (
        _command: string,
        opts: { onChunk: (stream: 'stdout' | 'stderr', data: string) => void }
      ) => {
        opts.onChunk('stdout', 'out-data');
        opts.onChunk('stderr', 'err-data');
        return { exitCode: 0 };
      }
    );
    const manager = createManager({ execInShell });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'exec.request', requestId: 'r1', command: 'echo out-data' });
    await vi.waitFor(() => expect(ch.ofType('exec.response')).toHaveLength(1));

    expect(execInShell).toHaveBeenCalledWith('echo out-data', expect.any(Object));
    const chunks = ch.ofType('exec.chunk');
    expect(chunks).toContainEqual(
      expect.objectContaining({ requestId: 'r1', stream: 'stdout', data: b64('out-data') })
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({ requestId: 'r1', stream: 'stderr', data: b64('err-data') })
    );
    expect(ch.ofType('exec.response')[0]).toMatchObject({ requestId: 'r1', exitCode: 0 });
  });

  it('refuses exec.request with an error response when no shell is wired', async () => {
    const manager = createManager(); // no execInShell
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'exec.request', requestId: 'r1', command: 'ls' });
    await vi.waitFor(() => expect(ch.ofType('exec.response')).toHaveLength(1));
    expect(ch.ofType('exec.response')[0]).toMatchObject({ exitCode: 127 });
    expect(ch.ofType('exec.response')[0].error).toContain('not supported');
  });

  it('aborts a running exec on exec.signal', async () => {
    const execInShell = vi.fn(
      (_command: string, opts: { signal: AbortSignal }) =>
        new Promise<{ exitCode: number }>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve({ exitCode: 130 }), { once: true });
        })
    );
    const manager = createManager({ execInShell });
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);
    ch.simulateMessage({ type: 'exec.request', requestId: 'r2', command: 'sleep 30' });
    await tick();
    expect(ch.ofType('exec.response')).toHaveLength(0);
    ch.simulateMessage({ type: 'exec.signal', requestId: 'r2', signal: 'SIGINT' });
    await vi.waitFor(() => expect(ch.ofType('exec.response')).toHaveLength(1));
    expect(ch.ofType('exec.response')[0]).toMatchObject({ requestId: 'r2', exitCode: 130 });
  });
});

describe('leader exec — ssh (leader → follower via execOnRemote)', () => {
  it('sends exec.request and resolves the buffered result on the streamed reply', async () => {
    const manager = createManager();
    const ch = addExecFollower(manager, 'b1');
    const onChunk = vi.fn();
    const p = manager.execOnRemote('follower-b1', 'ls -la', { onChunk });

    await vi.waitFor(() => expect(ch.ofType('exec.request')).toHaveLength(1));
    const req = ch.ofType('exec.request')[0];
    expect(req.command).toBe('ls -la');
    const requestId = req.requestId;

    ch.simulateMessage({ type: 'exec.chunk', requestId, stream: 'stdout', data: b64('hi\n') });
    ch.simulateMessage({ type: 'exec.chunk', requestId, stream: 'stderr', data: b64('warn\n') });
    ch.simulateMessage({ type: 'exec.response', requestId, exitCode: 0 });

    const result = await p;
    expect(result).toMatchObject({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 0 });
    expect(onChunk).toHaveBeenCalledWith('stdout', 'hi\n');
    expect(onChunk).toHaveBeenCalledWith('stderr', 'warn\n');
  });

  it('rejects when the follower is not an exec target', async () => {
    const manager = createManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch); // no exec-capable hello
    await expect(manager.execOnRemote('follower-b1', 'ls')).rejects.toThrow('not an exec target');
  });

  it('rejects when no follower matches the runtime id', async () => {
    const manager = createManager();
    await expect(manager.execOnRemote('follower-missing', 'ls')).rejects.toThrow(
      'No connected follower'
    );
  });

  it('rejects an in-flight exec when the follower disconnects', async () => {
    const manager = createManager();
    addExecFollower(manager, 'b1');
    const p = manager.execOnRemote('follower-b1', 'sleep 30');
    await vi.waitFor(() => expect(manager.getExecCapableBootstrapIds().has('b1')).toBe(true));
    manager.removeFollower('b1');
    await expect(p).rejects.toThrow('disconnected');
  });

  it('forwards an abort as exec.signal to the follower', async () => {
    const manager = createManager();
    const ch = addExecFollower(manager, 'b1');
    const controller = new AbortController();
    const p = manager.execOnRemote('follower-b1', 'sleep 30', { signal: controller.signal });
    await vi.waitFor(() => expect(ch.ofType('exec.request')).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(ch.ofType('exec.signal')).toHaveLength(1));
    expect(ch.ofType('exec.signal')[0]).toMatchObject({ signal: 'SIGINT' });
    // Complete the exec so the promise settles.
    const requestId = ch.ofType('exec.request')[0].requestId;
    ch.simulateMessage({ type: 'exec.response', requestId, exitCode: 130 });
    await expect(p).resolves.toMatchObject({ exitCode: 130 });
  });
});
