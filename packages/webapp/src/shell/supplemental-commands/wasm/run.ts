import type { CommandContext } from 'just-bash';
import { bytesSource, FdTable, sinkFile } from '../../../kernel/wasm-realm/fd-table.js';
import type { WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import { KernelTty } from '../../../kernel/wasm-realm/tty.js';
import type { WasmCommand } from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { stdinAsLatin1 } from '../../just-bash-compat.js';
import type { TerminalLease, TerminalPort } from '../../terminal-port.js';
import { installedCommands, modulePath, WasmSession } from './launch.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE =
  'usage: wasm [-t] [--argv0 NAME] [--module PATH] PROGRAM [ARGS...]\n       wasm --list\n';

const NO_SAB =
  'the wasm realm needs SharedArrayBuffer, which this page lacks (it is not cross-origin isolated)';

const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

interface Invocation {
  argv0?: string;
  module?: string;

  tty?: boolean;
  program: string;
  args: string[];
}

function parse(args: string[]): Invocation | undefined {
  const call: Partial<Invocation> = {};
  let i = 0;
  for (;;) {
    if (args[i] === '-t') {
      call.tty = true;
      i += 1;
      continue;
    }
    if (args[i] !== '--argv0' && args[i] !== '--module') break;
    const value = args[i + 1];
    if (value === undefined) return undefined;
    if (args[i] === '--argv0') call.argv0 = value;
    else call.module = value;
    i += 2;
  }
  const program = args[i];
  if (!program || program.startsWith('-')) return undefined;
  return { ...call, program, args: args.slice(i + 1) };
}

interface Stdio {
  fds: FdTable;

  collected(): { stdout: string; note: string };
  release(): void;
}

function pipedStdio(ctx: CommandContext, session: WasmSession, err: Uint8Array[]): Stdio {
  const out: Uint8Array[] = [];

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
  return {
    fds,
    collected: () => ({
      stdout: latin1(out),
      note: overflow ? `wasm: output exceeded ${limit} bytes; stopped\n` : '',
    }),
    release: () => {},
  };
}

function terminalStdio(lease: TerminalLease, session: WasmSession): Stdio {
  const tty = new KernelTty({ write: (bytes) => lease.write(bytes) }, (sig) =>
    session.signalAll(sig)
  );
  tty.setSize(lease.cols, lease.rows);
  lease.onInput((bytes) => tty.receive(bytes));
  lease.onResize((cols, rows) => tty.resize(cols, rows));
  const file = tty.file();
  const fds = new FdTable();
  fds.installAt(0, file);
  fds.installAt(1, file.retain());
  fds.installAt(2, file.retain());
  return { fds, collected: () => ({ stdout: '', note: '' }), release: () => lease.release() };
}

function listing(commands: Map<string, WasmCommand>): string {
  const rows = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(0, ...rows.map((c) => c.name.length));
  return rows.map((c) => `${c.name.padEnd(width)}  ${c.pkg}\n`).join('');
}

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
    ...call,
    argv0: call.argv0 ?? command.argv0,
    module: call.module ?? command.wasm,
    program: command.glue,
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
  processConfig?: JshProcessConfig,
  terminal?: TerminalPort
): Promise<Result> {
  if (args[0] === '--help' || args[0] === '-h') return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (args[0] === '--list' && args.length === 1) {
    return { stdout: listing(await installedCommands(ctx)), stderr: '', exitCode: 0 };
  }
  const parsed = parse(args);
  if (!parsed) return { stdout: '', stderr: USAGE, exitCode: 2 };
  if (typeof SharedArrayBuffer !== 'function') {
    return { stdout: '', stderr: `wasm: ${NO_SAB}\n`, exitCode: 126 };
  }

  const err: Uint8Array[] = [];
  const session = new WasmSession(ctx, processConfig, (message) =>
    err.push(new TextEncoder().encode(`wasm: ${message}\n`))
  );
  const call = await resolveInstalled(ctx, session, parsed);
  const gluePath = ctx.fs.resolvePath(ctx.cwd, call.program);

  let stdio: Stdio;
  if (call.tty) {
    const lease = terminal?.lease();
    if (!lease) {
      return {
        stdout: '',
        stderr: 'wasm: -t: no terminal to lend (only the panel terminal has one)\n',
        exitCode: 1,
      };
    }
    stdio = terminalStdio(lease, session);
  } else {
    stdio = pipedStdio(ctx, session, err);
  }
  const { fds } = stdio;

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
    stdio.release();
    if (ctx.signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
    const message = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `wasm: ${call.program}: ${message}\n`, exitCode: 127 };
  }

  const abort = () => session.killAll(130);
  ctx.signal?.addEventListener('abort', abort, { once: true });
  if (ctx.signal?.aborted) abort();
  try {
    const exitCode = await handle.exited;
    const { stdout, note } = stdio.collected();
    if (note) err.push(new TextEncoder().encode(note));
    return {
      stdout,
      stderr: new TextDecoder().decode(concat(err)),
      exitCode,
      stdoutKind: 'bytes',
    };
  } finally {
    stdio.release();
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
