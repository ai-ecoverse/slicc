export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';

export interface WasmProgram {
  glue: string;

  module: WebAssembly.Module;
}

export interface ForkState {
  memory: Uint8Array;

  currData: number;
  forkSp: number;

  callStackNames: Array<[number, string]>;

  ppid: number;

  streams?: ForkStream[];

  cwd?: string;
}

export type ForkStream =
  | {
      fd: number;
      kernel: number;
      kind: 'tty' | 'stream' | 'file' | 'socket';

      flags?: number;
    }
  | { fd: number; path: string; flags: number };

export interface WasmProcessInitMsg {
  type: typeof WASM_PROCESS_INIT;
  pid: number;
  program: WasmProgram;

  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;

  sab: SharedArrayBuffer;

  fork?: ForkState;

  fds?: number[];
}

export interface WasmProcessExitMsg {
  type: typeof WASM_PROCESS_EXIT;
  code: number;
}

export interface WasmProcessErrorMsg {
  type: typeof WASM_PROCESS_ERROR;
  message: string;
}
