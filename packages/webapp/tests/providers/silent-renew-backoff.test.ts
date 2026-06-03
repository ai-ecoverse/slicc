import { describe, expect, it, vi } from 'vitest';
import { createSilentRenewBackoff } from '../../src/providers/silent-renew-backoff.js';

describe('createSilentRenewBackoff', () => {
  it('runs renew and returns the token on success, no cooldown', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => 'token-1');
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBe('token-1');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(backoff.inCooldown(t0)).toBe(false);
  });

  it('sets a cooldown after a null renewal and skips renew during it', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => null);
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBeNull();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(backoff.inCooldown(t0 + 500)).toBe(true);
    // within cooldown → renew NOT called again
    expect(await backoff.run(renew, t0 + 500)).toBeNull();
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('re-attempts after the cooldown elapses', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => null);
    const t0 = 10_000;
    await backoff.run(renew, t0); // fail → cooldown until t0+1000
    await backoff.run(renew, t0 + 999); // still cooling → skip
    expect(renew).toHaveBeenCalledTimes(1);
    await backoff.run(renew, t0 + 1000); // elapsed → re-attempt
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown renewal as a failure (cooldown set, returns null)', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => {
      throw new Error('boom');
    });
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBeNull();
    expect(backoff.inCooldown(t0)).toBe(true);
  });

  it('clears the cooldown after a later success', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const t0 = 10_000;
    await backoff.run(async () => null, t0); // fail → cooldown
    const ok = await backoff.run(async () => 'tok', t0 + 1000); // elapsed → success
    expect(ok).toBe('tok');
    expect(backoff.inCooldown(t0 + 1000)).toBe(false);
  });
});
