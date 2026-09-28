import type { TerminalExecResult } from './terminal-session-client.js';

const MARK = '\x1b]7777;';
const MARKS = /\x1b\]7777;(\d+)\x07/g;

export const LOGIN_PROMPT_COMMAND = String.raw`printf '\033]7777;%s\007' "$?"`;

interface Capture {
  out: string;
  resolve: (result: TerminalExecResult) => void;
}

function commandOutput(out: string): string {
  const text = out.replace(/\r\n/g, '\n');
  const eol = text.indexOf('\n');
  return eol < 0 ? '' : text.slice(eol + 1);
}

export class LoginShellMarks {
  seen = false;

  private carry = '';
  private capture: Capture | null = null;

  filter(data: string): string {
    let text = this.carry + data;
    this.carry = '';

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

  get pending(): boolean {
    return this.capture !== null;
  }

  expect(): Promise<TerminalExecResult> {
    return new Promise((resolve) => {
      this.capture = { out: '', resolve };
    });
  }

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
