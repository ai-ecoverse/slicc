/**
 * `WasmShell` — xterm.js terminal integration on top of
 * `WasmShellHeadless`.
 *
 * Phase 2b: the headless concerns (just-bash, jsh sync, custom
 * commands, executeCommand/executeScriptFile primitives) live in
 * `wasm-shell-headless.ts`. This file adds the **view layer** —
 * xterm mount, theme sync, refit / resize, line editor, command
 * history, tab completion, Ctrl+C, multi-line continuation, and
 * inline media-preview rendering for `imgcat`.
 *
 * Worker context: the agent's `bash` tool calls `executeCommand` /
 * `executeScriptFile` on a `WasmShell` instance, but never calls
 * `mount()`. The view fields stay `null`, and the view methods
 * are dead code — xterm itself is dynamically imported inside
 * `mount()` so it never enters the worker bundle. Phase 3 may
 * formally split the public types so the worker constructs
 * `WasmShellHeadless` directly; today the inheritance is enough.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { BashExecResult } from 'just-bash';
import type { MediaPreviewItem } from './supplemental-commands.js';
import {
  WasmShellHeadless,
  type HeadlessShellOptions,
  type HeadlessShellLike,
} from './wasm-shell-headless.js';
import {
  encodeForbiddenRequestHeaders,
  decodeForbiddenResponseHeaders,
  isTextContentType,
} from './proxied-fetch.js';

// Re-exports for backwards compatibility — existing tests import
// these from `wasm-shell.ts`. New callers should import from the
// origin modules directly.
export { encodeForbiddenRequestHeaders, decodeForbiddenResponseHeaders, isTextContentType };
export type { HeadlessShellLike };
export { WasmShellHeadless } from './wasm-shell-headless.js';

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export interface WasmShellOptions extends HeadlessShellOptions {
  /** Container element for the terminal. */
  container?: HTMLElement;
}

/**
 * `WasmShell` — view-extending shell. Inherits everything headless
 * from `WasmShellHeadless`; adds xterm mount + line editor + media
 * preview.
 */
export class WasmShell extends WasmShellHeadless {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private terminalHost: HTMLElement | null = null;
  private previewHost: HTMLElement | null = null;
  private previewUrls: string[] = [];
  private previewStateListener: ((hasPreview: boolean) => void) | null = null;
  private hasPreview = false;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private currentLine = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private isExecuting = false;
  private execAbort: AbortController | null = null;
  private continuationBuffer = '';

  constructor(options: WasmShellOptions) {
    super(options);
  }

  /**
   * View override: thread the active terminal `AbortController` into
   * `runCommand` so terminal Ctrl+C cancels the running just-bash
   * command. Headless-only callers pass `signal` explicitly; view
   * callers (`executeCommandInTerminal`, `handleEnter`) leave it
   * `undefined` and rely on `this.execAbort` being current.
   */
  protected override async runCommand(
    command: string,
    signal?: AbortSignal
  ): Promise<BashExecResult> {
    return super.runCommand(command, signal ?? this.execAbort?.signal);
  }

  // -------------------------------------------------------------------------
  // Mount lifecycle
  // -------------------------------------------------------------------------

