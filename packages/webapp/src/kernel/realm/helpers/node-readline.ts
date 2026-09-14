import { latin1ToBytes } from '../realm-fs-bridge.js';
import { NodeExitError } from '../realm-node-shims.js';
import { EventEmitter } from './node-events.js';

interface ReadlineOutputLike {
  write(text: string): void;
}

interface ReadlineInterfaceOptions {
  input?: unknown;
  output?: unknown;
  terminal?: boolean;
}

export interface NodeReadlineDeps {
  output?: ReadlineOutputLike;

  onExit?: (code: number) => void;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function drainInputBuffer(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof (input as { read?: unknown }).read === 'function') {
    const value = (input as { read(): unknown }).read();
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function decodeDrainedUtf8(raw: string): string {
  return new TextDecoder('utf-8').decode(latin1ToBytes(raw));
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
    this.lines = splitLines(decodeDrainedUtf8(drainInputBuffer(input)));
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

  private runHandler(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof NodeExitError && this.onExit) {
        this.closed = true;
        this.onExit(err.code);
        return;
      }
      throw err;
    }
  }
}

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
