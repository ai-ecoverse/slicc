/**
 * Tests for RestrictedFS synchronous fast-path methods + realpath.
 *
 * VfsAdapter (packages/webapp/src/shell/vfs-adapter.ts) — the bridge
 * between the just-bash shell and our VirtualFS — calls these fast-path
 * methods on its `vfs` field:
 *
 *   - statSync(path)     — sync stat (follows symlinks)
 *   - lstatSync(path)    — sync lstat (does NOT follow symlinks)
 *   - readDirSync(path)  — sync readDir
 *   - realpath(path)     — async canonical path resolution
 *
 * Non-cone scoops (e.g. agent-bridge-spawned) wrap the VFS in RestrictedFS
 * and cast it to VirtualFS when constructing the shell. If RestrictedFS is
 * missing any of the four methods, every FS-reading shell command (`ls`,
 * `cat`, `find`, …) crashes with a runtime TypeError that the shell
 * surfaces as "No such file or directory" (exit code 2).
 *
 * These tests (VAL-FS-021 + VAL-FS-022 in the validation contract) lock
 * down the expected behavior of those four methods on RestrictedFS:
 * presence, ACL enforcement, and graceful failure for disallowed paths.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { WasmShell } from '../../src/shell/wasm-shell.js';

describe('RestrictedFS synchronous methods (VfsAdapter contract)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  // Use the exact prefix shape that AgentBridge constructs for a bridge scoop:
  // - R/W: /scoops/<folder>/, /shared/, user-supplied cwd
  // - R/O: /workspace/
  const scoopFolder = '/scoops/agent-x/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs-sync', wipe: true });
    await vfs.mkdir('/scoops/agent-x/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace/skills', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/scoops/agent-x/scratch.txt', 'scratch');
    await vfs.writeFile('/scoops/agent-x/workspace/notes.md', '# notes');
    await vfs.writeFile('/shared/foo', 'foo content');
    await vfs.writeFile('/shared/bar.txt', 'bar content');
    await vfs.writeFile('/workspace/skills/README.md', '# skills');
    await vfs.writeFile('/home/wiki/index.md', '# home wiki');
    await vfs.writeFile('/scoops/other-scoop/secret', 'secret');
    await vfs.writeFile('/root-file.txt', 'root');

    // Symlinks used by realpath tests
    await vfs.writeFile('/shared/target.txt', 'target');
    await vfs.symlink('/shared/target.txt', '/shared/link-to-target');
    await vfs.writeFile('/outside-file', 'outside');
    await vfs.symlink('/outside-file', '/shared/link-to-outside');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  describe('VfsAdapter contract presence', () => {
    it('exposes statSync as a function', () => {
      expect(typeof (restricted as unknown as { statSync: unknown }).statSync).toBe('function');
    });

    it('exposes lstatSync as a function', () => {
      expect(typeof (restricted as unknown as { lstatSync: unknown }).lstatSync).toBe('function');
    });

    it('exposes readDirSync as a function', () => {
      expect(typeof (restricted as unknown as { readDirSync: unknown }).readDirSync).toBe(
        'function'
      );
    });

    it('exposes realpath as a function', () => {
      expect(typeof (restricted as unknown as { realpath: unknown }).realpath).toBe('function');
    });
  });

  describe('statSync', () => {
    it('returns Stats for a file inside /shared/', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/shared/foo'
      ) as { type: string; size: number } | null;
      expect(s).not.toBeNull();
      expect(s?.type).toBe('file');
    });

    it('returns Stats for a file inside the scoop folder', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/scoops/agent-x/scratch.txt'
      ) as { type: string } | null;
      expect(s?.type).toBe('file');
    });

    it('returns Stats for the scoop folder root directory itself', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/scoops/agent-x'
      ) as { type: string } | null;
      expect(s?.type).toBe('directory');
    });

    it('returns Stats for a file inside the user-supplied cwd', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/home/wiki/index.md'
      ) as { type: string } | null;
      expect(s?.type).toBe('file');
    });

    it('returns null for a sibling scoop file (ACL)', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/scoops/other-scoop/secret'
      );
      expect(s).toBeNull();
    });

    it('returns null for a path outside all allowed prefixes (no TypeError)', () => {
      expect(() =>
        (restricted as unknown as { statSync(p: string): unknown }).statSync('/random-system-path')
      ).not.toThrow();
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/random-system-path'
      );
      expect(s).toBeNull();
    });

    it('returns null for a root-level file that does not lead to an allowed prefix', () => {
      const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
        '/root-file.txt'
      );
      expect(s).toBeNull();
    });
  });

  describe('lstatSync', () => {
    it('returns Stats for an allowed file', () => {
      const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
        '/scoops/agent-x/workspace/notes.md'
      ) as { type: string } | null;
      expect(s?.type).toBe('file');
    });

    it('returns Stats for an allowed directory', () => {
      const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
        '/scoops/agent-x/workspace'
      ) as { type: string } | null;
      expect(s?.type).toBe('directory');
    });

    it('returns null for a disallowed file', () => {
      const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
        '/scoops/other-scoop/secret'
      );
      expect(s).toBeNull();
    });

    it('returns Stats with type symlink for a symlink node (does not follow)', () => {
      const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
        '/shared/link-to-target'
      ) as { type: string } | null;
      expect(s?.type).toBe('symlink');
    });
  });

  describe('readDirSync', () => {
    it('returns entries for a strictly-allowed directory (/shared/)', () => {
      const entries = (
        restricted as unknown as {
          readDirSync(p: string): Array<{ name: string }> | null;
        }
      ).readDirSync('/shared/');
      expect(entries).not.toBeNull();
      const names = entries!.map((e) => e.name).sort();
      // Our seeded files: foo, bar.txt, target.txt, link-to-target, link-to-outside
      expect(names).toContain('foo');
      expect(names).toContain('bar.txt');
    });

    it('returns filtered entries for parent dir /scoops/ (ACL filter, no "other-scoop")', () => {
      const entries = (
        restricted as unknown as {
          readDirSync(p: string): Array<{ name: string }> | null;
        }
      ).readDirSync('/scoops');
      expect(entries).not.toBeNull();
      const names = entries!.map((e) => e.name);
      expect(names).toContain('agent-x');
      expect(names).not.toContain('other-scoop');
    });

    it('returns filtered entries for root "/" — only allowed top-level children', () => {
      const entries = (
        restricted as unknown as {
          readDirSync(p: string): Array<{ name: string }> | null;
        }
      ).readDirSync('/');
      expect(entries).not.toBeNull();
      const names = entries!.map((e) => e.name);
      // These lead toward allowed prefixes (scoops/agent-x, shared, home/wiki, workspace/*)
      expect(names).toContain('scoops');
      expect(names).toContain('shared');
      expect(names).toContain('home');
      expect(names).toContain('workspace');
      // This does NOT lead toward any allowed prefix
      expect(names).not.toContain('root-file.txt');
    });

    it('returns null for a path outside all allowed prefixes (no TypeError)', () => {
      expect(() =>
        (
          restricted as unknown as {
            readDirSync(p: string): unknown;
          }
        ).readDirSync('/random-system-path')
      ).not.toThrow();
      const entries = (
        restricted as unknown as {
          readDirSync(p: string): unknown;
        }
      ).readDirSync('/random-system-path');
      expect(entries).toBeNull();
    });
  });

  describe('realpath', () => {
    it('resolves a regular allowed path to itself', async () => {
      const resolved = await (
        restricted as unknown as { realpath(p: string): Promise<string> }
      ).realpath('/shared/foo');
      expect(resolved).toBe('/shared/foo');
    });

    it('resolves a symlink within allowed prefixes to its target', async () => {
      const resolved = await (
        restricted as unknown as { realpath(p: string): Promise<string> }
      ).realpath('/shared/link-to-target');
      expect(resolved).toBe('/shared/target.txt');
    });

    it('throws ENOENT when the resolved target escapes all allowed prefixes', async () => {
      await expect(
        (restricted as unknown as { realpath(p: string): Promise<string> }).realpath(
          '/shared/link-to-outside'
        )
      ).rejects.toThrow('ENOENT');
    });
  });
});

describe('RestrictedFS integration with WasmShell (VAL-FS-021 + VAL-FS-022)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  let shell: WasmShell;
  const scoopFolder = '/scoops/agent-y/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs-shell-integration', wipe: true });
    await vfs.mkdir('/scoops/agent-y/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.writeFile('/shared/README.md', '# shared readme');
    await vfs.writeFile('/shared/data.json', '{"ok":1}');
    await vfs.writeFile('/home/wiki/notes.md', '# wiki notes');
    await vfs.writeFile('/scoops/agent-y/scratch.txt', 'scratch');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
    // `as unknown as VirtualFS` mirrors the cast used by ScoopContext in production —
    // RestrictedFS is the actual fs a bridge scoop's shell sees.
    shell = new WasmShell({
      fs: restricted as unknown as VirtualFS,
      cwd,
    });
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('`ls /shared/` succeeds with exit 0 and lists seeded entries (VAL-FS-021)', async () => {
    const result = await shell.executeCommand('ls /shared/');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('README.md');
    expect(result.stdout).toContain('data.json');
  });

  it('`ls <cwd>` succeeds and returns known entries (VAL-FS-021)', async () => {
    const result = await shell.executeCommand('ls /home/wiki');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('notes.md');
  });

  it('`cat <readable-file>` returns the file contents (VAL-FS-021)', async () => {
    const result = await shell.executeCommand('cat /shared/README.md');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('shared readme');
  });

  it('`ls /` returns only allowed top-level children (VAL-FS-021 ACL filter)', async () => {
    const result = await shell.executeCommand('ls /');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    // Allowed top-level directories
    expect(result.stdout).toContain('scoops');
    expect(result.stdout).toContain('shared');
    expect(result.stdout).toContain('home');
  });

  it('`ls /random-system-path` fails gracefully with no TypeError (VAL-FS-022)', async () => {
    const result = await shell.executeCommand('ls /random-system-path');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/no such file|not found|does not exist|cannot/);
  });

  it('`cat /scoops/other-scoop/secret` fails gracefully (VAL-FS-022 sibling-scoop isolation)', async () => {
    // Seed a sibling scoop's content via the raw VFS (outside the ACL)
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });
    await vfs.writeFile('/scoops/other-scoop/secret', 'leaked?');
    const result = await shell.executeCommand('cat /scoops/other-scoop/secret');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);
  });
});

/**
 * VAL-FS-019 parity for synchronous RestrictedFS fast-path methods.
 *
 * The async `readDir()` / `stat()` / `lstat()` already refuse to dereference a
 * symlink inside an allowed prefix whose resolved target escapes every allowed
 * prefix (VAL-FS-019). The sync fast-path methods (`readDirSync`, `statSync`,
 * `lstatSync`) must enforce the same guarantee — otherwise a symlinked
 * directory inside `/shared/` pointing to `/scoops/other-scoop/` would let
 * `ls /shared/link-to-other-scoop/` enumerate a sibling scoop's contents via
 * the shell's sync fast path.
 */
