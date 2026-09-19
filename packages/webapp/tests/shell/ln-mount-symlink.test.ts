/**
 * Shell-level #3311: `ln -s <mount> <vfs-path>` must fail loudly instead of
 * exiting 0 with an empty directory. Same-layer `/tmp` links still work.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { createDirectoryHandle } from '../fs/fsa-test-helpers.js';

let dbCounter = 0;
let mountIdCounter = 0;

describe('ln -s across a mount boundary (#3311)', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `ln-mount-symlink-${dbCounter++}`, wipe: true });
    await fs.mkdir('/mnt', { recursive: true });
    await fs.mkdir('/shared', { recursive: true });
    await fs.mkdir('/tmp/lntest', { recursive: true });
    await fs.mount(
      '/mnt/kb',
      LocalMountBackend.fromHandle(createDirectoryHandle({ 'index.md': '# kb' }), {
        mountId: `ln-mount-${mountIdCounter++}`,
      })
    );
    shell = new AlmostBashShellHeadless({ fs });
  });

  it('creates a real same-layer symlink under /tmp', async () => {
    expect((await shell.executeCommand('echo hello > /tmp/lntest/target')).exitCode).toBe(0);
    const linked = await shell.executeCommand('ln -s /tmp/lntest/target /tmp/lntest/link');
    expect(linked).toMatchObject({ exitCode: 0, stderr: '' });

    const st = await fs.lstat('/tmp/lntest/link');
    expect(st.type).toBe('symlink');
    expect(await fs.readFile('/tmp/lntest/link')).toBe('hello\n');
  });

  it('fails with EXDEV and creates neither a link nor an empty directory', async () => {
    const result = await shell.executeCommand('ln -s /mnt/kb /shared/wiki');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/EXDEV|mount boundary/);
    expect(await fs.exists('/shared/wiki')).toBe(false);
  });

  it('fails the same way when the link would live under /tmp', async () => {
    const result = await shell.executeCommand('ln -s /mnt/kb /tmp/kblink');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/EXDEV|mount boundary/);
    expect(await fs.exists('/tmp/kblink')).toBe(false);
  });
});
