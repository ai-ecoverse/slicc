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
 *
 * `nodeCrypto.createHash` and `nodeZlib` bridge to dependency-light
 * pure-JS libraries (`js-md5` / `js-sha1` / `js-sha256` and `pako`).
 * The worker float imports them directly (bundled by Vite); the iframe
 * float reaches the same libraries through the `realm-vendor.js` IIFE
 * (`globalThis.__sliccRealmVendor`) loaded by `sandbox.html`.
 */

import { md5 } from 'js-md5';
import { sha1 } from 'js-sha1';
import { sha256 } from 'js-sha256';
import * as pako from 'pako';

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

// ---------------------------------------------------------------------------
// `nodePath` — the Node `path` built-in (POSIX semantics) served by the realm
// `require('path')` / `require('node:path')` shim. The CJS require hard-switch
// (architecture 4.4, 6) means every realm `require()` resolves from the
// host-built ipk module graph; `path` is implemented inline here so the
// graph can serve it without a `node_modules` install, and mirrored inline in
// `chrome-extension/sandbox.html` (parity test in
// `tests/kernel/realm/js-realm-helpers.test.ts`). POSIX-only: separator is
// always `/`, mirroring the VFS.
// ---------------------------------------------------------------------------

export interface NodePathParsed {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export interface NodePath {
  sep: '/';
  delimiter: ':';
  basename(path: string, ext?: string): string;
  dirname(path: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...parts: string[]): string;
  normalize(path: string): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  parse(path: string): NodePathParsed;
  format(parsed: Partial<NodePathParsed>): string;
}

function posixNormalizeArray(parts: string[], allowAboveRoot: boolean): string[] {
  const res: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (res.length > 0 && res[res.length - 1] !== '..') res.pop();
      else if (allowAboveRoot) res.push('..');
    } else {
      res.push(part);
    }
  }
  return res;
}

function pathNormalize(path: string): string {
  if (path.length === 0) return '.';
  const isAbsolute = path.charCodeAt(0) === 47; // '/'
  const trailingSep = path.charCodeAt(path.length - 1) === 47;
  let normalized = posixNormalizeArray(path.split('/'), !isAbsolute).join('/');
  if (normalized.length === 0 && !isAbsolute) normalized = '.';
  if (normalized.length > 0 && trailingSep) normalized += '/';
  return (isAbsolute ? '/' : '') + normalized;
}

function pathJoin(...parts: string[]): string {
  const joined = parts.filter((p) => typeof p === 'string' && p.length > 0).join('/');
  if (joined.length === 0) return '.';
  return pathNormalize(joined);
}

function pathDirname(path: string): string {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

function pathBasename(path: string, ext?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  const base = end === -1 ? '' : path.slice(start, end);
  if (ext && base.endsWith(ext) && base !== ext) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}

function pathExtname(path: string): string {
  const base = pathBasename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function pathResolve(...parts: string[]): string {
  let resolved = '';
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= 0 && !isAbsolute; i--) {
    const part = parts[i];
    if (typeof part !== 'string' || part.length === 0) continue;
    resolved = resolved.length > 0 ? `${part}/${resolved}` : part;
    isAbsolute = part.charCodeAt(0) === 47;
  }
  if (!isAbsolute) resolved = resolved.length > 0 ? `/${resolved}` : '/';
  const normalized = posixNormalizeArray(resolved.split('/'), false).join('/');
  return normalized.length > 0 ? `/${normalized}` : '/';
}

function pathRelative(from: string, to: string): string {
  const fromAbs = pathResolve(from);
  const toAbs = pathResolve(to);
  if (fromAbs === toAbs) return '';
  const fromParts = fromAbs.split('/').filter(Boolean);
  const toParts = toAbs.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => '..');
  return [...up, ...toParts.slice(i)].join('/');
}

function pathParse(path: string): NodePathParsed {
  const root = path.charCodeAt(0) === 47 ? '/' : '';
  const base = pathBasename(path);
  const ext = pathExtname(path);
  const name = ext ? base.slice(0, base.length - ext.length) : base;
  let dir = pathDirname(path);
  if (dir === '.' && root === '') dir = '';
  return { root, dir, base, ext, name };
}

function pathFormat(parsed: Partial<NodePathParsed>): string {
  const dir = parsed.dir || parsed.root || '';
  const base = parsed.base || `${parsed.name || ''}${parsed.ext || ''}`;
  if (!dir) return base;
  if (dir === parsed.root) return `${dir}${base}`;
  return `${dir}/${base}`;
}

