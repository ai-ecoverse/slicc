import { describe, expect, it } from 'vitest';
import { CompactionRowTracker } from '../../src/scoops/compaction-rows.js';

const IDLE = { trigger: 'idle' } as const;

function tracker(): CompactionRowTracker {
  let n = 0;
  return new CompactionRowTracker((unitId) => `${unitId}-row-${++n}`);
}

describe('CompactionRowTracker', () => {
  it('gives each unit its own round', () => {
    const rows = tracker();
    const cone = rows.apply('cone_1', 'summarizing', IDLE);
    const scoop = rows.apply('scoop_1', 'summarizing', IDLE);
    expect(cone?.messageId).not.toBe(scoop?.messageId);

    expect(rows.apply('cone_1', 'idle', IDLE)).toMatchObject({
      kind: 'settle',
      messageId: cone?.messageId,
    });
    expect(rows.apply('scoop_1', 'idle', IDLE)).toMatchObject({
      kind: 'settle',
      messageId: scoop?.messageId,
    });
  });

  it('forgets a unit, so its open round can no longer be settled', () => {
    const rows = tracker();
    rows.apply('cone_1', 'summarizing', IDLE);
    rows.forget('cone_1');

    expect(rows.apply('cone_1', 'idle', IDLE)).toBeNull();
  });

  describe('an id supplied from elsewhere', () => {
    it('opens the round under it instead of minting a second id', () => {
      const rows = tracker();
      const action = rows.apply('cone_1', 'summarizing', IDLE, 'kernel-row-7');
      expect(action).toMatchObject({ kind: 'open', messageId: 'kernel-row-7' });

      expect(rows.apply('cone_1', 'idle', IDLE, 'kernel-row-7')).toMatchObject({
        kind: 'settle',
        messageId: 'kernel-row-7',
      });
    });

    it('settles a round it never saw open', () => {
      const rows = tracker();
      expect(rows.apply('cone_1', 'idle', IDLE, 'kernel-row-7')).toMatchObject({
        kind: 'settle',
        messageId: 'kernel-row-7',
      });
    });

    it('keeps the row it is already tracking when the two disagree', () => {
      const rows = tracker();
      const opened = rows.apply('cone_1', 'summarizing', IDLE);

      expect(rows.apply('cone_1', 'idle', IDLE, 'kernel-row-9')).toMatchObject({
        messageId: opened?.messageId,
      });
    });
  });

  it('carries the transcript path onto the row when the snapshot landed', () => {
    const rows = tracker();
    const action = rows.apply('cone_1', 'summarizing', {
      trigger: 'threshold',
      transcriptPath: '/sessions/cone/before.md',
    });
    expect(action).toMatchObject({
      kind: 'open',
      marker: {
        trigger: 'threshold',
        state: 'summarizing',
        transcriptPath: '/sessions/cone/before.md',
      },
    });
  });
});
