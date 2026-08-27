/**
 * Tests for RestrictedFS path access control.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { MountBackend } from '../../src/fs/mount/backend.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

function fakeMountBackend(): MountBackend {
  return {
    kind: 'da',
    source: 'da://test/repo',
    mountId: 'test-mount-id',
    readDir: async () => [],
    readFile: async () => new Uint8Array(),
    stat: async () => ({ kind: 'directory', size: 0, mtime: 0 }),
    writeFile: async () => {},
    mkdir: async () => {},
    remove: async () => {},
    refresh: async () => ({ added: [], removed: [], changed: [], unchanged: 0, errors: [] }),
    describe: () => ({ displayName: 'test/repo' }),
    close: async () => {},
  };
}

describe('RestrictedFS', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs', wipe: true });
    // Set up directory structure
    await vfs.mkdir('/scoops/andy-scoop', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });
    await vfs.writeFile('/scoops/andy-scoop/file.txt', 'hello');
    await vfs.writeFile('/shared/data.txt', 'shared data');
    await vfs.writeFile('/scoops/other-scoop/secret.txt', 'secret');
    await vfs.writeFile('/root-file.txt', 'root');

    restricted = new RestrictedFS(vfs, ['/scoops/andy-scoop/', '/shared/']);
  });

  it('reads files within allowed dirs', async () => {
    const content = await restricted.readFile('/scoops/andy-scoop/file.txt', { encoding: 'utf-8' });
    expect(content).toBe('hello');
  });

  it('reads files in shared dir', async () => {
    const content = await restricted.readFile('/shared/data.txt', { encoding: 'utf-8' });
    expect(content).toBe('shared data');
  });

  it('throws ENOENT for reads outside allowed dirs (not EACCES)', async () => {
    await expect(restricted.readFile('/scoops/other-scoop/secret.txt')).rejects.toThrow('ENOENT');
  });

  it('throws ENOENT for root-level reads', async () => {
    await expect(restricted.readFile('/root-file.txt')).rejects.toThrow('ENOENT');
  });

  it('prevents path traversal (returns ENOENT)', async () => {
    await expect(restricted.readFile('/scoops/andy-scoop/../../root-file.txt')).rejects.toThrow(
      'ENOENT'
    );
  });

  it('returns false for exists() outside allowed dirs', async () => {
    expect(await restricted.exists('/scoops/other-scoop/secret.txt')).toBe(false);
    expect(await restricted.exists('/usr/bin/mkdir')).toBe(false);
  });

  it('returns empty array for readDir outside allowed dirs', async () => {
    const entries = await restricted.readDir('/usr/bin');
    expect(entries).toEqual([]);
  });

  it('widens reads for an approved glob without exposing non-matching siblings', async () => {
    await vfs.mkdir('/recordings', { recursive: true });
    await vfs.writeFile('/recordings/first.har', 'approved');
    await vfs.writeFile('/recordings/notes.txt', 'private');

    await expect(restricted.readFile('/recordings/first.har')).rejects.toThrow('ENOENT');
    restricted.setReadGrants(['/recordings/*.har']);

    expect(await restricted.readTextFile('/recordings/first.har')).toBe('approved');
    await expect(restricted.readFile('/recordings/notes.txt')).rejects.toThrow('ENOENT');
    expect((await restricted.readDir('/recordings')).map((entry) => entry.name)).toEqual([
      'first.har',
    ]);

    restricted.setReadGrants([]);
    await expect(restricted.readFile('/recordings/first.har')).rejects.toThrow('ENOENT');
  });

  it('writes within allowed dirs', async () => {
    await restricted.writeFile('/scoops/andy-scoop/new.txt', 'new content');
    const content = await vfs.readFile('/scoops/andy-scoop/new.txt', { encoding: 'utf-8' });
    expect(content).toBe('new content');
  });

  it('prevents writing outside allowed dirs', async () => {
    await expect(restricted.writeFile('/scoops/other-scoop/hack.txt', 'hacked')).rejects.toThrow(
      'EACCES'
    );
  });

  it('allows stat on allowed directory root', async () => {
    const stat = await restricted.stat('/scoops/andy-scoop');
    expect(stat.type).toBe('directory');
  });

  it('allows readDir on allowed dirs', async () => {
    const entries = await restricted.readDir('/scoops/andy-scoop');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('walk only yields files within allowed paths', async () => {
    // Write a file in shared too
    await vfs.writeFile('/shared/walk-test.txt', 'walkable');
    const files: string[] = [];
    for await (const f of restricted.walk('/shared')) {
      files.push(f);
    }
    expect(files).toContain('/shared/walk-test.txt');
    expect(files).toContain('/shared/data.txt');
  });

  it('getUnderlyingFS returns the raw VFS', () => {
    expect(restricted.getUnderlyingFS()).toBe(vfs);
  });

  // ── Parent directory traversal (needed for cd) ──────────────────────

  it('stat on parent dir of allowed path works (cd needs this)', async () => {
    // /scoops is parent of /scoops/andy-scoop/ — stat should succeed
    const stat = await restricted.stat('/scoops');
    expect(stat.type).toBe('directory');
  });

  it('stat on root works (parent of all paths)', async () => {
    const stat = await restricted.stat('/');
    expect(stat.type).toBe('directory');
  });

  it('exists on parent dir returns true', async () => {
    expect(await restricted.exists('/scoops')).toBe(true);
  });

  it('readDir on parent dir filters to only allowed children', async () => {
    // /scoops has andy-scoop and other-scoop, but restricted should only show andy-scoop
    const entries = await restricted.readDir('/scoops');
    const names = entries.map((e) => e.name);
    expect(names).toContain('andy-scoop');
    expect(names).not.toContain('other-scoop');
  });

  it('readDir on root filters to relevant children', async () => {
    const entries = await restricted.readDir('/');
    const names = entries.map((e) => e.name);
    // /scoops and /shared lead toward allowed paths
    expect(names).toContain('scoops');
    expect(names).toContain('shared');
    // root-file.txt does NOT lead toward allowed paths
    expect(names).not.toContain('root-file.txt');
  });

  // ── Write protection on parent dirs ─────────────────────────────────

  it('mkdir on parent dir is blocked (EACCES)', async () => {
    await expect(restricted.mkdir('/other-top-dir')).rejects.toThrow('EACCES');
  });

  it('writeFile to parent dir is blocked (EACCES)', async () => {
    await expect(restricted.writeFile('/scoops/hack.txt', 'nope')).rejects.toThrow('EACCES');
  });

  it('rm on parent dir is blocked (EACCES)', async () => {
    await expect(restricted.rm('/scoops')).rejects.toThrow('EACCES');
  });

  // ── readTextFile strict check ───────────────────────────────────────

  it('readTextFile works within allowed dirs', async () => {
    const content = await restricted.readTextFile('/scoops/andy-scoop/file.txt');
    expect(content).toBe('hello');
  });

  it('readTextFile throws ENOENT for parent dirs (no reading parent files)', async () => {
    await vfs.writeFile('/scoops/secret-at-parent.txt', 'nope');
    await expect(restricted.readTextFile('/scoops/secret-at-parent.txt')).rejects.toThrow('ENOENT');
  });

  // ── copyFile source/dest checks ─────────────────────────────────────

  it('copyFile within allowed dirs works', async () => {
    await restricted.writeFile('/scoops/andy-scoop/copy-src.txt', 'copy me');
    await restricted.copyFile('/scoops/andy-scoop/copy-src.txt', '/shared/copy-dest.txt');
    const content = await vfs.readFile('/shared/copy-dest.txt', { encoding: 'utf-8' });
    expect(content).toBe('copy me');
  });

  it('copyFile to outside dir throws EACCES', async () => {
    await expect(
      restricted.copyFile('/scoops/andy-scoop/file.txt', '/scoops/other-scoop/stolen.txt')
    ).rejects.toThrow('EACCES');
  });

  it('copyFile from outside dir throws ENOENT', async () => {
    await expect(
      restricted.copyFile('/scoops/other-scoop/secret.txt', '/scoops/andy-scoop/got-it.txt')
    ).rejects.toThrow('ENOENT');
  });

  // ── Mount path access (dynamic read-only) ──────────────────────────

  describe('mount paths as dynamic read-only prefixes', () => {
    let mountVfs: VirtualFS;
    let mountRestricted: RestrictedFS;

    beforeAll(async () => {
      mountVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-mounts', wipe: true });
      await mountVfs.mkdir('/scoops/scoop-a', { recursive: true });
      await mountVfs.writeFile('/scoops/scoop-a/file.txt', 'scoop file');

      // Simulate a mount by creating the directory and adding files,
      // then registering it as a mount point via the VFS mount mechanism.
      // Since we can't use real FileSystemDirectoryHandle in tests, we
      // create the content in LFS and mock listMounts to include the path.
      await mountVfs.mkdir('/mnt/kb', { recursive: true });
      await mountVfs.writeFile('/mnt/kb/README.md', 'mount readme');
      await mountVfs.writeFile('/mnt/kb/data.json', '{"key":"value"}');

      // Spy on listMounts to return our simulated mount path
      const originalListMounts = mountVfs.listMounts.bind(mountVfs);
      mountVfs.listMounts = () => [...originalListMounts(), '/mnt/kb'];

      mountRestricted = new RestrictedFS(mountVfs, ['/scoops/scoop-a/']);
    });

    it('readFile on a mounted path succeeds', async () => {
      const content = await mountRestricted.readFile('/mnt/kb/README.md', { encoding: 'utf-8' });
      expect(content).toBe('mount readme');
    });

    it('writeFile on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.writeFile('/mnt/kb/new.txt', 'nope')).rejects.toThrow('EACCES');
    });

    it('readDir on a mounted path returns entries', async () => {
      const entries = await mountRestricted.readDir('/mnt/kb');
      const names = entries.map((e) => e.name);
      expect(names).toContain('README.md');
      expect(names).toContain('data.json');
    });

    it('stat on a mounted path works', async () => {
      const stat = await mountRestricted.stat('/mnt/kb');
      expect(stat.type).toBe('directory');
    });

    it('exists on a mounted path returns true', async () => {
      expect(await mountRestricted.exists('/mnt/kb')).toBe(true);
      expect(await mountRestricted.exists('/mnt/kb/README.md')).toBe(true);
    });

    it('mkdir on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.mkdir('/mnt/kb/subdir')).rejects.toThrow('EACCES');
    });

    it('rm on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.rm('/mnt/kb/README.md')).rejects.toThrow('EACCES');
    });

    it('readDir on root includes mount parent paths', async () => {
      const entries = await mountRestricted.readDir('/');
      const names = entries.map((e) => e.name);
      expect(names).toContain('mnt');
      expect(names).toContain('scoops');
    });
  });

  describe('mount/unmount operations', () => {
    let mountOpVfs: VirtualFS;

    beforeAll(async () => {
      mountOpVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-mount-ops', wipe: true });
      await mountOpVfs.mkdir('/scoops/editor', { recursive: true });
      await mountOpVfs.mkdir('/scoops/editor/da-site', { recursive: true });
      await mountOpVfs.mkdir('/workspace/external', { recursive: true });
    });

    it('mount succeeds when target is within writable paths', async () => {
      const rfs = new RestrictedFS(mountOpVfs, ['/scoops/editor/']);
      await expect(rfs.mount('/scoops/editor/da-site', fakeMountBackend())).resolves.not.toThrow();
      expect(rfs.listMounts()).toContain('/scoops/editor/da-site');
      await rfs.unmount('/scoops/editor/da-site');
    });

    it('mount throws EACCES when target is outside writable paths (hard enforcement)', async () => {
      const rfs = new RestrictedFS(mountOpVfs, ['/scoops/editor/'], [], 'hard');
      await expect(rfs.mount('/workspace/external', fakeMountBackend())).rejects.toThrow('EACCES');
    });

    it('unmount throws EACCES when the mount path is outside writable paths', async () => {
      // Load-bearing guard for the curator command whitelist: `mount` is
      // allowed for its read-only listing, and `mount unmount <path>` is a
      // plain `fs.unmount` — this checkWrite is what turns it into EACCES
      // under a narrow grant (e.g. the memory curator's single writable
      // file). If this guard moves out of `RestrictedFS.unmount`, the
      // whitelist entry in `scoops/agentic-memory.ts` must be revisited.
      await mountOpVfs.mount('/workspace/external', fakeMountBackend());
      try {
        const rfs = new RestrictedFS(mountOpVfs, ['/scoops/editor/'], [], 'hard');
        await expect(rfs.unmount('/workspace/external')).rejects.toThrow('EACCES');
        expect(mountOpVfs.listMounts()).toContain('/workspace/external');
      } finally {
        await mountOpVfs.unmount('/workspace/external');
      }
    });

    it('mount passes through RestrictedFS under sudo-delegated (SudoFS gates via cone approval)', async () => {
      const rfs = new RestrictedFS(mountOpVfs, ['/scoops/editor/'], [], 'sudo-delegated');
      // RestrictedFS layer passes through — SudoFS is responsible for gating
      await expect(rfs.mount('/workspace/external', fakeMountBackend())).resolves.not.toThrow();
      expect(rfs.listMounts()).toContain('/workspace/external');
      await rfs.unmount('/workspace/external');
    });

    it('listMounts and getMountIndex delegate to VFS', async () => {
      const rfs = new RestrictedFS(mountOpVfs, ['/scoops/editor/']);
      expect(rfs.listMounts()).toEqual(mountOpVfs.listMounts());
      expect(rfs.getMountIndex()).toBe(mountOpVfs.getMountIndex());
    });
  });

  // ── Symlink target validation ─────────────────────────────────────

  describe('symlink target validation', () => {
    let symlinkVfs: VirtualFS;
    let symlinkRestricted: RestrictedFS;

    beforeAll(async () => {
      symlinkVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-symlinks', wipe: true });
      // Set up directory structure
      await symlinkVfs.mkdir('/scoops/my-scoop', { recursive: true });
      await symlinkVfs.mkdir('/shared', { recursive: true });
      await symlinkVfs.mkdir('/secret', { recursive: true });
      await symlinkVfs.writeFile('/scoops/my-scoop/legit.txt', 'allowed content');
      await symlinkVfs.writeFile('/shared/data.txt', 'shared data');
      await symlinkVfs.writeFile('/secret/data.txt', 'top secret');

      // Create symlinks:
      // escape-link -> /secret/data.txt (points outside allowed)
      await symlinkVfs.symlink('/secret/data.txt', '/scoops/my-scoop/escape-link');
      // good-link -> /shared/data.txt (points to another allowed path)
      await symlinkVfs.symlink('/shared/data.txt', '/scoops/my-scoop/good-link');
      // chain: /scoops/my-scoop/chain-link -> /scoops/my-scoop/escape-link -> /secret/data.txt
      await symlinkVfs.symlink('/scoops/my-scoop/escape-link', '/scoops/my-scoop/chain-link');

      symlinkRestricted = new RestrictedFS(symlinkVfs, ['/scoops/my-scoop/'], ['/shared/']);
    });

    it('readFile through symlink pointing outside throws ENOENT', async () => {
      await expect(
        symlinkRestricted.readFile('/scoops/my-scoop/escape-link', { encoding: 'utf-8' })
      ).rejects.toThrow('ENOENT');
    });

    it('readFile through symlink pointing to allowed path succeeds', async () => {
      const content = await symlinkRestricted.readFile('/scoops/my-scoop/good-link', {
        encoding: 'utf-8',
      });
      expect(content).toBe('shared data');
    });

    it('readTextFile through symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.readTextFile('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('stat through symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.stat('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('exists returns false for symlink pointing outside', async () => {
      expect(await symlinkRestricted.exists('/scoops/my-scoop/escape-link')).toBe(false);
    });

    it('symlink chain where final target is outside throws ENOENT', async () => {
      await expect(
        symlinkRestricted.readFile('/scoops/my-scoop/chain-link', { encoding: 'utf-8' })
      ).rejects.toThrow('ENOENT');
    });

    it('writeFile through symlink pointing outside throws EACCES', async () => {
      // Create a symlink to a directory outside allowed
      await symlinkVfs.mkdir('/outside-dir', { recursive: true });
      await symlinkVfs.symlink('/outside-dir', '/scoops/my-scoop/dir-escape');
      await expect(
        symlinkRestricted.writeFile('/scoops/my-scoop/dir-escape/file.txt', 'hacked')
      ).rejects.toThrow('EACCES');
    });

    it('readlink on symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.readlink('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('readlink on symlink pointing to allowed path succeeds', async () => {
      const target = await symlinkRestricted.readlink('/scoops/my-scoop/good-link');
      expect(target).toBe('/shared/data.txt');
    });
  });

  // ── Destination symlink escape and rm symlink tests ─────────────────

  describe('destination symlink escape', () => {
    let escVfs: VirtualFS;
    let escRestricted: RestrictedFS;

    beforeAll(async () => {
      escVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-dest-symlink', wipe: true });
      await escVfs.mkdir('/scoops/my-scoop', { recursive: true });
      await escVfs.mkdir('/outside', { recursive: true });
      await escVfs.writeFile('/outside/secret', 'top secret');

      escRestricted = new RestrictedFS(escVfs, ['/scoops/my-scoop/']);
    });

    it('writeFile through existing symlink pointing outside sandbox is blocked', async () => {
      await escVfs.symlink('/outside/secret', '/scoops/my-scoop/escape-write');
      await expect(
        escRestricted.writeFile('/scoops/my-scoop/escape-write', 'hacked')
      ).rejects.toThrow('EACCES');
    });

    it('copyFile to existing symlink pointing outside sandbox is blocked', async () => {
      await escVfs.writeFile('/scoops/my-scoop/src.txt', 'source');
      await escVfs.symlink('/outside/secret', '/scoops/my-scoop/escape-copy');
      await expect(
        escRestricted.copyFile('/scoops/my-scoop/src.txt', '/scoops/my-scoop/escape-copy')
      ).rejects.toThrow('EACCES');
    });

    it('rm can delete a symlink whose target is outside writable prefixes', async () => {
      await escVfs.symlink('/outside/data', '/scoops/my-scoop/rm-link');
      // Should succeed — we're removing the link node, not the target
      await escRestricted.rm('/scoops/my-scoop/rm-link');
      expect(await escVfs.exists('/scoops/my-scoop/rm-link')).toBe(false);
    });
  });

  it('rename checks both paths', async () => {
    await restricted.writeFile('/scoops/andy-scoop/rename-src.txt', 'src');
    // Rename within allowed - should work
    await restricted.rename(
      '/scoops/andy-scoop/rename-src.txt',
      '/scoops/andy-scoop/rename-dest.txt'
    );
    const content = await restricted.readFile('/scoops/andy-scoop/rename-dest.txt', {
      encoding: 'utf-8',
    });
    expect(content).toBe('src');

    // Rename to outside - should fail
    await restricted.writeFile('/scoops/andy-scoop/escape.txt', 'escape');
    await expect(
      restricted.rename('/scoops/andy-scoop/escape.txt', '/root-escape.txt')
    ).rejects.toThrow('EACCES');
  });

  describe('canWrite predicate', () => {
    it('returns true for paths inside a writable prefix', () => {
      expect(restricted.canWrite('/scoops/andy-scoop/file.txt')).toBe(true);
      expect(restricted.canWrite('/scoops/andy-scoop')).toBe(true);
      expect(restricted.canWrite('/shared/data.txt')).toBe(true);
    });

    it('returns false for paths outside any writable prefix', () => {
      // Sibling scoop — the exact sandbox-escape case Item B guards.
      expect(restricted.canWrite('/scoops/other-scoop')).toBe(false);
      expect(restricted.canWrite('/scoops/other-scoop/secret.txt')).toBe(false);
      // Parent dir of the sandbox — `stat` would succeed on this path, but
      // it must NOT be writable.
      expect(restricted.canWrite('/scoops')).toBe(false);
      expect(restricted.canWrite('/')).toBe(false);
      expect(restricted.canWrite('/root-file.txt')).toBe(false);
    });

    it('returns false for read-only prefixes', () => {
      const readOnly = new RestrictedFS(vfs, ['/scoops/andy-scoop/'], ['/workspace/']);
      expect(readOnly.canWrite('/workspace/foo.txt')).toBe(false);
      expect(readOnly.canWrite('/scoops/andy-scoop/foo.txt')).toBe(true);
    });
  });

  describe('isPathUnderMount', () => {
    // Regression for issue #507 — git fs adapter calls
    // `vfs.isPathUnderMount(path)` on whatever fs the AlmostBashShell was
    // constructed with. When that's a `RestrictedFS` (every scoop), the
    // missing method threw "e.isPathUnderMount is not a function" and
    // broke ALL git operations inside scoops. The method must exist and
    // delegate to the underlying VirtualFS.
    it('returns false when there are no mounts (scoops are mountless by default)', () => {
      expect(restricted.isPathUnderMount('/scoops/andy-scoop/file.txt')).toBe(false);
      expect(restricted.isPathUnderMount('/shared/data.txt')).toBe(false);
      expect(restricted.isPathUnderMount('/anywhere/else')).toBe(false);
    });

    it('forwards the call to the underlying VFS with the original path', () => {
      const calls: string[] = [];
      const stubVfs = {
        isPathUnderMount: (p: string) => {
          calls.push(p);
          return p.startsWith('/mnt/');
        },
        listMounts: () => ['/mnt'],
      } as unknown as VirtualFS;
      const r = new RestrictedFS(stubVfs, ['/scoops/andy-scoop/']);

      expect(r.isPathUnderMount('/mnt/foo')).toBe(true);
      expect(r.isPathUnderMount('/scoops/andy-scoop/file.txt')).toBe(false);
      // Proves delegation: the underlying VFS must have been invoked with
      // each input path verbatim. A no-op `return false` implementation
      // would fail the `/mnt/foo` assertion above AND leave `calls` empty.
      expect(calls).toEqual(['/mnt/foo', '/scoops/andy-scoop/file.txt']);
    });
  });

  // ── sudo-delegated write enforcement ──────────────────────────────────

  describe('writeEnforcement: "sudo-delegated"', () => {
    let delegatedVfs: VirtualFS;
    let delegated: RestrictedFS;

    beforeAll(async () => {
      delegatedVfs = await VirtualFS.create({
        dbName: 'test-restricted-fs-delegated',
        wipe: true,
      });
      await delegatedVfs.mkdir('/scoops/sd', { recursive: true });
      await delegatedVfs.mkdir('/workspace', { recursive: true });
      await delegatedVfs.writeFile('/scoops/sd/in.txt', 'ok');
      // Sudo-delegated: writes outside the sandbox MUST pass through so the
      // outer SudoFS can escalate them. Reads still get filtered.
      delegated = new RestrictedFS(delegatedVfs, ['/scoops/sd/'], [], 'sudo-delegated');
    });

    it('passes through out-of-sandbox writeFile (no EACCES)', async () => {
      await delegated.writeFile('/workspace/escalated.txt', 'reached');
      expect(await delegatedVfs.readTextFile('/workspace/escalated.txt')).toBe('reached');
    });

    it('passes through out-of-sandbox mkdir', async () => {
      await delegated.mkdir('/workspace/newdir');
      const stat = await delegatedVfs.stat('/workspace/newdir');
      expect(stat.type).toBe('directory');
    });

    it('still ENOENT-filters reads outside the sandbox', async () => {
      await delegatedVfs.writeFile('/workspace/hidden.txt', 'oob');
      await expect(delegated.readFile('/workspace/hidden.txt')).rejects.toThrow('ENOENT');
    });

    it('still blocks a symlink escape from an in-sandbox link to /etc/sudoers', async () => {
      await delegatedVfs.mkdir('/etc/sudoers.d', { recursive: true });
      await delegatedVfs.writeFile('/etc/sudoers', '# locked');
      await delegatedVfs.symlink('/etc/sudoers', '/scoops/sd/escape-link');
      // Writing through the in-sandbox symlink must still EACCES — the outer
      // SudoFS gated the literal path (which is in-sandbox, so a NOPASSWD
      // Write rule applies); the symlink-resolved-path escape is a security
      // invariant that lives in RestrictedFS.
      await expect(delegated.writeFile('/scoops/sd/escape-link', 'x')).rejects.toThrow('EACCES');
    });
  });

  describe('/dev/null virtual device', () => {
    it('stat returns a file with size 0', async () => {
      const st = await restricted.stat('/dev/null');
      expect(st.type).toBe('file');
      expect(st.size).toBe(0);
    });

    it('statSync returns a file with size 0', () => {
      const st = restricted.statSync('/dev/null');
      expect(st).not.toBeNull();
      expect(st!.type).toBe('file');
      expect(st!.size).toBe(0);
    });

    it('exists returns true', async () => {
      expect(await restricted.exists('/dev/null')).toBe(true);
    });

    it('readFile returns empty string with default encoding', async () => {
      const content = await restricted.readFile('/dev/null');
      expect(content).toBe('');
    });

    it('readFile returns empty Uint8Array with binary encoding', async () => {
      const content = await restricted.readFile('/dev/null', { encoding: 'binary' });
      expect(content).toEqual(new Uint8Array(0));
    });

    it('readTextFile returns empty string', async () => {
      expect(await restricted.readTextFile('/dev/null')).toBe('');
    });

    it('writeFile silently discards data', async () => {
      await expect(restricted.writeFile('/dev/null', 'anything')).resolves.toBeUndefined();
    });

    it('lstat returns a file with size 0', async () => {
      const st = await restricted.lstat('/dev/null');
      expect(st.type).toBe('file');
      expect(st.size).toBe(0);
    });

    it('lstatSync returns a file with size 0', () => {
      const st = restricted.lstatSync('/dev/null');
      expect(st).not.toBeNull();
      expect(st!.type).toBe('file');
    });
  });
});

/**
 * `/tmp` is global scratch space every sandbox gets unconditionally
 * (`ALWAYS_WRITABLE_PREFIXES`), so tooling that hardcodes `/tmp/<file>` works
 * without a sudo escalation. Deliberately shared across scoops.
 */
