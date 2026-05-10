/**
 * `ProcessManager` — every async unit of work the kernel performs has
 * a pid the user can name. A process record carries a monotonic uint32
 * pid, parent/child links, an `AbortController` for cooperative
 * cancellation, a `Gate` for SIGSTOP/SIGCONT, and a small lifecycle
 * (`pending` → `running` → `exited` / `killed`). It's wired into
 * `TerminalSessionHost`, `ScoopContext.prompt`, `tool-adapter`, and
 * `jsh-executor` so every long-running unit shows up here, and surfaced
 * via `ps` / `kill` and the `/proc` mount.
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
 *     the `/proc` mount: `ls /proc` must see a process the instant
 *     it's spawned. Async listeners that need to do IO can queue their
 *     own `setTimeout(0)` work.
 *   - **AbortController per process.** SIGINT/SIGTERM/SIGKILL all
 *     call `controller.abort()` on the process's controller. The
 *     signal value is recorded in `Process.terminatedBy` so callers
 *     (terminal RPC, ps) can render the right exit code (130 for
 *     SIGINT, 143 for SIGTERM, 137 for SIGKILL). SIGSTOP/SIGCONT
 *     drive the `Gate` instead; the realm runner
 *     (`kernel/realm/realm-runner.ts`) subscribes to SIGKILL via
 *     `onSignal` and calls `realm.terminate()` synchronously so
 *     `node`/`.jsh`/`python` runaways are uncatchable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of process this is — drives the `ps` `STAT` column. */
export type ProcessKind = 'scoop-turn' | 'tool' | 'shell' | 'jsh' | 'py' | 'net';

export type ProcessStatus = 'pending' | 'running' | 'exited' | 'killed';

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';

/**
 * Pause/resume primitive. A `Gate` is a re-arming barrier that
 * IO-boundary code awaits before proceeding. Default state is
 * **resumed** — `wait()` returns immediately. SIGSTOP calls
 * `pause()`; subsequent `wait()` calls block on a single internal
 * promise. SIGCONT (`resume()`) resolves that promise so every
 * waiter wakes up at once. Auto-released on process exit so any
 * pending waiter doesn't deadlock if the parent code already chose
 * to exit.
 *
 * The gate is purely cooperative: callers must explicitly `await
 * gate.wait()` at the right points. Today the awaits are placed at
 * terminal output boundaries; VFS, network, and stdin gates can be
 * added as needed.
 */
export class Gate {
  private paused = false;
  private resumePromise: Promise<void> | null = null;
  private resumeResolve: (() => void) | null = null;
  private released = false;

