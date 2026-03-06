/**
 * WasmShell — xterm.js terminal integration with just-bash.
 *
 * Provides a terminal UI that connects to just-bash's Bash interpreter
 * for command execution. Uses our VirtualFS via the VfsAdapter so that
 * all file operations persist to the browser's OPFS/IndexedDB storage.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { VirtualFS } from '../fs/index.js';
import { Bash, defineCommand } from 'just-bash';
import type { BashExecResult, SecureFetch, Command } from 'just-bash';
import { VfsAdapter } from './vfs-adapter.js';
import { cacheBinaryBody, cacheBinaryByUrl } from './binary-cache.js';
import { GitCommands } from '../git/git-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import { createSkillCommand, createUpskillCommand } from './supplemental-commands/upskill-command.js';
import { MountCommands } from '../fs/mount-commands.js';

/** Check if a content-type header indicates text (safe for UTF-8 decoding). */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return true; // Default to text for unknown types
  const ct = contentType.toLowerCase();
  return ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('html') ||
    ct.includes('css') ||
    ct.includes('svg');
}

/**
 * Read a fetch Response body as a string, preserving binary data.
 *
 * For text content types, uses resp.text() (proper UTF-8 decoding).
 * For binary content types, reads as arrayBuffer and decodes as latin1
 * (ISO-8859-1) so every byte maps 1:1 to a codepoint 0-255. This
 * preserves binary data through just-bash's string-typed FetchResult.body.
 */
async function readResponseBody(resp: Response, url?: string): Promise<string> {
  const contentType = resp.headers.get('content-type') ?? '';
  const isText = isTextContentType(contentType);
  if (isText) {
    return resp.text();
  }
  // Binary: read raw bytes and encode as latin1 string for just-bash's
  // string-typed FetchResult.body. Also cache the original bytes so
  // VfsAdapter.writeFile can bypass string encoding entirely.
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const latin1 = new TextDecoder('iso-8859-1').decode(buf);
  cacheBinaryBody(latin1, bytes);
  // Also cache by URL so commands like upskill can retrieve by URL
  if (url) {
    cacheBinaryByUrl(url, bytes);
  }
  return latin1;
}

/**
 * Create a SecureFetch that routes requests through the CLI server's
 * /api/fetch-proxy endpoint, bypassing browser CORS restrictions.
 * In extension mode, uses direct fetch (CORS bypass via host_permissions).
 * Uses just-bash 2.11.7's custom `fetch` option so curl gets a fresh,
 * stateless fetch per invocation (fixes the multi-curl-in-loop bug).
 *
 * Binary responses (images, archives, etc.) are encoded as latin1 strings
 * to preserve byte fidelity through just-bash's string-typed FetchResult.
 */
function createProxiedFetch(): SecureFetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  if (isExtension) {
    // Extension mode — host_permissions grant native CORS bypass
    return async (url, options) => {
      const resp = await fetch(url, {
        method: options?.method ?? 'GET',
        headers: options?.headers,
        body: options?.body,
      });
      const body = await readResponseBody(resp, url);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
    };
  }

  // CLI mode — proxy through /api/fetch-proxy
  return async (url, options) => {
    const method = options?.method ?? 'GET';
    const headers: Record<string, string> = {
      ...options?.headers,
      'X-Target-URL': url,
    };

    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (options?.body && !['GET', 'HEAD'].includes(method)) {
      init.body = options.body;
    }

    const resp = await fetch('/api/fetch-proxy', init);

    // Check for proxy errors before reading body
    if (resp.status === 502 || resp.status === 400) {
      const errorText = await resp.text();
      let errorMsg = `Proxy error ${resp.status}`;
      try { errorMsg = JSON.parse(errorText).error ?? errorMsg; } catch { /* not JSON */ }
      throw new Error(errorMsg);
    }

    const body = await readResponseBody(resp, url);
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });

    return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
  };
}

export interface WasmShellOptions {
  fs: VirtualFS;
  /** Container element for the terminal. */
  container?: HTMLElement;
  /** Initial working directory. Default: / */
  cwd?: string;
  /** Initial environment variables. */
  env?: Record<string, string>;
}

export class WasmShell {
  private bash: Bash;
  private vfsAdapter: VfsAdapter;
  private gitCommands: GitCommands;
  private mountCommands: MountCommands;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private currentLine = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private isExecuting = false;
  private continuationBuffer = '';
  /** Accumulated env state from successive exec() calls. */
  private lastEnv: Record<string, string>;
  private cwd: string;

