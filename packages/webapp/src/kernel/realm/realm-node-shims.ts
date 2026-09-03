/**
 * `realm-node-shims.ts` — Node `process` / `console` / `stdin` shims and
 * small path/exit helpers used to bootstrap a JS realm. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
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

export function createNodeConsole(
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
) {
  return {
    log: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    info: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    warn: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
    error: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
  };
}

/** The `process.stdout` / `process.stderr` write sinks handed to user code. */
interface RealmWritableShim {
  write: (value: unknown) => void;
  end: () => undefined;
  isTTY: boolean;
}

/**
 * The realm's `process` shim surface (handed to user code and served for
 * `require('process')`). `argv` carries the non-enumerable `.parseFlags()`
 * helper (see `attachArgvParseFlags`).
 */
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
  // A `process.exit()` from a deferred stdin handler (`'data'`/`'end'`/`'close'`)
  // throws its NodeExitError inside a queued microtask, outside runUserCode's
  // try/catch. The shim catches it there and reports the code back here so the
  // realm still exits with N instead of losing the code (and surfacing it as an
  // uncaught error).
  const stdinShim = createStdinShim(init.stdin ?? '', recordExit);
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  const stdout = { write: writeStdout, end: () => undefined, isTTY: !noColor };
  const stderr = { write: writeStderr, end: () => undefined, isTTY: !noColor };
  const processShim: RealmProcessShim = {
    argv: argvWithParseFlags,
    env: init.env,
    // Identity fields packages sniff at require time. Leaving them undefined
    // turned a diagnosable failure into a TypeError deep inside a dependency
    // (`process.versions.node` in esbuild's Node entry, #2200), and Go's
    // `wasm_exec` glue branches on the same globals. The values mirror the
    // `os` shim (`helpers/node-os.ts`: linux/x64) so a script that reads both
    // sees one consistent machine.
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
    // Exposed so sibling shims that run user handlers in microtasks (the
    // readline shim's deferred 'line' flush) can report a caught
    // `process.exit(N)` the same way the stdin shim does.
    recordExit,
  };
}

/**
 * `process.stdin` shim. `init.stdin` arrives as a buffered, read-ahead
 * string from the kernel (the AlmostBashShell exec pipeline, `.jsh`
 * commands, `node`/`node -e`), so there's no streaming Readable.
 *
 * EOF semantics match Node's `Readable.read()`: the first `read()` returns
 * the full buffer (`null` when nothing was piped), subsequent calls return
 * `null`. A single `consumed` flag
 * is shared across `read()`, the async iterator, and the EventEmitter surface
 * so no path double-delivers: `for await (const c of process.stdin)` after a
 * `read()` (or a second iteration) yields nothing. `toString()` always returns
 * the original buffer; `isTTY` is always `false`.
 *
 * The EventEmitter surface (`.on('data'|'end'|'close')`, `for await`) reuses
 * the shared `StreamBase` emitter (`nodeStream.Stream`) rather than a bespoke
 * one. Registering a `'data'` listener (or calling `resume()`) puts the stream
 * in flowing mode: on a single `queueMicrotask` hop it emits the whole buffer
 * as one `'data'` chunk (skipped when empty or already consumed), then `'end'`,
 * then `'close'`. The one-hop deferral is enough for stdout capture: the realm
 * drain now waits for user timers the way Node waits for handles, so a nested
 * `setTimeout` in an `'end'` handler would still be collected. `'error'` never
 * fires.
 *
 * `pause()` suppresses the scheduled flush (the buffer stays intact so another
 * surface — a later `resume()` or a `read()` — can still drain it); `resume()`
 * clears the pause and re-schedules. A synchronous `pause().resume()` still
 * flushes on the single originally-scheduled microtask (no extra hop). A
 * `process.exit()` thrown from a handler is caught here and reported via
 * `onExit` so the realm exits with that code instead of leaking an uncaught
 * error.
 */
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
    // Node parity: `read()` on an empty stream yields `null`, never `''`
    // (a script run without piped input sees `null` on the first call).
    return this.buffer.length > 0 ? this.buffer : null;
  }

  toString(): string {
    return this.buffer;
  }

  // The realm buffer is already latin1-preserved text (one JS char per byte),
  // so there is nothing to re-decode: any/no encoding yields the same chunk.
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
    // Suppressed while paused: drop the scheduled slot so a later resume() can
    // re-arm the single-hop flush without double-emitting.
    if (this.paused) {
      this.flowScheduled = false;
      return;
    }
    // Handlers run synchronously (StreamBase.emit); a process.exit() among them
    // throws a NodeExitError. Catch it here — this runs in a microtask outside
    // runUserCode's try/catch — record the code, and stop emitting further
    // events (Node's exit is terminal).
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
