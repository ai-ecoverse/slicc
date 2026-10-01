/**
 * `wasm` — run an Emscripten program as a wasm-realm process (#3530): one
 * worker, stdio on kernel descriptors, files on the live VFS. Loaded lazily
 * by `wasm-command.ts`.
 *
 *   wasm [--argv0 NAME] [--module PATH] [--listen [HOST:]PORT] PROGRAM [ARGS...]
 *   wasm --list
 *   wasm --login
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
import { LOGIN_PROMPT_COMMAND, LOGIN_RC, LOGIN_RC_FD } from '../../../kernel/login-shell-marks.js';
import {
  bytesSource,
  FdTable,
  type OpenFile,
  sinkFile,
} from '../../../kernel/wasm-realm/fd-table.js';
import type { WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import {
  ensureRealmCaFile,
  ensureRealmGitConfig,
  type GitIdentity,
  isRealmDefault,
  realmCaPath,
  realmGitConfigPath,
  realmNetworkEnv,
} from '../../../kernel/wasm-realm/net/realm-network.js';
import { ownerKey, type SockAddr } from '../../../kernel/wasm-realm/socket.js';
import { KernelTty } from '../../../kernel/wasm-realm/tty.js';
import type { WasmCommand } from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { stdinAsLatin1 } from '../../just-bash-compat.js';
import type { TerminalLease, TerminalPort } from '../../terminal-port.js';
import { NO_LOGIN_SHELL } from '../../terminal-protocol.js';
import {
  type InstalledCommandsLookup,
  installedCommands,
  isModuleFile,
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
  'usage: wasm [-t] [--argv0 NAME] [--module PATH] [--listen [HOST:]PORT] PROGRAM [ARGS...]\n       wasm --list\n       wasm --login\n';

const NO_SAB =
  'the wasm realm needs SharedArrayBuffer, which this page lacks (it is not cross-origin isolated)';

/** The shell's output limit when the context carries none (just-bash's default). */
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

interface Invocation {
  argv0?: string;
  module?: string;
  /** `-t`: run on the panel terminal (a TTY), interactively. */
  tty?: boolean;
  /** The panel terminal's login shell (`--login`): a prompt that looks like slicc's. */
  login?: boolean;
  program: string;
  args: string[];
  /** The installed command's environment defaults (its manifest's `env`). */
  defaults?: Readonly<Record<string, string>>;
  /** `--listen [HOST:]PORT`: a listening socket the program starts with. */
  listen?: string;
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
    if (args[i] !== '--argv0' && args[i] !== '--module' && args[i] !== '--listen') break;
    const value = args[i + 1];
    if (value === undefined) return undefined;
    if (args[i] === '--argv0') call.argv0 = value;
    else if (args[i] === '--listen') call.listen = value;
    else call.module = value;
    i += 2;
  }
  const program = args[i];
  if (!program || program.startsWith('-')) return undefined;
  return { ...call, program, args: args.slice(i + 1) };
}

/** The program's fds 0-2, and what they leave for the command's result. */
interface Stdio {
  fds: FdTable;
  /** The command's stdout, and a note to add to stderr. */
  collected(): { stdout: string; note: string };
  release(): void;
}

/** How the `wasm` command, or a shell running its commands on GNU bash, runs a program. */
export interface RunWasmOptions {
  /** Registers each process in the process table (`ps`, `kill`). */
  processConfig?: JshProcessConfig;
  /** The panel terminal, for `-t`. */
  terminal?: TerminalPort;
  /** Asked before any program a process spawns runs natively (the shell's command policy). */
  gate?: NativeGate;
  /** Output as it is written (piped stdio): the caller's live tee. */
  onOutput?: (text: string) => void;
  /**
   * Descriptors beyond 0-2 the program starts with, by number:
   * close-on-exec, so they stay the program's own and never reach what it runs.
   */
  fds?: ReadonlyArray<readonly [number, OpenFile]>;
  /** The installed command's env defaults, when the shell dispatched it by name. */
  defaults?: Readonly<Record<string, string>>;
  /** The installed commands as the shell's catalog knows them (else scanned per invocation). */
  commands?: InstalledCommandsLookup;
  /** The identity SLICC's `git` commits with, for native git's system config. */
  gitIdentity?: () => Promise<GitIdentity | undefined>;
}

/** The installed commands: the shell's catalog when it gave one, else a scan. */
function installed(
  ctx: CommandContext,
  options: RunWasmOptions
): Promise<Map<string, WasmCommand>> {
  return options.commands?.() ?? installedCommands(ctx);
}

/** A tee of the bytes written, decoded as UTF-8 per stream. */
function teeing(onOutput: ((text: string) => void) | undefined): (bytes: Uint8Array) => void {
  if (!onOutput) return () => {};
  const decoder = new TextDecoder();
  return (bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (text) onOutput(text);
  };
}