describe('RestrictedFS /tmp exemption', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs-tmp', wipe: true });
    await vfs.mkdir('/scoops/tmp-scoop', { recursive: true });
    await vfs.mkdir('/tmp', { recursive: true });
    await vfs.mkdir('/tmpfoo', { recursive: true });
    await vfs.writeFile('/tmp/from-elsewhere.txt', 'planted');
    await vfs.writeFile('/tmpfoo/decoy.txt', 'decoy');
    // Note: `/tmp` is NOT among the configured writable prefixes.
    restricted = new RestrictedFS(vfs, ['/scoops/tmp-scoop/']);
  });

  it('writes under /tmp in hard enforcement mode', async () => {
    await restricted.writeFile('/tmp/scratch.txt', 'ok');
    expect(await vfs.readTextFile('/tmp/scratch.txt')).toBe('ok');
  });

  it('creates directories under /tmp', async () => {
    await restricted.mkdir('/tmp/nested/deep', { recursive: true });
    await restricted.writeFile('/tmp/nested/deep/file.txt', 'deep');
    expect(await restricted.readTextFile('/tmp/nested/deep/file.txt')).toBe('deep');
  });

  it('reads files another context left in /tmp (shared, not per-scoop)', async () => {
    expect(await restricted.readTextFile('/tmp/from-elsewhere.txt')).toBe('planted');
  });

  it('reports /tmp as writable via canWrite', () => {
    expect(restricted.canWrite('/tmp')).toBe(true);
    expect(restricted.canWrite('/tmp/scratch.txt')).toBe(true);
  });

  it('does not leak the exemption to a same-prefix sibling', async () => {
    expect(restricted.canWrite('/tmpfoo/x.txt')).toBe(false);
    await expect(restricted.writeFile('/tmpfoo/x.txt', 'nope')).rejects.toThrow(
      /permission denied/
    );
    await expect(restricted.readTextFile('/tmpfoo/decoy.txt')).rejects.toThrow();
  });
});

