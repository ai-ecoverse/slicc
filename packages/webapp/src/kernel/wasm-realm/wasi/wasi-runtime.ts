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
import type { WasmProcessInitMsg } from '../protocol.js';
import { cachingBridge } from './wasi-files.js';
import { WasiExit, type WasiFunction, WasiHost } from './wasi-host.js';
import type { ImportedMemory } from './wasi-module.js';
import { WasiStats } from './wasi-stats.js';
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
    if (imp.module === 'wasi' && imp.name === 'thread-spawn' && wasix) continue;
    if (imp.kind === 'memory' || imp.module === 'wasi') {
      return 'a threaded WASI program (wasm32-wasip1-threads: not supported yet)';
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
  memory: WebAssembly.Memory | undefined
): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
    [PREVIEW1]: preview1,
    ...(wasix ? { [WASIX]: { ...wasix } } : {}),
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

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  const transport = new SignalGate(
    createSyncSabTransport(init.sab, port),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    { masks: () => null, raise: () => {} }
  ).transport();

  const stats = init.env.SLICC_WASI_STATS === '1' ? new WasiStats() : undefined;
  const sys = kernelSys(transport);
  const say = (text: string) => sys.write(2, new TextEncoder().encode(`${init.argv0}: ${text}\n`));
  const { module } = init.program;
  const refused = unsupportedImport(module, init.program.memory);
  if (refused) {
    say(refused);
    return 126;
  }
  let call = (req: WasmSyscall): unknown => {
    const r: SyncFsResult = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r.kind === 'json' ? r.json : undefined;
  };
  if (stats) call = timedCalls(stats, call);
  const bridge = createSyncFsSabBridge(transport);
  const fork = init.fork?.wasi;
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: fork?.cwd ?? init.cwd,
    pid: init.pid,
    ...(init.ppid !== undefined ? { ppid: init.ppid } : {}),
    kernel: { sys: traced(stats, 'kernel', sys), call },
    fs: cachingBridge(traced(stats, 'fs', bridge)),
    ...(fork
      ? { forked: { fds: fork.fds, cloexec: fork.cloexec } }
      : { inherited: (init.fds ?? []).map((f) => ({ fd: f.fd, kind: f.kind, flags: f.flags })) }),
  });
  const driver = new AsyncifyDriver(host.mem);
  const wasixHost = WebAssembly.Module.imports(module).some((i) => i.module === WASIX)
    ? new WasixHost(host, driver, module)
    : undefined;
  const preview1 = { ...host.imports(), ...wasixHost?.preview1() };
  const wasix = wasixHost?.imports();
  const memory = importedMemory(init.program.memory, fork ? init.fork?.memory : undefined);
  const instance = await WebAssembly.instantiate(
    module,
    linkImports(
      module,
      traced(stats, 'wasi', preview1),
      wasix && traced(stats, 'wasix', wasix),
      memory
    )
  );
  stats?.phase('instantiate');
  const exports = instance.exports as { memory?: WebAssembly.Memory; _start: () => void };
  host.mem.bind(memory ?? (exports.memory as WebAssembly.Memory));
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
