import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkUnitClientEvent } from '../../../src/work-unit/client/types.js';
import { ROSTER } from './conformance.js';
import { makeLocalHarness } from './fakes.js';

describe('LocalWorkUnitClient replay recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-asks once when the request is dropped, and paints the subscriber', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    const seen: WorkUnitClientEvent[] = [];

    const pending = harness.client.snapshot('cone_1');
    harness.client.subscribe('cone_1', (event) => seen.push(event));

    expect(harness.transcriptRequests).toEqual(['cone_1']);

    await vi.advanceTimersByTimeAsync(5000);

    await pending;
    expect(seen).toEqual([]);

    expect(harness.transcriptRequests).toEqual(['cone_1', 'cone_1']);

    harness.emitSnapshot('cone_1', [
      { content: 'recovered', id: 'm1', role: 'user', timestamp: 1 },
    ]);
    const snapshots = seen.filter((event) => event.type === 'snapshot');
    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('shows the unit’s OWN last transcript when the retry is dropped too', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');

    const first = harness.client.snapshot('cone_1');
    harness.emitSnapshot(
      'cone_1',
      [{ content: 'known', id: 'm1', role: 'user', timestamp: 1 }],
      ['q1']
    );
    await first;

    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    const pending = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);

    const snapshots = seen.filter((event) => event.type === 'snapshot');

    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);

    expect(snapshots.at(-1)?.snapshot.queuedIds).toBeUndefined();
  });

  it('recovers with an empty transcript when the unit was never seen', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_2', (event) => seen.push(event));
    const pending = harness.client.snapshot('cone_2');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);

    const snapshots = seen.filter((event) => event.type === 'snapshot');
    expect(snapshots.at(-1)?.snapshot.messages).toEqual([]);
    expect(snapshots.at(-1)?.snapshot.summary?.id).toBe('cone_2');
  });

  it('does not cache its own recovery answer as though the kernel had sent it', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    const off = harness.client.subscribe('cone_1', () => undefined);
    const pending = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);
    off();

    const asksBefore = harness.transcriptRequests.length;
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    expect(seen).toEqual([]);
    expect(harness.transcriptRequests.slice(asksBefore)).toEqual(['cone_1']);
  });

  it('does not retry when nobody is subscribed to the unit', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');

    const pending = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(harness.transcriptRequests).toEqual(['cone_1']);
  });

  it('bounds the recovery to one extra ask per unanswered stretch', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    harness.client.subscribe('cone_1', () => undefined);

    expect(harness.transcriptRequests).toEqual(['cone_1']);

    const first = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    const second = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await second;

    expect(harness.transcriptRequests).toEqual(['cone_1', 'cone_1', 'cone_1', 'cone_1']);
  });

  it('earns a fresh retry once the transport starts answering again', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    harness.client.subscribe('cone_1', () => undefined);

    const first = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    expect(harness.transcriptRequests).toHaveLength(3);

    harness.emitSnapshot('cone_1', []);
    const second = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await second;

    expect(harness.transcriptRequests).toHaveLength(5);
  });

  it('does not re-ask 5 s after a replay that already landed (#2859)', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    const seen: WorkUnitClientEvent[] = [];

    const pending = harness.client.snapshot('cone_1');

    harness.client.subscribe('cone_1', (event) => seen.push(event));
    expect(harness.transcriptRequests).toEqual(['cone_1']);

    harness.emitSnapshot('cone_1', [{ content: 'prompt', id: 'm1', role: 'user', timestamp: 1 }]);
    await pending;
    expect(seen.filter((event) => event.type === 'snapshot')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.transcriptRequests).toEqual(['cone_1']);
  });

  it('treats an empty replay as an answer, not as silence (#2859)', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    const pending = harness.client.snapshot('cone_1');
    harness.client.subscribe('cone_1', () => undefined);
    expect(harness.transcriptRequests).toEqual(['cone_1']);

    harness.emitSnapshot('cone_1', []);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.transcriptRequests).toEqual(['cone_1']);
  });
});
