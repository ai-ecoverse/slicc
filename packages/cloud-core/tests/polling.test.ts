import { describe, expect, it } from 'vitest';
import { pollCloudStatus, pollForRefreshedStatus } from '../src/polling.js';
import type { SandboxHandle } from '../src/substrate.js';
import { makeFakeHandle } from './fixtures/fake-substrate.js';

/**
 * Build a handle whose /tmp/slicc-join.json read returns each entry of
 * `reads` in turn (last entry sticks). A `string` is returned verbatim;
 * an `Error` is thrown for that read.
 */
function makeReadSequenceHandle(reads: Array<string | Error>): {
  handle: SandboxHandle;
  readCount: () => number;
} {
  let i = 0;
  const base = makeFakeHandle();
  const handle: SandboxHandle = {
    ...base,
    readFile: async (path: string): Promise<string> => {
      if (path !== '/tmp/slicc-join.json') throw new Error(`ENOENT ${path}`);
      const entry = reads[Math.min(i, reads.length - 1)];
      i += 1;
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
  return { handle, readCount: () => i };
}

/**
 * Deadline for tests that expect the poll to *succeed*. It is never actually
 * reached (the fixture serves an acceptable read on the first or second pass),
 * so a generous value costs nothing while keeping the outcome independent of
 * how long a contended CI worker stalls the event loop between reads.
 */
const SUCCESS_OPTS = { timeoutMs: 2_000, intervalMs: 1 };

/** Deadline for tests that expect the poll to time out; always reached. */
const TIMEOUT_OPTS = { timeoutMs: 40, intervalMs: 1 };

describe('pollCloudStatus', () => {
  it('returns any well-formed read when no minUpdatedAt floor is set', async () => {
    const payload = {
      joinUrl: 'https://w/join/x',
      trayId: 't1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { handle } = makeReadSequenceHandle([JSON.stringify(payload)]);
    await expect(pollCloudStatus(handle, SUCCESS_OPTS)).resolves.toMatchObject(payload);
  });

  it('rejects a read whose updatedAt is not strictly newer than minUpdatedAt, then accepts a fresh one', async () => {
    const stale = {
      joinUrl: 'https://w/join/stale',
      trayId: 't-stale',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fresh = {
      joinUrl: 'https://w/join/fresh',
      trayId: 't-fresh',
      updatedAt: '2026-01-01T00:00:02.000Z',
    };
    const { handle, readCount } = makeReadSequenceHandle([
      JSON.stringify(stale),
      JSON.stringify(fresh),
    ]);
    await expect(
      pollCloudStatus(handle, { ...SUCCESS_OPTS, minUpdatedAt: '2026-01-01T00:00:01.000Z' })
    ).resolves.toMatchObject(fresh);
    expect(readCount()).toBeGreaterThan(1); // proves the stale read was rejected
  });

  it('throws SANDBOX_NOT_READY with a stale suffix labelled minUpdatedAt on timeout', async () => {
    const stale = {
      joinUrl: 'https://w/join/stale',
      trayId: 't-stale',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { handle } = makeReadSequenceHandle([JSON.stringify(stale)]);
    await expect(
      pollCloudStatus(handle, { ...TIMEOUT_OPTS, minUpdatedAt: '2026-01-01T00:00:01.000Z' })
    ).rejects.toMatchObject({
      name: 'CloudError',
      code: 'SANDBOX_NOT_READY',
      message: expect.stringContaining('minUpdatedAt=2026-01-01T00:00:01.000Z'),
    });
  });

  it('throws SANDBOX_NOT_READY with "file never appeared" when reads keep failing', async () => {
    const { handle } = makeReadSequenceHandle([new Error('ENOENT /tmp/slicc-join.json')]);
    await expect(pollCloudStatus(handle, TIMEOUT_OPTS)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_READY',
      message: expect.stringContaining('last error: ENOENT /tmp/slicc-join.json'),
    });
  });
});

describe('pollForRefreshedStatus', () => {
  it('returns any well-formed read when baselineUpdatedAt is undefined', async () => {
    const payload = {
      joinUrl: 'https://w/join/x',
      trayId: 't1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { handle } = makeReadSequenceHandle([JSON.stringify(payload)]);
    await expect(pollForRefreshedStatus(handle, undefined, SUCCESS_OPTS)).resolves.toMatchObject(
      payload
    );
  });

  it('requires a strictly newer updatedAt than the baseline', async () => {
    const stale = {
      joinUrl: 'https://w/join/stale',
      trayId: 't-stale',
      updatedAt: '2026-05-01T12:00:00.000Z',
    };
    const fresh = {
      joinUrl: 'https://w/join/fresh',
      trayId: 't-fresh',
      updatedAt: '2026-05-01T12:00:05.000Z',
    };
    const { handle } = makeReadSequenceHandle([JSON.stringify(stale), JSON.stringify(fresh)]);
    await expect(
      pollForRefreshedStatus(handle, '2026-05-01T12:00:00.000Z', SUCCESS_OPTS)
    ).resolves.toMatchObject(fresh);
  });

  it('throws LEADER_NOT_READY with a stale suffix labelled baseline.updatedAt on timeout', async () => {
    const baseline = '2026-05-01T12:00:00.000Z';
    const stale = { joinUrl: 'https://w/join/stale', trayId: 't-stale', updatedAt: baseline };
    const { handle } = makeReadSequenceHandle([JSON.stringify(stale)]);
    await expect(pollForRefreshedStatus(handle, baseline, TIMEOUT_OPTS)).rejects.toMatchObject({
      name: 'CloudError',
      code: 'LEADER_NOT_READY',
      message: expect.stringContaining(`baseline.updatedAt=${baseline}`),
    });
  });

  it('throws LEADER_NOT_READY with "did not refresh" on a never-appearing file', async () => {
    const { handle } = makeReadSequenceHandle([new Error('boom')]);
    await expect(pollForRefreshedStatus(handle, undefined, TIMEOUT_OPTS)).rejects.toMatchObject({
      code: 'LEADER_NOT_READY',
      message: expect.stringContaining('did not refresh within'),
    });
  });
});
