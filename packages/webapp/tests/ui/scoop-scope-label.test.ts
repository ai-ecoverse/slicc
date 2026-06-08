/**
 * Tests for the float-agnostic scoop scope-label cache.
 *
 * Covers cache hit (unchanged signature is skipped), in-flight
 * dedupe (concurrent same-jid calls coalesce), `invalidate` (forces
 * regeneration even when transcript is unchanged), `null` from
 * `quickLabel` (no-op, no `onResolved`), empty transcript (no-op,
 * no `quickLabel` call), and the never-throws contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const quickLabelMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../src/ui/quick-llm.js', () => ({
  quickLabel: quickLabelMock,
}));

const { ScoopScopeLabeler } = await import('../../src/ui/scoop-scope-label.js');

/** Promise + manual resolver. Lets us coordinate the
 *  fetchTranscript / quickLabel timing with test assertions. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drain any pending microtasks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(() => {
  quickLabelMock.mockReset();
});

describe('ScoopScopeLabeler', () => {
  it('caches the resolved label and skips regeneration for an unchanged transcript', async () => {
    quickLabelMock.mockResolvedValue('refactoring auth flow');
    const fetchTranscript = vi.fn(async () => 'user: refactor auth\nassistant: starting');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-a', onResolved);
    await flush();
    await flush();

    expect(quickLabelMock).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith('jid-a', 'refactoring auth flow');
    expect(labeler.getCached('jid-a')).toBe('refactoring auth flow');

    labeler.request('jid-a', onResolved);
    await flush();
    await flush();

    expect(quickLabelMock).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(labeler.getCached('jid-a')).toBe('refactoring auth flow');
  });

  it('dedupes concurrent in-flight calls for the same jid + signature', async () => {
    const labelDeferred = deferred<string | null>();
    quickLabelMock.mockReturnValue(labelDeferred.promise);
    const fetchTranscript = vi.fn(async () => 'doing the work');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-b', onResolved);
    labeler.request('jid-b', onResolved);
    labeler.request('jid-b', onResolved);
    await flush();

    expect(quickLabelMock).toHaveBeenCalledTimes(1);

    labelDeferred.resolve('writing tests');
    await flush();
    await flush();

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith('jid-b', 'writing tests');
    expect(labeler.getCached('jid-b')).toBe('writing tests');
  });

  it('invalidate() forces the next request to regenerate even with an unchanged transcript', async () => {
    quickLabelMock.mockResolvedValueOnce('first label');
    quickLabelMock.mockResolvedValueOnce('second label');
    const fetchTranscript = vi.fn(async () => 'stable transcript');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-c', onResolved);
    await flush();
    await flush();
    expect(labeler.getCached('jid-c')).toBe('first label');

    labeler.request('jid-c', onResolved);
    await flush();
    await flush();
    expect(quickLabelMock).toHaveBeenCalledTimes(1);

    labeler.invalidate('jid-c');
    expect(labeler.getCached('jid-c')).toBe('first label');

    labeler.request('jid-c', onResolved);
    await flush();
    await flush();

    expect(quickLabelMock).toHaveBeenCalledTimes(2);
    expect(labeler.getCached('jid-c')).toBe('second label');
    expect(onResolved).toHaveBeenLastCalledWith('jid-c', 'second label');
  });

  it('no-ops when quickLabel returns null (no onResolved, no cache write)', async () => {
    quickLabelMock.mockResolvedValue(null);
    const fetchTranscript = vi.fn(async () => 'something to label');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-d', onResolved);
    await flush();
    await flush();

    expect(quickLabelMock).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
    expect(labeler.getCached('jid-d')).toBeNull();
  });

  it('no-ops on empty transcript (does not call quickLabel)', async () => {
    const fetchTranscript = vi.fn(async () => '   \n   ');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-e', onResolved);
    await flush();
    await flush();

    expect(quickLabelMock).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(labeler.getCached('jid-e')).toBeNull();
  });

  it('never throws when fetchTranscript or quickLabel reject', async () => {
    const fetchTranscript = vi.fn(async () => {
      throw new Error('boom');
    });
    const labeler = new ScoopScopeLabeler(fetchTranscript);
    expect(() => labeler.request('jid-f', () => {})).not.toThrow();
    await flush();
    await flush();

    expect(quickLabelMock).not.toHaveBeenCalled();
    expect(labeler.getCached('jid-f')).toBeNull();

    const ok = vi.fn(async () => 'fresh transcript');
    quickLabelMock.mockRejectedValueOnce(new Error('llm down'));
    const labeler2 = new ScoopScopeLabeler(ok);
    const onResolved = vi.fn();
    expect(() => labeler2.request('jid-g', onResolved)).not.toThrow();
    await flush();
    await flush();

    expect(onResolved).not.toHaveBeenCalled();
    expect(labeler2.getCached('jid-g')).toBeNull();
  });

  it('rejects "idle" sentinel and normalizes wrapping quotes / trailing period', async () => {
    quickLabelMock.mockResolvedValueOnce('idle');
    const fetchTranscript = vi.fn(async () => 'transcript v1');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-h', onResolved);
    await flush();
    await flush();
    expect(onResolved).not.toHaveBeenCalled();
    expect(labeler.getCached('jid-h')).toBeNull();

    quickLabelMock.mockResolvedValueOnce('"writing the docs."');
    fetchTranscript.mockResolvedValueOnce('transcript v2');
    labeler.request('jid-h', onResolved);
    await flush();
    await flush();
    expect(onResolved).toHaveBeenCalledWith('jid-h', 'writing the docs');
    expect(labeler.getCached('jid-h')).toBe('writing the docs');
  });

  it('regenerates when the transcript signature changes', async () => {
    quickLabelMock.mockResolvedValueOnce('label one');
    quickLabelMock.mockResolvedValueOnce('label two');
    const fetchTranscript = vi.fn();
    fetchTranscript.mockResolvedValueOnce('transcript A');
    fetchTranscript.mockResolvedValueOnce('transcript B');
    const onResolved = vi.fn();

    const labeler = new ScoopScopeLabeler(fetchTranscript);
    labeler.request('jid-i', onResolved);
    await flush();
    await flush();
    expect(labeler.getCached('jid-i')).toBe('label one');

    labeler.request('jid-i', onResolved);
    await flush();
    await flush();
    expect(quickLabelMock).toHaveBeenCalledTimes(2);
    expect(labeler.getCached('jid-i')).toBe('label two');
    expect(onResolved).toHaveBeenLastCalledWith('jid-i', 'label two');
  });
});
