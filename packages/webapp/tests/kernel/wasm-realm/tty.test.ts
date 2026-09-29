import { describe, expect, it } from 'vitest';
import { SIG } from '../../../src/kernel/wasm-realm/signals.js';
import { defaultTermios, KernelTty } from '../../../src/kernel/wasm-realm/tty.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function setup() {
  const screen: number[] = [];
  const signals: number[] = [];
  const tty = new KernelTty(
    { write: (b) => void screen.push(...b) },
    (sig) => void signals.push(sig)
  );
  const file = tty.file();
  const read = (max = 64) => file.file.read!(max);
  return { tty, file, read, screen: () => text(Uint8Array.from(screen)), signals };
}

describe('KernelTty', () => {
  it('canonical mode: edits and echoes a line, hands it over at Enter (CR becomes NL)', async () => {
    const { tty, read, screen } = setup();
    tty.receive(bytes('lx\x7fs -l\r'));
    expect(text(await read())).toBe('ls -l\n');
    expect(screen()).toBe('lx\b \bs -l\r\n');
  });

  it('kill (^U) and word erase (^W) edit the pending line', async () => {
    const { tty, read } = setup();
    tty.receive(bytes('wrong\x15echo one two\x17three\n'));
    expect(text(await read())).toBe('echo one three\n');
  });

  it('^D on an empty line is end of file; after text it hands the text over', async () => {
    const { tty, read } = setup();
    tty.receive(bytes('abc\x04'));
    expect(text(await read())).toBe('abc');
    tty.receive(bytes('\x04'));
    expect(await read()).toHaveLength(0);
  });

  it('^C, ^\\ and ^Z signal the foreground and drop the line', async () => {
    const { tty, read, screen, signals } = setup();
    tty.receive(bytes('half\x03'));
    tty.receive(bytes('\x1c\x1a'));
    expect(signals).toEqual([SIG.INT, SIG.QUIT, SIG.TSTP]);
    expect(screen()).toContain('^C');
    tty.receive(bytes('next\n'));
    expect(text(await read())).toBe('next\n');
  });

  it('a signal key drops lines typed ahead too, unless NOFLSH', async () => {
    const { tty, read } = setup();
    tty.receive(bytes('rm -rf build\n\x03'));
    tty.receive(bytes('ls\n'));
    expect(text(await read())).toBe('ls\n');
    const noflsh = tty.tcgets();
    tty.tcsets({ ...noflsh, c_lflag: noflsh.c_lflag | 0o200 });
    tty.receive(bytes('kept\n\x03'));
    expect(text(await read())).toBe('kept\n');
  });

  it('erase takes a whole UTF-8 character, and one screen cell per character', async () => {
    const { tty, read, screen } = setup();
    tty.receive(bytes('caf\u00e9\x7f\u00e8\n'));
    expect(text(await read())).toBe('caf\u00e8\n');
    expect(screen()).toBe('caf\u00e9\b \b\u00e8\r\n');
    tty.receive(bytes('x \u{1F600}\u00e9\x17y\n'));
    expect(text(await read())).toBe('x y\n');
    expect(screen().endsWith('x \u{1F600}\u00e9\b \b\b \by\r\n')).toBe(true);
    const bytewise = tty.tcgets();
    tty.tcsets({ ...bytewise, c_iflag: bytewise.c_iflag & ~0o40000 });
    tty.receive(bytes('\u00e9\x7f\n'));
    expect(Array.from(await read())).toEqual([0xc3, 0x0a]);
  });

  it('raw mode: each byte readable at once, no signals when ISIG is off', async () => {
    const { tty, read, signals } = setup();
    const raw = defaultTermios();
    raw.c_lflag = 0;
    tty.tcsets(raw);
    tty.receive(bytes('a\x03'));
    expect(text(await read())).toBe('a\x03');
    expect(signals).toEqual([]);
  });

  it('leaving canonical mode makes what was typed readable', async () => {
    const { tty, read } = setup();
    tty.receive(bytes('pending'));
    const raw = defaultTermios();
    raw.c_lflag &= ~0o2;
    tty.tcsets(raw);
    expect(text(await read())).toBe('pending');
  });

  it('output turns \\n into \\r\\n (OPOST|ONLCR), and not when OPOST is off', async () => {
    const { tty, file, screen } = setup();
    await file.file.write!(bytes('a\nb\n'));
    const raw = defaultTermios();
    raw.c_oflag = 0;
    tty.tcsets(raw);
    await file.file.write!(bytes('c\n'));
    expect(screen()).toBe('a\r\nb\r\nc\n');
  });

  it('reports its size and SIGWINCH on a resize; reads wait and can be interrupted', async () => {
    const { tty, read, signals, file } = setup();
    tty.setSize(100, 30);
    expect(tty.winsize()).toEqual([30, 100]);
    tty.resize(120, 40);
    expect(signals).toEqual([SIG.WINCH]);
    const controller = new AbortController();
    const waiting = file.file.read!(8, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'EINTR' });
    const pending = read();
    tty.receive(bytes('x\n'));
    expect(text(await pending)).toBe('x\n');
    expect(file.file.tty).toBe(tty);
    expect(tty.tcgets().c_cc[0]).toBe(0x03);
  });

  it('echo off: typed text is not shown', async () => {
    const { tty, read, screen } = setup();
    const quiet = defaultTermios();
    quiet.c_lflag &= ~0o10;
    tty.tcsets(quiet);
    tty.receive(bytes('secret\n'));
    expect(text(await read())).toBe('secret\n');
    expect(screen()).toBe('');
  });
});

describe('terminal syscalls', () => {
  it('answer for a TTY fd and refuse others (ENOTTY)', async () => {
    const { FdTable, sinkFile } = await import('../../../src/kernel/wasm-realm/fd-table.js');
    const { WasmProcess } = await import('../../../src/kernel/wasm-realm/process.js');
    const { tty, file } = setup();
    tty.setSize(90, 20);
    const fds = new FdTable();
    fds.installAt(0, file);
    fds.installAt(
      1,
      sinkFile(() => {})
    );
    const p = new WasmProcess(1, fds);
    expect(await p.syscall({ op: 'fd-info', fd: 0 })).toEqual({
      ok: true,
      kind: 'json',
      json: { tty: true, kind: 'tty' },
    });
    expect(await p.syscall({ op: 'fd-info', fd: 1 })).toMatchObject({ json: { tty: false } });
    expect(await p.syscall({ op: 'tty-winsz', fd: 0 })).toMatchObject({ json: [20, 90] });
    const raw = defaultTermios();
    raw.c_lflag = 0;
    expect(await p.syscall({ op: 'tty-set', fd: 0, termios: raw })).toEqual({
      ok: true,
      kind: 'void',
    });
    expect(await p.syscall({ op: 'tty-get', fd: 0 })).toMatchObject({ json: { c_lflag: 0 } });
    expect(await p.syscall({ op: 'tty-get', fd: 1 })).toMatchObject({ ok: false, errno: 'ENOTTY' });
  });
});
