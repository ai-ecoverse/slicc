import { describe, expect, it, vi } from 'vitest';
import type { FsChangeEvent } from '../../src/fs/fs-watcher.js';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import type { DirEntry, ReadFileOptions, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
  VfsReadDirResultMsg,
} from '../../src/kernel/messages.js';
import { createRemoteVfsClient } from '../../src/kernel/remote-vfs-client.js';
import type { KernelTransport } from '../../src/kernel/transport.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeStubVfs(): {
  client: LocalVfsClient;
  readDir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
} {
  const readDir = vi.fn(async (_path: string): Promise<DirEntry[]> => []);
  const readFile = vi.fn(
    async (_path: string, _opts?: ReadFileOptions): Promise<string | Uint8Array> => ''
  );
  const stat = vi.fn(
    async (_path: string): Promise<Stats> => ({ type: 'file', size: 0, mtime: 0, ctime: 0 })
  );
  return { client: { readDir, readFile, stat }, readDir, readFile, stat };
}

interface RoundTripCtx {
  client: ReturnType<typeof createRemoteVfsClient>;
  vfs: ReturnType<typeof makeStubVfs>;
  stop: () => void;
}

function setupRoundTrip(getWatcher?: () => FsWatcher | null): RoundTripCtx {
  const channel = new MessageChannel();
  const bridge = createBridgeMessageChannelTransport(channel.port2);
  const vfs = makeStubVfs();
  const hostHandle = startVfsRpcHost({
    transport: bridge,
    client: vfs.client,
    ...(getWatcher ? { getWatcher } : {}),
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const panel = createPanelMessageChannelTransport(channel.port1);
  const client = createRemoteVfsClient({
    transport: panel,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  return {
    client,
    vfs,
    stop: () => {
      client.dispose();
      hostHandle.stop();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('RemoteVfsClient — end-to-end round-trip', () => {
  it('readDir round-trips entries from the host VFS', async () => {
    const ctx = setupRoundTrip();
    const entries: DirEntry[] = [
      { name: 'a.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
    ];
    ctx.vfs.readDir.mockResolvedValue(entries);
    const result = await ctx.client.readDir('/workspace');
    expect(ctx.vfs.readDir).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual(entries);
    ctx.stop();
  });

  it('readFile defaults to utf-8 and returns the string payload', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockResolvedValue('hello');
    const result = await ctx.client.readFile('/notes.md');
    expect(ctx.vfs.readFile).toHaveBeenCalledWith('/notes.md', { encoding: 'utf-8' });
    expect(result).toBe('hello');
    ctx.stop();
  });

  it('readFile binary returns the bytes as Uint8Array', async () => {
    const ctx = setupRoundTrip();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    ctx.vfs.readFile.mockResolvedValue(bytes);
    const result = await ctx.client.readFile('/image.png', { encoding: 'binary' });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    ctx.stop();
  });

  it('readFileRange round-trips a window without a whole-file read (#2857)', async () => {
    const ctx = setupRoundTrip();
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    const readFileRange = vi.fn(async (_p: string, start: number, end: number) =>
      bytes.subarray(start, end)
    );
    ctx.vfs.client.readFileRange = readFileRange;
    const result = await ctx.client.readFileRange('/clip.mp4', 1, 4);
    expect(readFileRange).toHaveBeenCalledWith('/clip.mp4', 1, 4);
    expect(ctx.vfs.readFile).not.toHaveBeenCalled();
    expect(Array.from(result)).toEqual([1, 2, 3]);
    ctx.stop();
  });

  it('stat round-trips the stats envelope', async () => {
    const ctx = setupRoundTrip();
    const stats: Stats = { type: 'file', size: 1234, mtime: 555, ctime: 444 };
    ctx.vfs.stat.mockResolvedValue(stats);
    const result = await ctx.client.stat('/file');
    expect(ctx.vfs.stat).toHaveBeenCalledWith('/file');
    expect(result).toEqual(stats);
    ctx.stop();
  });

  it('FsError ENOENT comes back as FsError with the POSIX code preserved', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockRejectedValue(new FsError('ENOENT', 'no such file', '/missing'));
    await expect(ctx.client.readFile('/missing')).rejects.toMatchObject({
      name: 'FsError',
      code: 'ENOENT',
      path: '/missing',
    });
    ctx.stop();
  });

  it('non-FsError throws become EIO on the failure branch', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readDir.mockRejectedValue(new Error('disk on fire'));
    await expect(ctx.client.readDir('/wherever')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EIO',
    });
    ctx.stop();
  });

  it('concurrent requests are demultiplexed by requestId', async () => {
    const ctx = setupRoundTrip();
    let resolveSlow: ((value: string) => void) | null = null;
    ctx.vfs.readFile.mockImplementation(async (path: string) => {
      if (path === '/slow') {
        return new Promise<string>((r) => {
          resolveSlow = r;
        });
      }
      return 'fast-data';
    });
    const slowP = ctx.client.readFile('/slow');
    const fastP = ctx.client.readFile('/fast');

    await expect(fastP).resolves.toBe('fast-data');

    (resolveSlow as ((v: string) => void) | null)?.('slow-data');
    await expect(slowP).resolves.toBe('slow-data');
    ctx.stop();
  });
});

describe('RemoteVfsClient — error-code narrowing', () => {
  it('unknown error codes fall back to EIO', async () => {
    let handler: ((m: ExtensionMessage) => void) | null = null;
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send(payload) {
        const req = payload as { type: string; requestId: string };

        handler?.({
          source: 'offscreen',
          payload: {
            type: 'vfs-read-dir-result',
            requestId: req.requestId,
            ok: false,
            error: { code: 'ENOTSUP', message: 'unknown code', path: '/x' },
          } as VfsReadDirResultMsg,
        } as ExtensionMessage);
      },
    };
    const client = createRemoteVfsClient({ transport, logger: { warn: vi.fn(), debug: vi.fn() } });
    await expect(client.readDir('/x')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EIO',
    });
    client.dispose();
  });
});

describe('RemoteVfsClient — envelope filtering', () => {
  it('ignores envelopes with source !== "offscreen"', async () => {
    const ctx = setupRoundTrip();

    ctx.vfs.readFile.mockResolvedValue('real');
    const p = ctx.client.readFile('/x');

    await expect(p).resolves.toBe('real');
    ctx.stop();
  });

  it('ignores non-vfs payloads on the wire', async () => {
    let handler: ((m: ExtensionMessage) => void) | null = null;
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send() {},
    };
    const client = createRemoteVfsClient({ transport, logger: { warn: vi.fn(), debug: vi.fn() } });

    expect(() =>
      handler?.({
        source: 'offscreen',
        payload: { type: 'agent-event', event: { type: 'noop' } },
      } as unknown as ExtensionMessage)
    ).not.toThrow();

    expect(() => handler?.(null as unknown as ExtensionMessage)).not.toThrow();
    client.dispose();
  });
});

describe('RemoteVfsClient — request timeout', () => {
  it('rejects with EIO when no response arrives within requestTimeoutMs', async () => {
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage: () => () => {},
      send: () => {},
    };
    const client = createRemoteVfsClient({
      transport,
      requestTimeoutMs: 20,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    await expect(client.readFile('/sessions/index.json')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EIO',
      path: '/sessions/index.json',
    });
    client.dispose();
  });

  it('requestTimeoutMs <= 0 disables the timeout (stays pending until dispose)', async () => {
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage: () => () => {},
      send: () => {},
    };
    const client = createRemoteVfsClient({
      transport,
      requestTimeoutMs: 0,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const p = client.readDir('/hang');

    await tick(40);
    client.dispose();
    await expect(p).rejects.toMatchObject({ name: 'FsError', code: 'EBADF' });
  });

  it('a response received before the timeout cancels it (resolves, no late rejection)', async () => {
    let handler: ((m: ExtensionMessage) => void) | null = null;
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send(payload) {
        const req = payload as { type: string; requestId: string };
        handler?.({
          source: 'offscreen',
          payload: {
            type: 'vfs-read-dir-result',
            requestId: req.requestId,
            ok: true,
            entries: [],
          } as VfsReadDirResultMsg,
        } as ExtensionMessage);
      },
    };
    const client = createRemoteVfsClient({
      transport,
      requestTimeoutMs: 20,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    await expect(client.readDir('/x')).resolves.toEqual([]);

    await tick(40);
    client.dispose();
  });
});

describe('RemoteVfsClient — dispose semantics', () => {
  it('rejects pending requests on dispose', async () => {
    const transport: KernelTransport<ExtensionMessage, PanelToOffscreenMessage> = {
      onMessage: () => () => {},
      send: () => {},
    };
    const client = createRemoteVfsClient({ transport, logger: { warn: vi.fn(), debug: vi.fn() } });
    const p = client.readDir('/hang');

    await tick(0);
    client.dispose();
    await expect(p).rejects.toMatchObject({ name: 'FsError', code: 'EBADF' });
  });
});

describe('RemoteVfsClient — watch', () => {
  it('delivers change batches for the subscribed roots', async () => {
    const watcher = new FsWatcher();
    const ctx = setupRoundTrip(() => watcher);
    const seen: FsChangeEvent[][] = [];
    const unwatch = await ctx.client.watch(['/workspace', '/shared'], (events) =>
      seen.push(events)
    );

    watcher.notify([{ type: 'create', path: '/workspace/new.txt', entryType: 'file' }]);
    await tick(10);
    expect(seen).toEqual([[{ type: 'create', path: '/workspace/new.txt', entryType: 'file' }]]);

    watcher.notify([{ type: 'create', path: '/etc/hosts', entryType: 'file' }]);
    await tick(10);
    expect(seen).toHaveLength(1);

    unwatch();
    ctx.stop();
  });

  it('unsubscribe releases the host-side registration (no listener leak)', async () => {
    const watcher = new FsWatcher();
    const ctx = setupRoundTrip(() => watcher);

    for (let i = 0; i < 10; i++) {
      const unwatch = await ctx.client.watch(['/workspace'], () => undefined);
      expect(watcher.size).toBe(1);
      unwatch();
      await tick(5);
      expect(watcher.size).toBe(0);
    }
    ctx.stop();
  });

  it('rejects with ENOSYS when the host has no watcher wired', async () => {
    const ctx = setupRoundTrip();
    await expect(ctx.client.watch(['/workspace'], () => undefined)).rejects.toMatchObject({
      code: 'ENOSYS',
    });
    ctx.stop();
  });

  it('rejects an in-flight subscribe when the client is disposed', async () => {
    const channel = new MessageChannel();

    const panel = createPanelMessageChannelTransport(channel.port1);
    const client = createRemoteVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const pending = client.watch(['/workspace'], () => undefined);
    const settled = expect(pending).rejects.toMatchObject({ code: 'EBADF' });
    client.dispose();
    await settled;
    channel.port1.close();
    channel.port2.close();
  });

  it('dispose drops host-side subscriptions too', async () => {
    const watcher = new FsWatcher();
    const ctx = setupRoundTrip(() => watcher);
    await ctx.client.watch(['/workspace'], () => undefined);
    expect(watcher.size).toBe(1);
    ctx.client.dispose();
    await tick(10);
    expect(watcher.size).toBe(0);
    ctx.stop();
  });
});
