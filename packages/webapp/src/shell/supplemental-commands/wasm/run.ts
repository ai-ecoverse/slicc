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
import { stdinAsLatin1 } from '../../just-bash-compat.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE = 'usage: wasm [--argv0 NAME] PROGRAM [ARGS...]\n';

/** Compiled modules, keyed by path, size and mtime: a rebuilt program recompiles. */
const modules = new Map<string, Promise<WebAssembly.Module>>();

/** Pids of wasm processes started by this command (process-table integration: Phase 2). */
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

export async function runWasmCommand(args: string[], ctx: CommandContext): Promise<Result> {
  if (args[0] === '--help' || args[0] === '-h') return { stdout: USAGE, stderr: '', exitCode: 0 };
  const call = parse(args);
  if (!call) return { stdout: '', stderr: USAGE, exitCode: 2 };
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

  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const fds = new FdTable();
  fds.install(bytesSource(stdinBytes(ctx)));
  fds.install(sinkFile((b) => out.push(b)));
  fds.install(sinkFile((b) => err.push(b)));
  const handle = spawnWasmProcess({
    pid: nextPid++,
    program: { glue, module },
    argv0: call.argv0 ?? gluePath.slice(gluePath.lastIndexOf('/') + 1).replace(/\.js$/, ''),
    args: call.args,
    env: ctx.exportedEnv ?? Object.fromEntries(ctx.env),
    cwd: ctx.cwd,
    fds,
    fs: ctx.fs,
    onError: (message) => err.push(new TextEncoder().encode(`wasm: ${message}\n`)),
  });
  const abort = () => handle.kill(130);
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    const exitCode = await handle.exited;
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
