import { describe, expect, it } from 'vitest';
import {
  activeTimeMicrosToGbSeconds,
  buildReport,
  daysInUtcMonth,
  estimateDailySpend,
  estimateMeterCost,
  ISSUE_MARKER,
  isOverThreshold,
  METERS,
  previousUtcDay,
  sumForDay,
} from './lib.mjs';

describe('activeTimeMicrosToGbSeconds', () => {
  it('converts microseconds of active time into 128 MB GB-seconds', () => {
    // 1s of active time = 1_000_000 micros = 0.125 GB-s (128 MB).
    expect(activeTimeMicrosToGbSeconds(1_000_000)).toBeCloseTo(0.125, 6);
  });

  it('treats missing/invalid input as zero', () => {
    expect(activeTimeMicrosToGbSeconds(undefined)).toBe(0);
    expect(activeTimeMicrosToGbSeconds('nope')).toBe(0);
  });
});

describe('daysInUtcMonth', () => {
  it('returns the correct day count per month', () => {
    expect(daysInUtcMonth('2026-06-04')).toBe(30);
    expect(daysInUtcMonth('2026-01-15')).toBe(31);
    expect(daysInUtcMonth('2024-02-10')).toBe(29); // leap year
    expect(daysInUtcMonth('2026-02-10')).toBe(28);
  });

  it('falls back to 30 for malformed input', () => {
    expect(daysInUtcMonth('garbage')).toBe(30);
  });
});

describe('previousUtcDay', () => {
  it('returns the prior complete UTC day window', () => {
    const range = previousUtcDay(new Date('2026-06-05T09:30:00Z'));
    expect(range).toEqual({
      startISO: '2026-06-04T00:00:00.000Z',
      endISO: '2026-06-05T00:00:00.000Z',
      day: '2026-06-04',
    });
  });
});

describe('sumForDay', () => {
  const groups = [
    { dimensions: { date: '2026-06-03' }, sum: { activeTime: 10 } },
    { dimensions: { date: '2026-06-04' }, sum: { activeTime: 20 } },
    { dimensions: { date: '2026-06-04' }, sum: { activeTime: 5 } },
  ];

  it('sums only the rows matching the requested day', () => {
    expect(sumForDay(groups, '2026-06-04', 'activeTime')).toBe(25);
  });

  it('returns 0 for no match or non-array input', () => {
    expect(sumForDay(groups, '2026-01-01', 'activeTime')).toBe(0);
    expect(sumForDay(null, '2026-06-04', 'activeTime')).toBe(0);
  });
});

describe('estimateMeterCost', () => {
  it('prices billable units after subtracting the prorated daily free tier', () => {
    // duration: free 400_000/month; in a 30-day month that is ~13_333/day.
    const result = estimateMeterCost(913_333, METERS.durableObjectsDuration, 30);
    expect(result.billableUnits).toBeCloseTo(900_000, 0);
    expect(result.usd).toBeCloseTo(11.25, 2); // 900_000 / 1e6 * 12.5
  });

  it('never goes negative below the free allocation', () => {
    const result = estimateMeterCost(1000, METERS.workersRequests, 30);
    expect(result.billableUnits).toBe(0);
    expect(result.usd).toBe(0);
  });
});

describe('estimateDailySpend', () => {
  it('reproduces the duration incident (~$11/day) and stays additive', () => {
    const { totalUsd, breakdown } = estimateDailySpend(
      { durationGbSeconds: 914_638, doRequests: 66_335, workersRequests: 80_373 },
      { daysInMonth: 30 }
    );
    expect(totalUsd).toBeGreaterThan(11);
    expect(totalUsd).toBeLessThan(12);
    expect(breakdown).toHaveLength(3);
    // Workers requests are well within the prorated free tier here.
    expect(breakdown[2].usd).toBe(0);
  });

  it('returns ~$0 for a healthy (post-hibernation) day', () => {
    const { totalUsd } = estimateDailySpend(
      { durationGbSeconds: 9_000, doRequests: 60_000, workersRequests: 90_000 },
      { daysInMonth: 30 }
    );
    expect(totalUsd).toBeLessThan(0.5);
  });
});

describe('isOverThreshold', () => {
  it('compares strictly greater than the threshold', () => {
    expect(isOverThreshold(11.27, 3)).toBe(true);
    expect(isOverThreshold(3, 3)).toBe(false);
    expect(isOverThreshold(0.1, 3)).toBe(false);
  });
});

describe('buildReport', () => {
  it('includes the dedup marker, day, total and a meter table', () => {
    const estimate = estimateDailySpend(
      { durationGbSeconds: 914_638, doRequests: 66_335, workersRequests: 80_373 },
      { daysInMonth: 30 }
    );
    const body = buildReport({
      day: '2026-06-04',
      thresholdUsd: 3,
      estimate,
      accountId: 'acct-123',
    });
    expect(body).toContain(ISSUE_MARKER);
    expect(body).toContain('2026-06-04 (UTC)');
    expect(body).toContain('Durable Objects duration');
    expect(body).toContain('acct-123');
    expect(body).toMatch(/\*\*Total\*\*/);
  });
});
