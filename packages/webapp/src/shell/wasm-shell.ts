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
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from 'just-bash';
import type { BashExecResult, SecureFetch, Command } from 'just-bash';
import { VfsAdapter } from './vfs-adapter.js';
import { cacheBinaryBody, cacheBinaryByUrl } from './binary-cache.js';
import { GitCommands } from '../git/git-commands.js';
import { createSupplementalCommands } from './supplemental-commands.js';
import type { MediaPreviewItem } from './supplemental-commands.js';
import type { BrowserAPI } from '../cdp/index.js';
import {
  createSkillCommand,
  createUpskillCommand,
} from './supplemental-commands/upskill-command.js';
import { MountCommands } from '../fs/mount-commands.js';
import { discoverJshCommands, type JshDiscoveryFS } from './jsh-discovery.js';
import { executeJshFile, executeJsCode } from './jsh-executor.js';
import { parseShellArgs } from './parse-shell-args.js';
import { trackShellCommand } from '../ui/telemetry.js';

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Check if a content-type header indicates text (safe for UTF-8 decoding). */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return true; // Default to text for unknown types
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('html') ||
    ct.includes('css') ||
    ct.includes('svg')
  );
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
// Convert Headers or Record<string, string> to a plain Record<string, string>.
function headersToRecord(
  headers: Record<string, string> | Headers | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((v, k) => {
      rec[k] = v;
    });
    return rec;
  }
  return headers;
}

// Multipart form bodies contain latin1-encoded binary file content from curl —
// convert to raw bytes so fetch() doesn't re-encode as UTF-8.
function prepareRequestBody(
  body: string | undefined,
  headers?: Record<string, string>
): BodyInit | undefined {
  if (!body) return undefined;
  const ct = headers?.['Content-Type'] ?? headers?.['content-type'] ?? '';
  if (ct.includes('multipart/form-data')) {
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i);
    return bytes;
  }
  return body;
}

/**
 * Encode request headers that browsers silently strip (forbidden headers).
 * Cookie → X-Proxy-Cookie, Proxy-* → X-Proxy-Proxy-*
 */
export function encodeForbiddenRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      result['X-Proxy-Cookie'] = value;
    } else if (lower.startsWith('proxy-')) {
      result[`X-Proxy-${key}`] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decode response headers that the proxy transported under non-forbidden names.
 * X-Proxy-Set-Cookie (JSON array) → set-cookie (JSON array string)
 */
export function decodeForbiddenResponseHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-proxy-set-cookie') {
      // Value is a JSON array of Set-Cookie strings from the proxy.
      // Keep as JSON array string since Record<string,string> can only hold one value.
      result['set-cookie'] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function createProxiedFetch(): SecureFetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  if (isExtension) {
    // Extension mode — host_permissions grant native CORS bypass
    return async (url, options) => {
      const plainHeaders = headersToRecord(options?.headers);
      const resp = await fetch(url, {
        method: options?.method ?? 'GET',
        headers: plainHeaders,
        body: prepareRequestBody(options?.body, plainHeaders),
      });
      const body = await readResponseBody(resp, url);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
    };
  }

  // CLI mode — proxy through /api/fetch-proxy
  return async (url, options) => {
    const method = options?.method ?? 'GET';
    const plainHeaders = headersToRecord(options?.headers);
    const encoded = encodeForbiddenRequestHeaders(plainHeaders);
    const headers: Record<string, string> = {
      ...encoded,
      'X-Target-URL': url,
    };

    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (options?.body && !['GET', 'HEAD'].includes(method)) {
      init.body = prepareRequestBody(options.body, headers);
    }

    const resp = await fetch('/api/fetch-proxy', init);

    // Check for proxy errors before reading body
    if (resp.status === 502 || resp.status === 400) {
      const errorText = await resp.text();
      let errorMsg = `Proxy error ${resp.status}`;
      try {
        errorMsg = JSON.parse(errorText).error ?? errorMsg;
      } catch {
        /* not JSON */
      }
      throw new Error(errorMsg);
    }

    const body = await readResponseBody(resp, url);
    const rawHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      rawHeaders[k] = v;
    });
    const respHeaders = decodeForbiddenResponseHeaders(rawHeaders);

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
  /** BrowserAPI for playwright-cli command. */
  browserAPI?: BrowserAPI;
  /** Optional: FS to use for .jsh discovery (defaults to fs). Useful for scoops where skill loading uses unrestricted VFS but the shell uses RestrictedFS. */
  jshDiscoveryFs?: JshDiscoveryFS;
}

export class WasmShell {
  private bash: Bash;
  private vfsAdapter: VfsAdapter;
  private gitCommands: GitCommands;
  private mountCommands: MountCommands;
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
  private continuationBuffer = '';
  /** Accumulated env state from successive exec() calls. */
  private lastEnv: Record<string, string>;
  private cwd: string;
  /** Set of all built-in + custom command names (for shadowing protection). */
  private builtinCommandNames: Set<string>;

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
    const supplementalCommands = createSupplementalCommands({
      onMediaPreview: async (items) => this.renderMediaPreview(items),
      getJshCommands: () => this.getJshCommandNames(),
      fs: options.fs,
      browserAPI: options.browserAPI,
    });
    const mountCommand = this.createMountCustomCommand();
    const fetchFn = createProxiedFetch();

    const customCommands = [
      gitCommand,
      mountCommand,
      createSkillCommand(options.fs),
      createUpskillCommand(options.fs, fetchFn),
      ...supplementalCommands,
    ];

    this.bash = new Bash({
      fs: this.vfsAdapter,
      cwd: initialCwd,
      env: initialEnv,
      fetch: fetchFn,
      customCommands,
    });

