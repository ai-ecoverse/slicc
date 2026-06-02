import { beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, clearAll } from '../src/cloud/rate-limit.js';

beforeEach(() => clearAll());

describe('rate-limit', () => {
  it('allows under capacity', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit('u1', 'start')).toEqual({ ok: true });
    }
  });

  it('rejects over capacity with retryAfter', () => {
    for (let i = 0; i < 30; i++) checkRateLimit('u1', 'start');
    const r = checkRateLimit('u1', 'start');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('isolates users', () => {
    for (let i = 0; i < 30; i++) checkRateLimit('u1', 'start');
    expect(checkRateLimit('u2', 'start')).toEqual({ ok: true });
  });

  it('isolates ops within the same user', () => {
    for (let i = 0; i < 30; i++) checkRateLimit('u1', 'start');
    expect(checkRateLimit('u1', 'list')).toEqual({ ok: true });
  });

  it('passes through unknown ops without rate-limiting', () => {
    for (let i = 0; i < 1000; i++) {
      expect(checkRateLimit('u1', 'unknown-op')).toEqual({ ok: true });
    }
  });
});
