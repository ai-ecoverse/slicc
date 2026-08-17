/**
 * Minimal `readline` / `readline/promises` shims for the realm, sufficient
 * for the common line-reading idioms over the realm's fully buffered
 * one-shot stdin (`readline.createInterface({ input: process.stdin })`).
 *
 * The input is drained ONCE at `createInterface` time via the stream's
 * `read()` (the realm's `StdinShim.read()` — this consumes `process.stdin`'s
 * one-shot flag, matching Node where readline puts the stream into flowing
 * mode). Lines are the `\n`-separated segments; a trailing `\r` is stripped
 * (CRLF input) and, matching Node, a final unterminated segment is still
 * emitted as a line. Three consumption surfaces share ONE line cursor so no
 * path double-delivers:
 *
 *  1. `'line'` events — registering a `'line'` listener schedules a single
 *     microtask hop (same one-hop deferral as the stdin shim: registration
 *     order stays sane but output cannot slip past `realm-done`) that emits
 *     every unconsumed line, then `'close'`.
 *  2. `for await (const line of rl)` — yields unconsumed lines, then closes.
 *  3. `question(query[, cb])` — writes the query to the interface's `output`
 *     (or the realm's stdout when none was passed) and answers with the NEXT
 *     unconsumed line, `''` at EOF. With a callback it invokes it on a
 *     microtask (callback `readline`); without one it returns a Promise
 *     (`readline/promises` — also handy for the callback module).
 *
 * A `process.exit(N)` thrown by a handler inside the deferred flush runs
 * outside `runUserCode`'s try/catch; it is caught here and reported via
 * `onExit` so the realm exits with code N (same contract as `StdinShim`).
 */
import { NodeExitError } from '../realm-node-shims.js';
import { EventEmitter } from './node-events.js';

interface ReadlineOutputLike {
  write(text: string): void;
}

/** `createInterface` options object (also accepted positionally as (input, output)). */
interface ReadlineInterfaceOptions {
  input?: unknown;
  output?: unknown;
  terminal?: boolean;
}

export interface NodeReadlineDeps {
  /** Default `question()` echo target when the caller passes no `output`. */
  output?: ReadlineOutputLike;
  /** Reports a `process.exit(N)` caught in the deferred 'line' flush. */
  onExit?: (code: number) => void;
}

/** Split the drained buffer into readline lines (Node semantics, see module doc). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Drain the input stream's full buffer. Designed for the realm's one-shot
 * `process.stdin` (`read()` returns the whole buffer, or `null` when empty /
 * already consumed elsewhere — consumed-elsewhere correctly reads as EOF
 * here). A plain string input is accepted for tests/utility use.
 */
