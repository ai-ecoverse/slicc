import type { CommandContext } from 'just-bash';
import { LOGIN_PROMPT_COMMAND, LOGIN_RC, LOGIN_RC_FD } from '../../../kernel/login-shell-marks.js';
import {
  bytesSource,
  FdTable,
  type OpenFile,
  sinkFile,
} from '../../../kernel/wasm-realm/fd-table.js';
import type { WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import { realmNetworkEnv } from '../../../kernel/wasm-realm/net/realm-network.js';
import { KernelTty } from '../../../kernel/wasm-realm/tty.js';
import type { WasmCommand } from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { stdinAsLatin1 } from '../../just-bash-compat.js';
import type { TerminalLease, TerminalPort } from '../../terminal-port.js';
import { NO_LOGIN_SHELL } from '../../terminal-protocol.js';
import {
  type InstalledCommandsLookup,
  installedCommands,
  modulePath,
  type NativeGate,
  WasmSession,
} from './launch.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE =
  'usage: wasm [-t] [--argv0 NAME] [--module PATH] PROGRAM [ARGS...]\n       wasm --list\n       wasm --login\n';

const NO_SAB =
  'the wasm realm needs SharedArrayBuffer, which this page lacks (it is not cross-origin isolated)';

const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

interface Invocation {
  argv0?: string;
  module?: string;

  tty?: boolean;

  login?: boolean;
  program: string;
  args: string[];

  defaults?: Readonly<Record<string, string>>;
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
    if (args[i] === '--login-prompt') {
      call.login = true;
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

export interface RunWasmOptions {
  processConfig?: JshProcessConfig;

  terminal?: TerminalPort;

  gate?: NativeGate;

  onOutput?: (text: string) => void;

  fds?: ReadonlyArray<readonly [number, OpenFile]>;

  defaults?: Readonly<Record<string, string>>;

  commands?: InstalledCommandsLookup;
}

function installed(
  ctx: CommandContext,
  options: RunWasmOptions
): Promise<Map<string, WasmCommand>> {
  return options.commands?.() ?? installedCommands(ctx);
}

function teeing(onOutput: ((text: string) => void) | undefined): (bytes: Uint8Array) => void {
  if (!onOutput) return () => {};
  const decoder = new TextDecoder();
  return (bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (text) onOutput(text);
  };
}

function pipedStdio(
  ctx: CommandContext,
  session: WasmSession,
  err: Uint8Array[],
  onOutput?: (text: string) => void
): Stdio {
  const out: Uint8Array[] = [];

  const limit = ctx.limits?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;
  let collected = 0;
  let overflow = false;
  const collect = (into: Uint8Array[], tee: (bytes: Uint8Array) => void) => (bytes: Uint8Array) => {
    collected += bytes.length;
    if (collected > limit) {
      overflow = true;
      session.killAll(1);
      return;
    }
    into.push(bytes);
    tee(bytes);
  };
  const fds = new FdTable();
  fds.install(bytesSource(stdinBytes(ctx)));
  fds.install(sinkFile(collect(out, teeing(onOutput))));
  fds.install(sinkFile(collect(err, teeing(onOutput))));
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
  const tty: KernelTty = new KernelTty({ write: (bytes) => lease.write(bytes) }, (sig) =>
    session.signalTerminal(tty, sig)
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

function programEnv(ctx: CommandContext, call: Invocation): Record<string, string> {
  const env = { ...realmNetworkEnv(), ...(ctx.exportedEnv ?? Object.fromEntries(ctx.env)) };
  if (call.tty && (!env.TERM || env.TERM === 'dumb')) {
    env.TERM = 'xterm-256color';
    env.COLORTERM ??= 'truecolor';
  }

  if (call.login) {
    env.PS1 ??= '\\w $ ';

    env.PROMPT_COMMAND ??= LOGIN_PROMPT_COMMAND;
  }
  return env;
}

async function loginShell(ctx: CommandContext, options: RunWasmOptions): Promise<Result> {
  const none = { stdout: '', stderr: '', exitCode: NO_LOGIN_SHELL };
  const choice = ctx.exportedEnv?.SLICC_SHELL ?? ctx.env.get('SLICC_SHELL');
  if (choice === 'just-bash' || !options.terminal || typeof SharedArrayBuffer !== 'function') {
    return none;
  }
  if (!(await installed(ctx, options)).has('bash')) return none;

  const rc = bytesSource(new TextEncoder().encode(LOGIN_RC));
  const args = ['-t', '--login-prompt', 'bash', '--rcfile', `/dev/fd/${LOGIN_RC_FD}`, '-i'];
  return runWasmCommand(args, ctx, { ...options, fds: [[LOGIN_RC_FD, rc]] });
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
    defaults: command.env,
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

function programDefaults(
  call: Invocation,
  options: RunWasmOptions
): Readonly<Record<string, string>> | undefined {
  return call.defaults ?? options.defaults;
}

export async function runWasmCommand(
  args: string[],
  ctx: CommandContext,
  options: RunWasmOptions = {}
): Promise<Result> {
  const { processConfig, terminal } = options;
  if (args[0] === '--help' || args[0] === '-h') return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (args[0] === '--login' && args.length === 1) return loginShell(ctx, options);
  if (args[0] === '--list' && args.length === 1) {
    return { stdout: listing(await installed(ctx, options)), stderr: '', exitCode: 0 };
  }
  const parsed = parse(args);
  if (!parsed) return { stdout: '', stderr: USAGE, exitCode: 2 };
  if (typeof SharedArrayBuffer !== 'function') {
    return { stdout: '', stderr: `wasm: ${NO_SAB}\n`, exitCode: 126 };
  }

  const err: Uint8Array[] = [];

  let report = (message: string): void => {
    err.push(new TextEncoder().encode(`wasm: ${message}\n`));
  };
  const session = new WasmSession(
    ctx,
    processConfig,
    (message) => report(message),
    options.gate,
    options.commands
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
    report = (message) => lease.write(new TextEncoder().encode(`wasm: ${message}\r\n`));
  } else {
    stdio = pipedStdio(ctx, session, err, options.onOutput);
  }
  for (const [fd, file] of options.fds ?? []) {
    stdio.fds.installAt(fd, file);
    stdio.fds.setCloseOnExec(fd);
  }
  const { fds } = stdio;

  let handle: WasmProcessHandle;
  try {
    handle = await session.launch({
      glue: gluePath,
      module: call.module ? ctx.fs.resolvePath(ctx.cwd, call.module) : modulePath(gluePath),
      argv0: call.argv0 ?? gluePath.slice(gluePath.lastIndexOf('/') + 1).replace(/\.js$/, ''),
      args: call.args,
      env: programEnv(ctx, call),
      defaults: programDefaults(call, options),
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
