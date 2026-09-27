/**
 * `wasm` — run an Emscripten program as a wasm-realm process (#3530): one
 * worker, stdio on kernel descriptors, files on the live VFS. Loaded lazily
 * by `wasm-command.ts`.
 *
 *   wasm [--argv0 NAME] [--module PATH] PROGRAM [ARGS...]
 *   wasm --list
 *
 * PROGRAM is the Emscripten glue, or the name of a command an installed
 * package provides (`wasm --list`). Its module sits next to it (`x.js` →
 * `x.wasm`, `x` → `x.wasm`) unless `--module` names it. The glue must be
 * linked with `-sENVIRONMENT` including `worker`. `--argv0` sets `argv[0]`
 * (the program of a multi-call binary such as coreutils); the default is
 * PROGRAM's base name.
 *
 * The program can spawn children (`posix_spawn`, `execve`): see `launch.ts`.
 * An abort or the output limit ends the whole process tree.
 */
import type { CommandContext } from 'just-bash';
import { bytesSource, FdTable, sinkFile } from '../../../kernel/wasm-realm/fd-table.js';
import type { WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import type { WasmCommand } from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { stdinAsLatin1 } from '../../just-bash-compat.js';
import { installedCommands, modulePath, WasmSession } from './launch.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE = 'usage: wasm [--argv0 NAME] [--module PATH] PROGRAM [ARGS...]\n       wasm --list\n';

const NO_SAB =
  'the wasm realm needs SharedArrayBuffer, which this page lacks (it is not cross-origin isolated)';

/** The shell's output limit when the context carries none (just-bash's default). */
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

interface Invocation {
  argv0?: string;
  module?: string;
  program: string;
  args: string[];
}

function parse(args: string[]): Invocation | undefined {
  const call: Partial<Invocation> = {};
  let i = 0;
  for (; args[i] === '--argv0' || args[i] === '--module'; i += 2) {
    const value = args[i + 1];
    if (value === undefined) return undefined;
    if (args[i] === '--argv0') call.argv0 = value;
    else call.module = value;
  }
  const program = args[i];
  if (!program || program.startsWith('-')) return undefined;
  return { ...call, program, args: args.slice(i + 1) };
}

function listing(commands: Map<string, WasmCommand>): string {
  const rows = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(0, ...rows.map((c) => c.name.length));
  return rows.map((c) => `${c.name.padEnd(width)}  ${c.pkg}\n`).join('');
}

/**
 * A bare PROGRAM that is no file in the working directory names an
 * installed command: run its glue and module with its `argv[0]`.
 */
async function resolveInstalled(
  ctx: CommandContext,
  session: WasmSession,
  call: Invocation
): Promise<Invocation> {
  if (call.program.includes('/')) return call;
  if (await ctx.fs.exists(ctx.fs.resolvePath(ctx.cwd, call.program))) return call;
  const command = (await session.commands()).get(call.program);
  if (!command) return call;
  return {
    argv0: call.argv0 ?? command.argv0,
    module: call.module ?? command.wasm,
    program: command.glue,
    args: call.args,
  };
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
  if (args[0] === '--list' && args.length === 1) {
    return { stdout: listing(await installedCommands(ctx)), stderr: '', exitCode: 0 };
  }
  const parsed = parse(args);
  if (!parsed) return { stdout: '', stderr: USAGE, exitCode: 2 };
  if (typeof SharedArrayBuffer !== 'function') {
    // Syscalls block in Atomics.wait on a shared buffer.
    return { stdout: '', stderr: `wasm: ${NO_SAB}\n`, exitCode: 126 };
  }

  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const session = new WasmSession(ctx, processConfig, (message) =>
    err.push(new TextEncoder().encode(`wasm: ${message}\n`))
  );
  const call = await resolveInstalled(ctx, session, parsed);
  const gluePath = ctx.fs.resolvePath(ctx.cwd, call.program);

  // The sinks never block, so a runaway producer (`yes`) is cut off at the
  // shell's output limit instead of filling memory.
  const limit = ctx.limits?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;
  let collected = 0;
  let overflow = false;
  const collect = (into: Uint8Array[]) => (bytes: Uint8Array) => {
    collected += bytes.length;
    if (collected > limit) {
      overflow = true;
      session.killAll(1);
      return;
    }
    into.push(bytes);
  };
  const fds = new FdTable();
  fds.install(bytesSource(stdinBytes(ctx)));
  fds.install(sinkFile(collect(out)));
  fds.install(sinkFile(collect(err)));

  let handle: WasmProcessHandle;
  try {
    handle = await session.launch({
      glue: gluePath,
      module: call.module ? ctx.fs.resolvePath(ctx.cwd, call.module) : modulePath(gluePath),
      argv0: call.argv0 ?? gluePath.slice(gluePath.lastIndexOf('/') + 1).replace(/\.js$/, ''),
      args: call.args,
      env: ctx.exportedEnv ?? Object.fromEntries(ctx.env),
      cwd: ctx.cwd,
      fds,
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
    const message = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `wasm: ${call.program}: ${message}\n`, exitCode: 127 };
  }

  const abort = () => session.killAll(130);
  ctx.signal?.addEventListener('abort', abort, { once: true });
  if (ctx.signal?.aborted) abort(); // canceled between the launch and here
  try {
    const exitCode = await handle.exited;
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
    ctx.signal?.removeEventListener('abort', abort);
  }
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
