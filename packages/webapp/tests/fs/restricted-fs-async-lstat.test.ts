import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('RestrictedFS async lstat rejects ancestor-symlink escape (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  const scoopFolder = '/scoops/agent-async-lstat/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({
      dbName: 'test-restricted-fs-async-lstat',
      wipe: true,
    });
    await vfs.mkdir('/scoops/agent-async-lstat/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/shared/real-file', 'shared real contents');
    await vfs.writeFile('/scoops/other-scoop/secret', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/scoops/other-scoop/another-secret', 'another leak');
    await vfs.writeFile('/outside-file', 'outside data');

    await vfs.symlink('/scoops/other-scoop', '/shared/escape-link');

    await vfs.symlink('/shared/real-file', '/shared/legit-symlink');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('async lstat through an escape-symlink ancestor throws ENOENT (no metadata leak)', async () => {
    await expect(restricted.lstat('/shared/escape-link/secret')).rejects.toThrow('ENOENT');
  });

  it('async lstat through an escape-symlink ancestor throws ENOENT for a non-existent leaf too', async () => {
    await expect(restricted.lstat('/shared/escape-link/does-not-exist')).rejects.toThrow('ENOENT');
  });

  it('async lstat on the escape symlink node itself still reports symlink (does not follow leaf)', async () => {
    const s = await restricted.lstat('/shared/escape-link');
    expect(s.type).toBe('symlink');
  });

  it('regression: async lstat on a legitimate in-sandbox symlink still returns symlink stats', async () => {
    const s = await restricted.lstat('/shared/legit-symlink');
    expect(s.type).toBe('symlink');
  });

  it('regression: async lstat on a regular file inside the ACL returns file stats', async () => {
    const s = await restricted.lstat('/shared/real-file');
    expect(s.type).toBe('file');
  });

  it('regression: async lstat on a disallowed path throws ENOENT (lexical ACL still holds)', async () => {
    await expect(restricted.lstat('/scoops/other-scoop/secret')).rejects.toThrow('ENOENT');
  });
});

describe('RestrictedFS async-lstat shell integration (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  let shell: AlmostBashShellHeadless;
  const scoopFolder = '/scoops/agent-async-lstat-shell/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({
      dbName: 'test-restricted-fs-async-lstat-shell',
      wipe: true,
    });
    await vfs.mkdir('/scoops/agent-async-lstat-shell/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/scoops/other-scoop/secret-file', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/shared/real-file', 'shared real contents');

    await vfs.symlink('/scoops/other-scoop', '/shared/escape-link');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
    shell = new AlmostBashShellHeadless({
      fs: restricted as unknown as VirtualFS,
      cwd,
    });
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('`stat /shared/escape-link/secret-file` fails gracefully and does NOT leak sibling metadata', async () => {
    const result = await shell.executeCommand('stat /shared/escape-link/secret-file');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);

    expect(result.stdout).not.toContain('SIBLING SCOOP SECRET');
    expect(result.stdout).not.toContain('/scoops/other-scoop/secret-file');
  });
});
