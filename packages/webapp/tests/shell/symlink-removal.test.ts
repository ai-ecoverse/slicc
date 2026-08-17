import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShell } from '../../src/shell/index.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

describe('shell symlink removal', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShell;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: 'shell-symlink-removal', wipe: true });
    shell = new AlmostBashShell({ fs });
    await fs.mkdir('/target');
    await fs.writeFile('/target/keep.txt', 'important');
  });

  async function expectTargetIntact(): Promise<void> {
    expect(await fs.exists('/alias')).toBe(false);
    expect(await fs.readTextFile('/target/keep.txt')).toBe('important');
  }

  it.each(['rm /alias', 'rm -f /alias', 'unlink /alias'])(
    '%s removes only a symlink to a non-empty directory',
    async (command) => {
      await fs.symlink('/target', '/alias');
      const result = await shell.executeCommand(command);
      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      await expectTargetIntact();
    }
  );

  it('stat reports the link by default and follows it with -L', async () => {
    await fs.symlink('/target', '/alias');
    const link = await shell.executeCommand('stat -c %F /alias');
    const target = await shell.executeCommand('stat -L -c %F /alias');
    expect(link).toMatchObject({ exitCode: 0, stdout: 'symbolic link\n' });
    expect(target).toMatchObject({ exitCode: 0, stdout: 'directory\n' });
  });

  it('rmdir does not inspect a symlink target', async () => {
    await fs.symlink('/target', '/alias');
    const result = await shell.executeCommand('rmdir /alias');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not a directory');
    expect(result.stderr).not.toContain('Directory not empty');
  });

  it('adapter lstat distinguishes a directory symlink', async () => {
    await fs.symlink('/target', '/alias');
    const stat = await new VfsAdapter(fs).lstat('/alias');
    expect(stat).toMatchObject({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
  });
});
