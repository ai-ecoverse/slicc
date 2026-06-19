/**
 * `RemoteTerminalView` — page-side terminal view that drives a
 * worker-resident shell through a `TerminalSessionClient`.
 *
 * The standalone-worker path
 * (`?kernel-worker=1`) runs the agent's `AlmostBashShell` inside a
 * DedicatedWorker. The panel terminal can't keep using the inline
 * `AlmostBashShell` view-class — that ships a local `Bash` instance the
 * worker never sees. This view is the panel-side counterpart to
 * the worker-side `TerminalSessionHost`: xterm renders here,
 * keystrokes assemble into committed lines locally, and Enter
 * dispatches each line via `terminal-exec` to the worker.
 *
 * What it does today:
 *   - Mount xterm.js + theme sync + refit.
 *   - Minimal line editor: typing, Backspace, Enter, ←/→ arrows,
 *     ↑/↓ history, Home/End, Ctrl+C → SIGINT.
 *   - Tab completion via a silent `compgen` round-trip to the
 *     worker shell (commands at line start, files otherwise).
 *   - Streaming output: `terminal-output` events render as they
 *     arrive; `terminal-exit` closes the prompt cycle.
 *   - `executeCommandInTerminal(cmd)` for programmatic dispatch
 *     (chat panel "run in terminal" affordance).
 *
 * Deliberate non-features (deferred, none blocking the standalone
 * smoke test):
 *   - Multi-line continuation (PS2 / heredoc).
 *   - Cwd-aware prompt. The worker shell tracks `cd`; the panel
 *     just renders a static `$ ` prompt. A future event can carry
 *     `cwd` updates from the host.
 *
 * Worker safety: this file imports from `../ui/...` (xterm,
 * `OffscreenClient`) and only loads on the page side — never in
 * the worker bundle.
 */

import type {
  PermissionDenyDetail,
  PermissionGrant,
  PermissionKind,
  PermissionRequestOptions,
} from '@slicc/webcomponents';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { storePendingHandle } from '../fs/mount-picker-popup.js';
import { parseEsptoolArgs } from '../shell/supplemental-commands/esptool-command.js';
import { parseHidArgs, parseHidFilters } from '../shell/supplemental-commands/hid-command.js';
import {
  parseSerialArgs,
  parseSerialFilters,
} from '../shell/supplemental-commands/serial-command.js';
import { parseUsbArgs, parseUsbFilters } from '../shell/supplemental-commands/usb-command.js';
import type { TerminalEventMsg, TerminalSessionId } from '../shell/terminal-protocol.js';
import type { OffscreenClient } from '../ui/offscreen-client.js';
import { getLeaderPermissionsSurface } from '../ui/wc/wc-permissions-registry.js';
import {
  getSharedHidRegistry,
  type HidDevice,
  type HidDeviceFilter,
} from './hid-device-registry.js';
import {
  getSharedSerialRegistry,
  type SerialFilter,
  type SerialPort,
} from './serial-port-registry.js';
import { type TerminalExecResult, TerminalSessionClient } from './terminal-session-client.js';
import {
  getSharedUsbRegistry,
  type UsbDevice,
  type UsbDeviceFilter,
} from './usb-device-registry.js';

export interface RemoteTerminalViewOptions {
  client: OffscreenClient;
  /** Session id; defaults to `panel-terminal-${Date.now()}`. */
  sid?: TerminalSessionId;
  cwd?: string;
  env?: Record<string, string>;
}

