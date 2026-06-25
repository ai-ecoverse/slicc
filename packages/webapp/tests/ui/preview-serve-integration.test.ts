/**
 * Integration test for the `serve` / `/preview/*` directory → index.html
 * fallback, wiring the THREE real production halves with no stubs:
 *
 *   handlePreviewRequest (SW side)  ⇄  installPreviewVfsResponder (page side)
 *                                   ⇅
 *                              real VirtualFS (in-memory backend)
 *
 * Regression guard for the bug where ZenFS' `readFile` returns a
 * directory's index bytes instead of throwing `EISDIR`, which left the
 * SW handler's directory → index.html retry as dead code: directory
 * preview URLs (`/preview/site`, project-serve `<a href="/products/">`)
 * served an empty `200` instead of the directory's `index.html`.
 *
 * The pre-existing e2e suite (`tests/e2e/preview-serve.test.ts`) stubs
 * the responder with a synchronous sessionStorage seed, so it never
 * exercises the real responder → VFS path this test covers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import { handlePreviewRequest, type PreviewChannel } from '../../src/ui/preview-sw-handler.js';
import {
  installPreviewVfsResponder,
  type PreviewVfsChannelLike,
} from '../../src/ui/preview-vfs-responder.js';

type Listener = (ev: MessageEvent) => void;

/**
 * In-memory stand-in for `BroadcastChannel`: every `BusChannel` posting
 * delivers to all OTHER channels' listeners (never its own), matching
 * the cross-context fan-out the SW ⇄ page channel relies on.
 */
class BroadcastBus {
  private readonly channels = new Set<BusChannel>();
  register(ch: BusChannel): void {
    this.channels.add(ch);
  }
  publish(from: BusChannel, data: unknown): void {
    for (const ch of this.channels) {
      if (ch !== from) ch.deliver(data);
    }
  }
}

class BusChannel implements PreviewChannel, PreviewVfsChannelLike {
  private readonly listeners = new Set<Listener>();
  constructor(private readonly bus: BroadcastBus) {
    bus.register(this);
  }
  postMessage(data: unknown): void {
    this.bus.publish(this, data);
  }
  addEventListener(_t: 'message', l: Listener): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: Listener): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.listeners.clear();
  }
  deliver(data: unknown): void {
    for (const l of this.listeners) l(new MessageEvent('message', { data }));
  }
}

describe('serve directory → index.html fallback (real responder + handler + VFS)', () => {
  let vfs: VirtualFS;
  let swChannel: BusChannel;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ backend: 'memory', wipe: true });
    await vfs.mkdir('/site/products', { recursive: true });
    await vfs.writeFile('/site/index.html', '<!DOCTYPE html><h1>Home</h1>');
    await vfs.writeFile('/site/app.js', 'console.log("ok")');
    await vfs.writeFile('/site/products/index.html', '<h1>Products</h1>');

    const bus = new BroadcastBus();
    const responderChannel = new BusChannel(bus);
    swChannel = new BusChannel(bus);
    installPreviewVfsResponder({
      channel: responderChannel,
      getReader: () => vfs as unknown as LocalVfsClient,
    });
  });

  afterEach(async () => {
    await vfs.dispose();
  });

  it('serves a real file directly', async () => {
    const res = await handlePreviewRequest(swChannel, '/site/app.js', 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    expect(await res.text()).toContain('console.log');
  });

  it('serves index.html for a directory path with no trailing slash', async () => {
    const res = await handlePreviewRequest(swChannel, '/site', 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(await res.text()).toContain('<h1>Home</h1>');
  });

  it('serves index.html for a directory path with a trailing slash', async () => {
    const res = await handlePreviewRequest(swChannel, '/site/', 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(await res.text()).toContain('<h1>Home</h1>');
  });

  it('serves index.html for a nested directory (project-serve link target)', async () => {
    const res = await handlePreviewRequest(swChannel, '/site/products', 1000);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(await res.text()).toContain('<h1>Products</h1>');
  });

  it('returns 404 for a directory that has no index.html', async () => {
    await vfs.mkdir('/empty-dir', { recursive: true });
    const res = await handlePreviewRequest(swChannel, '/empty-dir', 1000);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a missing path', async () => {
    const res = await handlePreviewRequest(swChannel, '/site/missing.html', 1000);
    expect(res.status).toBe(404);
  });
});
