import { bufferFrom } from './buffer-from.js';
import { EventEmitter } from './node-events.js';
import { Readable } from './node-stream.js';
import { UTIL_PROMISIFY_CUSTOM } from './node-util.js';

export interface CpExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CpExecHandle {
  kill(sig?: string): Promise<boolean>;
  stdin: { write(chunk: string): void; end(): void };
  done: Promise<CpExecResult>;
}

export interface CpExecStartOptions {
  stdin?: string;
  stdinKind?: 'text' | 'bytes';
  args?: string[];
}

export interface CpExecBridge {
  start(commandOrArgv: string | string[], opts?: CpExecStartOptions): CpExecHandle;
}

export interface CpSyncExecBridge {
  run(
    command: string | string[],
    opts?: { args?: string[]; input?: string; timeout?: number }
  ): CpExecResult;
}

interface CpOptions {
  encoding?: string | null;
  input?: string | ArrayBufferView;
  shell?: boolean | string;
  timeout?: number;
  stdio?: unknown;
}

type CpChunk = string | Buffer;
type CpExecCallback = (error: Error | null, stdout: CpChunk, stderr: CpChunk) => void;

export interface CpSpawnSyncResult {
  pid: number;
  status: number | null;
  signal: string | null;
  stdout: CpChunk;
  stderr: CpChunk;
  output: Array<CpChunk | null>;
  error?: Error;
}

export interface NodeChildProcess {
  exec(
    command: string,
    options?: CpOptions | CpExecCallback,
    callback?: CpExecCallback
  ): ChildProcess;
  execFile(
    file: string,
    args?: string[] | CpOptions | CpExecCallback,
    options?: CpOptions | CpExecCallback,
    callback?: CpExecCallback
  ): ChildProcess;
  spawn(command: string, args?: string[] | CpOptions, options?: CpOptions): ChildProcess;
  execSync(command: string, options?: CpOptions): CpChunk;
  execFileSync(file: string, args?: string[] | CpOptions, options?: CpOptions): CpChunk;
  spawnSync(command: string, args?: string[] | CpOptions, options?: CpOptions): CpSpawnSyncResult;
  fork(...args: unknown[]): never;
  ChildProcess: typeof ChildProcess;
}

let nextCpPid = 1;

function cpChunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (ArrayBuffer.isView(chunk)) {
    const v = chunk as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  if (chunk === null || chunk === undefined) return '';
  return String(chunk);
}

function cpEncodeChunk(text: string, encoding: string | null | undefined): CpChunk {
  if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return text;
  if (encoding === 'buffer' || encoding === null) return bufferFrom(text);
  return bufferFrom(text).toString(encoding as BufferEncoding);
}

function cpJoin(chunks: CpChunk[], encoding: string | null | undefined): CpChunk {
  if (chunks.length === 0) return cpEncodeChunk('', encoding);
  if (typeof chunks[0] === 'string') return (chunks as string[]).join('');
  const B = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  return B ? B.concat(chunks as Buffer[]) : chunks[0];
}

function cpEmitStream(stream: Readable, text: string, encoding: string | null | undefined): void {
  if (text.length > 0) stream.emit('data', cpEncodeChunk(text, encoding));
  stream.readable = false;
  stream.emit('end');
}

function cpMakeStdin(handle: CpExecHandle) {
  const runCb = (maybe: unknown): void => {
    if (typeof maybe === 'function') queueMicrotask(maybe as () => void);
  };
  return {
    writable: true,
    write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
      handle.stdin.write(cpChunkToString(chunk));
      runCb(typeof encoding === 'function' ? encoding : cb);
      return true;
    },
    end(chunk?: unknown, encoding?: unknown, cb?: unknown): void {
      if (chunk !== undefined && typeof chunk !== 'function') {
        handle.stdin.write(cpChunkToString(chunk));
      }
      handle.stdin.end();
      this.writable = false;
      runCb(typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb);
    },
  };
}

class ChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: ReturnType<typeof cpMakeStdin>;
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly spawnfile: string;
  readonly spawnargs: string[];
  private readonly handle: CpExecHandle;

  constructor(
    handle: CpExecHandle,
    encoding: string | null | undefined,
    spawnfile: string,
    spawnargs: string[]
  ) {
    super();
    this.handle = handle;
    this.pid = nextCpPid++;
    this.spawnfile = spawnfile;
    this.spawnargs = spawnargs;
    this.stdout = new Readable();
    this.stderr = new Readable();
    this.stdin = cpMakeStdin(handle);
    handle.done.then(
      (result) => this.finish(result, encoding),
      (error) => this.emit('error', error instanceof Error ? error : new Error(String(error)))
    );
  }

  private finish(result: CpExecResult, encoding: string | null | undefined): void {
    cpEmitStream(this.stdout, result.stdout, encoding);
    cpEmitStream(this.stderr, result.stderr, encoding);
    this.exitCode = result.exitCode;
    const code = this.killed ? null : result.exitCode;
    const signal = this.killed ? this.signalCode : null;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal: string = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.handle.kill(signal).catch(() => {});
    return true;
  }
}

