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

  it('links onto the mount: ls, cat and writes go through to it', async () => {
    const linked = await shell.executeCommand('ln -s /mnt/kb /shared/wiki');
    expect(linked).toMatchObject({ exitCode: 0, stderr: '' });
    expect((await fs.lstat('/shared/wiki')).type).toBe('symlink');
    expect((await shell.executeCommand('ls /shared/wiki')).stdout).toBe('index.md\n');
    expect((await shell.executeCommand('cat /shared/wiki/index.md')).stdout).toBe('# kb');
    expect((await shell.executeCommand('echo new > /shared/wiki/new.md')).exitCode).toBe(0);
    expect(await fs.readFile('/mnt/kb/new.md')).toBe('new\n');
  });

  it('a link under /tmp, and a relative one, reach it too', async () => {
    expect((await shell.executeCommand('ln -s /mnt/kb /tmp/kblink')).exitCode).toBe(0);
    expect((await shell.executeCommand('cat /tmp/kblink/index.md')).stdout).toBe('# kb');
    expect((await shell.executeCommand('cd /shared && ln -s ../mnt/kb rel')).exitCode).toBe(0);
    expect((await shell.executeCommand('cat /shared/rel/index.md')).stdout).toBe('# kb');
  });
});