export const nodePath: NodePath = {
  sep: '/',
  delimiter: ':',
  basename: pathBasename,
  dirname: pathDirname,
  extname: pathExtname,
  isAbsolute: (path) => path.length > 0 && path.charCodeAt(0) === 47,
  join: pathJoin,
  normalize: pathNormalize,
  resolve: pathResolve,
  relative: pathRelative,
  parse: pathParse,
  format: pathFormat,
};

// ---------------------------------------------------------------------------
// `nodeCrypto` — the subset of the Node `crypto` built-in served by the realm
// `require('crypto')` / `require('node:crypto')` shim, mirroring the `nodePath`
// precedent. Every operation is backed by `globalThis.crypto` (Web Crypto), so
// it is dependency-free and works in BOTH realm floats — including the
// opaque-origin iframe float where `crypto.randomUUID`/`crypto.subtle` are
// secure-context-gated (hence the `getRandomValues`-based UUID fallback). Only
// the subset with a Web Crypto equivalent is exposed; no Node-only primitives.
// Mirrored inline in `chrome-extension/sandbox.html` (parity test in
// `tests/kernel/realm/js-realm-helpers.test.ts`).
// ---------------------------------------------------------------------------

// Web Crypto `getRandomValues` rejects requests larger than 65536 bytes, so a
// large buffer must be filled in chunks of at most this size.
const MAX_RANDOM_BYTES = 65536;

export interface NodeHash {
  update(data: string | ArrayBufferView | ArrayBuffer, inputEncoding?: string): NodeHash;
  digest(): Uint8Array;
  digest(encoding: string): string;
}

export interface NodeCrypto {
  randomFillSync<T extends ArrayBufferView>(buffer: T, offset?: number, size?: number): T;
  randomBytes(size: number): Uint8Array;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  createHash(algorithm: string): NodeHash;
  readonly webcrypto: Crypto;
  readonly subtle: SubtleCrypto;
}

// `createHash` — the synchronous subset of Node `crypto.createHash`, backed by
// the pure-JS `js-md5` / `js-sha1` / `js-sha256` hashers (Web Crypto's
// `subtle.digest` is async and lacks md5, so it cannot serve the sync API).
// Mirrored inline in `chrome-extension/sandbox.html` against the
// `globalThis.__sliccRealmVendor` hashers.
interface IncrementalHasher {
  update(message: string | number[] | ArrayBuffer | Uint8Array): IncrementalHasher;
  array(): number[];
}
type HasherFactory = { create(): IncrementalHasher };

const HASH_FACTORIES: Record<string, HasherFactory> = {
  md5: md5 as unknown as HasherFactory,
  sha1: sha1 as unknown as HasherFactory,
  sha256: sha256 as unknown as HasherFactory,
};

function bufferFrom(
  value: ArrayBuffer | Uint8Array | number[] | string,
  encoding?: string
): Buffer {
  const B = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (!B) throw new Error('crypto.createHash: Buffer is unavailable in this environment');
  return encoding ? B.from(value as string, encoding as BufferEncoding) : B.from(value as never);
}

function hashInput(
  data: string | ArrayBufferView | ArrayBuffer,
  inputEncoding?: string
): string | number[] | ArrayBuffer | Uint8Array {
  if (typeof data !== 'string') {
    return ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data;
  }
  if (
    inputEncoding === 'hex' ||
    inputEncoding === 'base64' ||
    inputEncoding === 'base64url' ||
    inputEncoding === 'latin1' ||
    inputEncoding === 'binary'
  ) {
    return new Uint8Array(bufferFrom(data, inputEncoding === 'binary' ? 'latin1' : inputEncoding));
  }
  return data;
}

function createHash(algorithm: string): NodeHash {
  const key = String(algorithm).toLowerCase().replace('-', '');
  const factory = HASH_FACTORIES[key];
  if (!factory) throw new Error(`Digest method not supported: ${algorithm}`);
  const hasher = factory.create();
  let finalized = false;
  const hash: NodeHash = {
    update(data, inputEncoding) {
      if (finalized) throw new Error('Digest already called');
      hasher.update(hashInput(data, inputEncoding));
      return hash;
    },
    digest(encoding?: string): never {
      finalized = true;
      const buf = bufferFrom(hasher.array());
      return (encoding ? buf.toString(encoding as BufferEncoding) : buf) as never;
    },
  };
  return hash;
}

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto: globalThis.crypto is unavailable in this environment');
  }
  return c;
}

// Web Crypto's `getRandomValues` is typed for `ArrayBufferView<ArrayBuffer>`;
// our byte views can carry an `ArrayBufferLike` (e.g. derived from a passed-in
// buffer), so funnel every call through this cast in one place.
function secureRandomValues<T extends ArrayBufferView>(view: T): T {
  return webCrypto().getRandomValues(view as ArrayBufferView<ArrayBuffer>) as T;
}

