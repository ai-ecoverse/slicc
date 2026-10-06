/**
 * `wasi-runtime.ts` — one WASI program in a wasm-realm process worker
 * (#3530 phase 5); the counterpart of `process-runtime.ts` for
 * `abi: "wasi"`. There is no glue: the kernel's compiled module is
 * instantiated with {@link WasiHost}'s preview1 imports — and, for a WASIX
 * program, {@link WasixHost}'s `wasix_32v1` ones and the shared memory it
 * imports — and `_start` runs to its end or `proc_exit`. A WASIX fork or
 * setjmp unwinds to here and is carried out between two runs of `_start`
 * (`wasix-fork.ts`); a forked child starts by rewinding. The worker entry
 * imports this module only for a WASI program.
 */
import type { SyncFsResult } from '../../realm/sync-fs-wire.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
} from '../../realm/sync-sab-bridge.js';
import { SAB_HEADER_I32 } from '../../realm/sync-sab-wire.js';
import { SyscallError } from '../kernel-streams.js';
import type { WasmSyscall } from '../process.js';
import { kernelSys } from '../process-runtime.js';
import { SignalGate, type SignalHooks } from '../process-signals.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  type WasmProcessInitMsg,
  type WasmProgram,
  type WasmThreadInitMsg,
} from '../protocol.js';
import { dylinkInfo } from './dylink.js';
import { cachingBridge } from './wasi-files.js';
import { WasiExit, type WasiFunction, WasiHost } from './wasi-host.js';
import type { ForeignResult, ImportedMemory } from './wasi-module.js';
import { WasiSignals } from './wasi-signals.js';
import { WasiStats } from './wasi-stats.js';
import { MAIN_TID, ThreadExit, threadCap, WasiThreads } from './wasi-threads.js';
import { AsyncifyDriver } from './wasix-fork.js';
import { WasixHost } from './wasix-host.js';
import { type LinkerHost, type LinkRecord, WasixLinker } from './wasix-linker.js';
import { mainModule, nameFrame, sidecarNames } from './wasm-names.js';

/** A program that trapped (abort, `unreachable`, a stack overflow) ends as SIGABRT would. */
const TRAPPED = 134;

const PREVIEW1 = 'wasi_snapshot_preview1';
const WASIX = 'wasix_32v1';

/** What a module's imports are judged against. */
interface ImportContext {
  wasix: boolean;
  /** It imports preview1 or WASIX: a WASI program. */
  wasi: boolean;
  /** A position-independent main module (5g): the linker lays it out. */
  pie: boolean;
  memory?: ImportedMemory;
  foreign?: Record<string, ForeignResult>;
}

/** Why one import keeps the module from running here, if it does. */
function importRefusal(
  imp: WebAssembly.ModuleImportDescriptor,
  c: ImportContext
): string | undefined {
  const key = `${imp.module}.${imp.name}`;
  if (imp.module === PREVIEW1 || imp.module === WASIX) return undefined;
  if (c.pie && (imp.module === 'GOT.mem' || imp.module === 'GOT.func')) return undefined;
  // Its undefined symbols too: env functions resolve against side modules (or trap if called).
  if (c.pie && imp.module === 'env' && imp.kind !== 'memory') return undefined;
  if (imp.kind === 'memory' && c.memory?.module === imp.module && c.memory.name === imp.name)
    return undefined;
  // wasm32-wasip1-threads: threads on the memory the kernel recorded.
  if (imp.module === 'wasi' && imp.name === 'thread-spawn' && (c.wasix || c.memory?.shared))
    return undefined;
  // A function from a namespace this host neither provides nor decides answers ENOSYS,
  // unless its result cannot carry it.
  if (c.wasi && imp.kind === 'function' && imp.module !== 'env' && imp.module !== 'wasi') {
    return c.foreign?.[key] === 'other'
      ? `imports ${key}: its result cannot carry ENOSYS, and this host does not provide it`
      : undefined;
  }
  if (imp.kind === 'memory' || imp.module === 'wasi')
    return `imports ${key}: no WASI program this host runs`;
  return `imports ${key}: no WASI preview1 program (an Emscripten one runs with its glue)`;
}