    // Wire up /usr/bin virtual directory with all registered command names
    const customCommandNames = customCommands.map((c) => c.name);
    this.builtinCommandNames = new Set([
      ...getCommandNames(),
      ...getNetworkCommandNames(),
      ...customCommandNames,
    ]);
    this.vfsAdapter.setRegisteredCommandsFn(() => [...this.builtinCommandNames]);

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

  /** Discover .jsh commands from VFS (fresh scan each call, no caching), filtering out built-in command names. */
  private async getFilteredJshCommands(): Promise<Map<string, string>> {
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    const all = await discoverJshCommands(discoveryFs);
    const filtered = new Map<string, string>();
    for (const [name, path] of all) {
      if (!this.builtinCommandNames.has(name)) {
        filtered.set(name, path);
      }
    }
    return filtered;
  }

  /** Get currently discovered .jsh command names. */
  async getJshCommandNames(): Promise<string[]> {
    const jshMap = await this.getFilteredJshCommands();
    return [...jshMap.keys()];
  }

  /**
   * Try to run a command as a .jsh script if bash returned 127 (command not found).
   * Returns null if the command is not a .jsh file.
   */
  private async tryJshFallback(command: string): Promise<BashExecResult | null> {
    // Parse the first word as the command name
    const trimmed = command.trim();
    const firstSpace = trimmed.indexOf(' ');
    const cmdName = firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed;
    const argsStr = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';

    const jshMap = await this.getFilteredJshCommands();
    const scriptPath = jshMap.get(cmdName);
    if (!scriptPath) return null;

    const args = argsStr ? parseShellArgs(argsStr) : [];

    // Read the script source using the discovery FS (which can see paths outside the sandbox)
    const discoveryFs = this.options.jshDiscoveryFs ?? this.options.fs;
    let code: string;
    try {
      const raw = await discoveryFs.readFile(scriptPath, { encoding: 'utf-8' });
      code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      return {
        stdout: '',
        stderr: `jsh: cannot read script '${scriptPath}'\n`,
        exitCode: 127,
        env: this.lastEnv,
      };
    }

    // Execute with the SANDBOXED fs (this.vfsAdapter) — not the discovery FS
    const argv = ['node', scriptPath, ...args];
    const result = await executeJsCode(code, argv, {
      fs: this.vfsAdapter,
      cwd: this.cwd,
      env: new Map(Object.entries(this.lastEnv)),
      stdin: '',
      exec: (cmd, opts) => this.bash.exec(cmd, { env: this.lastEnv, cwd: opts?.cwd ?? this.cwd }),
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      env: this.lastEnv,
    };
  }

  /** Run a command through just-bash, carrying forward env/cwd state. */
  private async runCommand(command: string): Promise<BashExecResult> {
    // Track shell command for telemetry (extract first word as command name)
    const commandName = command.trim().split(/\s+/)[0] || 'unknown';
    trackShellCommand(commandName);

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

    // If bash returned 127 (command not found), try .jsh fallback
    if (result.exitCode === 127) {
      const jshResult = await this.tryJshFallback(command);
      if (jshResult) return jshResult;
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

    // Sync xterm theme when .theme-light class changes on <html>
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

    // Handle resize
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.terminalHost);

    // Write welcome message
    this.terminal.writeln('\x1b[1mslicc\x1b[0m \x1b[90mshell (powered by just-bash)\x1b[0m');
    this.terminal.writeln('\x1b[90mType "help" for available commands.\x1b[0m\n');

    this.showPrompt();
    this.setupInputHandler();
  }

  /** Execute a command programmatically (useful for agent integration). */
  async executeCommand(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.runCommand(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /**
   * Execute a .jsh/.bsh script file by VFS path.
   * Uses the same execution engine as JSH commands (JavaScript, not bash).
   */
  async executeScriptFile(
    scriptPath: string,
    args: string[] = []
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return executeJshFile(scriptPath, args, {
      fs: this.vfsAdapter,
      cwd: this.cwd,
      env: new Map(Object.entries(this.lastEnv)),
      stdin: '',
      exec: (cmd, opts) => this.bash.exec(cmd, { env: this.lastEnv, cwd: opts?.cwd ?? this.cwd }),
    });
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

    try {
      const result = await this.runCommand(trimmed);
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
      const msg = e instanceof Error ? e.message : String(e);
      const stderr = `Error: ${msg}\n`;
      this.writeToTerminal(stderr, true);
      return {
        stdout: '',
        stderr,
        exitCode: 1,
      };
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

  /** Dispose the terminal. */
  dispose(): void {
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
  }

  private showPrompt(): void {
    if (!this.terminal) return;
    const shortCwd = this.cwd === '/' ? '/' : (this.cwd.split('/').pop() ?? this.cwd);
    this.terminal.write(`\x1b[34m${shortCwd}\x1b[0m \x1b[90m$\x1b[0m `);
  }

  private setupInputHandler(): void {
    if (!this.terminal) return;

    this.terminal.onData((data) => {
      if (this.isExecuting) return;

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
      // Cross to end of previous line
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
          this.currentLine =
            this.currentLine.slice(0, this.cursorPos) +
            suffix +
            this.currentLine.slice(this.cursorPos);
          this.cursorPos += suffix.length;
          this.terminal.write(suffix);
        }
        // Add trailing slash for dirs, space for everything else
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
        // Multiple matches — complete common prefix, or show options
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

    // Add to history
    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
    }

    // Handle "clear"
    if (trimmed === 'clear') {
      this.clearTerminal();
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

  private async renderMediaPreview(items: MediaPreviewItem[]): Promise<void> {
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
