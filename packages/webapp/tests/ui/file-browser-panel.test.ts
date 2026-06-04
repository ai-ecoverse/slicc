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

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
// Wave B2: file browser renders via RemoteVfsClient over a real
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

describe('FileBrowserPanel — renders via RemoteVfsClient + VfsRpcHost (Wave B2)', () => {
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
    // Allow the async refresh chain (readDir → stat for the file) to settle.
    await tick(20);
    const rows = Array.from(ctx.container.querySelectorAll('.file-browser__name')) as HTMLElement[];
    const names = rows.map((r) => r.textContent);
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
    await tick(20);
    const size = ctx.container.querySelector('.file-browser__size') as HTMLElement | null;
    expect(size?.textContent).toBe('2.0K');
    expect(ctx.vfs.stat).toHaveBeenCalledWith('/big.bin');
  });
});
