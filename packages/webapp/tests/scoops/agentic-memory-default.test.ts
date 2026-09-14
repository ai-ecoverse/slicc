import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import { DEFAULT_MEMORY_MD, runAgenticMemoryPass } from '../../src/scoops/agentic-memory.js';
import { createDefaultSharedFiles } from '../../src/scoops/skills.js';

let dbCounter = 0;
let vfs: VirtualFS | undefined;

afterEach(async () => {
  await vfs?.dispose();
  vfs = undefined;
});

const stubVfs = (memoryMd: string) => ({
  readFile: async (path: string) => {
    if (path === '/shared/MEMORY.md') return memoryMd;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  },
  writeFile: async () => {},
  mkdir: async () => {},
});

describe('bundled MEMORY.md', () => {
  it('parses as the runner fallback', async () => {
    const spawn = vi.fn(async () => ({ finalText: 'done', exitCode: 0 }));

    await expect(
      runAgenticMemoryPass({
        spawn,
        vfs: stubVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: '/sessions/frozen.md',
        sessionCount: 1,
      })
    ).resolves.toEqual({ ok: true, report: 'done' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('can write the scratch path its prompt names, using only the grants it is spawned with', async () => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'done',
        exitCode: 0,
      })
    );
    await runAgenticMemoryPass({
      spawn,
      vfs: stubVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: '/sessions/frozen.md',
      sessionCount: 1,
    });
    const { writablePaths = [], name, prompt } = spawn.mock.calls[0][0];
    expect(writablePaths).toEqual(['/sessions/.curation/frozen.md/draft.md']);
    const scratchFolder = `/scoops/agent-${name}`;

    expect(prompt).toContain(`${scratchFolder}/draft.md`);

    expect(prompt).not.toContain('/tmp/memory-draft.md');

    vfs = await VirtualFS.create({ dbName: `memory-scratch-${dbCounter++}`, wipe: true });
    await vfs.mkdir(scratchFolder, { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });

    const restricted = new RestrictedFS(vfs, [...writablePaths, `${scratchFolder}/`]);

    await restricted.writeFile(`${scratchFolder}/draft.md`, 'draft');
    expect(await restricted.readFile(`${scratchFolder}/draft.md`, { encoding: 'utf-8' })).toBe(
      'draft'
    );

    await expect(restricted.writeFile('/workspace/CLAUDE.md.bak', 'copy')).rejects.toThrow(
      'EACCES'
    );
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
