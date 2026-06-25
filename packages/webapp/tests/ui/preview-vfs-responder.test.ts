/**
 * Tests for `installPreviewVfsResponder` — the page-side endpoint the
 * `/preview/*` service worker (`preview-sw.ts`) talks to.
 *
 * Pins:
 *  - `asText: true`  → `readFile({ encoding: 'utf-8' })`, response carries `content: string`.
 *  - `asText: false` → `readFile({ encoding: 'binary' })`, response carries `content: Uint8Array`.
 *  - Errors round-trip on the failure branch (`error: string`) and ENOENT is silent.
 *  - The reader is resolved per-request, so a swap (e.g. `localFs` → `RemoteVfsClient`)
 *    takes effect on the next message without reinstalling the listener.
 *  - End-to-end with a real `VfsRpcHost` + `RemoteVfsClient` round-trips through
 *    the kernel transport (the canonical OPFS-flag-on path).
 */

import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, ReadFileOptions, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import { createRemoteVfsClient } from '../../src/kernel/remote-vfs-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';
import {
  installPreviewVfsResponder,
  type PreviewVfsChannelLike,
  type PreviewVfsResponse,
} from '../../src/ui/preview-vfs-responder.js';

class FakeChannel implements PreviewVfsChannelLike {
  readonly outbound: unknown[] = [];
  private listeners = new Set<(ev: MessageEvent) => void>();
  postMessage(data: unknown): void {
    this.outbound.push(data);
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.listeners.clear();
  }
  /** Simulate an inbound SW message — bypasses the structured-clone hop. */
  emit(data: unknown): void {
    for (const l of this.listeners) l(new MessageEvent('message', { data }));
  }
}

