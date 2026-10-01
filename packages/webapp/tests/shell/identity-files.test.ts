import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

describe('synthetic /etc/passwd and /etc/group', () => {
  let fs: VfsAdapter;
  beforeEach(async () => {
    const vfs = await VirtualFS.create({ dbName: `identity-${Math.random()}`, wipe: true });
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.writeFile('/etc/sudoers', 'policy\n');
    fs = new VfsAdapter(vfs);
  });

  it('names the realm user (uid/gid 1000, /home/user, /bin/bash) where getpwuid looks', async () => {
    const passwd = await fs.readFile('/etc/passwd');
    expect(passwd.split('\n')).toContain('user:x:1000:1000:SLICC user:/home/user:/bin/bash');
    expect(await fs.readFile('/etc/group')).toContain('user:x:1000:\n');
    const bytes = await fs.readFileBuffer('/etc/passwd');
    expect(new TextDecoder().decode(bytes)).toBe(passwd);
  });

  it('stats, exists and lists like files', async () => {
    const st = await fs.stat('/etc/passwd');
    expect(st).toMatchObject({ isFile: true, isDirectory: false, mode: 0o644 });
    expect(st.size).toBe((await fs.readFileBuffer('/etc/passwd')).length);
    expect((await fs.lstat('/etc/group')).isFile).toBe(true);
    expect(await fs.exists('/etc/passwd')).toBe(true);
    expect(await fs.readdir('/etc')).toEqual(['group', 'passwd', 'sudoers']);
    const typed = await fs.readdirWithFileTypes('/etc');
    expect(typed.map((e) => [e.name, e.isFile])).toEqual([
      ['group', true],
      ['passwd', true],
      ['sudoers', true],
    ]);
  });

  it('a real file the user writes takes precedence, and is listed once', async () => {
    await fs.writeFile('/etc/passwd', 'me:x:1000:1000::/home/me:/bin/sh\n');
    expect(await fs.readFile('/etc/passwd')).toBe('me:x:1000:1000::/home/me:/bin/sh\n');
    expect((await fs.readdir('/etc')).filter((n) => n === 'passwd')).toHaveLength(1);
  });

  it('other missing paths still fail with ENOENT', async () => {
    await expect(fs.readFile('/etc/shadow')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat('/etc/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.exists('/etc/nope')).toBe(false);
  });
});
