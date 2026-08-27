/**
 * Regression guard: `split FILE PREFIX` could never succeed in SLICC.
 *
 * just-bash runs `split` as a transaction — every chunk is written to a hidden
 * staging file, then the input and the outputs are re-identified, and only then
 * are the staged files moved into place. The re-check calls `identitiesMatch()`,
 * which fails closed when an EXISTING entry has no stable identity:
 *
 *     e.existence === "existing"
 *       ? e.stableIdentity !== undefined && e.stableIdentity === t.stableIdentity
 *       : ...
 *
 * `VfsAdapter.stat()` returned no `dev`/`ino`/`identity`, so `stableIdentity`
 * was always `undefined`, the comparison was `undefined !== undefined` → false,
 * and split threw `input identity changed during split` against a file nothing
 * had touched. The rollback removed every staged chunk and reported the generic:
 *
 *     $ split -b 30000 IN706358.b64 chunk_
 *     split: failed to write output
 *     $ ls chunk_*
 *     ls: chunk_*: No such file or directory
 *
 * Size-independent and reproducible on any file. The stdin form
 * (`split -b N - PREFIX`) always worked — no input file to re-identify — which
 * is why it is pinned here too: it is the workaround, and the fix must not
 * trade one form for the other.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

let dbCounter = 0;
let vfs: VirtualFS;
let shell: AlmostBashShellHeadless;

// 129_200 bytes — the length of the base64 payload from the field report, so
// the chunk arithmetic below matches what a real caller saw.
const BODY = 'A'.repeat(129_200);

/** Names under /workspace with the given prefix. Read from the VFS rather than
 *  parsed out of `ls`, so the guard cannot drift with `ls`' formatting. */
async function named(prefix: string): Promise<string[]> {
  const entries = await vfs.readDir('/workspace');
  return entries
    .map((e) => e.name)
    .filter((n) => n.startsWith(prefix))
    .sort();
}

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `split-identity-${dbCounter++}`, wipe: true });
  await vfs.mkdir('/workspace', { recursive: true });
  await vfs.writeFile('/workspace/payload.b64', BODY);
  shell = new AlmostBashShellHeadless({ fs: vfs });
});

describe('split — file form', () => {
  it('writes its chunks instead of rolling them back', async () => {
    const r = await shell.executeCommand('cd /workspace && split -b 30000 payload.b64 chunk_');
    expect(r.stderr).not.toContain('failed to write output');
    expect(r.exitCode).toBe(0);
    // ceil(129200 / 30000) = 5
    expect(await named('chunk_')).toEqual([
      'chunk_aa',
      'chunk_ab',
      'chunk_ac',
      'chunk_ad',
      'chunk_ae',
    ]);
    expect((await vfs.stat('/workspace/chunk_aa')).size).toBe(30000);
    expect((await vfs.stat('/workspace/chunk_ae')).size).toBe(129200 - 4 * 30000);
  });

  it('reassembles to the original byte-for-byte', async () => {
    const r = await shell.executeCommand(
      'cd /workspace && split -b 30000 payload.b64 chunk_ && cat chunk_* > rejoined.b64'
    );
    expect(r.exitCode).toBe(0);
    expect(await vfs.readTextFile('/workspace/rejoined.b64')).toBe(BODY);
  });

  it('leaves the input untouched', async () => {
    await shell.executeCommand('cd /workspace && split -b 30000 payload.b64 chunk_');
    expect(await vfs.readTextFile('/workspace/payload.b64')).toBe(BODY);
  });

  it('still refuses to overwrite its own input', async () => {
    // The identity plumbing feeds this check — it must not weaken it. `xab` is
    // the classic collision: splitting it with the default prefix `x` would
    // emit `xaa`, `xab`, … and the second output IS the input.
    await vfs.writeFile('/workspace/xab', 'A'.repeat(200));
    const r = await shell.executeCommand('cd /workspace && split -b 100 xab');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('would overwrite input');
    expect(await vfs.readTextFile('/workspace/xab')).toBe('A'.repeat(200));
    expect(await named('xa')).toEqual(['xab']);
  });
});

describe('split — stdin form (the workaround, still intact)', () => {
  it('writes its chunks', async () => {
    const r = await shell.executeCommand(
      'cd /workspace && cat payload.b64 | split -b 30000 - piped_'
    );
    expect(r.exitCode).toBe(0);
    expect(await named('piped_')).toHaveLength(5);
  });
});

describe('VfsAdapter — stat identity', () => {
  it('names the file, not the path', async () => {
    const adapter = new VfsAdapter(vfs);
    await vfs.writeFile('/workspace/other.b64', 'other');
    const a = await adapter.stat('/workspace/payload.b64');
    const b = await adapter.stat('/workspace/other.b64');
    expect(a.identity).toBeDefined();
    expect(a.identity).not.toBe(b.identity);
  });

  it('survives a rewrite — same file, new contents', async () => {
    const adapter = new VfsAdapter(vfs);
    const before = await adapter.stat('/workspace/payload.b64');
    await vfs.writeFile('/workspace/payload.b64', 'replaced');
    expect((await adapter.stat('/workspace/payload.b64')).identity).toBe(before.identity);
  });

  it('agrees between stat and lstat', async () => {
    const adapter = new VfsAdapter(vfs);
    const [st, lst] = [
      await adapter.stat('/workspace/payload.b64'),
      await adapter.lstat('/workspace/payload.b64'),
    ];
    expect(lst.identity).toBe(st.identity);
  });

  it('withholds an identity where none can be trusted', async () => {
    // ZenFS pins `/` to inode 0, and a sidecar poisoned the way #2146 describes
    // hands out 0 for many entries until the pre-boot repair renumbers them. A
    // collided identity is worse than none, so inode 0 stays unnamed — as do
    // the synthetic /usr entries, which have no VFS entry at all.
    const adapter = new VfsAdapter(vfs);
    expect((await adapter.stat('/')).identity).toBeUndefined();
    expect((await adapter.stat('/usr/bin')).identity).toBeUndefined();
  });
});