function fillRandomBytes(view: Uint8Array): void {
  for (let offset = 0; offset < view.length; offset += MAX_RANDOM_BYTES) {
    const end = Math.min(offset + MAX_RANDOM_BYTES, view.length);
    secureRandomValues(view.subarray(offset, end));
  }
}

function asByteView(buffer: ArrayBufferView): Uint8Array {
  return buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

const HEX_BYTES: string[] = Array.from({ length: 256 }, (_, i) =>
  (i + 0x100).toString(16).slice(1)
);

function cryptoRandomUUID(): string {
  const c = webCrypto();
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC 4122 v4 fallback (no secure-context dependency, so the opaque-origin
  // iframe float — where `crypto.randomUUID` is undefined — still works).
  const b = secureRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return (
    `${HEX_BYTES[b[0]]}${HEX_BYTES[b[1]]}${HEX_BYTES[b[2]]}${HEX_BYTES[b[3]]}` +
    `-${HEX_BYTES[b[4]]}${HEX_BYTES[b[5]]}` +
    `-${HEX_BYTES[b[6]]}${HEX_BYTES[b[7]]}` +
    `-${HEX_BYTES[b[8]]}${HEX_BYTES[b[9]]}` +
    `-${HEX_BYTES[b[10]]}${HEX_BYTES[b[11]]}${HEX_BYTES[b[12]]}${HEX_BYTES[b[13]]}${HEX_BYTES[b[14]]}${HEX_BYTES[b[15]]}`
  );
}

export const nodeCrypto: NodeCrypto = {
  randomFillSync<T extends ArrayBufferView>(buffer: T, offset = 0, size?: number): T {
    const bytes = asByteView(buffer);
    const start = offset;
    const end = size === undefined ? bytes.length : start + size;
    fillRandomBytes(bytes.subarray(start, end));
    return buffer;
  },
  randomBytes(size: number): Uint8Array {
    const BufferCtor = (globalThis as { Buffer?: { allocUnsafe?: (n: number) => Uint8Array } })
      .Buffer;
    const buf =
      BufferCtor && typeof BufferCtor.allocUnsafe === 'function'
        ? BufferCtor.allocUnsafe(size)
        : new Uint8Array(size);
    fillRandomBytes(asByteView(buf));
    return buf;
  },
  randomUUID: cryptoRandomUUID,
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    return secureRandomValues(array);
  },
  createHash,
  get webcrypto(): Crypto {
    return webCrypto();
  },
  get subtle(): SubtleCrypto {
    return webCrypto().subtle;
  },
};

// ---------------------------------------------------------------------------
// `nodeAssert` — the subset of the Node `assert` built-in served by the realm
// `require('assert')` / `require('node:assert')` / `require('assert/strict')`
// shim, mirroring the `nodePath` / `nodeCrypto` precedent. Pure JS,
// dependency-free; works in BOTH realm floats. Common npm packages carry a
// transitive `require('assert')`; without this shim those packages would
// hard-fail with the browser-unavailable message. Mirrored inline in
// `chrome-extension/sandbox.html` (parity test in
// `tests/kernel/realm/js-realm-helpers.test.ts`).
// ---------------------------------------------------------------------------

export class NodeAssertionError extends Error {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;
  readonly code: 'ERR_ASSERTION';
  constructor(
    opts: {
      message?: string;
      actual?: unknown;
      expected?: unknown;
      operator?: string;
    } = {}
  ) {
    const generated = !opts.message;
    super(
      opts.message ||
        `${stringifyOperand(opts.actual)} ${opts.operator || '!='} ${stringifyOperand(opts.expected)}`
    );
    this.name = 'AssertionError';
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator || '';
    this.generatedMessage = generated;
    this.code = 'ERR_ASSERTION';
  }
}

function stringifyOperand(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toAssertError(
  message: string | Error | undefined,
  fallback: () => NodeAssertionError
): Error {
  if (message instanceof Error) return message;
  if (typeof message === 'string') return new NodeAssertionError({ message });
  return fallback();
}

function deepEqArray(a: unknown[], b: unknown[], strict: boolean, seen: WeakMap<object, object>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], strict, seen)) return false;
  return true;
}

function deepEqObject(ao: object, bo: object, strict: boolean, seen: WeakMap<object, object>) {
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    const av = (ao as Record<string, unknown>)[k];
    const bv = (bo as Record<string, unknown>)[k];
    if (!deepEq(av, bv, strict, seen)) return false;
  }
  return true;
}

