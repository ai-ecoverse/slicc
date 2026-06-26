import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FsError, VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { discoverBshScripts } from '../../src/shell/bsh-discovery.js';
import { discoverJshCommands } from '../../src/shell/jsh-discovery.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

let testMountIdCounter = 0;
function backendOf(handle: FileSystemDirectoryHandle): LocalMountBackend {
  return LocalMountBackend.fromHandle(handle, { mountId: `test-${testMountIdCounter++}` });
}

let dbCounter = 0;

async function waitForTerminalState(
  vfs: VirtualFS,
  path: string,
  timeoutMs: number
): Promise<string | undefined> {
  const index = vfs.getMountIndex();
  const deadline = Date.now() + timeoutMs;
  let state = index.getState(path);
  while (Date.now() < deadline && (state?.status === 'indexing' || state?.status === 'pending')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = index.getState(path);
  }
  return state?.status;
}

describe('VirtualFS mount interactions with script discovery', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-virtual-fs-mount-${dbCounter++}`,
      wipe: true,
    });
  });

  it('rejects mounting over a non-empty directory so existing scripts stay visible', async () => {
    await vfs.writeFile('/workspace/skills/test-skill/run.jsh', 'console.log("run");');

    await expect(
      vfs.mount(
        '/workspace/skills',
        backendOf(
          createDirectoryHandle({
            'shadow.jsh': 'console.log("shadow");',
          })
        )
      )
    ).rejects.toEqual(
      expect.objectContaining<FsError>({
        code: 'ENOTEMPTY',
        path: '/workspace/skills',
      })
    );

    const commands = await discoverJshCommands(vfs);
    expect(commands.get('run')).toBe('/workspace/skills/test-skill/run.jsh');
  });

  it('maps FSA InvalidModificationError to ENOTEMPTY when rm-ing a non-empty mounted directory', async () => {
    await vfs.mkdir('/mnt/repo', { recursive: true });
    await vfs.mount(
      '/mnt/repo',
      backendOf(
        createDirectoryHandle({
          pack: {
            'entry.txt': 'contents',
          },
        })
      )
    );

    // Non-recursive rm on a non-empty mounted directory must surface ENOTEMPTY
    // so callers (isomorphic-git checkout/reset cleanup) can tolerate it.
    await expect(vfs.rm('/mnt/repo/pack')).rejects.toEqual(
      expect.objectContaining<FsError>({
        code: 'ENOTEMPTY',
        path: '/mnt/repo/pack',
      })
    );
  });

  it('discovers nested mounted .jsh and .bsh scripts through the parent mount', async () => {
    await vfs.mount(
      '/workspace/repo',
      backendOf(
        createDirectoryHandle({
          'outer.jsh': 'console.log("outer");',
        })
      )
    );

    await vfs.mount(
      '/workspace/repo/nested',
      backendOf(
        createDirectoryHandle({
          'inner.jsh': 'console.log("inner");',
          '-.okta.com.bsh': 'console.log("okta");',
        })
      )
    );

    const commands = await discoverJshCommands(vfs);
    expect(commands.get('inner')).toBe('/workspace/repo/nested/inner.jsh');

    const bshEntries = await discoverBshScripts(vfs);
    expect(bshEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/workspace/repo/nested/-.okta.com.bsh',
          hostnamePattern: '*.okta.com',
        }),
      ])
    );
  });

  // Mount-index walk bounds must come from the just-bash shell env threaded
  // through `mount` → `vfs.mount(..., { env })`, NOT `process.env` (absent in
  // the worker/browser/Electron-renderer floats). A `Map` env carrying a low
  // SLICC_MOUNT_INDEX_MAX_ENTRIES must therefore actually bound the indexer.
  it('threads the shell env into the per-mount index walk bounds', async () => {
    await vfs.mkdir('/mnt/wide', { recursive: true });
    await vfs.mount(
      '/mnt/wide',
      backendOf(
        createDirectoryHandle({
          'a.txt': 'a',
          'b.txt': 'b',
          'c.txt': 'c',
        })
      ),
      { env: new Map([['SLICC_MOUNT_INDEX_MAX_ENTRIES', '2']]) }
    );

    const status = await waitForTerminalState(vfs, '/mnt/wide', 4000);
    const state = vfs.getMountIndex().getState('/mnt/wide');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('entries-exceeded');
  }, 9000);

  it('uses the default bounds when no shell env is supplied at mount time', async () => {
    await vfs.mkdir('/mnt/ok', { recursive: true });
    await vfs.mount(
      '/mnt/ok',
      backendOf(
        createDirectoryHandle({
          'a.txt': 'a',
          'b.txt': 'b',
          'c.txt': 'c',
        })
      )
    );

    const status = await waitForTerminalState(vfs, '/mnt/ok', 4000);
    expect(status).toBe('ready');
  }, 9000);
});
