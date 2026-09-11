/**
 * P7 — enforced, verified memory maintenance. Pins the three report criteria:
 * the check runs on a runtime schedule (no model in the loop), persists
 * numbers a human can sanity-check, and fails loudly when its own tooling
 * breaks — an unreadable ledger or a thrown checker is a FAILURE, never a
 * clean bill of health.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_HEALTH_REPORT_PATH,
  type MemoryHealthFs,
  type MemoryHealthReport,
  runMemoryHealthCheck,
  runScheduledMemoryHealthCheck,
  scheduleMemoryHealthChecks,
} from '../../src/scoops/memory-health.js';

function fakeFs(files: Record<string, string>): MemoryHealthFs & { files: Map<string, string> } {
  const store = new Map(Object.entries(files));
  return {
    files: store,
    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return content;
    },
    async writeFile(path: string, content: string): Promise<void> {
      store.set(path, content);
    },
    async mkdir(): Promise<void> {},
  };
}

const NOW = (): Date => new Date('2026-09-11T12:00:00Z');

function index(entries: object[]): string {
  return JSON.stringify(entries);
}

describe('runMemoryHealthCheck', () => {
  it('reports real numbers and no failures on a healthy system', async () => {
    const memory = '# memory\n- human: prefers rebase (2026-09-10)\n';
    const fs = fakeFs({
      '/sessions/index.json': index([
        { filename: 'a.md', memoryCuratedAt: '2026-09-10T00:00:00Z' },
        { filename: 'b.md', memoryPending: true },
        { filename: 'c.md', memorySkipped: true },
      ]),
      '/workspace/CLAUDE.md': memory,
    });
    const report = await runMemoryHealthCheck(fs, NOW);
    expect(report).toEqual({
      at: '2026-09-11T12:00:00.000Z',
      sessions: 3,
      curation: { curated: 1, failed: 0, pending: 1, skipped: 1, none: 0 },
      primaryMemoryChars: memory.length,
      cones: [{ folder: 'cone', curated: 1, chars: memory.length }],
      failures: [],
    });
  });

  // The lying-memory check is per cone: an archive's `cone` names the file its
  // curation grew. Checking only the primary flagged a healthy extra-cone
  // setup with no primary memory, and missed an extra cone whose file vanished.
  it('checks each cone against its own memory file, not everything against the primary', async () => {
    const withReadDir = (files: Record<string, string>, cones: string[]) => ({
      ...fakeFs(files),
      readDir: async () => cones.map((name) => ({ name, type: 'directory' })),
    });
    const entries = index([
      { filename: 'r1.md', cone: 'cone-research', memoryCuratedAt: '2026-09-10T00:00:00Z' },
      { filename: 'r2.md', cone: 'cone-research', memoryCuratedAt: '2026-09-10T01:00:00Z' },
    ]);
    // All the work is on the research cone and its memory is growing; the
    // primary never curated anything — healthy, not a lie.
    const healthy = await runMemoryHealthCheck(
      withReadDir(
        { '/sessions/index.json': entries, '/cones/cone-research/CLAUDE.md': '- fact\n' },
        ['cone-research']
      ),
      NOW
    );
    expect(healthy.failures).toEqual([]);
    expect(healthy.cones).toEqual([
      { folder: 'cone', curated: 0, chars: null },
      { folder: 'cone-research', curated: 2, chars: 7 },
    ]);

    // The research cone's file is gone while its archives claim curation.
    const lying = await runMemoryHealthCheck(
      withReadDir({ '/sessions/index.json': entries, '/workspace/CLAUDE.md': 'ok' }, [
        'cone-research',
      ]),
      NOW
    );
    expect(lying.failures).toEqual([
      '2 archive(s) from cone "cone-research" report successful curation but its memory file is missing or empty',
    ]);

    // A dropped cone took its memory file with it — not a lie.
    const dropped = await runMemoryHealthCheck(
      withReadDir({ '/sessions/index.json': entries, '/workspace/CLAUDE.md': 'ok' }, []),
      NOW
    );
    expect(dropped.failures).toEqual([]);
    expect(dropped.cones.map((c) => c.folder)).toEqual(['cone']);
  });

  it('treats a missing index as a fresh system, not a failure', async () => {
    const report = await runMemoryHealthCheck(fakeFs({}), NOW);
    expect(report.sessions).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('flags failed curation attempts', async () => {
    const fs = fakeFs({
      '/sessions/index.json': index([
        { filename: 'a.md', memoryFailed: 'provider timeout' },
        { filename: 'b.md', memoryCuratedAt: '2026-09-10T00:00:00Z' },
      ]),
      '/workspace/CLAUDE.md': 'memories',
    });
    const report = await runMemoryHealthCheck(fs, NOW);
    expect(report.failures).toEqual(['1 archive(s) whose last curation attempt failed']);
  });

  it('flags the lying shape: curated archives but a missing or empty memory file', async () => {
    const missing = await runMemoryHealthCheck(
      fakeFs({
        '/sessions/index.json': index([
          { filename: 'a.md', memoryCuratedAt: '2026-09-10T00:00:00Z' },
        ]),
      }),
      NOW
    );
    expect(missing.primaryMemoryChars).toBeNull();
    expect(missing.failures).toEqual([
      '1 archive(s) report successful curation but the primary memory file is missing or empty',
    ]);

    const empty = await runMemoryHealthCheck(
      fakeFs({
        '/sessions/index.json': index([
          { filename: 'a.md', memoryCuratedAt: '2026-09-10T00:00:00Z' },
        ]),
        '/workspace/CLAUDE.md': '',
      }),
      NOW
    );
    expect(empty.primaryMemoryChars).toBe(0);
    expect(empty.failures).toHaveLength(1);
  });

  // The /mnt/kb story: the one automated check lied for the life of the KB
  // because its own tooling was broken. A ledger that cannot be read must be
  // a failure — "0 sessions, all fine" is exactly the lie.
  it('fails loudly when the ledger is unreadable instead of reporting a clean fresh state', async () => {
    const invalidJson = await runMemoryHealthCheck(
      fakeFs({ '/sessions/index.json': 'not json {' }),
      NOW
    );
    expect(invalidJson.failures).toEqual([
      'sessions index at /sessions/index.json is not valid JSON',
    ]);

    const notArray = await runMemoryHealthCheck(
      fakeFs({ '/sessions/index.json': '{"filename":"a.md"}' }),
      NOW
    );
    expect(notArray.failures).toEqual(['sessions index is not an array']);

    const brokenFs = fakeFs({});
    brokenFs.readFile = async () => {
      throw new Error('EIO: device error');
    };
    const ioError = await runMemoryHealthCheck(brokenFs, NOW);
    expect(ioError.failures).toEqual([
      'sessions index unreadable at /sessions/index.json: EIO: device error',
    ]);
  });
});

describe('runScheduledMemoryHealthCheck', () => {
  it('persists the report where memory status reads it', async () => {
    const fs = fakeFs({
      '/sessions/index.json': index([{ filename: 'a.md', memoryFailed: 'boom' }]),
    });
    const report = await runScheduledMemoryHealthCheck(fs, NOW);
    expect(report.failures).toHaveLength(1);
    const persisted = JSON.parse(fs.files.get(MEMORY_HEALTH_REPORT_PATH) ?? '') as {
      at: string;
      failures: string[];
    };
    expect(persisted.at).toBe('2026-09-11T12:00:00.000Z');
    expect(persisted.failures).toEqual(report.failures);
  });
});

describe('scheduleMemoryHealthChecks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at the boot delay and then on the interval, logging failures loudly', async () => {
    const fs = fakeFs({
      '/sessions/index.json': index([{ filename: 'a.md', memoryFailed: 'boom' }]),
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cancel = scheduleMemoryHealthChecks(fs, { log, bootDelayMs: 1_000, intervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.error).toHaveBeenCalledWith(
      'memory health check FAILED',
      expect.objectContaining({
        failures: ['1 archive(s) whose last curation attempt failed'],
        report: MEMORY_HEALTH_REPORT_PATH,
      })
    );
    expect(fs.files.has(MEMORY_HEALTH_REPORT_PATH)).toBe(true);

    // The system heals; the next interval reports ok at info level.
    fs.files.set('/sessions/index.json', index([{ filename: 'a.md', memoryCuratedAt: 'x' }]));
    fs.files.set('/workspace/CLAUDE.md', 'memories');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.info).toHaveBeenCalledWith('memory health check ok', expect.anything());

    cancel();
    const errors = log.error.mock.calls.length;
    const infos = log.info.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(log.error.mock.calls.length).toBe(errors);
    expect(log.info.mock.calls.length).toBe(infos);
  });

  it('falls back to warn when the logger has no error level, and survives a write failure', async () => {
    const fs = fakeFs({});
    fs.writeFile = async () => {
      throw new Error('disk full');
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const cancel = scheduleMemoryHealthChecks(fs, { log, bootDelayMs: 1_000, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.warn).toHaveBeenCalledWith(
      'memory health check could not persist its report',
      expect.any(Error)
    );
    cancel();
  });

  it('report type round-trips through JSON for the status command', async () => {
    const fs = fakeFs({});
    const report = await runScheduledMemoryHealthCheck(fs, NOW);
    const parsed = JSON.parse(fs.files.get(MEMORY_HEALTH_REPORT_PATH) ?? '') as MemoryHealthReport;
    expect(parsed).toEqual(report);
  });
});
