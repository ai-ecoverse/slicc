import { describe, expect, it } from 'vitest';
import {
  dayBar,
  dayKey,
  describeRecurrence,
  formatDayKey,
  formatDuration,
  formatRange,
  occurrenceDay,
  relativeLabel,
  type TimePreviewData,
  weekStrip,
} from '../../src/chat/time-preview-model.js';

const ZONE = 'America/Los_Angeles';
const REF = '2026-05-12T10:30:00-07:00';

function data(partial: Partial<TimePreviewData> = {}): TimePreviewData {
  return {
    text: 'x',
    reference: REF,
    timeZone: ZONE,
    occurrences: [],
    rrules: [],
    locale: 'en-US',
    ...partial,
  };
}

describe('dayKey / occurrenceDay', () => {
  it('reads the calendar day in the target zone', () => {
    const ms = Date.parse('2026-05-13T03:00:00Z');
    expect(dayKey(ms, 'UTC')).toBe('2026-05-13');
    expect(dayKey(ms, ZONE)).toBe('2026-05-12');
  });

  it('keeps a bare all-day date on its own day west of Greenwich', () => {
    expect(occurrenceDay({ start: '2026-05-18', allDay: true }, ZONE)).toBe('2026-05-18');
    expect(occurrenceDay({ start: 'nope', allDay: false }, ZONE)).toBeNull();
  });

  it('formats a day key without shifting it', () => {
    expect(formatDayKey('2026-05-18', data())).toBe('Mon, May 18');
  });
});

describe('relativeLabel', () => {
  const ref = Date.parse(REF);
  it('uses the coarsest honest unit', () => {
    expect(relativeLabel(ref + 20 * 60_000, ref, 'en-US')).toBe('in 20 minutes');
    expect(relativeLabel(ref - 2 * 3_600_000, ref, 'en-US')).toBe('2 hours ago');
    expect(relativeLabel(ref + 86_400_000, ref, 'en-US')).toBe('tomorrow');
    expect(relativeLabel(ref + 10 * 86_400_000, ref, 'en-US')).toBe('in 10 days');
    expect(relativeLabel(ref + 21 * 86_400_000, ref, 'en-US')).toBe('in 3 weeks');
    expect(relativeLabel(ref + 10_000, ref, 'en-US')).toBe('now');
  });
});

describe('formatDuration', () => {
  it('reads minutes, hours and days', () => {
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(2 * 3_600_000)).toBe('2 h');
    expect(formatDuration(90 * 60_000)).toBe('1 h 30 min');
    expect(formatDuration(3 * 86_400_000)).toBe('3 days');
  });
});

describe('describeRecurrence', () => {
  const rule = (body: string) => `DTSTART;TZID=${ZONE}:20260513T083000\nRRULE:${body}`;
  it('reads common shapes in plain English', () => {
    expect(describeRecurrence(rule('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR'))).toBe(
      'Every weekday'
    );
    expect(describeRecurrence(rule('FREQ=WEEKLY;BYDAY=SA,SU'))).toBe('Every weekend');
    expect(describeRecurrence(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'))).toBe(
      'Every 2 weeks on Fri'
    );
    expect(describeRecurrence(rule('FREQ=MONTHLY;BYDAY=-1FR'))).toBe('Monthly on the last Fri');
    expect(describeRecurrence(rule('FREQ=MONTHLY;BYMONTHDAY=15'))).toBe('Monthly on day 15');
    expect(describeRecurrence(rule('FREQ=DAILY'))).toBe('Daily');
  });

  it('falls back to "Repeats" for rules it cannot read', () => {
    expect(describeRecurrence('FREQ=DAILY')).toBe('Repeats');
    expect(describeRecurrence(rule('FREQ=SECONDLY'))).toBe('Repeats');
  });
});

describe('weekStrip', () => {
  it('covers Monday to Sunday around the first occurrence and marks each occurrence', () => {
    const strip = weekStrip(
      data({
        occurrences: [
          { start: '2026-05-13T09:00:00-07:00', allDay: false },
          { start: '2026-05-15T09:00:00-07:00', allDay: false },
        ],
      })
    );
    expect(strip.map((d) => d.key)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16',
      '2026-05-17',
    ]);
    expect(strip.filter((d) => d.marked).map((d) => d.day)).toEqual([13, 15]);
    expect(strip.find((d) => d.today)?.key).toBe('2026-05-12');
    expect(strip[0]?.weekday).toBe('M');
  });

  it('falls back to the reference week without occurrences', () => {
    expect(weekStrip(data())[0]?.key).toBe('2026-05-11');
  });
});

describe('dayBar', () => {
  it('spans a same-day range and marks now on the reference day', () => {
    const bar = dayBar(
      { start: '2026-05-12T12:00:00-07:00', end: '2026-05-12T18:00:00-07:00', allDay: false },
      data()
    );
    expect(bar).toEqual({ from: 0.5, to: 0.75, now: 630 / 1440 });
  });

  it('clamps an overnight end to the end of the day and omits now on other days', () => {
    const bar = dayBar(
      { start: '2026-05-13T22:00:00-07:00', end: '2026-05-14T02:00:00-07:00', allDay: false },
      data()
    );
    expect(bar).toEqual({ from: 22 / 24, to: 1 });
  });

  it('fills to midnight for an open end, and skips all-day occurrences', () => {
    expect(
      dayBar({ start: '2026-05-13T18:00:00-07:00', allDay: false, open: 'end' }, data())
    ).toEqual({ from: 0.75, to: 1 });
    expect(dayBar({ start: '2026-05-13', allDay: true }, data())).toBeNull();
    expect(dayBar({ start: 'nope', allDay: false }, data())).toBeNull();
  });
});

describe('formatRange', () => {
  it('reads all-day, open-ended, same-day and cross-day ranges', () => {
    const d = data();
    expect(formatRange({ start: '2026-05-13', allDay: true }, d)).toBe('All day');
    expect(formatRange({ start: '2026-05-13T18:00:00-07:00', allDay: false, open: 'end' }, d)).toBe(
      'after 6:00 PM'
    );
    expect(
      formatRange({ start: '2026-05-13T18:00:00-07:00', allDay: false, open: 'start' }, d)
    ).toBe('before 6:00 PM');
    expect(
      formatRange(
        { start: '2026-05-13T09:00:00-07:00', end: '2026-05-13T10:30:00-07:00', allDay: false },
        d
      )
    ).toBe('9:00 AM – 10:30 AM');
    expect(
      formatRange(
        { start: '2026-05-13T22:00:00-07:00', end: '2026-05-14T02:00:00-07:00', allDay: false },
        d
      )
    ).toBe('10:00 PM – Thu, May 14 2:00 AM');
    expect(formatRange({ start: 'garbage', allDay: false }, d)).toBe('garbage');
  });
});
