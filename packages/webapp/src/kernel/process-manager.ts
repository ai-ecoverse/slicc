/**
 * `ProcessManager` — every async unit of work the kernel performs has
 * a pid the user can name.
 *
 * Phase 3 step 1. The data structure: a process record with a
 * monotonic uint32 pid, parent/child links, an `AbortController` for
 * cooperative cancellation, and a small lifecycle (`pending` →
 * `running` → `exited` / `killed`). Phase 3 steps 2–5 wire it into
 * `TerminalSessionHost`, `ScoopContext.prompt`, `tool-adapter`, and
 * `jsh-executor` so every long-running unit shows up here. Phase 4
 * surfaces the table via `ps` / `kill`; Phase 5 mounts `/proc`;
 * Phase 6 adds a pause/resume gate; Phase 7 adds preemption via
 * child workers.
 *
 * Design notes:
 *   - **No globals.** The manager is constructed by `createKernelHost`
 *     and threaded through `WasmShellOptions` / `HeadlessShellOptions`,
 *     `ScoopContext` constructor, `TerminalSessionHost`, etc. Tests
 *     instantiate it directly. The `globalThis.__slicc_*` hooks remain
 *     as fallback for shell scripts and `.jsh` callers that can't
 *     receive constructor injection.
 *   - **No `AsyncLocalStorage`.** `Process` is passed explicitly. The
 *     parent layer asks `pm.spawn(...)` and gets back a `Process`
 *     handle; the child gets that handle through whatever channel
 *     fits best (constructor arg, `BashExecOptions.process`, the tool
 *     adapter's `ToolExecutionContext.process`, …). Implicit context
 *     hides where lifetimes start and end and breaks the moment a
 *     boundary loses async context (everything that hops through a
 *     `MessagePort`, every CDP round-trip, every event-listener
 *     callback). Explicit DI is verbose but auditable.
 *   - **Pids start at 1024.** Below that is reserved for future "well
 *     known" anchors (kernel-host pid, lick-manager pid, …) that
 *     don't have a one-to-one process record but still want to show
 *     up as a `ppid` for orphan children. Wraps to 1024 once the
 *     uint32 space is exhausted; collisions are vanishingly unlikely
 *     in a single browser session, but `spawn()` skips entries whose
 *     pid is still live.
 *   - **Synchronous events.** `on('spawn')` / `on('exit')` listeners
 *     run synchronously inside `spawn()` / `exit()`. This matters for
 *     the `/proc` mount (Phase 5): `ls /proc` must see a process the
 *     instant it's spawned. Async listeners that need to do IO can
 *     queue their own `setTimeout(0)` work.
 *   - **AbortController per process.** A `SIGINT`/`SIGTERM`/`SIGKILL`
 *     all just call `controller.abort()` on the process's controller
 *     today. The signal value is recorded in `Process.terminatedBy`
 *     so callers (terminal RPC, ps) can render the right exit code
 *     (130 for SIGINT, 143 for SIGTERM, 137 for SIGKILL). Phase 6
 *     splits SIGSTOP/SIGCONT off into a separate `Gate`; Phase 7's
 *     `kind:'preemptive'` overrides SIGKILL with `worker.terminate()`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of process this is — drives the `ps` `STAT` column. */
export type ProcessKind = 'scoop-turn' | 'tool' | 'shell' | 'jsh' | 'net' | 'preemptive';

export type ProcessStatus = 'pending' | 'running' | 'exited' | 'killed';

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';

export interface ProcessOwner {
  /** 'cone' | 'scoop' | 'system' — drives the `ps` `SCOOP` column. */
  kind: 'cone' | 'scoop' | 'system';
  /** Scoop JID when `kind === 'scoop'` (or the cone's JID when 'cone'). */
  scoopJid?: string;
}

export interface SpawnOptions {
  kind: ProcessKind;
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  owner: ProcessOwner;
  /**
   * Optional parent pid. When omitted, defaults to the kernel-host pid
   * (1) so orphan reads of `/proc/<pid>/stat` always have a real
   * `ppid`. Phase 4's `ps -T` walks this link.
   */
  ppid?: number;
  /**
   * Existing `AbortController` to adopt. Useful when the caller already
   * built one (e.g. `TerminalSessionHost.handleExec` per-exec
   * controller). When omitted, the process gets a fresh controller.
   * Either way, `Process.abort` is the single source of truth — the
   * caller should NOT keep its own `AbortController` reference for
   * signaling; route signals through `pm.signal(pid, sig)` instead.
   */
  adoptAbort?: AbortController;
}