/** Stdin from the command, stdout/stderr collected (cut off at the output limit). */
function pipedStdio(
  ctx: CommandContext,
  session: WasmSession,
  err: Uint8Array[],
  onOutput?: (text: string) => void
): Stdio {
  const out: Uint8Array[] = [];
  // The sinks never block, so a runaway producer (`yes`) is cut off at the
  // shell's output limit instead of filling memory.
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

/**
 * fds 0-2 on a TTY over the leased panel terminal: keystrokes go through its
 * line discipline, ^C / ^Z / a resize signal the invocation's processes (the
 * foreground job), output reaches the screen as it is written.
 */
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

/**
 * A program's exported environment (what GNU bash reports after a run) without
 * the realm defaults it was only given, so they do not become the shell's own
 * exports; a name the shell already had (`had`) stays.
 */
export function withoutRealmDefaults(
  env: Readonly<Record<string, string>>,
  had: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => name in had || !isRealmDefault(name, value))
  );
}

/**
 * The owner's CA certificate, written under its home, and the variables that
 * point curl, libcurl and git at it (none when it cannot be had).
 */
async function caEnv(
  ctx: CommandContext,
  options: RunWasmOptions
): Promise<Record<string, string>> {
  const owner = ownerKey(options.processConfig?.owner);
  return ensureRealmCaFile(ctx.fs, realmCaPath(homeOf(ctx), owner), owner);
}

function homeOf(ctx: CommandContext): string {
  return ctx.exportedEnv?.HOME ?? ctx.env.get('HOME') ?? '/tmp';
}

/**
 * Native git's system config, written under the home: the credential helper
 * and SLICC's git identity (none when that cannot be had).
 */
async function gitEnv(
  ctx: CommandContext,
  options: RunWasmOptions
): Promise<Record<string, string>> {
  const identity = await options.gitIdentity?.().catch(() => undefined);
  return ensureRealmGitConfig(ctx.fs, realmGitConfigPath(homeOf(ctx)), identity);
}

/**
 * The program's environment: the realm's defaults (the proxy, the CA bundle
 * and git's system config, see `realm-network.ts`) under the shell's exports.
 * On the panel terminal, which is Ghostty's VT core, a `TERM` that is unset or `dumb` becomes
 * `xterm-256color` (with `COLORTERM=truecolor`), so curses programs use it.
 */
function programEnv(
  ctx: CommandContext,
  call: Invocation,
  network: Record<string, string>
): Record<string, string> {
  const env = { ...network, ...(ctx.exportedEnv ?? Object.fromEntries(ctx.env)) };
  if (call.tty && (!env.TERM || env.TERM === 'dumb')) {
    env.TERM = 'xterm-256color';
    env.COLORTERM ??= 'truecolor';
  }
  // The working directory and a `$`, as the slicc prompt shows.
  if (call.login) {
    env.PS1 ??= '\\w $ ';
    // Marks each prompt with the last status: how the panel collects the
    // result of a command it types into the shell (`login-shell-marks.ts`).
    env.PROMPT_COMMAND ??= LOGIN_PROMPT_COMMAND;
  }
  return env;
}

/**
 * The panel terminal's login shell: GNU bash (`bash -i`, on the slicc
 * shell's environment, which has sourced `~/.profile`) on the terminal, when a package provides it and the shell
 * has not opted out (`SLICC_SHELL=just-bash`). Otherwise nothing, with
 * {@link NO_LOGIN_SHELL}, and the panel keeps its own prompt.
 */
async function loginShell(ctx: CommandContext, options: RunWasmOptions): Promise<Result> {
  const none = { stdout: '', stderr: '', exitCode: NO_LOGIN_SHELL };
  const choice = ctx.exportedEnv?.SLICC_SHELL ?? ctx.env.get('SLICC_SHELL');
  if (choice === 'just-bash' || !options.terminal || typeof SharedArrayBuffer !== 'function') {
    return none;
  }
  if (!(await installed(ctx, options)).has('bash')) return none;
  // Not a login bash (-l): the environment is already the slicc shell's,
  // which sourced ~/.profile; reading it again would repeat its effects.
  // Its rc comes on a private descriptor, not from a file: any file bash
  // could read, another scoop could write (`/tmp`).
  const rc = bytesSource(new TextEncoder().encode(LOGIN_RC));
  const args = ['-t', '--login-prompt', 'bash', '--rcfile', `/dev/fd/${LOGIN_RC_FD}`, '-i'];
  return runWasmCommand(args, ctx, { ...options, fds: [[LOGIN_RC_FD, rc]] });
}

function listing(commands: Map<string, WasmCommand>): string {
  const rows = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(0, ...rows.map((c) => c.name.length));
  return rows.map((c) => `${c.name.padEnd(width)}  ${c.pkg}\n`).join('');
}

/**
 * Why a script command cannot run, as bash says it: its `#!` interpreter is
 * no program here (`autoreconf: /usr/bin/perl: bad interpreter`, until a
 * Perl package is installed), or it has no `#!` line at all.
 */
async function badScript(ctx: CommandContext, name: string, script: string): Promise<string> {
  let head = '';
  try {
    head = (await ctx.fs.readFile(script)).split('\n', 1)[0] ?? '';
  } catch {
    return `${name}: ${script}: No such file or directory`;
  }
  if (!head.startsWith('#!')) return `${name}: ${script}: no #! line naming its interpreter`;
  const interp =
    head
      .slice(2)
      .trim()
      .split(/[ \t]+/)[0] ?? '';
  return `${name}: ${interp}: bad interpreter: No such file or directory`;
}