  /** Block subsequent `wait()` calls until `resume()` runs. Idempotent. */
  pause(): void {
    if (this.released) return;
    if (this.paused) return;
    this.paused = true;
    this.resumePromise = new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  /** Wake every pending `wait()`. Idempotent. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const r = this.resumeResolve;
    this.resumePromise = null;
    this.resumeResolve = null;
    r?.();
  }

  /**
   * Resolve immediately if not paused; otherwise wait until
   * `resume()` (or the gate is `release()`d on process exit).
   */
  wait(): Promise<void> {
    if (!this.paused || this.released) return Promise.resolve();
    return this.resumePromise!;
  }

  /**
   * Permanently release: resolve any pending waiters, drop into a
   * "always resolved" state. Called by the manager from `exit()`
   * so a paused process at termination doesn't leak waiters.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.paused = false;
    const r = this.resumeResolve;
    this.resumePromise = null;
    this.resumeResolve = null;
    r?.();
  }

  isPaused(): boolean {
    return this.paused;
  }
}

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
   * `ppid`. `ps -T` walks this link.
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
  /**
   * Pause/resume gate. SIGSTOP → `gate.pause()`; SIGCONT →
   * `gate.resume()`. IO-boundary code (terminal output emission today;
   * future VFS / stdin / network gates) calls `await proc.gate.wait()`
   * before doing the next chunk of work. Default state is resumed —
   * `wait()` returns immediately. The manager `release()`s the gate
   * on `exit()` so a process that exits while paused doesn't leak
   * waiters.
   */
  readonly gate: Gate;
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

/**
 * Signal-delivery listener. Fires every time `pm.signal(pid, sig)`
 * delivers a signal to a live process — including SIGSTOP / SIGCONT
 * (which don't fire the abort) and signal escalations (e.g. a
 * SIGKILL after a previous SIGINT). The realm runner subscribes
 * here so it can `worker.terminate()` / `iframe.remove()` on every
 * SIGKILL, not just the first signal that aborts the controller.
 */
export type ProcessSignalListener = (proc: Process, sig: Signal) => void;

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
  private readonly signalListeners = new Set<ProcessSignalListener>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Allocate a pid + register the process. Listeners fire
   * synchronously before `spawn` returns. Status starts at `running`
   * — callers that want a two-phase startup can flip it manually
   * after `worker.postMessage(init)` but before the first `running`
   * event.
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
      gate: new Gate(),
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
    // Release the gate so any pending `wait()` resolves (e.g. a
    // paused stdout chunk that was waiting for SIGCONT when the
    // process got SIGKILL'd anyway). Callers that observe
    // `abort.signal.aborted` after their `wait()` resolves can then
    // bail out cleanly.
    proc.gate.release();
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
   * `kill(2)` semantics. SIGSTOP / SIGCONT drive the pause/resume
   * gate; the realm runner subscribes via `onSignal` and overrides
   * SIGKILL with `realm.terminate()` for `kind:'jsh'`/`'py'` realms.
   */
  signal(pid: number, sig: Signal): boolean {
    const proc = this.processes.get(pid);
    if (!proc) return false;
    if (proc.status === 'exited' || proc.status === 'killed') return false;
    if (sig === 'SIGSTOP') {
      // Pause the gate. Subsequent `await proc.gate.wait()` calls
      // block until SIGCONT. Existing aborts are not cleared (SIGINT
      // after SIGSTOP still kills, because the abort controller is
      // independent of the gate).
      proc.gate.pause();
      this.fireSignal(proc, sig);
      return true;
    }
    if (sig === 'SIGCONT') {
      // Resume the gate. Any waiters wake at once.
      proc.gate.resume();
      this.fireSignal(proc, sig);
      return true;
    }
    // Resolve `terminatedBy` for this signal:
    //   - SIGKILL escalates unconditionally (POSIX uncatchable
    //     semantic): even after a previous SIGINT / SIGTERM
    //     recorded a different `terminatedBy`, SIGKILL takes
    //     precedence.
    //   - SIGINT / SIGTERM are first-wins: a later SIGTERM after
    //     SIGINT leaves `terminatedBy = SIGINT`.
    if (sig === 'SIGKILL') {
      proc.terminatedBy = 'SIGKILL';
    } else if (proc.terminatedBy === null) {
      proc.terminatedBy = sig;
    }
    if (!proc.abort.signal.aborted) {
      proc.abort.abort();
    }
    // A terminating signal also releases the gate so
    // any paused waiter wakes (and observes `abort.signal.aborted`).
    proc.gate.release();
    this.fireSignal(proc, sig);
    return true;
  }

  /** Return a snapshot of all processes. The returned array is a copy. */
  list(): Process[] {
    return Array.from(this.processes.values());
  }

  /**
   * Return `proc` for `pid`, or `null` if the pid was never allocated.
   * No reaping today — terminated entries persist so `ps` after `kill`
   * still shows the exit code.
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

  /**
   * Subscribe to signal-delivery events. Fires every time
   * `signal(pid, sig)` succeeds — useful for hard-kill runners
   * (the realm runner) that need to react to SIGKILL specifically,
   * including escalations after a prior signal. Returns an
   * unsubscribe fn.
   */
  onSignal(listener: ProcessSignalListener): () => void {
    this.signalListeners.add(listener);
    return () => {
      this.signalListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private allocatePid(): number {
    // Linear probe for a free pid. The table size IS the live-process
    // count (no reaping yet), so the probe is bounded by
    // `processes.size`: starting from `nextPid`, we can hit at most
    // `size` collisions before finding a hole. Anything beyond
    // that means our bookkeeping is corrupt; fail loudly. Without
    // this bound, a corrupt table could spin a multi-billion-step
    // linear probe across the uint32 space and freeze the kernel
    // worker — far worse than a thrown error.
    const start = this.nextPid;
    const ceiling = this.processes.size + 1; // +1 to allow one full hop after the table is empty
    let pid = start;
    let probes = 0;
    while (probes <= ceiling) {
      if (!this.processes.has(pid)) {
        this.nextPid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
        return pid;
      }
      pid = pid + 1 > PID_CEIL ? PID_FLOOR : pid + 1;
      probes++;
      if (pid === start) {
        throw new Error('pm: pid space exhausted');
      }
    }
    throw new Error(
      `pm: pid allocation gave up after ${probes} probes (table size=${this.processes.size}); ` +
        'the process table is likely corrupt'
    );
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

  private fireSignal(proc: Process, sig: Signal): void {
    const listeners = Array.from(this.signalListeners);
    for (const l of listeners) {
      try {
        l(proc, sig);
      } catch (err) {
        console.warn('[pm] signal listener error', err);
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