function createCpSyncForms(
  syncExec: CpSyncExecBridge | undefined
): Pick<NodeChildProcess, 'execSync' | 'execFileSync' | 'spawnSync'> {
  const runSync = (
    name: string,
    command: string | string[],
    opts: { input?: string; timeout?: number }
  ): CpExecResult => {
    if (!syncExec) {
      throw new Error(
        `child_process.${name} is not available in this browser realm ` +
          '(no synchronous bridge — the page has no controlling Service Worker). ' +
          `Use the async form instead: await promisify(${name.replace(/Sync$/, '')})(…).`
      );
    }
    return syncExec.run(command, opts);
  };

  const runOptions = (options: CpOptions): { input?: string; timeout?: number } => ({
    ...(options.input !== undefined ? { input: cpChunkToString(options.input) } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });

  const throwingSync = (
    name: string,
    command: string | string[],
    label: string,
    options: CpOptions
  ): CpChunk => {
    const encoding = options.encoding === undefined ? 'buffer' : options.encoding;
    const result = runSync(name, command, runOptions(options));
    const stdout = cpEncodeChunk(result.stdout, encoding);
    const stderr = cpEncodeChunk(result.stderr, encoding);
    if (result.exitCode === 0) return stdout;
    throw Object.assign(new Error(`Command failed: ${label}\n${result.stderr}`), {
      status: result.exitCode,
      signal: null,
      stdout,
      stderr,
      output: [null, stdout, stderr],
      pid: nextCpPid++,
    });
  };

  const splitArgs = (
    argsOrOptions?: string[] | CpOptions,
    maybeOptions?: CpOptions
  ): { args: string[]; options: CpOptions } => ({
    args: Array.isArray(argsOrOptions) ? argsOrOptions : [],
    options: (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {},
  });

  return {
    execSync: (command: string, options: CpOptions = {}): CpChunk =>
      throwingSync('execSync', command, command, options),

    execFileSync: (
      file: string,
      argsOrOptions?: string[] | CpOptions,
      maybeOptions?: CpOptions
    ): CpChunk => {
      const { args, options } = splitArgs(argsOrOptions, maybeOptions);
      const argv = [file, ...args];
      return throwingSync('execFileSync', argv, argv.join(' '), options);
    },

    spawnSync: (
      command: string,
      argsOrOptions?: string[] | CpOptions,
      maybeOptions?: CpOptions
    ): CpSpawnSyncResult => {
      const { args, options } = splitArgs(argsOrOptions, maybeOptions);
      const encoding = options.encoding === undefined ? 'buffer' : options.encoding;
      const pid = nextCpPid++;
      const commandOrArgv: string | string[] = options.shell
        ? `${command}${args.length ? ` ${args.join(' ')}` : ''}`
        : [command, ...args];
      let result: CpExecResult;
      try {
        result = runSync('spawnSync', commandOrArgv, runOptions(options));
      } catch (err) {
        const empty = cpEncodeChunk('', encoding);
        return {
          pid,
          status: null,
          signal: null,
          stdout: empty,
          stderr: empty,
          output: [null, empty, empty],
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      const stdout = cpEncodeChunk(result.stdout, encoding);
      const stderr = cpEncodeChunk(result.stderr, encoding);
      return {
        pid,
        status: result.exitCode,
        signal: null,
        stdout,
        stderr,
        output: [null, stdout, stderr],
      };
    },
  };
}

export function createNodeChildProcess(
  exec: CpExecBridge,
  syncExec?: CpSyncExecBridge
): NodeChildProcess {
  const launch = (
    commandOrArgv: string | string[],
    options: CpOptions,
    encoding: string | null | undefined,
    spawnfile: string,
    spawnargs: string[]
  ): ChildProcess => {
    const handle = exec.start(commandOrArgv);
    const child = new ChildProcess(handle, encoding, spawnfile, spawnargs);
    if (options.input !== undefined) child.stdin.write(cpChunkToString(options.input));
    queueMicrotask(() => handle.stdin.end());
    return child;
  };

  const buffered = (
    child: ChildProcess,
    encoding: string | null | undefined,
    label: string,
    cb: CpExecCallback | undefined
  ): void => {
    if (typeof cb !== 'function') return;
    const outChunks: CpChunk[] = [];
    const errChunks: CpChunk[] = [];
    child.stdout.on('data', (c) => outChunks.push(c as CpChunk));
    child.stderr.on('data', (c) => errChunks.push(c as CpChunk));
    child.once('error', (err) =>
      cb(err as Error, cpJoin(outChunks, encoding), cpJoin(errChunks, encoding))
    );
    child.once('close', (code, signal) => {
      const stdout = cpJoin(outChunks, encoding);
      const stderr = cpJoin(errChunks, encoding);
      if (code === 0) {
        cb(null, stdout, stderr);
        return;
      }
      const err = Object.assign(new Error(`Command failed: ${label}\n${cpChunkToString(stderr)}`), {
        code: code === null ? undefined : (code as number),
        killed: child.killed,
        signal: (signal as string | null) ?? null,
        cmd: label,
      });
      cb(err, stdout, stderr);
    });
  };

  const execImpl = (
    command: string,
    optionsOrCb?: CpOptions | CpExecCallback,
    callback?: CpExecCallback
  ): ChildProcess => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : callback;
    const options: CpOptions = optionsOrCb && typeof optionsOrCb === 'object' ? optionsOrCb : {};
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    const child = launch(command, options, encoding, command, []);
    buffered(child, encoding, command, cb);
    return child;
  };

  const execFileImpl = (
    file: string,
    argsOrOptions?: string[] | CpOptions | CpExecCallback,
    optionsOrCb?: CpOptions | CpExecCallback,
    callback?: CpExecCallback
  ): ChildProcess => {
    let args: string[] = [];
    let options: CpOptions = {};
    let cb: CpExecCallback | undefined;
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions;
      if (typeof optionsOrCb === 'function') cb = optionsOrCb;
      else {
        options = (optionsOrCb as CpOptions) ?? {};
        cb = typeof callback === 'function' ? callback : undefined;
      }
    } else if (typeof argsOrOptions === 'function') {
      cb = argsOrOptions;
    } else if (argsOrOptions && typeof argsOrOptions === 'object') {
      options = argsOrOptions;
      cb = typeof optionsOrCb === 'function' ? optionsOrCb : undefined;
    }
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    const argv = [file, ...args];
    const child = launch(argv, options, encoding, file, args);
    buffered(child, encoding, argv.join(' '), cb);
    return child;
  };

  const spawnImpl = (
    command: string,
    argsOrOptions?: string[] | CpOptions,
    maybeOptions?: CpOptions
  ): ChildProcess => {
    let args: string[] = [];
    let options: CpOptions = {};
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions;
      options = maybeOptions ?? {};
    } else if (argsOrOptions && typeof argsOrOptions === 'object') {
      options = argsOrOptions;
    }
    const encoding = options.encoding === undefined ? 'buffer' : options.encoding;
    const commandOrArgv: string | string[] = options.shell
      ? `${command}${args.length ? ` ${args.join(' ')}` : ''}`
      : [command, ...args];
    return launch(commandOrArgv, options, encoding, command, args);
  };

  const execPromise = (
    command: string,
    options?: CpOptions
  ): Promise<{ stdout: CpChunk; stderr: CpChunk }> =>
    new Promise((resolve, reject) => {
      execImpl(command, options, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  const execFilePromise = (
    file: string,
    argsOrOptions?: string[] | CpOptions,
    maybeOptions?: CpOptions
  ): Promise<{ stdout: CpChunk; stderr: CpChunk }> =>
    new Promise((resolve, reject) => {
      const cb: CpExecCallback = (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      };
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;
      execFileImpl(file, args, options, cb);
    });

  const cpUnavailable = (name: string) => (): never => {
    throw new Error(`child_process.${name} is not available in the browser realm`);
  };

  const sync = createCpSyncForms(syncExec);

  const attachPromisify = (fn: object, impl: Function): void => {
    Object.defineProperty(fn, UTIL_PROMISIFY_CUSTOM, {
      value: impl,
      enumerable: false,
      configurable: true,
    });
  };
  attachPromisify(execImpl, execPromise);
  attachPromisify(execFileImpl, execFilePromise);

  return {
    exec: execImpl,
    execFile: execFileImpl,
    spawn: spawnImpl,
    execSync: sync.execSync,
    spawnSync: sync.spawnSync,
    execFileSync: sync.execFileSync,
    fork: cpUnavailable('fork'),
    ChildProcess,
  };
}
