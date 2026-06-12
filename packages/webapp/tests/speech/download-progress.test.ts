import { describe, expect, it } from 'vitest';
import { createDownloadTracker } from '../../src/speech/download-progress.js';

describe('createDownloadTracker', () => {
  it('aggregates loaded/total across files', () => {
    const tracker = createDownloadTracker(() => 0);
    tracker.update('encoder.onnx', 10, 100);
    tracker.update('decoder.onnx', 5, 200);
    expect(tracker.snapshot()).toMatchObject({ loaded: 15, total: 300 });
  });

  it('keeps the largest total seen per file (events can omit/lag totals)', () => {
    const tracker = createDownloadTracker(() => 0);
    tracker.update('a', 10, 100);
    tracker.update('a', 20, 0); // total missing on this event
    expect(tracker.snapshot()).toMatchObject({ loaded: 20, total: 100 });
  });

  it('complete() snaps a file to its total', () => {
    const tracker = createDownloadTracker(() => 0);
    tracker.update('a', 10, 100);
    tracker.complete('a');
    expect(tracker.snapshot()).toMatchObject({ loaded: 100, total: 100, etaSeconds: 0 });
  });

  it('reports no ETA before a measurable rate window has elapsed', () => {
    let now = 0;
    const tracker = createDownloadTracker(() => now);
    tracker.update('a', 0, 1000);
    now = 500; // under the 1s window
    tracker.update('a', 100, 1000);
    expect(tracker.snapshot().etaSeconds).toBeNull();
  });

  it('estimates the ETA from the average rate since the first sample', () => {
    let now = 0;
    const tracker = createDownloadTracker(() => now);
    tracker.update('a', 0, 30_000_000);
    now = 2000;
    tracker.update('a', 10_000_000, 30_000_000);
    // 10 MB in 2s → 5 MB/s; 20 MB remain → 4s.
    expect(tracker.snapshot().etaSeconds).toBeCloseTo(4, 5);
  });

  it('reports zero ETA once everything is loaded', () => {
    let now = 0;
    const tracker = createDownloadTracker(() => now);
    tracker.update('a', 0, 100);
    now = 5000;
    tracker.update('a', 100, 100);
    expect(tracker.snapshot().etaSeconds).toBe(0);
  });

  it('reports no ETA while nothing has gained (stalled start)', () => {
    let now = 0;
    const tracker = createDownloadTracker(() => now);
    tracker.update('a', 50, 100);
    now = 5000;
    tracker.update('a', 50, 100); // no progress since first sample
    expect(tracker.snapshot().etaSeconds).toBeNull();
  });
});
