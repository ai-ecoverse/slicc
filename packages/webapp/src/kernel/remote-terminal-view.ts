/**
 * `RemoteTerminalView` — page-side terminal view that drives a
 * worker-resident shell through a `TerminalSessionClient`.
 *
 * The standalone-worker path
 * (`?kernel-worker=1`) runs the agent's `AlmostBashShell` inside a
 * DedicatedWorker. The panel terminal can't keep using the inline
 * `AlmostBashShell` view-class — that ships a local `Bash` instance the
 * worker never sees. This view is the panel-side counterpart to
 * the worker-side `TerminalSessionHost`: wterm renders here,
 * keystrokes assemble into committed lines locally, and Enter
 * dispatches each line via `terminal-exec` to the worker.
 *
 * What it does today:
 *   - Mount Ghostty-backed wterm + theme sync + refit.
 *   - Local line editing: typing, Backspace,
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
 * Worker safety: this file dynamically imports the DOM component and only loads
 * on the page side — never in the worker bundle.
 */

import type {
  PermissionDenyDetail,
  PermissionGrant,
  PermissionKind,
  PermissionRequestOptions,
  SliccTerminal,
} from '@slicc/webcomponents';
import { getLeaderPermissionsSurface } from '../core/permissions-surface-registry.js';
import { storePendingHandle } from '../fs/mount-picker-popup.js';
import { parseEsptoolArgs } from '../shell/supplemental-commands/esptool-command.js';
import { parseHidArgs, parseHidFilters } from '../shell/supplemental-commands/hid-command.js';
import {
  parseSerialArgs,
  parseSerialFilters,
} from '../shell/supplemental-commands/serial-command.js';
import { parseUsbArgs, parseUsbFilters } from '../shell/supplemental-commands/usb-command.js';
import type { TerminalEventMsg, TerminalSessionId } from '../shell/terminal-protocol.js';
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
import { TerminalLineEditor } from './terminal-line-editor.js';
import {
  type TerminalExecResult,
  TerminalSessionClient,
  type TerminalSessionTransport,
} from './terminal-session-client.js';
import {
  getSharedUsbRegistry,
  type UsbDevice,
  type UsbDeviceFilter,
} from './usb-device-registry.js';

export interface RemoteTerminalViewOptions {
  client: TerminalSessionTransport;
  /** Session id; defaults to `panel-terminal-${Date.now()}`. */
  sid?: TerminalSessionId;
  cwd?: string;
  env?: Record<string, string>;
}

const PROMPT = '\x1b[34m/\x1b[0m \x1b[90m$\x1b[0m ';

export class RemoteTerminalView {
  private readonly client: TerminalSessionClient;
  private terminal: SliccTerminal | null = null;
  private terminalHost: HTMLElement | null = null;
  private previewHost: HTMLElement | null = null;
  private previewUrls: string[] = [];
  private hasPreview = false;
  private previewStateListener: ((hasPreview: boolean) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Unblocks `mount()` if the panel closes during wterm WASM initialization. */
  private rejectTerminalReady: ((reason: unknown) => void) | null = null;
  /** Session-local command buffer, cursor, and history. */
  private editor: TerminalLineEditor | null = null;
  /** Set true by `dispose()` so the prompt loop exits. */
  private disposed = false;
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
  /** Keystrokes received during async completion, replayed in arrival order. */
  private pendingTabInput: string[] = [];

  constructor(private readonly options: RemoteTerminalViewOptions) {
    const sid = options.sid ?? `panel-terminal-${Date.now()}`;
    this.client = new TerminalSessionClient({
      client: options.client,
      sid,
      onEvent: (event) => this.handleEvent(event),
    });
  }

  /**
   * Mount the wterm view in `container` and open a worker-side
   * shell session. Resolves when the session is opened (or rejects
   * with the `error` text from a `terminal-status: error` event).
   */
  async mount(container: HTMLElement): Promise<void> {
    await import('@slicc/webcomponents');
    if (this.disposed) return;

    container.replaceChildren();
    this.terminalHost = document.createElement('div');
    this.terminalHost.className = 'terminal-panel__terminal-host';
    container.appendChild(this.terminalHost);

    this.previewHost = document.createElement('div');
    this.previewHost.className = 'terminal-panel__preview';
    container.appendChild(this.previewHost);

    const terminal = document.createElement('slicc-terminal') as SliccTerminal;
    terminal.hideHeader = true;
    terminal.style.width = '100%';
    terminal.style.height = '100%';
    this.terminal = terminal;
    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        terminal.removeEventListener('terminal-ready', onReady);
        terminal.removeEventListener('terminal-error', onError);
        this.rejectTerminalReady = null;
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (event: Event) => {
        cleanup();
        reject((event as CustomEvent<unknown>).detail);
      };
      this.rejectTerminalReady = (reason) => {
        cleanup();
        reject(reason);
      };
      terminal.addEventListener('terminal-ready', onReady);
      terminal.addEventListener('terminal-error', onError);
    });
    terminal.addEventListener('terminal-data', (event) => {
      this.handleTerminalData((event as CustomEvent<string>).detail);
    });
    this.terminalHost.appendChild(terminal);
    await ready;
    if (this.disposed) return;
    terminal.fit();