/**
 * A bare PROGRAM that is no file in the working directory names an
 * installed command: run its glue and module with its `argv[0]` — or, for a
 * script command (`cc`), its interpreter with the script. A script command
 * whose interpreter cannot run is an error (exit 127, as bash on Linux), not
 * a program to look for in the working directory.
 */
async function resolveInstalled(
  ctx: CommandContext,
  session: WasmSession,
  call: Invocation
): Promise<Invocation | { error: string }> {
  if (call.program.includes('/')) return call;
  if (await ctx.fs.exists(ctx.fs.resolvePath(ctx.cwd, call.program))) return call;
  const command = (await session.commands()).get(call.program);
  if (!command) return call;
  if (command.script) {
    const run = await session.interpreted({
      file: call.program,
      argv: [call.program, ...call.args],
      cwd: ctx.cwd,
    });
    if (!run) return { error: await badScript(ctx, call.program, command.script) };
    return {
      ...call,
      argv0: run.target.argv0,
      module: run.target.module,
      program: run.target.glue,
      args: run.args,
      defaults: run.target.defaults,
    };
  }
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

/**
 * The module to run: `--module`, else PROGRAM itself when it is a wasm module
 * (`wasm ./rg.wasm`: a WASI program, no glue), else the glue's `.wasm`.
 */
async function programModule(
  ctx: CommandContext,
  call: Invocation,
  gluePath: string
): Promise<string> {
  if (call.module) return ctx.fs.resolvePath(ctx.cwd, call.module);
  return (await isModuleFile(ctx, gluePath)) ? gluePath : modulePath(gluePath);
}

/** musl's O_NONBLOCK: a `--listen` listener's status flags. */
const O_NONBLOCK = 0o4000;

/** `[HOST:]PORT` as a loopback address (HOST defaults to 127.0.0.1), or undefined when it is none. */
export function listenAddress(spec: string): SockAddr | undefined {
  const m = /^(?:([0-9.]+):)?(\d{1,5})$/.exec(spec);
  const port = m ? Number(m[2]) : 0;
  if (!m || port < 1 || port > 65535) return undefined;
  return { family: 'inet', host: m[1] ?? '127.0.0.1', port };
}

/**
 * `--listen`: a listening socket at the program's lowest free fd,
 * non-blocking, and the env naming it (a WASI program's host moves it above its preopens and says
 * so itself); an error message when the address is bad or taken.
 */
function listenOn(
  call: Invocation,
  session: WasmSession,
  fds: FdTable
): { env: Record<string, string> } | { error: string } {
  if (call.listen === undefined) return { env: {} };
  const addr = listenAddress(call.listen);
  if (!addr) return { error: `--listen ${call.listen}: not a [HOST:]PORT\n` };
  try {
    const fd = fds.install(session.listen(addr), 3);
    // Non-blocking from the start, as Go's netpoll needs to accept on it.
    fds.setStatusFlags(fd, O_NONBLOCK);
    return { env: { SLICC_LISTEN_FDS: String(fd) } };
  } catch (e) {
    const code = (e as { code?: string }).code ?? String(e);
    return { error: `--listen ${call.listen}: ${code}\n` };
  }
}

/** The program's env defaults: its installed command's, as looked up or as the shell dispatched it. */
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
    // Syscalls block in Atomics.wait on a shared buffer.
    return { stdout: '', stderr: `wasm: ${NO_SAB}\n`, exitCode: 126 };
  }

  const err: Uint8Array[] = [];
  // A process's crash diagnostic goes with the command's stderr; on a
  // terminal (-t) straight to the screen, since the session may run for
  // hours and its stderr is only seen at the end, if at all.
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
  // 127: Linux's execve answers ENOENT for a missing interpreter, which bash
  // (5.1+) reports as not found; 126 is for one found but not executable.
  if ('error' in call) return { stdout: '', stderr: `${call.error}\n`, exitCode: 127 };
  const gluePath = ctx.fs.resolvePath(ctx.cwd, call.program);
  const modulePathOf = await programModule(ctx, call, gluePath);

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
  const listening = listenOn(call, session, fds);
  if ('error' in listening) {
    stdio.release();
    await fds.closeAll();
    return { stdout: '', stderr: `wasm: ${listening.error}`, exitCode: 1 };
  }

  let handle: WasmProcessHandle;
  try {
    handle = await session.launch({
      glue: gluePath,
      module: modulePathOf,
      argv0:
        call.argv0 ?? gluePath.slice(gluePath.lastIndexOf('/') + 1).replace(/\.(js|wasm)$/, ''),
      args: call.args,
      env: {
        ...programEnv(ctx, call, {
          ...realmNetworkEnv(),
          ...(await caEnv(ctx, options)),
          ...(await gitEnv(ctx, options)),
        }),
        // Where the listener is, whatever the shell exports.
        ...listening.env,
      },
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
  if (ctx.signal?.aborted) abort(); // canceled between the launch and here
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
