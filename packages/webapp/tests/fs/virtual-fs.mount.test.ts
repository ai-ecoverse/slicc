import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FsError, VirtualFS } from '../../src/fs/index.js';
import { discoverBshScripts } from '../../src/shell/bsh-discovery.js';
import { discoverJshCommands } from '../../src/shell/jsh-discovery.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';

let testMountIdCounter = 0;
function backendOf(handle: FileSystemDirectoryHandle): LocalMountBackend {
  return LocalMountBackend.fromHandle(handle, { mountId: `test-${testMountIdCounter++}` });
}

let dbCounter = 0;

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
});
