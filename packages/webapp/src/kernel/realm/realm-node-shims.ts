/**
 * `realm-node-shims.ts` — Node `process` / `console` / `stdin` shims and
 * small path/exit helpers used to bootstrap a JS realm. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import { attachArgvParseFlags, nodeStream } from './js-realm-helpers.js';
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

export function createProcessShim(
  init: RealmInitMsg,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): { processShim: Record<string, unknown>; getDidCallProcessExit: () => boolean } {
  const noColor = !!init.env?.NO_COLOR;
  const stdinShim = createStdinShim(init.stdin ?? '');
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  let didCallProcessExit = false;
  const processShim = {
    argv: argvWithParseFlags,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      didCallProcessExit = true;
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout: { write: writeStdout, isTTY: !noColor },
    stderr: { write: writeStderr, isTTY: !noColor },
  };
  return { processShim, getDidCallProcessExit: () => didCallProcessExit };
}

/**
 * `process.stdin` shim. `init.stdin` arrives as a buffered, read-ahead
 * string from the kernel (the AlmostBashShell exec pipeline, `.jsh`
 * commands, `node`/`node -e`), so there's no streaming Readable.
 *
 * EOF semantics match Node's `Readable.read()`: the first `read()` returns
 * the full buffer, subsequent calls return `null`. A single `consumed` flag
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
 * then `'close'`. The one-hop deferral is deliberate — Wave 1 measured that a
 * multi-tick chain loses `'end'`-handler output past `realm-done` (see
 * `js-realm-shared.ts` `drainPendingRpcs`). `'error'` never fires.
 */
class StdinShim extends nodeStream.Stream {
  isTTY = false;
  private consumed = false;
  private flowScheduled = false;
  private readonly buffer: string;

  constructor(stdinBuffer: string) {
    super();
    this.buffer = stdinBuffer;
  }

  read(): string | null {
    if (this.consumed) return null;
    this.consumed = true;
    return this.buffer;
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
    return this;
  }

  resume(): this {
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
    if (!this.consumed) {
      this.consumed = true;
      if (this.buffer.length > 0) this.emit('data', this.buffer);
    }
    this.readable = false;
    this.emit('end');
    this.emit('close');
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

function createStdinShim(stdinBuffer: string): StdinShim {
  return new StdinShim(stdinBuffer);
}
