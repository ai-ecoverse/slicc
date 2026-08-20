/**
 * Tests for the user-facing approval timeout wrapper. Timers are injected so
 * the five-minute budget is exercised without waiting for it, and the wrapped
 * broker is a fake whose promise is settled by hand — that is the shape of the
 * real problem: a request that nobody is there to answer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isTimedOut,
  sudoRefusalMessage,
  timedOutDecision,
  timeoutNotice,
  USER_SUDO_TIMEOUT_MS,
  withApprovalTimeout,
} from '../../src/sudo/approval-timeout.js';
import type {
  SudoBroker,
  SudoDecision,
  SudoRequest,
  SudoRequestOptions,
} from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

/** Broker whose decision is settled manually, plus captured injectable timers. */
function makeHarness(callOpts?: SudoRequestOptions) {
  let settle: ((d: SudoDecision) => void) | null = null;
  let reject: ((err: unknown) => void) | null = null;
  let seenSignal: AbortSignal | undefined;
  const inner: SudoBroker = {
    requestApproval: vi.fn((_req: SudoRequest, opts?: SudoRequestOptions) => {
      seenSignal = opts?.signal;
      return new Promise<SudoDecision>((res, rej) => {
        settle = res;
        reject = rej;
      });
    }),
  };

  let fire: (() => void) | null = null;
  const setTimer = vi.fn((cb: () => void, _ms: number) => {
    fire = cb;
    return 'handle';
  });
  const clearTimer = vi.fn();

  const broker = withApprovalTimeout(inner, { setTimer, clearTimer });
  const pending = broker.requestApproval(REQ, callOpts);
  return {
    inner,
    broker,
    pending,
    setTimer,
    clearTimer,
    signal: () => seenSignal,
    answer: (d: SudoDecision) => settle?.(d),
    fail: (err: unknown) => reject?.(err),
    expire: () => fire?.(),
  };
}

describe('withApprovalTimeout', () => {
  it('passes an answered prompt through untouched', async () => {
    const h = makeHarness();
    h.answer({ decision: 'always', pattern: 'git push*' });
    expect(await h.pending).toEqual({ decision: 'always', pattern: 'git push*' });
    expect(h.clearTimer).toHaveBeenCalledWith('handle');
  });

  it('keeps a real denial distinguishable from a timeout', async () => {
    const h = makeHarness();
    h.answer({ decision: 'deny' });
    const decision = await h.pending;
    expect(decision).toEqual({ decision: 'deny' });
    expect(isTimedOut(decision)).toBe(false);
  });

  it('settles fail-closed with reason "user-timeout" when nobody answers', async () => {
    const h = makeHarness();
    h.expire();
    const decision = await h.pending;
    expect(decision).toEqual({ decision: 'deny', reason: 'user-timeout' });
    expect(isTimedOut(decision)).toBe(true);
  });

  it('arms the timer with the five-minute budget', () => {
    const h = makeHarness();
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), USER_SUDO_TIMEOUT_MS);
    expect(USER_SUDO_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('aborts the broker so it cannot raise a prompt after the budget expires', async () => {
    const h = makeHarness();
    expect(h.signal()?.aborted).toBe(false);
    h.expire();
    // Aborted before the caller is resolved: a broker still awaiting its
    // pattern suggestion must see the cancellation, not pop a stale dialog.
    expect(h.signal()?.aborted).toBe(true);
    await expect(h.pending).resolves.toEqual({ decision: 'deny', reason: 'user-timeout' });
  });

  it('leaves the signal unaborted for an answered prompt', async () => {
    const h = makeHarness();
    h.answer({ decision: 'allow' });
    await h.pending;
    expect(h.signal()?.aborted).toBe(false);
  });

  it("forwards the caller's own abort to the broker", async () => {
    const outer = new AbortController();
    const h = makeHarness({ signal: outer.signal });
    expect(h.signal()?.aborted).toBe(false);
    outer.abort();
    expect(h.signal()?.aborted).toBe(true);
  });

  it('discards a decision that arrives after the timeout', async () => {
    const h = makeHarness();
    h.expire();
    // The human finally clicks "Always" — too late; the caller already took
    // the fail-closed path, so the grant must not resurface as an approval.
    h.answer({ decision: 'always', pattern: 'git push*' });
    expect(await h.pending).toEqual({ decision: 'deny', reason: 'user-timeout' });
  });

  it('denies (without a timeout reason) when the wrapped broker throws', async () => {
    const h = makeHarness();
    h.fail(new Error('transport gone'));
    const decision = await h.pending;
    expect(decision).toEqual({ decision: 'deny' });
    expect(isTimedOut(decision)).toBe(false);
  });

  it('returns the broker unwrapped when the budget is disabled', () => {
    const inner: SudoBroker = { requestApproval: vi.fn() };
    expect(withApprovalTimeout(inner, { timeoutMs: 0 })).toBe(inner);
    expect(withApprovalTimeout(inner, { timeoutMs: -1 })).toBe(inner);
    expect(withApprovalTimeout(inner, { timeoutMs: Number.POSITIVE_INFINITY })).toBe(inner);
  });

  it('does not treat allow / always as timed out', () => {
    expect(isTimedOut({ decision: 'allow' })).toBe(false);
    expect(isTimedOut({ decision: 'always', pattern: '*' })).toBe(false);
  });
});

describe('timeout notices', () => {
  it('defaults to the user leg', () => {
    expect(timedOutDecision()).toEqual({ decision: 'deny', reason: 'user-timeout' });
    expect(timedOutDecision('cone-timeout')).toEqual({
      decision: 'deny',
      reason: 'cone-timeout',
    });
  });

  it('names the timeout and warns against retrying on both legs', () => {
    for (const reason of ['user-timeout', 'cone-timeout'] as const) {
      expect(timeoutNotice(reason)).toMatch(/TIMEOUT, not a denial/);
      expect(timeoutNotice(reason)).toMatch(/Do not retry/);
    }
  });

  it('names the right approver per leg', () => {
    // The two legs have different approvers, so the recovery advice differs:
    // waiting for an absent human is wrong when it was the cone that stalled.
    expect(timeoutNotice('user-timeout')).toContain('the user');
    expect(timeoutNotice('user-timeout')).toContain('wait for the user');
    expect(timeoutNotice('cone-timeout')).toContain('the cone agent');
    expect(timeoutNotice('cone-timeout')).toContain('no human was ever prompted');
    expect(timeoutNotice('cone-timeout')).not.toContain('wait for the user');
  });
});

describe('sudoRefusalMessage', () => {
  it('reports a refusal plainly', () => {
    expect(sudoRefusalMessage('sudo', { decision: 'deny' })).toBe('sudo: approval denied');
    expect(sudoRefusalMessage('secret', { decision: 'deny' })).toBe('secret: approval denied');
  });

  it('reports a timeout with the matching leg notice', () => {
    const msg = sudoRefusalMessage('sudo', { decision: 'deny', reason: 'cone-timeout' });
    expect(msg).toContain('sudo: approval request timed out');
    expect(msg).toContain(timeoutNotice('cone-timeout'));
  });

  it('never reports a non-deny decision as denied-with-reason', () => {
    // `reason` is only meaningful on a deny; an allow must not inherit it.
    expect(sudoRefusalMessage('sudo', { decision: 'allow' })).toBe('sudo: approval denied');
  });
});
