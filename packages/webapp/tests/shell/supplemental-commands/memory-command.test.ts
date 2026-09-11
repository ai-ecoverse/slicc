/**
 * `memory` shell command — inspection verbs over the sessions-index curation
 * ledger and the per-cone memory files, plus `curate` over the
 * `__slicc_memory` seam the kernel host publishes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsFeatureEnabled = vi.fn();
vi.mock('../../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

import type { VirtualFS } from '../../../src/fs/index.js';
import { createMemoryCommand } from '../../../src/shell/supplemental-commands/memory-command.js';

interface FakeDirEntry {
  name: string;
  type: 'file' | 'directory';
}

function memoryFs(initial: Record<string, string> = {}, dirs: Record<string, FakeDirEntry[]> = {}) {
  const files = new Map(Object.entries(initial));
  const fs = {
    files,
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    readDir: async (path: string) => {
      const entries = dirs[path];
      if (entries === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return entries;
    },
  };
  return fs as unknown as VirtualFS & { files: Map<string, string> };
}

type Globals = typeof globalThis & { __slicc_memory?: unknown };

function fakeSeam(result: { ok: true; report: string } | { ok: false; reason: string }) {
  return {
    curate: vi.fn(async () =>
      result.ok ? result : { ...result, legacyFallbackSafe: false as const }
    ),
  };
}

const ctx = { cwd: '/', env: {} } as never;

function run(fs: VirtualFS, args: string[]) {
  return createMemoryCommand({ fs }).execute(args, ctx);
}

/** A sessions-index entry; curation ledger fields ride on top. */
function entry(filename: string, frozenAt: string, extra: Record<string, unknown> = {}) {
  return { filename, title: filename, frozenAt, messageCount: 1, ...extra };
}

const INDEX_PATH = '/sessions/index.json';
const PRIMARY_MEMORY = '/workspace/CLAUDE.md';

beforeEach(() => {
  mockIsFeatureEnabled.mockReturnValue(true);
});

afterEach(() => {
  delete (globalThis as Globals).__slicc_memory;
  vi.clearAllMocks();
});

