/**
 * A gesture-less `mount /path` in the kernel worker (GNU bash on the panel
 * terminal: no pre-picked handle, no cone tool call) asks the page's
 * permission prompt for the directory over panel-RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pending = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../src/fs/mount-picker-popup.js', () => ({
  loadAndClearPendingHandle: vi.fn(async (key: string) => {
    const handle = pending.get(key) ?? null;
    pending.delete(key);
    return handle;
  }),
  reactivateHandle: vi.fn(async () => {}),
  openMountPickerPopup: vi.fn(),
}));

import { MountCommands } from '../../../src/fs/mount-commands.js';
import type { VirtualFS } from '../../../src/fs/virtual-fs.js';

function makeFs(mount = vi.fn()): VirtualFS {
  return { mount, listMounts: vi.fn(() => []) } as unknown as VirtualFS;
}

function publishRpc(call: ReturnType<typeof vi.fn>): void {
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = { call };
}

describe('gesture-less local mount in the kernel worker', () => {
  beforeEach(() => pending.clear());
  afterEach(() => {
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  it('mounts the directory the permission prompt granted', async () => {
    const call = vi.fn(async () => {
      pending.set('pendingMount:rpc-1', { name: 'project' });
      return { grants: [{ kind: 'filesystem', idbKey: 'pendingMount:rpc-1', dirName: 'project' }] };
    });
    publishRpc(call);
    const mount = vi.fn();
    const result = await new MountCommands({ fs: makeFs(mount) }).execute(['/mnt/p'], '/');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mounted 'project' → /mnt/p");
    expect(call).toHaveBeenCalledWith(
      'permission-request',
      expect.objectContaining({ kinds: ['filesystem'] }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(mount).toHaveBeenCalledWith('/mnt/p', expect.anything(), expect.anything());
  });

  it('reports a cancelled prompt without mounting', async () => {
    publishRpc(
      vi.fn(async () => {
        throw new Error('permission-request: cancelled');
      })
    );
    const mount = vi.fn();
    const result = await new MountCommands({ fs: makeFs(mount) }).execute(['/mnt/p'], '/');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('mount: cancelled\n');
    expect(mount).not.toHaveBeenCalled();
  });

  it('fails clearly when the grant carries no directory', async () => {
    publishRpc(vi.fn(async () => ({ grants: [] })));
    const none = await new MountCommands({ fs: makeFs() }).execute(['/mnt/p'], '/');
    expect(none.stderr).toContain('no directory selected');

    publishRpc(
      vi.fn(async () => ({ grants: [{ kind: 'filesystem', idbKey: 'gone', dirName: 'x' }] }))
    );
    const stale = await new MountCommands({ fs: makeFs() }).execute(['/mnt/p'], '/');
    expect(stale.stderr).toContain('no directory handle found');
  });

  it('keeps the old error when no page is listening', async () => {
    const result = await new MountCommands({ fs: makeFs() }).execute(['/mnt/p'], '/');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a user gesture');
  });
});
