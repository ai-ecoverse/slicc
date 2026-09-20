import { describe, expect, it } from 'vitest';
import {
  LOCAL_SEND_CONFIRMATION_WINDOW_MS,
  LocalSendLedger,
} from '../../../src/ui/work-unit-client/local-send-ledger.js';
import type { WorkUnitChatMessage } from '../../../src/work-unit/client/types.js';

const start = 1_000;

function message(id: string): WorkUnitChatMessage {
  return { id, role: 'user', content: id, timestamp: 1 };
}

describe('LocalSendLedger', () => {
  it('restores missing sends in the order they were sent', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('second'), 'b', start + 2);
    ledger.record(message('first'), 'b', start + 1);

    const merged = ledger.reconcile([message('old')], 'b', start + 3);

    expect(merged.map((entry) => entry.id)).toEqual(['old', 'first', 'second']);
    expect(ledger.owns('first')).toBe(true);
  });

  it('a send belongs only to the unit it was sent under', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('for-b'), 'b', start);

    const merged = ledger.reconcile([], 'a', start);

    expect(merged.map((entry) => entry.id)).toEqual([]);
    expect(ledger.owns('for-b')).toBe(true);
  });

  it('an expired send stops outranking the leader', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('lost'), 'b', start);
    const later = start + LOCAL_SEND_CONFIRMATION_WINDOW_MS + 1;

    expect(ledger.reconcile([], 'b', later).map((entry) => entry.id)).toEqual([]);
    expect(ledger.owns('lost')).toBe(false);
  });

  it('a send refused by the transport is still restored', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('refused'), 'b', start);
    ledger.flagUndelivered('refused');

    const merged = ledger.reconcile([message('old')], 'b', start);

    expect(merged.map((entry) => entry.id)).toEqual(['old', 'refused']);
    expect(ledger.owns('refused')).toBe(true);
    expect(ledger.isUndelivered('refused')).toBe(true);
  });

  it('a send made before any unit was selected is adopted by the first snapshot', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('early'), null, start);

    const first = ledger.reconcile([message('old')], 'cone', start);
    expect(first.map((entry) => entry.id)).toEqual(['old', 'early']);

    expect(ledger.reconcile([], 'other', start).map((entry) => entry.id)).toEqual([]);
    expect(ledger.reconcile([], 'cone', start).map((entry) => entry.id)).toEqual(['early']);
  });

  it('a later snapshot that contains the prompt does not duplicate it', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('local-1'), 'b', start);
    ledger.reconcile([message('old')], 'b', start);

    const confirmed = ledger.reconcile([message('old'), message('local-1')], 'b', start + 1);

    expect(confirmed.map((entry) => entry.id)).toEqual(['old', 'local-1']);
    expect(ledger.owns('local-1')).toBe(false);
    expect(ledger.reconcile([message('old'), message('local-1')], 'b', start + 2)).toEqual(
      confirmed
    );
  });

  it('seeding from the local cache does not confirm a send', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('local-1'), 'b', start);
    const overlaid = ledger.withUnconfirmed([message('old'), message('local-1')], 'b', start);

    expect(overlaid.map((entry) => entry.id)).toEqual(['old', 'local-1']);
    expect(ledger.owns('local-1')).toBe(true);

    const stale = ledger.reconcile([message('old')], 'b', start);
    expect(stale.map((entry) => entry.id)).toEqual(['old', 'local-1']);
  });

  it('removeAll releases every entry', () => {
    const ledger = new LocalSendLedger();
    ledger.record(message('m1'), 'b', start);
    ledger.removeAll();
    expect(ledger.owns('m1')).toBe(false);
    expect(ledger.reconcile([], 'b', start).map((entry) => entry.id)).toEqual([]);
  });
});
