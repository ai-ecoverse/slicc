// tva
/**
 * `CupSessionRegistry` — session-keyed headless shells for
 * cup (steering) mode.
 *
 * One shell instance per `sessionId`; created on first use and kept
 * alive until `sweepIdle` or `dispose`. Each exec appends to a
 * bounded recent-output tail (64K-char cap, keeps the LATEST chars on
 * overflow). ProcessManager integration mirrors `TerminalSessionHost`
 * (`handleExec`) so cup shell sessions show up in `ps`/`kill`
 * and `/proc`.
 *
 * No DOM APIs — this module runs in the kernel worker context.
 *
 * Wire-up: the registry is constructed in `kernel-worker.ts` under
 * cup mode (Task 5 / Task 7). `sweepIdle` is called from a
 * setInterval in the worker. Task 4 is the module + unit tests only.
 */

import type { HeadlessShellLike } from '../shell/almost-bash-shell-headless.js';
import type { ProcessManager, ProcessOwner } from './process-manager.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
}

export interface SessionStatus {
  alive: boolean;
  cwd: string;
  runningPids: number[];
  bufferedTail: string;
}

/** A single output/exit event from `streamExec`. */
export type ExecFrame =
  | { t: 'stdout' | 'stderr'; d: string }
  | { t: 'exit'; code: number; pid: number | null };

