/**
 * `TerminalSessionHost` — worker-side endpoint for the terminal RPC
 * protocol.
 *
 * Co-resides with `OffscreenBridge` on the kernel port: both
 * subscribe to the same transport, both filter by the messages they
 * care about. The bridge handles orchestrator traffic; this host
 * handles `terminal-*` envelopes (see `terminal-protocol.ts`).
 *
 * Per-session lifecycle:
 *   `terminal-open`  → construct a `AlmostBashShellHeadless`,
 *                      reply with `terminal-status: opened`.
 *   `terminal-exec`  → run the command via the headless shell,
 *                      emit `terminal-output` (stdout + stderr) and
 *                      `terminal-exit { exitCode }`.
 *   `terminal-signal { SIGINT | SIGTERM | SIGKILL }` →
 *                      abort the in-flight exec via its
 *                      `AbortController`. The process model widens
 *                      this to STOP/CONT etc.
 *   `terminal-close` → dispose the shell, reply
 *                      `terminal-status: closed`.
 *
 * Output stream caveats: `AlmostBashShellHeadless.executeCommand` returns
 * the full result in one shot — it doesn't stream. The host emits
 * one `terminal-output` per stdout/stderr block, then the `exit`
 * event. A future streaming runtime can switch to chunked emission
 * without changing the envelope shape.
 *
 * `terminal-stdin` and `terminal-resize` are intentionally
 * unhandled today: the panel-side line editor accumulates
 * keystrokes locally and sends committed lines via `terminal-exec`,
 * so stdin doesn't need a wire round-trip; resize is informational
 * (the worker shell doesn't render). They're reserved on the wire
 * for when a streaming pty-style mode lands.
 */

