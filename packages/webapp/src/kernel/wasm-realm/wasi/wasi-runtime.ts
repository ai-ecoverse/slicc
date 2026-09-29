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
import { WasiExit, WasiHost } from './wasi-host.js';
import { WasiStats } from './wasi-stats.js';

const TRAPPED = 134;

const PREVIEW1 = 'wasi_snapshot_preview1';

export function unsupportedImport(module: WebAssembly.Module): string | undefined {
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === PREVIEW1 && imp.kind === 'function') continue;
    if (imp.module === 'wasix_32v1') return 'a WASIX program (not supported yet)';
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

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  const transport = new SignalGate(
    createSyncSabTransport(init.sab, port),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    { masks: () => null, raise: () => {} }
  ).transport();

  const stats = init.env.SLICC_WASI_STATS === '1' ? new WasiStats() : undefined;
  const sys = kernelSys(transport);
  const say = (text: string) => sys.write(2, new TextEncoder().encode(`${init.argv0}: ${text}\n`));
  const refused = unsupportedImport(init.program.module);
  if (refused) {
    say(refused);
    return 126;
  }
  let call = (req: WasmSyscall): unknown => {
    const r: SyncFsResult = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r.kind === 'json' ? r.json : undefined;
  };
  if (stats) {
    const kernelCall = call;
    call = (req) => stats.time(`kernel.${req.op}`, () => kernelCall(req));
  }
  const bridge = createSyncFsSabBridge(transport);
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: init.cwd,
    pid: init.pid,
    kernel: { sys: stats ? stats.wrap('kernel', sys) : sys, call },
    fs: cachingBridge(stats ? stats.wrap('fs', bridge) : bridge),
    inherited: (init.fds ?? []).map((f) => ({ fd: f.fd, kind: f.kind, flags: f.flags })),
  });
  const instance = await WebAssembly.instantiate(init.program.module, {
    [PREVIEW1]: stats ? stats.wrap('wasi', host.imports()) : host.imports(),
  });
  stats?.phase('instantiate');
  const exports = instance.exports as { memory: WebAssembly.Memory; _start: () => void };
  host.mem.bind(exports.memory);
  try {
    exports._start();
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
    if (stats) {
      stats.phase('run');
      try {
        sys.write(2, new TextEncoder().encode(stats.report()));
      } catch {}
    }
  }
}
