/**
 * Tests for the user-facing approval timeout wrapper. Timers are injected so
 * the five-minute budget is exercised without waiting for it, and the wrapped
 * broker is a fake whose promise is settled by hand — that is the shape of the
 * real problem: a prompt that nobody is there to answer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isTimedOut,
  SUDO_TIMEOUT_NOTICE,
  timedOutDecision,
  USER_SUDO_TIMEOUT_MS,
  withApprovalTimeout,
} from '../../src/sudo/approval-timeout.js';
import type { SudoBroker, SudoDecision, SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

/** Broker whose decision is settled manually, plus captured injectable timers. */
function makeHarness() {
  let settle: ((d: SudoDecision) => void) | null = null;
  let reject: ((err: unknown) => void) | null = null;
  const inner: SudoBroker = {
    requestApproval: vi.fn(
      () =>
        new Promise<SudoDecision>((res, rej) => {
          settle = res;
          reject = rej;
        })
    ),
  };

  let fire: (() => void) | null = null;
  const setTimer = vi.fn((cb: () => void, _ms: number) => {
    fire = cb;
    return 'handle';
  });
  const clearTimer = vi.fn();

  const broker = withApprovalTimeout(inner, { setTimer, clearTimer });
  return {
    inner,
    broker,
    setTimer,
    clearTimer,
    answer: (d: SudoDecision) => settle?.(d),
    fail: (err: unknown) => reject?.(err),
    expire: () => fire?.(),
  };
}

describe('withApprovalTimeout', () => {
  it('passes an answered prompt through untouched', async () => {
    const h = makeHarness();
    const pending = h.broker.requestApproval(REQ);
    h.answer({ decision: 'always', pattern: 'git push*' });
    expect(await pending).toEqual({ decision: 'always', pattern: 'git push*' });
    expect(h.clearTimer).toHaveBeenCalledWith('handle');
  });

  it('keeps a real denial distinguishable from a timeout', async () => {
    const h = makeHarness();
    const pending = h.broker.requestApproval(REQ);
    h.answer({ decision: 'deny' });
    const decision = await pending;
    expect(decision).toEqual({ decision: 'deny' });
    expect(isTimedOut(decision)).toBe(false);
  });

  it('settles fail-closed with reason "timeout" when nobody answers', async () => {
    const h = makeHarness();
    const pending = h.broker.requestApproval(REQ);
    h.expire();
    const decision = await pending;
    expect(decision).toEqual({ decision: 'deny', reason: 'timeout' });
    expect(isTimedOut(decision)).toBe(true);
  });

  it('arms the timer with the five-minute budget', () => {
    const h = makeHarness();
    void h.broker.requestApproval(REQ);
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), USER_SUDO_TIMEOUT_MS);
    expect(USER_SUDO_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('discards a decision that arrives after the timeout', async () => {
    const h = makeHarness();
    const pending = h.broker.requestApproval(REQ);
    h.expire();
    // The human finally clicks "Always" — too late; the caller already took
    // the fail-closed path, so the grant must not resurface as an approval.
    h.answer({ decision: 'always', pattern: 'git push*' });
    expect(await pending).toEqual({ decision: 'deny', reason: 'timeout' });
  });

  it('denies (without a timeout reason) when the wrapped broker throws', async () => {
    const h = makeHarness();
    const pending = h.broker.requestApproval(REQ);
    h.fail(new Error('transport gone'));
    const decision = await pending;
    expect(decision).toEqual({ decision: 'deny' });
    expect(isTimedOut(decision)).toBe(false);
  });

  it('returns the broker unwrapped when the budget is disabled', () => {
    const inner: SudoBroker = { requestApproval: vi.fn() };
    expect(withApprovalTimeout(inner, { timeoutMs: 0 })).toBe(inner);
    expect(withApprovalTimeout(inner, { timeoutMs: -1 })).toBe(inner);
    expect(withApprovalTimeout(inner, { timeoutMs: Number.POSITIVE_INFINITY })).toBe(inner);
  });

  it('exposes a notice that names the timeout and warns against retrying', () => {
    expect(timedOutDecision()).toEqual({ decision: 'deny', reason: 'timeout' });
    expect(SUDO_TIMEOUT_NOTICE).toMatch(/TIMEOUT, not a denial/);
    expect(SUDO_TIMEOUT_NOTICE).toMatch(/Do not retry/);
  });

  it('does not treat allow / always as timed out', () => {
    expect(isTimedOut({ decision: 'allow' })).toBe(false);
    expect(isTimedOut({ decision: 'always', pattern: '*' })).toBe(false);
  });
});