function deepEq(a: unknown, b: unknown, strict: boolean, seen: WeakMap<object, object>): boolean {
  if (strict ? Object.is(a, b) : a === b) return true;
  // biome-ignore lint/suspicious/noDoubleEquals: assert.deepEqual is Node-faithful loose compare.
  if (!strict && a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ao = a as object;
  const bo = b as object;
  if (strict && Object.getPrototypeOf(ao) !== Object.getPrototypeOf(bo)) return false;
  if (seen.get(ao) === bo) return true;
  seen.set(ao, bo);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return deepEqArray(a, b, strict, seen);
  return deepEqObject(ao, bo, strict, seen);
}

function matchThrownFunction(err: unknown, expected: (e: unknown) => unknown): boolean {
  try {
    if (err instanceof (expected as unknown as new (...a: unknown[]) => unknown)) return true;
  } catch {
    // expected is not a class — fall through to predicate
  }
  try {
    return Boolean(expected(err));
  } catch {
    return false;
  }
}

function matchThrownShape(err: object, expected: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const ev = (err as Record<string, unknown>)[k];
    if (v instanceof RegExp) {
      if (typeof ev !== 'string' || !v.test(ev)) return false;
    } else if (ev !== v) {
      return false;
    }
  }
  return true;
}

function matchThrown(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) {
    const msg = err instanceof Error ? err.message : String(err);
    return expected.test(msg);
  }
  if (typeof expected === 'function')
    return matchThrownFunction(err, expected as (e: unknown) => unknown);
  if (expected && typeof expected === 'object') {
    if (!err || typeof err !== 'object') return false;
    return matchThrownShape(err, expected as Record<string, unknown>);
  }
  return false;
}

export interface NodeAssert {
  (value: unknown, message?: string | Error): void;
  ok(value: unknown, message?: string | Error): void;
  equal(actual: unknown, expected: unknown, message?: string | Error): void;
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  throws(block: () => unknown, error?: unknown, message?: string | Error): void;
  doesNotThrow(block: () => unknown, message?: string | Error): void;
  fail(message?: string | Error): never;
  AssertionError: typeof NodeAssertionError;
  strict: NodeAssert;
}

function buildAssert(strictMode: boolean): NodeAssert {
  const ok = (value: unknown, message?: string | Error): void => {
    if (value) return;
    throw toAssertError(
      message,
      () =>
        new NodeAssertionError({
          message: 'The expression evaluated to a falsy value',
          actual: value,
          expected: true,
          operator: '==',
        })
    );
  };
  const callable = ((value: unknown, message?: string | Error): void =>
    ok(value, message)) as NodeAssert;
  const strictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (Object.is(actual, expected)) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'strictEqual' })
    );
  };
  const equal = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      strictEqual(actual, expected, message);
      return;
    }
    // biome-ignore lint/suspicious/noDoubleEquals: assert.equal is Node-faithful loose compare.
    if (actual == expected) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: '==' })
    );
  };
  const notStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (!Object.is(actual, expected)) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notStrictEqual' })
    );
  };
  const notEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      notStrictEqual(actual, expected, message);
      return;
    }
    // biome-ignore lint/suspicious/noDoubleEquals: assert.notEqual is Node-faithful loose compare.
    if (actual != expected) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: '!=' })
    );
  };
  const deepStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (deepEq(actual, expected, true, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'deepStrictEqual' })
    );
  };
  const deepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      deepStrictEqual(actual, expected, message);
      return;
    }
    if (deepEq(actual, expected, false, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'deepEqual' })
    );
  };
  const notDeepStrictEqual = (
    actual: unknown,
    expected: unknown,
    message?: string | Error
  ): void => {
    if (!deepEq(actual, expected, true, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notDeepStrictEqual' })
    );
  };
  const notDeepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      notDeepStrictEqual(actual, expected, message);
      return;
    }
    if (!deepEq(actual, expected, false, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notDeepEqual' })
    );
  };
  const throws = (block: () => unknown, errorOrMsg?: unknown, message?: string | Error): void => {
    let thrown: unknown;
    let didThrow = false;
    try {
      block();
    } catch (e) {
      thrown = e;
      didThrow = true;
    }
    if (!didThrow) {
      throw toAssertError(
        typeof errorOrMsg === 'string' ? errorOrMsg : message,
        () => new NodeAssertionError({ message: 'Missing expected exception', operator: 'throws' })
      );
    }
    const isMsgOnly = typeof errorOrMsg === 'string' || errorOrMsg instanceof Error;
    if (!isMsgOnly && !matchThrown(thrown, errorOrMsg)) {
      throw toAssertError(
        message,
        () =>
          new NodeAssertionError({
            message: 'Got unwanted exception',
            actual: thrown,
            operator: 'throws',
          })
      );
    }
  };
  const doesNotThrow = (block: () => unknown, message?: string | Error): void => {
    try {
      block();
    } catch (e) {
      throw toAssertError(
        message,
        () =>
          new NodeAssertionError({
            message: 'Got unwanted exception',
            actual: e,
            operator: 'doesNotThrow',
          })
      );
    }
  };
  const fail = (message?: string | Error): never => {
    throw toAssertError(
      message,
      () => new NodeAssertionError({ message: 'Failed', operator: 'fail' })
    );
  };
  callable.ok = ok;
  callable.equal = equal;
  callable.notEqual = notEqual;
  callable.strictEqual = strictEqual;
  callable.notStrictEqual = notStrictEqual;
  callable.deepEqual = deepEqual;
  callable.deepStrictEqual = deepStrictEqual;
  callable.notDeepEqual = notDeepEqual;
  callable.notDeepStrictEqual = notDeepStrictEqual;
  callable.throws = throws;
  callable.doesNotThrow = doesNotThrow;
  callable.fail = fail;
  callable.AssertionError = NodeAssertionError;
  return callable;
}

