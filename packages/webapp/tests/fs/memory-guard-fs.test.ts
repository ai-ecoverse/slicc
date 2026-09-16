/**
 * `createMemoryGuardedFs` — every write landing on a memory file is refused
 * with an `EACCES` that names `memory_write`; everything else passes through
 * (#3157). The guard sits on the handle the shell shares with the file tools,
 * so `cp`, `cat >` and `write_file` all hit the same wall.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_FILE_GUARD_MESSAGE } from '../../src/base/memory-budget.js';
import { VirtualFS } from '../../src/fs/index.js';
import { createMemoryGuardedFs } from '../../src/fs/memory-guard-fs.js';
import { MONKEYPATCH_UNSAFE_FS } from '../../src/fs/sudo-fs.js';

describe('createMemoryGuardedFs', () => {
  let fs: VirtualFS;
  let guarded: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-memory-guard-${dbCounter++}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.mkdir('/tmp', { recursive: true });
    await fs.writeFile('/tmp/draft.md', 'draft');
    guarded = createMemoryGuardedFs(fs);
  });

  it('refuses writeFile and appendFile onto a memory file, naming memory_write', async () => {
    await expect(guarded.writeFile('/workspace/CLAUDE.md', 'x')).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining(MEMORY_FILE_GUARD_MESSAGE),
    });
    await expect(guarded.appendFile('/shared/CLAUDE.md', 'x')).rejects.toMatchObject({
      code: 'EACCES',
    });
    // Nothing landed.
    await expect(fs.readFile('/workspace/CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses rename, copyFile and symlink whose destination is a memory file', async () => {
    await expect(guarded.rename('/tmp/draft.md', '/workspace/CLAUDE.md')).rejects.toMatchObject({
      code: 'EACCES',
    });
    await expect(
      guarded.copyFile('/tmp/draft.md', '/sessions/.curation/dream-x.md/draft.md')
    ).rejects.toMatchObject({ code: 'EACCES' });
    await expect(
      guarded.symlink('/tmp/draft.md', '/cones/cone-helix/CLAUDE.md')
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readFile('/tmp/draft.md', { encoding: 'utf-8' })).toBe('draft');
  });

  it('refuses an un-normalized spelling of a memory path too', async () => {
    await expect(guarded.writeFile('/workspace//CLAUDE.md', 'x')).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('passes ordinary writes through, including a repository CLAUDE.md', async () => {
    await guarded.writeFile('/workspace/notes.md', 'notes');
    await guarded.mkdir('/workspace/repo', { recursive: true });
    await guarded.writeFile('/workspace/repo/CLAUDE.md', 'developer docs');
    expect(await fs.readFile('/workspace/notes.md', { encoding: 'utf-8' })).toBe('notes');
    expect(await fs.readFile('/workspace/repo/CLAUDE.md', { encoding: 'utf-8' })).toBe(
      'developer docs'
    );
  });

  it('passes reads and deletes of a memory file through', async () => {
    await fs.writeFile('/workspace/CLAUDE.md', 'memory');
    expect(await guarded.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' })).toBe('memory');
    expect((await guarded.stat('/workspace/CLAUDE.md')).size).toBe(6);
    await guarded.rm('/workspace/CLAUDE.md');
    await expect(fs.readFile('/workspace/CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('advertises the monkeypatch-unsafe marker like the sudo-fs Proxy', () => {
    expect((guarded as unknown as Record<symbol, unknown>)[MONKEYPATCH_UNSAFE_FS]).toBe(true);
  });
});