/**
 * Why the module cannot run here, if it cannot: anything an Emscripten
 * module's glue provides (`env` functions, or `a` once minified), a memory
 * import the kernel did not record (a thread spawn needs its shared memory),
 * or no `_start`. A WASI program (one that imports preview1 or WASIX) may also
 * import functions from namespaces this host does not provide, such as a
 * package's host module that only slicc-kernel loads: those calls answer
 * ENOSYS ({@link linkImports}).
 */
export function unsupportedImport(
  module: WebAssembly.Module,
  memory?: ImportedMemory,
  foreign?: Record<string, ForeignResult>
): string | undefined {
  const imports = WebAssembly.Module.imports(module);
  const context: ImportContext = {
    wasix: imports.some((i) => i.module === WASIX),
    wasi: imports.some((i) => i.module === PREVIEW1 || i.module === WASIX),
    pie: dylinkInfo(module) !== undefined,
    memory,
    foreign,
  };
  for (const imp of imports) {
    const refused = importRefusal(imp, context);
    if (refused) return refused;
  }
  if (!WebAssembly.Module.exports(module).some((e) => e.name === '_start')) {
    return 'no WASI command (it exports no _start)';
  }
  return undefined;
}

/**
 * The import object. A WASIX call this host does not serve (another
 * generation of it, say) or a function from a namespace it does not provide
 * answers ENOSYS, as a value of the import's result type (`foreign`, read from
 * the module's bytes); `wasi.thread-spawn` starts a thread (-1: none, past the
 * cap or without threads).
 */
/** The stub for an import this host does not provide: ENOSYS (52) in its result type. */
function enosys(
  imp: WebAssembly.ModuleImportDescriptor,
  result: ForeignResult | undefined
): () => number | bigint | undefined {
  if (imp.module === 'wasi' && imp.name === 'thread-spawn') return () => -1;
  if (result === 'none') return () => undefined;
  if (result === 'i64') return () => 52n;
  return () => 52;
}

function linkImports(
  module: WebAssembly.Module,
  preview1: Record<string, WasiFunction>,
  wasix: Record<string, WasiFunction> | undefined,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined,
  foreign: Record<string, ForeignResult> = {}
): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
    [PREVIEW1]: preview1,
    ...(wasix ? { [WASIX]: { ...wasix } } : {}),
    ...(threads ? { wasi: { 'thread-spawn': (arg: number) => threads.spawn(arg) } } : {}),
  };
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.name in ns) continue;
    if (imp.kind === 'memory' && memory) ns[imp.name] = memory;
    else if (imp.kind === 'function')
      ns[imp.name] = enosys(imp, foreign[`${imp.module}.${imp.name}`]);
  }
  return imports;
}

/**
 * The largest maximum WebKit reliably reserves for a shared memory: 2 GiB.
 * JavaScriptCore reserves a shared memory's whole maximum up front, and on
 * iOS a 4 GiB reservation fails with `RangeError: Out of memory` once a page
 * holds a few other memories (rustc imports `maximum: 65536`).
 */
export const FALLBACK_MAXIMUM_PAGES = 32768;

/**
 * A memory for an import declared `{ initial, maximum }`. A provided memory
 * may have a smaller maximum than the import declares, so when the engine
 * cannot reserve the declared one the program gets 2 GiB instead of none.
 */
function newImportedMemory(spec: ImportedMemory): WebAssembly.Memory {
  const maximum = spec.maximum ?? 65536;
  try {
    return new WebAssembly.Memory({ initial: spec.initial, maximum, shared: spec.shared });
  } catch (err) {
    if (!(err instanceof RangeError) || maximum <= FALLBACK_MAXIMUM_PAGES) throw err;
    if (spec.initial > FALLBACK_MAXIMUM_PAGES) throw err;
    return new WebAssembly.Memory({
      initial: spec.initial,
      maximum: FALLBACK_MAXIMUM_PAGES,
      shared: spec.shared,
    });
  }
}