describe('memory --help', () => {
  it('prints usage for bare, --help, and <verb> --help without dispatching', async () => {
    const fs = memoryFs();
    for (const args of [[], ['--help'], ['curate', '--help']]) {
      const result = await run(fs, args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: memory');
    }
  });
});

describe('memory-v2 gating', () => {
  it('rejects every verb except status when the flag is off', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const fs = memoryFs({ [PRIMARY_MEMORY]: 'remember me' });
    for (const verb of ['show', 'log', 'curate']) {
      const result = await run(fs, [verb]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('memory-v2');
    }
    const status = await run(fs, ['status']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('OFF');
  });
});

describe('memory show', () => {
  it('prints the primary memory file', async () => {
    const fs = memoryFs({ [PRIMARY_MEMORY]: '# Memories\n- prefers tabs\n' });
    const result = await run(fs, ['show']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('# Memories\n- prefers tabs\n');
  });

  it('reads an extra cone via --cone', async () => {
    const fs = memoryFs({ '/cones/cone-side/CLAUDE.md': 'side memories\n' });
    const result = await run(fs, ['show', '--cone', 'cone-side']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('side memories\n');
  });

  it('fails when no memory file exists yet', async () => {
    const result = await run(memoryFs(), ['show']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(PRIMARY_MEMORY);
  });

  it('rejects unknown flags loudly', async () => {
    const result = await run(memoryFs(), ['show', '--bogus']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--bogus');
  });
});

describe('memory status', () => {
  it('reports files, budget, and the curation tally across cones', async () => {
    const index = [
      entry('a.md', '2026-09-01T00:00:00Z', { memoryCuratedAt: '2026-09-01T00:10:00Z' }),
      entry('b.md', '2026-09-02T00:00:00Z', { memoryPending: true }),
      entry('c.md', '2026-09-03T00:00:00Z', { memorySkipped: true }),
      entry('d.md', '2026-09-04T00:00:00Z'),
    ];
    const fs = memoryFs(
      {
        [INDEX_PATH]: JSON.stringify(index),
        [PRIMARY_MEMORY]: 'primary memories',
        '/cones/cone-side/CLAUDE.md': 'side',
      },
      { '/cones': [{ name: 'cone-side', type: 'directory' }] }
    );
    const result = await run(fs, ['status']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Memory v2:  ON');
    expect(result.stdout).toContain('4 archived');
    expect(result.stdout).toContain(PRIMARY_MEMORY);
    expect(result.stdout).toContain('/cones/cone-side/CLAUDE.md');
    expect(result.stdout).toContain('1 curated, 0 failed, 1 pending, 1 skipped, 1 unmarked');
    expect(result.stdout).toContain('Health:     ok');
  });

  it('--json emits the structured report', async () => {
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify([entry('a.md', '2026-09-01T00:00:00Z')]) });
    const result = await run(fs, ['status', '--json']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.sessions).toBe(1);
    expect(report.budgetChars).toBeGreaterThan(0);
    expect(report.curation.none).toBe(1);
  });

  it('--check exits non-zero when an archive has a failed curation', async () => {
    const fs = memoryFs({
      [INDEX_PATH]: JSON.stringify([
        entry('a.md', '2026-09-01T00:00:00Z', { memoryFailed: 'timeout' }),
      ]),
      [PRIMARY_MEMORY]: 'has content',
    });
    const result = await run(fs, ['status', '--check']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAIL');
    // Without --check, the same state reports but exits 0.
    const noCheck = await run(fs, ['status']);
    expect(noCheck.exitCode).toBe(0);
  });

  it('--check exits non-zero when curation succeeded but memory stayed empty', async () => {
    const fs = memoryFs({
      [INDEX_PATH]: JSON.stringify([
        entry('a.md', '2026-09-01T00:00:00Z', { memoryCuratedAt: '2026-09-01T00:10:00Z' }),
      ]),
    });
    const result = await run(fs, ['status', '--check']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('missing or empty');
  });
});

describe('memory log', () => {
  const index = [
    entry('old.md', '2026-09-01T00:00:00Z', { memoryCuratedAt: '2026-09-01T00:10:00Z' }),
    entry('failed.md', '2026-09-02T00:00:00Z', { memoryFailed: 'exit-1' }),
    entry('new.md', '2026-09-03T00:00:00Z', { memoryPending: true }),
  ];

  it('lists entries newest first with their ledger state', async () => {
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['log']);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toContain('new.md');
    expect(lines[0]).toContain('pending');
    expect(lines[1]).toContain('failed');
    expect(lines[1]).toContain('exit-1');
    expect(lines[2]).toContain('curated');
  });

  it('honors --limit and rejects a bad one', async () => {
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const limited = await run(fs, ['log', '--limit', '1']);
    expect(limited.stdout.trim().split('\n')).toHaveLength(1);
    const bad = await run(fs, ['log', '--limit', 'many']);
    expect(bad.exitCode).toBe(1);
  });

  it('says so when nothing is archived yet', async () => {
    const result = await run(memoryFs(), ['log']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no archived sessions');
  });
});

describe('memory curate', () => {
  const index = [entry('old.md', '2026-09-01T00:00:00Z'), entry('new.md', '2026-09-02T00:00:00Z')];

  it('fails before boot publishes the seam', async () => {
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['curate']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not booted');
  });

  it('curates the newest archive by default and prints the report', async () => {
    const seam = fakeSeam({ ok: true, report: 'curated two facts' });
    (globalThis as Globals).__slicc_memory = seam;
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['curate']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Curated new.md');
    expect(result.stdout).toContain('curated two facts');
    expect(seam.curate).toHaveBeenCalledWith({
      sessionArchivePath: '/sessions/new.md',
      sessionCount: 2,
    });
  });

  it('selects an archive with --archive and forwards --cone', async () => {
    const seam = fakeSeam({ ok: true, report: '' });
    (globalThis as Globals).__slicc_memory = seam;
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['curate', '--archive', 'old.md', '--cone', 'cone-side']);
    expect(result.exitCode).toBe(0);
    expect(seam.curate).toHaveBeenCalledWith({
      sessionArchivePath: '/sessions/old.md',
      sessionCount: 2,
      cone: { folder: 'cone-side' },
    });
  });

  it('rejects an archive the index does not know', async () => {
    (globalThis as Globals).__slicc_memory = fakeSeam({ ok: true, report: '' });
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['curate', '--archive', 'nope.md']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nope.md');
  });

  it('surfaces a failed pass on stderr with exit 1', async () => {
    (globalThis as Globals).__slicc_memory = fakeSeam({ ok: false, reason: 'timeout' });
    const fs = memoryFs({ [INDEX_PATH]: JSON.stringify(index) });
    const result = await run(fs, ['curate']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('timeout');
  });

  it('fails when nothing has been archived yet', async () => {
    (globalThis as Globals).__slicc_memory = fakeSeam({ ok: true, report: '' });
    const result = await run(memoryFs(), ['curate']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('freeze a chat first');
  });
});
