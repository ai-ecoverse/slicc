/** A prompt editor for a VT terminal. Command history stays in this session only. */
export interface TerminalLineDisplay {
  write(data: string): void;
  getCursor(): { row: number; col: number };
  getScrollbackCount(): number;
}

const MAX_HISTORY = 500;

export class TerminalLineEditor {
  private line: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private prompt = '';
  private anchorRow = 0;
  private resolve: ((line: string) => void) | null = null;
  private reject: ((reason: unknown) => void) | null = null;

  constructor(private readonly display: TerminalLineDisplay) {}

  get isReading(): boolean {
    return this.resolve !== null;
  }

  get text(): string {
    return this.line.join('');
  }

  get beforeCursor(): string {
    return this.line.slice(0, this.cursor).join('');
  }

  read(prompt: string): Promise<string> {
    if (this.isReading) throw new Error('terminal already reading');
    // A command may have ended without a newline. Keep its last bytes visible
    // and mark the missing terminator before starting the next prompt.
    if (this.display.getCursor().col > 0) this.display.write('\x1b[7m%\x1b[0m\r\n');
    this.prompt = prompt;
    this.line = [];
    this.cursor = 0;
    this.historyIndex = this.history.length;
    this.draft = '';
    this.anchorRow = this.display.getCursor().row;
    this.display.write(prompt);
    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  abort(reason: unknown): void {
    this.reject?.(reason);
    this.resolve = null;
    this.reject = null;
  }

  setLine(text: string): void {
    if (!this.isReading) return;
    this.line = [...text];
    this.cursor = this.line.length;
    this.redraw();
  }

  insert(text: string): void {
    if (!this.isReading || !text) return;
    const chars = [...text.replace(/[\r\n\x1b]/g, '')];
    this.line.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    this.redraw();
  }

  /** List ambiguous completions and redraw the active prompt below them. */
  list(matches: string[]): void {
    if (!this.isReading) return;
    this.cursor = this.line.length;
    this.redraw();
    this.display.write(`\r\n${matches.join('  ')}\r\n`);
    this.anchorRow = this.display.getCursor().row;
    this.redraw();
  }

  accept(): void {
    if (!this.resolve) return;
    this.cursor = this.line.length;
    this.redraw();
    const text = this.text;
    this.display.write('\r\n');
    if (text.trim() && this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    const resolve = this.resolve;
    this.resolve = null;
    this.reject = null;
    resolve(text);
  }

  /** Ctrl+C at a prompt abandons the line without sending a worker signal. */
  cancel(): void {
    if (!this.resolve) return;
    this.cursor = this.line.length;
    this.redraw();
    this.display.write('^C\r\n');
    const resolve = this.resolve;
    this.resolve = null;
    this.reject = null;
    resolve('');
  }

  feed(data: string): void {
    if (!this.isReading) return;
    switch (data) {
      case '\r':
      case '\n':
        this.accept();
        return;
      case '\x03':
        this.cancel();
        return;
      case '\x7f':
      case '\b':
        if (this.cursor > 0) {
          this.line.splice(--this.cursor, 1);
          this.redraw();
        }
        return;
      case '\x1b[3~':
        if (this.cursor < this.line.length) {
          this.line.splice(this.cursor, 1);
          this.redraw();
        }
        return;
      case '\x1b[D':
      case '\x1bOD':
        this.cursor = Math.max(0, this.cursor - 1);
        this.redraw();
        return;
      case '\x1b[C':
      case '\x1bOC':
        this.cursor = Math.min(this.line.length, this.cursor + 1);
        this.redraw();
        return;
      case '\x1b[H':
      case '\x1bOH':
      case '\x01':
        this.cursor = 0;
        this.redraw();
        return;
      case '\x1b[F':
      case '\x1bOF':
      case '\x05':
        this.cursor = this.line.length;
        this.redraw();
        return;
      case '\x1b[A':
      case '\x1bOA':
        this.navigate(-1);
        return;
      case '\x1b[B':
      case '\x1bOB':
        this.navigate(1);
        return;
      case '\x15': // Ctrl+U
        this.line.splice(0, this.cursor);
        this.cursor = 0;
        this.redraw();
        return;
      case '\x0b': // Ctrl+K
        this.line.splice(this.cursor);
        this.redraw();
        return;
      case '\x17': {
        // Ctrl+W
        let start = this.cursor;
        while (start > 0 && /\s/.test(this.line[start - 1] ?? '')) start--;
        while (start > 0 && !/\s/.test(this.line[start - 1] ?? '')) start--;
        this.line.splice(start, this.cursor - start);
        this.cursor = start;
        this.redraw();
        return;
      }
      default:
        // wterm sends pasted text as one chunk. Keep pasted newlines on one
        // editable line so a paste cannot execute extra commands implicitly.
        if (!data.includes('\x1b') && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data)) {
          this.insert(data.replace(/[\r\n\t]+/g, ' '));
        }
    }
  }

  private navigate(direction: -1 | 1): void {
    if (direction < 0 && this.historyIndex === 0) return;
    if (direction > 0 && this.historyIndex === this.history.length) return;
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex += direction;
    this.line = [...(this.history[this.historyIndex] ?? this.draft)];
    this.cursor = this.line.length;
    this.redraw();
  }

  private redraw(): void {
    const { row } = this.display.getCursor();
    const scrollback = this.display.getScrollbackCount();
    const up = row - this.anchorRow;
    if (up > 0) this.display.write(`\x1b[${up}A`);
    this.display.write('\r\x1b[0J');
    this.display.write(this.prompt + this.beforeCursor);
    // DECSC/DECRC let Ghostty place the cursor using its own Unicode cell
    // widths, including wide and combining characters, after drawing suffix.
    this.display.write('\x1b7');
    this.display.write(this.line.slice(this.cursor).join(''));
    this.display.write('\x1b8');
    // Account for lines actually pushed into scrollback. Ghostty computes
    // cell widths, so this remains correct for wide and combining glyphs.
    this.anchorRow = Math.max(0, this.anchorRow - (this.display.getScrollbackCount() - scrollback));
  }
}