/** The shared memory a WASIX program imports, grown to hold a forked parent's copy. */
export function createImportedMemory(
  spec: ImportedMemory | undefined,
  copy?: Uint8Array
): WebAssembly.Memory | undefined {
  if (!spec) return undefined;
  const memory = newImportedMemory(spec);
  if (copy) {
    const pages = copy.byteLength / 65536 - memory.buffer.byteLength / 65536;
    if (pages > 0) memory.grow(pages);
    // Before instantiation: the start function's data-segment guard stays set.
    new Uint8Array(memory.buffer).set(copy);
  }
  return memory;
}

/** The kernel over a worker's SAB bridge: its syscalls, and stderr for a word of our own. */
function kernelOf(
  init: { sab: SharedArrayBuffer; argv0: string },
  port: SabPostLike,
  // Without a program's handlers the kernel applies each signal's default action itself.
  hooks: SignalHooks = { masks: () => null, raise: () => {} }
) {
  const transport = new SignalGate(
    createSyncSabTransport(init.sab, port),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    hooks
  ).transport();
  const sys = kernelSys(transport);
  const call = (req: WasmSyscall): unknown => {
    const r: SyncFsResult = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r.kind === 'json' ? r.json : undefined;
  };
  const say = (text: string) => sys.write(2, new TextEncoder().encode(`${init.argv0}: ${text}\n`));
  return { transport, sys, call, say };
}

/** `table` counted and timed under `tag.*` when stats are on, else itself. */
function traced<T extends object>(stats: WasiStats | undefined, tag: string, table: T): T {
  return stats ? stats.wrap(tag, table) : table;
}

/** `call`, each syscall counted and timed under `kernel.<op>`. */
function timedCalls(stats: WasiStats, call: (req: WasmSyscall) => unknown) {
  return (req: WasmSyscall): unknown => stats.time(`kernel.${req.op}`, () => call(req));
}

/** The stats table on the program's stderr, if it still has one. */
function report(stats: WasiStats, sys: { write(fd: number, bytes: Uint8Array): unknown }): void {
  stats.phase('run');
  try {
    sys.write(2, new TextEncoder().encode(stats.report()));
  } catch {
    /* no stderr left to report on */
  }
}

/** Whether the module can start threads (it imports a thread spawn). */
function spawnsThreads(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (i) =>
      (i.module === 'wasi' && i.name === 'thread-spawn') ||
      (i.module === WASIX && i.name === 'thread_spawn_v2')
  );
}

