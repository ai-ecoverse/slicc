/**
 * Regression guard: the VFS root must be reachable through `lstat`.
 *
 * ZenFS' `lstat` does not route the final path component through the mount
 * table. Unlike `stat` — which resolves via `resolveMount` — it parses the
 * path, resolves the PARENT to a filesystem, and then stats the basename
 * inside THAT filesystem (`@zenfs/core/dist/vfs/async.js`, the `lstat`
 * branch of `stat()`):
 *
 *     const { base, dir } = parse(path);
 *     const { fs, path: parent } = await resolve(this, dir, false, extra);
 *     const target = base ? join(parent, base) : parent;
 *     stats = cacheOf(fs).get(target)?.inode ?? (await fs.stat(target)...);
 *
 * A mount point is not an entry in its parent's filesystem — it exists only
 * in the mount table — so the lookup misses and raises ENOENT.
 *
 * Every VirtualFS mounts its backend at `/__opfs__/<dbName>` (memory:
 * `/__zenfs__/<dbName>`) and maps VFS `/` onto exactly that mount point. So
 * the root — and only the root — was unreachable via `lstat`, while
 * `stat('/')`, `exists('/')`, and `readDir('/')` all worked. On a live
 * instance that asymmetry took out `du -sh /`, `stat /`,
 * `find / -maxdepth 1 -type d`, and any path normalizing to the root:
 *
 *     $ test -d /                    -> yes
 *     $ ls -la /                     -> 19 entries
 *     $ stat /                       -> stat: cannot stat '/'
 *     $ du -sh /                     -> du: cannot access '/'
 *     $ stat /workspace/..           -> stat: cannot stat '/workspace/..'
 *
 * The root is always a directory and can never be a symlink, so `lstat` and
 * `stat` are definitionally the same answer there.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';

let dbCounter = 0;

async function makeFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `root-lstat-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/a.txt', 'hi');
  return fs;
}

describe('VirtualFS — the root is reachable through lstat', () => {
  it('lstat("/") reports a directory instead of throwing ENOENT', async () => {
    const fs = await makeFs();
    const st = await fs.lstat('/');
    expect(st.type).toBe('directory');
    expect(st.isSymlink).toBeFalsy();
  });

  it('lstat("/") agrees with stat("/")', async () => {
    const fs = await makeFs();
    const [st, lst] = [await fs.stat('/'), await fs.lstat('/')];
    expect(lst.type).toBe(st.type);
  });

  it.each(['/', '/.', '/workspace/..'])(
    'lstat(%s) resolves — every spelling of the root',
    async (path) => {
      const fs = await makeFs();
      expect((await fs.lstat(path)).type).toBe('directory');
    }
  );

  it('lstat still reports a real symlink as a symlink', async () => {
    const fs = await makeFs();
    await fs.symlink('/workspace/a.txt', '/link');
    const st = await fs.lstat('/link');
    expect(st.type).toBe('symlink');
    expect(st.symlinkTarget).toBe('/workspace/a.txt');
  });

  it('a du-style walk of / can lstat every entry it lists', async () => {
    const fs = await makeFs();
    // `du` lstats its argument and each entry it finds, and reports ANY throw
    // as `cannot access '<argument>'` — which is why the live failure blamed
    // `/` itself.
    await expect(fs.lstat('/')).resolves.toBeDefined();
    for (const entry of await fs.readDir('/')) {
      await expect(fs.lstat(`/${entry.name}`)).resolves.toBeDefined();
    }
  });

  // The sync fast path fell over for the same reason: `statSync` opens its
  // bounded symlink walk with `sync.lstatSync(current)` and returns null when
  // that throws, so the root dropped out of the fast path entirely — both
  // `statSync('/')` and `lstatSync('/')` returned null — and every caller
  // paid an unnecessary async round-trip.
  //
  // These suites run on the memory backend, where sync ops are available, so
  // null here is a real failure rather than the documented OPFS fallback
  // (sync is unavailable outside a SharedWorker there and null is correct).
  it('statSync("/") and lstatSync("/") return the root, not null', async () => {
    const fs = await makeFs();
    expect(fs.backend).toBe('memory'); // guard: null below would be legitimate on opfs
    expect(fs.statSync('/')?.type).toBe('directory');
    expect(fs.lstatSync('/')?.type).toBe('directory');
  });
});