    this.editor = new TerminalLineEditor({
      write: (data) => terminal.write(data),
      getCursor: () => terminal.terminal?.bridge?.getCursor() ?? { row: 0, col: 0 },
      getScrollbackCount: () => terminal.terminal?.bridge?.getScrollbackCount() ?? 0,
    });

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.terminalHost);

    terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (kernel)\x1b[0m');
    terminal.writeln('\x1b[90mType "help" for available commands.\x1b[0m');
    terminal.writeln('');

    await this.client.open({ cwd: this.options.cwd, env: this.options.env });
    void this.runPromptLoop();
  }

  /** Re-fit the terminal to its container. */
  refit(): void {
    this.terminal?.fit();
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
    if (!this.terminal || !this.editor) return this.client.exec(trimmed);
    if (
      this.isExecuting ||
      this.programmaticResolve ||
      !this.editor.isReading ||
      this.editor.text
    ) {
      return { stdout: '', stderr: 'terminal is busy; finish current input first\n', exitCode: 1 };
    }
    // Render the command in the active prompt line and commit it. The prompt loop's
    // `processLine` runs it and resolves this promise with the result.
    const result = new Promise<TerminalExecResult>((resolve) => {
      this.programmaticResolve = resolve;
    });
    this.editor.setLine(trimmed);
    this.editor.accept();
    return result;
  }

  setPreviewStateListener(listener: ((hasPreview: boolean) => void) | null): void {
    this.previewStateListener = listener;
    listener?.(this.hasPreview);
  }

  /** Tear down the view + close the worker session. */
  dispose(): void {
    this.disposed = true;
    this.rejectTerminalReady?.(new Error('terminal disposed'));
    this.editor?.abort(new Error('terminal disposed'));
    this.clearMediaPreview();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.remove();
    this.terminal = null;
    this.editor = null;
    this.pendingTabInput = [];
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

    const previewItem = document.createElement('div');
    previewItem.className = 'terminal-panel__preview-item';

    const label = document.createElement('div');
    label.className = 'terminal-panel__preview-label';
    const name = event.path.split('/').pop() ?? event.path;
    label.textContent = `${name} · ${event.mediaType}`;
    previewItem.appendChild(label);

    if (event.mediaType === 'image/png') {
      const terminal = document.createElement('slicc-terminal') as SliccTerminal;
      terminal.hideHeader = true;
      terminal.style.width = '100%';
      terminal.style.height = '180px';
      terminal.style.pointerEvents = 'none';
      terminal.setAttribute('aria-label', `Kitty graphics preview of ${name}`);
      terminal.addEventListener(
        'terminal-ready',
        () =>
          requestAnimationFrame(() => {
            const viewport = terminal.shadowRoot?.querySelector<HTMLElement>('.host');
            if (viewport) viewport.scrollTop = 0;
            this.terminal?.focus();
          }),
        { once: true }
      );
      previewItem.appendChild(terminal);
      // Kitty direct PNG transport. Continuation chunks stay below the
      // protocol's 4096-byte payload limit; Ghostty places the decoded image.
      for (let offset = 0; offset < event.data.length; offset += 4096) {
        const first = offset === 0;
        const last = offset + 4096 >= event.data.length;
        const control = first ? `a=T,f=100,t=d,m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
        terminal.write(`\x1b_G${control};${event.data.slice(offset, offset + 4096)}\x1b\\`);
      }
    } else if (event.mediaType.startsWith('video/')) {
      const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: event.mediaType }));
      this.previewUrls.push(url);
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
      const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: event.mediaType }));
      this.previewUrls.push(url);
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

  /**
   * Prompt/execute loop. The editor owns the buffer, cursor, and history.
   * Each committed line is dispatched through
   * `processLine`; the next iteration re-renders the prompt.
   */
  private async runPromptLoop(): Promise<void> {
    while (!this.disposed && this.editor && this.terminal) {
      let line: string;
      try {
        line = await this.readNextLine();
      } catch {
        // `dispose()` rejected the pending read to unblock the loop.
        break;
      }
      // `executeCommandInTerminal` sets `programmaticResolve` before it
      // feeds a line, so a non-null resolver marks THIS line as a
      // programmatic (gesture-less) invocation.
      const programmatic = this.programmaticResolve !== null;
      const result = await this.processLine(line, programmatic);
      // Hand the result to that programmatic caller (the chat-panel
      // "run in terminal" / E2E seam).
      if (this.programmaticResolve) {
        this.programmaticResolve(result);
        this.programmaticResolve = null;
      }
    }
  }

  /**
   * Await a committed line. The editor checks Ghostty's synchronous cursor
   * state before drawing the next prompt, preserving unterminated output.
   */
  private readNextLine(): Promise<string> {
    if (!this.editor) return Promise.reject(new Error('terminal not mounted'));
    const line = this.editor.read(PROMPT);
    this.flushPendingTabInput();
    return line;
  }

  private flushPendingTabInput(): void {
    while (this.editor?.isReading && this.pendingTabInput.length > 0) {
      this.editor.feed(this.pendingTabInput.shift() ?? '');
    }
  }

  private handleTerminalData(data: string): void {
    if (data === '\t') {
      if (!this.tabBusy) void this.handleTab();
    } else if (data === '\x03' && this.isExecuting) {
      this.signalInterruptDuringExec();
    } else if (this.tabBusy) {
      this.pendingTabInput.push(data);
    } else {
      this.editor?.feed(data);
    }
  }

  /**
   * Dispatch one committed line. For real typed input, `mount` /
   * `usb|hid|serial request` / `esptool` first run a gesture-gated
   * device picker (see `tryRunPicker`): the picker fires in the
   * microtask chain of the Enter keystroke that resolved `read()`, so
   * that keystroke's transient user activation is still valid when
   * `showDirectoryPicker` / `requestDevice` / `requestPort` fire. A
   * `programmatic` line (from `executeCommandInTerminal`) has no gesture,
   * so it skips the pickers and runs directly — matching the
   * original programmatic path, which called `runRemote` without pre-intercepts.
   */
  private async processLine(rawLine: string, programmatic = false): Promise<TerminalExecResult> {
    const command = rawLine.trim();
    const noop: TerminalExecResult = { stdout: '', stderr: '', exitCode: 0 };
    if (!command) return noop;
    if (!programmatic && (await this.tryRunPicker(command))) return noop;
    return this.runRemote(command);
  }

  /**
   * Run a gesture-gated device picker for the pre-intercept commands
   * (`mount /<path>`, `usb|hid|serial request`, `esptool`, `computer add
   * screen`). Returns true when a picker handled the line, false for an
   * ordinary command. Only called for real typed input (see `processLine`)
   * because the pickers require the Enter-keystroke user activation.
   */
  private async tryRunPicker(command: string): Promise<boolean> {
    const mountTarget = parseLocalMountTarget(command);
    if (mountTarget) {
      await this.runRemoteWithLocalPicker(command, mountTarget);
      return true;
    }
    const usbFilters = parseUsbRequestCommand(command);
    if (usbFilters) {
      await this.runRemoteWithUsbPicker(usbFilters);
      return true;
    }
    const hidFilters = parseHidRequestCommand(command);
    if (hidFilters) {
      await this.runRemoteWithHidPicker(hidFilters);
      return true;
    }
    const serialFilters = parseSerialRequestCommand(command);
    if (serialFilters) {
      await this.runRemoteWithSerialPicker(serialFilters);
      return true;
    }
    const esptoolFilters = parseEsptoolPickerCommand(command);
    if (esptoolFilters) {
      await this.runRemoteWithEsptoolPicker(command, esptoolFilters);
      return true;
    }
    const screenAdd = parseComputerAddScreenCommand(command);
    if (screenAdd) {
      await this.runRemoteWithScreenShare(screenAdd.name);
      return true;
    }
    return false;
  }

  /**
   * Ctrl+C during execution forwards SIGINT to the worker. At a prompt,
   * the editor cancels the current line locally.
   */
  private signalInterruptDuringExec(): void {
    if (!this.isExecuting) return;
    this.terminal?.writeln('^C');
    this.client.signal('SIGINT');
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
   * Completion targets text before the cursor. The editor inserts the
   * resolved suffix and redraws any text following the cursor.
   */
  private async handleTab(): Promise<void> {
    if (!this.terminal || !this.editor) return;
    if (this.isExecuting || this.tabBusy) return;
    this.tabBusy = true;
    // Share the `isExecuting` gate so a Ctrl+C during the round-trip
    // routes to the worker and the single exec slot isn't double-booked.
    this.isExecuting = true;
    try {
      const beforeCursor = this.editor.beforeCursor;
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
        if (suffix) this.editor.insert(suffix);
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
        this.editor.insert(trail);
        return;
      }

      // Multi-match: insert the longest common prefix. If there's no
      // shared extension beyond what the user typed, list the candidates
      // and redraw the active line below the listing.
      const prefix = longestCommonPrefix(matches);
      const suffix = prefix.slice(currentWord.length);
      if (suffix) {
        this.editor.insert(suffix);
        return;
      }
      this.editor.list(matches.map((m) => m.split('/').pop() ?? m));
    } catch (err) {
      console.warn(
        '[RemoteTerminal] Tab completion failed:',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.tabBusy = false;
      this.isExecuting = false;
      this.flushPendingTabInput();
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
   * Run getDisplayMedia through the centralized screenshare permission
   * surface on the Enter-keystroke gesture, adopt the stream into the
   * page-side session store, then forward `computer add screen --__resolved
   * <handle>` so the worker registers a `screen:` computer without a
   * second picker.
   */
  private async runRemoteWithScreenShare(name: string | undefined): Promise<void> {
    this.isExecuting = true;
    try {
      const result = await this.requestPermission('screenshare', {
        constraints: { video: true },
      });
      if (!result.ok) {
        this.writePickerDenial(
          'computer',
          result,
          'screen capture is not available in this browser'
        );
        return;
      }
      const grant = result.grant as Extract<PermissionGrant, { kind: 'screenshare' }>;
      const { adoptDisplayStream, displaySessions } = await import(
        '../shell/supplemental-commands/screencapture-media.js'
      );
      const adopted = await adoptDisplayStream(grant.stream);
      if (!adopted.handle) {
        this.terminal?.writeln('computer: screen share produced no handle');
        return;
      }
      await finishAdoptedScreenRegistration(
        (cmd) => this.client.exec(cmd),
        (handle) => {
          displaySessions.stop(handle);
        },
        adopted.handle,
        name
      );
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
        // xterm's former convertEol option reset the column for bare LF.
        // Ghostty preserves VT semantics, so normalize shell output here.
        const output = event.data.replace(/\r?\n/g, '\r\n');
        if (event.stream === 'stderr') {
          this.terminal.write(`\x1b[31m${output}\x1b[0m`);
        } else {
          this.terminal.write(output);
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
 * (`mount list`, `mount --list`, `mount unmount`, `mount info`,
 * `mount /x --source s3://…`, `mount` alone, …).
 *
 * The match is intentionally narrow — false positives would fire
 * a directory picker for commands the user didn't intend, which is
 * jarring. The user's `mount /mnt/foo` (the canonical local mount
 * invocation) reliably matches; everything else falls through to
 * the worker, which produces the right error message itself.
 */
export function parseLocalMountTarget(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('mount')) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'mount') return null;
  if (
    tokens.includes('--source') ||
    tokens.includes('--help') ||
    tokens.includes('-h') ||
    tokens.includes('--list') ||
    tokens.includes('-l') ||
    tokens.includes('--json')
  ) {
    return null;
  }
  // First non-flag arg.
  const target = tokens.slice(1).find((t) => !t.startsWith('-'));
  if (!target) return null;
  // Skip subcommand-like tokens that don't take a directory picker.
  if (['list', 'unmount', 'refresh', 'recover', 'info'].includes(target)) return null;
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
 * Quote-aware argv split for panel-typed lines. Quoted `-n` names must
 * stay one token so reconstruction can pass them through `computer add
 * screen --__resolved` without re-splitting on whitespace.
 */
export function tokenizeCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of line.trim()) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function shellQuoteArg(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  if (arg.includes('"') && !arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Rebuild `computer add screen --__resolved` from parsed argv, quoting `-n`. */
export function buildComputerAddScreenResolvedCommand(handle: string, name?: string): string {
  const args = ['computer', 'add', 'screen', '--__resolved', handle];
  if (name !== undefined) args.push('-n', name);
  return args.map(shellQuoteArg).join(' ');
}

/**
 * After adopting a display stream, register it with the worker. Any throw
 * or nonzero `computer add screen` result must stop the session so the
 * display slot is not left alive but unreachable.
 */
export async function finishAdoptedScreenRegistration(
  exec: (command: string) => Promise<TerminalExecResult>,
  stop: (handle: string) => void,
  handle: string,
  name?: string
): Promise<TerminalExecResult> {
  try {
    const result = await exec(buildComputerAddScreenResolvedCommand(handle, name));
    if (result.exitCode !== 0) stop(handle);
    return result;
  } catch (err) {
    stop(handle);
    throw err;
  }
}

/**
 * Parse a typed command line and return a match when it is a
 * gesture-requiring `computer add screen` (no `--__resolved` handle and
 * no help flag). Returns `null` for anything else so the worker handles it.
 */
export function parseComputerAddScreenCommand(line: string): { name?: string } | null {
  const tokens = tokenizeCommandLine(line);
  if (tokens[0] !== 'computer' || tokens[1] !== 'add' || tokens[2] !== 'screen') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const nameIdx = tokens.findIndex((t) => t === '-n' || t === '--name');
  const name = nameIdx !== -1 ? tokens[nameIdx + 1] : undefined;
  return name ? { name } : {};
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
