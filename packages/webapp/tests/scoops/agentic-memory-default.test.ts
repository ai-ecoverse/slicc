import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { DEFAULT_MEMORY_MD } from '../../src/scoops/agentic-memory.js';
import { createDefaultSharedFiles } from '../../src/scoops/skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const bundledMemory = readFileSync(resolve(repoRoot, 'packages/vfs-root/shared/MEMORY.md'), 'utf8');

let dbCounter = 0;
let vfs: VirtualFS | undefined;

afterEach(async () => {
  await vfs?.dispose();
  vfs = undefined;
});

describe('bundled MEMORY.md', () => {
  it('matches the runner fallback exactly', () => {
    expect(bundledMemory).toBe(DEFAULT_MEMORY_MD);
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
