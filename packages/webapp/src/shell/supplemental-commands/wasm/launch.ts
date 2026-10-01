/**
 * `launch.ts` — start wasm-realm processes for one `wasm` invocation (#3530):
 * the program the command runs and every child it spawns.
 *
 * A {@link WasmSession} owns what the processes of one invocation share: the
 * command's gated filesystem, its process-table parentage, the compiled-module
 * cache, and the installed-command index (scanned once per invocation). Each
 * process gets a spawner that resolves a child's program:
 *
 * - a bare name (or `/usr/bin/<name>`) that an installed package provides, or
 *   a path whose module sits beside it, runs as another wasm-realm process —
 *   concurrently, on the descriptors the kernel built from its parent's;
 * - anything else runs through the shell (`ctx.exec`): its stdin is read to
 *   the end first and its output is written to its descriptors when it is done.
 */
import type { CommandContext } from 'just-bash';
import { compileWasmFromVfs, compileWasmModule } from '../../../kernel/realm/wasm-compiler.js';
import {
  type ChildForker,
  type ChildHandle,
  type ChildSpawner,
  type ChildSpawnRequest,
  SpawnError,
} from '../../../kernel/wasm-realm/children.js';
import { type FdTable, KernelError, OpenFile } from '../../../kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess, type WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import { JobTable } from '../../../kernel/wasm-realm/jobs.js';
import {
  enableRealmNetwork,
  isRealmDefault,
} from '../../../kernel/wasm-realm/net/realm-network.js';
import type { ForkState, WasmProgram } from '../../../kernel/wasm-realm/protocol.js';
import { defaultAction, SIGNAL_BY_NAME } from '../../../kernel/wasm-realm/signals.js';
import {
  type LoopbackNet,
  loopbackNet,
  ownerKey,
  type SockAddr,
} from '../../../kernel/wasm-realm/socket.js';
import type { KernelTty } from '../../../kernel/wasm-realm/tty.js';
import {
  type ImportedMemory,
  importedMemory,
} from '../../../kernel/wasm-realm/wasi/wasi-module.js';
import { GLOBAL_NODE_MODULES } from '../../ipk/global-prefix.js';
import { ensurePth, type PthFs, type PythonBlock, pythonOf } from '../../ipk/python-packages.js';
import {
  type ProgramFs,
  scanPythonPackages,
  scanWasmCommands,
  type WasmCommand,
} from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';
import { STDIN_ISATTY_ENV, STDOUT_ISATTY_ENV } from '../stdio-tty.js';

/**
 * GNU bash's `secret`: the slicc command, then (when it succeeded) the line
 * `secret shell-env` gives for it, so a `secret set` / `secret delete` keeps
 * `$NAME` in step in the running shell itself, as `export` would, not only in
 * slicc's shell, which a bash that is already running never hears from. It is
 * an exported function (bash imports `BASH_FUNC_<name>%%` from its
 * environment), so the panel's login shell, the agent's `bash -c` and a bash
 * a script starts all have it; `command secret` is the plain command. In a
 * pipeline stage (`echo v | secret set …`) it runs in a subshell, as any
 * function does, and the export ends with it.
 */
export const SECRET_FUNCTION_ENV = 'BASH_FUNC_secret%%';
export const SECRET_FUNCTION =
  '() { command secret "$@" || return; local __slicc_env; ' +
  'if __slicc_env=$(command secret shell-env "$@" 2>/dev/null); then eval "$__slicc_env"; fi; return 0; }';

/**
 * A process's environment, with GNU bash's `secret` function when the
 * process is bash (as `bash` or `sh`): every one, the command's own or one a
 * program starts (make's recipe shell), unless its environment has one.
 */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Defaults with each `${NAME}` replaced by the caller's `NAME`, so a package
 * can put a cache under the user's home (`${HOME}/.cache/zig`). A default
 * that names a variable the caller has not set is left out: the program's
 * own default beats a path missing its first part.
 */
export function expandDefaults(
  defaults: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    let missing = false;
    const expanded = value.replace(ENV_REFERENCE, (_, name: string) => {
      // Own variables only: `${toString}` names no environment variable.
      const set = Object.hasOwn(env, name) ? env[name] : undefined;
      if (set === undefined) missing = true;
      return set ?? '';
    });
    if (!missing) out[key] = expanded;
  }
  return out;
}

