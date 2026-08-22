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
    ).resolves.toEqual({ ok: true, report: 'done' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  // The prompt tells the curator to draft in `/tmp/` rather than beside the
  // memory file. That instruction is only true because `/tmp` is writable for
  // every sandbox regardless of ACLs (`ALWAYS_WRITABLE_PREFIXES`) — the shipped
  // `writablePaths` never mentions it. Lose that exemption and the curator is
  // back to escalating a sudo request mid-pass, so pin the pair together.
  it('can write the scratch path its prompt names, using only the shipped grants', async () => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'done',
        exitCode: 0,
      })
    );
    await runAgenticMemoryPass({
      spawn,
      vfs: { readFile: async () => DEFAULT_MEMORY_MD },
      sessionArchivePath: '/sessions/frozen.md',
      sessionCount: 1,
    });
    const writablePaths = spawn.mock.calls[0][0].writablePaths ?? [];
    expect(writablePaths).toEqual(['/workspace/CLAUDE.md']);
    expect(DEFAULT_MEMORY_MD).toContain('/tmp/memory-draft.md');

    vfs = await VirtualFS.create({ dbName: `memory-scratch-${dbCounter++}`, wipe: true });
    await vfs.mkdir('/tmp', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    const restricted = new RestrictedFS(vfs, writablePaths);

    await restricted.writeFile('/tmp/memory-draft.md', 'draft');
    expect(await restricted.readFile('/tmp/memory-draft.md', { encoding: 'utf-8' })).toBe('draft');
    // A scratch copy beside the memory file stays blocked — the reason the
    // prompt sends drafts to `/tmp` instead of next door.
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
