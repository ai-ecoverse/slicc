/**
 * `terminal-protocol.ts` — wire envelopes for a panel-side terminal
 * driving a worker-resident `HeadlessShellLike`.
 *
 * Phase 2b step 2. The full implementation (`terminal-view.ts`
 * page-side + a session bridge worker-side) lands in step 3+; this
 * module declares the contract the two sides agree on so the
 * envelopes are stable when the wire-up arrives.
 *
 * Direction:
 *
 *   panel  →  worker   `TerminalControlMsg`     (stdin / signal / resize / exec / open / close)
 *   worker →  panel    `TerminalEventMsg`       (output / media-preview / exit / cleared / status)
 *
 * Each pair carries a `sid` (terminal session id) so a single kernel
 * transport can multiplex multiple terminals (e.g. a future
 * "open new tab" feature). For Phase 2b the panel only opens one
 * session at a time.
 *
 * Why a custom protocol instead of just streaming raw stdout?
 * Because the existing terminal renders things xterm doesn't speak
 * natively — the `imgcat` command shows inline images and PDFs via
 * a separate "preview host" `<div>` that lives next to the xterm
 * instance. The current `wasm-shell.ts` calls into a
 * `previewHost.appendChild(...)` from within the same class as the
 * Bash exec — the worker can't do that. So `imgcat` (and any
 * future media-emitting command) must produce a `media-preview`
 * envelope that the panel-side terminal-view materializes into DOM.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/**
 * Terminal session id. Allocated by the panel when it opens a
 * session (`TerminalOpenMsg`). The worker echoes it back on every
 * event for routing.
 */
export type TerminalSessionId = string;

// ---------------------------------------------------------------------------
// Panel → worker: control messages
// ---------------------------------------------------------------------------

/**
 * Open a new terminal session in the worker. Reply: a
 * `TerminalStatusMsg` with `state: 'opened'`.
 */
export interface TerminalOpenMsg {
  type: 'terminal-open';
  sid: TerminalSessionId;
  /** Optional initial cwd. Default `/`. */
  cwd?: string;
  /** Optional initial env vars. Merged on top of the shell's defaults. */
  env?: Record<string, string>;
  /** Optional initial cols/rows for size-aware programs. Default 80×24. */
  cols?: number;
  rows?: number;
}

/** Close a session. Worker tears down its `HeadlessShell` instance. */
export interface TerminalCloseMsg {
  type: 'terminal-close';
  sid: TerminalSessionId;
}

/**
 * Send raw input from xterm to the worker. The panel-side line
 * editor handles arrow keys / history / tab completion locally and
 * only forwards committed lines (with a trailing `\n`) here. This
 * keeps editor latency at sub-ms even when the worker is busy.
 */
export interface TerminalStdinMsg {
  type: 'terminal-stdin';
  sid: TerminalSessionId;
  /** UTF-8 text. Includes the trailing `\n` for committed lines. */
  data: string;
}

/**
 * Execute a single command. Same shape as
 * `HeadlessShellLike.executeCommand` but delivered async over the
 * wire. The worker returns a sequence of `output` events, then an
 * `exit` event with the exit code.
 */
export interface TerminalExecMsg {
  type: 'terminal-exec';
  sid: TerminalSessionId;
  /** Unique id for the exec — echoed in the resulting `exit` event. */
  execId: string;
  command: string;
}

/**
 * Send a signal to the foreground process of the session. Phase 3
 * (process model) will widen the signal set; today only `SIGINT`
 * (Ctrl+C) is honored.
 */
export interface TerminalSignalMsg {
  type: 'terminal-signal';
  sid: TerminalSessionId;
  signal: 'SIGINT' | 'SIGTERM' | 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';
}

/** Notify the worker about a terminal size change. */
export interface TerminalResizeMsg {
  type: 'terminal-resize';
  sid: TerminalSessionId;
  cols: number;
  rows: number;
}

export type TerminalControlMsg =
  | TerminalOpenMsg
  | TerminalCloseMsg
  | TerminalStdinMsg
  | TerminalExecMsg
  | TerminalSignalMsg
  | TerminalResizeMsg;

// ---------------------------------------------------------------------------
// Worker → panel: events
// ---------------------------------------------------------------------------

/**
 * stdout / stderr chunk. The panel-side `terminal-view` writes
 * directly to xterm; ANSI escapes pass through unchanged.
 */
export interface TerminalOutputMsg {
  type: 'terminal-output';
  sid: TerminalSessionId;
  /** Discriminator so the panel can color stderr differently if it wants. */
  stream: 'stdout' | 'stderr';
  /** UTF-8 text — possibly partial (no \n required). */
  data: string;
}

/**
 * Worker-side commands that produce inline media (today: `imgcat`,
 * tomorrow potentially `chartjs`, `mermaid-cli`, …) emit this. The
 * panel-side terminal-view materializes the bytes into a DOM
 * preview element next to xterm.
 *
 * `mediaType` mirrors a MIME type. `data` is base64-encoded so the
 * envelope survives `structuredClone` and JSON serialization (which
 * the kernel transport does today). A future binary-port mode could
 * stream `Uint8Array` directly.
 */
export interface TerminalMediaPreviewMsg {
  type: 'terminal-media-preview';
  sid: TerminalSessionId;
  /** Original VFS path of the previewed file, for the panel's caption. */
  path: string;
  mediaType: string;
  /** Base64-encoded content. */
  data: string;
}

/**
 * Emitted after each `terminal-exec` completes. Carries the
 * `execId` from the request so the panel can match.
 */
export interface TerminalExitMsg {
  type: 'terminal-exit';
  sid: TerminalSessionId;
  execId: string;
  exitCode: number;
}

/** Worker telling the panel to wipe scrollback (e.g. on `clear`). */
export interface TerminalClearedMsg {
  type: 'terminal-cleared';
  sid: TerminalSessionId;
}

/**
 * Lifecycle status change. `opened` after `terminal-open` resolves;
 * `closed` after `terminal-close` finishes; `error` for unexpected
 * worker-side failures.
 */
export interface TerminalStatusMsg {
  type: 'terminal-status';
  sid: TerminalSessionId;
  state: 'opened' | 'closed' | 'error';
  error?: string;
}

export type TerminalEventMsg =
  | TerminalOutputMsg
  | TerminalMediaPreviewMsg
  | TerminalExitMsg
  | TerminalClearedMsg
  | TerminalStatusMsg;

// ---------------------------------------------------------------------------
// Convenience type guards
// ---------------------------------------------------------------------------

export function isTerminalControlMsg(msg: unknown): msg is TerminalControlMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === 'terminal-open' ||
    t === 'terminal-close' ||
    t === 'terminal-stdin' ||
    t === 'terminal-exec' ||
    t === 'terminal-signal' ||
    t === 'terminal-resize'
  );
}

export function isTerminalEventMsg(msg: unknown): msg is TerminalEventMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === 'terminal-output' ||
    t === 'terminal-media-preview' ||
    t === 'terminal-exit' ||
    t === 'terminal-cleared' ||
    t === 'terminal-status'
  );
}
