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
import { Bash } from 'just-bash';
import type { BashExecResult } from 'just-bash';
import { VfsAdapter } from './vfs-adapter.js';

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
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private currentLine = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private isExecuting = false;
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
    this.bash = new Bash({
      fs: this.vfsAdapter,
      cwd: initialCwd,
      env: initialEnv,
    });
    this.lastEnv = { ...initialEnv };
    this.cwd = initialCwd;
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
    this.terminal.writeln('Browser Coding Agent Shell (powered by just-bash)');
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

      for (const ch of data) {
        switch (ch) {
          case '\r': // Enter
            this.handleEnter();
            break;
          case '\x7f': // Backspace
            this.handleBackspace();
            break;
          case '\x03': // Ctrl+C
            this.handleCtrlC();
            break;
          case '\x1b[A': // Up arrow
            this.handleHistoryUp();
            break;
          case '\x1b[B': // Down arrow
            this.handleHistoryDown();
            break;
          default:
            if (ch >= ' ' || ch === '\t') {
              this.insertChar(ch);
            }
        }
      }
    });

    // Handle multi-char escape sequences
    this.terminal.onData((data) => {
      if (data === '\x1b[A') this.handleHistoryUp();
      else if (data === '\x1b[B') this.handleHistoryDown();
    });
  }

  private insertChar(ch: string): void {
    this.currentLine =
      this.currentLine.slice(0, this.cursorPos) + ch + this.currentLine.slice(this.cursorPos);
    this.cursorPos++;
    this.terminal?.write(ch);
  }

  private handleBackspace(): void {
    if (this.cursorPos > 0) {
      this.currentLine =
        this.currentLine.slice(0, this.cursorPos - 1) + this.currentLine.slice(this.cursorPos);
      this.cursorPos--;
      this.terminal?.write('\b \b');
    }
  }

  private handleCtrlC(): void {
    this.terminal?.writeln('^C');
    this.currentLine = '';
    this.cursorPos = 0;
    this.showPrompt();
  }

  private handleHistoryUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.replaceCurrentLine(this.history[this.history.length - 1 - this.historyIndex]);
    }
  }

  private handleHistoryDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.replaceCurrentLine(this.history[this.history.length - 1 - this.historyIndex]);
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.replaceCurrentLine('');
    }
  }

  private replaceCurrentLine(text: string): void {
    // Clear current line
    if (this.cursorPos > 0) {
      this.terminal?.write('\b'.repeat(this.cursorPos));
      this.terminal?.write(' '.repeat(this.currentLine.length));
      this.terminal?.write('\b'.repeat(this.currentLine.length));
    }
    this.currentLine = text;
    this.cursorPos = text.length;
    this.terminal?.write(text);
  }

  private async handleEnter(): Promise<void> {
    this.terminal?.writeln('');
    const line = this.currentLine.trim();
    this.currentLine = '';
    this.cursorPos = 0;
    this.historyIndex = -1;

    if (!line) {
      this.showPrompt();
      return;
    }

    // Add to history
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }

    // Handle "clear"
    if (line === 'clear') {
      this.terminal?.clear();
      this.showPrompt();
      return;
    }

    this.isExecuting = true;
    try {
      const result = await this.runCommand(line);
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
