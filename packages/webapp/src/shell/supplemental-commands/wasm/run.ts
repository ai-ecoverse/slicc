/**
 * `wasm` — run an Emscripten program as a wasm-realm process (#3530): one
 * worker, stdio on kernel descriptors, files on the live VFS. Loaded lazily
 * by `wasm-command.ts`.
 *
 *   wasm [--argv0 NAME] PROGRAM [ARGS...]
 *
 * PROGRAM is the Emscripten glue; its module sits next to it (`x.js` →
 * `x.wasm`, `x` → `x.wasm`). The glue must be linked with `-sENVIRONMENT`
 * including `worker`. `--argv0` sets `argv[0]` (the program of a multi-call
 * binary such as coreutils); the default is PROGRAM's base name.
 */
import type { CommandContext } from 'just-bash';
import { compileWasmFromVfs } from '../../../kernel/realm/wasm-compiler.js';
import { bytesSource, FdTable, sinkFile } from '../../../kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../kernel/wasm-realm/host.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { stdinAsLatin1 } from '../../just-bash-compat.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE = 'usage: wasm [--argv0 NAME] PROGRAM [ARGS...]\n';

const NO_SAB =
  'the wasm realm needs SharedArrayBuffer, which this page lacks (it is not cross-origin isolated)';

/** Compiled modules, keyed by path, size and mtime: a rebuilt program recompiles. */
const modules = new Map<string, Promise<WebAssembly.Module>>();

/** Exit codes of the terminating signals: the worker ends at once (128 + signo). */
const SIGNAL_EXIT_CODE: Readonly<Partial<Record<string, number>>> = {
  SIGKILL: 137,
  SIGINT: 130,
  SIGTERM: 143,
};

/** The shell's output limit when the context carries none (just-bash's default). */
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

/** Pids when there is no process table (unit tests). */
let nextPid = 40000;

interface Invocation {
  argv0?: string;
  program: string;
  args: string[];
}

function parse(args: string[]): Invocation | undefined {
  let argv0: string | undefined;
  let i = 0;
  if (args[i] === '--argv0') {
    argv0 = args[i + 1];
    i += 2;
  }
  const program = args[i];
  if (!program || program.startsWith('-')) return undefined;
  return { argv0, program, args: args.slice(i + 1) };
}

function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
}

async function loadModule(ctx: CommandContext, path: string): Promise<WebAssembly.Module> {
  const st = await ctx.fs.stat(path);
  const key = `${path}:${st.size}:${st.mtime.getTime()}`;
  let module = modules.get(key);
  if (!module) {
    module = compileWasmFromVfs((p) => ctx.fs.readFileBuffer(p), path);
    modules.set(key, module);
    module.catch(() => modules.delete(key));
  }
  return module;
}

function latin1(chunks: Uint8Array[]): string {
  let out = '';
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 0x8000) {
      out += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
    }
  }
  return out;
}

function stdinBytes(ctx: CommandContext): Uint8Array {
  const raw = stdinAsLatin1(ctx.stdin);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  return bytes;
}

export async function runWasmCommand(
  args: string[],
  ctx: CommandContext,
  processConfig?: JshProcessConfig
): Promise<Result> {
  if (args[0] === '--help' || args[0] === '-h') return { stdout: USAGE, stderr: '', exitCode: 0 };
  const call = parse(args);
  if (!call) return { stdout: '', stderr: USAGE, exitCode: 2 };
  if (typeof SharedArrayBuffer !== 'function') {
    // Syscalls block in Atomics.wait on a shared buffer.
    return { stdout: '', stderr: `wasm: ${NO_SAB}\n`, exitCode: 126 };
  }
  const gluePath = ctx.fs.resolvePath(ctx.cwd, call.program);
  let glue: string;
  let module: WebAssembly.Module;
  try {
    glue = await ctx.fs.readFile(gluePath);
    module = await loadModule(ctx, modulePath(gluePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `wasm: ${call.program}: ${message}\n`, exitCode: 127 };
  }

  // Canceled while the program was read or compiled: never start it.
  if (ctx.signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };

  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  // The sinks never block, so a runaway producer (`yes`) is cut off at the
  // shell's output limit instead of filling memory.
  const limit = ctx.limits?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;
  let collected = 0;
  let overflow = false;
  const collect = (into: Uint8Array[]) => (bytes: Uint8Array) => {
    collected += bytes.length;
    if (collected > limit) {
      overflow = true;
      handle.kill(1);
      return;
    }
    into.push(bytes);
  };
  const fds = new FdTable();
  fds.install(bytesSource(stdinBytes(ctx)));
  fds.install(sinkFile(collect(out)));
  fds.install(sinkFile(collect(err)));
  const argv0 = call.argv0 ?? gluePath.slice(gluePath.lastIndexOf('/') + 1).replace(/\.js$/, '');
  const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);
  const pm = processConfig?.processManager;
  const proc = processConfig && registerProcess(processConfig, [argv0, ...call.args], ctx.cwd, env);
  const handle = spawnWasmProcess({
    pid: proc?.pid ?? nextPid++,
    program: { glue, module },
    argv0,
    args: call.args,
    env,
    cwd: ctx.cwd,
    fds,
    fs: ctx.fs,
    onError: (message) => err.push(new TextEncoder().encode(`wasm: ${message}\n`)),
  });
  // `kill` / `ps`: a terminating signal to the pid ends the worker at once.
  const unsubscribe = pm?.onSignal((signaled, sig) => {
    const code = signaled.pid === handle.pid ? SIGNAL_EXIT_CODE[sig] : undefined;
    if (code !== undefined) handle.kill(code);
  });
  const abort = () => handle.kill(130);
  ctx.signal?.addEventListener('abort', abort, { once: true });
  if (ctx.signal?.aborted) abort(); // canceled between the check above and here
  try {
    const exitCode = await handle.exited;
    if (proc) pm?.exit(proc.pid, exitCode);
    if (overflow) {
      err.push(new TextEncoder().encode(`wasm: output exceeded ${limit} bytes; stopped\n`));
    }
    return {
      stdout: latin1(out),
      stderr: new TextDecoder().decode(concat(err)),
      exitCode,
      stdoutKind: 'bytes',
    };
  } finally {
    unsubscribe?.();
    ctx.signal?.removeEventListener('abort', abort);
  }
}

/** The process-table record (`ps`, `kill`), parented like a `node` realm's. */
function registerProcess(
  config: JshProcessConfig,
  argv: string[],
  cwd: string,
  env: Record<string, string>
): { pid: number } {
  return config.processManager.spawn({
    kind: 'wasm',
    argv,
    cwd,
    env,
    owner: config.owner,
    ppid: config.getParentPid?.(),
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
