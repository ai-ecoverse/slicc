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
  type WasmThreadInitMsg,
} from '../protocol.js';
import { dylinkInfo } from './dylink.js';
import { cachingBridge } from './wasi-files.js';
import { WasiExit, type WasiFunction, WasiHost } from './wasi-host.js';
import type { ImportedMemory } from './wasi-module.js';
import { WasiSignals } from './wasi-signals.js';
import { WasiStats } from './wasi-stats.js';
import { MAIN_TID, ThreadExit, threadCap, WasiThreads } from './wasi-threads.js';
import { AsyncifyDriver } from './wasix-fork.js';
import { WasixHost } from './wasix-host.js';
import { type LinkerHost, type LinkRecord, WasixLinker } from './wasix-linker.js';

const TRAPPED = 134;

const PREVIEW1 = 'wasi_snapshot_preview1';
const WASIX = 'wasix_32v1';

export function unsupportedImport(
  module: WebAssembly.Module,
  memory?: ImportedMemory
): string | undefined {
  const imports = WebAssembly.Module.imports(module);
  const wasix = imports.some((i) => i.module === WASIX);

  const pie = dylinkInfo(module) !== undefined;
  for (const imp of imports) {
    if (imp.module === PREVIEW1 || imp.module === WASIX) continue;
    if (pie && (imp.module === 'GOT.mem' || imp.module === 'GOT.func')) continue;

    if (pie && imp.module === 'env' && imp.kind !== 'memory') continue;
    if (imp.kind === 'memory' && memory?.module === imp.module && memory.name === imp.name)
      continue;

    if (imp.module === 'wasi' && imp.name === 'thread-spawn' && (wasix || memory?.shared)) continue;
    if (imp.kind === 'memory' || imp.module === 'wasi') {
      return `imports ${imp.module}.${imp.name}: no WASI program this host runs`;
    }
    return `imports ${imp.module}.${imp.name}: no WASI preview1 program (an Emscripten one runs with its glue)`;
  }
  if (!WebAssembly.Module.exports(module).some((e) => e.name === '_start')) {
    return 'no WASI command (it exports no _start)';
  }
  return undefined;
}

function linkImports(
  module: WebAssembly.Module,
  preview1: Record<string, WasiFunction>,
  wasix: Record<string, WasiFunction> | undefined,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined
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
    else if (imp.kind === 'function') ns[imp.name] = () => (imp.name === 'thread-spawn' ? -1 : 52);
  }
  return imports;
}

function importedMemory(
  spec: ImportedMemory | undefined,
  copy?: Uint8Array
): WebAssembly.Memory | undefined {
  if (!spec) return undefined;
  const memory = new WebAssembly.Memory({
    initial: spec.initial,
    maximum: spec.maximum ?? 65536,
    shared: spec.shared,
  });
  if (copy) {
    const pages = copy.byteLength / 65536 - memory.buffer.byteLength / 65536;
    if (pages > 0) memory.grow(pages);

    new Uint8Array(memory.buffer).set(copy);
  }
  return memory;
}

function kernelOf(
  init: { sab: SharedArrayBuffer; argv0: string },
  port: SabPostLike,

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

function traced<T extends object>(stats: WasiStats | undefined, tag: string, table: T): T {
  return stats ? stats.wrap(tag, table) : table;
}

function timedCalls(stats: WasiStats, call: (req: WasmSyscall) => unknown) {
  return (req: WasmSyscall): unknown => stats.time(`kernel.${req.op}`, () => call(req));
}

function report(stats: WasiStats, sys: { write(fd: number, bytes: Uint8Array): unknown }): void {
  stats.phase('run');
  try {
    sys.write(2, new TextEncoder().encode(stats.report()));
  } catch {}
}

function spawnsThreads(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (i) =>
      (i.module === 'wasi' && i.name === 'thread-spawn') ||
      (i.module === WASIX && i.name === 'thread_spawn_v2')
  );
}

