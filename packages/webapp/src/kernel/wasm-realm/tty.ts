/**
 * `tty.ts` — a terminal as a kernel device for wasm-realm processes (#3530).
 *
 * The terminal panel sends raw keystrokes ({@link KernelTty.receive}) and
 * shows what the device writes ({@link TtyScreen.write}). Between them sits
 * the line discipline, as in a Unix kernel, driven by the program's termios:
 *
 * - canonical mode (ICANON): the line is edited here — erase, kill, word
 *   erase — echoed (ECHO) and handed to a read only once it ends (newline,
 *   or EOF from ^D);
 * - raw mode: every byte is readable at once (VMIN 1), so an editor or a
 *   shell with its own line editing sees each key;
 * - ISIG: ^C, ^\ and ^Z become SIGINT, SIGQUIT and SIGTSTP for the
 *   foreground processes, and a resize becomes SIGWINCH;
 * - output: OPOST/ONLCR turn `\n` into `\r\n`.
 */
import { KernelError, OpenFile, type PollState } from './fd-table.js';
import { SIG } from './signals.js';

/** termios as Emscripten's TTY ioctls exchange it. */
export interface Termios {
  c_iflag: number;
  c_oflag: number;
  c_cflag: number;
  c_lflag: number;
  c_cc: number[];
}

/** The terminal on the other side: the panel. */
export interface TtyScreen {
  write(bytes: Uint8Array): void;
}

// musl's termios bits and c_cc slots (Linux's).
const ICRNL = 0o400;
const IUTF8 = 0o40000;
const OPOST = 0o1;
const ONLCR = 0o4;
const ISIG = 0o1;
const ICANON = 0o2;
const ECHO = 0o10;
const ECHOE = 0o20;
const ECHOCTL = 0o1000;
const NOFLSH = 0o200;
const IEXTEN = 0o100000;
const VINTR = 0;
const VQUIT = 1;
const VERASE = 2;
const VKILL = 3;
const VEOF = 4;
const VSUSP = 10;
const VWERASE = 14;

/** The settings a fresh terminal starts with (Emscripten's `ioctl_tcgets` default). */
export function defaultTermios(): Termios {
  const cCc = new Array<number>(32).fill(0);
  Object.assign(cCc, { [VINTR]: 0x03, [VQUIT]: 0x1c, [VERASE]: 0x7f, [VKILL]: 0x15 });
  Object.assign(cCc, { [VEOF]: 0x04, 6: 1, 8: 0x11, 9: 0x13, [VSUSP]: 0x1a });
  Object.assign(cCc, { 12: 0x12, 13: 0x0f, [VWERASE]: 0x17, 15: 0x16 });
  return {
    c_iflag: ICRNL | 0o2000 /* IXON */ | 0o20000 /* IMAXBEL */ | IUTF8,
    c_oflag: OPOST | ONLCR,
    c_cflag: 0o17 /* B38400 */ | 0o60 /* CS8 */ | 0o200 /* CREAD */,
    c_lflag:
      ISIG | ICANON | ECHO | ECHOE | 0o40 /* ECHOK */ | ECHOCTL | 0o4000 /* ECHOKE */ | IEXTEN,
    c_cc: cCc,
  };
}

const encoder = new TextEncoder();

