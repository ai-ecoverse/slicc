/**
 * `wasix-fork.ts` — WASIX calls that need Asyncify driven by the host:
 * `proc_fork` and `stack_checkpoint` / `stack_restore` (setjmp / longjmp),
 * as Wasmer does them (#3530 phase 5c).
 *
 * The program is built with `wasm-opt --asyncify` and exports its
 * `asyncify_*` functions. An import that must leave the stack starts an
 * unwind — its data at the bottom of the stack, `__data_end` in a
 * data-first layout, 0 in a stack-first one — and returns; the program
 * unwinds to `_start`, where the runtime's loop takes the pending operation,
 * carries it out, and rewinds into the same import, which then returns its
 * answer:
 *
 * - fork: the memory copy, the exported globals and the descriptor table go
 *   to the kernel's `proc-fork`, whose new worker restores them and rewinds
 *   into `proc_fork` answering 0; the parent's answers the child's pid.
 * - setjmp saves the unwound frames and the globals under an id it writes
 *   into the program's snapshot struct, and rewinds at once (answering 0);
 *   longjmp unwinds, swaps those frames back in and rewinds into the setjmp,
 *   which answers the longjmp's value. As in Wasmer, longjmp does not
 *   restore stack memory.
 */
import { E } from './wasi-abi.js';
import type { WasiForkFd } from './wasi-fds.js';
import type { WasiMemory } from './wasi-memory.js';

/** What a forked child restores (in `ForkState.wasi`). */
export interface WasiForkState {
  /** Where Asyncify's data struct lives. */
  asyncifyData: number;
  /** The exported mutable i32 globals at the fork (`__stack_pointer`, `__tls_base`, …). */
  globals: Array<[string, number]>;
  fds: WasiForkFd[];
  cloexec: number[];
  cwd: string;
  /** A threaded parent: the child's table is the kernel's copy, rebuilt from there. */
  shared?: true;
}

interface AsyncifyExports {
  asyncify_start_unwind?: (data: number) => void;
  asyncify_stop_unwind?: () => void;
  asyncify_start_rewind?: (data: number) => void;
  asyncify_stop_rewind?: () => void;
  asyncify_get_state?: () => number;
}

const UNWINDING = 1;
const REWINDING = 2;

/** The globals a snapshot restores: mutable i32 ones (probing mutability: an immutable one throws). */
function mutableGlobals(exports: WebAssembly.Exports): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(exports)) {
    if (!(value instanceof WebAssembly.Global) || typeof value.value !== 'number') continue;
    try {
      const v = value.value as number;
      value.value = v;
      out.push([name, v]);
    } catch {
      /* immutable */
    }
  }
  return out;
}

export class AsyncifyDriver {
  private exports: WebAssembly.Exports & AsyncifyExports = {};
  /** The stack's top: `__stack_pointer` before any code ran. */
  private stackUpper = 0;
  /** The operation to carry out once the stack is unwound; answers the data to rewind with. */
  private pending: (() => number) | undefined;
  /** What the import being rewound into answers. */
  private answer = 0;
  private readonly snapshots = new Map<
    number,
    { frames: Uint8Array; globals: Array<[string, number]> }
  >();
  private nextSnapshot = 1;

  constructor(private readonly mem: WasiMemory) {}

  bind(exports: WebAssembly.Exports): void {
    this.exports = exports as WebAssembly.Exports & AsyncifyExports;
    const sp = this.exports.__stack_pointer;
    this.stackUpper = sp instanceof WebAssembly.Global ? (sp.value as number) : 0;
  }

  /** Whether the program can unwind (it was built with Asyncify). */
  get supported(): boolean {
    return typeof this.exports.asyncify_start_unwind === 'function';
  }

  /** After `_start` returns: unwound for an operation? Then carry it out and rewind (true). */
  resume(): boolean {
    if (this.exports.asyncify_get_state?.() !== UNWINDING) return false;
    this.exports.asyncify_stop_unwind?.();
    const op = this.pending;
    this.pending = undefined;
    if (!op) throw new Error('WASIX: unwound with nothing to do');
    this.exports.asyncify_start_rewind?.(op());
    return true;
  }