function drainInputBuffer(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof (input as { read?: unknown }).read === 'function') {
    const value = (input as { read(): unknown }).read();
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function asOutput(candidate: unknown): ReadlineOutputLike | undefined {
  if (candidate && typeof (candidate as { write?: unknown }).write === 'function') {
    return candidate as ReadlineOutputLike;
  }
  return undefined;
}

class RealmReadlineInterface extends EventEmitter {
  readonly terminal = false;
  private readonly lines: string[];
  private cursor = 0;
  private closed = false;
  private flushScheduled = false;
  private readonly output: ReadlineOutputLike | undefined;
  private readonly onExit: ((code: number) => void) | undefined;

  constructor(input: unknown, output: ReadlineOutputLike | undefined, deps: NodeReadlineDeps) {
    super();
    this.lines = splitLines(drainInputBuffer(input));
    this.output = output ?? deps.output;
    this.onExit = deps.onExit;
  }

  override on(event: string | symbol, fn: (...args: unknown[]) => void): this {
    super.on(event, fn);
    if (event === 'line') this.scheduleFlush();
    return this;
  }

  override once(event: string | symbol, fn: (...args: unknown[]) => void): this {
    super.once(event, fn);
    if (event === 'line') this.scheduleFlush();
    return this;
  }

  /** No-op flow control (the buffer is already fully drained). */
  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /**
   * Callback form (`cb` given): Node's callback `readline`. Without a
   * callback it returns a Promise (`readline/promises`; the callback module
   * shares the behavior as a convenience superset).
   */
  question(query: string, secondArg?: unknown, thirdArg?: unknown): Promise<string> | undefined {
    const cb =
      typeof secondArg === 'function'
        ? secondArg
        : typeof thirdArg === 'function'
          ? thirdArg
          : undefined;
    this.output?.write(String(query));
    const answer = this.cursor < this.lines.length ? this.lines[this.cursor++] : '';
    if (cb) {
      queueMicrotask(() => this.runHandler(() => (cb as (a: string) => void)(answer)));
      return undefined;
    }
    return Promise.resolve(answer);
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (!this.closed && this.cursor < this.lines.length) {
          return { value: this.lines[this.cursor++], done: false };
        }
        this.close();
        return { value: undefined, done: true };
      },
    };
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    this.runHandler(() => {
      while (!this.closed && this.cursor < this.lines.length) {
        this.emit('line', this.lines[this.cursor++]);
      }
      this.close();
    });
  }

  /** Run a user handler outside `runUserCode`'s try/catch; see module doc. */
  private runHandler(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof NodeExitError && this.onExit) {
        this.closed = true; // exit is terminal — no further 'line'/'close'
        this.onExit(err.code);
        return;
      }
      throw err;
    }
  }
}

/** The module shape served for both `require('readline')` and its `promises` form. */
export interface NodeReadlineModule {
  createInterface(
    optionsOrInput: ReadlineInterfaceOptions | unknown,
    maybeOutput?: unknown
  ): RealmReadlineInterface;
  Interface: typeof RealmReadlineInterface;
  promises: Omit<NodeReadlineModule, 'promises'>;
  emitKeypressEvents(stream?: unknown): void;
  cursorTo(stream?: unknown, x?: number, y?: number, cb?: () => void): boolean;
  moveCursor(stream?: unknown, dx?: number, dy?: number, cb?: () => void): boolean;
  clearLine(stream?: unknown, dir?: number, cb?: () => void): boolean;
  clearScreenDown(stream?: unknown, cb?: () => void): boolean;
}

/**
 * Build the per-realm `readline` module. Per-realm (not a static export like
 * `nodeOs`) because `question()`'s default echo target is the realm's own
 * stdout and `onExit` is the realm's exit recorder.
 */
export function createNodeReadline(deps: NodeReadlineDeps): NodeReadlineModule {
  const createInterface = (
    optionsOrInput: ReadlineInterfaceOptions | unknown,
    maybeOutput?: unknown
  ): RealmReadlineInterface => {
    let input: unknown;
    let output: ReadlineOutputLike | undefined;
    if (
      optionsOrInput &&
      typeof optionsOrInput === 'object' &&
      'input' in (optionsOrInput as ReadlineInterfaceOptions)
    ) {
      const options = optionsOrInput as ReadlineInterfaceOptions;
      input = options.input;
      output = asOutput(options.output);
    } else {
      input = optionsOrInput;
      output = asOutput(maybeOutput);
    }
    if (input === undefined || input === null) {
      throw new TypeError("readline.createInterface: an 'input' stream is required");
    }
    return new RealmReadlineInterface(input, output, deps);
  };
  // Cursor-control helpers are terminal no-ops: realm stdout is a buffered
  // pipe (isTTY drives color only), so there is no cursor to move. They
  // return true ("wrote fully") so spinner-style code proceeds harmlessly.
  const noopTty = (...args: unknown[]): boolean => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') queueMicrotask(() => (cb as () => void)());
    return true;
  };
  const promises = {
    createInterface,
    Interface: RealmReadlineInterface,
    emitKeypressEvents: (): void => undefined,
    cursorTo: noopTty,
    moveCursor: noopTty,
    clearLine: noopTty,
    clearScreenDown: noopTty,
  };
  return { ...promises, promises };
}
