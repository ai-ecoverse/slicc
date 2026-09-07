import { describe, expect, it } from 'vitest';
import { toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import type {
  WorkUnitPresentationState,
  WorkUnitSummary,
} from '../../../src/work-unit/client/types.js';
import { UnreadLedger } from '../../../src/work-unit/client/unread.js';

function unit(
  id: string,
  state: WorkUnitPresentationState,
  turns?: number
): Pick<WorkUnitSummary, 'id' | 'state' | 'turns'> {
  return { id, state, ...(turns === undefined ? {} : { turns }) };
}

describe('UnreadLedger', () => {
  it('counts a turn ending on a unit the user is not watching', () => {
    const ledger = new UnreadLedger();
    ledger.sync([unit('cone', 'idle'), unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle')], 'cone').get('scoop')).toBe(1);
    ledger.sync([unit('cone', 'idle'), unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle')], 'cone').get('scoop')).toBe(2);
  });

  it('counts a turn that ends in failure', () => {
    const ledger = new UnreadLedger();
    ledger.sync([unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('scoop', 'broken')], 'cone').get('scoop')).toBe(1);
  });

  it('never counts the selected unit, and clears it on selection', () => {
    const ledger = new UnreadLedger();
    ledger.sync([unit('cone', 'idle'), unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle')], 'scoop').has('scoop')).toBe(
      false
    );
    // And a count already held is a read receipt the moment the tab is opened.
    ledger.sync([unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('scoop', 'idle')], 'cone').get('scoop')).toBe(1);
    expect(ledger.sync([unit('scoop', 'idle')], 'scoop').has('scoop')).toBe(false);
  });

  it('is idempotent for an unchanged roster — it counts transitions, not states', () => {
    const ledger = new UnreadLedger();
    ledger.sync([unit('scoop', 'working')], 'cone');
    ledger.sync([unit('scoop', 'idle')], 'cone');
    ledger.sync([unit('scoop', 'idle')], 'cone');
    expect(ledger.sync([unit('scoop', 'idle')], 'cone').get('scoop')).toBe(1);
  });

  it('does not open a first roster with everything unread', () => {
    const ledger = new UnreadLedger();
    const counts = ledger.sync([unit('cone', 'idle'), unit('old', 'broken')], 'cone');
    expect(counts.size).toBe(0);
  });

  it('forgets a unit the roster dropped instead of resurrecting its dot', () => {
    const ledger = new UnreadLedger();
    ledger.sync([unit('cone', 'idle'), unit('scoop', 'working')], 'cone');
    expect(ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle')], 'cone').get('scoop')).toBe(1);
    expect(ledger.sync([unit('cone', 'idle')], 'cone').has('scoop')).toBe(false);
    // A recycled id starts clean: no held count, and no remembered `working`.
    expect(ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle')], 'cone').has('scoop')).toBe(
      false
    );
  });

  describe('the completion counter', () => {
    it('counts a turn a coalesced roster push never showed as working', () => {
      const ledger = new UnreadLedger();
      // The follower has seen this unit idle; the leader then runs a whole turn
      // inside its 50ms coalescing window, so the only frame that lands is the
      // final `idle` — sampled state says nothing happened, `turns` says one
      // turn did.
      ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle', 3)], 'cone');
      const counts = ledger.sync([unit('cone', 'idle'), unit('scoop', 'idle', 4)], 'cone');
      expect(counts.get('scoop')).toBe(1);
    });

    it('counts every turn a burst of them collapsed into one frame', () => {
      const ledger = new UnreadLedger();
      ledger.sync([unit('scoop', 'idle', 1)], 'cone');
      expect(ledger.sync([unit('scoop', 'working', 4)], 'cone').get('scoop')).toBe(3);
    });

    it('counts the first turn of a unit it has been watching', () => {
      const ledger = new UnreadLedger();
      // No counter yet: a leader only sends one once the unit has finished a
      // turn, so its arrival at 1 IS that turn and must not be swallowed as a
      // baseline.
      ledger.sync([unit('scoop', 'working')], 'cone');
      expect(ledger.sync([unit('scoop', 'idle', 1)], 'cone').get('scoop')).toBe(1);
    });

    it('baselines a unit it is seeing for the first time', () => {
      const ledger = new UnreadLedger();
      expect(ledger.sync([unit('scoop', 'idle', 7)], 'cone').size).toBe(0);
      expect(ledger.sync([unit('scoop', 'idle', 8)], 'cone').get('scoop')).toBe(1);
    });

    it('re-baselines instead of underflowing when a leader reloads', () => {
      const ledger = new UnreadLedger();
      ledger.sync([unit('scoop', 'idle', 9)], 'cone');
      // A fresh leader counts from zero again; that is not negative news.
      expect(ledger.sync([unit('scoop', 'idle', 0)], 'cone').size).toBe(0);
      expect(ledger.sync([unit('scoop', 'idle', 1)], 'cone').get('scoop')).toBe(1);
    });

    it('takes precedence over the state it also sees', () => {
      const ledger = new UnreadLedger();
      ledger.sync([unit('scoop', 'working', 2)], 'cone');
      // The transition happened AND the counter stood still (the turn was
      // aborted, not completed) — the counter is the one that knows.
      expect(ledger.sync([unit('scoop', 'idle', 2)], 'cone').size).toBe(0);
    });

    it('keeps watching state for a leader that sends no counter', () => {
      const ledger = new UnreadLedger();
      ledger.sync([unit('scoop', 'working')], 'cone');
      expect(ledger.sync([unit('scoop', 'idle')], 'cone').get('scoop')).toBe(1);
    });
  });

  it('hands its counts to the strip, minus the selected tab', () => {
    const summaries: WorkUnitSummary[] = [
      {
        id: 'cone',
        parentId: null,
        role: 'primary',
        name: 'sliccy',
        folder: 'cone',
        assistantLabel: 'Sliccy',
        state: 'idle',
        fill: 10,
      },
      {
        id: 'scoop',
        parentId: 'cone',
        role: 'child',
        name: 'research',
        folder: 'research',
        assistantLabel: 'Research',
        state: 'idle',
        fill: 20,
      },
    ];
    const unread = new Map([
      ['cone', 4],
      ['scoop', 2],
    ]);
    const tabs = toTabDescriptors(summaries, 'cone', () => '#000', unread);
    expect(tabs.find((tab) => tab.key === 'cone')?.unread).toBeUndefined();
    expect(tabs.find((tab) => tab.key === 'scoop')?.unread).toBe(2);
    // A caller that tracks nothing dots nothing.
    expect(toTabDescriptors(summaries, 'cone', () => '#000')[1]?.unread).toBeUndefined();
  });
});