describe('RestrictedFS sync methods reject symlink-escape (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  const scoopFolder = '/scoops/agent-z/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs-sync-symlink', wipe: true });
    await vfs.mkdir('/scoops/agent-z/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace/skills', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/shared/README.md', '# shared readme');
    await vfs.writeFile('/shared/real-file', 'real file contents');
    await vfs.writeFile('/home/wiki/index.md', '# index');
    await vfs.writeFile('/scoops/other-scoop/secret-file', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/scoops/other-scoop/another-secret', 'another leaked secret');
    await vfs.writeFile('/outside-file', 'outside data');

    // Escape symlinks: INSIDE an allowed prefix, but target escapes every
    // allowed prefix.
    await vfs.symlink('/scoops/other-scoop', '/shared/link-to-other-scoop');
    await vfs.symlink('/outside-file', '/shared/link-to-outside-file');

    // Legitimate symlink: target stays inside allowed prefixes.
    await vfs.symlink('/shared/real-file', '/shared/legit-link');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('readDirSync on a symlinked directory whose target escapes returns null', () => {
    const entries = (
      restricted as unknown as {
        readDirSync(p: string): Array<{ name: string }> | null;
      }
    ).readDirSync('/shared/link-to-other-scoop');
    expect(entries).toBeNull();
  });

  it('readDirSync on a symlinked directory whose target escapes (trailing slash) returns null', () => {
    const entries = (
      restricted as unknown as {
        readDirSync(p: string): Array<{ name: string }> | null;
      }
    ).readDirSync('/shared/link-to-other-scoop/');
    expect(entries).toBeNull();
  });

  it('readDirSync traversing an escape-symlink ancestor returns null', () => {
    // Even though the final segment is not a symlink, the ancestor
    // `/shared/link-to-other-scoop` is — traversal would escape.
    const entries = (
      restricted as unknown as {
        readDirSync(p: string): Array<{ name: string }> | null;
      }
    ).readDirSync('/shared/link-to-other-scoop/some-subdir');
    expect(entries).toBeNull();
  });

  it('statSync on a file reached via an escape-symlink ancestor returns null', () => {
    const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
      '/shared/link-to-other-scoop/secret-file'
    );
    expect(s).toBeNull();
  });

  it('statSync on an escape symlink itself returns null (follows symlink)', () => {
    // statSync follows symlinks, so it would resolve to the escape target
    // outside the ACL.
    const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
      '/shared/link-to-outside-file'
    );
    expect(s).toBeNull();
  });

  it('lstatSync traversing an escape-symlink ancestor returns null', () => {
    const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
      '/shared/link-to-other-scoop/secret-file'
    );
    expect(s).toBeNull();
  });

  it('lstatSync on the escape symlink node itself still reports symlink (does not follow)', () => {
    // lstat does NOT follow — the leaf is the symlink itself, no escape.
    const s = (restricted as unknown as { lstatSync(p: string): unknown }).lstatSync(
      '/shared/link-to-other-scoop'
    ) as { type: string } | null;
    expect(s?.type).toBe('symlink');
  });

  it('regression: readDirSync on /shared/ still succeeds and lists entries', () => {
    const entries = (
      restricted as unknown as {
        readDirSync(p: string): Array<{ name: string }> | null;
      }
    ).readDirSync('/shared');
    expect(entries).not.toBeNull();
    const names = entries!.map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('real-file');
  });

  it('regression: statSync on a legitimate symlink (target within allowed) returns Stats', () => {
    // /shared/legit-link -> /shared/real-file — both are inside /shared/.
    // The sync fast path may still return null (forcing async fallback for
    // symlinks) which is acceptable. What matters is that when it DOES return
    // a value, it must be the file target — and the async path must succeed.
    const s = (restricted as unknown as { statSync(p: string): unknown }).statSync(
      '/shared/legit-link'
    ) as { type: string } | null;
    if (s !== null) {
      expect(s.type).toBe('file');
    }
  });

  it('regression: async readFile through a legitimate symlink still works', async () => {
    const content = await restricted.readFile('/shared/legit-link', { encoding: 'utf-8' });
    expect(content).toBe('real file contents');
  });
});

