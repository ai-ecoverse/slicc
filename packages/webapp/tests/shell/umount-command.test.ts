import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { createDirectoryHandle } from '../fs/fsa-test-helpers.js';

/**
 * `umount <path>` is registered as a top-level shell command aliasing
 * `mount unmount <path>` (issue #2738). These tests drive it through the real
 * shell so the registration — not just `MountCommands.executeUmount` — is
 * covered: an alias nobody can type is not an alias.
 */
describe('umount shell command', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `umount-command-test-${dbCounter++}`, wipe: true });
    await fs.mkdir('/mnt', { recursive: true });
    shell = new AlmostBashShellHeadless({ fs });
  });

  async function mountFixture(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
    await fs.mount(
      path,
      LocalMountBackend.fromHandle(createDirectoryHandle({ 'a.txt': 'a' }), {
        mountId: `umount-test-${path}`,
      })
    );
  }

  it('unmounts a mounted path', async () => {
    await mountFixture('/mnt/fixture');
    expect(fs.listMounts()).toContain('/mnt/fixture');

    const result = await shell.executeCommand('umount /mnt/fixture');

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Unmounted /mnt/fixture');
    expect(fs.listMounts()).not.toContain('/mnt/fixture');
  });

  it('is a usage error with no argument', async () => {
    const result = await shell.executeCommand('umount');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('umount: path required');
  });

  // `VirtualFS.unmount` is deliberately idempotent, so `mount unmount` on a
  // path that was never mounted is a no-op rather than an error. The alias has
  // to agree with it — including on that — or the two spellings diverge.
  // Error-path prefix parity (`umount: <msg>` vs `mount unmount: <msg>`) is
  // covered in tests/fs/mount-commands.test.ts, where fs.unmount can throw.
  it('treats a path that is not mounted exactly like `mount unmount` does', async () => {
    const viaAlias = await shell.executeCommand('umount /mnt/never-mounted');
    const viaMount = await shell.executeCommand('mount unmount /mnt/never-mounted');

    expect(viaAlias.exitCode).toBe(viaMount.exitCode);
    expect(viaAlias.stdout).toBe(viaMount.stdout);
    expect(viaAlias.stderr).toBe(viaMount.stderr);
  });

  it('leaves `mount unmount` and `mount -u` working', async () => {
    await mountFixture('/mnt/sub');
    expect((await shell.executeCommand('mount unmount /mnt/sub')).exitCode).toBe(0);

    await mountFixture('/mnt/flag');
    expect((await shell.executeCommand('mount -u /mnt/flag')).exitCode).toBe(0);
    expect(fs.listMounts()).toEqual([]);
  });

  it('prints its own help and is listed by `commands`', async () => {
    const help = await shell.executeCommand('umount --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: umount [--clear-cache] <path>');

    const listed = await shell.executeCommand('commands');
    expect(listed.stdout).toContain('umount');

    const which = await shell.executeCommand('which umount');
    expect(which.exitCode).toBe(0);
  });
});
