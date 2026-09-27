/**
 * `protocol.ts` — messages between the kernel and a wasm-realm process
 * worker (#3530).
 *
 * The kernel posts ONE {@link WasmProcessInitMsg}; the worker runs the
 * program and posts {@link WasmProcessExitMsg} (or {@link WasmProcessErrorMsg}
 * when it could not start). In between, every syscall and file operation is a
 * blocking round trip over the Atomics/SAB bridge on the same port
 * (`sync-sab-req` / `sync-sab-next`, see `realm/sync-sab-wire.ts`).
 */

export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';

/** An Emscripten program: its glue (JS) and compiled module. */
export interface WasmProgram {
  /** The Emscripten glue source; built with `-sENVIRONMENT` including `worker`. */
  glue: string;
  /** Compiled on the kernel side (a large module would OOM a worker). */
  module: WebAssembly.Module;
}

export interface WasmProcessInitMsg {
  type: typeof WASM_PROCESS_INIT;
  pid: number;
  program: WasmProgram;
  /** `argv[0]`: selects the program in a multi-call binary (coreutils). */
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The Atomics/SAB bridge for syscalls and the live VFS. */
  sab: SharedArrayBuffer;
}

export interface WasmProcessExitMsg {
  type: typeof WASM_PROCESS_EXIT;
  code: number;
}

export interface WasmProcessErrorMsg {
  type: typeof WASM_PROCESS_ERROR;
  message: string;
}