  /** The child side of a fork: the globals back, then rewind into `proc_fork` (answering 0). */
  startChild(state: WasiForkState): void {
    this.restoreGlobals(state.globals);
    this.answer = 0;
    this.exports.asyncify_start_rewind?.(state.asyncifyData);
  }

  /** Being rewound into: stop, and take the answer. Undefined when this is a fresh call. */
  rewound(): number | undefined {
    if (this.exports.asyncify_get_state?.() !== REWINDING) return undefined;
    this.exports.asyncify_stop_rewind?.();
    return this.answer;
  }

  /**
   * proc_fork: unwind; `fork(data, globals, sp)` then hands the unwound state
   * to the kernel and answers the child's pid.
   */
  fork(
    fork: (asyncifyData: number, globals: Array<[string, number]>, sp: number) => number
  ): number {
    const sp = this.stackPointer();
    const globals = mutableGlobals(this.exports);
    return this.unwind((data) => {
      this.answer = fork(data, globals, sp);
    });
  }

  /** setjmp: remember the frames Asyncify saves on the way out, and rewind right back (answering 0). */
  checkpoint(snapPtr: number, retPtr: number): number {
    const id = this.nextSnapshot++;
    const v = this.mem.view();
    v.setBigUint64(snapPtr, BigInt(retPtr), true);
    v.setBigUint64(snapPtr + 8, BigInt(id), true);
    v.setBigUint64(snapPtr + 16, 0x51cc5117n, true);
    const globals = mutableGlobals(this.exports);
    return this.unwind((data) => {
      const end = this.mem.view().getUint32(data, true);
      this.snapshots.set(id, { frames: this.mem.bytes(data + 8, end - data - 8).slice(), globals });
      this.answer = 0;
    });
  }

  /** longjmp: unwind, then rewind into the setjmp's frames, which answers `val` (never 0). */
  restore(snapPtr: number, val: bigint): number {
    const id = Number(this.mem.view().getBigUint64(snapPtr + 8, true));
    const snap = this.snapshots.get(id);
    if (!snap) throw new Error(`WASIX: longjmp to an unknown setjmp (${id})`);
    return this.unwind((data) => {
      this.mem.bytes(data + 8, snap.frames.length).set(snap.frames);
      this.mem.view().setUint32(data, data + 8 + snap.frames.length, true);
      this.restoreGlobals(snap.globals);
      this.answer = Number(val) || 1;
    });
  }

  private stackPointer(): number {
    const g = this.exports.__stack_pointer;
    return g instanceof WebAssembly.Global ? (g.value as number) : 0;
  }

  /**
   * Where Asyncify's data goes: the bottom of the stack, which grows down
   * toward it — `__data_end` in a data-first layout, just above 0 in a
   * stack-first one (Wasmer's rule).
   */
  private dataPointer(): number {
    const g = this.exports.__data_end;
    const dataEnd = g instanceof WebAssembly.Global ? (g.value as number) : 0;
    return dataEnd < this.stackUpper ? (dataEnd + 15) & ~15 : 16;
  }

  /** Start unwinding to the runtime's loop with Asyncify's buffer below the live stack. */
  private unwind(then: (data: number) => void): number {
    if (!this.supported) return E.NOSYS;
    const data = this.dataPointer();
    const v = this.mem.view();
    v.setUint32(data, data + 8, true);
    v.setUint32(data + 4, this.stackPointer() - 16, true);
    this.pending = () => {
      then(data);
      return data;
    };
    this.exports.asyncify_start_unwind?.(data);
    return E.SUCCESS;
  }

  private restoreGlobals(globals: Array<[string, number]>): void {
    for (const [name, value] of globals) {
      const g = this.exports[name];
      if (g instanceof WebAssembly.Global) g.value = value;
    }
  }
}
