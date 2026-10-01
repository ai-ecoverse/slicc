import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

describe('synthetic /etc/passwd and /etc/group', () => {
  let fs: VfsAdapter;
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `identity-${Math.random()}`, wipe: true });
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

  it("names uid 1000 after the shell's identity, falling back for what a passwd line cannot hold", async () => {
    fs.setIdentityFn(() => ({ user: 'alice', home: '/home/alice' }));
    expect((await fs.readFile('/etc/passwd')).split('\n')).toContain(
      'alice:x:1000:1000:SLICC user:/home/alice:/bin/bash'
    );
    expect(await fs.readFile('/etc/group')).toContain('alice:x:1000:\n');
    expect((await fs.stat('/etc/passwd')).size).toBe(
      (await fs.readFileBuffer('/etc/passwd')).length
    );
    fs.setIdentityFn(() => ({ user: 'a:b', home: 'relative' }));
    expect(await fs.readFile('/etc/passwd')).toContain('user:x:1000:1000:SLICC user:/home/user:');
    fs.setIdentityFn(() => ({ user: 'root', home: '/root' }));
    expect(await fs.readFile('/etc/passwd')).toContain('\nuser:x:1000:1000:SLICC user:/root:');
  });

  it('cp copies them, alone and with cp -r', async () => {
    fs.setIdentityFn(() => ({ user: 'bob', home: '/home/bob' }));
    await vfs.mkdir('/tmp', { recursive: true });
    await fs.cp('/etc/passwd', '/tmp/passwd');
    expect(await vfs.readTextFile('/tmp/passwd')).toContain('bob:x:1000:1000:');
    await fs.cp('/etc', '/tmp/etc', { recursive: true });
    expect((await vfs.readDir('/tmp/etc')).map((e) => e.name).sort()).toEqual([
      'group',
      'passwd',
      'sudoers',
    ]);
    expect(await vfs.readTextFile('/tmp/etc/group')).toContain('bob:x:1000:');
    await expect(fs.cp('/etc/nope', '/tmp/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("a shell's /etc/passwd is its $USER and $HOME (a scoop's pinned identity)", async () => {
    const shell = new AlmostBashShellHeadless({
      fs: vfs,
      env: { USER: 'scout', HOME: '/scoops/scout/home' },
    });
    const result = await shell.executeCommand('grep :1000: /etc/passwd');
    expect(result.stdout).toBe('scout:x:1000:1000:SLICC user:/scoops/scout/home:/bin/bash\n');
  });

  it('other missing paths still fail with ENOENT', async () => {
    await expect(fs.readFile('/etc/shadow')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat('/etc/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.exists('/etc/nope')).toBe(false);
  });
});