  constructor(private options: WasmShellOptions) {
    this.vfsAdapter = new VfsAdapter(options.fs);
    const initialCwd = options.cwd ?? '/';
    const initialEnv: Record<string, string> = {
      HOME: '/',
      PATH: '/usr/bin',
      USER: 'user',
      SHELL: '/bin/bash',
      PWD: initialCwd,
      ...options.env,
    };

    // Initialize git commands with VirtualFS
    this.gitCommands = new GitCommands({
      fs: options.fs,
      authorName: initialEnv.GIT_AUTHOR_NAME ?? 'User',
      authorEmail: initialEnv.GIT_AUTHOR_EMAIL ?? 'user@example.com',
    });

    // Initialize mount commands with VirtualFS
    this.mountCommands = new MountCommands({ fs: options.fs });

    // Create custom commands for just-bash
    const gitCommand = this.createGitCustomCommand();
    const supplementalCommands = createSupplementalCommands();
    const mountCommand = this.createMountCustomCommand();
    const fetchFn = createProxiedFetch();

    this.bash = new Bash({
      fs: this.vfsAdapter,
      cwd: initialCwd,
      env: initialEnv,
      fetch: fetchFn,
      customCommands: [
        gitCommand,
        mountCommand,
        createSkillCommand(options.fs),
        createUpskillCommand(options.fs, fetchFn),
        ...supplementalCommands,
      ],
    });
    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;
  }