/**
 * Process record. Read-only from outside the manager; the manager
 * mutates `status` / `exitCode` / `terminatedBy` / `finishedAt`
 * during the lifecycle.
 */
export interface Process {
  readonly pid: number;
  readonly ppid: number;
  readonly kind: ProcessKind;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly owner: ProcessOwner;
  readonly abort: AbortController;
  readonly startedAt: number;
  status: ProcessStatus;
  exitCode: number | null;
  /**
   * Recorded when `signal()` first hits a non-exited process. The
   * actual termination is still cooperative (the consumer of
   * `abort.signal` decides when to stop). `exit()` translates this
   * into a conventional exit code (`130` SIGINT, `143` SIGTERM,
   * `137` SIGKILL) when the caller passes `null` for the exit code.
   */
  terminatedBy: Signal | null;
  finishedAt: number | null;
}

export type ProcessEvent = 'spawn' | 'exit';

export type ProcessEventListener = (proc: Process) => void;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const PID_FLOOR = 1024;
const PID_CEIL = 0xffffffff;

/**
 * Conventional Unix exit codes for signals — used as the default
 * when `pm.exit(pid, null)` runs on a process that was previously
 * signaled. Callers can still override with an explicit exit code
 * (e.g. just-bash returning 0 even after a SIGTERM-flavored abort).
 */
const SIGNAL_EXIT_CODE: Record<Signal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGKILL: 137,
  SIGSTOP: 128 + 19,
  SIGCONT: 128 + 18,
};

export class ProcessManager {
  private readonly processes = new Map<number, Process>();
  private nextPid = PID_FLOOR;
  private readonly listeners: Record<ProcessEvent, Set<ProcessEventListener>> = {
    spawn: new Set(),
    exit: new Set(),
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Allocate a pid + register the process. Listeners fire
   * synchronously before `spawn` returns. Status starts at `running`
   * — callers that want a two-phase startup (Phase 7's preemptive
   * worker) can flip it manually after `worker.postMessage(init)`
   * but before the first `running` event.
   */
  spawn(options: SpawnOptions): Process {
    const pid = this.allocatePid();
    const abort = options.adoptAbort ?? new AbortController();
    const proc: Process = {
      pid,
      ppid: options.ppid ?? 1,
      kind: options.kind,
      argv: options.argv.slice(),
      cwd: options.cwd ?? '/',
      env: { ...(options.env ?? {}) },
      owner: { ...options.owner },
      abort,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      terminatedBy: null,
      finishedAt: null,
    };
    this.processes.set(pid, proc);
    this.fire('spawn', proc);
    return proc;
  }

  /**
   * Mark a process as exited. Idempotent — repeated calls are a
   * no-op. Pass `null` for `exitCode` to derive it from the recorded
   * signal (or 0 if no signal was ever sent — clean exit).
   */
  exit(pid: number, exitCode: number | null): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    if (proc.status === 'exited' || proc.status === 'killed') return;
    proc.finishedAt = Date.now();
    if (exitCode !== null) {
      proc.exitCode = exitCode;
      proc.status = proc.terminatedBy ? 'killed' : 'exited';
    } else if (proc.terminatedBy) {
      proc.exitCode = SIGNAL_EXIT_CODE[proc.terminatedBy];
      proc.status = 'killed';
    } else {
      proc.exitCode = 0;
      proc.status = 'exited';
    }
    this.fire('exit', proc);
  }

