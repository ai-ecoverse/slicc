import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { DEFAULT_MEMORY_MD, runAgenticMemoryPass } from '../../src/scoops/agentic-memory.js';
import { createDefaultSharedFiles } from '../../src/scoops/skills.js';

let dbCounter = 0;
let vfs: VirtualFS | undefined;

afterEach(async () => {
  await vfs?.dispose();
  vfs = undefined;
});

describe('bundled MEMORY.md', () => {
  it('parses as the runner fallback', async () => {
    const spawn = vi.fn(async () => ({ finalText: 'done', exitCode: 0 }));

    await expect(
      runAgenticMemoryPass({
        spawn,
        vfs: { readFile: async () => DEFAULT_MEMORY_MD },
        sessionArchivePath: '/sessions/frozen.md',
        sessionCount: 1,
      })
    ).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('is seeded on a fresh VFS without overwriting user edits', async () => {
    vfs = await VirtualFS.create({ dbName: `memory-default-${dbCounter++}`, wipe: true });

    await createDefaultSharedFiles(vfs);
    expect(await vfs.readFile('/shared/MEMORY.md', { encoding: 'utf-8' })).toBe(DEFAULT_MEMORY_MD);

    await vfs.writeFile('/shared/MEMORY.md', 'custom memory curator');
    await createDefaultSharedFiles(vfs);
    expect(await vfs.readFile('/shared/MEMORY.md', { encoding: 'utf-8' })).toBe(
      'custom memory curator'
    );
  });
});
