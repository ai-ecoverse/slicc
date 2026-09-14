import { attachArgvParseFlags, nodeStream } from './js-realm-helpers.js';
import { NODE_SHIM_VERSION } from './node-builtins.js';
import type { RealmInitMsg } from './realm-types.js';

export function dirnameOf(filePath: string): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return filePath.substring(0, idx);
}

export class NodeExitError extends Error {
  constructor(public readonly code: number) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatConsoleLine(parts: unknown[]): string {
  return `${parts.map(formatConsoleArg).join(' ')}\n`;
}

function consoleLabel(label: unknown): string {
  return label === undefined ? 'default' : String(label);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function formatElapsed(ms: number): string {
  return `${ms.toFixed(3)}ms`;
}

type ConsoleSink = (value: unknown) => void;
type ConsoleLogFn = (...parts: unknown[]) => void;

function writeConsoleLine(sink: ConsoleSink, indent: number, parts: unknown[]): void {
  const line = formatConsoleLine(parts);
  sink(indent > 0 ? `${'  '.repeat(indent)}${line}` : line);
}

function consoleAssert(error: ConsoleLogFn, condition: unknown, args: unknown[]): void {
  if (condition) return;
  if (args.length === 0) {
    error('Assertion failed');
    return;
  }
  const [first, ...rest] = args;
  error(`Assertion failed: ${formatConsoleArg(first)}`, ...rest);
}

function consoleTrace(
  error: ConsoleLogFn,
  writeRaw: ConsoleSink,
  indent: number,
  args: unknown[]
): void {
  const prefix = args.length > 0 ? `Trace: ${args.map(formatConsoleArg).join(' ')}` : 'Trace:';
  error(prefix);
  const stack = new Error().stack;
  if (!stack) return;

  const frames = stack.split('\n').slice(3).join('\n');
  if (!frames) return;
  const body = frames.endsWith('\n') ? frames : `${frames}\n`;
  writeRaw(indent > 0 ? `${'  '.repeat(indent)}${body}` : body);
}

function consoleTimeStart(times: Map<string, number>, warn: ConsoleLogFn, label: unknown): void {
  const key = consoleLabel(label);
  if (times.has(key)) {
    warn(`Label '${key}' already exists for console.time()`);
    return;
  }
  times.set(key, nowMs());
}

function consoleTimeEnd(
  times: Map<string, number>,
  warn: ConsoleLogFn,
  log: ConsoleLogFn,
  label: unknown
): void {
  const key = consoleLabel(label);
  const start = times.get(key);
  if (start === undefined) {
    warn(`No such label '${key}' for console.timeEnd()`);
    return;
  }
  times.delete(key);
  log(`${key}: ${formatElapsed(nowMs() - start)}`);
}

function consoleTimeLog(
  times: Map<string, number>,
  warn: ConsoleLogFn,
  log: ConsoleLogFn,
  label: unknown,
  args: unknown[]
): void {
  const key = consoleLabel(label);
  const start = times.get(key);
  if (start === undefined) {
    warn(`No such label '${key}' for console.timeLog()`);
    return;
  }
  const elapsed = `${key}: ${formatElapsed(nowMs() - start)}`;
  if (args.length === 0) log(elapsed);
  else log(elapsed, ...args);
}

function consoleCount(counts: Map<string, number>, log: ConsoleLogFn, label: unknown): void {
  const key = consoleLabel(label);
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  log(`${key}: ${next}`);
}

function consoleCountReset(counts: Map<string, number>, warn: ConsoleLogFn, label: unknown): void {
  const key = consoleLabel(label);
  if (!counts.has(key)) {
    warn(`Count for '${key}' does not exist`);
    return;
  }
  counts.set(key, 0);
}

function bumpGroup(state: { depth: number }, log: ConsoleLogFn, parts: unknown[]): void {
  if (parts.length > 0) log(...parts);
  state.depth += 1;
}

function endGroup(state: { depth: number }): void {
  if (state.depth > 0) state.depth -= 1;
}

export function createNodeConsole(writeStdout: ConsoleSink, writeStderr: ConsoleSink) {
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  const group = { depth: 0 };

  const log: ConsoleLogFn = (...parts) => writeConsoleLine(writeStdout, group.depth, parts);
  const error: ConsoleLogFn = (...parts) => writeConsoleLine(writeStderr, group.depth, parts);
  const startGroup: ConsoleLogFn = (...parts) => bumpGroup(group, log, parts);

  return {
    log,
    info: log,
    debug: log,
    dirxml: log,
    table: log,
    warn: error,
    error,
    dir: (obj?: unknown, _opts?: unknown) => log(obj),
    clear: () => undefined,
    group: startGroup,
    groupCollapsed: startGroup,
    groupEnd: () => endGroup(group),
    assert: (condition?: unknown, ...args: unknown[]) => consoleAssert(error, condition, args),
    trace: (...args: unknown[]) => consoleTrace(error, writeStderr, group.depth, args),
    time: (label?: unknown) => consoleTimeStart(times, error, label),
    timeEnd: (label?: unknown) => consoleTimeEnd(times, error, log, label),
    timeLog: (label?: unknown, ...args: unknown[]) =>
      consoleTimeLog(times, error, log, label, args),
    count: (label?: unknown) => consoleCount(counts, log, label),
    countReset: (label?: unknown) => consoleCountReset(counts, error, label),
  };
}

interface RealmWritableShim {
  write: (value: unknown) => void;
  end: () => undefined;
  isTTY: boolean;
}

export interface RealmProcessShim {
  argv: string[];
  env: Record<string, string>;
  versions: { node: string };
  version: string;
  platform: string;
  arch: string;
  cwd: () => string;
  exit: (codeValue?: number) => never;
  stdin: StdinShim;
  stdout: RealmWritableShim;
  stderr: RealmWritableShim;
}

export function createProcessShim(
  init: RealmInitMsg,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): {
  processShim: RealmProcessShim;
  getDidCallProcessExit: () => boolean;
  getExitCode: () => number;
  recordExit: (code: number) => void;
} {
  const noColor = !!init.env?.NO_COLOR;
  let didCallProcessExit = false;
  let exitCode = 0;
  const recordExit = (code: number): void => {
    didCallProcessExit = true;
    exitCode = code;
  };

  const stdinShim = createStdinShim(init.stdin ?? '', recordExit);
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  const stdout = { write: writeStdout, end: () => undefined, isTTY: !noColor };
  const stderr = { write: writeStderr, end: () => undefined, isTTY: !noColor };
  const processShim: RealmProcessShim = {
    argv: argvWithParseFlags,
    env: init.env,

    versions: { node: NODE_SHIM_VERSION },
    version: `v${NODE_SHIM_VERSION}`,
    platform: 'linux',
    arch: 'x64',
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      recordExit(normalized);
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout,
    stderr,
  };
  return {
    processShim,
    getDidCallProcessExit: () => didCallProcessExit,
    getExitCode: () => exitCode,

    recordExit,
  };
}

class StdinShim extends nodeStream.Stream {
  isTTY = false;
  private consumed = false;
  private flowScheduled = false;
  private paused = false;
  private readonly buffer: string;
  private readonly onExit: (code: number) => void;

  constructor(stdinBuffer: string, onExit: (code: number) => void) {
    super();
    this.buffer = stdinBuffer;
    this.onExit = onExit;
  }

  read(): string | null {
    if (this.consumed) return null;
    this.consumed = true;

    return this.buffer.length > 0 ? this.buffer : null;
  }

  toString(): string {
    return this.buffer;
  }

  setEncoding(_encoding?: string): this {
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    this.scheduleFlow();
    return this;
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    super.on(event, fn);
    if (event === 'data') this.scheduleFlow();
    return this;
  }

  addListener(event: string, fn: (...args: unknown[]) => void): this {
    return this.on(event, fn);
  }

  once(event: string, fn: (...args: unknown[]) => void): this {
    super.once(event, fn);
    if (event === 'data') this.scheduleFlow();
    return this;
  }

  private scheduleFlow(): void {
    if (this.flowScheduled) return;
    this.flowScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    if (this.paused) {
      this.flowScheduled = false;
      return;
    }

    try {
      if (!this.consumed) {
        this.consumed = true;
        if (this.buffer.length > 0) this.emit('data', this.buffer);
      }
      this.readable = false;
      this.emit('end');
      this.emit('close');
    } catch (err) {
      if (err instanceof NodeExitError) {
        this.onExit(err.code);
        return;
      }
      throw err;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this.consumed) return { value: undefined, done: true };
        this.consumed = true;
        return { value: this.buffer, done: false };
      },
    };
  }
}

function createStdinShim(stdinBuffer: string, onExit: (code: number) => void): StdinShim {
  return new StdinShim(stdinBuffer, onExit);
}