  /**
   * Send a signal to a process. Today every signal except
   * SIGSTOP/SIGCONT calls `abort.abort()` once and records
   * `terminatedBy`; the actual termination is cooperative
   * (the consumer of `abort.signal` decides when to stop).
   *
   * Returns `true` when the signal was delivered (process exists +
   * not already terminated), `false` otherwise — matching POSIX
   * `kill(2)` semantics. Phase 6 will widen this to handle the
   * pause/resume gate; Phase 7's preemptive worker will override
   * SIGKILL to `worker.terminate()`.
   */
  signal(pid: number, sig: Signal): boolean {
    const proc = this.processes.get(pid);
    if (!proc) return false;
    if (proc.status === 'exited' || proc.status === 'killed') return false;
    if (sig === 'SIGSTOP' || sig === 'SIGCONT') {
      // Reserved for Phase 6 (gate). No-op today; record so
      // observability tools can see the signal was attempted.
      return true;
    }
    // Record the FIRST terminating signal — subsequent SIGKILL after
    // SIGTERM doesn't change the exit code, mirroring just-bash and
    // POSIX behavior.
    if (!proc.terminatedBy) {
      proc.terminatedBy = sig;
    }
    if (!proc.abort.signal.aborted) {
      proc.abort.abort();
    }
    return true;
  }

  /** Return a snapshot of all processes. The returned array is a copy. */
  list(): Process[] {
    return Array.from(this.processes.values());
  }

  /**
   * Return `proc` for `pid`, or `null` if the pid was never allocated
   * or has been reaped (Phase 4's reaping policy: keep terminated
   * processes for one minute so `ps` after `kill` shows the exit
   * code; until reaping lands, terminated entries persist).
   */
  get(pid: number): Process | null {
    return this.processes.get(pid) ?? null;
  }

  /**
   * Resolve when the process exits. If the pid is unknown, rejects
   * synchronously — there's no "wait for a future spawn of this pid"
   * semantic; callers wait on a `Process` they were handed.
   */
  wait(pid: number): Promise<Process> {
    const proc = this.processes.get(pid);
    if (!proc) return Promise.reject(new Error(`pm: no such process: ${pid}`));
    if (proc.status === 'exited' || proc.status === 'killed') {
      return Promise.resolve(proc);
    }
    return new Promise<Process>((resolve) => {
      const handler = (p: Process): void => {
        if (p.pid !== pid) return;
        this.listeners.exit.delete(handler);
        resolve(p);
      };
      this.listeners.exit.add(handler);
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Subscribe to spawn / exit events. Returns an unsubscribe fn. */
  on(event: ProcessEvent, listener: ProcessEventListener): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private allocatePid(): number {
    // Linear probe for a free pid. In a 1k-process session this
    // probes at most a handful of slots; with reaping (Phase 4) the
    // table stays small.
    const start = this.nextPid;
    let pid = start;
    do {
      if (!this.processes.has(pid)) {
        this.nextPid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
        return pid;
      }
      pid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
      if (pid === start) {
        throw new Error('pm: pid space exhausted');
      }
    } while (true);
  }

  private fire(event: ProcessEvent, proc: Process): void {
    // Snapshot to a copy so listeners that unsubscribe themselves
    // mid-fire don't perturb the iteration.
    const listeners = Array.from(this.listeners[event]);
    for (const l of listeners) {
      try {
        l(proc);
      } catch (err) {
        // Listener errors must not break the manager's invariants —
        // they could leave a process in a half-spawned state. Surface
        // via console; the kernel logger isn't always available here
        // (e.g. tests pass a bare `new ProcessManager()`).
         
        console.warn('[pm] listener error', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper for callers that want to thread a process through an
 * async block: spawn, run, exit (with the right code derived from
 * the block's return / throw). The block sees `proc.abort.signal`
 * for cooperative cancellation.
 *
 * ```ts
 * const result = await runAsProcess(pm, { kind:'tool', ... }, async (proc) => {
 *   return await tool.execute({ signal: proc.abort.signal, ... });
 * });
 * ```
 *
 * Exit code derivation:
 *   - block resolves → 0
 *   - block throws because of abort → derived from `terminatedBy`
 *   - block throws otherwise → 1
 */
export async function runAsProcess<T>(
  pm: ProcessManager,
  options: SpawnOptions,
  block: (proc: Process) => Promise<T>
): Promise<T> {
  const proc = pm.spawn(options);
  try {
    const result = await block(proc);
    pm.exit(proc.pid, 0);
    return result;
  } catch (err) {
    if (proc.abort.signal.aborted) {
      pm.exit(proc.pid, null);
    } else {
      pm.exit(proc.pid, 1);
    }
    throw err;
  }
}
