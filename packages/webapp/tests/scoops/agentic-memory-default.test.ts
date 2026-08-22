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

  // The prompt sends drafts to the curator's own scratch folder. That path is
  // never in the shipped `writablePaths` — the bridge unions `/scoops/agent-<name>/`
  // in at spawn time from the fixed agent name, and deletes it when the pass
  // ends. So the literal path in the prompt is only correct as long as the name
  // stays put; derive it here rather than hardcoding it, and pin that the
  // sandbox actually admits the write. Lose either half and the curator is back
  // to escalating a sudo request mid-pass (#2164).
  it('can write the scratch path its prompt names, using only the grants it is spawned with', async () => {
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
    const { writablePaths = [], name } = spawn.mock.calls[0][0];
    expect(writablePaths).toEqual(['/workspace/CLAUDE.md']);
    const scratchFolder = `/scoops/agent-${name}`;
    expect(DEFAULT_MEMORY_MD).toContain(`${scratchFolder}/draft.md`);
    // Shared `/tmp` is writable too, but a full rewrite of durable memory is
    // readable and clobberable by every other scoop there, so the prompt must
    // not send drafts to it.
    expect(DEFAULT_MEMORY_MD).not.toContain('/tmp/memory-draft.md');

    vfs = await VirtualFS.create({ dbName: `memory-scratch-${dbCounter++}`, wipe: true });
    await vfs.mkdir(scratchFolder, { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    // What `buildScoopConfig` hands the sandbox: the frontmatter grants plus
    // the scratch folder.
    const restricted = new RestrictedFS(vfs, [...writablePaths, `${scratchFolder}/`]);

    await restricted.writeFile(`${scratchFolder}/draft.md`, 'draft');
    expect(await restricted.readFile(`${scratchFolder}/draft.md`, { encoding: 'utf-8' })).toBe(
      'draft'
    );
    // A scratch copy beside the memory file stays blocked — the reason the
    // prompt sends drafts elsewhere rather than next door.
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
