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

export const SECRET_FUNCTION_ENV = 'BASH_FUNC_secret%%';
export const SECRET_FUNCTION =
  '() { command secret "$@" || return; local __slicc_env; ' +
  'if __slicc_env=$(command secret shell-env "$@" 2>/dev/null); then eval "$__slicc_env"; fi; return 0; }';

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandDefaults(
  defaults: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    let missing = false;
    const expanded = value.replace(ENV_REFERENCE, (_, name: string) => {
      const set = Object.hasOwn(env, name) ? env[name] : undefined;
      if (set === undefined) missing = true;
      return set ?? '';
    });
    if (!missing) out[key] = expanded;
  }
  return out;
}

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

function withLogname(env: Record<string, string>): Record<string, string> {
  if (env.USER === undefined || 'LOGNAME' in env) return env;
  return { ...env, LOGNAME: env.USER };
}

function withSecretFunction(argv0: string, env: Record<string, string>): Record<string, string> {
  if (!/^(ba)?sh$/.test(baseName(argv0)) || SECRET_FUNCTION_ENV in env) return env;
  return { ...env, [SECRET_FUNCTION_ENV]: SECRET_FUNCTION };
}

const modules = new Map<string, Promise<WebAssembly.Module>>();

const memories = new Map<string, ImportedMemory | undefined>();

const SIGNAL_NAME = new Map(
  Object.entries(SIGNAL_BY_NAME).map(([name, sig]) => [sig, name as keyof typeof SIGNAL_BY_NAME])
);

const REGISTRY_PATH = /^\/(?:usr\/)?bin\/([^/]+)$/;

const PACKAGE_ROOT = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//;

const LOCATED_MODULE = /locateFile\(\s*["']([^"'/]+\.wasm)["']\s*\)/;

const SHEBANG_MAX = 256;

let nextPid = 40000;

export type NativeGate = (
  name: string,
  args: string[],
  env: Record<string, string>
) => Promise<{ stderr: string; exitCode: number } | null>;

export type InstalledCommandsLookup = () => Promise<Map<string, WasmCommand>>;

export interface WasmTarget {
  glue: string;
  module: string;
  argv0: string;

  defaults?: Readonly<Record<string, string>>;
}

export interface LaunchRequest extends WasmTarget {
  args: string[];
  env: Record<string, string>;
  cwd: string;

  fds: FdTable;

  ppid?: number;

  signal?: AbortSignal;
}

interface StartRequest extends LaunchRequest {
  program: WasmProgram;
  fork?: ForkState;
}