export const nodeAssertStrict: NodeAssert = buildAssert(true);
nodeAssertStrict.strict = nodeAssertStrict;
export const nodeAssert: NodeAssert = buildAssert(false);
nodeAssert.strict = nodeAssertStrict;

// ---------------------------------------------------------------------------
// `nodeUtil` — the subset of the Node `util` built-in served by the realm
// `require('util')` / `require('node:util')` shim, mirroring the `nodePath` /
// `nodeAssert` precedent. Pure JS, dependency-free; works in BOTH realm floats.
// Many npm packages (cowsay, debug, …) carry a transitive `require('util')`
// for `format` / `inspect` / `inherits` / `promisify`; without this shim they
// would hard-fail the browser-unavailable throw. Mirrored inline in
// `chrome-extension/sandbox.html` (parity test in
// `tests/kernel/realm/js-realm-helpers.test.ts`).
// ---------------------------------------------------------------------------

const UTIL_INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const UTIL_PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

export interface NodeInspectOptions {
  depth?: number | null;
}

interface InspectCtx {
  seen: Set<unknown>;
  maxDepth: number | null;
  opts: NodeInspectOptions;
}

function inspectQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function inspectPrimitive(val: unknown): string | null {
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'string') return inspectQuote(val as string);
  if (t === 'number') return Object.is(val, -0) ? '-0' : String(val);
  if (t === 'bigint') return `${String(val)}n`;
  if (t === 'boolean' || t === 'undefined') return String(val);
  if (t === 'symbol') return (val as symbol).toString();
  if (t === 'function') {
    const name = (val as { name?: string }).name;
    return name ? `[Function: ${name}]` : '[Function (anonymous)]';
  }
  return null;
}

function inspectSpecialObject(val: object): string | null {
  if (val instanceof RegExp) return val.toString();
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
  }
  if (val instanceof Error) {
    return val.stack || `${val.name}: ${val.message}`;
  }
  return null;
}

