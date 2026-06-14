/**
 * Tests for the shared cron helper used by LickManager and TaskScheduler.
 */

import { describe, expect, it } from 'vitest';
import { getNextCronTime } from '../../src/scoops/cron.js';

describe('getNextCronTime', () => {
  it('returns the next minute for "* * * * *"', () => {
    const from = new Date('2026-06-14T10:00:30');
    const next = getNextCronTime('* * * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    expect(next!.getSeconds()).toBe(0);
    expect((next!.getTime() - from.getTime()) / 1000).toBeLessThanOrEqual(60);
  });

  it('fires strictly after the given time', () => {
    const from = new Date('2026-06-14T10:00:00');
    const next = getNextCronTime('* * * * *', from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('computes daily "0 9 * * *" at 09:00', () => {
    const next = getNextCronTime('0 9 * * *', new Date('2026-06-14T10:00:00'));
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getSeconds()).toBe(0);
  });

  it('handles step fields "*/5 * * * *"', () => {
    const next = getNextCronTime('*/5 * * * *', new Date('2026-06-14T10:02:00'));
    expect(next!.getMinutes() % 5).toBe(0);
  });

  it('handles list fields "0 9,17 * * *"', () => {
    const next = getNextCronTime('0 9,17 * * *', new Date('2026-06-14T10:00:00'));
    expect([9, 17]).toContain(next!.getHours());
    expect(next!.getMinutes()).toBe(0);
  });

  it('handles range fields "0 9-17 * * *"', () => {
    const next = getNextCronTime('0 9-17 * * *', new Date('2026-06-14T08:00:00'));
    expect(next!.getHours()).toBeGreaterThanOrEqual(9);
    expect(next!.getHours()).toBeLessThanOrEqual(17);
  });

  it('returns far-future January 1st without iterating minute-by-minute', () => {
    const next = getNextCronTime('0 9 1 1 *', new Date('2026-06-14T10:00:00'));
    expect(next!.getMonth()).toBe(0);
    expect(next!.getDate()).toBe(1);
    expect(next!.getHours()).toBe(9);
  });

  it('returns null for wrong field count', () => {
    expect(getNextCronTime('* * * *', new Date())).toBeNull();
  });

  it('returns null for out-of-range fields', () => {
    expect(getNextCronTime('61 25 32 13 8', new Date())).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(getNextCronTime('not a cron', new Date())).toBeNull();
  });

  it('uses AND semantics when both day-of-month and day-of-week are constrained', () => {
    // "0 9 1 * 1" fires only when the 1st of the month is also a Monday.
    const next = getNextCronTime('0 9 1 * 1', new Date('2026-06-14T10:00:00'));
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(1);
    expect(next!.getDay()).toBe(1);
    expect(next!.getHours()).toBe(9);
  });

  it('supports @daily shortcut', () => {
    const next = getNextCronTime('@daily', new Date('2026-06-14T10:00:00'));
    expect(next!.getHours()).toBe(0);
    expect(next!.getMinutes()).toBe(0);
  });
});
