export interface TimeOccurrence {
  start: string;
  end?: string;
  allDay: boolean;

  open?: 'start' | 'end';
}

export interface TimePreviewData {
  text: string;

  reference: string;

  timeZone: string;
  occurrences: TimeOccurrence[];

  rrules: string[];

  locale?: string;
}

export interface WeekStripDay {
  key: string;
  weekday: string;
  day: number;

  marked: boolean;

  today: boolean;
}

export interface DayBar {
  from: number;

  to: number;

  now?: number;
}

const DAY_MS = 86_400_000;

function zonedParts(
  ms: number,
  timeZone: string
): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

export function dayKey(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function occurrenceDay(occurrence: TimeOccurrence, timeZone: string): string | null {
  if (DATE_ONLY.test(occurrence.start)) return occurrence.start;
  const ms = Date.parse(occurrence.start);
  return Number.isNaN(ms) ? null : dayKey(ms, timeZone);
}

export function formatDayKey(key: string, data: TimePreviewData): string {
  return new Intl.DateTimeFormat(data.locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(keyToUtc(key)));
}

function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function addDays(key: string, days: number): string {
  return new Date(keyToUtc(key) + days * DAY_MS).toISOString().slice(0, 10);
}

function isoWeekday(key: string): number {
  return (new Date(keyToUtc(key)).getUTCDay() + 6) % 7;
}

export function relativeLabel(targetMs: number, referenceMs: number, locale?: string): string {
  const diff = targetMs - referenceMs;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * DAY_MS],
    ['month', 30 * DAY_MS],
    ['week', 7 * DAY_MS],
    ['day', DAY_MS],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) {
    const threshold = unit === 'week' ? 2 * size : unit === 'month' ? 2 * size : size;
    if (abs >= threshold) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, 'second');
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `${days} days`;
}

const WEEKDAY_NAMES: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

const ORDINALS: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '-1': 'last',
  '-2': 'second-to-last',
};

function describeByDay(byDay: string[]): string {
  const plain = byDay.map((token) => token.replace(/^[+-]?\d+/, ''));
  const set = new Set(plain);
  if (set.size === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => set.has(d))) return 'weekdays';
  if (set.size === 2 && set.has('SA') && set.has('SU')) return 'weekends';
  return byDay
    .map((token) => {
      const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(token);
      if (!match) return token;
      const name = WEEKDAY_NAMES[match[2] ?? ''] ?? match[2];
      const ordinal = match[1] ? ORDINALS[match[1].replace('+', '')] : undefined;
      return ordinal ? `the ${ordinal} ${name}` : name;
    })
    .join(', ');
}

export function describeRecurrence(rrule: string): string {
  const line = rrule.split(/\r?\n/).find((l) => l.startsWith('RRULE:'));
  if (!line) return 'Repeats';
  const fields = new Map<string, string>();
  for (const pair of line.slice('RRULE:'.length).split(';')) {
    const [key, value] = pair.split('=');
    if (key && value) fields.set(key, value);
  }
  const freq = fields.get('FREQ');
  const interval = Number(fields.get('INTERVAL') ?? '1') || 1;
  const byDay = fields.get('BYDAY')?.split(',') ?? [];
  const byMonthDay = fields.get('BYMONTHDAY');
  const unit: Record<string, [string, string]> = {
    HOURLY: ['Hourly', 'hours'],
    DAILY: ['Daily', 'days'],
    WEEKLY: ['Weekly', 'weeks'],
    MONTHLY: ['Monthly', 'months'],
    YEARLY: ['Yearly', 'years'],
  };
  const names = freq ? unit[freq] : undefined;
  if (!names) return 'Repeats';

  const days = byDay.length ? describeByDay(byDay) : '';
  if (freq === 'WEEKLY' && interval === 1 && (days === 'weekdays' || days === 'weekends')) {
    return `Every ${days.slice(0, -1)}`;
  }
  const head = interval === 1 ? names[0] : `Every ${interval} ${names[1]}`;
  if (days) return `${head} on ${days}`;
  if (byMonthDay) return `${head} on day ${byMonthDay}`;
  return head;
}

export function weekStrip(data: TimePreviewData): WeekStripDay[] {
  const refMs = Date.parse(data.reference);
  const today = Number.isNaN(refMs) ? '' : dayKey(refMs, data.timeZone);
  const first = data.occurrences[0] ? occurrenceDay(data.occurrences[0], data.timeZone) : null;
  const anchor = first ?? (today || dayKey(Date.now(), data.timeZone));
  const monday = addDays(anchor, -isoWeekday(anchor));
  const marked = new Set(
    data.occurrences
      .map((occ) => occurrenceDay(occ, data.timeZone))
      .filter((key): key is string => key !== null)
  );
  const weekdayFmt = new Intl.DateTimeFormat(data.locale, { weekday: 'narrow', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(monday, i);
    return {
      key,
      weekday: weekdayFmt.format(new Date(keyToUtc(key))),
      day: Number(key.slice(8, 10)),
      marked: marked.has(key),
      today: key === today,
    };
  });
}

export function dayBar(occurrence: TimeOccurrence, data: TimePreviewData): DayBar | null {
  if (occurrence.allDay) return null;
  const startMs = Date.parse(occurrence.start);
  if (Number.isNaN(startMs)) return null;
  const start = zonedParts(startMs, data.timeZone);
  const startKey = dayKey(startMs, data.timeZone);
  const from = start.minutes / 1440;
  let to = from;
  const endMs = occurrence.end ? Date.parse(occurrence.end) : Number.NaN;
  if (!Number.isNaN(endMs) && endMs > startMs) {
    to =
      dayKey(endMs, data.timeZone) === startKey
        ? zonedParts(endMs, data.timeZone).minutes / 1440
        : 1;
  } else if (occurrence.open === 'end') {
    to = 1;
  }
  const bar: DayBar = { from, to };
  const refMs = Date.parse(data.reference);
  if (!Number.isNaN(refMs) && dayKey(refMs, data.timeZone) === startKey) {
    bar.now = zonedParts(refMs, data.timeZone).minutes / 1440;
  }
  return bar;
}

export function formatDay(ms: number, data: TimePreviewData): string {
  return new Intl.DateTimeFormat(data.locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: data.timeZone,
  }).format(new Date(ms));
}

export function formatClock(ms: number, data: TimePreviewData): string {
  return new Intl.DateTimeFormat(data.locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: data.timeZone,
  }).format(new Date(ms));
}

export function formatRange(occurrence: TimeOccurrence, data: TimePreviewData): string {
  if (occurrence.allDay) return 'All day';
  const startMs = Date.parse(occurrence.start);
  if (Number.isNaN(startMs)) return occurrence.start;
  const start = formatClock(startMs, data);
  if (occurrence.open === 'end') return `after ${start}`;
  if (occurrence.open === 'start') return `before ${start}`;
  const endMs = occurrence.end ? Date.parse(occurrence.end) : Number.NaN;
  if (Number.isNaN(endMs)) return start;
  const sameDay = dayKey(startMs, data.timeZone) === dayKey(endMs, data.timeZone);
  const end = sameDay
    ? formatClock(endMs, data)
    : `${formatDay(endMs, data)} ${formatClock(endMs, data)}`;
  return `${start} – ${end}`;
}