/** Instantiate the program for `host` (and its WASIX calls, its threads) on `memory`. */
async function instantiate(
  host: WasiHost,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined,
  {
    thread = false,
    stats,
    signals,
    foreign,
  }: {
    thread?: boolean;
    stats?: WasiStats;
    signals?: WasiSignals;
    foreign?: Record<string, ForeignResult>;
  } = {}
): Promise<{ instance: WebAssembly.Instance; driver: AsyncifyDriver }> {
  const driver = new AsyncifyDriver(host.mem);
  const wasixHost = WebAssembly.Module.imports(module).some((i) => i.module === WASIX)
    ? new WasixHost(host, driver, module)
    : undefined;
  if (wasixHost) {
    wasixHost.threads = threads;
    wasixHost.signals = signals;
  }
  let preview1: Record<string, WasiFunction> = traced(stats, 'wasi', {
    ...host.imports(),
    ...wasixHost?.preview1(),
  });
  let wasix = wasixHost && traced(stats, 'wasix', wasixHost.imports());
  // A position-independent main module (5g): the linker lays memory out and loads its libraries.
  const info = dylinkInfo(module);
  const sync: LinkSync | undefined =
    info && memory
      ? new LinkSync(
          new WasixLinker(
            memory,
            info,
            linkerHost(host, (): WebAssembly.Imports => imports),
            thread
          ),
          (req) => host.o.kernel.call(req),
          threads?.ids
        )
      : undefined;
  if (sync) {
    ({ preview1, wasix } = sync.guard(preview1, wasix));
    if (wasixHost) wasixHost.linker = sync.linker;
    // A thread replays with the modules its spawner compiled, and hands on what it compiles.
    if (threads) {
      sync.linker.cache = threads.received;
      threads.modules = () => sync.linker.compiled();
    }
  }
  const hostImports = linkImports(module, preview1, wasix, memory, threads, foreign);
  const imports: WebAssembly.Imports = sync
    ? merge(hostImports, sync.linker.mainImports(module))
    : hostImports;
  const instance = await WebAssembly.instantiate(module, imports);
  stats?.phase('instantiate');
  const exports = instance.exports as { memory?: WebAssembly.Memory };
  host.mem.bind(memory ?? (exports.memory as WebAssembly.Memory));
  if (sync) {
    sync.linker.bindMain(instance, !thread);
    // A thread starts with what the process linked so far.
    if (thread) sync.catchUp();
    // Then the main module's GOT: slots and addresses, 0 for what nobody defines.
    sync.linker.bindMainGot();
  }
  return { instance, driver };
}

/** What the linker reads and links side modules against: the VFS, and the main module's own host imports. */
function linkerHost(host: WasiHost, imports: () => WebAssembly.Imports): LinkerHost {
  return {
    read: (path) => {
      try {
        return host.o.fs.readFile(path) as Uint8Array<ArrayBuffer>;
      } catch {
        return undefined;
      }
    },
    hostImports: () => {
      const { env: _env, 'GOT.mem': _mem, 'GOT.func': _func, ...rest } = imports();
      return rest;
    },
  };
}

/** `extra`'s namespaces merged over `base`'s. */
function merge(
  base: WebAssembly.Imports,
  extra: Record<string, Record<string, WebAssembly.ImportValue>>
): WebAssembly.Imports {
  const out: WebAssembly.Imports = { ...base };
  for (const [ns, values] of Object.entries(extra)) out[ns] = { ...base[ns], ...values };
  return out;
}

/**
 * A PIE process's links, the same in each of its workers: this worker's
 * loads and slots go to the kernel's log (`dl-log`), and, once the process
 * has threads, the others' are replayed before each call (a shared
 * generation word says when there are new ones).
 */
class LinkSync {
  private count = 0;
  private gen = 0;

  constructor(
    readonly linker: WasixLinker,
    private readonly call: (req: WasmSyscall) => unknown,
    private readonly ids: Int32Array | undefined
  ) {
    linker.publisher = (record) => this.publish(record);
  }

  private publish(record: LinkRecord): void {
    const since = this.call({ op: 'dl-log', append: record, from: this.count }) as LinkRecord[];
    // Anything another thread linked meanwhile comes first; the last is this one.
    for (const r of since.slice(0, -1)) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.add(this.ids, DL_GEN, 1) + 1;
  }

  /** Replay what the other workers linked since this one last looked. */
  catchUp(): void {
    const since = this.call({ op: 'dl-log', from: this.count }) as LinkRecord[];
    for (const r of since) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.load(this.ids, DL_GEN);
  }

  /** The import tables, each call first catching up when another thread linked something. */
  guard(
    preview1: Record<string, WasiFunction>,
    wasix: Record<string, WasiFunction> | undefined
  ): { preview1: Record<string, WasiFunction>; wasix: Record<string, WasiFunction> | undefined } {
    const ids = this.ids;
    if (!ids) return { preview1, wasix };
    const wrap = (table: Record<string, WasiFunction>) =>
      Object.fromEntries(
        Object.entries(table).map(([name, fn]) => [
          name,
          ((...args: never[]) => {
            if (Atomics.load(ids, DL_GEN) !== this.gen) this.catchUp();
            // Again on the way out: a call that waited (a join's futex) may
            // come back to a pointer another thread just resolved.
            const result = fn(...args);
            if (Atomics.load(ids, DL_GEN) !== this.gen) this.catchUp();
            return result;
          }) as WasiFunction,
        ])
      );
    return { preview1: wrap(preview1), wasix: wasix && wrap(wasix) };
  }
}

