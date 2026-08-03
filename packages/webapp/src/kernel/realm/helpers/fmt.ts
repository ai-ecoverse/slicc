const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

export interface FmtApi {
  trunc(s: string, n: number): string;
  col(s: string, width: number): string;
  table(rows: ReadonlyArray<ReadonlyArray<unknown>>, widths?: ReadonlyArray<number>): string;
  date(value: Date | string | number, style?: 'short' | 'iso' | 'human' | 'locale'): string;
}

function trunc(s: string, n: number): string {
  const text = String(s ?? '');
  if (n <= 0) return '';
  if (visibleLength(text) <= n) return text;
  if (n <= 1) return text.slice(0, n);
  const plain = stripAnsi(text);
  return `${plain.slice(0, n - 1)}…`;
}

function col(s: string, width: number): string {
  const text = String(s ?? '');
  const vis = visibleLength(text);
  if (vis === width) return text;
  if (vis > width) return trunc(text, width);
  return text + ' '.repeat(width - vis);
}

function table(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  widths?: ReadonlyArray<number>
): string {
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const computed: number[] = [];
  for (let i = 0; i < colCount; i++) {
    if (widths && widths[i] !== undefined) {
      computed[i] = widths[i];
    } else {
      let max = 0;
      for (const r of rows) {
        const cell = i < r.length ? String(r[i] ?? '') : '';
        max = Math.max(max, visibleLength(cell));
      }
      computed[i] = max;
    }
  }
  return rows
    .map((r) =>
      computed
        .map((w, i) => col(i < r.length ? String(r[i] ?? '') : '', w))
        .join('  ')
        .replace(/\s+$/, '')
    )
    .join('\n');
}

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtDate(
  value: Date | string | number,
  style: 'short' | 'iso' | 'human' | 'locale' = 'short'
): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (style === 'iso') return d.toISOString();
  if (style === 'locale') {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
  }
  if (style === 'human') {
    const diff = Date.now() - d.getTime();
    const abs = Math.abs(diff);
    if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment';
    const tense = (n: number, u: string) =>
      diff >= 0 ? `${n} ${u}${n === 1 ? '' : 's'} ago` : `in ${n} ${u}${n === 1 ? '' : 's'}`;
    if (abs < 3_600_000) return tense(Math.round(abs / 60_000), 'minute');
    if (abs < 86_400_000) return tense(Math.round(abs / 3_600_000), 'hour');
    if (abs < 2_629_800_000) return tense(Math.round(abs / 86_400_000), 'day');
    if (abs < 31_557_600_000) return tense(Math.round(abs / 2_629_800_000), 'month');
    return tense(Math.round(abs / 31_557_600_000), 'year');
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const fmt: FmtApi = { trunc, col, table, date: fmtDate };
