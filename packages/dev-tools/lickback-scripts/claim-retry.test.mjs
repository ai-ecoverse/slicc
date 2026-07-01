// Unit tests for the claim-retry core. After the bootstrap reaper kills a stale
// drain, the cup keeps the dead session as owner for one lease window (~45s, a
// deliberate reconnect grace) before a fresh claim wins — so claim must ride out
// that tail by retrying on 409, while still succeeding instantly on a clean cup
// and standing down if a live OTHER brain genuinely holds the channel past the
// budget. Pure: inject `attemptClaim` + `sleep`.
import { describe, expect, it, vi } from 'vitest';
import { claimWithRetry } from '../../../.claude/skills/slicc-lickback-handler/scripts/_lib.mjs';

const noSleep = () => Promise.resolve();

describe('claimWithRetry', () => {
  it('returns immediately on a granted claim (no sleep)', async () => {
    const attemptClaim = vi.fn().mockResolvedValue({ status: 200 });
    const sleep = vi.fn(noSleep);
    const res = await claimWithRetry({ attemptClaim, sleep, attempts: 5, intervalMs: 1 });
    expect(res).toEqual({ status: 200 });
    expect(attemptClaim).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rides out the lease tail: 409s then succeeds', async () => {
    const attemptClaim = vi
      .fn()
      .mockResolvedValueOnce({ status: 409, owner: 'dead-sess' })
      .mockResolvedValueOnce({ status: 409, owner: 'dead-sess' })
      .mockResolvedValueOnce({ status: 200 });
    const sleep = vi.fn(noSleep);
    const res = await claimWithRetry({ attemptClaim, sleep, attempts: 10, intervalMs: 1 });
    expect(res).toEqual({ status: 200 });
    expect(attemptClaim).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the budget and returns the last 409 (caller stands down)', async () => {
    const attemptClaim = vi.fn().mockResolvedValue({ status: 409, owner: 'live-other' });
    const sleep = vi.fn(noSleep);
    const res = await claimWithRetry({ attemptClaim, sleep, attempts: 3, intervalMs: 1 });
    expect(res).toEqual({ status: 409, owner: 'live-other' });
    expect(attemptClaim).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the final attempt
  });

  it('does not retry a hard error (non-200/409)', async () => {
    const attemptClaim = vi.fn().mockResolvedValue({ status: 503 });
    const sleep = vi.fn(noSleep);
    const res = await claimWithRetry({ attemptClaim, sleep, attempts: 5, intervalMs: 1 });
    expect(res).toEqual({ status: 503 });
    expect(attemptClaim).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
