/**
 * `createBlindReadFs` — a memory pass's reads outside `visiblePaths` are
 * told apart from reads of a missing file (#3459): recorded on the ledger,
 * raised as `EACCES … unknown, not absent` where the sandbox raised
 * `ENOENT`, and answered with the sandbox's own empty value where it never
 * threw. Inside the roots, and for a genuinely missing file there, nothing
 * changes.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlindReadLog } from '../../src/base/blind-reads.js';
import { BLIND_READ_MESSAGE, createBlindReadFs } from '../../src/fs/blind-read-fs.js';
import { RestrictedFS, VirtualFS } from '../../src/fs/index.js';
import { MONKEYPATCH_UNSAFE_FS } from '../../src/fs/sudo-fs.js';

const VISIBLE = ['/sessions/', '/shared/', '/workspace/'];

describe('createBlindReadFs', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;
  let log: BlindReadLog;
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-blind-read-${dbCounter++}`, wipe: true });
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/sessions/.curation/dream-x.md', { recursive: true });
    await vfs.writeFile('/etc/llmstxtignore', 'www.printful.com\n');
    await vfs.writeFile('/workspace/CLAUDE.md', '# Memory\n');
    await vfs.writeFile('/sessions/.curation/dream-x.md/draft.md', '# Memory\n');
    restricted = new RestrictedFS(vfs, ['/sessions/.curation/dream-x.md/draft.md'], VISIBLE);
    log = new BlindReadLog(VISIBLE);
    fs = createBlindReadFs(restricted as unknown as VirtualFS, restricted, log);
  });

  afterEach(async () => {
    await vfs.dispose();
  });

  it('raises the blind error, not ENOENT, for a content read outside the roots — and records it', async () => {
    await expect(fs.readFile('/etc/llmstxtignore', { encoding: 'utf-8' })).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining(BLIND_READ_MESSAGE),
      path: '/etc/llmstxtignore',
    });
    await expect(fs.readTextFile('/etc/MEMORY.md')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(fs.readFileRange('/etc/llmstxtignore', 0, 4)).rejects.toMatchObject({
      code: 'EACCES',
    });
    await expect(fs.stat('/etc')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(fs.lstat('/etc/llmstxtignore')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(fs.realpath('/etc/llmstxtignore')).rejects.toMatchObject({ code: 'EACCES' });
    // The sandbox underneath still says ENOENT — the decorator is what changed.
    await expect(restricted.readFile('/etc/llmstxtignore')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(log.outsidePaths()).toEqual(['/etc/llmstxtignore', '/etc/MEMORY.md', '/etc']);
  });

  it("keeps the sandbox's empty answers for the probes the shell relies on, but records them", async () => {
    expect(await fs.exists('/etc/llmstxtignore')).toBe(false);
    expect(await fs.getNativeFile('/etc/llmstxtignore')).toBeNull();
    expect(await fs.readDir('/etc')).toEqual([]);
    const walked: string[] = [];
    for await (const path of fs.walk('/etc')) walked.push(path);
    expect(walked).toEqual([]);
    expect(log.outsidePaths()).toEqual(['/etc/llmstxtignore', '/etc']);
  });

  it('records a parent listing as filtered and forwards it unchanged', async () => {
    const entries = await fs.readDir('/');
    expect(entries.map((entry) => entry.name).sort()).toEqual(['sessions', 'workspace']);
    const note = log.takeNote();
    expect(note).toContain('[filtered listing] /');
    expect(note).not.toContain('[not visible');
    expect(log.outsidePaths()).toEqual([]);
  });

  it('leaves reads inside the roots alone — a missing file there is still ENOENT', async () => {
    expect(await fs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' })).toBe('# Memory\n');
    expect(await fs.exists('/workspace/CLAUDE.md')).toBe(true);
    await expect(fs.readFile('/workspace/absent.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat('/sessions/absent.md')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(log.outsidePaths()).toEqual([]);
    expect(log.takeNote()).toBeUndefined();
  });

  it('answers a symlink escape as not found, not as a blind read', async () => {
    await vfs.symlink('/etc/llmstxtignore', '/workspace/escape');
    await expect(fs.readFile('/workspace/escape')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(log.outsidePaths()).toEqual([]);
  });

  it('lets a sudoers read grant widen the roots', async () => {
    restricted.setReadGrants(['/etc/**']);
    expect(await fs.readFile('/etc/llmstxtignore', { encoding: 'utf-8' })).toBe(
      'www.printful.com\n'
    );
    expect(log.outsidePaths()).toEqual([]);
  });

  it('passes writes and the memory draft through, and advertises the monkeypatch marker', async () => {
    await fs.writeFile('/sessions/.curation/dream-x.md/draft.md', '# Memory\n- fact\n');
    expect(
      await vfs.readFile('/sessions/.curation/dream-x.md/draft.md', { encoding: 'utf-8' })
    ).toBe('# Memory\n- fact\n');
    await expect(fs.writeFile('/etc/llmstxtignore', 'x')).rejects.toMatchObject({ code: 'EACCES' });
    expect((fs as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBe(true);
  });
});
