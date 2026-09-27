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
import { compileWasmFromVfs } from '../../../kernel/realm/wasm-compiler.js';
import {
  type ChildForker,
  type ChildHandle,
  type ChildSpawner,
  type ChildSpawnRequest,
  SpawnError,
} from '../../../kernel/wasm-realm/children.js';
import type { FdTable, OpenFile } from '../../../kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess, type WasmProcessHandle } from '../../../kernel/wasm-realm/host.js';
import type { ForkState, WasmProgram } from '../../../kernel/wasm-realm/protocol.js';
import { GLOBAL_NODE_MODULES } from '../../ipk/global-prefix.js';
import { type ProgramFs, scanWasmCommands, type WasmCommand } from '../../ipk/wasm-programs.js';
import type { JshProcessConfig } from '../../jsh-executor.js';

/** Compiled modules, keyed by path, size and mtime: a rebuilt program recompiles. */
const modules = new Map<string, Promise<WebAssembly.Module>>();

/** Exit codes of the terminating signals: the worker ends at once (128 + signo). */
const SIGNAL_EXIT_CODE: Readonly<Partial<Record<string, number>>> = {
  SIGKILL: 137,
  SIGINT: 130,
  SIGTERM: 143,
};

/** A path into the shell's command registry: `/usr/bin/<name>` or its alias `/bin/<name>`. */
const REGISTRY_PATH = /^\/(?:usr\/)?bin\/([^/]+)$/;

/** Pids when there is no process table (unit tests). */
let nextPid = 40000;

/** A wasm program to start: its glue and module paths and `argv[0]`. */
export interface WasmTarget {
  glue: string;
  module: string;
  argv0: string;
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

/** The glue's module: `x.js` → `x.wasm`, `x` → `x.wasm`. */
export function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
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

export class WasmSession {
  private readonly live = new Set<WasmProcessHandle>();
  /** The running shell children: each one's abort ends it. */
  private readonly shellChildren = new Set<AbortController>();
  private installed: Promise<Map<string, WasmCommand>> | undefined;

  constructor(
    private readonly ctx: CommandContext,
    private readonly processConfig: JshProcessConfig | undefined,
    private readonly onError: (message: string) => void
  ) {}

  /** The installed commands, scanned once per invocation. */
  commands(): Promise<Map<string, WasmCommand>> {
    this.installed ??= installedCommands(this.ctx);
    return this.installed;
  }

  /** Start a program; rejects when its glue or module cannot be read or compiled. */
  async launch(req: LaunchRequest): Promise<WasmProcessHandle> {
    let glue: string;
    let module: WebAssembly.Module;
    try {
      glue = await this.ctx.fs.readFile(req.glue);
      module = await loadModule(this.ctx, req.module);
      req.signal?.throwIfAborted();
    } catch (e) {
      await req.fds.closeAll();
      throw e;
    }
    return this.start({ ...req, program: { glue, module } });
  }

  /** Start a loaded program: a new process, or (with `fork`) a forked copy of its parent. */
  private start(req: StartRequest): WasmProcessHandle {
    const pm = this.processConfig?.processManager;
    const { pid } = this.register('wasm', [req.argv0, ...req.args], req.cwd, req.env, req.ppid);
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
      ...(req.fork ? { fork: req.fork } : {}),
    });
    this.live.add(handle);
    // `kill` / `ps`: a terminating signal to the pid ends the worker at once.
    const unsubscribe = pm?.onSignal((signaled, sig) => {
      const code = signaled.pid === pid ? SIGNAL_EXIT_CODE[sig] : undefined;
      if (code !== undefined) handle.kill(code);
    });
    void handle.exited.then((code) => {
      this.live.delete(handle);
      unsubscribe?.();
      if (this.processConfig) pm?.exit(pid, code);
    });
    return handle;
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
      const command = (await this.commands()).get(name);
      return command && { glue: command.glue, module: command.wasm, argv0: command.argv0 };
    }
    const glue = this.ctx.fs.resolvePath(cwd, file);
    const module = modulePath(glue);
    if (!(await this.ctx.fs.exists(glue)) || !(await this.ctx.fs.exists(module))) return undefined;
    return { glue, module, argv0: baseName(argv0 || file) };
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
      return { pid: handle.pid, exited: handle.exited };
    };
  }

  private spawner(ppid: number): ChildSpawner {
    return async (req, fds) => {
      const target = await this.resolve(req.file, req.argv[0] ?? req.file, req.cwd);
      if (!target) return this.runShellChild(req, fds, ppid);
      const handle = await this.launch({
        ...target,
        args: req.argv.slice(1),
        env: req.env,
        cwd: req.cwd,
        fds,
        ppid,
      });
      return { pid: handle.pid, exited: handle.exited };
    };
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
    this.shellChildren.add(controller);
    const exited = (async () => {
      try {
        const stdin = fds.has(0) ? await readAll(fds.get(0)) : new Uint8Array(0);
        const r = await exec(req.file, {
          args: req.argv.slice(1),
          cwd: req.cwd,
          env: req.env,
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
        this.ctx.signal?.removeEventListener('abort', onAbort);
      }
    })();
    if (this.processConfig) {
      void exited.then((code) => this.processConfig?.processManager.exit(pid, code));
    }
    return { pid, exited };
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
