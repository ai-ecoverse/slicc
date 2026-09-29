/**
 * `wasi-threads.ts` — a WASI process's threads, as one of its workers sees
 * them (#3530 phase 5d): `wasi.thread-spawn` (wasm32-wasip1-threads) and
 * WASIX `thread_spawn_v2` take a thread id and post the spawn to the kernel,
 * which starts a worker for it (`host.ts`) on the process's shared memory.
 * Posting needs no event loop of this worker's, which is busy running wasm,
 * so the spawn returns at once.
 *
 * The threads share Int32s (`WasmThread.ids`): the last thread id, how many
 * run besides the main one — checked against the process's cap here, where
 * a spawn can still fail (pthread_create: EAGAIN) — and the descriptor
 * table's generation (`WasiFds.share`).
 */
import type { SabPostLike } from '../../realm/sync-sab-bridge.js';
import { WASM_MAX_THREADS, WASM_THREAD_EXIT, WASM_THREAD_SPAWN } from '../protocol.js';

const LAST_TID = 0;
const RUNNING = 1;
/** The main thread's id. */
export const MAIN_TID = 1;

/** thread_exit (WASIX): this thread ends, the process goes on. */
export class ThreadExit extends Error {
  constructor() {
    super('thread exit');
  }
}

/** The cap: WASM_MAX_THREADS, or less if `SLICC_WASM_THREADS` asks for it. */
export function threadCap(env: Readonly<Record<string, string>>): number {
  const asked = Number.parseInt(env.SLICC_WASM_THREADS ?? '', 10);
  return asked >= 1 ? Math.min(asked, WASM_MAX_THREADS) : WASM_MAX_THREADS;
}

export class WasiThreads {
  readonly ids: Int32Array;
  /** Before a spawn: what the spawning thread must do first (the main thread shares its table). */
  beforeSpawn: (() => void) | undefined;

  constructor(
    private readonly port: SabPostLike,
    private readonly memory: WebAssembly.Memory,
    private readonly cap: number,
    /** This thread's id. */
    readonly tid: number,
    ids?: SharedArrayBuffer
  ) {
    this.ids = new Int32Array(ids ?? new SharedArrayBuffer(16));
    if (!ids) Atomics.store(this.ids, LAST_TID, MAIN_TID);
  }

  /** A new thread running `wasi_thread_start(tid, arg)`: its id, or -1 past the cap. */
  spawn(arg: number): number {
    if (Atomics.add(this.ids, RUNNING, 1) + 1 >= this.cap) {
      Atomics.sub(this.ids, RUNNING, 1);
      return -1;
    }
    this.beforeSpawn?.();
    const tid = Atomics.add(this.ids, LAST_TID, 1) + 1;
    this.port.postMessage({
      type: WASM_THREAD_SPAWN,
      thread: { tid, arg, memory: this.memory, ids: this.ids.buffer as SharedArrayBuffer },
    });
    return tid;
  }

  /** This thread is done: the kernel ends its worker. */
  exited(): void {
    Atomics.sub(this.ids, RUNNING, 1);
    this.port.postMessage({ type: WASM_THREAD_EXIT });
  }

  /** Whether `tid` names one of the process's threads (a running one, or one that ran). */
  known(tid: number): boolean {
    return tid >= MAIN_TID && tid <= Atomics.load(this.ids, LAST_TID);
  }

  /** thread_parallelism: how many threads can run at once. */
  parallelism(): number {
    const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(1, Math.min(this.cap, cores ?? this.cap));
  }
}