  /** Create a custom git command for just-bash. */
  private createGitCustomCommand(): Command {
    const gitCommands = this.gitCommands;
    return defineCommand('git', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await gitCommands.execute(args, cwd);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  /** Create a custom mount command for just-bash. */
  private createMountCustomCommand(): Command {
    const mountCommands = this.mountCommands;
    return defineCommand('mount', async (args, ctx) => {
      const cwd = ctx.cwd;
      const result = await mountCommands.execute(args, cwd);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
  }

  /** Get the underlying Bash instance for programmatic access. */
  getBash(): Bash {
    return this.bash;
  }

  /** Get current working directory. */
  getCwd(): string {
    return this.cwd;
  }

  /** Get a copy of the environment. */
  getEnv(): Record<string, string> {
    return { ...this.lastEnv };
  }

  /** Run a command through just-bash, carrying forward env/cwd state. */
  private async runCommand(command: string): Promise<BashExecResult> {
    const result = await this.bash.exec(command, {
      env: this.lastEnv,
      cwd: this.cwd,
    });
    // Persist state for next call
    if (result.env) {
      this.lastEnv = { ...result.env };
    }
    if (result.env?.PWD) {
      this.cwd = result.env.PWD;
    }
    return result;
  }

  /** Mount the terminal in a DOM container. */
  async mount(container?: HTMLElement): Promise<void> {
    const target = container ?? this.options.container;
    if (!target) throw new Error('No container element provided');

    // Dynamic imports so this module can be loaded in Node.js (tests) without xterm
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    // @ts-expect-error — Vite handles CSS imports at build time
    await import('@xterm/xterm/css/xterm.css');

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e94560',
        selectionBackground: '#e9456040',
      },
      convertEol: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    this.terminal.open(target);
    this.fitAddon.fit();

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit();
    });
    resizeObserver.observe(target);

    // Write welcome message
    this.terminal.writeln('slicc shell (powered by just-bash)');
    this.terminal.writeln('Type "help" for available commands.\n');

    this.showPrompt();
    this.setupInputHandler();
  }

  /** Execute a command programmatically (useful for agent integration). */
  async executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.runCommand(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /** Clear the terminal screen. */
  clearTerminal(): void {
    this.terminal?.clear();
  }

  /** Dispose the terminal. */
  dispose(): void {
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  private showPrompt(): void {
    if (!this.terminal) return;
    const shortCwd = this.cwd === '/' ? '/' : this.cwd.split('/').pop() ?? this.cwd;
    this.terminal.write(`\x1b[36m${shortCwd}\x1b[0m \x1b[33m$\x1b[0m `);
  }

  private setupInputHandler(): void {
    if (!this.terminal) return;

    this.terminal.onData((data) => {
      if (this.isExecuting) return;

      // Handle escape sequences as a whole (arrow keys, Home, End, Delete)
      if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) {
        switch (data) {
          case '\x1b[A': this.handleHistoryUp(); return;
          case '\x1b[B': this.handleHistoryDown(); return;
          case '\x1b[C': this.handleArrowRight(); return;
          case '\x1b[D': this.handleArrowLeft(); return;
          case '\x1b[H': case '\x1bOH': case '\x1b[1~': this.handleHome(); return;
          case '\x1b[F': case '\x1bOF': case '\x1b[4~': this.handleEnd(); return;
          case '\x1b[3~': this.handleDelete(); return;
        }
        return; // Ignore unknown escape sequences
      }

      // Handle regular characters one at a time (supports paste)
      for (const ch of data) {
        switch (ch) {
          case '\r': this.handleEnter(); break;
          case '\x7f': this.handleBackspace(); break;
          case '\x03': this.handleCtrlC(); break;
          case '\t': this.handleTab(); break;
          default:
            if (ch >= ' ') this.insertChar(ch);
        }
      }
    });
  }

  // -- Multi-line helpers --

  /** Visual width of the prompt: "cwd $ " */
  private getPromptWidth(): number {
    const shortCwd = this.cwd === '/' ? '/' : this.cwd.split('/').pop() ?? this.cwd;
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
    let targetLine = 0, targetCol = 0, pos = 0;
    for (let i = 0; i < lines.length; i++) {
      if (pos + lines[i].length >= this.cursorPos) {
        targetLine = i; targetCol = this.cursorPos - pos; break;
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
    this.currentLine =
      this.currentLine.slice(0, this.cursorPos) + ch + after;
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
    this.currentLine =
      this.currentLine.slice(0, this.cursorPos - 1) + after;
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
    this.currentLine =
      this.currentLine.slice(0, this.cursorPos) + after;
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
      // Cross to end of previous line
      const before = this.currentLine.slice(0, this.cursorPos);
      const prevLineStart = before.lastIndexOf('\n') + 1;
      const prevLineLen = this.cursorPos - prevLineStart;
      const visualCol = prevLineStart === 0
        ? this.getPromptWidth() + prevLineLen
        : prevLineLen;
      this.terminal?.write('\x1b[A\r');
      if (visualCol > 0) this.terminal?.write(`\x1b[${visualCol}C`);
    } else {
      this.terminal?.write('\x1b[D');
    }
  }

  private handleArrowRight(): void {
    if (this.cursorPos >= this.currentLine.length) return;
    if (this.currentLine[this.cursorPos] === '\n') {
      // Cross to start of next line
      this.cursorPos++;
      this.terminal?.write('\x1b[B\r');
    } else {
      this.cursorPos++;
      this.terminal?.write('\x1b[C');
    }
  }

  private handleHome(): void {
    // Go to start of current text line
    const before = this.currentLine.slice(0, this.cursorPos);
    const lineStart = before.lastIndexOf('\n') + 1;
    if (this.cursorPos === lineStart) return;
    this.cursorPos = lineStart;
    const visualCol = lineStart === 0 ? this.getPromptWidth() : 0;
    this.terminal?.write('\r');
    if (visualCol > 0) this.terminal?.write(`\x1b[${visualCol}C`);
  }

  private handleEnd(): void {
    // Go to end of current text line
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

    // Use just-bash's compgen builtin for completions (not child_process — this is WASM)
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
          this.currentLine = this.currentLine.slice(0, this.cursorPos) + suffix + this.currentLine.slice(this.cursorPos);
          this.cursorPos += suffix.length;
          this.terminal.write(suffix);
        }
        // Add trailing slash for dirs, space for everything else
        let trail = ' ';
        if (!isFirstWord) {
          const dirCheck = await this.bash.exec(`compgen -d -- ${escaped.slice(0, -1)}${suffix}'`, { env: this.lastEnv, cwd: this.cwd });
          if (dirCheck.stdout.trim() === completion) trail = '/';
        }
        this.currentLine = this.currentLine.slice(0, this.cursorPos) + trail + this.currentLine.slice(this.cursorPos);
        this.cursorPos += 1;
        this.terminal.write(trail);
      } else {
        // Multiple matches — complete common prefix, or show options
        let prefix = matches[0];
        for (const m of matches) {
          while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
        }
        const suffix = prefix.slice(currentWord.length);
        if (suffix) {
          this.currentLine = this.currentLine.slice(0, this.cursorPos) + suffix + this.currentLine.slice(this.cursorPos);
          this.cursorPos += suffix.length;
          this.terminal.write(suffix);
        } else {
          // Show all matches
          this.terminal.writeln('');
          this.terminal.writeln(matches.map((m) => m.split('/').pop() ?? m).join('  '));
          this.showPrompt();
          this.terminal.write(this.currentLine);
          const back = this.currentLine.length - this.cursorPos;
          if (back > 0) this.terminal.write(`\x1b[${back}D`);
        }
      }
    } catch (err) {
      console.warn('[Shell] Tab completion failed:', err instanceof Error ? err.message : String(err));
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
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && !inSingle) { escaped = true; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    }
    return inSingle || inDouble;
  }

  private async handleEnter(): Promise<void> {
    // Move cursor to end of displayed content so output appears below all lines
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

    // Accumulate continuation lines
    const combined = this.continuationBuffer
      ? this.continuationBuffer + '\n' + line
      : line;

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

    // Add to history
    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }

    // Handle "clear"
    if (trimmed === 'clear') {
      this.terminal?.clear();
      this.showPrompt();
      return;
    }

    this.isExecuting = true;
    try {
      const result = await this.runCommand(trimmed);
      if (result.stdout) {
        this.writeToTerminal(result.stdout);
      }
      if (result.stderr) {
        this.writeToTerminal(result.stderr, true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeToTerminal(`Error: ${msg}\n`, true);
    }
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
}