/** `ids[DL_GEN]`: bumped whenever a worker of the process links something. */
const DL_GEN = 3;

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  captureBacktraces(init.env);
  // A WASIX program's handlers run at syscall boundaries; without one, its
  // default action is the kernel's (raised again, now reported uncaught).
  const signals = new WasiSignals((sig) => {
    call({ op: 'proc-kill', pid: init.pid, sig });
    throw new WasiExit(128 + sig);
  });
  const { transport, sys, call: kernelCall, say } = kernelOf(init, port, signals);
  // SLICC_WASI_STATS=1: every call counted and timed, the table on stderr at the end.
  const stats = init.env.SLICC_WASI_STATS === '1' ? new WasiStats() : undefined;
  const call = stats ? timedCalls(stats, kernelCall) : kernelCall;
  const { module } = init.program;
  const refused = unsupportedImport(module, init.program.memory, init.program.foreign);
  if (refused) {
    say(refused);
    return 126;
  }
  const fork = init.fork?.wasi;
  const memory = createImportedMemory(init.program.memory, fork ? init.fork?.memory : undefined);
  const threads =
    memory?.buffer instanceof SharedArrayBuffer && spawnsThreads(module)
      ? new WasiThreads(port, memory, threadCap(init.env), MAIN_TID)
      : undefined;
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: fork?.cwd ?? init.cwd,
    pid: init.pid,
    ...(init.ppid !== undefined ? { ppid: init.ppid } : {}),
    kernel: { sys: traced(stats, 'kernel', sys), call },
    fs: cachingBridge(traced(stats, 'fs', createSyncFsSabBridge(transport))),
    ...(fork?.shared && threads
      ? { shared: threads.ids }
      : fork
        ? { forked: { fds: fork.fds, cloexec: fork.cloexec } }
        : {
            inherited: (init.fds ?? []).map((f) => ({
              fd: f.fd,
              kind: f.kind,
              flags: f.flags,
              ...(f.device ? { device: f.device } : {}),
            })),
          }),
  });
  if (threads) {
    // The first spawn makes the table the kernel's: the new thread must see it.
    threads.beforeSpawn = () => {
      if (!host.fds.isShared) host.fds.share(threads.ids, false);
    };
  }
  const { instance, driver } = await instantiate(host, module, memory, threads, {
    stats,
    signals,
    foreign: init.program.foreign,
  });
  signals.bind(instance.exports);
  host.onRaise = (sig) => signals.raised(sig);
  const exports = instance.exports as { _start: () => void };
  driver.bind(instance.exports);
  try {
    if (fork) driver.startChild(fork);
    // A fork or setjmp unwinds out of _start: carry it out, rewind, go on.
    do exports._start();
    while (driver.resume());
    return 0;
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    try {
      say(trapMessage(e, init.env, '', programNames(host, init.program)));
    } catch {
      // No stderr to say it on (closed, a broken pipe): the kernel's diagnostics get it.
      throw new Error(`${init.argv0}: wasm trap: ${e.message}`);
    }
    return TRAPPED;
  } finally {
    // What the program wrote to the files it has open must not be lost with the worker.
    host.flushAll();
    if (stats) report(stats, sys);
  }
}

/** Frames of a trap's stack {@link trapMessage} shows at most. */
const BACKTRACE_FRAMES = 40;

