/**
 * `CompactionRowTracker` — the phase→row reducer both the panel and the
 * kernel drive (#2843).
 *
 * The round lifecycles (settle, retract, late retraction, round-id scoping)
 * are pinned end-to-end through the panel in
 * `tests/ui/offscreen-client.test.ts`; this file covers what only the shared
 * reducer can answer: that two units keep their own rows, and that a unit can
 * be forgotten.
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