/**
 * A command's environment defaults under the caller's environment, which wins.
 * A package's `GIT_CONFIG_NOSYSTEM` would also switch off the system config
 * the realm points git at (its credential helper and SLICC's identity), so
 * it does not apply over that one; exported, it does.
 */
function withDefaults(
  given: Readonly<Record<string, string>> | undefined,
  env: Record<string, string>
): Record<string, string> {
  if (!given) return env;
  const defaults = expandDefaults(given, env);
  const realmGitConfig =
    env.GIT_CONFIG_SYSTEM !== undefined &&
    isRealmDefault('GIT_CONFIG_SYSTEM', env.GIT_CONFIG_SYSTEM);
  if (!realmGitConfig || !('GIT_CONFIG_NOSYSTEM' in defaults)) return { ...defaults, ...env };
  const { GIT_CONFIG_NOSYSTEM: _off, ...rest } = defaults;
  return { ...rest, ...env };
}

/**
 * `LOGNAME` follows `USER` unless the caller set one: the shell exports only
 * `USER`, and an Emscripten program otherwise keeps its runtime's default
 * `LOGNAME=web_user` — which GNU bash then exports to every program it
 * starts, and which `getpass.getuser()` reads before `USER`.
 */
function withLogname(env: Record<string, string>): Record<string, string> {
  if (env.USER === undefined || 'LOGNAME' in env) return env;
  return { ...env, LOGNAME: env.USER };
}

function withSecretFunction(argv0: string, env: Record<string, string>): Record<string, string> {
  if (!/^(ba)?sh$/.test(baseName(argv0)) || SECRET_FUNCTION_ENV in env) return env;
  return { ...env, [SECRET_FUNCTION_ENV]: SECRET_FUNCTION };
}

/** Compiled modules, keyed by path, size and mtime: a rebuilt program recompiles. */
const modules = new Map<string, Promise<WebAssembly.Module>>();
/** The memory a WASI module imports (WASIX's shared `env.memory`), by the same key, read with its bytes. */
const memories = new Map<string, ImportedMemory | undefined>();

/** The process manager's signal names, by number (what `kill()` from a program can reach there). */
const SIGNAL_NAME = new Map(
  Object.entries(SIGNAL_BY_NAME).map(([name, sig]) => [sig, name as keyof typeof SIGNAL_BY_NAME])
);

/** A path into the shell's command registry: `/usr/bin/<name>` or its alias `/bin/<name>`. */
const REGISTRY_PATH = /^\/(?:usr\/)?bin\/([^/]+)$/;

/** The installed package a path lies in (`…/node_modules/[@scope/]name`). */
const PACKAGE_ROOT = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//;

/** The module an Emscripten glue loads (`locateFile("x.wasm")`). */
const LOCATED_MODULE = /locateFile\(\s*["']([^"'/]+\.wasm)["']\s*\)/;

/** How much of a script its `#!` line may take (Linux: 256 bytes). */
const SHEBANG_MAX = 256;

/** Pids when there is no process table (unit tests). */
let nextPid = 40000;

/**
 * The shell's command policy (allowed commands, sudo `Cmnd` rules) for a
 * program a wasm process spawns: a denial is what the program's run reports
 * instead (its message and exit code), `null` lets it run. A shell command
 * needs none: it runs through the shell, whose dispatch applies the policy.
 */
export type NativeGate = (
  name: string,
  args: string[],
  env: Record<string, string>
) => Promise<{ stderr: string; exitCode: number } | null>;

/** The installed wasm commands by name, as the shell's catalog knows them now. */
export type InstalledCommandsLookup = () => Promise<Map<string, WasmCommand>>;

/**
 * A wasm program to start: its glue and module paths and `argv[0]`. A WASI
 * program has no glue: its `glue` is its module (see {@link isWasiTarget}).
 */
export interface WasmTarget {
  glue: string;
  module: string;
  argv0: string;
  /** Fixed arguments declared by the installed command. */
  prefixArgs?: readonly string[];
  /**
   * The installed command's environment defaults (its manifest's `env`, e.g.
   * where ImageMagick keeps its configuration), under the caller's `env`.
   */
  defaults?: Readonly<Record<string, string>>;
}

export interface LaunchRequest extends WasmTarget {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The process's descriptors; it takes them over. */
  fds: FdTable;
  /** The parent process; the invocation's own parent when absent. */
  ppid?: number;
  /** Canceled while the program was read or compiled: it never starts. */
  signal?: AbortSignal;
}

