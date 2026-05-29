import { describe, it, expect, beforeEach } from 'vitest';
import { getCached, setCached, invalidate, clearAll } from '../src/cloud/auth-cache.js';

beforeEach(() => clearAll());

describe('auth cache', () => {
  it('round-trips a result', async () => {
    const r = { userId: 'u', email: 'a@adobe.com', userName: 'A' };
    await setCached('tok', r);
    expect(await getCached('tok')).toEqual(r);
  });

  it('returns null for unknown token', async () => {
    expect(await getCached('absent')).toBeNull();
  });

  it('invalidate clears the entry', async () => {
    await setCached('tok', { userId: 'u', email: 'a@adobe.com', userName: 'A' });
    await invalidate('tok');
    expect(await getCached('tok')).toBeNull();
  });

  it('caps TTL at min(10min, tokenExp - now)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const shortExp = nowSec + 60;
    await setCached('short', { userId: 'u', email: 'a@adobe.com', userName: 'A' }, shortExp);
    expect(await getCached('short')).not.toBeNull();

    const longExp = nowSec + 60 * 60;
    await setCached('long', { userId: 'u', email: 'a@adobe.com', userName: 'A' }, longExp);
    expect(await getCached('long')).not.toBeNull();
  });

  it('returns null after manual time-warp past expiry', async () => {
    const result = { userId: 'u', email: 'a@adobe.com', userName: 'A' };
    const pastExpSec = Math.floor(Date.now() / 1000) - 1;
    await setCached('expired', result, pastExpSec);
    expect(await getCached('expired')).toBeNull();
  });
});
