/**
 * `RemoteTerminalView` — page-side terminal view that drives a
 * worker-resident shell through a `TerminalSessionClient`.
 *
 * Phase 2b step 5b. The standalone-worker path
 * (`?kernel-worker=1`) runs the agent's `WasmShell` inside a
 * DedicatedWorker. The panel terminal can't keep using the inline
 * `WasmShell` view-class — that ships a local `Bash` instance the
 * worker never sees. This view is the panel-side counterpart to
 * the worker-side `TerminalSessionHost`: xterm renders here,
 * keystrokes assemble into committed lines locally, and Enter
 * dispatches each line via `terminal-exec` to the worker.
 *
 * What it does today:
 *   - Mount xterm.js + theme sync + refit.
 *   - Minimal line editor: typing, Backspace, Enter, ←/→ arrows,
 *     ↑/↓ history, Home/End, Ctrl+C → SIGINT.
 *   - Streaming output: `terminal-output` events render as they
 *     arrive; `terminal-exit` closes the prompt cycle.
 *   - `executeCommandInTerminal(cmd)` for programmatic dispatch
 *     (chat panel "run in terminal" affordance).
 *
 * Deliberate non-features (deferred, none blocking the standalone
 * smoke test):
 *   - Multi-line continuation (PS2 / heredoc).
 *   - Tab completion (would need a worker-side `which` / jsh
 *     enumeration round-trip).
 *   - Inline media-preview (`imgcat`). Phase 2b.6 lands the panel
 *     UI capability for this — for now `imgcat` writes its base64
 *     escape into the terminal stream like any other command and
 *     the user-visible result is "the bytes printed inline."
 *   - Cwd-aware prompt. The worker shell tracks `cd`; the panel
 *     just renders a static `$ ` prompt. A future event can carry
 *     `cwd` updates from the host.
 *
 * Worker safety: this file imports from `../ui/...` (xterm,
 * `OffscreenClient`) and only loads on the page side — never in
 * the worker bundle.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { OffscreenClient } from '../ui/offscreen-client.js';
import type { TerminalEventMsg, TerminalSessionId } from '../shell/terminal-protocol.js';
import { TerminalSessionClient, type TerminalExecResult } from './terminal-session-client.js';

export interface RemoteTerminalViewOptions {
  client: OffscreenClient;
  /** Session id; defaults to `panel-terminal-${Date.now()}`. */
  sid?: TerminalSessionId;
  cwd?: string;
  env?: Record<string, string>;
}

const DARK_THEME = {
  background: '#141414',
  foreground: '#cfcfcf',
  cursor: '#3562ff',
  cursorAccent: '#141414',
  selectionBackground: '#3562ff40',
  selectionForeground: '#ffffff',
  black: '#1a1a1a',
  red: '#e34850',
  green: '#2d9d78',
  yellow: '#e68619',
  blue: '#3562ff',
  magenta: '#a962e8',
  cyan: '#2db9be',
  white: '#cfcfcf',
  brightBlack: '#5a5a5a',
  brightRed: '#e34850',
  brightGreen: '#2d9d78',
  brightYellow: '#e68619',
  brightBlue: '#4a75ff',
  brightMagenta: '#a962e8',
  brightCyan: '#2db9be',
  brightWhite: '#ffffff',
};
const LIGHT_THEME = {
  background: '#f0f0f0',
  foreground: '#1a1a1a',
  cursor: '#2b54db',
  cursorAccent: '#f0f0f0',
  selectionBackground: '#2b54db30',
  selectionForeground: '#000000',
  black: '#1a1a1a',
  red: '#d73220',
  green: '#268e6c',
  yellow: '#d17a00',
  blue: '#2b54db',
  magenta: '#8839ef',
  cyan: '#1a9088',
  white: '#e8e8e8',
  brightBlack: '#6e6e6e',
  brightRed: '#d73220',
  brightGreen: '#268e6c',
  brightYellow: '#d17a00',
  brightBlue: '#1e44c4',
  brightMagenta: '#8839ef',
  brightCyan: '#1a9088',
  brightWhite: '#ffffff',
};

const PROMPT = '\x1b[34m/\x1b[0m \x1b[90m$\x1b[0m ';
const PROMPT_VISUAL_LEN = 4; // "/ $ " — 4 visible chars

export class RemoteTerminalView {
  private readonly client: TerminalSessionClient;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private terminalHost: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;

  // Line editor
  private currentLine = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private isExecuting = false;
  /** Tail of the most recent exec while it's running. */
  private execInFlight: Promise<TerminalExecResult> | null = null;

