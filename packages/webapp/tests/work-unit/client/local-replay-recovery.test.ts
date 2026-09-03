/**
 * `LocalWorkUnitClient` recovery when the kernel never answers a replay
 * request (#2382 PR B).
 *
 * `subscribe` deliberately does NOT re-ask while a `snapshot(id)` is in flight
 * — two asks would replay the same transcript twice and each `loadMessages`
 * consumes the one-shot held-queue restore (#2354). That dedup makes the
 * single request load-bearing: if it is dropped, nothing else would ever ask,
 * the previous unit's transcript would stay on screen, and a held queue would
 * never be restored. So the unanswered request earns exactly one retry.
 */

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
    // The kernel never answers this one.
    expect(harness.transcriptRequests).toEqual(['cone_1']);

    await vi.advanceTimersByTimeAsync(5000);
    // The caller's promise settles from the fallback with an empty transcript,
    // which is why the MOUNT paints from the subscription and not from here.
    await pending;
    expect(seen).toEqual([]);
    // …and the dropped ask has been re-issued, once.
    expect(harness.transcriptRequests).toEqual(['cone_1', 'cone_1']);

    // The retry lands: the subscriber finally gets the transcript, so the
    // thread is not left showing the unit the user navigated away from.
    harness.emitSnapshot('cone_1', [
      { content: 'recovered', id: 'm1', role: 'user', timestamp: 1 },
    ]);
    const snapshots = seen.filter((event) => event.type === 'snapshot');
    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('shows the unit’s OWN last transcript when the retry is dropped too', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    // `cone_1` has been seen before, so there is something honest to fall back
    // to. Its held queue must survive the fallback.
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
    await vi.advanceTimersByTimeAsync(5000); // first timeout → retry
    await pending;
    await vi.advanceTimersByTimeAsync(5000); // retry timeout → recover

    const snapshots = seen.filter((event) => event.type === 'snapshot');
    // Never another unit's messages under this unit's chrome: what the shell
    // gets is this unit's own last-known transcript…
    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
    // …and NO queue answer, so the one-shot held-queue restore is not spent
    // reconciling against a queue the transport never reported (#2354).
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

    // A later subscriber must not be seeded from a transcript the CLIENT
    // invented; with nothing cached it asks the transport instead.
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

    // A one-off `snapshot()` with no subscriber has nobody left to paint, so a
    // second ask would buy nothing.
    expect(harness.transcriptRequests).toEqual(['cone_1']);
  });

  it('bounds the recovery to one extra ask per unanswered stretch', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    harness.client.subscribe('cone_1', () => undefined);
    // The subscribe itself asks (no snapshot in flight yet).
    expect(harness.transcriptRequests).toEqual(['cone_1']);

    const first = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    const second = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await second;

    // subscribe + two snapshots + ONE retry. A kernel that ignored the first
    // two is not going to answer a third, and a retry per selection would
    // outlive the selection that started it.
    expect(harness.transcriptRequests).toEqual(['cone_1', 'cone_1', 'cone_1', 'cone_1']);
  });

  it('earns a fresh retry once the transport starts answering again', async () => {
    const harness = makeLocalHarness();
    harness.setRoster(ROSTER, 'cone_1');
    harness.client.subscribe('cone_1', () => undefined);

    const first = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    // subscribe + snapshot + retry
    expect(harness.transcriptRequests).toHaveLength(3);

    harness.emitSnapshot('cone_1', []);
    const second = harness.client.snapshot('cone_1');
    await vi.advanceTimersByTimeAsync(5000);
    await second;

    // A replay landed in between, so the next unanswered stretch is a NEW one
    // and gets its own single retry rather than inheriting the spent budget.
    expect(harness.transcriptRequests).toHaveLength(5);
  });
});
