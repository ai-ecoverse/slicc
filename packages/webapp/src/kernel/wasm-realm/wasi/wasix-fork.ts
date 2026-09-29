import { E } from './wasi-abi.js';
import type { WasiForkFd } from './wasi-fds.js';
import type { WasiMemory } from './wasi-memory.js';

export interface WasiForkState {
  asyncifyData: number;

  globals: Array<[string, number]>;
  fds: WasiForkFd[];
  cloexec: number[];
  cwd: string;

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

function mutableGlobals(exports: WebAssembly.Exports): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(exports)) {
    if (!(value instanceof WebAssembly.Global) || typeof value.value !== 'number') continue;
    try {
      const v = value.value as number;
      value.value = v;
      out.push([name, v]);
    } catch {}
  }
  return out;
}

export class AsyncifyDriver {
  private exports: WebAssembly.Exports & AsyncifyExports = {};

  private stackUpper = 0;

  private pending: (() => number) | undefined;

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

  get supported(): boolean {
    return typeof this.exports.asyncify_start_unwind === 'function';
  }

  resume(): boolean {
    if (this.exports.asyncify_get_state?.() !== UNWINDING) return false;
    this.exports.asyncify_stop_unwind?.();
    const op = this.pending;
    this.pending = undefined;
    if (!op) throw new Error('WASIX: unwound with nothing to do');
    this.exports.asyncify_start_rewind?.(op());
    return true;
  }

  startChild(state: WasiForkState): void {
    this.restoreGlobals(state.globals);
    this.answer = 0;
    this.exports.asyncify_start_rewind?.(state.asyncifyData);
  }

  rewound(): number | undefined {
    if (this.exports.asyncify_get_state?.() !== REWINDING) return undefined;
    this.exports.asyncify_stop_rewind?.();
    return this.answer;
  }

  fork(
    fork: (asyncifyData: number, globals: Array<[string, number]>, sp: number) => number
  ): number {
    const sp = this.stackPointer();
    const globals = mutableGlobals(this.exports);
    return this.unwind((data) => {
      this.answer = fork(data, globals, sp);
    });
  }

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

  private dataPointer(): number {
    const g = this.exports.__data_end;
    const dataEnd = g instanceof WebAssembly.Global ? (g.value as number) : 0;
    return dataEnd < this.stackUpper ? (dataEnd + 15) & ~15 : 16;
  }

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
