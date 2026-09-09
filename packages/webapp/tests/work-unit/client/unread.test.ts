import { describe, expect, it } from 'vitest';
import { toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import type {
  WorkUnitPresentationState,
  WorkUnitSummary,
} from '../../../src/work-unit/client/types.js';
import { UnreadLedger } from '../../../src/work-unit/client/unread.js';

type LedgerUnit = Pick<WorkUnitSummary, 'id' | 'role' | 'state' | 'turns'>;

/** A cone — the only kind of unit the ledger counts. */
function cone(id: string, state: WorkUnitPresentationState, turns?: number): LedgerUnit {
  return { id, role: 'primary', state, ...(turns === undefined ? {} : { turns }) };
}

/** A scoop, which is never news however busy it is. */
function scoop(id: string, state: WorkUnitPresentationState, turns?: number): LedgerUnit {
  return { id, role: 'child', state, ...(turns === undefined ? {} : { turns }) };
}

describe('UnreadLedger', () => {
  it('counts a turn ending on a cone the user is not watching', () => {
    const ledger = new UnreadLedger();
    ledger.sync([cone('here', 'idle'), cone('there', 'working')], 'here');
    expect(ledger.sync([cone('here', 'idle'), cone('there', 'idle')], 'here').get('there')).toBe(1);
    ledger.sync([cone('here', 'idle'), cone('there', 'working')], 'here');
    expect(ledger.sync([cone('here', 'idle'), cone('there', 'idle')], 'here').get('there')).toBe(2);
  });

  it('counts a turn that ends in failure', () => {
    const ledger = new UnreadLedger();
    ledger.sync([cone('there', 'working')], 'here');
    expect(ledger.sync([cone('there', 'broken')], 'here').get('there')).toBe(1);
  });

  it('never counts a scoop, however many turns it finishes', () => {
    const ledger = new UnreadLedger();
    // A scoop's turns are the work its cone was asked for, and a user never
    // talks to a scoop — so there is no unread reply behind such a dot.
    ledger.sync([cone('here', 'idle'), scoop('helper', 'working', 1)], 'here');
    expect(ledger.sync([cone('here', 'idle'), scoop('helper', 'idle', 2)], 'here').size).toBe(0);
    // Not even while the user is watching a different cone entirely.
    ledger.sync([cone('there', 'idle'), scoop('helper', 'working')], 'there');
    expect(ledger.sync([cone('there', 'idle'), scoop('helper', 'idle')], 'there').size).toBe(0);
  });

  it('never counts the selected cone, and clears it on selection', () => {
    const ledger = new UnreadLedger();
    ledger.sync([cone('here', 'idle'), cone('there', 'working')], 'here');
    expect(ledger.sync([cone('here', 'idle'), cone('there', 'idle')], 'there').has('there')).toBe(
      false
    );
    // And a count already held is a read receipt the moment the tab is opened.
    ledger.sync([cone('there', 'working')], 'here');
    expect(ledger.sync([cone('there', 'idle')], 'here').get('there')).toBe(1);
    expect(ledger.sync([cone('there', 'idle')], 'there').has('there')).toBe(false);
  });

  it('is idempotent for an unchanged roster — it counts transitions, not states', () => {
    const ledger = new UnreadLedger();
    ledger.sync([cone('there', 'working')], 'here');
    ledger.sync([cone('there', 'idle')], 'here');
    ledger.sync([cone('there', 'idle')], 'here');
    expect(ledger.sync([cone('there', 'idle')], 'here').get('there')).toBe(1);
  });

  it('does not open a first roster with everything unread', () => {
    const ledger = new UnreadLedger();
    const counts = ledger.sync([cone('here', 'idle'), cone('old', 'broken')], 'here');
    expect(counts.size).toBe(0);
  });

  it('forgets a cone the roster dropped instead of resurrecting its dot', () => {
    const ledger = new UnreadLedger();
    ledger.sync([cone('here', 'idle'), cone('there', 'working')], 'here');
    expect(ledger.sync([cone('here', 'idle'), cone('there', 'idle')], 'here').get('there')).toBe(1);
    expect(ledger.sync([cone('here', 'idle')], 'here').has('there')).toBe(false);
    // A recycled id starts clean: no held count, and no remembered `working`.
    expect(ledger.sync([cone('here', 'idle'), cone('there', 'idle')], 'here').has('there')).toBe(
      false
    );
  });

  describe('the completion counter', () => {
    it('counts a turn a coalesced roster push never showed as working', () => {
      const ledger = new UnreadLedger();
      // The follower has seen this cone idle; the leader then runs a whole turn
      // inside its 50ms coalescing window, so the only frame that lands is the
      // final `idle` — sampled state says nothing happened, `turns` says one
      // turn did.
      ledger.sync([cone('here', 'idle'), cone('there', 'idle', 3)], 'here');
      const counts = ledger.sync([cone('here', 'idle'), cone('there', 'idle', 4)], 'here');
      expect(counts.get('there')).toBe(1);
    });

    it('counts every turn a burst of them collapsed into one frame', () => {
      const ledger = new UnreadLedger();
      ledger.sync([cone('there', 'idle', 1)], 'here');
      expect(ledger.sync([cone('there', 'working', 4)], 'here').get('there')).toBe(3);
    });

    it('counts the first turn of a cone it has been watching', () => {
      const ledger = new UnreadLedger();
      // No counter yet: a leader only sends one once the unit has finished a
      // turn, so its arrival at 1 IS that turn and must not be swallowed as a
      // baseline.
      ledger.sync([cone('there', 'working')], 'here');
      expect(ledger.sync([cone('there', 'idle', 1)], 'here').get('there')).toBe(1);
    });

    it('baselines a cone it is seeing for the first time', () => {
      const ledger = new UnreadLedger();
      expect(ledger.sync([cone('there', 'idle', 7)], 'here').size).toBe(0);
      expect(ledger.sync([cone('there', 'idle', 8)], 'here').get('there')).toBe(1);
    });

    it('re-baselines instead of underflowing when a leader reloads', () => {
      const ledger = new UnreadLedger();
      ledger.sync([cone('there', 'idle', 9)], 'here');
      // A fresh leader counts from zero again; that is not negative news.
      expect(ledger.sync([cone('there', 'idle', 0)], 'here').size).toBe(0);
      expect(ledger.sync([cone('there', 'idle', 1)], 'here').get('there')).toBe(1);
    });

    it('takes precedence over the state it also sees', () => {
      const ledger = new UnreadLedger();
      ledger.sync([cone('there', 'working', 2)], 'here');
      // The transition happened AND the counter stood still (the turn was
      // aborted, not completed) — the counter is the one that knows.
      expect(ledger.sync([cone('there', 'idle', 2)], 'here').size).toBe(0);
    });

    it('keeps watching state for a leader that sends no counter', () => {
      const ledger = new UnreadLedger();
      ledger.sync([cone('there', 'working')], 'here');
      expect(ledger.sync([cone('there', 'idle')], 'here').get('there')).toBe(1);
    });
  });

  it('hands its counts to the strip, minus the selected tab and every scoop', () => {
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
        id: 'other',
        parentId: null,
        role: 'primary',
        name: 'sliccy',
        folder: 'other',
        assistantLabel: 'Sliccy',
        state: 'idle',
        fill: 15,
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
      ['other', 3],
      ['scoop', 2],
    ]);
    const tabs = toTabDescriptors(summaries, 'cone', () => '#000', unread);
    expect(tabs.find((tab) => tab.key === 'cone')?.unread).toBeUndefined();
    expect(tabs.find((tab) => tab.key === 'other')?.unread).toBe(3);
    // A caller handing over its own map does not get to dot a scoop either.
    expect(tabs.find((tab) => tab.key === 'scoop')?.unread).toBeUndefined();
    // A caller that tracks nothing dots nothing.
    expect(
      toTabDescriptors(summaries, 'cone', () => '#000').every((tab) => tab.unread === undefined)
    ).toBe(true);
  });
});
