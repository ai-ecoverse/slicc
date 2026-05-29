/**
 * `js-realm-helpers.ts` — pure-JS runtime helpers exposed inside `.jsh`
 * and `node -e` realms. These globals (`cli`, `c`, `time`, `fmt`, `pool`)
 * plus `process.argv.parseFlags()` collapse cross-skill boilerplate
 * identified in the workspace spec at `analyze-skills`.
 *
 * The helpers are pure JS — they touch no kernel-side RPC, only the
 * realm's own stdout/stderr writers and the `exit` function. The
 * sandbox-iframe variant in `chrome-extension/sandbox.html` mirrors
 * this surface inline (CSP-isolated bootstrap can't `import` the TS
 * module). The mirror is kept in lockstep via the parity test in
 * `tests/kernel/realm/js-realm-helpers.test.ts`.
 */

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  subcommand: string | null;
  passthrough: string[];
}

/**
 * Parse `process.argv` style flags. Skips `argv[0]` (node) and `argv[1]`
 * (script). Handles `--flag=val`, `--flag val`, `-x` (short → boolean),
 * repeated flags promoting to array, and a trailing `--` separator that
 * routes remaining args into `passthrough` verbatim. `subcommand` is the
 * first positional iff it looks like a bareword (matches `/^[a-z][\w-]*$/i`).
 */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const passthrough: string[] = [];
  const set = (key: string, value: string | boolean): void => {
    if (key in flags) {
      const prev = flags[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else flags[key] = [String(prev), String(value)];
    } else {
      flags[key] = value;
    }
  };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i += 2;
        continue;
      }
      set(body, true);
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) set(ch, true);
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  const subcommand =
    positional.length > 0 && /^[a-z][\w-]*$/i.test(positional[0]) ? positional[0] : null;
  return { positional, flags, subcommand, passthrough };
}

/**
 * Mutate (or return a fresh array) so `argv.parseFlags()` works on the
 * realm's `process.argv`. The method is non-enumerable to keep
 * `[...argv]` / iteration semantics unchanged.
 */
