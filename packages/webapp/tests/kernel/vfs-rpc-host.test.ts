/**
 * Tests for `VfsRpcHost` — the worker-side VFS read RPC surface.
 *
 * Pins:
 *  - readDir / readFile / stat round-trip over a real MessageChannel
 *    pair (mirrors the kernel-worker / page wire shape).
 *  - Binary readFile responses carry the bytes as `Uint8Array` (no
 *    base64 copy) and request transfer of the backing buffer.
 *  - FsError throws map onto the failure branch with the POSIX code.
 *  - Non-vfs envelopes and non-panel-source envelopes are ignored.
 *  - The chrome.runtime transport silently ignores the transfer list
 *    (verified by a stub transport that records the second argument).
 *  - dispose() stops the subscriber.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, ReadFileOptions, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  VfsReadDirResultMsg,
  VfsReadFileResultMsg,
  VfsReadRequestMsg,
  VfsStatResultMsg,
} from '../../src/kernel/messages.js';
import type { KernelTransport } from '../../src/kernel/transport.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Deterministic replacement for `await tick(N)` when the test needs to
 * observe a response that hops port1 -> port2 -> async handler -> port2
 * -> port1. On loaded CI runners (Node 24/25) the worker_threads
 * MessagePort delivery can drift past a fixed-budget setTimeout, which
 * is what makes a single `tick(20)` flaky for the very first test in
 * this file. Polling `ctx.responses.length` removes that drift.
 */