async function instantiate(
  host: WasiHost,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined,
  {
    thread = false,
    stats,
    signals,
  }: { thread?: boolean; stats?: WasiStats; signals?: WasiSignals } = {}
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

    if (threads) {
      sync.linker.cache = threads.received;
      threads.modules = () => sync.linker.compiled();
    }
  }
  const hostImports = linkImports(module, preview1, wasix, memory, threads);
  const imports: WebAssembly.Imports = sync
    ? merge(hostImports, sync.linker.mainImports(module))
    : hostImports;
  const instance = await WebAssembly.instantiate(module, imports);
  stats?.phase('instantiate');
  const exports = instance.exports as { memory?: WebAssembly.Memory };
  host.mem.bind(memory ?? (exports.memory as WebAssembly.Memory));
  if (sync) {
    sync.linker.bindMain(instance, !thread);

    if (thread) sync.catchUp();

    sync.linker.bindMainGot();
  }
  return { instance, driver };
}

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

function merge(
  base: WebAssembly.Imports,
  extra: Record<string, Record<string, WebAssembly.ImportValue>>
): WebAssembly.Imports {
  const out: WebAssembly.Imports = { ...base };
  for (const [ns, values] of Object.entries(extra)) out[ns] = { ...base[ns], ...values };
  return out;
}

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

    for (const r of since.slice(0, -1)) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.add(this.ids, DL_GEN, 1) + 1;
  }

  catchUp(): void {
    const since = this.call({ op: 'dl-log', from: this.count }) as LinkRecord[];
    for (const r of since) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.load(this.ids, DL_GEN);
  }

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

            const result = fn(...args);
            if (Atomics.load(ids, DL_GEN) !== this.gen) this.catchUp();
            return result;
          }) as WasiFunction,
        ])
      );
    return { preview1: wrap(preview1), wasix: wasix && wrap(wasix) };
  }
}

const DL_GEN = 3;

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  captureBacktraces(init.env);

  const signals = new WasiSignals((sig) => {
    call({ op: 'proc-kill', pid: init.pid, sig });
    throw new WasiExit(128 + sig);
  });
  const { transport, sys, call: kernelCall, say } = kernelOf(init, port, signals);

  const stats = init.env.SLICC_WASI_STATS === '1' ? new WasiStats() : undefined;
  const call = stats ? timedCalls(stats, kernelCall) : kernelCall;
  const { module } = init.program;
  const refused = unsupportedImport(module, init.program.memory);
  if (refused) {
    say(refused);
    return 126;
  }
  const fork = init.fork?.wasi;
  const memory = importedMemory(init.program.memory, fork ? init.fork?.memory : undefined);
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
            inherited: (init.fds ?? []).map((f) => ({ fd: f.fd, kind: f.kind, flags: f.flags })),
          }),
  });
  if (threads) {
    threads.beforeSpawn = () => {
      if (!host.fds.isShared) host.fds.share(threads.ids, false);
    };
  }
  const { instance, driver } = await instantiate(host, module, memory, threads, { stats, signals });
  signals.bind(instance.exports);
  host.onRaise = (sig) => signals.raised(sig);
  const exports = instance.exports as { _start: () => void };
  driver.bind(instance.exports);
  try {
    if (fork) driver.startChild(fork);

    do exports._start();
    while (driver.resume());
    return 0;
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    try {
      say(trapMessage(e, init.env));
    } catch {
      throw new Error(`${init.argv0}: wasm trap: ${e.message}`);
    }
    return TRAPPED;
  } finally {
    host.flushAll();
    if (stats) report(stats, sys);
  }
}

const BACKTRACE_FRAMES = 40;

export function trapMessage(
  e: WebAssembly.RuntimeError,
  env: Readonly<Record<string, string>>,
  where = ''
): string {
  const head = `wasm trap${where}: ${e.message}`;
  if (env.SLICC_WASM_BACKTRACE !== '1') return head;

  const frames = (e.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at .*wasm:\/\/wasm\//.test(line))
    .slice(0, BACKTRACE_FRAMES);
  return frames.length ? `${head}\n${frames.join('\n')}` : head;
}

export function captureBacktraces(env: Readonly<Record<string, string>>): void {
  if (env.SLICC_WASM_BACKTRACE !== '1') return;

  Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 0, BACKTRACE_FRAMES + 20);
}

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

  const { instance } = await instantiate(host, init.program.module, thread.memory, threads, {
    thread: true,
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
        say(trapMessage(e, init.env, ` in thread ${thread.tid}`));
      } catch {}
      port.postMessage({ type: WASM_PROCESS_EXIT, code: TRAPPED });
      return;
    }
    port.postMessage({
      type: WASM_PROCESS_ERROR,
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}