export interface CupSessionRegistry {
  runExec(sessionId: string, command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult>;
  streamExec(
    sessionId: string,
    command: string,
    onFrame: (f: ExecFrame) => void,
    opts?: { signal?: AbortSignal }
  ): Promise<void>;
  sessionStatus(sessionId: string): SessionStatus;
  sweepIdle(now: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sessions idle longer than this are collected by `sweepIdle`. */
export const IDLE_RETAIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Maximum characters (UTF-16 code units) kept in the recent-output
 * tail. On overflow the LATEST chars are kept. Counts code units, not
 * bytes — a code-unit cap can't split a UTF-16 surrogate pair the way
 * a byte cap could split a multi-byte sequence, and it matches the
 * `transcript-limits.ts` style cap.
 */
export const TAIL_CAP_CHARS = 64 * 1024; // 64K chars

// ---------------------------------------------------------------------------
// Shell factory type
// ---------------------------------------------------------------------------

/**
 * Factory that builds a headless shell for a new session.
 * Mirrors `TerminalShellFactory` shape from `terminal-session-host.ts`.
 */
export type CupShellFactory = (
  sessionId: string,
  opts: { cwd?: string; env?: Record<string, string> }
) => HeadlessShellLike & { dispose?: () => void };

// ---------------------------------------------------------------------------
// Registry options
// ---------------------------------------------------------------------------

export interface CupSessionRegistryOptions {
  shellFactory: CupShellFactory;
  /** Initial cwd passed to every new shell. */
  cwd?: string;
  /** Initial env passed to every new shell. */
  env?: Record<string, string>;
  /** Optional ProcessManager for `ps`/`kill` visibility. */
  processManager?: ProcessManager;
  /** Default process owner for spawned shell processes. */
  processOwner?: ProcessOwner;
  /** Injectable clock for unit-testing `sweepIdle`. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal session record
// ---------------------------------------------------------------------------

interface SessionEntry {
  shell: HeadlessShellLike & { dispose?: () => void };
  /** Bounded recent-output tail (stdout + stderr appended together). */
  tail: string;
  /** Timestamp of the last completed exec, from the injected clock. */
  lastActiveAt: number;
  /** Pids of currently in-flight execs (0 or 1 — see `busy`). */
  runningPids: number[];
  /**
   * True while an `executeCommand` is in flight for this session. The
   * underlying headless shell is NOT concurrency-safe (it shares one
   * just-bash runtime, cwd, and env), so the registry refuses a second
   * overlapping exec rather than corrupting the shell or
   * `runningPids`. Mirrors `TerminalSessionHost`'s per-session
   * `currentExec` overlap guard.
   */
  busy: boolean;
}

/**
 * Exit code surfaced when an exec is rejected because the session is
 * already running a command. 130 mirrors the panel terminal's
 * "interrupted / can't run now" convention in `TerminalSessionHost`.
 */
const BUSY_EXIT_CODE = 130;

const BUSY_STDERR = 'cup: session busy — a command is already running\n';

// ---------------------------------------------------------------------------
// Tail buffer helper
// ---------------------------------------------------------------------------

/**
 * Append `chunk` to `tail`, then truncate to at most `cap` chars
 * (UTF-16 code units), keeping the LATEST chars (the end of the
 * combined string).
 */
function appendTail(tail: string, chunk: string, cap: number): string {
  const combined = tail + chunk;
  if (combined.length <= cap) return combined;
  return combined.slice(combined.length - cap);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCupSessionRegistry(options: CupSessionRegistryOptions): CupSessionRegistry {
  const { shellFactory, cwd, env, processManager: pm, processOwner, now = Date.now } = options;

  const sessions = new Map<string, SessionEntry>();

  // -------------------------------------------------------------------------
  // Ensure session exists, creating it on first use.
  // -------------------------------------------------------------------------

  function getOrCreateSession(sessionId: string): SessionEntry {
    let entry = sessions.get(sessionId);
    if (!entry) {
      const shell = shellFactory(sessionId, { cwd, env });
      entry = {
        shell,
        tail: '',
        lastActiveAt: now(),
        runningPids: [],
        busy: false,
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // Process management helpers (split from execCore to keep complexity down)
  // -------------------------------------------------------------------------

  /** Spawn a ProcessManager process for a shell exec. Returns the process or null. */
  function spawnShellProcess(
    entry: SessionEntry,
    command: string,
    abort: AbortController
  ): ReturnType<ProcessManager['spawn']> | null {
    if (!pm) return null;
    const proc = pm.spawn({
      kind: 'shell',
      argv: [command],
      cwd: entry.shell.getCwd?.() ?? cwd ?? '/',
      owner: processOwner ?? { kind: 'system' },
      adoptAbort: abort,
    });
    entry.runningPids.push(proc.pid);
    return proc;
  }

  /** Reap the process after exec: exit the PM record and remove from entry pids. */
  function reapProcess(
    entry: SessionEntry,
    proc: ReturnType<ProcessManager['spawn']> | null,
    exitCode: number | null
  ): void {
    if (!proc) return;
    if (pm) pm.exit(proc.pid, exitCode);
    entry.runningPids = entry.runningPids.filter((p) => p !== proc.pid);
  }

  // -------------------------------------------------------------------------
  // Core exec implementation (shared by runExec and streamExec).
  // -------------------------------------------------------------------------

  async function execCore(
    entry: SessionEntry,
    command: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number; pid: number | null }> {
    // Overlap guard: the headless shell shares one runtime/cwd/env and
    // isn't concurrency-safe, so a second exec on a busy session is
    // rejected (not queued) with a synthetic busy result. Mirrors the
    // panel terminal's per-session `currentExec` refusal. NOTE: the
    // check + set must stay synchronous (no `await` between them) so two
    // overlapping calls can't both pass the guard.
    if (entry.busy) {
      return { stdout: '', stderr: BUSY_STDERR, exitCode: BUSY_EXIT_CODE, pid: null };
    }
    entry.busy = true;

    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort(), { once: true });

    const proc = spawnShellProcess(entry, command, abort);

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      // TODO(streaming): incremental output requires an executeCommand output
      // callback in AlmostBashShellHeadless — the current signature returns the
      // full result in one shot. Block-level frames are the phase-1 deliverable;
      // the wire ExecFrame envelope is unchanged when streaming is added later.
      result = await entry.shell.executeCommand(command, abort.signal);
    } catch (err) {
      reapProcess(entry, proc, abort.signal.aborted ? null : 1);
      throw err;
    } finally {
      entry.lastActiveAt = now();
      entry.busy = false;
    }

    reapProcess(entry, proc, abort.signal.aborted ? null : result.exitCode);

    if (result.stdout) entry.tail = appendTail(entry.tail, result.stdout, TAIL_CAP_CHARS);
    if (result.stderr) entry.tail = appendTail(entry.tail, result.stderr, TAIL_CAP_CHARS);

    return { ...result, pid: proc?.pid ?? null };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function runExec(
    sessionId: string,
    command: string,
    opts?: { signal?: AbortSignal }
  ): Promise<ExecResult> {
    const entry = getOrCreateSession(sessionId);
    const r = await execCore(entry, command, opts?.signal);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      pid: r.pid,
    };
  }

  async function streamExec(
    sessionId: string,
    command: string,
    onFrame: (f: ExecFrame) => void,
    opts?: { signal?: AbortSignal }
  ): Promise<void> {
    const entry = getOrCreateSession(sessionId);
    const r = await execCore(entry, command, opts?.signal);

    // Emit block-level frames (stdout then stderr, then exit).
    // TODO(streaming): wire incremental output callback when
    // AlmostBashShellHeadless.executeCommand gains one.
    if (r.stdout) onFrame({ t: 'stdout', d: r.stdout });
    if (r.stderr) onFrame({ t: 'stderr', d: r.stderr });
    onFrame({ t: 'exit', code: r.exitCode, pid: r.pid });
  }

  function sessionStatus(sessionId: string): SessionStatus {
    const entry = sessions.get(sessionId);
    if (!entry) {
      return { alive: false, cwd: '', runningPids: [], bufferedTail: '' };
    }
    return {
      alive: true,
      cwd: entry.shell.getCwd?.() ?? cwd ?? '/',
      runningPids: [...entry.runningPids],
      bufferedTail: entry.tail,
    };
  }

  function sweepIdle(sweepNow: number): void {
    for (const [sessionId, entry] of sessions) {
      if (sweepNow - entry.lastActiveAt >= IDLE_RETAIN_MS) {
        entry.shell.dispose?.();
        sessions.delete(sessionId);
      }
    }
  }

  function dispose(): void {
    for (const entry of sessions.values()) {
      entry.shell.dispose?.();
    }
    sessions.clear();
  }

  return { runExec, streamExec, sessionStatus, sweepIdle, dispose };
}

// ---------------------------------------------------------------------------
// Periodic GC sweep helper
// ---------------------------------------------------------------------------

/** Default interval for the GC sweep: 60 seconds. */
export const CUP_SWEEP_INTERVAL_MS = 60_000;

/**
 * Start a periodic `sweepIdle` interval for a `CupSessionRegistry`.
 * Returns a stop function that clears the interval.
 *
 * @param registry  — must expose `sweepIdle(now: number) => void`
 * @param intervalMs — how often to run the sweep (ms)
 * @param timers   — injectable timer object for testability (defaults to global)
 * @param now      — injectable clock for testability (defaults to `Date.now`)
 */
export function startCupSweep(
  registry: Pick<CupSessionRegistry, 'sweepIdle'>,
  intervalMs: number,
  // Call the globals as methods of `globalThis` (NOT as bare props of this
  // options object): in a browser worker setInterval/clearInterval are
  // WorkerGlobalScope methods that throw "Illegal invocation" when `this` is a
  // plain object. The simple param types also dodge the Node-vs-DOM
  // `typeof setInterval` overload clash. (Node is lenient at runtime — which is
  // why the bare form passed unit tests but failed live.)
  timers: {
    setInterval: (handler: () => void, ms: number) => unknown;
    clearInterval: (id: unknown) => void;
  } = {
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (id) => globalThis.clearInterval(id as number),
  },
  now: () => number = Date.now
): () => void {
  const id = timers.setInterval(() => registry.sweepIdle(now()), intervalMs);
  return () => timers.clearInterval(id);
}
