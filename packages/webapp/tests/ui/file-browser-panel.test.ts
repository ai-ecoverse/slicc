// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, ReadFileOptions, Stats } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import { createRemoteVfsClient } from '../../src/kernel/remote-vfs-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';
import { FileBrowserPanel } from '../../src/ui/file-browser-panel.js';

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * Poll until `predicate` returns a non-null/non-false value or the timeout
 * elapses. Used instead of a fixed `setTimeout` so the assertions don't
 * race the real-MessageChannel RPC round-trips (readDir → stat → render)
 * under CI load — a fixed wait flaked intermittently.
 */
async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  { timeout = 2000, interval = 5 }: { timeout?: number; interval?: number } = {}
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value != null && value !== false) return value;
    if (Date.now() - start > timeout) {
      throw new Error('waitFor: condition not met within timeout');
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

describe('FileBrowserPanel', () => {
  it('registers a keydown listener on the container', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'addEventListener');
    new FileBrowserPanel(container);
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });

  it('removes the keydown listener on dispose', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'removeEventListener');
    const panel = new FileBrowserPanel(container);
    panel.dispose();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// File browser renders via RemoteVfsClient over a real
// MessageChannel + VfsRpcHost. Pins the end-to-end RPC path the
// standalone-worker uses when `slicc_opfs_vfs === 'opfs'`.
// ---------------------------------------------------------------------------

interface RpcCtx {
  panel: FileBrowserPanel;
  container: HTMLElement;
  vfs: {
    readDir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
  };
  dispose: () => void;
}

function setupPanelOverRpc(): RpcCtx {
  const container = createContainer();
  const channel = new MessageChannel();
  const bridge = createBridgeMessageChannelTransport(channel.port2);
  const readDir = vi.fn(async (_path: string): Promise<DirEntry[]> => []);
  const readFile = vi.fn(
    async (_path: string, _opts?: ReadFileOptions): Promise<string | Uint8Array> => ''
  );
  const stat = vi.fn(
    async (_path: string): Promise<Stats> => ({ type: 'file', size: 0, mtime: 0, ctime: 0 })
  );
  const client: LocalVfsClient = { readDir, readFile, stat };
  const hostHandle = startVfsRpcHost({
    transport: bridge,
    client,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const panelTransport = createPanelMessageChannelTransport(channel.port1);
  const remoteVfs = createRemoteVfsClient({
    transport: panelTransport,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });
  const panel = new FileBrowserPanel(container);
  panel.setFs(remoteVfs);
  return {
    panel,
    container,
    vfs: { readDir, readFile, stat },
    dispose: () => {
      panel.dispose();
      remoteVfs.dispose();
      hostHandle.stop();
      channel.port1.close();
      channel.port2.close();
      container.remove();
    },
  };
}

describe('FileBrowserPanel — renders via RemoteVfsClient + VfsRpcHost', () => {
  let ctx: RpcCtx | null = null;
  afterEach(() => {
    ctx?.dispose();
    ctx = null;
  });

  it('renders directory entries served by the RPC host', async () => {
    ctx = setupPanelOverRpc();
    ctx.vfs.readDir.mockImplementation(async (path: string) => {
      if (path === '/') {
        return [
          { name: 'workspace', type: 'directory' },
          { name: 'readme.txt', type: 'file' },
        ];
      }
      return [];
    });
    ctx.vfs.stat.mockResolvedValue({ type: 'file', size: 42, mtime: 0, ctime: 0 } as Stats);
    // Poll the async refresh chain (readDir → stat for the file) to settle.
    const names = await waitFor(() => {
      const rows = Array.from(
        ctx!.container.querySelectorAll('.file-browser__name')
      ) as HTMLElement[];
      const ns = rows.map((r) => r.textContent);
      return ns.includes('workspace') && ns.includes('readme.txt') ? ns : null;
    });
    expect(names).toEqual(expect.arrayContaining(['workspace', 'readme.txt']));
    expect(ctx.vfs.readDir).toHaveBeenCalledWith('/');
  });

  it('renders file size via the RPC-served stat result', async () => {
    ctx = setupPanelOverRpc();
    ctx.vfs.readDir.mockImplementation(async (path: string) => {
      if (path === '/') return [{ name: 'big.bin', type: 'file' }];
      return [];
    });
    ctx.vfs.stat.mockResolvedValue({ type: 'file', size: 2048, mtime: 0, ctime: 0 } as Stats);
    const sizeText = await waitFor(() => {
      const size = ctx!.container.querySelector('.file-browser__size') as HTMLElement | null;
      return size?.textContent === '2.0K' ? size.textContent : null;
    });
    expect(sizeText).toBe('2.0K');
    expect(ctx.vfs.stat).toHaveBeenCalledWith('/big.bin');
  });
});
