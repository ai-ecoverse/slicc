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
import type { ImportedMemory } from './wasi/wasi-module.js';
import type { WasiForkState } from './wasi/wasix-fork.js';

export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';
/** A WASI process starts a thread (`thread-spawn`, `thread_spawn_v2`): any of its workers → kernel. */
export const WASM_THREAD_SPAWN = 'wasm-thread-spawn';
/** The kernel starts a thread's worker: kernel → the new worker. */
export const WASM_THREAD_INIT = 'wasm-thread-init';
/** A thread's start function returned (or it called thread_exit): its worker → kernel. */
export const WASM_THREAD_EXIT = 'wasm-thread-exit';

/**
 * The most threads a WASI process runs at once, the main one included (a
 * worker, and a V8 isolate, each); `SLICC_WASM_THREADS` in its environment
 * lowers it. A spawn past it fails (pthread_create: EAGAIN).
 */
export const WASM_MAX_THREADS = 64;

/** A program: its compiled module, and for Emscripten its glue (JS). */
export interface WasmProgram {
  /**
   * How it talks to the kernel: through its Emscripten glue (the default), or
   * WASI preview1 imports (`wasi/wasi-runtime.ts`), with no glue at all.
   */
  abi?: 'emscripten' | 'wasi';
  /** The Emscripten glue source; built with `-sENVIRONMENT` including `worker`. Empty for WASI. */
  glue: string;
  /** Compiled on the kernel side (a large module would OOM a worker). */
  module: WebAssembly.Module;
  /**
   * WASI: the memory the module imports (every WASIX binary imports a shared
   * `env.memory`), read from its bytes when it was compiled — browsers do not
   * reflect an import's type.
   */
  memory?: ImportedMemory;
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
  /** A WASIX program's fork: its globals, Asyncify data and descriptor table. */
  wasi?: WasiForkState;
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
  /** The kernel's id of the open file description: aliases of one stream share an inode. */
  desc?: number;
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
  /** A stream's open file description, by id: fds that share one fstat as one file. */
  desc?: number;
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
  /** Its parent's pid (getppid); absent: the invocation's own parent. */
  ppid?: number;
  /** A forked child: the parent's state to resume from, instead of running main. */
  fork?: ForkState;
  /**
   * Kernel descriptors beyond 0-2 the program starts with, open at the same
   * numbers: what its spawner inherited to it (execve / posix_spawn), or a
   * runner's private descriptor (close-on-exec).
   */
  fds?: InheritedFd[];
}

/** A thread of a WASI process: its id, its start function's argument, the process's memory and ids. */
export interface WasmThread {
  tid: number;
  arg: number;
  /** The process's shared memory. */
  memory: WebAssembly.Memory;
  /**
   * Int32s the process's threads share: the last thread id, the threads
   * running besides the main one, the descriptor table's generation.
   */
  ids: SharedArrayBuffer;
  /** The side modules the process has compiled, by path (a WASIX dynamically linked program). */
  modules?: Record<string, WebAssembly.Module>;
}

export interface WasmThreadSpawnMsg {
  type: typeof WASM_THREAD_SPAWN;
  thread: WasmThread;
}

/** The process's init, with the thread's own SAB bridge and what it runs. */
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
