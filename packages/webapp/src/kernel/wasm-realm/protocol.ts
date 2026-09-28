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
import type { KernelFdKind } from './fd-table.js';

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

/**
 * The parent's state at a fork(2) (`slicc-fork.js` in the toolchain): the
 * child's worker restores it and resumes from fork() returning 0.
 */
export interface ForkState {
  /** The parent's linear memory. */
  memory: Uint8Array;
  /** Asyncify's saved call stack, and the stack pointer at the fork() call. */
  currData: number;
  forkSp: number;
  /** Asyncify's call-stack ids as export names (`[id, name]`). */
  callStackNames: Array<[number, string]>;
  /** The parent's getpid(), the child's getppid(). */
  ppid: number;
  /** The parent's fd table, as the child rebuilds it (filled in by the runtime). */
  streams?: ForkStream[];
  /** The parent's working directory (filled in by the runtime). */
  cwd?: string;
}

/**
 * A program fd backed by kernel descriptor `kernel`, and how to back it (a
 * terminal, a seekable VFS file, a stream). `cloexec`: FD_CLOEXEC is set.
 */
export interface KernelStreamEntry {
  fd: number;
  kernel: number;
  kind: KernelFdKind;
  /** A socket's status flags (O_NONBLOCK), which the child's stream keeps. */
  flags?: number;
  cloexec?: boolean;
}

/**
 * One descriptor of a forked parent: backed by a kernel descriptor of the same
 * number in the child's table (the fork copied it), or a device the child
 * reopens by path (its flags carry O_CLOEXEC).
 */
export type ForkStream = KernelStreamEntry | { fd: number; path: string; flags: number };

/** A kernel descriptor beyond 0-2 a process starts with, open at the same number. */
export interface InheritedFd {
  fd: number;
  kind: KernelFdKind;
  /** A socket's status flags (O_NONBLOCK), which its stream keeps. */
  flags?: number;
  cloexec?: boolean;
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
  /** A forked child: the parent's state to resume from, instead of running main. */
  fork?: ForkState;
  /**
   * Kernel descriptors beyond 0-2 the program starts with, open at the same
   * numbers: what its spawner inherited to it (execve / posix_spawn), or a
   * runner's private descriptor (close-on-exec).
   */
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