async function waitForResponses(
  ctx: { responses: unknown[] },
  expected = 1,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (ctx.responses.length < expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${expected} response(s); got ${ctx.responses.length}`
      );
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

function makeStubVfs(overrides?: Partial<LocalVfsClient>): {
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
  return {
    client: { readDir, readFile, stat, ...overrides },
    readDir,
    readFile,
    stat,
  };
}

interface RoundTripCtx {
  panelTransport: KernelTransport<ExtensionMessage, ReturnType<typeof noop>>;
  responses: OffscreenToPanelMessage[];
  vfs: ReturnType<typeof makeStubVfs>;
  channel: MessageChannel;
  stop: () => void;
}

function noop(): unknown {
  return null;
}

function setupRoundTrip(client?: LocalVfsClient): RoundTripCtx {
  const channel = new MessageChannel();
  const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
  const vfs = client ? { ...makeStubVfs(), client } : makeStubVfs();
  const handle = startVfsRpcHost({
    transport: bridgeTransport,
    client: vfs.client,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const panelTransport = createPanelMessageChannelTransport(channel.port1);
  const responses: OffscreenToPanelMessage[] = [];
  panelTransport.onMessage((envelope) => {
    if (envelope.source !== 'offscreen') return;
    responses.push(envelope.payload as OffscreenToPanelMessage);
  });
  return {
    panelTransport,
    responses,
    vfs,
    channel,
    stop: () => {
      handle.stop();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('VfsRpcHost round-trip over MessageChannel', () => {
  it('readDir success returns entries on the ok branch', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readDir.mockResolvedValue([
      { name: 'a.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
    ] satisfies DirEntry[]);
    const req: VfsReadRequestMsg = { type: 'vfs-read-dir', requestId: 'r1', path: '/workspace' };
    ctx.panelTransport.send(req);
    await waitForResponses(ctx);
    expect(ctx.vfs.readDir).toHaveBeenCalledWith('/workspace');
    expect(ctx.responses).toHaveLength(1);
    const resp = ctx.responses[0] as VfsReadDirResultMsg;
    expect(resp.type).toBe('vfs-read-dir-result');
    expect(resp.requestId).toBe('r1');
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.entries).toEqual([
        { name: 'a.txt', type: 'file' },
        { name: 'sub', type: 'directory' },
      ]);
    }
    ctx.stop();
  });

  it('readFile utf-8 returns the string payload', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockResolvedValue('hello world');
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r2',
      path: '/notes.md',
      encoding: 'utf-8',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    expect(ctx.vfs.readFile).toHaveBeenCalledWith('/notes.md', { encoding: 'utf-8' });
    const resp = ctx.responses[0] as VfsReadFileResultMsg;
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.encoding).toBe('utf-8');
      expect(resp.data).toBe('hello world');
    }
    ctx.stop();
  });

  it('readFile defaults to utf-8 when encoding is omitted', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockResolvedValue('default');
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r2b',
      path: '/notes.md',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    expect(ctx.vfs.readFile).toHaveBeenCalledWith('/notes.md', { encoding: 'utf-8' });
    ctx.stop();
  });

  it('readFile binary returns Uint8Array (round-tripping bytes verbatim)', async () => {
    const ctx = setupRoundTrip();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    ctx.vfs.readFile.mockResolvedValue(bytes);
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r3',
      path: '/image.png',
      encoding: 'binary',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsReadFileResultMsg;
    expect(resp.ok).toBe(true);
    if (resp.ok && resp.encoding === 'binary') {
      expect(resp.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(resp.data)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    }
    ctx.stop();
  });

  it('stat success returns the stats envelope', async () => {
    const ctx = setupRoundTrip();
    const stats: Stats = { type: 'file', size: 1234, mtime: 555, ctime: 444 };
    ctx.vfs.stat.mockResolvedValue(stats);
    ctx.panelTransport.send({
      type: 'vfs-stat',
      requestId: 'r4',
      path: '/file',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsStatResultMsg;
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.stats).toEqual({ type: 'file', size: 1234, mtime: 555, ctime: 444 });
    }
    ctx.stop();
  });

  it('FsError ENOENT maps to the failure branch with the POSIX code', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockRejectedValue(new FsError('ENOENT', 'no such file', '/missing'));
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r5',
      path: '/missing',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsReadFileResultMsg;
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('ENOENT');
      expect(resp.error.path).toBe('/missing');
      expect(resp.error.message).toContain('ENOENT');
    }
    ctx.stop();
  });

  it('non-FsError throws map to EIO on the failure branch', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readDir.mockRejectedValue(new Error('disk on fire'));
    ctx.panelTransport.send({
      type: 'vfs-read-dir',
      requestId: 'r6',
      path: '/wherever',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsReadDirResultMsg;
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('EIO');
      expect(resp.error.message).toBe('disk on fire');
      expect(resp.error.path).toBe('/wherever');
    }
    ctx.stop();
  });

  it('readFile(binary) that returns a string is reported as EIO (defensive)', async () => {
    const ctx = setupRoundTrip();
    // Defensive: shouldn't happen with VirtualFS, but pin the safety net.
    ctx.vfs.readFile.mockResolvedValue('not bytes' as unknown as Uint8Array);
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r7',
      path: '/oops',
      encoding: 'binary',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsReadFileResultMsg;
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('EIO');
    }
    ctx.stop();
  });

  it('readFile(utf-8) that returns bytes is reported as EIO (defensive)', async () => {
    const ctx = setupRoundTrip();
    ctx.vfs.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    ctx.panelTransport.send({
      type: 'vfs-read-file',
      requestId: 'r7b',
      path: '/oops2',
      encoding: 'utf-8',
    } satisfies VfsReadRequestMsg);
    await waitForResponses(ctx, 1);
    const resp = ctx.responses[0] as VfsReadFileResultMsg;
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('EIO');
    }
    ctx.stop();
  });

  it('ignores envelopes that are not vfs-* requests', async () => {
    const ctx = setupRoundTrip();
    // Send a non-vfs message; the host should not respond and the VFS
    // client should not be touched.
    ctx.panelTransport.send({ type: 'request-state' } as never);
    await tick();
    expect(ctx.responses).toHaveLength(0);
    expect(ctx.vfs.readDir).not.toHaveBeenCalled();
    expect(ctx.vfs.readFile).not.toHaveBeenCalled();
    expect(ctx.vfs.stat).not.toHaveBeenCalled();
    ctx.stop();
  });

  it('dispose() stops further request handling', async () => {
    const ctx = setupRoundTrip();
    ctx.stop();
    // Re-issue a request on a freshly-built channel pair so we can
    // verify the host doesn't pick it up after stop().
    const channel2 = new MessageChannel();
    const bridge2 = createBridgeMessageChannelTransport(channel2.port2);
    const vfs2 = makeStubVfs();
    const handle = startVfsRpcHost({
      transport: bridge2,
      client: vfs2.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    handle.stop();
    const panel2 = createPanelMessageChannelTransport(channel2.port1);
    panel2.send({
      type: 'vfs-read-dir',
      requestId: 'r-stopped',
      path: '/',
    } satisfies VfsReadRequestMsg);
    await tick();
    expect(vfs2.readDir).not.toHaveBeenCalled();
    channel2.port1.close();
    channel2.port2.close();
  });
});

describe('VfsRpcHost — source / envelope filtering', () => {
  it('ignores envelopes with source !== "panel"', async () => {
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const vfs = makeStubVfs();
    const handle = startVfsRpcHost({
      transport: bridge,
      client: vfs.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    // Inject an envelope tagged as if it came from the offscreen side —
    // the host must ignore it (would otherwise reflect its own responses).
    channel.port1.postMessage({
      source: 'offscreen',
      payload: { type: 'vfs-read-dir', requestId: 'spoofed', path: '/' },
    });
    await tick();
    expect(vfs.readDir).not.toHaveBeenCalled();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('ignores raw non-envelope messages', async () => {
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const vfs = makeStubVfs();
    const handle = startVfsRpcHost({
      transport: bridge,
      client: vfs.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    channel.port1.postMessage({ type: 'vfs-read-dir', requestId: 'naked', path: '/' });
    await tick();
    expect(vfs.readDir).not.toHaveBeenCalled();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });
});

describe('VfsRpcHost — transfer list', () => {
  it('binary readFile passes the ArrayBuffer in the transport transfer list', async () => {
    const vfs = makeStubVfs();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vfs.readFile.mockResolvedValue(bytes);

    // Mock transport so we can inspect the transfer argument that the
    // host hands to send(). The chrome.runtime adapter ignores this
    // list; the MessageChannel adapter forwards it to postMessage.
    let handler: ((m: ExtensionMessage) => void) | null = null;
    const sends: Array<{
      payload: OffscreenToPanelMessage;
      transfer: Transferable[] | undefined;
    }> = [];
    const transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };

    const handle = startVfsRpcHost({
      transport,
      client: vfs.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    // Hand-craft a panel-source envelope.
    // handler is assigned inside the transport's onMessage closure; TS's CFA
    // narrows the variable to null here, so read it through a cast.
    (handler as ((m: ExtensionMessage) => void) | null)?.({
      source: 'panel',
      payload: {
        type: 'vfs-read-file',
        requestId: 'tx',
        path: '/blob.bin',
        encoding: 'binary',
      },
    } as ExtensionMessage);
    await tick();
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    expect(sent.payload.type).toBe('vfs-read-file-result');
    expect(sent.transfer).toBeDefined();
    expect(sent.transfer).toHaveLength(1);
    // The transferred item is the underlying ArrayBuffer.
    expect(sent.transfer?.[0]).toBe(bytes.buffer);
    handle.stop();
  });

  it('utf-8 readFile does NOT pass a transfer list', async () => {
    const vfs = makeStubVfs();
    vfs.readFile.mockResolvedValue('plain text');

    let handler: ((m: ExtensionMessage) => void) | null = null;
    const sends: Array<{
      payload: OffscreenToPanelMessage;
      transfer: Transferable[] | undefined;
    }> = [];
    const transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };
    const handle = startVfsRpcHost({
      transport,
      client: vfs.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    // handler is assigned inside the transport's onMessage closure; TS's CFA
    // narrows the variable to null here, so read it through a cast.
    (handler as ((m: ExtensionMessage) => void) | null)?.({
      source: 'panel',
      payload: { type: 'vfs-read-file', requestId: 'u', path: '/x', encoding: 'utf-8' },
    } as ExtensionMessage);
    await tick();
    expect(sends).toHaveLength(1);
    expect(sends[0].transfer).toBeUndefined();
    handle.stop();
  });

  it('error responses are sent without a transfer list', async () => {
    const vfs = makeStubVfs();
    vfs.readFile.mockRejectedValue(new FsError('ENOENT', 'gone', '/x'));

    let handler: ((m: ExtensionMessage) => void) | null = null;
    const sends: Array<{
      payload: OffscreenToPanelMessage;
      transfer: Transferable[] | undefined;
    }> = [];
    const transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage> = {
      onMessage(h) {
        handler = h;
        return () => {
          handler = null;
        };
      },
      send(payload, transfer) {
        sends.push({ payload, transfer });
      },
    };
    const handle = startVfsRpcHost({
      transport,
      client: vfs.client,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    // handler is assigned inside the transport's onMessage closure; TS's CFA
    // narrows the variable to null here, so read it through a cast.
    (handler as ((m: ExtensionMessage) => void) | null)?.({
      source: 'panel',
      payload: { type: 'vfs-read-file', requestId: 'e', path: '/x', encoding: 'binary' },
    } as ExtensionMessage);
    await tick();
    expect(sends).toHaveLength(1);
    expect(sends[0].transfer).toBeUndefined();
    handle.stop();
  });
});
