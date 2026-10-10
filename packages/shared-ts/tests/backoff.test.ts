import { describe, expect, it } from 'vitest';
import { nextBackoffDelayMs } from '../src/backoff.js';

describe('nextBackoffDelayMs', () => {
  it('doubles from the base per attempt', () => {
    expect(nextBackoffDelayMs({ attempt: 0, baseMs: 250 })).toBe(250);
    expect(nextBackoffDelayMs({ attempt: 1, baseMs: 250 })).toBe(500);
    expect(nextBackoffDelayMs({ attempt: 3, baseMs: 250 })).toBe(2000);
  });

  it('clamps a negative attempt to the base delay', () => {
    expect(nextBackoffDelayMs({ attempt: -5, baseMs: 1000 })).toBe(1000);
  });

  it('caps the exponential delay at capMs', () => {
    expect(nextBackoffDelayMs({ attempt: 10, baseMs: 1000, capMs: 15000 })).toBe(15000);

    expect(nextBackoffDelayMs({ attempt: 3, baseMs: 1000, capMs: 15000 })).toBe(8000);
  });

  it('is uncapped when capMs is omitted', () => {
    expect(nextBackoffDelayMs({ attempt: 20, baseMs: 500 })).toBe(500 * 2 ** 20);
  });

  it('clamps the exponent with maxShift before applying the cap', () => {
    expect(nextBackoffDelayMs({ attempt: 40, baseMs: 1, maxShift: 8 })).toBe(2 ** 8);
  });

  it('adds jitter as a fraction of the delay, pinned by random', () => {
    expect(nextBackoffDelayMs({ attempt: 0, baseMs: 1000, jitter: 0.2, random: () => 0.5 })).toBe(
      1100
    );

    expect(nextBackoffDelayMs({ attempt: 0, baseMs: 1000, jitter: 0.2, random: () => 0 })).toBe(
      1000
    );
  });

  it('keeps the jittered delay within the cap', () => {
    const delay = nextBackoffDelayMs({
      attempt: 30,
      baseMs: 250,
      capMs: 30000,
      jitter: 0.2,
      random: () => 0.99,
    });
    expect(delay).toBe(30000);
  });

  it('matches the legacy CDP reconnect formula', () => {
    const legacy = (attempt: number, random: () => number): number => {
      const shift = Math.min(Math.max(0, attempt), 16);
      const exp = Math.min(30000, 250 * 2 ** shift);
      return Math.min(30000, exp + Math.round(exp * 0.2 * random()));
    };
    for (const attempt of [0, 1, 5, 16, 30]) {
      for (const r of [0, 0.37, 0.99]) {
        expect(
          nextBackoffDelayMs({
            attempt,
            baseMs: 250,
            capMs: 30000,
            jitter: 0.2,
            maxShift: 16,
            random: () => r,
          })
        ).toBe(legacy(attempt, () => r));
      }
    }
  });
});
