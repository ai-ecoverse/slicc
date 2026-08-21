import { describe, expect, it, vi } from 'vitest';
import {
  popToolExecutionContext,
  pushToolExecutionContext,
} from '../../../src/base/tool-execution-context.js';
import {
  MAX_UPDATES_PER_SECOND,
  ProgressEmitter,
  type ProgressEvent,
  progressLabel,
} from '../../../src/shell/progress/index.js';

function ev(partial: Partial<ProgressEvent> & Pick<ProgressEvent, 'phase'>): ProgressEvent {
  return { id: 'u1', label: 'sleep 10', ...partial };
}

describe('ProgressEmitter', () => {
  it('allocates unique, prefixed ids', () => {
    const emitter = new ProgressEmitter({ sink: () => {} });
    const a = emitter.allocateId('sleep');
    const b = emitter.allocateId('sleep');
    const c = emitter.allocateId();
    expect(a).not.toBe(b);
    expect(a.startsWith('sleep-')).toBe(true);
    expect(c.startsWith('p-')).toBe(true);
  });

  it('throttles updates to at most 4 per second per id, never start/end', () => {
    let t = 0;
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
    expect(emitter.emit(ev({ phase: 'start' }))).toBe(true);
    // 20 updates over one second at 50 ms spacing.
    let forwarded = 0;
    for (let i = 0; i < 20; i++) {
      t += 50;
      if (emitter.emit(ev({ phase: 'update', fraction: i / 20 }))) forwarded += 1;
    }
    expect(forwarded).toBe(MAX_UPDATES_PER_SECOND);
    expect(emitter.emit(ev({ phase: 'end', fraction: 1 }))).toBe(true);
    expect(seen.map((e) => e.phase)).toEqual([
      'start',
      'update',
      'update',
      'update',
      'update',
      'end',
    ]);
  });

  it('throttles per id independently', () => {
    let t = 0;
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
    emitter.emit(ev({ id: 'a', phase: 'start' }));
    emitter.emit(ev({ id: 'b', phase: 'start' }));
    t += 10;
    expect(emitter.emit(ev({ id: 'a', phase: 'update' }))).toBe(true);
    expect(emitter.emit(ev({ id: 'b', phase: 'update' }))).toBe(true);
    t += 10;
    expect(emitter.emit(ev({ id: 'a', phase: 'update' }))).toBe(false);
    expect(emitter.emit(ev({ id: 'b', phase: 'update' }))).toBe(false);
  });

  it('ignores update/end for ids that never started', () => {
    const sink = vi.fn();
    const emitter = new ProgressEmitter({ sink });
    expect(emitter.emit(ev({ id: 'ghost', phase: 'update' }))).toBe(false);
    expect(emitter.emit(ev({ id: 'ghost', phase: 'end' }))).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it('forgets an id after end so a late update is dropped', () => {
    let t = 0;
    const sink = vi.fn();
    const emitter = new ProgressEmitter({ sink, now: () => t });
    emitter.emit(ev({ phase: 'start' }));
    emitter.emit(ev({ phase: 'end' }));
    t += 1000;
    expect(emitter.emit(ev({ phase: 'update' }))).toBe(false);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without a tool execution context', () => {
    const emitter = new ProgressEmitter();
    expect(emitter.hasSink()).toBe(false);
    expect(emitter.emit(ev({ phase: 'start' }))).toBe(false);
    expect(emitter.emit(ev({ phase: 'end' }))).toBe(false);
  });

  it('resolves the sink lazily from the tool execution context', () => {
    const emitter = new ProgressEmitter();
    const onUpdate = vi.fn();
    const ctx = pushToolExecutionContext({ onUpdate, toolName: 'bash', toolCallId: 'tc1' });
    try {
      expect(emitter.hasSink()).toBe(true);
      emitter.emit(ev({ phase: 'start', fraction: 0 }));
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate.mock.calls[0][0]).toEqual({
        content: [{ type: 'progress', progress: ev({ phase: 'start', fraction: 0 }) }],
      });
    } finally {
      popToolExecutionContext(ctx);
    }
    // Context gone: the end event is swallowed (no listener to close the bar).
    expect(emitter.emit(ev({ phase: 'end' }))).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('scrubs labels once per id and preserves ordering while scrubbing', async () => {
    const seen: ProgressEvent[] = [];
    const scrub = vi.fn(async (text: string) => text.replace('sk-secret', '***'));
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), scrubLabel: scrub });
    const label = 'curl -H Authorization:sk-secret https://x';
    emitter.emit(ev({ label, phase: 'start' }));
    emitter.emit(ev({ label, phase: 'end' }));
    expect(seen).toEqual([]); // nothing leaves before the scrub resolves
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
    for (const e of seen) expect(e.label).toBe('curl -H Authorization:*** https://x');
    expect(scrub).toHaveBeenCalledTimes(1);
  });

  it('re-scrubs when the label changes mid-unit and passes changed labels through unscrubbed', async () => {
    const seen: ProgressEvent[] = [];
    const scrub = vi.fn(async (text: string) => text.replace('sk-secret', '***'));
    const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), scrubLabel: scrub });
    emitter.emit(ev({ label: 'for f (0/2)', phase: 'start' }));
    emitter.emit(ev({ label: 'for f (1/2) sk-secret', phase: 'end' }));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((e) => e.label)).toEqual(['for f (0/2)', 'for f (1/2) ***']);
    expect(scrub).toHaveBeenCalledTimes(2);

    const plain: ProgressEvent[] = [];
    const noScrub = new ProgressEmitter({ sink: (e) => plain.push(e) });
    noScrub.emit(ev({ label: 'a', phase: 'start' }));
    noScrub.emit(ev({ label: 'b', phase: 'end' }));
    expect(plain.map((e) => e.label)).toEqual(['a', 'b']);
  });

  it('withholds the label when the scrubber throws', async () => {
    const seen: ProgressEvent[] = [];
    const emitter = new ProgressEmitter({
      sink: (e) => seen.push(e),
      scrubLabel: async () => {
        throw new Error('bridge down');
      },
    });
    emitter.emit(ev({ label: 'curl secret', phase: 'start' }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].label).not.toContain('curl secret');
    expect(seen[0].label).toMatch(/withheld/);
  });
});

describe('progressLabel', () => {
  it('joins argv and caps the length', () => {
    expect(progressLabel('sleep', ['30'])).toBe('sleep 30');
    expect(progressLabel('ls', [])).toBe('ls');
    const long = progressLabel('curl', ['x'.repeat(200)]);
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });
});