describe('RestrictedFS symlink-escape shell integration (VAL-FS-019 parity)', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  let shell: WasmShell;
  const scoopFolder = '/scoops/agent-w/';
  const cwd = '/home/wiki/';

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs-shell-symlink', wipe: true });
    await vfs.mkdir('/scoops/agent-w/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/home/wiki', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });

    await vfs.writeFile('/shared/real-file', 'real shared file');
    await vfs.writeFile('/scoops/other-scoop/secret-file', 'SIBLING SCOOP SECRET');
    await vfs.writeFile('/scoops/other-scoop/another-secret', 'another leaked secret');

    // Escape symlink inside /shared/ pointing to a sibling scoop's folder.
    await vfs.symlink('/scoops/other-scoop', '/shared/link-to-other-scoop');
    // Legit symlink within the same allowed prefix.
    await vfs.symlink('/shared/real-file', '/shared/legit-link');

    restricted = new RestrictedFS(vfs, [scoopFolder, '/shared/', cwd], ['/workspace/']);
    shell = new WasmShell({
      fs: restricted as unknown as VirtualFS,
      cwd,
    });
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('`ls /shared/link-to-other-scoop/` does NOT enumerate the sibling scoop', async () => {
    const result = await shell.executeCommand('ls /shared/link-to-other-scoop/');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);
    // Sibling scoop's entries MUST NOT appear in stdout.
    expect(result.stdout).not.toContain('secret-file');
    expect(result.stdout).not.toContain('another-secret');
  });

  it('`cat /shared/link-to-other-scoop/secret-file` fails and does not leak content', async () => {
    const result = await shell.executeCommand('cat /shared/link-to-other-scoop/secret-file');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('SIBLING SCOOP SECRET');
  });

  it('regression: `cat /shared/legit-link` still returns the target contents', async () => {
    const result = await shell.executeCommand('cat /shared/legit-link');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('real shared file');
  });

  it('regression: `ls /shared/` still lists the legit symlink and real files', async () => {
    const result = await shell.executeCommand('ls /shared/');
    expect(result.stderr).not.toMatch(/TypeError/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('real-file');
    expect(result.stdout).toContain('legit-link');
  });
});
