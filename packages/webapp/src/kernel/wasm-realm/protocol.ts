import type { DeviceMeta, KernelFdKind } from './fd-table.js';
import type { ImportedMemory } from './wasi/wasi-module.js';
import type { WasiForkState } from './wasi/wasix-fork.js';

export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';

export const WASM_THREAD_SPAWN = 'wasm-thread-spawn';

export const WASM_THREAD_INIT = 'wasm-thread-init';

export const WASM_THREAD_EXIT = 'wasm-thread-exit';

export const WASM_MAX_THREADS = 64;

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

  device?: DeviceMeta;

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

export interface WasmThread {
  tid: number;
  arg: number;

  memory: WebAssembly.Memory;

  ids: SharedArrayBuffer;

  modules?: Record<string, WebAssembly.Module>;
}

export interface WasmThreadSpawnMsg {
  type: typeof WASM_THREAD_SPAWN;
  thread: WasmThread;
}

export interface WasmThreadInitMsg extends Omit<WasmProcessInitMsg, 'type' | 'fork' | 'fds'> {
  type: typeof WASM_THREAD_INIT;
  thread: WasmThread;
}

export interface WasmThreadExitMsg {
  type: typeof WASM_THREAD_EXIT;
}

export interface WasmProcessExitMsg {
  type: typeof WASM_PROCESS_EXIT;
  code: number;
}

export interface WasmProcessErrorMsg {
  type: typeof WASM_PROCESS_ERROR;
  message: string;
}
