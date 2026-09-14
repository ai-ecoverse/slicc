import type {
  PermissionDenyDetail,
  PermissionGrant,
  PermissionKind,
  PermissionRequestOptions,
} from '@slicc/webcomponents';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Readline } from 'xterm-readline';
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

  sid?: TerminalSessionId;
  cwd?: string;
  env?: Record<string, string>;
}

const DARK_THEME = {
  background: '#141414',

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

  private readline: Readline | null = null;

  private disposed = false;

  private abortPromptLoop: ((reason: unknown) => void) | null = null;

  private programmaticResolve: ((result: TerminalExecResult) => void) | null = null;
  private isExecuting = false;

  private suppressOutput = false;

  private tabBusy = false;

  constructor(private readonly options: RemoteTerminalViewOptions) {
    const sid = options.sid ?? `panel-terminal-${Date.now()}`;
    this.client = new TerminalSessionClient({
      client: options.client,
      sid,
      onEvent: (event) => this.handleEvent(event),
    });
  }

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

  refit(): void {
    this.fitAddon?.fit();
  }

  clearTerminal(): void {
    this.terminal?.clear();
  }

  async executeCommandInTerminal(command: string): Promise<TerminalExecResult> {
    const trimmed = command.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };
    if (!this.terminal || !this.readline) return this.client.exec(trimmed);
    if (this.isExecuting || this.programmaticResolve || this.readline.getLine().length > 0) {
      return { stdout: '', stderr: 'terminal is busy; finish current input first\n', exitCode: 1 };
    }

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

  private async runPromptLoop(): Promise<void> {
    while (!this.disposed && this.readline && this.terminal) {
      let line: string;
      try {
        line = await this.readNextLine();
      } catch {
        break;
      } finally {
        this.abortPromptLoop = null;
      }

      const programmatic = this.programmaticResolve !== null;
      const result = await this.processLine(line, programmatic);

      if (this.programmaticResolve) {
        this.programmaticResolve(result);
        this.programmaticResolve = null;
      }
    }
  }

  private readNextLine(): Promise<string> {
    const terminal = this.terminal;
    const readline = this.readline;
    if (!terminal || !readline) {
      return Promise.reject(new Error('terminal not mounted'));
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      this.abortPromptLoop = reject;
    });
    const read = new Promise<string>((resolve, reject) => {
      terminal.write('', () => {
        if (terminal.buffer.active.cursorX > 0) {
          terminal.write('\x1b[7m%\x1b[0m\r\n');
        }
        readline.read(PROMPT).then(resolve, reject);
      });
    });
    return Promise.race([read, aborted]);
  }

  private async processLine(rawLine: string, programmatic = false): Promise<TerminalExecResult> {
    const command = rawLine.trim();
    const noop: TerminalExecResult = { stdout: '', stderr: '', exitCode: 0 };
    if (!command) return noop;
    if (!programmatic && (await this.tryRunPicker(command))) return noop;
    return this.runRemote(command);
  }

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
    return false;
  }

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

  private signalInterruptDuringExec(): void {
    if (!this.isExecuting) return;
    this.terminal?.writeln('^C');
    this.client.signal('SIGINT');
  }

  private neutralizeReadlineHistoryPersistence(): void {
    const history = (this.readline as unknown as { history?: ReadlineHistoryInternals }).history;
    if (!history) return;
    history.entries = [];
    history.cursor = -1;
    history.saveToLocalStorage = () => undefined;
    history.restoreFromLocalStorage = () => undefined;
  }

  private reanchorReadline(): void {
    if (!this.terminal || !this.readline) return;
    const state = (this.readline as unknown as { state?: ReadlineStateInternals }).state;
    if (!state) return;
    state.getTty().anchorRow = this.terminal.buffer.active.cursorY;
    state.refresh();
  }

  private async handleTab(): Promise<void> {
    if (!this.terminal || !this.readline) return;
    if (this.isExecuting || this.tabBusy) return;
    this.tabBusy = true;

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

      await this.client.exec(command);
    } finally {
      this.isExecuting = false;
    }
  }

  private async runRemote(command: string): Promise<TerminalExecResult> {
    this.isExecuting = true;
    this.clearMediaPreview();
    try {
      return await this.client.exec(command);
    } finally {
      this.isExecuting = false;
    }
  }

  private handleEvent(event: TerminalEventMsg): void {
    if (!this.terminal) return;
    switch (event.type) {
      case 'terminal-output':
        if (this.suppressOutput) return;

        if (event.stream === 'stderr') {
          this.terminal.write(`\x1b[31m${event.data}\x1b[0m`);
        } else {
          this.terminal.write(event.data);
        }
        return;
      case 'terminal-exit':
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
    tokens.includes('-l')
  ) {
    return null;
  }

  const target = tokens.slice(1).find((t) => !t.startsWith('-'));
  if (!target) return null;

  if (['list', 'unmount', 'refresh', 'recover'].includes(target)) return null;

  if (!target.startsWith('/')) return null;
  return target;
}

export function localMountIdbKey(target: string): string {
  return `pendingMount:term:${target}`;
}

function parseUsbRequestCommand(line: string): UsbDeviceFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'usb' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseUsbArgs(tokens.slice(2));
  return parseUsbFilters(flags);
}

function parseHidRequestCommand(line: string): HidDeviceFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'hid' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseHidArgs(tokens.slice(2));
  return parseHidFilters(flags);
}

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

function parseSerialRequestCommand(line: string): SerialFilter[] | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'serial' || tokens[1] !== 'request') return null;
  if (tokens.includes('--__resolved') || tokens.includes('--help') || tokens.includes('-h')) {
    return null;
  }
  const { flags } = parseSerialArgs(tokens.slice(2));
  return parseSerialFilters(flags);
}

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

export function bashSingleQuote(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

export function buildCompgenDirCheck(completion: string): string {
  return `compgen -d -- ${bashSingleQuote(completion)}`;
}

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