export function attachArgvParseFlags(argv: string[]): string[] {
  const copy = [...argv];
  Object.defineProperty(copy, 'parseFlags', {
    value: () => parseFlags(copy),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy;
}

// ---------------------------------------------------------------------------
// `cli` — stderr/stdout/exit helpers replacing the per-skill die/out/warn/help
// ---------------------------------------------------------------------------

export interface CliDeps {
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
  exit: (code: number) => never;
  color: ColorApi;
}

export interface CliDieOpts {
  exitCode?: number;
  prefix?: string;
}

export interface CliWarnOpts {
  prefix?: string;
}

export interface CliApi {
  die(msg: unknown, opts?: number | CliDieOpts): never;
  out(value: unknown): void;
  warn(msg: unknown, opts?: CliWarnOpts): void;
  help(text: string): never;
}

export function createCli(deps: CliDeps): CliApi {
  const toLine = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    if (v === null || v === undefined) return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const formatPrefixed = (
    color: (s: string) => string,
    prefix: string | undefined,
    text: string
  ): string => {
    if (prefix === undefined) return `${color('Error:')} ${text}\n`;
    if (prefix === '') return `${color(text)}\n`;
    return `${color(`${prefix}:`)} ${text}\n`;
  };
  const formatWarn = (prefix: string | undefined, text: string): string => {
    if (prefix === undefined) return `${deps.color.yellow('Warning:')} ${text}\n`;
    if (prefix === '') return `${deps.color.yellow(text)}\n`;
    return `${deps.color.yellow(`${prefix}:`)} ${text}\n`;
  };
  return {
    die(msg: unknown, opts?: number | CliDieOpts): never {
      const exitCode = typeof opts === 'number' ? opts : (opts?.exitCode ?? 1);
      const customPrefix =
        typeof opts === 'object' && opts !== null && 'prefix' in opts ? opts.prefix : undefined;
      const text = toLine(msg);
      deps.writeStderr(formatPrefixed(deps.color.red, customPrefix, text));
      deps.exit(exitCode);
      throw new Error('unreachable');
    },
    out(value: unknown): void {
      if (typeof value === 'string') {
        deps.writeStdout(value.endsWith('\n') ? value : `${value}\n`);
        return;
      }
      try {
        deps.writeStdout(`${JSON.stringify(value, null, 2)}\n`);
      } catch {
        deps.writeStdout(`${String(value)}\n`);
      }
    },
    warn(msg: unknown, opts?: CliWarnOpts): void {
      const customPrefix =
        typeof opts === 'object' && opts !== null && 'prefix' in opts ? opts.prefix : undefined;
      deps.writeStderr(formatWarn(customPrefix, toLine(msg)));
    },
    help(text: string): never {
      deps.writeStdout(text.endsWith('\n') ? text : `${text}\n`);
      deps.exit(0);
      throw new Error('unreachable');
    },
  };
}

// ---------------------------------------------------------------------------
// `c` — ANSI color helpers; auto-disabled when stdout is not a TTY or
// `NO_COLOR` is set. The closed surface matches the skills survey:
// green / red / yellow / gray / bold / cyan / dim.
// ---------------------------------------------------------------------------

export interface ColorApi {
  enabled: boolean;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  gray(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
}

const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
} as const;

export function createColor(opts: { isTTY: boolean; noColor: boolean }): ColorApi {
  const enabled = opts.isTTY && !opts.noColor;
  const wrap =
    (code: string) =>
    (s: string): string =>
      enabled ? `${code}${s}${ANSI.reset}` : String(s);
  return {
    enabled,
    green: wrap(ANSI.green),
    red: wrap(ANSI.red),
    yellow: wrap(ANSI.yellow),
    gray: wrap(ANSI.gray),
    bold: wrap(ANSI.bold),
    cyan: wrap(ANSI.cyan),
    dim: wrap(ANSI.dim),
  };
}

// ---------------------------------------------------------------------------
// `time` — duration / date helpers. Unit set matches Gmail's search syntax
// (`s|m|h|d|w|M|y`) plus an explicit `ms` form. `m` is **minutes** here
// (the more common interpretation across the surveyed skills); months use
// `M`. This is documented on the realm global so skills don't have to guess.
// ---------------------------------------------------------------------------

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_629_800_000,
  y: 31_557_600_000,
};

export interface TimeApi {
  parseDuration(spec: string | number): number;
  ago(spec: string | number, from?: Date): Date;
  range(spec: string | number, from?: Date): { start: Date; end: Date };
  future(spec: string | number, from?: Date): { start: Date; end: Date };
  gmailDate(spec: string | number, from?: Date): string;
}

function parseDuration(spec: string | number): number {
  if (typeof spec === 'number' && Number.isFinite(spec)) return Math.trunc(spec);
  if (typeof spec !== 'string')
    throw new TypeError('time.parseDuration: spec must be string or number');
  const trimmed = spec.trim();
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d|w|M|y)?$/.exec(trimmed);
  if (!m) throw new RangeError(`time.parseDuration: unrecognized spec "${spec}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms') as keyof typeof DURATION_UNITS_MS;
  return Math.trunc(n * DURATION_UNITS_MS[unit]);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export const time: TimeApi = {
  parseDuration,
  ago(spec, from = new Date()) {
    return new Date(from.getTime() - parseDuration(spec));
  },
  range(spec, from = new Date()) {
    const end = new Date(from.getTime());
    const start = new Date(end.getTime() - parseDuration(spec));
    return { start, end };
  },
  future(spec, from = new Date()) {
    const start = new Date(from.getTime());
    const end = new Date(start.getTime() + parseDuration(spec));
    return { start, end };
  },
  gmailDate(spec, from = new Date()) {
    const d = new Date(from.getTime() - parseDuration(spec));
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  },
};

// ---------------------------------------------------------------------------
// `fmt` — ANSI-aware text formatting helpers.
// ---------------------------------------------------------------------------

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
  // Strip ANSI when truncating; callers that want color preserved in
  // long strings should call `col`/`table` which handle padding only.
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

// ---------------------------------------------------------------------------
// `pool` — bounded concurrency runner. `pool(n, items, fn)` resolves to an
// array of results in input order. `n` is the maximum number of in-flight
// promises; values < 1 are coerced to 1.
// ---------------------------------------------------------------------------

export type PoolFn = <T, R>(
  concurrency: number,
  items: ReadonlyArray<T>,
  fn: (item: T, index: number) => Promise<R> | R
) => Promise<R[]>;

export const pool: PoolFn = async <T, R>(
  concurrency: number,
  items: ReadonlyArray<T>,
  fn: (item: T, index: number) => Promise<R> | R
): Promise<R[]> => {
  const n = Math.max(1, Math.trunc(concurrency) || 1);
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  for (let w = 0; w < Math.min(n, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
};
