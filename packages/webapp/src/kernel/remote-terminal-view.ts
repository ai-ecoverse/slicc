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
 *   - Line editing via the `xterm-readline` addon: typing, Backspace,
 *     Delete, ←/→ arrows (wrap-aware across long input that spans
 *     multiple visual rows), ↑/↓ history, Home/End, Ctrl+C → SIGINT.
 *   - Tab completion via a silent `compgen` round-trip to the
 *     worker shell (commands at line start, files otherwise).
 *   - Streaming output: `terminal-output` events render as they
 *     arrive; `terminal-exit` closes the prompt cycle.
 *   - `executeCommandInTerminal(cmd)` for programmatic dispatch
 *     (chat panel "run in terminal" affordance).
 *
 * Deliberate non-features (deferred, none blocking the standalone
 * smoke test):
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
import type { Readline } from 'xterm-readline';
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

/**
 * Minimal structural views into `xterm-readline` internals we depend on.
 * The addon exposes no public API to (a) disable its localStorage history
 * persistence or (b) re-anchor its renderer after we print tab-completion
 * candidates, so we reach in through these narrow shapes. Pinned to
 * `xterm-readline@1.2.2`; revisit on upgrade. Upstreaming a `persist:false`
 * option plus a completion hook would remove the need for both.
 */
