// @vitest-environment jsdom

/**
 * Focused tests for the `setupVfs()` / `attachWorkerVfs()` boot stage.
 * The OPFS leader election, mount recovery, and preview-vfs responder
 * subsystems have their own exhaustive coverage; these tests pin the
 * stage-level contract that lives in `setup-vfs.ts`:
 *
 *   - Returns a `VfsHandle` with the flag-off baseline
 *     (`useRpcVfs=false`, `panelReadVfs===localFs`,
 *     `writableFs===localFs`, leader-by-default).
 *   - Wires `layout.panels.fileBrowser.setFs(localFs)` only when the
 *     flag is off (the OPFS branch defers it to `attachWorkerVfs`).
 *   - Installs a preview-vfs responder on a `preview-vfs`
 *     BroadcastChannel.
 *   - `attachWorkerVfs()` is a no-op when `useRpcVfs=false`.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { attachWorkerVfs, setupVfs } from '../../../src/ui/boot/setup-vfs.js';
import type { Layout } from '../../../src/ui/layout.js';

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface FakeLayout {
  panels: {
    fileBrowser: { setFs: ReturnType<typeof vi.fn> };
  };
}

function makeFakeLayout(): FakeLayout {
  return { panels: { fileBrowser: { setFs: vi.fn() } } };
}

describe('setupVfs', () => {
  it('returns a flag-off handle with localFs binding panelReadVfs + writableFs', async () => {
    const layout = makeFakeLayout();
    const handle = await setupVfs({
      layout: layout as unknown as Layout,
      log: silentLog,
    });

    expect(handle.useRpcVfs).toBe(false);
    expect(handle.opfsLeader.isLeader).toBe(true);
    expect(handle.panelReadVfs).toBe(handle.localFs);
    expect(handle.writableFs).toBe(handle.localFs);
    expect(handle.previewVfsCh).toBeInstanceOf(BroadcastChannel);
    handle.previewVfsCh.close();
    handle.opfsLeader.dispose();
  });

  it('wires layout.panels.fileBrowser.setFs(localFs) when the flag is off', async () => {
    const layout = makeFakeLayout();
    const handle = await setupVfs({
      layout: layout as unknown as Layout,
      log: silentLog,
    });

    expect(layout.panels.fileBrowser.setFs).toHaveBeenCalledTimes(1);
    expect(layout.panels.fileBrowser.setFs).toHaveBeenCalledWith(handle.localFs);
    handle.previewVfsCh.close();
    handle.opfsLeader.dispose();
  });

  it('installs a preview-vfs BroadcastChannel responder that reads through the handle', async () => {
    const layout = makeFakeLayout();
    const handle = await setupVfs({
      layout: layout as unknown as Layout,
      log: silentLog,
    });

    // Seed a file in localFs and confirm the responder serves it via the channel.
    await handle.localFs.mkdir('/preview', { recursive: true });
    await handle.localFs.writeFile('/preview/hello.txt', 'hi');

    const peer = new BroadcastChannel('preview-vfs');
    const responses: Array<{ id: string; content?: string | Uint8Array; error?: string }> = [];
    peer.addEventListener('message', (ev: MessageEvent) => {
      if ((ev.data as { type?: string })?.type === 'preview-vfs-response') {
        responses.push(ev.data as { id: string });
      }
    });
    peer.postMessage({
      type: 'preview-vfs-read',
      id: 't1',
      path: '/preview/hello.txt',
      asText: true,
    });

    // Wait a couple of microtask turns for the async listener to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(responses.length).toBe(1);
    expect(responses[0].id).toBe('t1');
    expect(responses[0].content).toBe('hi');

    peer.close();
    handle.previewVfsCh.close();
    handle.opfsLeader.dispose();
  });
});

describe('attachWorkerVfs', () => {
  it('is a no-op when handle.useRpcVfs is false', async () => {
    const layout = makeFakeLayout();
    const handle = await setupVfs({
      layout: layout as unknown as Layout,
      log: silentLog,
    });
    // setupVfs already called setFs once with localFs.
    layout.panels.fileBrowser.setFs.mockClear();

    await attachWorkerVfs({
      handle,
      // Client should never be touched on the flag-off path.
      client: {
        getTransport: () => {
          throw new Error('getTransport must not be called when useRpcVfs=false');
        },
      },
      layout: layout as unknown as Layout,
      log: silentLog,
    });

    expect(layout.panels.fileBrowser.setFs).not.toHaveBeenCalled();
    expect(handle.panelReadVfs).toBe(handle.localFs);
    expect(handle.writableFs).toBe(handle.localFs);
    handle.previewVfsCh.close();
    handle.opfsLeader.dispose();
  });
});
