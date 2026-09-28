/**
 * `terminal-port.ts` — the panel's terminal, lent to one program at a time
 * for interactive use (#3530).
 *
 * The panel terminal normally edits lines itself and runs each committed
 * line as a command. A program that wants the terminal (`wasm -t bash`)
 * leases it: while the lease is held, every keystroke goes to the program
 * as raw input, its output reaches the screen as it is written, and resizes
 * are reported — a pty, with the kernel's TTY (`kernel/wasm-realm/tty.ts`)
 * doing the line discipline.
 */

export interface TerminalLease {
  /** The terminal's size now. */
  readonly cols: number;
  readonly rows: number;
  /** To the screen, as written. */
  write(bytes: Uint8Array): void;
  /** Keystrokes, raw (UTF-8), as they arrive. */
  onInput(listener: (bytes: Uint8Array) => void): void;
  onResize(listener: (cols: number, rows: number) => void): void;
  /** Give the terminal back to the line editor. */
  release(): void;
}

export interface TerminalPort {
  /** Take the terminal; null while another program holds it (or none is attached). */
  lease(): TerminalLease | null;
}
