import { describe, expect, it } from 'vitest';
import { StandaloneHandoffWatcher } from '../../src/ui/standalone-handoff-watcher.js';

const payload = { instruction: 'Do something.' };

describe('StandaloneHandoffWatcher', () => {
  it('injectHandoff adds a pending handoff and notifies the callback', () => {
    const snapshots: string[][] = [];
    const watcher = new StandaloneHandoffWatcher({
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.map((h) => h.payload.instruction));
      },
    });

    watcher.injectHandoff(payload);

    expect(snapshots).toEqual([['Do something.']]);
  });

  it('clearHandoff removes the handoff and notifies the callback', () => {
    const snapshots: string[][] = [];
    const watcher = new StandaloneHandoffWatcher({
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.map((h) => h.payload.instruction));
      },
    });

    const id = watcher.injectHandoff(payload);
    const result = watcher.clearHandoff(id);

    expect(result.handoff?.payload.instruction).toBe('Do something.');
    expect(result.targetIds).toEqual([]);
    expect(snapshots).toEqual([['Do something.'], []]);
  });

  it('clearHandoff on unknown id returns null without notifying', () => {
    const snapshots: string[][] = [];
    const watcher = new StandaloneHandoffWatcher({
      onPendingHandoffsChange: (handoffs) => {
        snapshots.push(handoffs.map((h) => h.payload.instruction));
      },
    });

    const result = watcher.clearHandoff('nonexistent');

    expect(result).toEqual({ handoff: null, targetIds: [] });
    expect(snapshots).toEqual([]);
  });

  it('multiple injected handoffs are sorted by receivedAt', () => {
    const instructions: string[] = [];
    const watcher = new StandaloneHandoffWatcher({
      onPendingHandoffsChange: (handoffs) => {
        instructions.splice(0, instructions.length, ...handoffs.map((h) => h.payload.instruction));
      },
    });

    watcher.injectHandoff({ instruction: 'First.' });
    watcher.injectHandoff({ instruction: 'Second.' });

    expect(instructions).toEqual(['First.', 'Second.']);
  });
});
