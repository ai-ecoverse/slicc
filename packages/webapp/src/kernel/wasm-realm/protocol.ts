import type { KernelFdKind } from './fd-table.js';
import type { ImportedMemory } from './wasi/wasi-module.js';
import type { WasiForkState } from './wasi/wasix-fork.js';

export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';

export interface WasmProgram {
  abi?: 'emscripten' | 'wasi';

  glue: string;

  module: WebAssembly.Module;

  memory?: ImportedMemory;
}

export interface ForkState {
  memory: Uint8Array;

  currData: number;
  forkSp: number;

  callStackNames: Array<[number, string]>;

  ppid: number;

  streams?: ForkStream[];

  cwd?: string;

  wasi?: WasiForkState;
}

export interface KernelStreamEntry {
  fd: number;
  kernel: number;
  kind: KernelFdKind;

  flags?: number;
  cloexec?: boolean;

  desc?: number;
}

export type ForkStream = KernelStreamEntry | { fd: number; path: string; flags: number };

export interface InheritedFd {
  fd: number;
  kind: KernelFdKind;

  flags?: number;
  cloexec?: boolean;

  desc?: number;
}

export interface WasmProcessInitMsg {
  type: typeof WASM_PROCESS_INIT;
  pid: number;
  program: WasmProgram;

  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;

  sab: SharedArrayBuffer;

  ppid?: number;

  fork?: ForkState;

  fds?: InheritedFd[];
}

export interface WasmProcessExitMsg {
  type: typeof WASM_PROCESS_EXIT;
  code: number;
}

export interface WasmProcessErrorMsg {
  type: typeof WASM_PROCESS_ERROR;
  message: string;
}