  /** Mount the terminal in a DOM container. */
  async mount(container?: HTMLElement): Promise<void> {
    const target = container ?? (this.options as WasmShellOptions).container;
    if (!target) throw new Error('No container element provided');

    // Dynamic imports so this module can be loaded in Node.js (tests)
    // and the kernel worker without xterm.
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    await import('@xterm/xterm/css/xterm.css');

    const isDark = !document.documentElement.classList.contains('theme-light');
    const darkTheme = {
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
    const lightTheme = {
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

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 11,
      fontFamily: "'Source Code Pro', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: isDark ? darkTheme : lightTheme,
      convertEol: true,
    });

    this.themeObserver?.disconnect();
    this.themeObserver = new MutationObserver(() => {
      if (!this.terminal) return;
      const isLight = document.documentElement.classList.contains('theme-light');
      this.terminal.options.theme = isLight ? lightTheme : darkTheme;
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    target.replaceChildren();
    this.terminalHost = document.createElement('div');
    this.terminalHost.className = 'terminal-panel__terminal-host';
    target.appendChild(this.terminalHost);

    this.previewHost = document.createElement('div');
    this.previewHost.className = 'terminal-panel__preview';
    target.appendChild(this.previewHost);

    this.terminal.open(this.terminalHost);
    this.fitAddon.fit();

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.terminalHost);

    this.terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (powered by just-bash)\x1b[0m');
    this.terminal.writeln('\x1b[90mType "help" for available commands.\x1b[0m\n');

    this.showPrompt();
    this.setupInputHandler();
  }

  /** Re-fit the terminal to its host container. */
  refit(): void {
    this.fitAddon?.fit();
  }

  setPreviewStateListener(listener: ((hasPreview: boolean) => void) | null): void {
    this.previewStateListener = listener;
    this.previewStateListener?.(this.hasPreview);
  }

  /**
   * Execute a command and render it in the mounted terminal.
   * Returns the command result for callers that need status.
   */
  async executeCommandInTerminal(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const trimmed = command.trim();
    if (!trimmed) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (!this.terminal) {
      return this.executeCommand(trimmed);
    }

    if (this.isExecuting || this.currentLine.length > 0 || this.continuationBuffer.length > 0) {
      return {
        stdout: '',
        stderr: 'terminal is busy; finish current input first\n',
        exitCode: 1,
      };
    }

    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }
    this.historyIndex = -1;

    this.terminal.write(trimmed);
    this.terminal.writeln('');
    this.isExecuting = true;
    this.execAbort = new AbortController();

    try {
      const result = await this.runCommand(trimmed);
      const wasAborted = this.execAbort.signal.aborted;
      this.execAbort = null;
      if (wasAborted) {
        return { stdout: '', stderr: '', exitCode: 130 };
      }
      if (result.stdout) {
        this.writeToTerminal(result.stdout);
      }
      if (result.stderr) {
        this.writeToTerminal(result.stderr, true);
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (e) {
      if (this.execAbort?.signal.aborted) {
        this.execAbort = null;
        return { stdout: '', stderr: '', exitCode: 130 };
      }
      this.execAbort = null;
      const msg = e instanceof Error ? e.message : String(e);
      const stderr = `Error: ${msg}\n`;
      this.writeToTerminal(stderr, true);
      return { stdout: '', stderr, exitCode: 1 };
    } finally {
      this.isExecuting = false;
      this.showPrompt();
    }
  }

  /** Clear the terminal screen. */
  clearTerminal(): void {
    this.terminal?.clear();
    this.clearMediaPreview();
  }

  /** Dispose the terminal + headless tear-down. */
  override dispose(): void {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearMediaPreview();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.terminalHost = null;
    this.previewHost = null;
    super.dispose();
  }

  // -------------------------------------------------------------------------
  // Line editor
  // -------------------------------------------------------------------------

  private showPrompt(): void {
    if (!this.terminal) return;
    const shortCwd = this.cwd === '/' ? '/' : (this.cwd.split('/').pop() ?? this.cwd);
    this.terminal.write(`\x1b[34m${shortCwd}\x1b[0m \x1b[90m$\x1b[0m `);
  }

  private setupInputHandler(): void {
    if (!this.terminal) return;

    this.terminal.onData((data) => {
      if (this.isExecuting) {
        // Allow Ctrl+C to interrupt running commands
        if (data === '\x03' || (data.length === 1 && data.charCodeAt(0) === 3)) {
          this.execAbort?.abort();
          this.terminal?.writeln('^C');
        }
        return;
      }

      // Handle escape sequences as a whole (arrow keys, Home, End, Delete)
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
        return; // Ignore unknown escape sequences
      }

      // Handle regular characters one at a time (supports paste)
      for (const ch of data) {
        switch (ch) {
          case '\r':
            this.handleEnter();
            break;
          case '\x7f':
            this.handleBackspace();
            break;
          case '\x03':
            this.handleCtrlC();
            break;
          case '\t':
            this.handleTab();
            break;
          default:
            if (ch >= ' ') this.insertChar(ch);
        }
      }
    });
  }

  // -- Multi-line helpers --

  /** Visual width of the prompt: "cwd $ " */
  private getPromptWidth(): number {
    const shortCwd = this.cwd === '/' ? '/' : (this.cwd.split('/').pop() ?? this.cwd);
    return shortCwd.length + 3;
  }

  /** Which visual line (0-indexed) the cursor is on. */
  private getCursorVisualLine(): number {
    let pos = 0;
    for (const [i, line] of this.currentLine.split('\n').entries()) {
      if (pos + line.length >= this.cursorPos) return i;
      pos += line.length + 1;
    }
    return 0;
  }

  /** Move terminal cursor from end-of-content to the position matching cursorPos. */
  private positionTerminalCursor(): void {
    const lines = this.currentLine.split('\n');
    let targetLine = 0,
      targetCol = 0,
      pos = 0;
    for (let i = 0; i < lines.length; i++) {
      if (pos + lines[i].length >= this.cursorPos) {
        targetLine = i;
        targetCol = this.cursorPos - pos;
        break;
      }
      pos += lines[i].length + 1;
    }
    const linesUp = lines.length - 1 - targetLine;
    if (linesUp > 0) this.terminal?.write(`\x1b[${linesUp}A`);
    const visualCol = targetLine === 0 ? this.getPromptWidth() + targetCol : targetCol;
    this.terminal?.write('\r');
    if (visualCol > 0) this.terminal?.write(`\x1b[${visualCol}C`);
  }

  /** Erase everything from prompt line down, redraw content, reposition cursor. */
  private redrawInput(oldVisualLine: number): void {
    if (oldVisualLine > 0) this.terminal?.write(`\x1b[${oldVisualLine}A`);
    this.terminal?.write('\r\x1b[J');
    this.showPrompt();
    this.terminal?.write(this.currentLine);
    this.positionTerminalCursor();
  }

  // -- Editing --

  private insertChar(ch: string): void {
    const multiLine = this.currentLine.includes('\n');
    const oldLine = multiLine ? this.getCursorVisualLine() : 0;
    const after = this.currentLine.slice(this.cursorPos);
    this.currentLine = this.currentLine.slice(0, this.cursorPos) + ch + after;
    this.cursorPos++;
    if (multiLine) {
      this.redrawInput(oldLine);
    } else {
      this.terminal?.write(ch + after);
      if (after.length > 0) this.terminal?.write(`\x1b[${after.length}D`);
    }
  }

  private handleBackspace(): void {
    if (this.cursorPos <= 0) return;
    const multiLine = this.currentLine.includes('\n');
    const oldLine = multiLine ? this.getCursorVisualLine() : 0;
    const after = this.currentLine.slice(this.cursorPos);
    this.currentLine = this.currentLine.slice(0, this.cursorPos - 1) + after;
    this.cursorPos--;
    if (multiLine) {
      this.redrawInput(oldLine);
    } else {
      this.terminal?.write('\b' + after + ' ');
      this.terminal?.write(`\x1b[${after.length + 1}D`);
    }
  }

  private handleDelete(): void {
    if (this.cursorPos >= this.currentLine.length) return;
    const multiLine = this.currentLine.includes('\n');
    const oldLine = multiLine ? this.getCursorVisualLine() : 0;
    const after = this.currentLine.slice(this.cursorPos + 1);
    this.currentLine = this.currentLine.slice(0, this.cursorPos) + after;
    if (multiLine) {
      this.redrawInput(oldLine);
    } else {
      this.terminal?.write(after + ' ');
      this.terminal?.write(`\x1b[${after.length + 1}D`);
    }
  }

  // -- Cursor movement --

  private handleArrowLeft(): void {
    if (this.cursorPos <= 0) return;
    this.cursorPos--;
    if (this.currentLine[this.cursorPos] === '\n') {
      const before = this.currentLine.slice(0, this.cursorPos);
      const prevLineStart = before.lastIndexOf('\n') + 1;
      const prevLineLen = this.cursorPos - prevLineStart;
      const visualCol = prevLineStart === 0 ? this.getPromptWidth() + prevLineLen : prevLineLen;
      this.terminal?.write('\x1b[A\r');
      if (visualCol > 0) this.terminal?.write(`\x1b[${visualCol}C`);
    } else {
      this.terminal?.write('\x1b[D');
    }
  }

  private handleArrowRight(): void {
    if (this.cursorPos >= this.currentLine.length) return;
    if (this.currentLine[this.cursorPos] === '\n') {
      this.cursorPos++;
      this.terminal?.write('\x1b[B\r');
    } else {
      this.cursorPos++;
      this.terminal?.write('\x1b[C');
    }
  }

  private handleHome(): void {
    const before = this.currentLine.slice(0, this.cursorPos);
    const lineStart = before.lastIndexOf('\n') + 1;
    if (this.cursorPos === lineStart) return;
    this.cursorPos = lineStart;
    const visualCol = lineStart === 0 ? this.getPromptWidth() : 0;
    this.terminal?.write('\r');
    if (visualCol > 0) this.terminal?.write(`\x1b[${visualCol}C`);
  }

  private handleEnd(): void {
    let lineEnd = this.currentLine.indexOf('\n', this.cursorPos);
    if (lineEnd === -1) lineEnd = this.currentLine.length;
    if (this.cursorPos === lineEnd) return;
    const moved = lineEnd - this.cursorPos;
    this.cursorPos = lineEnd;
    this.terminal?.write(`\x1b[${moved}C`);
  }

  private handleCtrlC(): void {
    this.terminal?.writeln('^C');
    this.currentLine = '';
    this.cursorPos = 0;
    this.continuationBuffer = '';
    this.showPrompt();
  }

  private handleHistoryUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.continuationBuffer = '';
      this.replaceCurrentLine(this.history[this.history.length - 1 - this.historyIndex]);
    }
  }