/** Per-test db name counter — descriptor state must not leak between cases. */
let fdDbCounter = 0;

describe('RestrictedFS ephemeral shell descriptors', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-restricted-fs-fd-${fdDbCounter++}`, wipe: true });
    await vfs.mkdir('/scoops/fd-scoop', { recursive: true });
    // A real out-of-sandbox file, so an ENOENT below is the ACL filtering it
    // rather than the path simply not existing.
    await vfs.writeFile('/scoops/other-scoop/secret.txt', 'secret', { recursive: true });
    restricted = new RestrictedFS(vfs, ['/scoops/fd-scoop/']);
  });

  it('accepts a descriptor write and reads the payload back', async () => {
    await restricted.writeFile('/dev/fd/63', 'alpha\n');
    expect(await restricted.readTextFile('/dev/fd/63')).toBe('alpha\n');
    expect(await restricted.readFile('/dev/fd/63')).toBe('alpha\n');
    expect(await restricted.readFile('/dev/fd/63', { encoding: 'binary' })).toEqual(
      new TextEncoder().encode('alpha\n')
    );
  });

  it('keeps each descriptor separate (diff needs both 63 and 62)', async () => {
    await restricted.writeFile('/dev/fd/63', 'alpha');
    await restricted.writeFile('/dev/fd/62', 'beta');
    expect(await restricted.readTextFile('/dev/fd/63')).toBe('alpha');
    expect(await restricted.readTextFile('/dev/fd/62')).toBe('beta');
  });

  it('never writes the descriptor into the shared tree', async () => {
    await restricted.writeFile('/dev/fd/63', 'private');
    expect(await vfs.exists('/dev/fd/63')).toBe(false);
    expect(await vfs.exists('/dev')).toBe(false);
  });

  it('is private per sandbox — a sibling sees nothing', async () => {
    const sibling = new RestrictedFS(vfs, ['/scoops/other-scoop/']);
    await restricted.writeFile('/dev/fd/63', 'mine');
    expect(await sibling.exists('/dev/fd/63')).toBe(false);
    await expect(sibling.readTextFile('/dev/fd/63')).rejects.toThrow(/no such file/);
  });

  it('reports metadata for a live descriptor and ENOENT for an unopened one', async () => {
    await restricted.writeFile('/dev/fd/63', 'abc');
    expect(await restricted.stat('/dev/fd/63')).toMatchObject({ type: 'file', size: 3 });
    expect(await restricted.lstat('/dev/fd/63')).toMatchObject({ type: 'file', size: 3 });
    expect(restricted.statSync('/dev/fd/63')).toMatchObject({ type: 'file', size: 3 });
    expect(restricted.lstatSync('/dev/fd/63')).toMatchObject({ type: 'file', size: 3 });
    expect(await restricted.realpath('/dev/fd/63')).toBe('/dev/fd/63');
    expect(await restricted.exists('/dev/fd/63')).toBe(true);

    expect(await restricted.exists('/dev/fd/42')).toBe(false);
    expect(restricted.statSync('/dev/fd/42')).toBeNull();
    expect(restricted.lstatSync('/dev/fd/42')).toBeNull();
    await expect(restricted.stat('/dev/fd/42')).rejects.toThrow(/no such file/);
    await expect(restricted.readFile('/dev/fd/42')).rejects.toThrow(/no such file/);
    await expect(restricted.realpath('/dev/fd/42')).rejects.toThrow(/no such file/);
  });

  it('releases a descriptor on rm and reports a missing one as ENOENT', async () => {
    // Mirrors the VFS contract for a missing file. The interpreter's own
    // release swallows it; `rm -f` never reaches this layer.
    await restricted.writeFile('/dev/fd/63', 'abc');
    await restricted.rm('/dev/fd/63');
    expect(await restricted.exists('/dev/fd/63')).toBe(false);
    await expect(restricted.rm('/dev/fd/63')).rejects.toThrow(/no such file/);
  });

  it('reports a descriptor as writable', () => {
    expect(restricted.canWrite('/dev/fd/63')).toBe(true);
  });

  it('copies a descriptor into the tree and a tree file into a descriptor', async () => {
    // `cp <(echo hi) out` and `cp in >(consumer)` both land here via
    // `VfsAdapter.cp`, so each end has to be resolved independently.
    await restricted.writeFile('/dev/fd/63', 'from-descriptor');
    await restricted.copyFile('/dev/fd/63', '/scoops/fd-scoop/out.txt');
    expect(await restricted.readTextFile('/scoops/fd-scoop/out.txt')).toBe('from-descriptor');

    await restricted.writeFile('/scoops/fd-scoop/in.txt', 'from-tree');
    await restricted.copyFile('/scoops/fd-scoop/in.txt', '/dev/fd/62');
    expect(await restricted.readTextFile('/dev/fd/62')).toBe('from-tree');
    // The descriptor end never becomes a tree entry, in either direction.
    expect(await vfs.exists('/dev/fd/62')).toBe(false);
  });

  it('keeps the ACL on the tree end of a descriptor copy', async () => {
    await restricted.writeFile('/dev/fd/63', 'payload');
    await expect(restricted.copyFile('/dev/fd/63', '/elsewhere/out.txt')).rejects.toThrow(
      /permission denied/
    );
    await expect(
      restricted.copyFile('/scoops/other-scoop/secret.txt', '/dev/fd/62')
    ).rejects.toThrow(/no such file/);
    expect(await restricted.exists('/dev/fd/62')).toBe(false);
  });

  it('refuses tree-shape ops on a descriptor path', async () => {
    // The exemption covers a content write, the read back and the release —
    // not tree shape. Under `sudo-delegated` enforcement these would otherwise
    // fall through to the shared VFS, which is what the private store prevents.
    await restricted.writeFile('/scoops/fd-scoop/src.txt', 'x');
    await expect(restricted.mkdir('/dev/fd/63')).rejects.toThrow(/permission denied/);
    await expect(restricted.symlink('/scoops/fd-scoop/src.txt', '/dev/fd/63')).rejects.toThrow(
      /permission denied/
    );
    await expect(restricted.rename('/scoops/fd-scoop/src.txt', '/dev/fd/63')).rejects.toThrow(
      /permission denied/
    );
    await expect(restricted.rename('/dev/fd/63', '/scoops/fd-scoop/moved.txt')).rejects.toThrow(
      /permission denied/
    );
    expect(await vfs.exists('/dev')).toBe(false);
    expect(await vfs.exists('/dev/fd/63')).toBe(false);
  });

  it('refuses a mount at a descriptor path', async () => {
    await expect(restricted.mount('/dev/fd/63', fakeMountBackend())).rejects.toThrow(
      /permission denied/
    );
    await expect(restricted.unmount('/dev/fd/63')).rejects.toThrow(/permission denied/);
    await expect(restricted.refreshMount('/dev/fd/63')).rejects.toThrow(/permission denied/);
    expect(await vfs.exists('/dev')).toBe(false);
  });

  it('does not expose the descriptors as a directory', async () => {
    await restricted.writeFile('/dev/fd/63', 'abc');
    expect(await restricted.readDir('/dev/fd')).toEqual([]);
    expect(await restricted.exists('/dev/fd')).toBe(false);
    await expect(restricted.stat('/dev/fd')).rejects.toThrow(/no such file/);
  });

  it('does not extend the exemption to other /dev paths', async () => {
    // Only numbered descriptors are exempt; `/dev/` at large stays gated so a
    // future device path with observable effects is not silently writable.
    await expect(restricted.writeFile('/dev/fd/name', 'nope')).rejects.toThrow(/permission denied/);
    await expect(restricted.writeFile('/dev/sda', 'nope')).rejects.toThrow(/permission denied/);
    expect(restricted.canWrite('/dev/fd/name')).toBe(false);
  });

  it('leaves /dev/null a no-op write with empty reads', async () => {
    await expect(restricted.writeFile('/dev/null', 'discarded')).resolves.toBeUndefined();
    expect(await restricted.readTextFile('/dev/null')).toBe('');
    expect(await restricted.exists('/dev/null')).toBe(true);
  });
});