interface ReadlineHistoryInternals {
  entries: string[];
  cursor: number;
  saveToLocalStorage: () => void;
  restoreFromLocalStorage: () => void;
}
interface ReadlineStateInternals {
  getTty(): { anchorRow: number };
  refresh(): void;
}

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

  // Line editor — the xterm-readline addon owns the buffer, cursor, and
  // history (including wrap-aware ←/→ navigation across visual rows).
  private readline: Readline | null = null;
  /** Set true by `dispose()` so the prompt loop exits. */
  private disposed = false;
  /** Rejects the pending `read()` so `dispose()` can unblock the loop. */
  private abortPromptLoop: ((reason: unknown) => void) | null = null;
  /** Resolves a programmatic `executeCommandInTerminal` caller's result. */
  private programmaticResolve: ((result: TerminalExecResult) => void) | null = null;
  private isExecuting = false;
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
    const { Readline } = await import('xterm-readline');
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

    this.readline = new Readline();
    this.neutralizeReadlineHistoryPersistence();
    this.terminal.loadAddon(this.readline);
    this.readline.setCtrlCHandler(() => this.signalInterruptDuringExec());
    this.setupInput();

    this.terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (kernel)\x1b[0m');
    this.terminal.writeln('\x1b[90mType "help" for available commands.\x1b[0m\n');

    await this.client.open({ cwd: this.options.cwd, env: this.options.env });
    void this.runPromptLoop();
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
    if (!this.terminal || !this.readline) return this.client.exec(trimmed);
    if (this.isExecuting || this.programmaticResolve || this.readline.getLine().length > 0) {
      return { stdout: '', stderr: 'terminal is busy; finish current input first\n', exitCode: 1 };
    }
    // Render the command in the active prompt line and commit it through
    // readline (as if the user typed it, then Enter). The prompt loop's
    // `processLine` runs it and resolves this promise with the result.
    const result = new Promise<TerminalExecResult>((resolve) => {
      this.programmaticResolve = resolve;
    });
    this.readline.updateLine(trimmed);
    this.terminal.input('\r');
    return result;
  }

  setPreviewStateListener(listener: ((hasPreview: boolean) => void) | null): void {
    this.previewStateListener = listener;
    listener?.(this.hasPreview);
  }

  /** Tear down the view + close the worker session. */
  dispose(): void {
    this.disposed = true;
    this.abortPromptLoop?.(new Error('terminal disposed'));
    this.abortPromptLoop = null;
    this.clearMediaPreview();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.readline = null;
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
  // Internal — line editor (xterm-readline)
  // ---------------------------------------------------------------------------

  /**
   * Prompt/execute loop. `readline.read()` owns ALL line editing — the
   * buffer, cursor, history (↑/↓), Home/End, Backspace/Delete, and
   * (crucially) ←/→ navigation that stays correct across long input that
   * wraps onto multiple visual rows, which the previous hand-rolled
   * editor could not do. Each committed line is dispatched through
   * `processLine`; the next iteration re-renders the prompt.
   */
  private async runPromptLoop(): Promise<void> {
    while (!this.disposed && this.readline && this.terminal) {
      let line: string;
      try {
        line = await this.readNextLine();
      } catch {
        // `dispose()` rejected the pending read to unblock the loop.
        break;
      } finally {
        this.abortPromptLoop = null;
      }
      const result = await this.processLine(line);
      // Hand the result to a programmatic `executeCommandInTerminal`
      // caller waiting on this line (the "run in terminal" E2E seam).
      if (this.programmaticResolve) {
        this.programmaticResolve(result);
        this.programmaticResolve = null;
      }
    }
  }

  /**
   * Await the next committed line, racing a `dispose()` abort so the
   * loop can unblock (readline has no `abortRead`). Extracted from the
   * loop body so the abort promise's closure isn't re-created inline on
   * every iteration.
   */
  private readNextLine(): Promise<string> {
    if (!this.readline) return Promise.reject(new Error('readline not mounted'));
    const aborted = new Promise<never>((_resolve, reject) => {
      this.abortPromptLoop = reject;
    });
    return Promise.race([this.readline.read(PROMPT), aborted]);
  }

  /**
   * Dispatch one committed line. Mirrors the old `handleEnter`
   * pre-intercepts: `mount` / `usb|hid|serial request` / `esptool` run a
   * gesture-gated device picker BEFORE the worker exec. The picker call
   * runs in the microtask chain of the Enter keystroke that resolved
   * `read()`, so that keystroke's transient user activation is still
   * valid when `showDirectoryPicker` / `requestDevice` / `requestPort`
   * fire.
   */
  private async processLine(rawLine: string): Promise<TerminalExecResult> {
    const command = rawLine.trim();
    const noop: TerminalExecResult = { stdout: '', stderr: '', exitCode: 0 };
    if (!command) return noop;

    const mountTarget = parseLocalMountTarget(command);
    if (mountTarget) {
      await this.runRemoteWithLocalPicker(command, mountTarget);
      return noop;
    }
    const usbFilters = parseUsbRequestCommand(command);
    if (usbFilters) {
      await this.runRemoteWithUsbPicker(usbFilters);
      return noop;
    }
    const hidFilters = parseHidRequestCommand(command);
    if (hidFilters) {
      await this.runRemoteWithHidPicker(hidFilters);
      return noop;
    }
    const serialFilters = parseSerialRequestCommand(command);
    if (serialFilters) {
      await this.runRemoteWithSerialPicker(serialFilters);
      return noop;
    }
    const esptoolFilters = parseEsptoolPickerCommand(command);
    if (esptoolFilters) {
      await this.runRemoteWithEsptoolPicker(command, esptoolFilters);
      return noop;
    }
    return this.runRemote(command);
  }

  /**
   * Wire the Tab-completion keystroke tap and the mid-completion Enter
   * guard. readline itself ignores Tab, so a second `onData` listener
   * owns completion without racing the addon. The custom key handler
   * (attached after the addon, so it wins) blocks Enter while a compgen
   * round-trip is in flight, so a second exec can't race the worker's
   * single exec slot.
   */
  private setupInput(): void {
    if (!this.terminal) return;
    this.terminal.onData((data) => {
      if (data === '\t') void this.handleTab();
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && this.tabBusy) return false;
      return true;
    });
  }

  /**
   * Ctrl+C handler invoked by readline only BETWEEN reads — i.e. while a
   * command is executing (no active `read()`). Forwards SIGINT to the
   * worker session so a running job can be interrupted. While a line is
   * being edited, readline handles Ctrl+C itself (clears the line).
   */
  private signalInterruptDuringExec(): void {
    if (!this.isExecuting) return;
    this.terminal?.writeln('^C');
    this.client.signal('SIGINT');
  }

  /**
   * xterm-readline persists command history to `localStorage['history']`
   * by default (restoring it in its constructor and saving on every
   * commit). SLICC keeps shell history in-memory per session and relies
   * on secret masking, so a command typed into the terminal must not be
   * written to disk under a generic, collision-prone key. Neutralize
   * both sides and clear anything a prior load may have restored.
   */
  private neutralizeReadlineHistoryPersistence(): void {
    const history = (this.readline as unknown as { history?: ReadlineHistoryInternals }).history;
    if (!history) return;
    history.entries = [];
    history.cursor = -1;
    history.saveToLocalStorage = () => undefined;
    history.restoreFromLocalStorage = () => undefined;
  }

  /**
   * Re-anchor readline's renderer to the current cursor row and redraw
   * the input line. Used after we print tab-completion candidates with
   * direct `println` calls, which move the real cursor without updating
   * the addon's tracked anchor row.
   */
  private reanchorReadline(): void {
    if (!this.terminal || !this.readline) return;
    const state = (this.readline as unknown as { state?: ReadlineStateInternals }).state;
    if (!state) return;
    state.getTty().anchorRow = this.terminal.buffer.active.cursorY;
    state.refresh();
  }

  /**
   * Bash-style tab completion via a silent `compgen` round-trip through
   * the worker shell.
   *
   * Mirrors the local `AlmostBashShell.handleTab` shape (commands at the
   * start of a line use `compgen -A command`; subsequent words use file
   * completion). Output from the compgen exec is swallowed by the
   * `suppressOutput` flag — only the matches are applied: single hit →
   * insert + trailing space/slash, multi hit → insert the longest common
   * prefix, listing fallback when there's no shared extension.
   *
   * Completion targets the committed buffer as the "before cursor" text
   * (cursor-at-end); a mid-line Tab completes the final token. Resolved
   * text is fed back through `terminal.input()` so the readline addon
   * inserts it and keeps its wrap-aware layout model in sync.
   */
  private async handleTab(): Promise<void> {
    if (!this.terminal || !this.readline) return;
    if (this.isExecuting || this.tabBusy) return;
    this.tabBusy = true;
    // Share the `isExecuting` gate so a Ctrl+C during the round-trip
    // routes to the worker and the single exec slot isn't double-booked.
    this.isExecuting = true;
    try {
      const beforeCursor = this.readline.getLine();
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
        if (suffix) this.terminal.input(suffix);
        // Decide between trailing space (commands / regular files) and
        // trailing slash (directories) via a second silent compgen.
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
        this.terminal.input(trail);
        return;
      }

      // Multi-match: insert the longest common prefix. If there's no
      // shared extension beyond what the user typed, list the candidates
      // and re-anchor so readline redraws the line below the listing.
      const prefix = longestCommonPrefix(matches);
      const suffix = prefix.slice(currentWord.length);
      if (suffix) {
        this.terminal.input(suffix);
        return;
      }
      this.readline.println('');
      this.readline.println(matches.map((m) => m.split('/').pop() ?? m).join('  '));
      this.reanchorReadline();
    } catch (err) {
      console.warn(
        '[RemoteTerminal] Tab completion failed:',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.tabBusy = false;
      this.isExecuting = false;
    }
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
      await this.client.exec(`usb request --__resolved ${handle}`);
    } finally {
      this.isExecuting = false;
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
      await this.client.exec(`hid request --__resolved ${handles.join(',')}${usageSuffix}`);
    } finally {
      this.isExecuting = false;
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
      await this.client.exec(`serial request --__resolved ${handle}`);
    } finally {
      this.isExecuting = false;
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
      await this.client.exec(`${command.trim()} --port ${handle}`);
    } finally {
      this.isExecuting = false;
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
      await this.client.exec(command);
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Dispatch `command` to the worker session and stream the result back
   * into the terminal. Output is rendered synchronously by the
   * `handleEvent` route; this helper only manages the `isExecuting` flag
   * (the prompt is re-rendered by the next `runPromptLoop` iteration).
   */
  private async runRemote(command: string): Promise<TerminalExecResult> {
    this.isExecuting = true;
    this.clearMediaPreview();
    try {
      return await this.client.exec(command);
    } finally {
      this.isExecuting = false;
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