  private handleHistoryDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.continuationBuffer = '';
      this.replaceCurrentLine(this.history[this.history.length - 1 - this.historyIndex]);
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.continuationBuffer = '';
      this.replaceCurrentLine('');
    }
  }

  private async handleTab(): Promise<void> {
    if (!this.terminal) return;

    const beforeCursor = this.currentLine.slice(0, this.cursorPos);
    const words = beforeCursor.split(/\s+/);
    const currentWord = words[words.length - 1] || '';
    const isFirstWord = words.length <= 1 || (words.length === 2 && words[0] === '');

    const escaped = currentWord ? "'" + currentWord.replace(/'/g, "'\\''") + "'" : "''";
    const compgenCmd = isFirstWord
      ? `compgen -A command -- ${escaped}`
      : `compgen -f -- ${escaped}`;

    try {
      const result = await this.bash.exec(compgenCmd, { env: this.lastEnv, cwd: this.cwd });
      const matches = result.stdout.split('\n').filter(Boolean);
      if (matches.length === 0) return;

      if (matches.length === 1) {
        const completion = matches[0];
        const suffix = completion.slice(currentWord.length);
        if (suffix) {
          this.currentLine =
            this.currentLine.slice(0, this.cursorPos) +
            suffix +
            this.currentLine.slice(this.cursorPos);
          this.cursorPos += suffix.length;
          this.terminal.write(suffix);
        }
        let trail = ' ';
        if (!isFirstWord) {
          const dirCheck = await this.bash.exec(`compgen -d -- ${escaped.slice(0, -1)}${suffix}'`, {
            env: this.lastEnv,
            cwd: this.cwd,
          });
          if (dirCheck.stdout.trim() === completion) trail = '/';
        }
        this.currentLine =
          this.currentLine.slice(0, this.cursorPos) +
          trail +
          this.currentLine.slice(this.cursorPos);
        this.cursorPos += 1;
        this.terminal.write(trail);
      } else {
        let prefix = matches[0];
        for (const m of matches) {
          while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
        }
        const suffix = prefix.slice(currentWord.length);
        if (suffix) {
          this.currentLine =
            this.currentLine.slice(0, this.cursorPos) +
            suffix +
            this.currentLine.slice(this.cursorPos);
          this.cursorPos += suffix.length;
          this.terminal.write(suffix);
        } else {
          this.terminal.writeln('');
          this.terminal.writeln(matches.map((m) => m.split('/').pop() ?? m).join('  '));
          this.showPrompt();
          this.terminal.write(this.currentLine);
          const back = this.currentLine.length - this.cursorPos;
          if (back > 0) this.terminal.write(`\x1b[${back}D`);
        }
      }
    } catch (err) {
      console.warn(
        '[Shell] Tab completion failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private replaceCurrentLine(text: string): void {
    const oldLine = this.getCursorVisualLine();
    if (oldLine > 0) this.terminal?.write(`\x1b[${oldLine}A`);
    this.terminal?.write('\r\x1b[J');
    this.showPrompt();
    this.currentLine = text;
    this.cursorPos = text.length;
    this.terminal?.write(text);
  }

  /** Check if input needs continuation (unclosed quotes or trailing backslash). */
  private isIncomplete(input: string): boolean {
    if (input.endsWith('\\')) return true;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (const ch of input) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && !inSingle) {
        escaped = true;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
    }
    return inSingle || inDouble;
  }

  private async handleEnter(): Promise<void> {
    const lines = this.currentLine.split('\n');
    if (lines.length > 1) {
      const curLine = this.getCursorVisualLine();
      const below = lines.length - 1 - curLine;
      if (below > 0) this.terminal?.write(`\x1b[${below}B`);
      const lastLen = lines[lines.length - 1].length;
      this.terminal?.write('\r');
      if (lastLen > 0) this.terminal?.write(`\x1b[${lastLen}C`);
    }
    this.terminal?.writeln('');
    const line = this.currentLine;
    this.currentLine = '';
    this.cursorPos = 0;

    const combined = this.continuationBuffer ? this.continuationBuffer + '\n' + line : line;

    if (this.isIncomplete(combined)) {
      this.continuationBuffer = combined;
      this.terminal?.write('> ');
      return;
    }

    this.continuationBuffer = '';
    const trimmed = combined.trim();
    this.historyIndex = -1;

    if (!trimmed) {
      this.showPrompt();
      return;
    }

    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }

    if (trimmed === 'clear') {
      this.clearTerminal();
      this.showPrompt();
      return;
    }

    this.isExecuting = true;
    this.execAbort = new AbortController();
    try {
      const result = await this.runCommand(trimmed);
      const wasAborted = this.execAbort.signal.aborted;
      if (wasAborted) {
        // Command was interrupted — suppress output
      } else {
        if (result.stdout) {
          this.writeToTerminal(result.stdout);
        }
        if (result.stderr) {
          this.writeToTerminal(result.stderr, true);
        }
      }
    } catch (e) {
      if (!this.execAbort?.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        this.writeToTerminal(`Error: ${msg}\n`, true);
      }
    }
    this.execAbort = null;
    this.isExecuting = false;
    this.showPrompt();
  }

  private writeToTerminal(text: string, isError = false): void {
    if (!this.terminal) return;
    if (isError) {
      this.terminal.write(`\x1b[31m${text}\x1b[0m`);
    } else {
      this.terminal.write(text);
    }
  }

  private clearMediaPreview(): void {
    for (const url of this.previewUrls) {
      URL.revokeObjectURL(url);
    }
    this.previewUrls = [];
    this.hasPreview = false;
    if (this.previewHost) {
      this.previewHost.replaceChildren();
      this.previewHost.classList.remove('terminal-panel__preview--visible');
    }
    this.previewStateListener?.(false);
  }

  /**
   * View override: render the inline media preview inside the
   * terminal panel. Headless base throws; this overrides with the
   * existing image/video rendering logic.
   */
  protected override async renderMediaPreview(items: MediaPreviewItem[]): Promise<void> {
    if (!this.previewHost || typeof document === 'undefined') {
      throw new Error('terminal preview is unavailable');
    }

    this.clearMediaPreview();

    for (const item of items) {
      const bytes = new Uint8Array(item.bytes);
      const url = URL.createObjectURL(new Blob([bytes], { type: item.mimeType }));
      this.previewUrls.push(url);

      const previewItem = document.createElement('div');
      previewItem.className = 'terminal-panel__preview-item';

      const label = document.createElement('div');
      label.className = 'terminal-panel__preview-label';
      label.textContent = `${basename(item.path)} · ${item.mimeType}`;
      previewItem.appendChild(label);

      if (item.mimeType.startsWith('video/')) {
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
        image.alt = basename(item.path);
        image.src = url;
        image.addEventListener('load', () => this.refit(), { once: true });
        previewItem.appendChild(image);
      }

      this.previewHost.appendChild(previewItem);
    }

    this.previewHost.classList.add('terminal-panel__preview--visible');
    this.hasPreview = items.length > 0;
    this.previewStateListener?.(this.hasPreview);
    requestAnimationFrame(() => this.refit());
  }
}