function inspectContainer(
  obj: Record<PropertyKey, unknown>,
  depth: number,
  ctx: InspectCtx
): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[ ${obj.map((v) => inspectValue(v, depth + 1, ctx)).join(', ')} ]`;
  }
  if (obj instanceof Map) {
    const items = [...obj].map(
      ([k, v]) => `${inspectValue(k, depth + 1, ctx)} => ${inspectValue(v, depth + 1, ctx)}`
    );
    return `Map(${obj.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
  }
  if (obj instanceof Set) {
    const items = [...obj].map((v) => inspectValue(v, depth + 1, ctx));
    return `Set(${obj.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
  }
  const keys = Object.keys(obj);
  const ctorName = obj.constructor ? obj.constructor.name : '';
  const prefix = ctorName && ctorName !== 'Object' ? `${ctorName} ` : '';
  if (keys.length === 0) return `${prefix}{}`;
  const items = keys.map((k) => {
    const label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : inspectQuote(k);
    return `${label}: ${inspectValue(obj[k], depth + 1, ctx)}`;
  });
  return `${prefix}{ ${items.join(', ')} }`;
}

function inspectValue(val: unknown, depth: number, ctx: InspectCtx): string {
  const prim = inspectPrimitive(val);
  if (prim !== null) return prim;
  const obj = val as Record<PropertyKey, unknown>;
  const special = inspectSpecialObject(obj as object);
  if (special !== null) return special;
  const custom = (obj as Record<symbol, unknown>)[UTIL_INSPECT_CUSTOM];
  if (typeof custom === 'function') {
    try {
      return String((custom as Function).call(obj, ctx.maxDepth, ctx.opts));
    } catch {
      // Fall through to structural inspection when a custom inspector throws.
    }
  }
  if (ctx.seen.has(val)) return '[Circular *1]';
  if (ctx.maxDepth !== null && depth > ctx.maxDepth) {
    return Array.isArray(val) ? '[Array]' : '[Object]';
  }
  ctx.seen.add(val);
  try {
    return inspectContainer(obj, depth, ctx);
  } finally {
    ctx.seen.delete(val);
  }
}

function nodeInspect(value: unknown, opts: NodeInspectOptions = {}): string {
  const maxDepth = opts.depth === undefined ? 2 : opts.depth;
  return inspectValue(value, 0, { seen: new Set(), maxDepth, opts });
}

function formatToken(
  token: string,
  args: unknown[],
  state: { i: number },
  opts: NodeInspectOptions
): string {
  if (token === '%%') return '%';
  if (state.i >= args.length) return token;
  const arg = args[state.i];
  switch (token) {
    case '%s':
      state.i++;
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      if (
        arg === null ||
        arg === undefined ||
        typeof arg === 'number' ||
        typeof arg === 'boolean'
      ) {
        return String(arg);
      }
      return nodeInspect(arg, { depth: opts.depth === undefined ? 2 : opts.depth });
    case '%d':
      state.i++;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      return Number.isNaN(Number(arg)) ? 'NaN' : String(Number(arg));
    case '%i':
      state.i++;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      return String(Number.parseInt(arg as string, 10));
    case '%f':
      state.i++;
      if (typeof arg === 'bigint') return String(arg);
      return String(Number.parseFloat(arg as string));
    case '%j':
      state.i++;
      try {
        return JSON.stringify(arg) ?? 'undefined';
      } catch {
        return '[Circular]';
      }
    case '%o':
      state.i++;
      return nodeInspect(arg, { depth: 4 });
    case '%O':
      state.i++;
      return nodeInspect(arg, { depth: null });
    case '%c':
      state.i++;
      return '';
    default:
      return token;
  }
}

function nodeFormatWithOptions(opts: NodeInspectOptions, ...args: unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string') {
    return args.map((a) => (typeof a === 'string' ? a : nodeInspect(a))).join(' ');
  }
  const state = { i: 1 };
  let str = first.replace(/%[sdifjoOc%]/g, (token) => formatToken(token, args, state, opts));
  for (; state.i < args.length; state.i++) {
    const a = args[state.i];
    str += ` ${typeof a === 'string' ? a : nodeInspect(a)}`;
  }
  return str;
}

function nodeFormat(...args: unknown[]): string {
  return nodeFormatWithOptions({}, ...args);
}

function nodeInherits(ctor: Function, superCtor: Function): void {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The constructor to "inherits" must not be null or undefined');
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The super constructor to "inherits" must not be null or undefined');
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The super constructor to "inherits" must have a prototype');
  }
  (ctor as { super_?: unknown }).super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

function nodePromisify(original: Function): Function {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type function');
  }
  const custom = (original as Function & { [UTIL_PROMISIFY_CUSTOM]?: Function })[
    UTIL_PROMISIFY_CUSTOM
  ];
  if (custom) {
    if (typeof custom !== 'function') {
      throw new TypeError('The [util.promisify.custom] property must be of type function');
    }
    return custom;
  }
  function fn(this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      (original as (...a: unknown[]) => unknown).call(
        this,
        ...args,
        (err: unknown, ...values: unknown[]) => {
          if (err) {
            reject(err as Error);
            return;
          }
          resolve(values.length > 1 ? values : values[0]);
        }
      );
    });
  }
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  return fn;
}

export interface NodeUtil {
  format(...args: unknown[]): string;
  formatWithOptions(opts: NodeInspectOptions, ...args: unknown[]): string;
  inspect: { (value: unknown, opts?: NodeInspectOptions): string; custom: symbol };
  inherits(ctor: Function, superCtor: Function): void;
  promisify: { (original: Function): Function; custom: symbol };
}

const utilInspect = nodeInspect as NodeUtil['inspect'];
utilInspect.custom = UTIL_INSPECT_CUSTOM;
const utilPromisify = nodePromisify as NodeUtil['promisify'];
utilPromisify.custom = UTIL_PROMISIFY_CUSTOM;

export const nodeUtil: NodeUtil = {
  format: nodeFormat,
  formatWithOptions: nodeFormatWithOptions,
  inspect: utilInspect,
  inherits: nodeInherits,
  promisify: utilPromisify,
};

// ---------------------------------------------------------------------------
// `nodeZlib` — the subset of the Node `zlib` built-in served by the realm
// `require('zlib')` / `require('node:zlib')` shim, backed by `pako` (pure JS,
// no Node-only bindings). Covers the sync (`*Sync`) and Node-style callback
// (`(buf, [opts], cb)`) forms of deflate/inflate/gzip/gunzip (+ the raw
// variants). Streaming classes (`createGzip`, …) are intentionally omitted —
// the realm has no Node stream layer. Mirrored inline in
// `chrome-extension/sandbox.html` against `globalThis.__sliccRealmVendor.pako`.
// ---------------------------------------------------------------------------

type ZlibInput = string | ArrayBufferView | ArrayBuffer;
interface ZlibOptions {
  level?: number;
  windowBits?: number;
  memLevel?: number;
  strategy?: number;
}
type PakoFn = (data: Uint8Array, opts?: Record<string, unknown>) => Uint8Array;
type ZlibCallback = (error: Error | null, result?: Buffer) => void;

function zlibToBytes(data: ZlibInput): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(bufferFrom(data, 'utf8'));
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

function zlibPakoOpts(opts?: ZlibOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts) {
    if (typeof opts.level === 'number') out['level'] = opts.level;
    if (typeof opts.windowBits === 'number') out['windowBits'] = opts.windowBits;
    if (typeof opts.memLevel === 'number') out['memLevel'] = opts.memLevel;
    if (typeof opts.strategy === 'number') out['strategy'] = opts.strategy;
  }
  return out;
}

function zlibSync(fn: PakoFn, data: ZlibInput, opts?: ZlibOptions): Buffer {
  return bufferFrom(fn(zlibToBytes(data), zlibPakoOpts(opts)));
}

function zlibAsync(
  fn: PakoFn,
  data: ZlibInput,
  optsOrCb: ZlibOptions | ZlibCallback | undefined,
  maybeCb?: ZlibCallback
): void {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ZlibCallback | undefined;
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
  if (typeof cb !== 'function') throw new TypeError('zlib: callback is required');
  let result: Buffer;
  try {
    result = zlibSync(fn, data, opts);
  } catch (err) {
    queueMicrotask(() => cb(err instanceof Error ? err : new Error(String(err))));
    return;
  }
  queueMicrotask(() => cb(null, result));
}

export interface NodeZlib {
  gzipSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  gunzipSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  deflateSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  inflateSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  deflateRawSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  inflateRawSync(data: ZlibInput, opts?: ZlibOptions): Buffer;
  gzip(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  gunzip(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  deflate(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  inflate(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  deflateRaw(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  inflateRaw(data: ZlibInput, optsOrCb: ZlibOptions | ZlibCallback, cb?: ZlibCallback): void;
  constants: Record<string, number>;
}

export const nodeZlib: NodeZlib = {
  gzipSync: (data, opts) => zlibSync(pako.gzip as PakoFn, data, opts),
  gunzipSync: (data, opts) => zlibSync(pako.ungzip as PakoFn, data, opts),
  deflateSync: (data, opts) => zlibSync(pako.deflate as PakoFn, data, opts),
  inflateSync: (data, opts) => zlibSync(pako.inflate as PakoFn, data, opts),
  deflateRawSync: (data, opts) => zlibSync(pako.deflateRaw as PakoFn, data, opts),
  inflateRawSync: (data, opts) => zlibSync(pako.inflateRaw as PakoFn, data, opts),
  gzip: (data, optsOrCb, cb) => zlibAsync(pako.gzip as PakoFn, data, optsOrCb, cb),
  gunzip: (data, optsOrCb, cb) => zlibAsync(pako.ungzip as PakoFn, data, optsOrCb, cb),
  deflate: (data, optsOrCb, cb) => zlibAsync(pako.deflate as PakoFn, data, optsOrCb, cb),
  inflate: (data, optsOrCb, cb) => zlibAsync(pako.inflate as PakoFn, data, optsOrCb, cb),
  deflateRaw: (data, optsOrCb, cb) => zlibAsync(pako.deflateRaw as PakoFn, data, optsOrCb, cb),
  inflateRaw: (data, optsOrCb, cb) => zlibAsync(pako.inflateRaw as PakoFn, data, optsOrCb, cb),
  constants: {
    Z_NO_FLUSH: 0,
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
  },
};

// ---------------------------------------------------------------------------
// `nodeOs` — the subset of the Node `os` built-in served by the realm
// `require('os')` / `require('node:os')` shim. Pure JS, dependency-free;
// works in BOTH realm floats. Returns static values appropriate for the
// browser-based POSIX VFS environment. Mirrored inline in
// `chrome-extension/sandbox.html`.
// ---------------------------------------------------------------------------

export interface NodeOs {
  tmpdir(): string;
  homedir(): string;
  platform: string;
  arch: string;
  EOL: string;
  cpus(): { model: string; speed: number }[];
  hostname(): string;
  type(): string;
  release(): string;
}

export const nodeOs: NodeOs = {
  tmpdir: () => '/tmp',
  homedir: () => '/home/user',
  platform: 'linux',
  arch: 'x64',
  EOL: '\n',
  cpus: () => [{ model: 'virtual', speed: 0 }],
  hostname: () => 'slicc',
  type: () => 'Linux',
  release: () => '0.0.0',
};

// ---------------------------------------------------------------------------
// `nodeUrl` — the subset of the Node `url` built-in served by the realm
// `require('url')` / `require('node:url')` shim. Bridges `fileURLToPath` and
// `pathToFileURL` (used by 5 audited .mjs files) plus re-exports the browser's
// native URL/URLSearchParams. Mirrored inline in `chrome-extension/sandbox.html`.
// ---------------------------------------------------------------------------

export interface NodeUrl {
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  fileURLToPath(url: string | URL): string;
  pathToFileURL(path: string): URL;
}

function fileURLToPath(url: string | URL): string {
  const str = typeof url === 'string' ? url : url.href;
  if (!str.startsWith('file://')) throw new TypeError('fileURLToPath: not a file URL');
  const pathname = str.slice('file://'.length);
  return decodeURIComponent(pathname);
}

function pathToFileURL(path: string): URL {
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return new URL(`file://${encoded}`);
}

export const nodeUrl: NodeUrl = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath,
  pathToFileURL,
};

