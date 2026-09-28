/**
 * `login-shell-marks.ts` — command results from the panel's GNU bash login
 * shell (#3530).
 *
 * The login shell's `PROMPT_COMMAND` prints a private OSC mark with the last
 * status before each prompt (`LOGIN_PROMPT_COMMAND`). The view shows the
 * terminal output with the marks taken out; a programmatic command ("run in
 * terminal") typed into bash resolves at the next mark with the output in
 * between (the echoed command line dropped) and that status. A shell whose
 * rc files replace `PROMPT_COMMAND` prints no marks, and `seen` stays false.
 */
import type { TerminalExecResult } from './terminal-session-client.js';

const MARK = '\x1b]7777;';
const MARKS = /\x1b\]7777;(\d+)\x07/g;

/** What the login shell's `PROMPT_COMMAND` defaults to: the mark, with `$?`. */
export const LOGIN_PROMPT_COMMAND = String.raw`printf '\033]7777;%s\007' "$?"`;

interface Capture {
  out: string;
  resolve: (result: TerminalExecResult) => void;
}

/** The output of a typed command: everything after the terminal's echo of its line. */
function commandOutput(out: string): string {
  const text = out.replace(/\r\n/g, '\n');
  const eol = text.indexOf('\n');
  return eol < 0 ? '' : text.slice(eol + 1);
}

export class LoginShellMarks {
  /** Whether the shell prints marks (a first prompt came with one). */
  seen = false;
  /** A mark cut off at the end of a chunk, completed by the next. */
  private carry = '';
  private capture: Capture | null = null;

  /** Terminal output from the login shell, minus the marks; a mark ends a pending capture. */
  filter(data: string): string {
    let text = this.carry + data;
    this.carry = '';
    // A mark the chunk ends inside of: its start, or all but its end.
    const open = text.lastIndexOf('\x1b');
    const tail = open < 0 ? '' : text.slice(open);
    if (tail && (MARK.startsWith(tail) || (tail.startsWith(MARK) && !tail.includes('\x07')))) {
      this.carry = tail;
      text = text.slice(0, open);
    }
    let shown = '';
    let from = 0;
    for (const mark of text.matchAll(MARKS)) {
      const before = text.slice(from, mark.index);
      shown += before;
      this.settle(before, Number(mark[1]));
      this.seen = true;
      from = mark.index + mark[0].length;
    }
    const rest = text.slice(from);
    if (this.capture) this.capture.out += rest;
    return shown + rest;
  }

  /** Whether a typed command's result is still being collected. */
  get pending(): boolean {
    return this.capture !== null;
  }

  /** The result of the command about to be typed: its output up to the next mark. */
  expect(): Promise<TerminalExecResult> {
    return new Promise((resolve) => {
      this.capture = { out: '', resolve };
    });
  }

  /** The shell is gone: a pending capture ends with what it has. */
  end(): void {
    this.settle('', 1);
    this.seen = false;
    this.carry = '';
  }

  private settle(before: string, status: number): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    capture.resolve({ stdout: commandOutput(capture.out + before), stderr: '', exitCode: status });
  }
}