/** A UTF-8 continuation byte (10xxxxxx). */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export class KernelTty {
  private termios = defaultTermios();
  private cols = 80;
  private rows = 24;
  /** Bytes a read can take; `null` marks an end of file (^D on an empty line). */
  private readable: Array<Uint8Array | null> = [];
  /** The line being edited (canonical mode). */
  private line: number[] = [];
  private waiters: Array<() => void> = [];
  /** The terminal went away (a pseudo-terminal's master closed): reads end. */
  private hungUp = false;

  /**
   * @param screen where output (and echo) goes
   * @param signal a signal for the foreground processes (^C, ^Z, a resize)
   */
  constructor(
    private readonly screen: TtyScreen,
    private readonly signal: (sig: number) => void
  ) {}

  /** Keystrokes from the terminal. */
  receive(bytes: Uint8Array): void {
    for (const byte of bytes) this.key(byte);
    this.wake();
  }

  resize(cols: number, rows: number): void {
    this.setSize(cols, rows);
    this.signal(SIG.WINCH);
  }

  /** The terminal is gone (a pseudo-terminal's master closed): every read, now or later, ends. */
  hangup(): void {
    this.hungUp = true;
    this.wake();
  }

  /** SIGHUP for the foreground processes (the terminal hung up). */
  signalHangup(): void {
    this.signal(SIG.HUP);
  }

  /** The size, without SIGWINCH (the terminal a program starts on). */
  setSize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  tcgets(): Termios {
    return { ...this.termios, c_cc: [...this.termios.c_cc] };
  }

  tcsets(termios: Termios): void {
    const wasCanonical = this.canonical;
    this.termios = { ...termios, c_cc: [...termios.c_cc] };
    // Leaving canonical mode: what was typed so far becomes readable as is.
    if (wasCanonical && !this.canonical && this.line.length > 0) {
      this.readable.push(Uint8Array.from(this.line));
      this.line = [];
      this.wake();
    }
  }

  /** `[rows, cols]`, as TIOCGWINSZ reports it. */
  winsize(): [number, number] {
    return [this.rows, this.cols];
  }

  /** The device as an open file description (fds 0-2 share one). */
  file(): OpenFile {
    return new OpenFile({
      read: (max, signal) => this.read(max, signal),
      write: async (bytes) => {
        this.output(bytes);
        return bytes.length;
      },
      poll: (): PollState => ({
        readable: this.readable.length > 0 || this.hungUp,
        writable: true,
        hangup: this.hungUp,
      }),
      changed: (signal) => this.changed(signal),
      close: () => {},
      tty: this,
    });
  }

  private get canonical(): boolean {
    return (this.termios.c_lflag & ICANON) !== 0;
  }

  private cc(slot: number): number {
    return this.termios.c_cc[slot] ?? 0;
  }

  private key(input: number): void {
    const { c_iflag, c_lflag } = this.termios;
    const byte = input === 0x0d && c_iflag & ICRNL ? 0x0a : input;
    if (c_lflag & ISIG && this.signalKey(byte)) return;
    if (!this.canonical) {
      this.readable.push(Uint8Array.of(byte));
      if (c_lflag & ECHO) this.echo(byte);
      return;
    }
    this.edit(byte);
  }

  /**
   * ^C / ^\ / ^Z: the foreground processes are signalled, and the input not
   * yet read — the line being edited and any lines typed ahead — is dropped
   * (unless NOFLSH), so a command typed before ^C does not run after it.
   */
  private signalKey(byte: number): boolean {
    const sig =
      byte === this.cc(VINTR)
        ? SIG.INT
        : byte === this.cc(VQUIT)
          ? SIG.QUIT
          : byte === this.cc(VSUSP)
            ? SIG.TSTP
            : 0;
    if (!sig || byte === 0) return false;
    if (this.termios.c_lflag & ECHO) this.echo(byte);
    if (!(this.termios.c_lflag & NOFLSH)) {
      this.line = [];
      this.readable = [];
    }
    this.signal(sig);
    return true;
  }

  /** Canonical-mode editing. */
  private edit(byte: number): void {
    const echo = (this.termios.c_lflag & ECHO) !== 0;
    if (byte === this.cc(VERASE) || byte === 0x08) {
      this.rubOut(this.lastCharLength());
    } else if (byte === this.cc(VKILL)) {
      this.rubOut(this.line.length);
    } else if (byte === this.cc(VWERASE)) {
      this.rubOut(this.lastWordLength());
    } else if (byte === this.cc(VEOF)) {
      // ^D: the line so far without a newline; on an empty line, end of file.
      this.readable.push(this.line.length > 0 ? Uint8Array.from(this.line) : null);
      this.line = [];
    } else if (byte === 0x0a) {
      this.line.push(byte);
      if (echo) this.output(encoder.encode('\n'));
      this.readable.push(Uint8Array.from(this.line));
      this.line = [];
    } else {
      this.line.push(byte);
      if (echo) this.echo(byte);
    }
  }

  /** The trailing word of the line, with the blanks after it (what ^W erases). */
  private lastWordLength(): number {
    let end = this.line.length;
    while (end > 0 && this.line[end - 1] === 0x20) end--;
    while (end > 0 && this.line[end - 1] !== 0x20) end--;
    return this.line.length - end;
  }

  /** Bytes of the line's last character: its whole UTF-8 sequence with IUTF8. */
  private lastCharLength(): number {
    const { line } = this;
    let n = Math.min(1, line.length);
    if (this.termios.c_iflag & IUTF8) {
      while (n < line.length && isContinuation(line[line.length - n] ?? 0)) n++;
    }
    return n;
  }

  /** Drop the last `n` bytes of the line, and their characters from the screen when echoing. */
  private rubOut(n: number): void {
    const dropped = this.line.splice(this.line.length - n, n);
    const utf8 = (this.termios.c_iflag & IUTF8) !== 0;
    const cells = utf8 ? dropped.filter((b) => !isContinuation(b)).length : dropped.length;
    if (cells > 0 && this.termios.c_lflag & ECHO) {
      this.output(encoder.encode('\b \b'.repeat(cells)), false);
    }
  }

  /** Echo one byte: a control character as `^X` (ECHOCTL). */
  private echo(byte: number): void {
    if (byte < 0x20 && byte !== 0x0a && byte !== 0x09 && this.termios.c_lflag & ECHOCTL) {
      this.output(Uint8Array.of(0x5e, byte + 0x40), false);
      return;
    }
    this.output(Uint8Array.of(byte));
  }

  /** To the screen, with `\n` → `\r\n` when OPOST|ONLCR. */
  private output(bytes: Uint8Array, translate = true): void {
    const { c_oflag } = this.termios;
    if (!translate || !(c_oflag & OPOST && c_oflag & ONLCR) || !bytes.includes(0x0a)) {
      this.screen.write(bytes);
      return;
    }
    const out: number[] = [];
    for (const byte of bytes) {
      if (byte === 0x0a) out.push(0x0d);
      out.push(byte);
    }
    this.screen.write(Uint8Array.from(out));
  }

  private async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (this.readable.length === 0) {
      if (this.hungUp) return new Uint8Array(0);
      await this.changed(signal);
    }
    const head = this.readable[0];
    if (head === null) {
      this.readable.shift();
      return new Uint8Array(0);
    }
    if (head === undefined) return new Uint8Array(0);
    // Canonical: at most one line per read; raw: whatever is queued.
    const chunks: Uint8Array[] = [];
    let n = 0;
    while (this.readable.length > 0 && n < max) {
      const next = this.readable[0];
      if (next === null || next === undefined) break;
      const take = next.subarray(0, max - n);
      chunks.push(take);
      n += take.length;
      if (take.length < next.length) this.readable[0] = next.subarray(take.length);
      else this.readable.shift();
      if (this.canonical) break;
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new KernelError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
