/**
 * Turn-gate lifetime and multi-seat batches — the two ways a guest's tool calls
 * could escape review, or an owner's could be caught by it.
 */

import type { FollowerBiscottoIdentity } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { toolGateForSeat } from '../../src/scoops/tray-leader/biscotto-gate.js';

function seat(tool: { approver: string; scoop?: string }): FollowerBiscottoIdentity {
  return {
    id: 'seat1',
    label: 'Anna',
    gates: { message: { approver: 'user' }, tool },
  } as unknown as FollowerBiscottoIdentity;
}

describe('toolGateForSeat', () => {
  it('produces no gate when the seat leaves tool calls ungated', () => {
    expect(toolGateForSeat(seat({ approver: 'off' }), 'cone_1')).toBeUndefined();
  });

  it('routes the user tier to the owner broker', () => {
    expect(toolGateForSeat(seat({ approver: 'user' }), 'cone_1')).toEqual({
      requester: 'biscotto “Anna”',
    });
  });

  it('REFUSES a cone-tier tool gate rather than substituting the owner', () => {
    // The cone would be blocked awaiting this very tool result and could not
    // reach `lick_confirm`, so the tier is unroutable for tool calls. An
    // earlier build sent these to the OWNER — which is worse than useless: the
    // principal the seat names never decides, while a different principal
    // authorizes execution. `null` means "cannot ask the configured approver".
    expect(toolGateForSeat(seat({ approver: 'cone' }), 'cone_1')).toBeNull();
  });

  it('routes the scoop tier to the named scoop', () => {
    expect(toolGateForSeat(seat({ approver: 'scoop', scoop: 'reviewer' }), 'cone_1')).toEqual({
      requester: 'biscotto “Anna”',
      approver: { kind: 'scoop', scoopName: 'reviewer', unitJid: 'cone_1' },
    });
  });

  it('refuses a scoop tier with no scoop named', () => {
    // Cannot reach the configured approver either — deny, do not redirect.
    expect(toolGateForSeat(seat({ approver: 'scoop' }), 'cone_1')).toBeNull();
  });

  it('refuses an approver tier it does not recognise', () => {
    // An unknown tier must never read as "no gate", and must not resolve to a
    // known approver either — `null` is the only honest answer.
    expect(toolGateForSeat(seat({ approver: 'quorum' }), 'cone_1')).toBeNull();
  });

  it('names an unlabelled seat rather than emitting empty quotes', () => {
    const anon = { id: 's', label: '  ', gates: { message: {}, tool: { approver: 'user' } } };
    expect(toolGateForSeat(anon as never, 'cone_1')?.requester).toBe('an unnamed biscotto');
  });
});
