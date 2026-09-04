/**
 * Regression (#2885): `git stash` push and pop/apply must move working-tree
 * bytes, not UTF-8 strings.
 *
 * Both halves used to hop through `readTextFile` (`TextDecoder` with
 * `fatal: false`) and `TextEncoder.encode`, so a dirty JPEG / zip / wasm /
 * packfile was stashed as U+FFFD and restored as `EF BF BD` — with exit code 0
 * and no warning. Unmodified files took the raw-blob path and survived, which
 * is why only DIRTY binaries corrupted.
 *
 * The fixtures are the same probes the sibling codec bugs used: a 256-byte
 * 0x00..0xFF ramp and a JPEG SOI (`FF D8 FF 98 00 41 7F 80 FE`, PR #2818). Any
 * string round-trip anywhere in the path expands or replaces the high bytes and
 * the byte-equality assertions trip.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

/** Every byte 0x00-0xFF — NUL, high bytes, and invalid UTF-8 sequences. */
function allBytes(): Uint8Array {
  return new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
}

/** The JPEG SOI probe from PR #2818. */
const JPEG_SOI = new Uint8Array([0xff, 0xd8, 0xff, 0x98, 0x00, 0x41, 0x7f, 0x80, 0xfe]);

async function readBytes(vfs: VirtualFS, path: string): Promise<Uint8Array> {
  return (await vfs.readFile(path, { encoding: 'binary' })) as Uint8Array;
}

describe('git stash binary round-trip (#2885)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-stash-binary-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-stash-binary-global-${testId}`,
    });
  });

  /** init + commit `committed` at `bin.dat`, then dirty it with `dirty`. */
  async function seedDirtyBinary(committed: Uint8Array, dirty: Uint8Array): Promise<void> {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/bin.dat', committed);
    await git.execute(['add', 'bin.dat'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');
    await vfs.writeFile('/project/bin.dat', dirty);
  }

  it('stash + pop restores a dirty all-bytes file byte for byte', async () => {
    const committed = new Uint8Array([0x00, 0x01, 0x02]);
    const dirty = allBytes();
    await seedDirtyBinary(committed, dirty);

    const push = await git.execute(['stash'], '/project');
    expect(push.exitCode).toBe(0);
    // Workdir is back to the committed bytes, unexpanded.
    expect(Array.from(await readBytes(vfs, '/project/bin.dat'))).toEqual(Array.from(committed));

    const pop = await git.execute(['stash', 'pop'], '/project');
    expect(pop.exitCode).toBe(0);
    expect(pop.stdout).toContain('Dropped refs/stash@{0}');

    const restored = await readBytes(vfs, '/project/bin.dat');
    expect(restored.byteLength).toBe(256);
    expect(Array.from(restored)).toEqual(Array.from(dirty));
  });

  it('stash + pop restores a dirty JPEG SOI probe byte for byte', async () => {
    await seedDirtyBinary(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), JPEG_SOI);

    expect((await git.execute(['stash'], '/project')).exitCode).toBe(0);
    expect((await git.execute(['stash', 'pop'], '/project')).exitCode).toBe(0);

    const restored = await readBytes(vfs, '/project/bin.dat');
    // The bug produced 21 bytes with EF BF BD runs instead of these 9.
    expect(restored.byteLength).toBe(JPEG_SOI.byteLength);
    expect(Array.from(restored)).toEqual(Array.from(JPEG_SOI));
  });

  it('stash + apply restores binary bytes and keeps the entry', async () => {
    const dirty = allBytes();
    await seedDirtyBinary(new Uint8Array([0x00]), dirty);

    await git.execute(['stash'], '/project');
    const apply = await git.execute(['stash', 'apply'], '/project');
    expect(apply.exitCode).toBe(0);
    expect(Array.from(await readBytes(vfs, '/project/bin.dat'))).toEqual(Array.from(dirty));

    const list = await git.execute(['stash', 'list'], '/project');
    expect(list.stdout).toContain('stash@{0}');
  });

  it('stashes a new (never committed) binary file and pops it back intact', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/keep.txt', 'keep');
    await git.execute(['add', 'keep.txt'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');

    const dirty = allBytes();
    await vfs.writeFile('/project/new.bin', dirty);
    await git.execute(['add', 'new.bin'], '/project');

    expect((await git.execute(['stash'], '/project')).exitCode).toBe(0);
    expect(await vfs.exists('/project/new.bin')).toBe(false);

    expect((await git.execute(['stash', 'pop'], '/project')).exitCode).toBe(0);
    expect(Array.from(await readBytes(vfs, '/project/new.bin'))).toEqual(Array.from(dirty));
  });

  it('leaves an unrelated committed binary untouched across a stash round-trip', async () => {
    const untouched = allBytes();
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/asset.bin', untouched);
    await vfs.writeFile('/project/file.txt', 'original\n');
    await git.execute(['add', '.'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');

    // Only the text file is dirty; the binary must not be rewritten as U+FFFD
    // by the stash tree walk (push records every tracked path, not just dirty).
    await vfs.writeFile('/project/file.txt', 'modified\n');
    expect((await git.execute(['stash'], '/project')).exitCode).toBe(0);
    expect(Array.from(await readBytes(vfs, '/project/asset.bin'))).toEqual(Array.from(untouched));

    expect((await git.execute(['stash', 'pop'], '/project')).exitCode).toBe(0);
    expect(Array.from(await readBytes(vfs, '/project/asset.bin'))).toEqual(Array.from(untouched));
    expect(await vfs.readTextFile('/project/file.txt')).toBe('modified\n');
  });

  it('reports a binary conflict instead of merging bytes as text', async () => {
    const committed = allBytes();
    const stashed = new Uint8Array([...allBytes(), 0xde, 0xad]);
    const local = new Uint8Array([...allBytes(), 0xbe, 0xef]);
    await seedDirtyBinary(committed, stashed);

    await git.execute(['stash'], '/project');

    // Diverge the working tree from both the base and the stash.
    await vfs.writeFile('/project/bin.dat', local);
    const pop = await git.execute(['stash', 'pop'], '/project');

    expect(pop.exitCode).toBe(1);
    expect(pop.stdout).toContain('CONFLICT (content): Merge conflict in bin.dat');
    expect(pop.stderr).toContain('warning: Cannot merge binary files: bin.dat');

    // The working-tree copy is preserved verbatim — no markers spliced into it.
    expect(Array.from(await readBytes(vfs, '/project/bin.dat'))).toEqual(Array.from(local));

    // The entry is kept so the stashed bytes are still recoverable.
    expect((await git.execute(['stash', 'list'], '/project')).stdout).toContain('stash@{0}');
  });

  it('still three-way merges disjoint text edits after the byte change', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'A\nB\nC\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');

    await vfs.writeFile('/project/file.txt', 'A\nB\nCHANGED_C\n');
    await git.execute(['stash'], '/project');

    await vfs.writeFile('/project/file.txt', 'CHANGED_A\nB\nC\n');
    const pop = await git.execute(['stash', 'pop'], '/project');

    expect(pop.exitCode).toBe(0);
    expect(await vfs.readTextFile('/project/file.txt')).toBe('CHANGED_A\nB\nCHANGED_C\n');
  });

  it('preserves a UTF-8 text file with multi-byte characters', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'plain\n');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');

    const unicode = 'héllo — 🍦 λ\n';
    await vfs.writeFile('/project/file.txt', unicode);
    await git.execute(['stash'], '/project');
    expect((await git.execute(['stash', 'pop'], '/project')).exitCode).toBe(0);

    expect(await vfs.readTextFile('/project/file.txt')).toBe(unicode);
  });
});