  constructor(private readonly options: RemoteTerminalViewOptions) {
    const sid = options.sid ?? `panel-terminal-${Date.now()}`;
    this.client = new TerminalSessionClient({
      client: options.client,
      sid,
      onEvent: (event) => this.handleEvent(event),
    });
  }

  /**
   * Mount the xterm view in `container` and open a worker-side
   * shell session. Resolves when the session is opened (or rejects
   * with the `error` text from a `terminal-status: error` event).
   */
  async mount(container: HTMLElement): Promise<void> {
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    await import('@xterm/xterm/css/xterm.css');

    const isDark = !document.documentElement.classList.contains('theme-light');

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 11,
      fontFamily: "'Source Code Pro', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: isDark ? DARK_THEME : LIGHT_THEME,
      convertEol: true,
    });

    this.themeObserver = new MutationObserver(() => {
      if (!this.terminal) return;
      const isLight = document.documentElement.classList.contains('theme-light');
      this.terminal.options.theme = isLight ? LIGHT_THEME : DARK_THEME;
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    container.replaceChildren();
    this.terminalHost = document.createElement('div');
    this.terminalHost.className = 'terminal-panel__terminal-host';
    container.appendChild(this.terminalHost);

    this.terminal.open(this.terminalHost);
    this.fitAddon.fit();

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.terminalHost);

    this.terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (kernel-worker)\x1b[0m');
    this.terminal.writeln('\x1b[90mType "help" for available commands.\x1b[0m\n');

    await this.client.open({ cwd: this.options.cwd, env: this.options.env });
    this.showPrompt();
    this.setupInputHandler();
  }

  /** Re-fit the terminal to its container. */
  refit(): void {
    this.fitAddon?.fit();
  }

  /** Clear the terminal screen. */
  clearTerminal(): void {
    this.terminal?.clear();
  }

  /**
   * Programmatically dispatch a command (used by chat panel "run in
   * terminal"). Echoes the command to the terminal and resolves
   * with the captured result.
   */
  async executeCommandInTerminal(command: string): Promise<TerminalExecResult> {
    const trimmed = command.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };
    if (!this.terminal) return this.client.exec(trimmed);
    if (this.isExecuting || this.currentLine.length > 0) {
      return { stdout: '', stderr: 'terminal is busy; finish current input first\n', exitCode: 1 };
    }
    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }
    this.historyIndex = -1;
    this.terminal.write(trimmed);
    this.terminal.writeln('');
    return this.runRemote(trimmed);
  }

  /** Tear down the view + close the worker session. */
  dispose(): void {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.terminalHost = null;
    this.client.close();
    this.client.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal — line editor
  // ---------------------------------------------------------------------------

  private showPrompt(): void {
    this.terminal?.write(PROMPT);
  }

  private setupInputHandler(): void {
    if (!this.terminal) return;
    this.terminal.onData((data) => {
      if (this.isExecuting) {
        // Allow Ctrl+C to interrupt the running exec.
        if (data === '\x03' || (data.length === 1 && data.charCodeAt(0) === 3)) {
          this.client.signal('SIGINT');
          this.terminal?.writeln('^C');
        }
        return;
      }

      // Escape sequences first (arrows, Home, End, Delete).
      if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) {
        switch (data) {
          case '\x1b[A':
            this.handleHistoryUp();
            return;
          case '\x1b[B':
            this.handleHistoryDown();
            return;
          case '\x1b[C':
            this.handleArrowRight();
            return;
          case '\x1b[D':
            this.handleArrowLeft();
            return;
          case '\x1b[H':
          case '\x1bOH':
          case '\x1b[1~':
            this.handleHome();
            return;
          case '\x1b[F':
          case '\x1bOF':
          case '\x1b[4~':
            this.handleEnd();
            return;
          case '\x1b[3~':
            this.handleDelete();
            return;
        }
        return;
      }

      for (const ch of data) {
        switch (ch) {
          case '\r':
            this.handleEnter();
            break;
          case '\x7f':
            this.handleBackspace();
            break;
          case '\x03':
            // No running command (handled above) — clear current line.
            this.terminal?.writeln('^C');
            this.currentLine = '';
            this.cursorPos = 0;
            this.showPrompt();
            break;
          default:
            if (ch >= ' ') this.insertChar(ch);
        }
      }
    });
  }

  private insertChar(ch: string): void {
    if (!this.terminal) return;
    const tail = this.currentLine.slice(this.cursorPos);
    this.currentLine = this.currentLine.slice(0, this.cursorPos) + ch + tail;
    this.cursorPos++;
    this.terminal.write(ch);
    if (tail.length > 0) {
      this.terminal.write(tail);
      this.terminal.write(`\x1b[${tail.length}D`);
    }
  }

  private handleBackspace(): void {
    if (!this.terminal || this.cursorPos <= 0) return;
    const tail = this.currentLine.slice(this.cursorPos);
    this.currentLine = this.currentLine.slice(0, this.cursorPos - 1) + tail;
    this.cursorPos--;
    this.terminal.write('\b\x1b[K');
    if (tail.length > 0) {
      this.terminal.write(tail);
      this.terminal.write(`\x1b[${tail.length}D`);
    }
  }

  private handleDelete(): void {
    if (!this.terminal || this.cursorPos >= this.currentLine.length) return;
    const tail = this.currentLine.slice(this.cursorPos + 1);
    this.currentLine = this.currentLine.slice(0, this.cursorPos) + tail;
    this.terminal.write('\x1b[K');
    if (tail.length > 0) {
      this.terminal.write(tail);
      this.terminal.write(`\x1b[${tail.length}D`);
    }
  }

  private handleArrowLeft(): void {
    if (this.cursorPos <= 0) return;
    this.cursorPos--;
    this.terminal?.write('\x1b[D');
  }

  private handleArrowRight(): void {
    if (this.cursorPos >= this.currentLine.length) return;
    this.cursorPos++;
    this.terminal?.write('\x1b[C');
  }

  private handleHome(): void {
    if (this.cursorPos === 0) return;
    this.terminal?.write(`\x1b[${this.cursorPos}D`);
    this.cursorPos = 0;
  }

  private handleEnd(): void {
    const delta = this.currentLine.length - this.cursorPos;
    if (delta <= 0) return;
    this.terminal?.write(`\x1b[${delta}C`);
    this.cursorPos = this.currentLine.length;
  }

  private handleHistoryUp(): void {
    if (this.history.length === 0) return;
    const next =
      this.historyIndex === -1 ? this.history.length - 1 : Math.max(0, this.historyIndex - 1);
    this.historyIndex = next;
    this.replaceLine(this.history[next]);
  }

  private handleHistoryDown(): void {
    if (this.historyIndex === -1) return;
    const next = this.historyIndex + 1;
    if (next >= this.history.length) {
      this.historyIndex = -1;
      this.replaceLine('');
    } else {
      this.historyIndex = next;
      this.replaceLine(this.history[next]);
    }
  }

  private replaceLine(text: string): void {
    if (!this.terminal) return;
    // Move cursor to end, erase backwards to prompt, redraw.
    const tail = this.currentLine.length - this.cursorPos;
    if (tail > 0) this.terminal.write(`\x1b[${tail}C`);
    this.terminal.write('\r');
    this.terminal.write(`\x1b[${PROMPT_VISUAL_LEN + this.currentLine.length}D`);
    this.terminal.write('\x1b[K');
    this.showPrompt();
    this.terminal.write(text);
    this.currentLine = text;
    this.cursorPos = text.length;
  }

  private handleEnter(): void {
    if (!this.terminal) return;
    const command = this.currentLine.trim();
    this.terminal.writeln('');
    this.currentLine = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    if (!command) {
      this.showPrompt();
      return;
    }
    if (this.history[this.history.length - 1] !== command) {
      this.history.push(command);
    }
    // Pre-intercept local mount commands. The worker has no
    // `window.showDirectoryPicker`; without this hook a user-typed
    // `mount /mnt/foo` in the panel terminal would error with
    // "ask the agent to mount it". The Enter keystroke IS a user
    // activation gesture; we run the picker on the page side
    // synchronously, stash the granted handle in IDB keyed by
    // target path, then forward the original command. The
    // worker's `mountLocal` checks IDB for a handle keyed by the
    // typed target and uses it directly when present.
    const mountTarget = parseLocalMountTarget(command);
    if (mountTarget) {
      void this.runRemoteWithLocalPicker(command, mountTarget);
      return;
    }
    void this.runRemote(command);
  }

  /**
   * Pre-pick a local directory before forwarding the `mount` command
   * to the worker. Runs `showDirectoryPicker` on the keystroke
   * activation chain. Cancellation surfaces as a brief terminal
   * line and skips the exec entirely (so the worker doesn't
   * receive a no-op `mount` call).
   */
  private async runRemoteWithLocalPicker(command: string, target: string): Promise<void> {
    this.isExecuting = true;
    try {
      const win = window as Window & {
        showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
      };
      if (typeof win.showDirectoryPicker !== 'function') {
        this.terminal?.writeln(`mount: File System Access API not available\n`);
        return;
      }
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await win.showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          this.terminal?.writeln(`mount: cancelled`);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.terminal?.writeln(`mount: ${msg}`);
        return;
      }
      try {
        const { storePendingHandle } = await import('../fs/mount-picker-popup.js');
        await storePendingHandle(localMountIdbKey(target), handle);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.terminal?.writeln(`mount: failed to stash handle: ${msg}`);
        return;
      }
      // Forward the command to the worker. `mountLocal` will pick
      // up the stashed handle keyed by the typed target.
      await this.runRemoteImpl(command);
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /**
   * Dispatch `command` to the worker session and stream the result
   * back into the terminal. Output is rendered synchronously by the
   * `handleEvent` route; this helper only manages the
   * isExecuting/prompt cycle.
   */
  private async runRemote(command: string): Promise<TerminalExecResult> {
    this.isExecuting = true;
    try {
      return await this.runRemoteImpl(command);
    } finally {
      this.isExecuting = false;
      this.execInFlight = null;
      this.showPrompt();
    }
  }

  /**
   * Bare exec — no isExecuting / showPrompt bookkeeping. Callers
   * (`runRemote`, `runRemoteWithLocalPicker`) wrap this with their
   * own lifecycle.
   */
  private async runRemoteImpl(command: string): Promise<TerminalExecResult> {
    const promise = this.client.exec(command);
    this.execInFlight = promise;
    try {
      return await promise;
    } finally {
      this.execInFlight = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — event routing
  // ---------------------------------------------------------------------------

  private handleEvent(event: TerminalEventMsg): void {
    if (!this.terminal) return;
    switch (event.type) {
      case 'terminal-output':
        // Stderr renders red; stdout in default. Terminals usually
        // don't distinguish, but tinting stderr makes errors obvious
        // in the panel.
        if (event.stream === 'stderr') {
          this.terminal.write(`\x1b[31m${event.data}\x1b[0m`);
        } else {
          this.terminal.write(event.data);
        }
        return;
      case 'terminal-exit':
        // The exit code is also threaded back through the
        // `client.exec` promise; nothing to render here today.
        return;
      case 'terminal-cleared':
        this.terminal.clear();
        return;
      case 'terminal-status':
        if (event.state === 'error') {
          this.terminal.writeln(
            `\x1b[31mterminal session error: ${event.error ?? 'unknown'}\x1b[0m`
          );
        }
        return;
      case 'terminal-media-preview':
        // Phase 2b.6 will surface this through a panel UI capability
        // (image/video preview pane). For now ignore — the underlying
        // command (`imgcat`) writes its escape into stdout in the
        // CLI shell, which we render above.
        return;
    }
    event satisfies never;
  }
}

// ---------------------------------------------------------------------------
// Mount pre-intercept helpers
// ---------------------------------------------------------------------------

/**
 * Parse a typed command line and return the local-mount target
 * path if it looks like `mount /some/path` with no `--source` flag
 * and no recognized subcommand. Returns `null` for anything else
 * (`mount list`, `mount unmount`, `mount /x --source s3://…`,
 * `mount` alone, …).
 *
 * The match is intentionally narrow — false positives would fire
 * a directory picker for commands the user didn't intend, which is
 * jarring. The user's `mount /mnt/foo` (the canonical local mount
 * invocation) reliably matches; everything else falls through to
 * the worker, which produces the right error message itself.
 */
function parseLocalMountTarget(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('mount')) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'mount') return null;
  if (tokens.includes('--source') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  // First non-flag arg.
  const target = tokens.slice(1).find((t) => !t.startsWith('-'));
  if (!target) return null;
  // Skip subcommand-like tokens that don't take a directory picker.
  if (['list', 'unmount', 'refresh', 'recover'].includes(target)) return null;
  // Heuristic: only intercept absolute paths (typical mount targets).
  if (!target.startsWith('/')) return null;
  return target;
}

/**
 * Build the IDB key under which the panel stashes a pre-picked
 * directory handle for a typed `mount <target>` command. The
 * worker's `mountLocal` looks up the same key and uses the handle
 * if present. Different paths get different keys, so multiple
 * pending mounts don't collide.
 *
 * Exported so `fs/mount-commands.ts` (worker side) can use the
 * exact same key format. The leading `pendingMount:term:` prefix
 * keeps it disjoint from the cone path's `pendingMount:dip-…`
 * keys.
 */
export function localMountIdbKey(target: string): string {
  return `pendingMount:term:${target}`;
}
