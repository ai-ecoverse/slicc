import { describe, expect, it } from 'vitest';
import { toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import type {
  WorkUnitPresentationState,
  WorkUnitSummary,
} from '../../../src/work-unit/client/types.js';
import { UnreadLedger } from '../../../src/work-unit/client/unread.js';

function unit(id: string, state: WorkUnitPresentationState): Pick<WorkUnitSummary, 'id' | 'state'> {
  return { id, state };
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
