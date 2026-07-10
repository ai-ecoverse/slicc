/**
 * Tests for `WritableVfsClient` and the write-side extensions to
 * `VfsRpcHost`.
 *
 * Pins:
 *  - writeFile (utf-8 + binary) / mkdir / rm / flush round-trip over a
 *    real MessageChannel pair against a stub `WritableVfsBackend`.
 *  - Binary writeFile passes the underlying ArrayBuffer in the
 *    transport's transfer list.
 *  - FsError throws on the backend map onto the failure branch with
 *    the POSIX code; non-FsError throws collapse to EIO.
 *  - Without `writableClient` configured, write requests are answered
 *    with EACCES (fail-fast for a stray writer against a read-only
 *    host).
 *  - Read surface (B1) still works on the combined client.
 *  - dispose() rejects in-flight writes with EBADF.
 *  - flush() error envelope drops the empty-path sentinel.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DirEntry,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
  WriteFileOptions,
} from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  VfsFlushResultMsg,
  VfsMkdirResultMsg,
  VfsRmResultMsg,
  VfsWriteFileResultMsg,
} from '../../src/kernel/messages.js';
import { createRemoteVfsClient } from '../../src/kernel/remote-vfs-client.js';
import type { KernelTransport } from '../../src/kernel/transport.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';
import {
  createRemoteWritableVfsClient,
  type WritableVfsBackend,
} from '../../src/kernel/writable-vfs-client.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeStubReadVfs(): {
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

function makeStubWriteBackend(): {
  backend: WritableVfsBackend;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  rm: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  listMountPoints: ReturnType<typeof vi.fn>;
} {
  const writeFile = vi.fn(
    async (_path: string, _content: FileContent, _opts?: WriteFileOptions): Promise<void> => {}
  );
  const mkdir = vi.fn(async (_path: string, _opts?: MkdirOptions): Promise<void> => {});
  const rm = vi.fn(async (_path: string, _opts?: RmOptions): Promise<void> => {});
  const flush = vi.fn(async (): Promise<void> => {});
  const listMountPoints = vi.fn(() => [{ path: '/tmp/mounted', kind: 'local' as const }]);
  return {
    backend: { writeFile, mkdir, rm, flush, listMountPoints },
    writeFile,
    mkdir,
    rm,
    flush,
    listMountPoints,
  };
}

interface RoundTripCtx {
  read: ReturnType<typeof makeStubReadVfs>;
  write: ReturnType<typeof makeStubWriteBackend>;
  client: ReturnType<typeof createRemoteWritableVfsClient>;
  channel: MessageChannel;
  stop: () => void;
}

function setupRoundTrip(opts?: { withWritable?: boolean }): RoundTripCtx {
  const channel = new MessageChannel();
  const bridge = createBridgeMessageChannelTransport(channel.port2);
  const read = makeStubReadVfs();
  const write = makeStubWriteBackend();
  const host = startVfsRpcHost({
    transport: bridge,
    client: read.client,
    writableClient: opts?.withWritable === false ? undefined : write.backend,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const panel = createPanelMessageChannelTransport(channel.port1);
  const client = createRemoteWritableVfsClient({
    transport: panel,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  return {
    read,
    write,
    client,
    channel,
    stop: () => {
      client.dispose();
      host.stop();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('WritableVfsClient — write round-trip over MessageChannel', () => {
  it('writeFile utf-8 round-trips and resolves void', async () => {
    const ctx = setupRoundTrip();
    const result = ctx.client.writeFile('/notes.md', 'hello world');
    await expect(result).resolves.toBeUndefined();
    expect(ctx.write.writeFile).toHaveBeenCalledTimes(1);
    const [path, data, options] = ctx.write.writeFile.mock.calls[0];
    expect(path).toBe('/notes.md');
    expect(data).toBe('hello world');
    expect(options).toBeUndefined();
    ctx.stop();
  });

  it('writeFile passes recursive option when set', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.writeFile('/a/b/notes.md', 'x', { recursive: true });
    const [, , options] = ctx.write.writeFile.mock.calls[0];
    expect(options).toEqual({ recursive: true });
    ctx.stop();
  });

  it('writeFile binary round-trips bytes verbatim', async () => {
    const ctx = setupRoundTrip();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    await ctx.client.writeFile('/image.png', bytes);
    expect(ctx.write.writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = ctx.write.writeFile.mock.calls[0];
    expect(path).toBe('/image.png');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    ctx.stop();
  });

  it('mkdir round-trips with recursive', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.mkdir('/workspace/sessions', { recursive: true });
    expect(ctx.write.mkdir).toHaveBeenCalledWith('/workspace/sessions', { recursive: true });
    ctx.stop();
  });

  it('mkdir without options omits options argument', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.mkdir('/a');
    expect(ctx.write.mkdir).toHaveBeenCalledWith('/a', undefined);
    ctx.stop();
  });

  it('rm round-trips with recursive', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.rm('/sessions/pending-x.md', { recursive: true });
    expect(ctx.write.rm).toHaveBeenCalledWith('/sessions/pending-x.md', { recursive: true });
    ctx.stop();
  });

  it('rm without options omits options argument', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.rm('/sessions/pending-x.md');
    expect(ctx.write.rm).toHaveBeenCalledWith('/sessions/pending-x.md', undefined);
    ctx.stop();
  });

  it('flush round-trips and resolves void', async () => {
    const ctx = setupRoundTrip();
    await ctx.client.flush();
    expect(ctx.write.flush).toHaveBeenCalledTimes(1);
    ctx.stop();
  });

  it('listMountPoints round-trips the worker-owned mount registry', async () => {
    const ctx = setupRoundTrip();
    await expect(ctx.client.listMountPoints()).resolves.toEqual([
      { path: '/tmp/mounted', kind: 'local' },
    ]);
    expect(ctx.write.listMountPoints).toHaveBeenCalledTimes(1);
    ctx.stop();
  });

  it('listMountPoints fails fast when the writable backend has no mount registry', async () => {
    const ctx = setupRoundTrip();
    delete ctx.write.backend.listMountPoints;

    await expect(ctx.client.listMountPoints()).rejects.toMatchObject({ code: 'EACCES' });
    ctx.stop();
  });

  it('FsError on writeFile maps to failure branch with POSIX code', async () => {
    const ctx = setupRoundTrip();
    ctx.write.writeFile.mockRejectedValueOnce(new FsError('EISDIR', 'is a directory', '/d'));
    await expect(ctx.client.writeFile('/d', 'x')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EISDIR',
      path: '/d',
    });
    ctx.stop();
  });

  it('non-FsError throws collapse to EIO', async () => {
    const ctx = setupRoundTrip();
    ctx.write.writeFile.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(ctx.client.writeFile('/x', 'y')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EIO',
    });
    ctx.stop();
  });

  it('FsError on flush is reported without a spurious empty path', async () => {
    const ctx = setupRoundTrip();
    ctx.write.flush.mockRejectedValueOnce(new FsError('EIO', 'flush failed'));
    try {
      await ctx.client.flush();
      throw new Error('expected reject');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('EIO');
      // The page reconstructs `FsError` with `path = error.path ?? pending.path`;
      // pending.path is '' for flush, so the worker must not echo back a
      // path it didn't have.
      expect((err as FsError).path).toBe('');
    }
    ctx.stop();
  });

  it('writeFile rejects EINVAL when content is neither string nor Uint8Array', async () => {
    const ctx = setupRoundTrip();
    await expect(ctx.client.writeFile('/x', 42 as unknown as FileContent)).rejects.toMatchObject({
      name: 'FsError',
      code: 'EINVAL',
      path: '/x',
    });
    expect(ctx.write.writeFile).not.toHaveBeenCalled();
    ctx.stop();
  });

  it('read surface still works (readDir / readFile / stat)', async () => {
    const ctx = setupRoundTrip();
    ctx.read.readDir.mockResolvedValue([{ name: 'a.txt', type: 'file' }]);
    ctx.read.readFile.mockResolvedValue('hello');
    ctx.read.stat.mockResolvedValue({ type: 'file', size: 5, mtime: 1, ctime: 2 });
    const [entries, content, stats] = await Promise.all([
      ctx.client.readDir('/workspace'),
      ctx.client.readFile('/x.txt'),
      ctx.client.stat('/x.txt'),
    ]);
    expect(entries).toEqual([{ name: 'a.txt', type: 'file' }]);
    expect(content).toBe('hello');
    expect(stats).toEqual({ type: 'file', size: 5, mtime: 1, ctime: 2 });
    ctx.stop();
  });

  it('dispose() rejects in-flight writes with EBADF', async () => {
    const ctx = setupRoundTrip();
    // Block the backend so the request hangs in-flight.
    let _resolveBackend: () => void = () => {};
    ctx.write.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          _resolveBackend = res;
        })
    );
    const pending = ctx.client.writeFile('/blocked', 'x');
    await tick();
    ctx.client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'EBADF', path: '/blocked' });
    // Unblock so the backend doesn't leak past the test.
    _resolveBackend();
    ctx.channel.port1.close();
    ctx.channel.port2.close();
  });
});

describe('VFS clients sharing one transport — sibling-response handling', () => {
  // Regression: in standalone the page constructs BOTH a `RemoteVfsClient`
  // (reader, ids `vfs-…`) and a `RemoteWritableVfsClient` (writer, ids
  // `vfs-w-…`) on the SAME kernel transport. Both match `vfs-read-*-result`
  // envelopes, so every read response is delivered to both clients. The
  // non-owner must drop it SILENTLY — the previous "drop unmatched response"
  // debug log fired once per read on the wrong client, flooding the console
  // (and the page→node-server relay) under leader load.
  it('writable client does not log a drop for a sibling reader response', async () => {
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const read = makeStubReadVfs();
    const write = makeStubWriteBackend();
    const host = startVfsRpcHost({
      transport: bridge,
      client: read.client,
      writableClient: write.backend,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panel = createPanelMessageChannelTransport(channel.port1);
    const writerDebug = vi.fn();
    const writer = createRemoteWritableVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: writerDebug },
    });
    const reader = createRemoteVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    read.readDir.mockResolvedValue([{ name: 'a.txt', type: 'file' }]);
    await expect(reader.readDir('/workspace')).resolves.toEqual([{ name: 'a.txt', type: 'file' }]);
    await tick();

    expect(writerDebug).not.toHaveBeenCalled();

    reader.dispose();
    writer.dispose();
    host.stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('reader does not log a drop for a sibling writable-client read response', async () => {
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const read = makeStubReadVfs();
    const write = makeStubWriteBackend();
    const host = startVfsRpcHost({
      transport: bridge,
      client: read.client,
      writableClient: write.backend,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panel = createPanelMessageChannelTransport(channel.port1);
    const readerDebug = vi.fn();
    const reader = createRemoteVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: readerDebug },
    });
    const writer = createRemoteWritableVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    read.readFile.mockResolvedValue('hi');
    await expect(writer.readFile('/x.txt')).resolves.toBe('hi');
    await tick();

    expect(readerDebug).not.toHaveBeenCalled();

    reader.dispose();
    writer.dispose();
    host.stop();
    channel.port1.close();
    channel.port2.close();
  });
});

describe('VfsRpcHost — write requests without writableClient', () => {
  it('replies EACCES when no writable backend is wired', async () => {
    const ctx = setupRoundTrip({ withWritable: false });
    await expect(ctx.client.writeFile('/x', 'y')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EACCES',
    });
    await expect(ctx.client.mkdir('/d', { recursive: true })).rejects.toMatchObject({
      code: 'EACCES',
    });
    await expect(ctx.client.rm('/p')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(ctx.client.flush()).rejects.toMatchObject({ code: 'EACCES' });
    ctx.stop();
  });
});

describe('VfsRpcHost — transfer list (write side)', () => {
  it('binary writeFile passes the ArrayBuffer in the transport transfer list', async () => {
    // Mock transport so we can inspect the transfer argument that the
    // panel-side client hands to send().
    const sends: Array<{ payload: unknown; transfer: Transferable[] | undefined }> = [];
    let _hostHandler: ((m: ExtensionMessage) => void) | null = null;
    const panelTransport: KernelTransport<ExtensionMessage, unknown> = {
      onMessage(h) {
        _hostHandler = h;
        return () => {
          _hostHandler = null;
        };
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };

    const client = createRemoteWritableVfsClient({
      transport: panelTransport as KernelTransport<
        ExtensionMessage,
        // biome-ignore lint/suspicious/noExplicitAny: test stub matches the wire shape
        any
      >,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    // Fire-and-forget — the stub transport never replies, so the
    // promise stays pending. We only care about what was sent.
    void client.writeFile('/blob.bin', bytes).catch(() => {});
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    expect((sent.payload as { type: string }).type).toBe('vfs-write-file');
    expect(sent.transfer).toBeDefined();
    expect(sent.transfer).toHaveLength(1);
    expect(sent.transfer?.[0]).toBe(bytes.buffer);
    client.dispose();
  });

  it('utf-8 writeFile does NOT pass a transfer list', async () => {
    const sends: Array<{ payload: unknown; transfer: Transferable[] | undefined }> = [];
    const panelTransport: KernelTransport<ExtensionMessage, unknown> = {
      onMessage() {
        return () => {};
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };
    const client = createRemoteWritableVfsClient({
      transport: panelTransport as KernelTransport<
        ExtensionMessage,
        // biome-ignore lint/suspicious/noExplicitAny: test stub matches the wire shape
        any
      >,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    void client.writeFile('/x.txt', 'hello').catch(() => {});
    expect(sends).toHaveLength(1);
    expect(sends[0].transfer).toBeUndefined();
    client.dispose();
  });

  it('mkdir / rm / flush do NOT pass a transfer list', async () => {
    const sends: Array<{ payload: unknown; transfer: Transferable[] | undefined }> = [];
    const panelTransport: KernelTransport<ExtensionMessage, unknown> = {
      onMessage() {
        return () => {};
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };
    const client = createRemoteWritableVfsClient({
      transport: panelTransport as KernelTransport<
        ExtensionMessage,
        // biome-ignore lint/suspicious/noExplicitAny: test stub matches the wire shape
        any
      >,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    void client.mkdir('/d', { recursive: true }).catch(() => {});
    void client.rm('/p').catch(() => {});
    void client.flush().catch(() => {});
    expect(sends).toHaveLength(3);
    for (const s of sends) expect(s.transfer).toBeUndefined();
    client.dispose();
  });
});

describe('VfsRpcHost — write success-branch wire shape', () => {
  it('emits ok:true responses without extra payload fields', async () => {
    // End-to-end via the round-trip harness but inspect the raw
    // envelopes the host emits, to lock the success-branch wire shape.
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const read = makeStubReadVfs();
    const write = makeStubWriteBackend();
    const host = startVfsRpcHost({
      transport: bridge,
      client: read.client,
      writableClient: write.backend,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panel = createPanelMessageChannelTransport(channel.port1);
    const seen: OffscreenToPanelMessage[] = [];
    panel.onMessage((envelope) => {
      if (envelope.source !== 'offscreen') return;
      seen.push(envelope.payload as OffscreenToPanelMessage);
    });
    panel.send({
      type: 'vfs-write-file',
      requestId: 'w1',
      path: '/x',
      encoding: 'utf-8',
      data: 'a',
    });
    panel.send({ type: 'vfs-mkdir', requestId: 'm1', path: '/d' });
    panel.send({ type: 'vfs-rm', requestId: 'r1', path: '/p' });
    panel.send({ type: 'vfs-flush', requestId: 'f1' });
    await tick(25);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toEqual({
      type: 'vfs-write-file-result',
      requestId: 'w1',
      ok: true,
    } satisfies VfsWriteFileResultMsg);
    expect(seen[1]).toEqual({
      type: 'vfs-mkdir-result',
      requestId: 'm1',
      ok: true,
    } satisfies VfsMkdirResultMsg);
    expect(seen[2]).toEqual({
      type: 'vfs-rm-result',
      requestId: 'r1',
      ok: true,
    } satisfies VfsRmResultMsg);
    expect(seen[3]).toEqual({
      type: 'vfs-flush-result',
      requestId: 'f1',
      ok: true,
    } satisfies VfsFlushResultMsg);
    host.stop();
    channel.port1.close();
    channel.port2.close();
  });
});