export function isWasiTarget(target: Pick<WasmTarget, 'glue' | 'module'>): boolean {
  return target.glue === target.module;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function isWasmBytes(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

export function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
}

function commandName(file: string): string {
  return REGISTRY_PATH.exec(file)?.[1] ?? baseName(file);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

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

function cacheWasi(key: string, bytes: Uint8Array): Promise<WebAssembly.Module> {
  memories.set(key, importedMemory(bytes));
  return cache(key, compileWasmModule(bytes));
}

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

async function writeAll(fds: FdTable, fd: number, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0 || !fds.has(fd)) return;
  const file = fds.get(fd).file;
  try {
    await file.write?.(bytes);
  } catch {}
}

function isTerminal(fds: FdTable, fd: number): boolean {
  return fds.has(fd) && fds.get(fd).file.tty !== undefined;
}

function ttyHints(fds: FdTable): Record<string, string> {
  return {
    ...(isTerminal(fds, 0) ? {} : { [STDIN_ISATTY_ENV]: '0' }),
    ...(isTerminal(fds, 1) ? {} : { [STDOUT_ISATTY_ENV]: '0' }),
  };
}

function childHandle(handle: WasmProcessHandle): ChildHandle {
  return {
    pid: handle.pid,
    exited: handle.exited,
    termsig: handle.termsig,
    onState: (listener) => handle.onState(listener),
  };
}

const PYTHON_SCANS = new WeakMap<object, ReturnType<typeof scanPythonPackages>>();

export class WasmSession {
  private readonly live = new Set<WasmProcessHandle>();

  private readonly shellChildren = new Set<AbortController>();

  private readonly wasmByPid = new Map<number, WasmProcessHandle>();

  private readonly shellByPid = new Map<number, (sig: number) => void>();
  private installed: Promise<Map<string, WasmCommand>> | undefined;

  private readonly jobs = new JobTable();

  private leader: number | undefined;

  private readonly net: LoopbackNet;

  constructor(
    private readonly ctx: CommandContext,
    private readonly processConfig: JshProcessConfig | undefined,
    private readonly onError: (message: string) => void,
    private readonly gate?: NativeGate,
    private readonly lookup?: InstalledCommandsLookup
  ) {
    this.net = loopbackNet(ownerKey(processConfig?.owner));

    const owner = ownerKey(processConfig?.owner);
    enableRealmNetwork(this.net, { process: processConfig, tls: { owner } });
  }

  commands(): Promise<Map<string, WasmCommand>> {
    if (this.lookup) return this.lookup();
    this.installed ??= installedCommands(this.ctx);
    return this.installed;
  }

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
    } catch {}
  }

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

    this.jobs.add(pid, req.ppid, (sig) => handle.signal(sig), terminal);

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

  private async killOutside(pid: number, name: keyof typeof SIGNAL_BY_NAME): Promise<boolean> {
    const denial = await this.gate?.('kill', [`-${name.slice(3)}`, String(pid)], {});
    if (denial) throw new KernelError('EPERM');
    return this.processConfig?.processManager.signal(pid, name) ?? false;
  }

  listen(addr: SockAddr): OpenFile {
    return new OpenFile(this.net.listen(addr));
  }

  signalAll(sig: number): void {
    for (const handle of this.live) handle.signal(sig);
  }

  signalTerminal(tty: KernelTty, sig: number): void {
    if (this.leader !== undefined) this.jobs.signalForeground(tty, this.leader, sig);
  }

  killAll(code: number): void {
    for (const handle of this.live) handle.kill(code);
    for (const child of this.shellChildren) child.abort();
  }

  async resolve(file: string, argv0: string, cwd: string): Promise<WasmTarget | undefined> {
    const name = REGISTRY_PATH.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name !== undefined) {
      const commands = await this.commands();
      const command = commands.get(name);

      if (command?.script) return undefined;
      if (command) {
        return {
          glue: command.glue,
          module: command.wasm,
          argv0: command.argv0,
          defaults: command.env,
        };
      }

      const bash = name === 'sh' ? commands.get('bash') : undefined;
      return bash && { glue: bash.glue, module: bash.wasm, argv0: 'sh', defaults: bash.env };
    }
    const glue = this.ctx.fs.resolvePath(cwd, file);
    if (!(await this.ctx.fs.exists(glue))) return undefined;
    const module = modulePath(glue);
    if (await this.ctx.fs.exists(module)) return { glue, module, argv0: baseName(argv0 || file) };

    if (await isModuleFile(this.ctx, glue)) {
      return { glue, module: glue, argv0: baseName(argv0 || file).replace(/\.wasm$/, '') };
    }
    return this.packagedCopy(glue, argv0 || file);
  }

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

  private async scriptCommand(file: string): Promise<WasmCommand | undefined> {
    const name = REGISTRY_PATH.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name === undefined) return undefined;
    const command = (await this.commands()).get(name);
    return command?.script ? command : undefined;
  }

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

    const arg = rest.join(' ');
    return {
      target,
      file: interp,
      args: [...(arg ? [arg] : []), command ? script : req.file, ...req.argv.slice(1)],
    };
  }

  private spawner(ppid: number): ChildSpawner {
    return async (req, fds) => {
      const direct = await this.resolve(req.file, req.argv[0] ?? req.file, req.cwd);
      const run = direct
        ? { target: direct, file: req.file, args: req.argv.slice(1) }
        : await this.interpreted(req);
      if (!run) {
        if (!(await this.shellRuns(req))) {
          void fds.closeAll().catch(() => undefined);
          throw new SpawnError('ENOENT');
        }
        return this.runShellChild(req, fds, ppid);
      }

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

  private runShellChild(req: ChildSpawnRequest, fds: FdTable, ppid: number): ChildHandle {
    const exec = this.ctx.exec;
    if (!exec) {
      void fds.closeAll().catch(() => undefined);
      throw new SpawnError('ENOSYS');
    }
    const { pid, abort } = this.register('shell', req.argv, req.cwd, req.env, ppid);

    const controller = abort ?? new AbortController();
    const onAbort = () => controller.abort();
    this.ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.ctx.signal?.aborted) onAbort();

    let endedBy: number | undefined;
    const signal = (sig: number): void => {
      if (defaultAction(sig) !== 'terminate') return;
      endedBy ??= sig;
      controller.abort();
    };
    this.shellChildren.add(controller);
    this.shellByPid.set(pid, signal);

    this.jobs.add(pid, ppid, signal);

    const unsubscribe = this.processConfig?.processManager.onSignal((signaled, sig) => {
      if (signaled.pid === pid) signal(SIGNAL_BY_NAME[sig]);
    });
    const exited = (async () => {
      try {
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