interface StartRequest extends LaunchRequest {
  program: WasmProgram;
  fork?: ForkState;
}

/** A target with no glue of its own (its glue path is its module): a WASI program. */
export function isWasiTarget(target: Pick<WasmTarget, 'glue' | 'module'>): boolean {
  return target.glue === target.module;
}

/** The first bytes of every wasm module: `\0asm`. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function isWasmBytes(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

/** The glue's module: `x.js` → `x.wasm`, `x` → `x.wasm`. */
export function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
}

/** The command a program path names: `/usr/bin/rm` and `rm` are `rm`. */
function commandName(file: string): string {
  return REGISTRY_PATH.exec(file)?.[1] ?? baseName(file);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The installed-package scan over the command's filesystem. */
function programFs(ctx: CommandContext): ProgramFs {
  return {
    exists: (path) => ctx.fs.exists(path),
    readDir: async (path) => (await ctx.fs.readdir(path)).map((name) => ({ name })),
    readFile: (path) => ctx.fs.readFile(path),
  };
}

export function installedCommands(ctx: CommandContext): Promise<Map<string, WasmCommand>> {
  return scanWasmCommands(programFs(ctx), GLOBAL_NODE_MODULES);
}

function cacheKey(path: string, st: { size: number; mtime: Date }): string {
  return `${path}:${st.size}:${st.mtime.getTime()}`;
}

function cache(key: string, module: Promise<WebAssembly.Module>): Promise<WebAssembly.Module> {
  modules.set(key, module);
  module.catch(() => modules.delete(key));
  return module;
}

async function loadModule(ctx: CommandContext, path: string): Promise<WebAssembly.Module> {
  const key = cacheKey(path, await ctx.fs.stat(path));
  return (
    modules.get(key) ??
    cache(
      key,
      compileWasmFromVfs((p) => ctx.fs.readFileBuffer(p), path)
    )
  );
}

/**
 * Whether `path` is a wasm module itself (it starts with `\0asm`), which the
 * realm runs as a WASI program. What was read to tell is compiled into the
 * module cache, so the launch that follows reads nothing again.
 */
/** Compile WASI bytes into the cache, noting the memory the module imports. */
function cacheWasi(key: string, bytes: Uint8Array): Promise<WebAssembly.Module> {
  memories.set(key, importedMemory(bytes));
  return cache(key, compileWasmModule(bytes));
}

/** A WASI program's module and the memory it imports, read once and cached. */
async function loadWasi(
  ctx: CommandContext,
  path: string
): Promise<{ module: WebAssembly.Module; memory?: ImportedMemory }> {
  const key = cacheKey(path, await ctx.fs.stat(path));
  const cached = modules.get(key);
  const module = await (cached && memories.has(key)
    ? cached
    : cacheWasi(key, await ctx.fs.readFileBuffer(path)));
  const memory = memories.get(key);
  return { module, ...(memory ? { memory } : {}) };
}

export async function isModuleFile(ctx: CommandContext, path: string): Promise<boolean> {
  let key: string;
  try {
    const st = await ctx.fs.stat(path);
    if (!st.isFile) return false;
    key = cacheKey(path, st);
  } catch {
    return false;
  }
  if (modules.has(key)) return true;
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.readFileBuffer(path);
  } catch {
    return false;
  }
  if (!isWasmBytes(bytes)) return false;
  void cacheWasi(key, bytes).catch(() => undefined);
  return true;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Everything left to read on a descriptor (nothing when it is not readable). */
async function readAll(file: OpenFile): Promise<Uint8Array> {
  if (!file.file.read) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await file.file.read(65536); chunk.length > 0; ) {
    chunks.push(chunk);
    total += chunk.length;
    chunk = await file.file.read(65536);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Write to a descriptor, ignoring a reader that is gone (EPIPE) or a slot that is closed. */
async function writeAll(fds: FdTable, fd: number, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0 || !fds.has(fd)) return;
  const file = fds.get(fd).file;
  try {
    await file.write?.(bytes);
  } catch {
    /* EPIPE */
  }
}

function isTerminal(fds: FdTable, fd: number): boolean {
  return fds.has(fd) && fds.get(fd).file.tty !== undefined;
}

/** What a shell command learns of its stdio: `0` for a stdin / stdout that is no terminal. */
function ttyHints(fds: FdTable): Record<string, string> {
  return {
    ...(isTerminal(fds, 0) ? {} : { [STDIN_ISATTY_ENV]: '0' }),
    ...(isTerminal(fds, 1) ? {} : { [STDOUT_ISATTY_ENV]: '0' }),
  };
}

/** A wasm process as its parent's child table sees it. */
function childHandle(handle: WasmProcessHandle): ChildHandle {
  return {
    pid: handle.pid,
    exited: handle.exited,
    termsig: handle.termsig,
    onState: (listener) => handle.onState(listener),
  };
}

/** Python package scans, by the command catalog they were made for. */
const PYTHON_SCANS = new WeakMap<object, ReturnType<typeof scanPythonPackages>>();

export class WasmSession {
  private readonly live = new Set<WasmProcessHandle>();
  /** The running shell children: each one's abort ends it. */
  private readonly shellChildren = new Set<AbortController>();
  /** The session's processes by pid: kill(2) between them. */
  private readonly wasmByPid = new Map<number, WasmProcessHandle>();
  /** Signal a shell child: every signal whose default action ends a process ends it. */
  private readonly shellByPid = new Map<number, (sig: number) => void>();
  private installed: Promise<Map<string, WasmCommand>> | undefined;
  /** Process groups and sessions of the invocation's wasm processes (job control). */
  private readonly jobs = new JobTable();
  /** The invocation's first process: the terminal's foreground until a program picks one. */
  private leader: number | undefined;
  /**
   * The loopback network of the invocation's owner (the cone, one scoop): it
   * outlives the invocation, so a server another invocation runs (in the
   * panel's login shell, say) or a kernel service is reachable from this one.
   */
  private readonly net: LoopbackNet;

  constructor(
    private readonly ctx: CommandContext,
    private readonly processConfig: JshProcessConfig | undefined,
    private readonly onError: (message: string) => void,
    private readonly gate?: NativeGate,
    private readonly lookup?: InstalledCommandsLookup
  ) {
    this.net = loopbackNet(ownerKey(processConfig?.owner));
    // The owner's HTTP proxy, started by a program's first connection to it;
    // it terminates TLS with a leaf from the owner's CA.
    const owner = ownerKey(processConfig?.owner);
    enableRealmNetwork(this.net, { process: processConfig, tls: { owner } });
  }

  /**
   * The installed commands: the shell's catalog, which a package install or
   * removal refreshes (the terminal's login shell outlives both), else
   * scanned once per invocation.
   */
  commands(): Promise<Map<string, WasmCommand>> {
    if (this.lookup) return this.lookup();
    this.installed ??= installedCommands(this.ctx);
    return this.installed;
  }

  /** Start a program; rejects when its glue or module cannot be read or compiled. */
  async launch(req: LaunchRequest): Promise<WasmProcessHandle> {
    const wasi = isWasiTarget(req);
    let glue = '';
    let module: WebAssembly.Module;
    let memory: ImportedMemory | undefined;
    try {
      if (wasi) ({ module, memory } = await loadWasi(this.ctx, req.module));
      else {
        glue = await this.ctx.fs.readFile(req.glue);
        module = await loadModule(this.ctx, req.module);
      }
      req.signal?.throwIfAborted();
    } catch (e) {
      await req.fds.closeAll();
      throw e;
    }
    const env = withSecretFunction(req.argv0, withLogname(withDefaults(req.defaults, req.env)));
    if (wasi) await this.pythonPackages(req, env);
    return this.start({
      ...req,
      env,
      program: wasi
        ? { abi: 'wasi', glue, module, ...(memory ? { memory } : {}) }
        : { glue, module },
    });
  }

  /**
   * An installed Python interpreter (a package whose manifest has a
   * `slicc.python` version, abi and platform) starts with the installed
   * Python packages on its path: `_slicc_packages.pth` in its user site
   * (`python-packages.ts`). Never in the way of the start itself.
   */
  private async pythonPackages(req: LaunchRequest, env: Record<string, string>): Promise<void> {
    const root = PACKAGE_ROOT.exec(req.module)?.[1];
    if (!root) return;
    try {
      const fs = programFs(this.ctx);
      const raw = await fs.readFile(`${root}/package.json`, { encoding: 'utf-8' });
      const manifest = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      ) as {
        name?: unknown;
        slicc?: { python?: PythonBlock };
      };
      const name = typeof manifest.name === 'string' ? manifest.name : root;
      const interpreter = pythonOf(root, name, manifest.slicc?.python).interpreter;
      if (!interpreter) return;
      const { packages } = await this.pythonScan(fs);
      const skipped = await ensurePth(
        this.ctx.fs as PthFs,
        env.HOME ?? '/home',
        interpreter,
        packages
      );
      if (skipped.length > 0) {
        const tag = `${interpreter.abi}-${interpreter.platform}`;
        const note = `${req.argv0}: not for ${tag}, left off the path: ${skipped.map((p) => p.pkg).join(', ')}\n`;
        await writeAll(req.fds, 2, new TextEncoder().encode(note));
      }
    } catch {
      /* no manifest, an unwritable home: the interpreter starts without them */
    }
  }

  /**
   * The installed Python packages, scanned once per installed set: the
   * command catalog is replaced on an install or removal, and a new one
   * means a new scan.
   */
  private pythonScan(fs: ProgramFs): ReturnType<typeof scanPythonPackages> {
    return this.commands().then((catalog) => {
      let scan = PYTHON_SCANS.get(catalog);
      if (!scan) {
        scan = scanPythonPackages(fs, GLOBAL_NODE_MODULES);
        PYTHON_SCANS.set(catalog, scan);
      }
      return scan;
    });
  }

  /** Start a loaded program: a new process, or (with `fork`) a forked copy of its parent. */
  private start(req: StartRequest): WasmProcessHandle {
    const pm = this.processConfig?.processManager;
    const { pid } = this.register('wasm', [req.argv0, ...req.args], req.cwd, req.env, req.ppid);
    const terminal = req.fds.stdioTerminal();
    const handle = spawnWasmProcess({
      pid,
      program: req.program,
      argv0: req.argv0,
      args: req.args,
      env: req.env,
      cwd: req.cwd,
      fds: req.fds,
      fs: this.ctx.fs,
      onError: this.onError,
      spawner: this.spawner(pid),
      forker: this.forker(pid, req),
      kill: (target, sig) => this.kill(target, sig),
      jobs: this.jobs,
      net: this.net,
      ...(req.fork ? { fork: req.fork } : {}),
      ...(req.ppid !== undefined ? { ppid: req.ppid } : {}),
    });
    this.live.add(handle);
    this.wasmByPid.set(pid, handle);
    this.leader ??= pid;
    // The invocation's first process leads its session: the terminal it
    // starts on (`wasm -t`, the panel's login shell) is the session's `/dev/tty`.
    this.jobs.add(pid, req.ppid, (sig) => handle.signal(sig), terminal);
    // `kill` / `ps`: SIGKILL and uncaught signals end the worker; caught ones run the handler.
    const unsubscribe = pm?.onSignal((signaled, sig) => {
      if (signaled.pid === pid) handle.signal(SIGNAL_BY_NAME[sig]);
    });
    void handle.exited.then((code) => {
      this.live.delete(handle);
      this.wasmByPid.delete(pid);
      this.jobs.remove(pid);
      unsubscribe?.();
      if (this.processConfig) pm?.exit(pid, code);
    });
    return handle;
  }

  /**
   * kill(2) from a program: a process of this session gets any signal; one
   * elsewhere in the process table gets the signals the table knows. A
   * negative pid names a process group of the session. Signal 0 only asks
   * whether the process exists.
   */
  private kill(pid: number, sig: number): boolean | Promise<boolean> {
    if (pid < 0) return this.jobs.killGroup(-pid, sig);
    const wasm = this.wasmByPid.get(pid);
    if (wasm) {
      if (sig !== 0) wasm.signal(sig);
      return true;
    }
    const shell = this.shellByPid.get(pid);
    if (shell) {
      if (sig !== 0) shell(sig);
      return true;
    }
    const pm = this.processConfig?.processManager;
    if (!pm) return false;
    if (sig === 0) return pm.get(pid) !== null;
    const name = SIGNAL_NAME.get(sig);
    if (name === undefined) return false;
    if (!this.gate) return pm.signal(pid, name);
    return this.killOutside(pid, name);
  }

  /**
   * A signal to a process outside the invocation goes through the shell's
   * command policy as `kill -SIG PID` would: bash's `kill` is a builtin, so
   * no command dispatch gates it otherwise. A denial is EPERM.
   */
  private async killOutside(pid: number, name: keyof typeof SIGNAL_BY_NAME): Promise<boolean> {
    const denial = await this.gate?.('kill', [`-${name.slice(3)}`, String(pid)], {});
    if (denial) throw new KernelError('EPERM');
    return this.processConfig?.processManager.signal(pid, name) ?? false;
  }

  /**
   * A listening socket on the invocation's owner's loopback network (`wasm
   * --listen`), for a program to accept on: other programs of the owner and
   * kernel services reach it while it is open.
   */
  listen(addr: SockAddr): OpenFile {
    return new OpenFile(this.net.listen(addr));
  }

  /** Signal every process of the invocation. */
  signalAll(sig: number): void {
    for (const handle of this.live) handle.signal(sig);
  }

  /** A signal from the terminal (^C, ^Z, SIGWINCH): its foreground process group. */
  signalTerminal(tty: KernelTty, sig: number): void {
    // The first process leads the invocation's session: its group until a program picks one.
    if (this.leader !== undefined) this.jobs.signalForeground(tty, this.leader, sig);
  }

  /** End every process of the invocation (an abort, the output limit). */
  killAll(code: number): void {
    for (const handle of this.live) handle.kill(code);
    for (const child of this.shellChildren) child.abort();
  }

  /**
   * What a child's program name means: an installed or on-disk wasm program,
   * if any. A path into the command registry (`/usr/bin/<name>`, `/bin/<name>`,
   * what a `$PATH` search finds) is the bare name.
   */
  async resolve(file: string, argv0: string, cwd: string): Promise<WasmTarget | undefined> {
    const name = REGISTRY_PATH.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name !== undefined) {
      const commands = await this.commands();
      const command = commands.get(name);
      // A script command is no wasm program: its interpreter runs it (`interpreted`).
      if (command?.script) return undefined;
      if (command) {
        return {
          glue: command.glue,
          module: command.wasm,
          argv0: command.argv0,
          ...(command.args ? { prefixArgs: command.args } : {}),
          defaults: command.env,
        };
      }
      // A program's `/bin/sh` (system(3), popen(3), tar's compressor) is GNU
      // bash when no package provides `sh`: as `sh`, in POSIX mode, finding
      // the native programs just-bash's `sh` would not.
      const bash = name === 'sh' ? commands.get('bash') : undefined;
      return bash && { glue: bash.glue, module: bash.wasm, argv0: 'sh', defaults: bash.env };
    }
    const glue = this.ctx.fs.resolvePath(cwd, file);
    if (!(await this.ctx.fs.exists(glue))) return undefined;
    const module = modulePath(glue);
    if (await this.ctx.fs.exists(module)) return { glue, module, argv0: baseName(argv0 || file) };
    // A wasm module by itself: a WASI program (its name without `.wasm`, for a multi-call binary).
    if (await isModuleFile(this.ctx, glue)) {
      return { glue, module: glue, argv0: baseName(argv0 || file).replace(/\.wasm$/, '') };
    }
    return this.packagedCopy(glue, argv0 || file);
  }

  /**
   * A glue without a module of its own that is a copy of one of its
   * package's programs runs that program, under its own name: wasm-git's
   * `libexec/git-core/git-upload-pack` is `bin/git`'s glue (it locates
   * `git.wasm`, which sits next to `bin/git`), and git runs a dashed builtin
   * by its argv[0]. Anything else stays no wasm program.
   */
  private async packagedCopy(glue: string, argv0: string): Promise<WasmTarget | undefined> {
    const root = PACKAGE_ROOT.exec(glue)?.[1];
    if (root === undefined) return undefined;
    let text: string;
    try {
      text = await this.ctx.fs.readFile(glue);
    } catch {
      return undefined;
    }
    const located = LOCATED_MODULE.exec(text)?.[1];
    if (located === undefined) return undefined;
    for (const command of (await this.commands()).values()) {
      if (command.wasm.startsWith(`${root}/`) && command.wasm.endsWith(`/${located}`)) {
        return {
          glue: command.glue,
          module: command.wasm,
          argv0: baseName(argv0),
          defaults: command.env,
        };
      }
    }
    return undefined;
  }

  /** fork(2) of process `ppid`: the same program, resumed from the parent's state. */
  private forker(ppid: number, parent: StartRequest): ChildForker {
    return async (state, fds) => {
      const handle = this.start({
        ...parent,
        cwd: state.cwd ?? parent.cwd,
        fds,
        ppid,
        fork: state,
      });
      return childHandle(handle);
    };
  }

  /** The script of the script command `file` names (bare, or its `/usr/bin/<name>` path), if any. */
  private async scriptCommand(file: string): Promise<WasmCommand | undefined> {
    const name = REGISTRY_PATH.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name === undefined) return undefined;
    const command = (await this.commands()).get(name);
    return command?.script ? command : undefined;
  }

  /**
   * A script a program runs by path (git's hooks, a `./configure`), or a
   * package's script command (`cc`): `#!interp [arg]` on its first line names
   * the program that runs it, with the script's path as its argument, as
   * execve(2) does; a script command's environment defaults go along.
   * Undefined for anything else, or an interpreter that is no wasm program
   * (the shell runs such a script).
   */
  async interpreted(
    req: Pick<ChildSpawnRequest, 'file' | 'argv' | 'cwd'>
  ): Promise<{ target: WasmTarget; file: string; args: string[] } | undefined> {
    const command = await this.scriptCommand(req.file);
    if (!command && (!req.file.includes('/') || REGISTRY_PATH.test(req.file))) return undefined;
    const script = command?.script ?? this.ctx.fs.resolvePath(req.cwd, req.file);
    let head: Uint8Array;
    try {
      head = (await this.ctx.fs.readFileBuffer(script)).subarray(0, SHEBANG_MAX);
    } catch {
      return undefined;
    }
    if (head[0] !== 0x23 || head[1] !== 0x21) return undefined; // #!
    const line = new TextDecoder().decode(head).slice(2).split('\n')[0].trim();
    const [interp, ...rest] = line.split(/[ \t]+/);
    if (!interp) return undefined;
    const found = await this.resolve(interp, interp, req.cwd);
    if (!found) return undefined;
    const target = command?.env
      ? { ...found, defaults: { ...found.defaults, ...command.env } }
      : found;
    // Linux passes what follows the interpreter as one argument.
    const arg = rest.join(' ');
    return {
      target,
      file: interp,
      args: [
        ...(found.prefixArgs ?? []),
        ...(arg ? [arg] : []),
        command ? script : req.file,
        ...req.argv.slice(1),
      ],
    };
  }

  private spawner(ppid: number): ChildSpawner {
    return async (req, fds) => {
      const direct = await this.resolve(req.file, req.argv[0] ?? req.file, req.cwd);
      const run = direct
        ? {
            target: direct,
            file: req.file,
            args: [...(direct.prefixArgs ?? []), ...req.argv.slice(1)],
          }
        : await this.interpreted(req);
      if (!run) {
        if (!(await this.shellRuns(req))) {
          void fds.closeAll().catch(() => undefined);
          throw new SpawnError('ENOENT');
        }
        return this.runShellChild(req, fds, ppid);
      }
      // The program that runs is what the policy sees: a script's interpreter.
      const denial = await this.gate?.(commandName(run.file), run.args, req.env);
      if (denial) return this.deniedChild(req, fds, ppid, denial);
      const handle = await this.launch({
        ...run.target,
        args: run.args,
        env: req.env,
        cwd: req.cwd,
        fds,
        ppid,
      });
      return childHandle(handle);
    };
  }

  /**
   * Whether the shell has something to run for a child no wasm program runs:
   * a file, or a name (bare, or its `/usr/bin/<name>` path) the shell knows —
   * a registered command, else whatever `command -v` finds (a builtin such as
   * `test` or `kill`, which Linux also ships as programs; a `.jsh` script).
   * A miss fails the spawn with ENOENT, as execve does, so a libc `$PATH`
   * search tries its next directory and a program sees its `FileNotFoundError`
   * rather than a child the shell reports as "command not found" (127).
   * Without the shell's catalog (unit tests), everything goes to the shell.
   */
  private async shellRuns(req: ChildSpawnRequest): Promise<boolean> {
    const name =
      REGISTRY_PATH.exec(req.file)?.[1] ?? (req.file.includes('/') ? undefined : req.file);
    if (name === undefined) return this.ctx.fs.exists(this.ctx.fs.resolvePath(req.cwd, req.file));
    const registered = this.ctx.getRegisteredCommands?.();
    if (!registered || registered.includes(name) || !this.ctx.exec) return true;
    const found = await this.ctx.exec('command', {
      args: ['-v', name],
      cwd: req.cwd,
      env: req.env,
      replaceEnv: true,
    });
    return found.exitCode === 0;
  }

  /** A program the shell's policy refused: a child that reports the denial and exits. */
  private deniedChild(
    req: ChildSpawnRequest,
    fds: FdTable,
    ppid: number,
    denial: { stderr: string; exitCode: number }
  ): ChildHandle {
    const { pid } = this.register('shell', req.argv, req.cwd, req.env, ppid);
    const exited = (async () => {
      await writeAll(fds, 2, new TextEncoder().encode(denial.stderr));
      await fds.closeAll();
      return denial.exitCode;
    })();
    if (this.processConfig) {
      void exited.then((code) => this.processConfig?.processManager.exit(pid, code));
    }
    return { pid, exited };
  }

  /** A child that is no wasm program: a shell command on the child's descriptors. */
  private runShellChild(req: ChildSpawnRequest, fds: FdTable, ppid: number): ChildHandle {
    const exec = this.ctx.exec;
    if (!exec) {
      void fds.closeAll().catch(() => undefined);
      throw new SpawnError('ENOSYS');
    }
    const { pid, abort } = this.register('shell', req.argv, req.cwd, req.env, ppid);
    // Its own abort: `kill <pid>` (and a kill of an ancestor) signals the
    // process record; an abort of the whole invocation ends it too.
    const controller = abort ?? new AbortController();
    const onAbort = () => controller.abort();
    this.ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.ctx.signal?.aborted) onAbort();
    // It has no handlers of its own: a signal whose default action ends a
    // process ends it (reported as WIFSIGNALED); stop and continue cannot
    // pause a shell command, so they do nothing.
    let endedBy: number | undefined;
    const signal = (sig: number): void => {
      if (defaultAction(sig) !== 'terminate') return;
      endedBy ??= sig;
      controller.abort();
    };
    this.shellChildren.add(controller);
    this.shellByPid.set(pid, signal);
    // A member of its parent's process group: `kill -- -pgid` and the
    // terminal's ^C reach it.
    this.jobs.add(pid, ppid, signal);
    // `kill <pid>` through the process table aborts the record's controller
    // itself; hear which signal it was, so the end reports as WIFSIGNALED.
    const unsubscribe = this.processConfig?.processManager.onSignal((signaled, sig) => {
      if (signaled.pid === pid) signal(SIGNAL_BY_NAME[sig]);
    });
    const exited = (async () => {
      try {
        // A shell command takes its stdin whole, read to the end first; a
        // terminal never ends (until ^D), so on one it gets none.
        const onTerminal = isTerminal(fds, 0);
        const stdin = fds.has(0) && !onTerminal ? await readAll(fds.get(0)) : new Uint8Array(0);
        const r = await exec(req.file, {
          args: req.argv.slice(1),
          cwd: req.cwd,
          env: { ...req.env, ...ttyHints(fds) },
          replaceEnv: true,
          stdin: latin1(stdin),
          stdinKind: 'bytes',
          signal: controller.signal,
        });
        const bytesOut = (r as { stdoutKind?: string }).stdoutKind === 'bytes';
        await writeAll(
          fds,
          1,
          bytesOut ? latin1Bytes(r.stdout) : new TextEncoder().encode(r.stdout)
        );
        await writeAll(fds, 2, new TextEncoder().encode(r.stderr));
        return r.exitCode;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await writeAll(fds, 2, new TextEncoder().encode(`${req.file}: ${message}\n`));
        return 126;
      } finally {
        await fds.closeAll();
        this.shellChildren.delete(controller);
        this.shellByPid.delete(pid);
        this.jobs.remove(pid);
        unsubscribe?.();
        this.ctx.signal?.removeEventListener('abort', onAbort);
      }
    })();
    if (this.processConfig) {
      void exited.then((code) => this.processConfig?.processManager.exit(pid, code));
    }
    return { pid, exited, termsig: () => endedBy };
  }

  /**
   * A process-table record (`ps`, `kill`) and the abort its signals fire, or
   * a local pid without a table.
   */
  private register(
    kind: 'wasm' | 'shell',
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    ppid: number | undefined
  ): { pid: number; abort?: AbortController } {
    const config = this.processConfig;
    if (!config) return { pid: nextPid++ };
    return config.processManager.spawn({
      kind,
      argv,
      cwd,
      env,
      owner: config.owner,
      ppid: ppid ?? config.getParentPid?.(),
    });
  }
}