function makeStubVfs(): {
  client: LocalVfsClient;
  readDir: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
} {
  const readDir = vi.fn(async (_p: string): Promise<DirEntry[]> => []);
  const readFile = vi.fn(
    async (_p: string, _o?: ReadFileOptions): Promise<string | Uint8Array> => ''
  );
  const stat = vi.fn(
    async (_p: string): Promise<Stats> => ({ type: 'file', size: 0, mtime: 0, ctime: 0 })
  );
  return { client: { readDir, readFile, stat }, readDir, readFile, stat };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Outbound `preview-vfs-response` envelopes (skips the receipt acks). */
function responsesOf(ch: FakeChannel): PreviewVfsResponse[] {
  return ch.outbound.filter(
    (m): m is PreviewVfsResponse => (m as { type?: string })?.type === 'preview-vfs-response'
  );
}

/** Outbound `preview-vfs-ack` envelopes. */
function acksOf(ch: FakeChannel): Array<{ type: 'preview-vfs-ack'; id: string }> {
  return ch.outbound.filter(
    (m): m is { type: 'preview-vfs-ack'; id: string } =>
      (m as { type?: string })?.type === 'preview-vfs-ack'
  );
}

describe('installPreviewVfsResponder', () => {
  it('acks on receipt before the read resolves', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    let resolveRead: (v: string) => void = () => {};
    vfs.readFile.mockImplementation(() => new Promise<string>((r) => (resolveRead = r)));
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });

    ch.emit({ type: 'preview-vfs-read', id: 'ack1', path: '/slow', asText: true });
    await tick();

    // Ack is posted synchronously on receipt, before the pending read settles.
    expect(acksOf(ch)).toEqual([{ type: 'preview-vfs-ack', id: 'ack1' }]);
    expect(responsesOf(ch)).toHaveLength(0);

    resolveRead('done');
    await tick();
    expect(responsesOf(ch)).toHaveLength(1);
  });

  it('asText=true reads as utf-8 and responds with a string', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    vfs.readFile.mockResolvedValue('<html>ok</html>');
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });

    ch.emit({ type: 'preview-vfs-read', id: 'p1', path: '/preview/index.html', asText: true });
    await tick();

    expect(vfs.readFile).toHaveBeenCalledWith('/preview/index.html', { encoding: 'utf-8' });
    expect(acksOf(ch)).toEqual([{ type: 'preview-vfs-ack', id: 'p1' }]);
    const resps = responsesOf(ch);
    expect(resps).toHaveLength(1);
    const resp = resps[0] as PreviewVfsResponse;
    expect(resp).toMatchObject({ type: 'preview-vfs-response', id: 'p1' });
    expect('content' in resp && resp.content).toBe('<html>ok</html>');
  });

  it('asText=false reads as binary and responds with a Uint8Array', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vfs.readFile.mockResolvedValue(bytes);
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });

    ch.emit({ type: 'preview-vfs-read', id: 'p2', path: '/preview/logo.png', asText: false });
    await tick();

    expect(vfs.readFile).toHaveBeenCalledWith('/preview/logo.png', { encoding: 'binary' });
    const resp = responsesOf(ch)[0] as PreviewVfsResponse;
    expect('content' in resp).toBe(true);
    if ('content' in resp) expect(resp.content).toBeInstanceOf(Uint8Array);
  });

  it('non-ENOENT errors are logged and round-trip as { error }', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    vfs.readFile.mockRejectedValue(new Error('disk on fire'));
    const logger = { error: vi.fn() };
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client, logger });

    ch.emit({ type: 'preview-vfs-read', id: 'p3', path: '/x', asText: true });
    await tick();

    const resp = responsesOf(ch)[0] as PreviewVfsResponse;
    expect('error' in resp && resp.error).toBe('disk on fire');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('ENOENT errors round-trip silently (no log)', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    vfs.readFile.mockRejectedValue(new FsError('ENOENT', 'no such file', '/missing'));
    const logger = { error: vi.fn() };
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client, logger });

    ch.emit({ type: 'preview-vfs-read', id: 'p4', path: '/missing', asText: true });
    await tick();

    const resp = responsesOf(ch)[0] as PreviewVfsResponse;
    expect('error' in resp).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('ignores non-preview-vfs-read envelopes', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });

    ch.emit({ type: 'something-else', id: 'ignored' });
    ch.emit(undefined);
    await tick();

    expect(vfs.readFile).not.toHaveBeenCalled();
    expect(ch.outbound).toHaveLength(0);
  });

  it('reader swap takes effect on the next request (flag flip path)', async () => {
    const ch = new FakeChannel();
    const initial = makeStubVfs();
    initial.readFile.mockResolvedValue('from-local');
    const swapped = makeStubVfs();
    swapped.readFile.mockResolvedValue('from-rpc');
    let reader = initial.client;
    installPreviewVfsResponder({ channel: ch, getReader: () => reader });

    ch.emit({ type: 'preview-vfs-read', id: 'a', path: '/a', asText: true });
    await tick();
    reader = swapped.client;
    ch.emit({ type: 'preview-vfs-read', id: 'b', path: '/b', asText: true });
    await tick();

    expect(initial.readFile).toHaveBeenCalledTimes(1);
    expect(swapped.readFile).toHaveBeenCalledTimes(1);
    const [r0, r1] = responsesOf(ch);
    expect('content' in (r0 as PreviewVfsResponse) && (r0 as { content: string }).content).toBe(
      'from-local'
    );
    expect('content' in (r1 as PreviewVfsResponse) && (r1 as { content: string }).content).toBe(
      'from-rpc'
    );
  });

  it('dispose() stops further request handling', async () => {
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    const handle = installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });
    handle.dispose();

    ch.emit({ type: 'preview-vfs-read', id: 'p', path: '/x', asText: true });
    await tick();
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('directory paths surface EISDIR so the SW falls back to index.html', async () => {
    // ZenFS readFile does not throw on a directory (it returns the dir
    // entry's index bytes), so the responder stats first and reports
    // EISDIR for directories. The preview SW keys its index.html retry
    // off that error code.
    const ch = new FakeChannel();
    const vfs = makeStubVfs();
    vfs.stat.mockResolvedValue({ type: 'directory', size: 0, mtime: 0, ctime: 0 });
    installPreviewVfsResponder({ channel: ch, getReader: () => vfs.client });

    ch.emit({ type: 'preview-vfs-read', id: 'd1', path: '/site', asText: true });
    await tick();

    expect(acksOf(ch)).toEqual([{ type: 'preview-vfs-ack', id: 'd1' }]);
    const resp = responsesOf(ch)[0] as PreviewVfsResponse;
    expect('error' in resp && resp.error).toContain('EISDIR');
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('end-to-end: forwards through a real VfsRpcHost + RemoteVfsClient', async () => {
    // Canonical OPFS-flag-on path: the swapped reader is a
    // `RemoteVfsClient` talking to the kernel worker's `VfsRpcHost`
    // over a MessageChannel.
    const channel = new MessageChannel();
    const bridge = createBridgeMessageChannelTransport(channel.port2);
    const worker = makeStubVfs();
    worker.readFile.mockImplementation(async (p: string, opts?: ReadFileOptions) =>
      opts?.encoding === 'binary' ? new Uint8Array([1, 2, 3]) : `worker:${p}`
    );
    const host = startVfsRpcHost({
      transport: bridge,
      client: worker.client,
      logger: { warn: vi.fn() },
    });
    const panel = createPanelMessageChannelTransport(channel.port1);
    const remoteVfs = createRemoteVfsClient({ transport: panel });

    const ch = new FakeChannel();
    installPreviewVfsResponder({ channel: ch, getReader: () => remoteVfs });

    ch.emit({ type: 'preview-vfs-read', id: 't1', path: '/preview/a.html', asText: true });
    await tick(20);

    const text = responsesOf(ch)[0] as PreviewVfsResponse;
    expect(worker.readFile).toHaveBeenCalledWith('/preview/a.html', { encoding: 'utf-8' });
    expect('content' in text && text.content).toBe('worker:/preview/a.html');

    ch.emit({ type: 'preview-vfs-read', id: 't2', path: '/preview/a.png', asText: false });
    await tick(20);

    const bin = responsesOf(ch)[1] as PreviewVfsResponse;
    expect(worker.readFile).toHaveBeenLastCalledWith('/preview/a.png', { encoding: 'binary' });
    expect('content' in bin && bin.content).toBeInstanceOf(Uint8Array);

    remoteVfs.dispose();
    host.stop();
    channel.port1.close();
    channel.port2.close();
  });
});