// ---------------------------------------------------------------------------
// `nodeEvents` — minimal EventEmitter served by `require('events')` /
// `require('node:events')`. Many npm packages transitively depend on it.
// Mirrored inline in `chrome-extension/sandbox.html`.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class EventEmitter {
  private _events: Map<string | symbol, Listener[]> = new Map();

  on(event: string | symbol, fn: Listener): this {
    const list = this._events.get(event);
    if (list) list.push(fn);
    else this._events.set(event, [fn]);
    return this;
  }

  addListener(event: string | symbol, fn: Listener): this {
    return this.on(event, fn);
  }

  off(event: string | symbol, fn: Listener): this {
    const list = this._events.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this._events.delete(event);
    }
    return this;
  }

  removeListener(event: string | symbol, fn: Listener): this {
    return this.off(event, fn);
  }

  once(event: string | symbol, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  removeAllListeners(event?: string | symbol): this {
    if (event !== undefined) this._events.delete(event);
    else this._events.clear();
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this._events.get(event)?.length ?? 0;
  }

  listeners(event: string | symbol): Listener[] {
    return [...(this._events.get(event) ?? [])];
  }
}

export const nodeEvents = {
  EventEmitter,
  default: EventEmitter,
};

// ---------------------------------------------------------------------------
// `nodeStream` — minimal stream stubs served by `require('stream')` /
// `require('node:stream')`. Many npm packages transitively depend on stream
// classes. These are no-op stubs that satisfy structural checks without a
// full streaming implementation. Mirrored inline in
// `chrome-extension/sandbox.html`.
// ---------------------------------------------------------------------------

