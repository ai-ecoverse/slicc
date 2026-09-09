/**
 * `CompactionRowTracker` — the phase→row reducer both the panel and the
 * kernel drive (#2843).
 *
 * The round lifecycles (settle, retract, late retraction, round-id scoping)
 * are pinned end-to-end through the panel in
 * `tests/ui/offscreen-client.test.ts`; this file covers what only the shared
 * reducer can answer: that two units keep their own rows, that a unit can be
 * forgotten, and how a row id handed in from outside (the kernel's, off the
 * wire) beats minting a second one for the same round.
 */

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

    // Settling one leaves the other's round open.
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
    // No open row: a terminal phase for a round this tracker no longer knows
    // must not conjure one.
    expect(rows.apply('cone_1', 'idle', IDLE)).toBeNull();
  });

  describe('an id supplied from elsewhere', () => {
    it('opens the round under it instead of minting a second id', () => {
      const rows = tracker();
      const action = rows.apply('cone_1', 'summarizing', IDLE, 'kernel-row-7');
      expect(action).toMatchObject({ kind: 'open', messageId: 'kernel-row-7' });
      // And the round it settles is that same row.
      expect(rows.apply('cone_1', 'idle', IDLE, 'kernel-row-7')).toMatchObject({
        kind: 'settle',
        messageId: 'kernel-row-7',
      });
    });

    // The panel mounted mid-round: it never saw the opening phase, so without
    // an id from the kernel it would ignore the terminal one and never show
    // the seam until the next replay.
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
      // Its own row is the one on screen; a late-arriving other id must not
      // strand it half-rendered.
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