const DARK_THEME = {
  background: '#141414',
  // Near-white body text — #cfcfcf read muddy on the black pane.
  foreground: '#f2f2f2',
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
  white: '#f2f2f2',
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
  private previewHost: HTMLElement | null = null;
  private previewUrls: string[] = [];
  private hasPreview = false;
  private previewStateListener: ((hasPreview: boolean) => void) | null = null;
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
  /**
   * When true, the `handleEvent` route swallows `terminal-output`
   * events so they don't render in the visible buffer. Used by
   * `handleTab()` to run `compgen` silently — the `client.exec`
   * promise still resolves with the captured stdout.
   */
  private suppressOutput = false;
  /**
   * Prevents re-entrant `handleTab` while a compgen round-trip is in
   * flight. Multiple Tab presses just no-op until the active one
   * resolves; without this, holding Tab would queue redundant execs.
   */
  private tabBusy = false;

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

    this.previewHost = document.createElement('div');
    this.previewHost.className = 'terminal-panel__preview';
    container.appendChild(this.previewHost);

    this.terminal.open(this.terminalHost);
    this.fitAddon.fit();

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.terminalHost);

    this.terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (kernel)\x1b[0m');
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

  setPreviewStateListener(listener: ((hasPreview: boolean) => void) | null): void {
    this.previewStateListener = listener;
    listener?.(this.hasPreview);
  }

  /** Tear down the view + close the worker session. */
  dispose(): void {
    this.clearMediaPreview();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.terminalHost = null;
    this.previewHost = null;
    this.client.close();
    this.client.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal — media preview
  // ---------------------------------------------------------------------------

  private renderMediaPreview(event: TerminalEventMsg & { type: 'terminal-media-preview' }): void {
    if (!this.previewHost) return;

    const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: event.mediaType }));
    this.previewUrls.push(url);

    const previewItem = document.createElement('div');
    previewItem.className = 'terminal-panel__preview-item';

    const label = document.createElement('div');
    label.className = 'terminal-panel__preview-label';
    const name = event.path.split('/').pop() ?? event.path;
    label.textContent = `${name} · ${event.mediaType}`;
    previewItem.appendChild(label);

    if (event.mediaType.startsWith('video/')) {
      const video = document.createElement('video');
      video.className = 'terminal-panel__preview-media';
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.src = url;
      video.addEventListener('loadedmetadata', () => this.refit(), { once: true });
      previewItem.appendChild(video);
    } else {
      const image = document.createElement('img');
      image.className = 'terminal-panel__preview-media';
      image.alt = name;
      image.src = url;
      image.addEventListener('load', () => this.refit(), { once: true });
      previewItem.appendChild(image);
    }

    this.previewHost.appendChild(previewItem);
    this.previewHost.classList.add('terminal-panel__preview--visible');
    this.hasPreview = true;
    this.previewStateListener?.(true);
  }

  private clearMediaPreview(): void {
    for (const url of this.previewUrls) URL.revokeObjectURL(url);
    this.previewUrls = [];
    if (this.previewHost) {
      this.previewHost.replaceChildren();
      this.previewHost.classList.remove('terminal-panel__preview--visible');
    }
    this.hasPreview = false;
    this.previewStateListener?.(false);
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
          case '\t':
            // Tab completion via a silent `compgen` round-trip through
            // the worker shell. Async; ignored while another tab is in
            // flight so holding the key doesn't pile up execs.
            void this.handleTab();
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

  /**
   * Bash-style tab completion via a silent `compgen` round-trip
   * through the worker shell.
   *
   * Mirrors the local `AlmostBashShell.handleTab` shape (commands at the
   * start of a line use `compgen -A command`; subsequent words use
   * file completion) so panel-shell behaviour matches the in-page
   * shell that this view replaced. Output from the compgen exec is
   * swallowed by the `suppressOutput` flag — only the matches are
   * applied to the line buffer (single hit → insert + space, multi
   * hit → insert common prefix, listing fallback if no shared prefix).
   */
  private async handleTab(): Promise<void> {
    if (!this.terminal) return;
    if (this.tabBusy) return;
    this.tabBusy = true;
    // Share the existing `isExecuting` busy gate so the input handler
    // swallows Enter (and other keystrokes except Ctrl+C) while the
    // silent `compgen` round-trip is in flight. Without this, a user
    // who hits Enter immediately after Tab races a second
    // `terminal-exec` against the worker session, which only permits
    // one exec at a time and rejects the second with exit code 130 —
    // their actual command disappears. The compgen round-trip is
    // typically <100ms, so the brief block is imperceptible.
    const previouslyExecuting = this.isExecuting;
    this.isExecuting = true;
    try {
      const beforeCursor = this.currentLine.slice(0, this.cursorPos);
      const { currentWord, isFirstWord, compgenCmd } = buildCompgenPlan(beforeCursor);

      this.suppressOutput = true;
      let stdout = '';
      try {
        const result = await this.client.exec(compgenCmd);
        stdout = result.stdout;
      } finally {
        this.suppressOutput = false;
      }

      const matches = stdout.split('\n').filter(Boolean);
      if (matches.length === 0) return;

      if (matches.length === 1) {
        const completion = matches[0];
        const suffix = completion.slice(currentWord.length);
        if (suffix) {
          this.insertText(suffix);
        }
        // Decide between trailing space (commands / regular files)
        // and trailing slash (directories). Run a second silent
        // compgen to ask if the completed prefix is a directory.
        let trail = ' ';
        if (!isFirstWord) {
          this.suppressOutput = true;
          try {
            const dirCheck = await this.client.exec(buildCompgenDirCheck(completion));
            if (dirCheck.stdout.trim() === completion) trail = '/';
          } finally {
            this.suppressOutput = false;
          }
        }
        this.insertText(trail);
        return;
      }

      // Multi-match: insert the longest common prefix. If there's no
      // shared extension beyond what the user already typed, list the
      // candidates instead and redraw the prompt with the original
      // line so the user can keep typing.
      const prefix = longestCommonPrefix(matches);
      const suffix = prefix.slice(currentWord.length);
      if (suffix) {
        this.insertText(suffix);
        return;
      }
      this.terminal.writeln('');
      this.terminal.writeln(matches.map((m) => m.split('/').pop() ?? m).join('  '));
      this.showPrompt();
      this.terminal.write(this.currentLine);
      const back = this.currentLine.length - this.cursorPos;
      if (back > 0) this.terminal.write(`\x1b[${back}D`);
    } catch (err) {
      console.warn(
        '[RemoteTerminal] Tab completion failed:',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.tabBusy = false;
      // Only release the busy gate if the tab didn't piggyback on an
      // already-executing command (defensive — handleTab is gated on
      // !isExecuting via the input handler, but the explicit save/
      // restore makes the contract obvious for future callers).
      this.isExecuting = previouslyExecuting;
    }
  }

  /**
   * Insert `text` at the current cursor position and redraw the tail
   * if needed. Shared by `handleTab`'s single-match and prefix-extend
   * paths; behaves like a multi-char `insertChar` without going
   * through the per-char loop in `setupInputHandler`.
   */
  private insertText(text: string): void {
    if (!this.terminal || text.length === 0) return;
    const tail = this.currentLine.slice(this.cursorPos);
    this.currentLine =
      this.currentLine.slice(0, this.cursorPos) + text + this.currentLine.slice(this.cursorPos);
    this.cursorPos += text.length;
    this.terminal.write(text);
    if (tail.length > 0) {
      this.terminal.write(tail);
      this.terminal.write(`\x1b[${tail.length}D`);
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
    // Pre-intercept `usb request`. `navigator.usb.requestDevice` needs a
    // user gesture; the worker shell has none. The Enter keystroke IS a
    // gesture, so we run the chooser on the page, stash the granted
    // device in the shared registry, and forward a rewritten command
    // carrying the resolved handle so the worker prints its descriptor.
    const usbFilters = parseUsbRequestCommand(command);
    if (usbFilters) {
      void this.runRemoteWithUsbPicker(usbFilters);
      return;
    }
    // Pre-intercept `hid request` for the same gesture reason as
    // `usb request`: `navigator.hid.requestDevice` needs a user gesture.
    const hidFilters = parseHidRequestCommand(command);
    if (hidFilters) {
      void this.runRemoteWithHidPicker(hidFilters);
      return;
    }
    // Pre-intercept `serial request` for the same gesture reason:
    // `navigator.serial.requestPort` needs a user gesture.
    const serialFilters = parseSerialRequestCommand(command);
    if (serialFilters) {
      void this.runRemoteWithSerialPicker(serialFilters);
      return;
    }
    // Pre-intercept `esptool <sub>` (without `--port`). The worker
    // command would otherwise call `serial.requestPort` after the
    // panel-RPC hop has discarded the keystroke's user activation and
    // Chromium would reject the chooser. Run the picker here, then
    // forward the original line with `--port <handle>` appended.
    const esptoolFilters = parseEsptoolPickerCommand(command);
    if (esptoolFilters) {
      void this.runRemoteWithEsptoolPicker(command, esptoolFilters);
      return;
    }
    void this.runRemote(command);
  }

  /**
   * Run a gesture-gated picker through the leader `<slicc-permissions>`
   * surface and capture the matching deny event so callers can render a
   * cancellation / unavailable / error line. The Enter keystroke
   * activation is preserved because we await `surface.request(...)`
   * directly — the surface forwards `opts.filters` to the platform
   * default (`navigator.usb.requestDevice` / `navigator.hid.requestDevice`
   * / `navigator.serial.requestPort` / `showDirectoryPicker`) without an
   * intervening DOM event, so user activation flows straight through.
   */
  private async requestPermission(
    kind: PermissionKind,
    opts?: PermissionRequestOptions
  ): Promise<
    | { ok: true; grant: PermissionGrant }
    | { ok: false; reason: PermissionDenyDetail['reason']; message?: string }
  > {
    const surface = getLeaderPermissionsSurface();
    if (!surface) {
      return { ok: false, reason: 'unavailable', message: 'permission surface not mounted' };
    }
    // Hold the deny detail in a property ref so TS's control-flow
    // narrowing doesn't pin it to `null` after the closure assignment
    // (closures don't participate in CFA).
    const denyRef: { current: PermissionDenyDetail | null } = { current: null };
    const onDeny = (event: Event): void => {
      const detail = (event as CustomEvent<PermissionDenyDetail>).detail;
      if (detail.kind === kind) denyRef.current = detail;
    };
    surface.addEventListener('slicc-permission-deny', onDeny);
    try {
      const grant = await surface.request(kind, opts);
      if (grant) return { ok: true, grant };
      const deny = denyRef.current;
      return {
        ok: false,
        reason: deny?.reason ?? 'error',
        ...(deny?.message ? { message: deny.message } : {}),
      };
    } finally {
      surface.removeEventListener('slicc-permission-deny', onDeny);
    }
  }

  /**
   * Render a denial outcome from {@link requestPermission}. `label`
   * prefixes the line and matches today's command-name prefix; the
   * `unavailable` branch uses the caller-supplied long-form message so
   * the existing UX ("usb: WebUSB is not available in this browser",
   * "mount: File System Access API not available", …) is preserved.
   */
  private writePickerDenial(
    label: string,
    denial: { reason: PermissionDenyDetail['reason']; message?: string },
    unavailableMessage: string
  ): void {
    if (!this.terminal) return;
    if (denial.reason === 'cancelled') {
      this.terminal.writeln(`${label}: cancelled`);
      return;
    }
    if (denial.reason === 'unavailable') {
      this.terminal.writeln(`${label}: ${unavailableMessage}`);
      return;
    }
    this.terminal.writeln(`${label}: ${denial.message ?? 'unknown error'}`);
  }

  /**
   * Run the WebUSB chooser through the centralized permission surface
   * on the Enter-keystroke gesture, register the granted device in the
   * page-side registry, then forward `usb request --__resolved <handle>`
   * so the worker command renders the device descriptor. Cancellation
   * surfaces as a terminal line and skips the worker exec entirely.
   */
  private async runRemoteWithUsbPicker(filters: UsbDeviceFilter[]): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission('usb', { filters });
      if (!result.ok) {
        this.writePickerDenial('usb', result, 'WebUSB is not available in this browser');
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'usb' }>;
      const handle = getSharedUsbRegistry().register(grant.device as UsbDevice);
      await this.runRemoteImpl(`usb request --__resolved ${handle}`);
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /**
   * Run the WebHID chooser through the centralized permission surface
   * on the Enter-keystroke gesture, register EVERY granted interface in
   * the page-side registry, then forward `hid request --__resolved <h1,h2,…>`
   * so the worker command renders each one. The surface returns
   * `{ device, devices }` where `devices` is the full array — for a
   * multi-interface device (e.g. a VIA/QMK keyboard) a single chooser
   * pick maps to one `HIDDevice` per interface, and the raw-HID (0xFF60)
   * interface is often NOT the first entry. Dropping all but `devices[0]`
   * would silently lose those siblings; the `--usage-page`/`--usage`
   * filter flags are preserved on the rewrite so the resolved branch can
   * reorder the matching interface to the top, matching the worker-side
   * `hid request` behavior.
   */
  private async runRemoteWithHidPicker(filters: HidDeviceFilter[]): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission('hid', { filters });
      if (!result.ok) {
        this.writePickerDenial('hid', result, 'WebHID is not available in this browser');
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'hid' }>;
      const registry = getSharedHidRegistry();
      const handles = (grant.devices as HidDevice[]).map((d) => registry.register(d));
      const usageSuffix = serializeHidUsageFlags(filters[0]);
      await this.runRemoteImpl(`hid request --__resolved ${handles.join(',')}${usageSuffix}`);
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /**
   * Run the Web Serial chooser through the centralized permission surface
   * on the Enter-keystroke gesture, register the granted port in the
   * page-side registry, then forward `serial request --__resolved <handle>`
   * so the worker command renders the port descriptor. Cancellation /
   * unavailable surfaces as a terminal line.
   */
  private async runRemoteWithSerialPicker(filters: SerialFilter[]): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission(
        'serial',
        filters.length ? { filters } : undefined
      );
      if (!result.ok) {
        this.writePickerDenial('serial', result, 'Web Serial is not available in this browser');
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'serial' }>;
      const handle = getSharedSerialRegistry().register(grant.port as SerialPort);
      await this.runRemoteImpl(`serial request --__resolved ${handle}`);
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /**
   * Run the Web Serial chooser through the centralized permission surface
   * on the Enter-keystroke gesture for an `esptool` invocation that
   * omitted `--port`, register the granted port, and forward the ORIGINAL
   * command line with `--port <handle>` appended so the worker command
   * reuses the resolved port instead of trying its own (gesture-less)
   * `requestPort`. Cancellation surfaces as a terminal line and skips
   * the worker exec.
   */
  private async runRemoteWithEsptoolPicker(
    command: string,
    filters: SerialFilter[]
  ): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission(
        'serial',
        filters.length ? { filters } : undefined
      );
      if (!result.ok) {
        this.writePickerDenial('esptool', result, 'Web Serial is not available in this browser');
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'serial' }>;
      const handle = getSharedSerialRegistry().register(grant.port as SerialPort);
      await this.runRemoteImpl(`${command.trim()} --port ${handle}`);
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /**
   * Pre-pick a local directory through the centralized permission surface
   * before forwarding the `mount` command to the worker. Runs
   * `showDirectoryPicker` on the keystroke activation chain. Cancellation
   * surfaces as a brief terminal line and skips the exec entirely (so
   * the worker doesn't receive a no-op `mount` call).
   */
  private async runRemoteWithLocalPicker(command: string, target: string): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission('filesystem');
      if (!result.ok) {
        this.writePickerDenial('mount', result, 'File System Access API not available');
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'filesystem' }>;
      try {
        await storePendingHandle(localMountIdbKey(target), grant.handle);
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
    this.clearMediaPreview();
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
        // While a silent exec is in flight (currently only
        // `handleTab`'s `compgen` round-trip), swallow output here so
        // it doesn't bleed into the user's prompt line. The
        // `TerminalSessionClient` still buffers the bytes against the
        // active `execId`, so `client.exec(...)` resolves with the
        // captured stdout/stderr.
        if (this.suppressOutput) return;
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
        this.renderMediaPreview(event);
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

/**
 * Parse a typed command line and return the WebUSB filters when it is a
 * gesture-requiring `usb request` (no `--__resolved` handle and no help
 * flag). Returns `null` for anything else so the worker handles it.
 */
function parseUsbRequestCommand(line: string): UsbDeviceFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'usb' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseUsbArgs(tokens.slice(2));
  return parseUsbFilters(flags);
}

/**
 * Parse a typed command line and return the WebHID filters when it is a
 * gesture-requiring `hid request` (no `--__resolved` handle and no help
 * flag). Returns `null` for anything else so the worker handles it.
 */
function parseHidRequestCommand(line: string): HidDeviceFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'hid' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseHidArgs(tokens.slice(2));
  return parseHidFilters(flags);
}

/**
 * Re-serialize the picker's `--usage-page` / `--usage` filter flags
 * onto the resolved-handle rewrite so the worker `hid request` can
 * reorder a multi-interface device to put the matching collection
 * first. The picker itself doesn't honor these as a hard pre-select
 * (Chromium's chooser is single-line per device), so they only steer
 * the post-grant display.
 */
function serializeHidUsageFlags(filter: HidDeviceFilter | undefined): string {
  if (!filter) return '';
  const parts: string[] = [];
  if (filter.usagePage !== undefined) {
    parts.push(`--usage-page 0x${filter.usagePage.toString(16)}`);
  }
  if (filter.usage !== undefined) {
    parts.push(`--usage 0x${filter.usage.toString(16)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Parse a typed command line and return the Web Serial filters when it
 * is a gesture-requiring `serial request` (no `--__resolved` handle and
 * no help flag). Returns `null` for anything else so the worker handles
 * it.
 */
function parseSerialRequestCommand(line: string): SerialFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'serial' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseSerialArgs(tokens.slice(2));
  return parseSerialFilters(flags);
}

/**
 * Parse a typed command line and return the Web Serial filters when it
 * is an `esptool <subcommand>` that will need the serial picker —
 * i.e. there is a subcommand positional, no `--port`, and no help
 * flag. Returns `null` for `esptool` with no subcommand (the worker
 * prints HELP) or when `--port` is already resolved so the worker
 * handles it directly.
 */
function parseEsptoolPickerCommand(line: string): SerialFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'esptool') return null;
  if (tokens.includes('--port') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { positionals, flags } = parseEsptoolArgs(tokens.slice(1));
  if (positionals.length === 0) return null;
  return parseSerialFilters(flags);
}

// ---------------------------------------------------------------------------
// Tab completion helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Single-quote a string for safe inclusion in a bash command. The
 * exhaustive form: replace each `'` with `'\''` and wrap the whole
 * result in `'…'`. Empty input becomes `''` so `compgen -- ''` is a
 * valid call (lists every candidate).
 */
export function bashSingleQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decide what to feed to `compgen` for the prefix at the cursor.
 *
 *   - The current word is whatever follows the last run of
 *     whitespace in `beforeCursor` (may be empty when the user is
 *     about to start a new word).
 *   - `isFirstWord` is true when the cursor sits in the leading
 *     position of the line — that's the "command name" slot, so we
 *     ask `compgen -A command` for shell-builtin / supplemental /
 *     PATH executables. Every other word is a file completion via
 *     `compgen -f`.
 */
export function buildCompgenPlan(beforeCursor: string): {
  currentWord: string;
  isFirstWord: boolean;
  compgenCmd: string;
} {
  const words = beforeCursor.split(/\s+/);
  const currentWord = words[words.length - 1] ?? '';
  const isFirstWord = words.length <= 1 || (words.length === 2 && words[0] === '');
  const escaped = bashSingleQuote(currentWord);
  const compgenCmd = isFirstWord ? `compgen -A command -- ${escaped}` : `compgen -f -- ${escaped}`;
  return { currentWord, isFirstWord, compgenCmd };
}

/**
 * Build the second-round `compgen -d` invocation used to decide
 * whether a single completion candidate is a directory (so the line
 * editor appends `/` instead of a space).
 */
export function buildCompgenDirCheck(completion: string): string {
  return `compgen -d -- ${bashSingleQuote(completion)}`;
}

/**
 * Longest common prefix of a non-empty match list. Drops one
 * character at a time until every entry shares the prefix. Returns
 * the empty string when the matches don't share a leading character.
 *
 * Exported so the multi-match insertion logic can be unit-tested
 * without a DOM. Matches the behavior of the local-bash
 * `AlmostBashShell.handleTab` so the two shells feel identical.
 */
export function longestCommonPrefix(matches: readonly string[]): string {
  if (matches.length === 0) return '';
  let prefix = matches[0];
  for (const m of matches) {
    while (prefix.length > 0 && !m.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) break;
  }
  return prefix;
}