import type {
  HeadlessShellLike,
  HeadlessShellOptions,
} from '../shell/almost-bash-shell-headless.js';
import type {
  TerminalCloseMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExecMsg,
  TerminalExitMsg,
  TerminalOpenMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalSignalMsg,
  TerminalStatusMsg,
} from '../shell/terminal-protocol.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from './messages.js';
import type { Process, ProcessManager, ProcessOwner, Signal } from './process-manager.js';
import type { KernelTransport } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Per-session shell factory. The host calls this for every
 * `terminal-open` and disposes the returned shell on
 * `terminal-close`.
 *
 * Production wiring (in `kernel-worker.ts`'s `boot()`) returns a
 * `AlmostBashShellHeadless` over the worker's shared FS / browser API.
 * Tests pass a stub.
 */
export type TerminalShellFactory = (
  sid: TerminalSessionId,
  options: { cwd?: string; env?: Record<string, string> }
) => HeadlessShellLike & { dispose?: () => void };

export interface TerminalSessionHostOptions {
  /**
   * Same kernel transport the OffscreenBridge uses. We subscribe
   * via `onMessage` (multiple subscribers are supported on the
   * underlying chrome.runtime / MessageChannel adapters) and only
   * react to panel-source `terminal-*` envelopes.
   */
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  /** Construct a shell for each new session. */
  createShell: TerminalShellFactory;
  /**
   * Optional process manager. When provided, each
   * `terminal-exec` registers a `kind:'shell'` process whose
   * `Process.abort` is the controller threaded into the headless
   * shell's `executeCommand(cmd, signal)` call. Signals route
   * through `pm.signal(pid, sig)` instead of the host's local
   * controller, so `ps` and `/proc` see the exec live, and `kill`
   * from another shell stops it.
   *
   * Without `pm`, the host falls back to a single per-exec
   * `AbortController`. Tests and the offscreen extension path that
   * haven't been wired to a manager yet stay untouched.
   */
  processManager?: ProcessManager;
  /**
   * Default owner for spawned shell processes. Defaults to
   * `{ kind: 'system' }` — terminal sessions in the current
   * standalone-worker layout aren't yet associated with a scoop.
   * A follow-up may parameterize per-session (so the cone's
   * panel terminal carries `{ kind: 'cone', scoopJid }`).
   */
  defaultOwner?: ProcessOwner;
  /**
   * Logger; defaults to `console`. Override in tests to silence
   * expected warnings (e.g. signal-on-unknown-session).
   */
  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

interface Session {
  shell: HeadlessShellLike & { dispose?: () => void };
  /** AbortController for the currently-running exec, if any. */
  currentExec: AbortController | null;
  /**
   * The active shell `Process`, set when `processManager` is
   * configured and an exec is in flight. Mirrors `currentExec`
   * (the controller is the same `Process.abort`); kept separately
   * so `handleSignal` can route through the manager.
   */
  currentProcess: Process | null;
}

export class TerminalSessionHost {
  private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  private readonly createShell: TerminalShellFactory;
  private readonly log: NonNullable<TerminalSessionHostOptions['logger']>;
  private readonly pm: ProcessManager | null;
  private readonly defaultOwner: ProcessOwner;
  private readonly sessions = new Map<TerminalSessionId, Session>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: TerminalSessionHostOptions) {
    this.transport = options.transport;
    this.createShell = options.createShell;
    this.log = options.logger ?? console;
    this.pm = options.processManager ?? null;
    this.defaultOwner = options.defaultOwner ?? { kind: 'system' };
  }

  /**
   * Subscribe to the transport. Returns a `dispose` that
   * unsubscribes and tears down all open sessions.
   */
  start(): () => void {
    if (this.unsubscribe) return () => this.dispose();
    this.unsubscribe = this.transport.onMessage((envelope) => {
      // Only handle panel-source terminal-* messages.
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'panel') return;
      const payload = envelope.payload as PanelToOffscreenMessage;
      if (!isTerminalControlMsg(payload)) return;
      void this.handleControl(payload).catch((err) => {
        this.log.warn('[terminal-session-host] handler error', err);
      });
    });
    return () => this.dispose();
  }

  /** Tear down. Idempotent. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, session] of this.sessions) {
      if (session.currentProcess && this.pm) {
        // Reap the in-flight exec as a teardown abort. SIGTERM
        // matches the conventional "shutdown" semantic; the dispose
        // path doesn't have a user-visible exit code anyway.
        this.pm.signal(session.currentProcess.pid, 'SIGTERM');
        this.pm.exit(session.currentProcess.pid, null);
      } else {
        session.currentExec?.abort();
      }
      session.shell.dispose?.();
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async handleControl(msg: TerminalControlMsg): Promise<void> {
    switch (msg.type) {
      case 'terminal-open':
        return this.handleOpen(msg);
      case 'terminal-close':
        return this.handleClose(msg);
      case 'terminal-exec':
        return this.handleExec(msg);
      case 'terminal-signal':
        return this.handleSignal(msg);
      case 'terminal-stdin':
      case 'terminal-resize':
        // Reserved on the wire for a future streaming-pty mode. No
        // semantic action today; silently accept so existing clients
        // can ship the messages without breaking.
        return;
    }
  }

  private async handleOpen(msg: TerminalOpenMsg): Promise<void> {
    if (this.sessions.has(msg.sid)) {
      this.emitStatus(msg.sid, 'error', 'session already open');
      return;
    }
    try {
      const shell = this.createShell(msg.sid, { cwd: msg.cwd, env: msg.env });
      this.sessions.set(msg.sid, { shell, currentExec: null, currentProcess: null });
      this.emitStatus(msg.sid, 'opened');
    } catch (err) {
      this.emitStatus(msg.sid, 'error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleClose(msg: TerminalCloseMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) return; // idempotent
    if (session.currentProcess && this.pm) {
      this.pm.signal(session.currentProcess.pid, 'SIGTERM');
      this.pm.exit(session.currentProcess.pid, null);
    } else {
      session.currentExec?.abort();
    }
    session.shell.dispose?.();
    this.sessions.delete(msg.sid);
    this.emitStatus(msg.sid, 'closed');
  }

  /** Emit a `terminal-exit` for the given exec. */
  private emitExit(msg: TerminalExecMsg, exitCode: number): void {
    this.emit({
      type: 'terminal-exit',
      sid: msg.sid,
      execId: msg.execId,
      exitCode,
    } satisfies TerminalExitMsg);
  }

  /** Emit a `terminal-output` chunk on the given stream. */
  private emitStream(msg: TerminalExecMsg, stream: 'stdout' | 'stderr', data: string): void {
    this.emit({
      type: 'terminal-output',
      sid: msg.sid,
      execId: msg.execId,
      stream,
      data,
    } satisfies TerminalOutputMsg);
  }

  private async handleExec(msg: TerminalExecMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      // Emit a synthetic exit so the client doesn't hang.
      this.emitExit(msg, 127);
      this.log.warn('[terminal-session-host] exec on unknown session', msg.sid);
      return;
    }

    if (session.currentExec) {
      // The protocol allows only one exec at a time per session.
      // If a new exec arrives while one is running, surface an
      // immediate exit; the panel-side line editor enforces this
      // already, so this is a defense-in-depth.
      this.emitExit(msg, 130);
      return;
    }

    // When a `ProcessManager` is configured, the per-exec
    // controller is the `Process.abort` (`adoptAbort` keeps the same
    // identity so anyone holding a reference still works). Without
    // a manager, we fall back to a fresh local controller.
    const abort = new AbortController();
    session.currentExec = abort;
    const proc = this.pm
      ? this.pm.spawn({
          kind: 'shell',
          argv: [msg.command],
          cwd: session.shell.getCwd?.() ?? undefined,
          owner: this.defaultOwner,
          adoptAbort: abort,
        })
      : null;
    session.currentProcess = proc;
    try {
      // Pass the shell proc pid so realm-backed commands (`node` / `.jsh` /
      // `python`) parent their realm child to it — a terminal signal to this
      // shell pid then fans out to the realm via `pm.signal` (#1116).
      const result = await session.shell.executeCommand(msg.command, abort.signal, proc?.pid);
      await this.emitExecSuccess(msg, result, abort, proc);
    } catch (err) {
      this.emitExecError(msg, err, abort, proc);
    } finally {
      // Only clear if we still own the slot — a future process
      // model may juggle multiple controllers per session, but
      // today there's at most one.
      if (session.currentExec === abort) {
        session.currentExec = null;
        session.currentProcess = null;
      }
    }
  }

  /** Emit gated output + exit for a completed exec, and settle the process. */
  private async emitExecSuccess(
    msg: TerminalExecMsg,
    result: { stdout: string; stderr: string; exitCode: number },
    abort: AbortController,
    proc: Process | null
  ): Promise<void> {
    // Derive the aborted code from the recorded signal (mirroring
    // `emitExecError`) so a terminal `kill -TERM/-9 <shellPid>` that still
    // returns normally from the shell reports 143/137 instead of being
    // flattened to 130. SIGINT still maps to 130.
    const exitCode = abort.signal.aborted
      ? signalExitCode(proc?.terminatedBy ?? 'SIGINT')
      : result.exitCode;
    if (!abort.signal.aborted) {
      // Gate output + exit emission. If the user (or another shell) sent
      // SIGSTOP between command launch and now, hold the buffer here until
      // SIGCONT lands. The gate auto-releases on `pm.exit` / terminating
      // signals so a SIGINT after SIGSTOP still terminates cleanly.
      if (proc) await proc.gate.wait();
      if (result.stdout) this.emitStream(msg, 'stdout', result.stdout);
      if (result.stderr) this.emitStream(msg, 'stderr', result.stderr);
    }
    this.emitExit(msg, exitCode);
    // Process lifetime: the manager records `terminatedBy` from `signal()`;
    // calling `exit(pid, null)` here lets it derive the right code (130
    // SIGINT, 143 SIGTERM, …) when an abort raced the shell return.
    // Otherwise we pass the real code.
    if (proc && this.pm) {
      this.pm.exit(proc.pid, abort.signal.aborted ? null : result.exitCode);
    }
  }

  /** Emit the exit (and any error output) for a failed/aborted exec. */
  private emitExecError(
    msg: TerminalExecMsg,
    err: unknown,
    abort: AbortController,
    proc: Process | null
  ): void {
    // If the abort fired, the shell typically rejects with an "aborted"
    // error. Treat that as a signal-derived exit (130 for SIGINT, 143/137
    // for SIGTERM/KILL) instead of a generic failure (1).
    if (abort.signal.aborted) {
      this.emitExit(msg, signalExitCode(proc?.terminatedBy ?? 'SIGINT'));
      if (proc && this.pm) this.pm.exit(proc.pid, null);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.emitStream(msg, 'stderr', `Error: ${message}\n`);
    this.emitExit(msg, 1);
    if (proc && this.pm) this.pm.exit(proc.pid, 1);
  }

  private async handleSignal(msg: TerminalSignalMsg): Promise<void> {
    const session = this.sessions.get(msg.sid);
    if (!session) {
      this.log.warn('[terminal-session-host] signal on unknown session', msg.sid);
      return;
    }
    // Route through the manager so the recorded `terminatedBy`
    // and `kind:'shell'` exit code are correct, and any future
    // `kill -INT <pid>` from another shell hits the same code path.
    // SIGSTOP / SIGCONT remain reserved.
    if (msg.signal === 'SIGINT' || msg.signal === 'SIGTERM' || msg.signal === 'SIGKILL') {
      if (session.currentProcess && this.pm) {
        this.pm.signal(session.currentProcess.pid, msg.signal);
      } else {
        session.currentExec?.abort();
      }
    }
  }

  private emit(event: TerminalEventMsg): void {
    this.transport.send(event as OffscreenToPanelMessage);
  }

  private emitStatus(
    sid: TerminalSessionId,
    state: 'opened' | 'closed' | 'error',
    error?: string
  ): void {
    const msg: TerminalStatusMsg = error
      ? { type: 'terminal-status', sid, state, error }
      : { type: 'terminal-status', sid, state };
    this.emit(msg);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExtensionEnvelope(value: unknown): value is ExtensionMessage {
  return typeof value === 'object' && value !== null && 'source' in value && 'payload' in value;
}

/**
 * Conventional Unix exit codes for terminating signals. Mirrors the
 * `SIGNAL_EXIT_CODE` table in `process-manager.ts` but kept local so
 * the synchronous `terminal-exit` emit doesn't need to round-trip
 * through `proc.exitCode` (which is set by `pm.exit`, not by
 * `pm.signal`).
 */
function signalExitCode(sig: Signal): number {
  switch (sig) {
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    case 'SIGKILL':
      return 137;
    case 'SIGSTOP':
    case 'SIGCONT':
      // Reserved — execs aren't terminated by these. Fall through to
      // the SIGINT default since this branch is only reached on
      // aborted execs.
      return 130;
  }
}

function isTerminalControlMsg(payload: unknown): payload is TerminalControlMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === 'terminal-open' ||
    t === 'terminal-close' ||
    t === 'terminal-exec' ||
    t === 'terminal-signal' ||
    t === 'terminal-stdin' ||
    t === 'terminal-resize'
  );
}

// ---------------------------------------------------------------------------
// Production wiring helper
// ---------------------------------------------------------------------------

/**
 * Build a `TerminalShellFactory` over a `AlmostBashShellHeadless` factory.
 * The kernel-worker boot path uses this with options pre-bound to
 * the worker's shared FS / browser API.
 *
 * Exported so tests can compose the same shape with a stubbed
 * shell ctor.
 */
export function createAlmostBashShellTerminalFactory(
  buildShell: (
    cwd?: string,
    env?: Record<string, string>
  ) => HeadlessShellLike & {
    dispose?: () => void;
  }
): TerminalShellFactory {
  return (_sid, opts) => buildShell(opts.cwd, opts.env);
}

export type { HeadlessShellOptions };
