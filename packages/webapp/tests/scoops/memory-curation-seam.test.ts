import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../src/fs/index.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import {
  createMemorySeam,
  MEMORY_SEAM_GLOBAL_KEY,
  publishMemorySeam,
} from '../../src/scoops/memory-curation-seam.js';

interface SeamGlobals {
  __slicc_agent?: { spawn(options: AgentSpawnOptions): Promise<AgentSpawnResult> };
  __slicc_memory?: unknown;
}

const globals = globalThis as unknown as SeamGlobals;

/**
 * Just enough VFS for a pass: instruction docs and the live memory read from
 * `files`, writes (snapshot seeding) land in `writes`, everything else is
 * ENOENT. Cast to VirtualFS — the seam only touches this structural subset.
 */
function fakeVfs(files: Record<string, string>) {
  const writes = new Map<string, string>();
  const vfs = {
    readFile: vi.fn(async (path: string) => {
      const written = writes.get(path);
      if (written !== undefined) return written;
      const content = files[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return content;
    }),
    writeFile: vi.fn(async (path: string, body: string) => {
      writes.set(path, body);
    }),
    mkdir: vi.fn(async () => {}),
  };
  return { vfs: vfs as unknown as VirtualFS, writes };
}

describe('createMemorySeam', () => {
  afterEach(() => {
    globals.__slicc_agent = undefined;
    globals.__slicc_memory = undefined;
    vi.restoreAllMocks();
  });

  it('fails soft on both verbs when no agent bridge is published', async () => {
    const seam = createMemorySeam(fakeVfs({}).vfs);
    for (const result of [
      await seam.curate({ sessionArchivePath: '/sessions/a.md', sessionCount: 1 }),
      await seam.dream({}),
    ]) {
      expect(result).toEqual({
        ok: false,
        reason: 'agent bridge not published yet',
        legacyFallbackSafe: false,
      });
    }
  });

  it('dream derives the session count from the index and runs the dreamer pass', async () => {
    const spawn = vi.fn(async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => {
      return { finalText: 'consolidated', exitCode: 0 };
    });
    globals.__slicc_agent = { spawn };
    const { vfs } = fakeVfs({
      '/sessions/index.json': JSON.stringify([
        { filename: 'a.md', title: 'a', frozenAt: '2026-09-01T00:00:00Z', messageCount: 1 },
        { filename: 'b.md', title: 'b', frozenAt: '2026-09-02T00:00:00Z', messageCount: 1 },
      ]),
      '/shared/DREAMING.md': 'Dream {{MEMORY_PATH}}: {{SESSION_COUNT}} sessions.',
      '/workspace/CLAUDE.md': '# memories\n',
    });

    const result = await createMemorySeam(vfs).dream({ today: '2026-09-11' });

    expect(result).toEqual({ ok: true, report: 'consolidated' });
    const options = spawn.mock.calls[0][0];
    expect(options.name).toBe('memory-dreamer');
    expect(options.prompt).toContain('2 sessions');
  });

  it('publishMemorySeam exposes the seam on the documented global key', () => {
    const seam = createMemorySeam(fakeVfs({}).vfs);
    publishMemorySeam(seam);
    expect(globals[MEMORY_SEAM_GLOBAL_KEY as '__slicc_memory']).toBe(seam);
  });
});
