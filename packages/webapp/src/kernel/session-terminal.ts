/**
 * `session-terminal.ts` — the terminal of one panel session as a
 * {@link TerminalPort} (#3530): what a program leases for interactive use.
 *
 * While leased, the panel is in pty mode (`terminal-mode`): its keystrokes
 * arrive as `terminal-stdin` and go to the lease holder, resizes as
 * `terminal-resize`, and what the program writes is shown as it comes. On
 * release the panel returns to its own line editing.
 */
import type { TerminalLease, TerminalPort } from '../shell/terminal-port.js';

export interface SessionTerminalScreen {
  /** Program output, for the panel (`terminal-output`). */
  output(text: string): void;
  /** Who owns the keyboard (`terminal-mode`). */
  mode(mode: 'pty' | 'line'): void;
}

const encoder = new TextEncoder();

export class SessionTerminal implements TerminalPort {
  cols = 80;
  rows = 24;
  private held: {
    input: Array<(bytes: Uint8Array) => void>;
    resize: Array<(cols: number, rows: number) => void>;
  } | null = null;

  constructor(private readonly screen: SessionTerminalScreen) {}

  lease(): TerminalLease | null {
    if (this.held) return null;
    const held = {
      input: [] as Array<(bytes: Uint8Array) => void>,
      resize: [] as Array<(c: number, r: number) => void>,
    };
    this.held = held;
    this.screen.mode('pty');
    // Output may split a UTF-8 sequence between writes.
    const decoder = new TextDecoder();
    const terminal = this;
    let released = false;
    return {
      get cols() {
        return terminal.cols;
      },
      get rows() {
        return terminal.rows;
      },
      write: (bytes) => {
        if (!released) this.screen.output(decoder.decode(bytes, { stream: true }));
      },
      onInput: (listener) => void held.input.push(listener),
      onResize: (listener) => void held.resize.push(listener),
      release: () => {
        if (released) return;
        released = true;
        const rest = decoder.decode();
        if (rest) this.screen.output(rest);
        if (this.held === held) this.held = null;
        this.screen.mode('line');
      },
    };
  }

  /** Keystrokes from the panel (`terminal-stdin`); dropped when no program holds the terminal. */
  input(data: string): void {
    const bytes = encoder.encode(data);
    for (const listener of this.held?.input ?? []) listener(bytes);
  }

  /** The panel's size (`terminal-resize`). */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.cols = cols;
    this.rows = rows;
    for (const listener of this.held?.resize ?? []) listener(cols, rows);
  }
}