type StreamListener = (...args: unknown[]) => void;

class StreamBase {
  private _events: Map<string, StreamListener[]> = new Map();
  writable = true;
  readable = true;

  on(event: string, fn: StreamListener): this {
    const list = this._events.get(event);
    if (list) list.push(fn);
    else this._events.set(event, [fn]);
    return this;
  }

  once(event: string, fn: StreamListener): this {
    const wrapped: StreamListener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, fn: StreamListener): this {
    const list = this._events.get(event);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this._events.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  pipe(dest: StreamBase): StreamBase {
    return dest;
  }

  removeListener(event: string, fn: StreamListener): this {
    return this.off(event, fn);
  }

  removeAllListeners(): this {
    this._events.clear();
    return this;
  }
}

class Readable extends StreamBase {
  read(): null {
    return null;
  }
  destroy(): this {
    return this;
  }
}

class Writable extends StreamBase {
  write(_chunk: unknown, _encoding?: string, cb?: () => void): boolean {
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(cb?: () => void): this {
    if (cb) queueMicrotask(cb);
    return this;
  }
  destroy(): this {
    return this;
  }
}

class Transform extends StreamBase {
  write(_chunk: unknown, _encoding?: string, cb?: () => void): boolean {
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(cb?: () => void): this {
    if (cb) queueMicrotask(cb);
    return this;
  }
  read(): null {
    return null;
  }
  destroy(): this {
    return this;
  }
}

class PassThrough extends Transform {}

export const nodeStream = {
  Readable,
  Writable,
  Transform,
  PassThrough,
  Stream: StreamBase,
};
