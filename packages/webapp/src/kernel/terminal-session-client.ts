/**
 * `TerminalSessionClient` — page-side counterpart to
 * `TerminalSessionHost`.
 *
 * The panel-side terminal-view constructs one of these per terminal
 * tab and uses it to:
 *   - Open a session in the worker.
 *   - Send committed lines for execution (`exec(cmd)`).
 *   - Subscribe to inbound output / media-preview / status events.
 *   - Send signals (Ctrl+C → SIGINT) and close the session.
 *
 * The client multiplexes one transport across multiple `exec` calls
 * by allocating a fresh `execId` for each and matching `terminal-exit`
 * events back to their pending promises.
 *
 * Output streaming: the worker emits one `terminal-output` per
 * stdout/stderr block then a `terminal-exit`. The client surfaces
 * outputs via `onEvent` (callers buffer them) and resolves the
 * `exec` promise on the matching `terminal-exit`. A future
 * streaming runtime can switch to per-chunk emissions without
 * changing this surface.
 */

import type {
  TerminalClearedMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExitMsg,
  TerminalMediaPreviewMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalStatusMsg,
} from '../shell/terminal-protocol.js';
import type { OffscreenClient } from '../ui/offscreen-client.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TerminalSessionClientOptions {
  /**
   * The page-side `OffscreenClient` (or anything structurally
   * compatible) used to send `TerminalControlMsg` envelopes and
   * receive `TerminalEventMsg`s. The client uses
   * `client.sendRaw(message)` for outbound traffic — that hook is
   * intentionally exposed so this class doesn't need to reach into
   * private internals.
   */
  client: OffscreenClient;
  /** Session id. Caller-provided so panels can stamp meaningful values. */
  sid: TerminalSessionId;
  /**
   * Optional event handler — called for every terminal-* event
   * tagged with this session's `sid`. Useful for the panel terminal
   * view to render output / media previews / status changes.
   */
  onEvent?: (event: TerminalEventMsg) => void;
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class TerminalSessionClient {
  private readonly client: OffscreenClient;
  private readonly sid: TerminalSessionId;
  private readonly onEvent: ((event: TerminalEventMsg) => void) | null;
  private nextExecId = 1;
  private pending = new Map<string, (result: TerminalExecResult) => void>();
  /** Output accumulators per in-flight execId. */
  private buffers = new Map<string, { stdout: string; stderr: string }>();
  /** Tracks whether we've sent terminal-open. */
  private opened = false;
  private openWaiters: Array<(err?: Error) => void> = [];
  private unsubscribe: (() => void) | null = null;
  /** Active retry interval for the in-flight `open()` call (cleared on reply / timeout / close / dispose). */
  private openRetryTimer: ReturnType<typeof setInterval> | null = null;
  /** Active timeout for the in-flight `open()` call. */
  private openTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TerminalSessionClientOptions) {
    this.client = options.client;
    this.sid = options.sid;
    this.onEvent = options.onEvent ?? null;
    // Subscribe eagerly so events for this `sid` always land — even
    // for `exec`s that come before `open()` (e.g. the "unknown
    // session" path, which is still expected to receive a synthetic
    // exit from the host). `dispose()` tears the subscription down.
    this.unsubscribe = this.subscribeToEvents();
  }

  /**
   * Open the session in the worker. Resolves on
   * `terminal-status: opened`, rejects on `error` or on timeout.
   *
   * Defense-in-depth retry: the worker's `TerminalSessionHost`
   * subscribes on boot, but mounts that race the host-install lose
   * the initial `terminal-open` (the message bus drops messages with
   * no listener). Mirroring `OffscreenClient.requestState`, we
   * resend `terminal-open` every `retryMs` until a `terminal-status`
   * arrives or `timeoutMs` elapses. Page-side `mountTerminal` also
   * gates the call on kernel-ready so this retry should almost never
   * fire in production — but a genuine failure now rejects (visible
   * error in the view) instead of hanging silently.
   */
  open(
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      /** Resend interval for the open envelope. Default 500ms. */
      retryMs?: number;
      /** Hard ceiling; reject after this many ms with no status. Default 10000ms. */
      timeoutMs?: number;
    } = {}
  ): Promise<void> {
    if (this.opened) return Promise.resolve();
    const retryMs = opts.retryMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const envelope = {
      type: 'terminal-open' as const,
      sid: this.sid,
      cwd: opts.cwd,
      env: opts.env,
    };
    return new Promise((resolve, reject) => {
      this.openWaiters.push((err) => {
        this.clearOpenTimers();
        if (err) reject(err);
        else resolve();
      });
      this.send(envelope);
      // Resend until status arrives.
      this.openRetryTimer = setInterval(() => {
        if (this.opened || this.openWaiters.length === 0) {
          this.clearOpenTimers();
          return;
        }
        this.send(envelope);
      }, retryMs);
      // Hard ceiling.
      this.openTimeoutTimer = setTimeout(() => {
        if (this.opened || this.openWaiters.length === 0) return;
        const err = new Error(`terminal-open timed out after ${timeoutMs}ms`);
        const waiters = this.openWaiters;
        this.openWaiters = [];
        this.clearOpenTimers();
        for (const waiter of waiters) waiter(err);
      }, timeoutMs);
    });
  }

  private clearOpenTimers(): void {
    if (this.openRetryTimer) {
      clearInterval(this.openRetryTimer);
      this.openRetryTimer = null;
    }
    if (this.openTimeoutTimer) {
      clearTimeout(this.openTimeoutTimer);
      this.openTimeoutTimer = null;
    }
  }

  /**
   * Run a single command. Resolves with the captured output and
   * exit code. Tracks per-call `execId` so multiple `exec`s on the
   * same session don't cross streams (the protocol allows only one
   * concurrent exec per session, but the client still tracks ids
   * for future streaming-pty support).
   */
  exec(command: string): Promise<TerminalExecResult> {
    const execId = `e${this.nextExecId++}`;
    return new Promise((resolve) => {
      this.pending.set(execId, resolve);
      this.buffers.set(execId, { stdout: '', stderr: '' });
      this.send({ type: 'terminal-exec', sid: this.sid, execId, command });
    });
  }

  /**
   * Send a signal to the in-flight exec. Today the worker honors
   * SIGINT/SIGTERM/SIGKILL by aborting the active just-bash
   * command; SIGSTOP/SIGCONT are reserved.
   */
  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL'): void {
    this.send({ type: 'terminal-signal', sid: this.sid, signal: sig });
  }

  /** Send a resize hint. Reserved on the wire today. */
  resize(cols: number, rows: number): void {
    this.send({ type: 'terminal-resize', sid: this.sid, cols, rows });
  }

  /**
   * Close the session in the worker. Subscription stays alive so
   * the resulting `terminal-status: closed` event reaches `onEvent`.
   * Call `dispose()` to fully tear down the page-side subscription
   * (typically on tab teardown / page unload).
   */
  close(): void {
    // Cancel any in-flight open retry/timeout first so a `close()` mid-handshake
    // doesn't leak timers even if `opened` is still false.
    const hadPendingOpen = this.openWaiters.length > 0;
    if (!this.opened && !hadPendingOpen) {
      // Idempotent — also a no-op if open() was never called.
      this.clearOpenTimers();
      return;
    }
    if (this.opened) this.send({ type: 'terminal-close', sid: this.sid });
    this.opened = false;
    // Reject pending opens (none in steady state) and resolve
    // pending execs with a synthetic exit so callers don't hang.
    const waiters = this.openWaiters;
    this.openWaiters = [];
    this.clearOpenTimers();
    for (const waiter of waiters) waiter(new Error('terminal session closed'));
    for (const [execId, resolve] of this.pending) {
      const buf = this.buffers.get(execId) ?? { stdout: '', stderr: '' };
      resolve({ stdout: buf.stdout, stderr: buf.stderr, exitCode: 130 });
    }
    this.pending.clear();
    this.buffers.clear();
  }

  /**
   * Tear down the page-side subscription. Call after `close()`
   * (or skip `close()` and call this directly to abort).
   */
  dispose(): void {
    this.clearOpenTimers();
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const waiter of waiters) waiter(new Error('terminal session disposed'));
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private send(msg: TerminalControlMsg): void {
    this.client.sendRaw(msg);
  }

  private subscribeToEvents(): () => void {
    // OffscreenClient doesn't expose a generic onMessage hook today,
    // so we tap into its terminal-event route via `onTerminalEvent`
    // in `offscreen-client.ts`.
    const handler = (event: TerminalEventMsg): void => {
      if (event.sid !== this.sid) return;
      this.handleEvent(event);
    };
    return this.client.onTerminalEvent(handler);
  }

  private handleEvent(event: TerminalEventMsg): void {
    this.onEvent?.(event);
    switch (event.type) {
      case 'terminal-status': {
        const status = event as TerminalStatusMsg;
        if (status.state === 'opened') {
          this.opened = true;
          const waiters = this.openWaiters;
          this.openWaiters = [];
          this.clearOpenTimers();
          for (const waiter of waiters) waiter();
        } else if (status.state === 'error') {
          this.opened = false;
          const err = new Error(status.error ?? 'terminal session error');
          const waiters = this.openWaiters;
          this.openWaiters = [];
          this.clearOpenTimers();
          for (const waiter of waiters) waiter(err);
        }
        return;
      }
      case 'terminal-output': {
        const out = event as TerminalOutputMsg;
        // The current host always tags output with the originating
        // `execId`. Route the chunk to the matching buffer; if the
        // exec already completed (terminal-exit landed first), the
        // chunk is dropped instead of bleeding into a sibling exec
        // that happens to also be in-flight.
        //
        // Legacy hosts that don't set `execId` fall back to broadcast
        // behavior (accumulate against every in-flight buffer). The
        // protocol allows only one exec at a time per session, so the
        // broadcast is unambiguous on older hosts.
        if (out.execId !== undefined) {
          const buf = this.buffers.get(out.execId);
          if (!buf) return;
          if (out.stream === 'stdout') buf.stdout += out.data;
          else buf.stderr += out.data;
        } else {
          for (const buf of this.buffers.values()) {
            if (out.stream === 'stdout') buf.stdout += out.data;
            else buf.stderr += out.data;
          }
        }
        return;
      }
      case 'terminal-exit': {
        const exit = event as TerminalExitMsg;
        const resolve = this.pending.get(exit.execId);
        const buf = this.buffers.get(exit.execId);
        this.pending.delete(exit.execId);
        this.buffers.delete(exit.execId);
        if (resolve) {
          resolve({
            stdout: buf?.stdout ?? '',
            stderr: buf?.stderr ?? '',
            exitCode: exit.exitCode,
          });
        }
        return;
      }
      case 'terminal-cleared':
      case 'terminal-media-preview':
        // Surfaced via onEvent already; no client-side state change.
        return;
    }
    // Exhaustiveness — TypeScript flags if a new event variant
    // is added and we forget to handle it here.
    event satisfies never;
  }
}

// Re-export envelopes for ergonomic imports at call sites.
export type {
  TerminalClearedMsg,
  TerminalControlMsg,
  TerminalEventMsg,
  TerminalExitMsg,
  TerminalMediaPreviewMsg,
  TerminalOutputMsg,
  TerminalSessionId,
  TerminalStatusMsg,
};
