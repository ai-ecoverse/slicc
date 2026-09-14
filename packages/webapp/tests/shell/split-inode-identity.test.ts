import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

let dbCounter = 0;
let vfs: VirtualFS;
let shell: AlmostBashShellHeadless;

const BODY = 'A'.repeat(129_200);

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
    const adapter = new VfsAdapter(vfs);
    expect((await adapter.stat('/')).identity).toBeUndefined();
    expect((await adapter.stat('/usr/bin')).identity).toBeUndefined();
  });
});
