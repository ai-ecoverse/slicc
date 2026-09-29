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
import { SignalGate } from '../process-signals.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  type WasmProcessInitMsg,
  type WasmThreadInitMsg,
} from '../protocol.js';
import { cachingBridge } from './wasi-files.js';
import { WasiExit, type WasiFunction, WasiHost } from './wasi-host.js';
import type { ImportedMemory } from './wasi-module.js';
import { WasiStats } from './wasi-stats.js';
import { MAIN_TID, ThreadExit, threadCap, WasiThreads } from './wasi-threads.js';
import { AsyncifyDriver } from './wasix-fork.js';
import { WasixHost } from './wasix-host.js';

const TRAPPED = 134;

const PREVIEW1 = 'wasi_snapshot_preview1';
const WASIX = 'wasix_32v1';

export function unsupportedImport(
  module: WebAssembly.Module,
  memory?: ImportedMemory
): string | undefined {
  const imports = WebAssembly.Module.imports(module);
  const wasix = imports.some((i) => i.module === WASIX);
  for (const imp of imports) {
    if (imp.module === PREVIEW1 || imp.module === WASIX) continue;
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

function kernelOf(init: { sab: SharedArrayBuffer; argv0: string }, port: SabPostLike) {
  const transport = new SignalGate(
    createSyncSabTransport(init.sab, port),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    { masks: () => null, raise: () => {} }
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
  stats?: WasiStats
): Promise<{ instance: WebAssembly.Instance; driver: AsyncifyDriver }> {
  const driver = new AsyncifyDriver(host.mem);
  const wasixHost = WebAssembly.Module.imports(module).some((i) => i.module === WASIX)
    ? new WasixHost(host, driver, module)
    : undefined;
  if (wasixHost) wasixHost.threads = threads;
  const instance = await WebAssembly.instantiate(
    module,
    linkImports(
      module,
      traced(stats, 'wasi', { ...host.imports(), ...wasixHost?.preview1() }),
      wasixHost && traced(stats, 'wasix', wasixHost.imports()),
      memory,
      threads
    )
  );
  stats?.phase('instantiate');
  const exports = instance.exports as { memory?: WebAssembly.Memory };
  host.mem.bind(memory ?? (exports.memory as WebAssembly.Memory));
  return { instance, driver };
}

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  const { transport, sys, call: kernelCall, say } = kernelOf(init, port);

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
  const { instance, driver } = await instantiate(host, module, memory, threads, stats);
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
      say(`wasm trap: ${e.message}`);
    } catch {
      throw new Error(`${init.argv0}: wasm trap: ${e.message}`);
    }
    return TRAPPED;
  } finally {
    host.flushAll();
    if (stats) report(stats, sys);
  }
}

export async function runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void> {
  const { transport, sys, call, say } = kernelOf(init, port);
  const { thread } = init;
  const threads = new WasiThreads(port, thread.memory, threadCap(init.env), thread.tid, thread.ids);
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

  const { instance } = await instantiate(host, init.program.module, thread.memory, threads);
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
        say(`wasm trap in thread ${thread.tid}: ${e.message}`);
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
