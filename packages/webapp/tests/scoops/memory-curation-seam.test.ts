import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../src/fs/index.js';
import {
  AGENT_NAME_IN_USE_PREFIX,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../src/scoops/agent-bridge.js';
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
    // The seam seeds `/etc/MEMORY.md` only when absent; a fixture that
    // provides the document must answer the existence probe.
    stat: vi.fn(async (path: string) => {
      if (writes.has(path) || files[path] !== undefined) return { size: 1 };
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }),
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
      '/etc/MEMORY.md':
        '---\ntimeoutSeconds: 60\n---\nDream {{MEMORY_PATH}}: {{SESSION_COUNT}} sessions.',
      '/workspace/CLAUDE.md': '# memories\n',
    });

    const result = await createMemorySeam(vfs).dream({ today: '2026-09-11' });

    expect(result).toEqual({ ok: true, report: 'consolidated' });
    const options = spawn.mock.calls[0][0];
    expect(options.name).toBe('memory-dreamer');
    expect(options.prompt).toContain('2 sessions');
  });

  // #3849: a `memory curate` pass that landed left the archive's earlier
  // failure note in place, so `memory log` / `memory status` kept reporting
  // it failed — for the primary and for a non-primary cone alike.
  it.each([
    ['cone', '/workspace/CLAUDE.md'],
    ['cone-helix', '/cones/cone-helix/CLAUDE.md'],
  ])('curate records a success on the archive row (%s)', async (folder, memoryPath) => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'curated',
        exitCode: 0,
      })
    );
    globals.__slicc_agent = { spawn };
    const filename = `live-${folder}-mtt4z0qj-b393.md`;
    const { vfs, writes } = fakeVfs({
      '/sessions/index.json': JSON.stringify([
        { filename: 'other.md', title: 'o', frozenAt: '2026-09-01T00:00:00Z', messageCount: 1 },
        {
          filename,
          title: 't',
          frozenAt: '2026-09-08T20:42:49.339Z',
          messageCount: 1,
          cone: folder,
          memoryFailed: 'Scoop "agent-memory-curator-cone-helix" failed with …',
        },
      ]),
      '/etc/MEMORY.md': '---\ntimeoutSeconds: 60\n---\nCurate {{MEMORY_PATH}}.',
      [memoryPath]: '# memories\n',
    });

    const result = await createMemorySeam(vfs).curate({
      sessionArchivePath: `/sessions/${filename}`,
      sessionCount: 2,
      ...(folder === 'cone' ? {} : { cone: { folder } }),
    });

    expect(result).toEqual({ ok: true, report: 'curated' });
    const index = JSON.parse(writes.get('/sessions/index.json') ?? '[]');
    const row = index.find((entry: { filename: string }) => entry.filename === filename);
    expect(row.memoryFailed).toBeUndefined();
    expect(row.memoryCuratedAt).toEqual(expect.any(String));
    expect(index.find((e: { filename: string }) => e.filename === 'other.md')).toEqual({
      filename: 'other.md',
      title: 'o',
      frozenAt: '2026-09-01T00:00:00Z',
      messageCount: 1,
    });
  });

  // A pass redirected with `memory curate --cone` grew another cone's file;
  // the ledger credits the row to its own cone, so it must stay untouched.
  it('curate leaves the row alone when the pass was redirected into another cone', async () => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'curated',
        exitCode: 0,
      })
    );
    globals.__slicc_agent = { spawn };
    const row = {
      filename: 'a.md',
      title: 'a',
      frozenAt: '2026-09-01T00:00:00Z',
      messageCount: 1,
      memoryFailed: 'old',
    };
    const { vfs, writes } = fakeVfs({
      '/sessions/index.json': JSON.stringify([row]),
      '/etc/MEMORY.md': '---\ntimeoutSeconds: 60\n---\nCurate {{MEMORY_PATH}}.',
    });

    const result = await createMemorySeam(vfs).curate({
      sessionArchivePath: '/sessions/a.md',
      sessionCount: 1,
      cone: { folder: 'cone-helix' },
    });

    expect(result.ok).toBe(true);
    expect(writes.has('/sessions/index.json')).toBe(false);
  });

  it('curate records a failure note, but not for a name-in-use rejection', async () => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'bedrock returned 400',
        exitCode: 1,
      })
    );
    globals.__slicc_agent = { spawn };
    const row = { filename: 'a.md', title: 'a', frozenAt: '2026-09-01T00:00:00Z', messageCount: 1 };
    const { vfs, writes } = fakeVfs({
      '/sessions/index.json': JSON.stringify([row]),
      '/etc/MEMORY.md': '---\ntimeoutSeconds: 60\n---\nCurate {{MEMORY_PATH}}.',
    });
    const seam = createMemorySeam(vfs);

    await seam.curate({ sessionArchivePath: '/sessions/a.md', sessionCount: 1 });
    expect(JSON.parse(writes.get('/sessions/index.json') ?? '[]')[0].memoryFailed).toBe(
      'bedrock returned 400'
    );

    writes.set('/sessions/index.json', JSON.stringify([row]));
    spawn.mockResolvedValueOnce({ finalText: `${AGENT_NAME_IN_USE_PREFIX} x`, exitCode: 1 });
    await seam.curate({ sessionArchivePath: '/sessions/a.md', sessionCount: 1 });
    expect(JSON.parse(writes.get('/sessions/index.json') ?? '[]')[0]).toEqual(row);
  });

  it('publishMemorySeam exposes the seam on the documented global key', () => {
    const seam = createMemorySeam(fakeVfs({}).vfs);
    publishMemorySeam(seam);
    expect(globals[MEMORY_SEAM_GLOBAL_KEY as '__slicc_memory']).toBe(seam);
  });
});
