import type { SabPostLike } from '../../realm/sync-sab-bridge.js';
import { WASM_MAX_THREADS, WASM_THREAD_EXIT, WASM_THREAD_SPAWN } from '../protocol.js';

const LAST_TID = 0;
const RUNNING = 1;

export const MAIN_TID = 1;

export class ThreadExit extends Error {
  constructor() {
    super('thread exit');
  }
}

export function threadCap(env: Readonly<Record<string, string>>): number {
  const asked = Number.parseInt(env.SLICC_WASM_THREADS ?? '', 10);
  return asked >= 1 ? Math.min(asked, WASM_MAX_THREADS) : WASM_MAX_THREADS;
}

export class WasiThreads {
  readonly ids: Int32Array;

  beforeSpawn: (() => void) | undefined;

  modules: (() => Record<string, WebAssembly.Module>) | undefined;

  received: Readonly<Record<string, WebAssembly.Module>> | undefined;

  constructor(
    private readonly port: SabPostLike,
    private readonly memory: WebAssembly.Memory,
    private readonly cap: number,

    readonly tid: number,
    ids?: SharedArrayBuffer
  ) {
    this.ids = new Int32Array(ids ?? new SharedArrayBuffer(16));
    if (!ids) Atomics.store(this.ids, LAST_TID, MAIN_TID);
  }

  spawn(arg: number): number {
    if (Atomics.add(this.ids, RUNNING, 1) + 1 >= this.cap) {
      Atomics.sub(this.ids, RUNNING, 1);
      return -1;
    }
    this.beforeSpawn?.();
    const tid = Atomics.add(this.ids, LAST_TID, 1) + 1;
    const modules = this.modules?.();
    this.port.postMessage({
      type: WASM_THREAD_SPAWN,
      thread: {
        tid,
        arg,
        memory: this.memory,
        ids: this.ids.buffer as SharedArrayBuffer,
        ...(modules ? { modules } : {}),
      },
    });
    return tid;
  }

  exited(): void {
    Atomics.sub(this.ids, RUNNING, 1);
    this.port.postMessage({ type: WASM_THREAD_EXIT });
  }

  known(tid: number): boolean {
    return tid >= MAIN_TID && tid <= Atomics.load(this.ids, LAST_TID);
  }

  parallelism(): number {
    const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(1, Math.min(this.cap, cores ?? this.cap));
  }
}