/**
 * What a trap says on stderr: `wasm trap: <message>`, and with
 * `SLICC_WASM_BACKTRACE=1` in the program's environment the wasm frames
 * under it, as V8 names them from the module's name section (`at
 * Build.Step.zigProcessUpdate (wasm://…)`) — where a toolchain's panic
 * handler (`unreachable`) came from. A module shipped without its name
 * section gets them from its sidecar (`name`, see `wasm-names.ts`): the
 * main module's frames only, never a side module's.
 */
export function trapMessage(
  e: WebAssembly.RuntimeError,
  env: Readonly<Record<string, string>>,
  where = '',
  name?: (index: number) => string | undefined
): string {
  const head = `wasm trap${where}: ${e.message}`;
  if (env.SLICC_WASM_BACKTRACE !== '1') return head;
  const lines = (e.stack ?? '').split('\n');
  // The sidecar names the main module's functions, not a side module's.
  const main = name && mainModule(lines);
  // The program's frames only: under them the stack goes on into the
  // runtime's own JS (runWasiProcess, the worker).
  const frames = lines
    .filter((line) => /^\s+at .*wasm:\/\/wasm\//.test(line))
    .slice(0, BACKTRACE_FRAMES)
    .map((line) => (name && main ? nameFrame(line, main, name) : line));
  return frames.length ? `${head}\n${frames.join('\n')}` : head;
}

/** The frame names of a program shipped with a name-section sidecar, read on first use. */
function programNames(
  host: WasiHost,
  program: WasmProgram
): ((index: number) => string | undefined) | undefined {
  const path = program.names;
  return path === undefined ? undefined : sidecarNames((p) => host.o.fs.readFile(p), path);
}

/**
 * With `SLICC_WASM_BACKTRACE=1`, let V8 record enough frames for
 * {@link trapMessage}: it captures only `Error.stackTraceLimit` (10 by
 * default) when the trap happens. The worker runs this one program, so the
 * global is its own.
 */
export function captureBacktraces(env: Readonly<Record<string, string>>): void {
  if (env.SLICC_WASM_BACKTRACE !== '1') return;
  // The runtime's own frames sit under the program's: room for both.
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 0, BACKTRACE_FRAMES + 20);
}

/**
 * One thread of a WASI process, in a worker of its own (#3530 phase 5d): the
 * program instantiated again on the process's shared memory, its
 * `wasi_thread_start(tid, arg)` run to its end. It reports for itself: its
 * end (the kernel ends the worker), or the process's — exit() or a trap in
 * any thread ends every thread.
 */
export async function runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void> {
  captureBacktraces(init.env);
  const { transport, sys, call, say } = kernelOf(init, port);
  const { thread } = init;
  const threads = new WasiThreads(port, thread.memory, threadCap(init.env), thread.tid, thread.ids);
  threads.received = thread.modules;
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: init.cwd,
    pid: init.pid,
    ...(init.ppid !== undefined ? { ppid: init.ppid } : {}),
    kernel: { sys, call },
    fs: cachingBridge(createSyncFsSabBridge(transport)),
    shared: threads.ids,
  });
  // Fork and setjmp need the program's own stack for Asyncify: a thread gets
  // ENOSYS for them (its driver is never bound).
  const { instance } = await instantiate(host, init.program.module, thread.memory, threads, {
    thread: true,
    foreign: init.program.foreign,
  });
  const start = instance.exports.wasi_thread_start as (tid: number, arg: number) => void;
  try {
    start(thread.tid, thread.arg);
    threads.exited();
  } catch (e) {
    if (e instanceof ThreadExit) {
      threads.exited();
      return;
    }
    if (e instanceof WasiExit) {
      port.postMessage({ type: WASM_PROCESS_EXIT, code: e.code });
      return;
    }
    if (e instanceof WebAssembly.RuntimeError) {
      try {
        say(trapMessage(e, init.env, ` in thread ${thread.tid}`, programNames(host, init.program)));
      } catch {
        /* no stderr left */
      }
      port.postMessage({ type: WASM_PROCESS_EXIT, code: TRAPPED });
      return;
    }
    port.postMessage({
      type: WASM_PROCESS_ERROR,
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
