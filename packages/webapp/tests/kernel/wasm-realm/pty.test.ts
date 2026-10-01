import { describe, expect, it } from 'vitest';
import { FdTable, KernelError, type OpenFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { JobTable } from '../../../src/kernel/wasm-realm/jobs.js';
import {
  ptyIoctl,
  TIOCGPTN,
  TIOCPKT,
  TIOCSCTTY,
  TIOCSPTLCK,
  TIOCSWINSZ,
} from '../../../src/kernel/wasm-realm/process-pty.js';
import { PtyTable, ptsNumber, ptySyscall } from '../../../src/kernel/wasm-realm/pty.js';
import { SIG } from '../../../src/kernel/wasm-realm/signals.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function readAll(file: OpenFile): Promise<string> {
  const read = file.file.read;
  if (!read) throw new Error('not readable');
  return dec.decode(await read.call(file.file, 4096));
}

async function write(file: OpenFile, text: string): Promise<void> {
  await file.file.write?.(enc.encode(text));
}

describe('PtyTable / PtyPair', () => {
  it('moves bytes both ways through the slave line discipline', async () => {
    const { pair, master } = new PtyTable(() => {}).open();
    pair.locked = false;
    const slave = pair.openSlave();
    await write(master, 'ls\n');
    expect(await readAll(slave)).toBe('ls\n');
    expect(await readAll(master)).toBe('ls\r\n'); // the echo, with ONLCR
    await write(slave, 'a\nb\n');
    expect(await readAll(master)).toBe('a\r\nb\r\n');
  });

  it('refuses the slave while locked (EIO) and for a number with no pair (ENOENT)', () => {
    const ptys = new PtyTable(() => {});
    const { pair } = ptys.open();
    expect(() => pair.openSlave()).toThrow(KernelError);
    expect(() => ptys.get(7)).toThrow(/ENOENT/);
  });

  it('the master closed: the slave hears SIGHUP from its foreground and its reads end', async () => {
    const signals: number[] = [];
    const { pair, master } = new PtyTable((_tty, sig) => signals.push(sig)).open();
    pair.locked = false;
    const slave = pair.openSlave();
    const pending = readAll(slave);
    await master.release();
    expect(await pending).toBe('');
    expect(await readAll(slave)).toBe('');
    expect(signals).toEqual([SIG.HUP]);
    // Nobody reads it any more: a write fails instead of vanishing.
    await expect(write(slave, 'lost\n')).rejects.toMatchObject({ code: 'EIO' });
  });

  it("an unowned pty's signals reach nobody, never the invocation's leader", async () => {
    const jobs = new JobTable();
    const got: number[] = [];
    jobs.add(1, undefined, (sig) => got.push(sig));
    const ptys = new PtyTable((tty, sig) => jobs.signalOwnedForeground(tty, sig));
    const { pair, master } = ptys.open();
    pair.locked = false;
    pair.openSlave(); // O_NOCTTY-style: no session took it
    pair.slave.resize(100, 30);
    await master.release();
    expect(got).toEqual([]);
    // Once a session owns it, its foreground group hears them.
    const owned = ptys.open().pair;
    jobs.acquireTerminal(1, owned.slave);
    owned.slave.resize(90, 20);
    expect(got).toEqual([SIG.WINCH]);
  });

  it('the last slave descriptor closed: the master reads EIO; both closed frees the number', async () => {
    const ptys = new PtyTable(() => {});
    const { pair, master } = ptys.open();
    pair.locked = false;
    const slave = pair.openSlave();
    await write(slave, 'bye\n');
    await slave.release();
    expect(await readAll(master)).toBe('bye\r\n'); // what was written before stays readable
    await expect(readAll(master)).rejects.toMatchObject({ code: 'EIO' });
    expect(ptys.numbers()).toEqual([0]);
    await master.release();
    expect(ptys.numbers()).toEqual([]);
    expect(ptys.open().pair.index).toBe(0); // the number is reused
  });

  it('packet mode: every master read starts with TIOCPKT_DATA, within the size asked for', async () => {
    const { pair, master } = new PtyTable(() => {}).open();
    pair.locked = false;
    const slave = pair.openSlave();
    pair.packet = true;
    await write(slave, 'abc');
    const read = master.file.read as (max: number) => Promise<Uint8Array>;
    expect([...(await read.call(master.file, 3))]).toEqual([0, 97, 98]);
    expect([...(await read.call(master.file, 4096))]).toEqual([0, 99]);
    pair.packet = false;
    await write(slave, 'd');
    expect(await readAll(master)).toBe('d');
  });

  it('ptsNumber reads /dev/pts/N only', () => {
    expect(ptsNumber('/dev/pts/12')).toBe(12);
    expect(ptsNumber('/dev/pts/x')).toBeUndefined();
    expect(ptsNumber('/dev/ptmx')).toBeUndefined();
  });
});

describe('ptySyscall', () => {
  function context(pid = 10) {
    const jobs = new JobTable();
    jobs.add(pid, undefined, () => {});
    return { pid, fds: new FdTable(), ptys: new PtyTable(() => {}), jobs };
  }

  it('/dev/ptmx, TIOCGPTN, TIOCSPTLCK, then /dev/pts/N; a session leader takes it as its terminal', () => {
    const ctx = context();
    const master = (ptySyscall({ op: 'pty-open' }, ctx) as { json: number }).json;
    const n = (ptySyscall({ op: 'pty-number', fd: master }, ctx) as { json: number }).json;
    expect(n).toBe(0);
    expect(() => ptySyscall({ op: 'pty-slave-open', n, noctty: false }, ctx)).toThrow(/EIO/);
    ptySyscall({ op: 'pty-lock', fd: master, lock: false }, ctx);
    const slave = (ptySyscall({ op: 'pty-slave-open', n, noctty: false }, ctx) as { json: number })
      .json;
    expect(ctx.fds.get(slave).file.tty).toBe(ctx.ptys.get(0).slave);
    expect(ctx.ptys.get(0).slave.name).toBe('/dev/pts/0');
    expect(ctx.jobs.controllingTerminal(ctx.pid)).toBe(ctx.ptys.get(0).slave);
    // What /dev/pts holds: the numbers in use.
    expect(ptySyscall({ op: 'pty-list' }, ctx)).toMatchObject({ json: [0] });
    expect(ptySyscall({ op: 'pty-list' }, { ...ctx, ptys: undefined })).toMatchObject({ json: [] });
  });

  it('O_NOCTTY leaves the session without a terminal; TIOCSCTTY then takes it, once', () => {
    const ctx = context();
    const master = (ptySyscall({ op: 'pty-open' }, ctx) as { json: number }).json;
    ptySyscall({ op: 'pty-lock', fd: master, lock: false }, ctx);
    const slave = (
      ptySyscall({ op: 'pty-slave-open', n: 0, noctty: true }, ctx) as { json: number }
    ).json;
    expect(ctx.jobs.controllingTerminal(ctx.pid)).toBeNull();
    ptySyscall({ op: 'pty-ctty', fd: slave }, ctx);
    expect(ctx.jobs.controllingTerminal(ctx.pid)).toBe(ctx.ptys.get(0).slave);
    // The same terminal again is fine (screen's window asks after opening it without O_NOCTTY).
    expect(ptySyscall({ op: 'pty-ctty', fd: slave }, ctx)).toEqual({ ok: true, kind: 'void' });
    // It has one now: another terminal is EPERM.
    const other = (ptySyscall({ op: 'pty-open' }, ctx) as { json: number }).json;
    expect(() => ptySyscall({ op: 'pty-ctty', fd: other }, ctx)).toThrow(/EPERM/);
  });

  it('TIOCPKT sets packet mode on a master only', () => {
    const ctx = context();
    const master = (ptySyscall({ op: 'pty-open' }, ctx) as { json: number }).json;
    ptySyscall({ op: 'pty-packet', fd: master, on: true }, ctx);
    expect(ctx.ptys.get(0).packet).toBe(true);
    ptySyscall({ op: 'pty-lock', fd: master, lock: false }, ctx);
    const slave = (
      ptySyscall({ op: 'pty-slave-open', n: 0, noctty: true }, ctx) as { json: number }
    ).json;
    expect(() => ptySyscall({ op: 'pty-packet', fd: slave, on: true }, ctx)).toThrow(/ENOTTY/);
  });

  it('TIOCSWINSZ on the master or the slave resizes the slave, signalling SIGWINCH', () => {
    const signals: number[] = [];
    const ctx = { ...context(), ptys: new PtyTable((_t, sig) => signals.push(sig)) };
    const master = (ptySyscall({ op: 'pty-open' }, ctx) as { json: number }).json;
    ptySyscall({ op: 'pty-winsz-set', fd: master, rows: 40, cols: 120 }, ctx);
    expect(ctx.ptys.get(0).slave.winsize()).toEqual([40, 120]);
    expect(signals).toEqual([SIG.WINCH]);
    expect(() => ptySyscall({ op: 'pty-number', fd: 99 }, ctx)).toThrow();
  });
});

describe('ptyIoctl (an Emscripten program’s ioctl)', () => {
  function setup(kfd: number | undefined, tty = false) {
    const heap = new Int32Array(64);
    const calls: string[] = [];
    const glue = (fd: number, op: number) => {
      calls.push(`glue ${fd} ${op >>> 0}`);
      return 0;
    };
    const stream = kfd === undefined ? {} : { sliccKernelFd: kfd, ...(tty ? { tty: {} } : {}) };
    const ioctl = ptyIoctl(glue, {
      fs: () => ({ getStream: () => stream }) as never,
      heap: () => heap,
      kernel: {
        ptyNumber: (k) => {
          calls.push(`number ${k}`);
          return 3;
        },
        ptyLock: (k, lock) => void calls.push(`lock ${k} ${lock}`),
        setControllingTerminal: (k) => {
          if (k === 13) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
          calls.push(`ctty ${k}`);
        },
        setPacketMode: (k, on) => void calls.push(`packet ${k} ${on}`),
        setWinsize: (k, rows, cols) => void calls.push(`winsz ${k} ${rows}x${cols}`),
      },
    });
    // varargs at word 0 points at the argument at byte 16 (word 4).
    heap[0] = 16;
    return { heap, calls, ioctl };
  }

  it('TIOCGPTN writes the number; TIOCSPTLCK reads the lock word', () => {
    const { heap, calls, ioctl } = setup(9);
    expect(ioctl(5, TIOCGPTN | 0, 0)).toBe(0);
    expect(heap[4]).toBe(3);
    heap[4] = 0;
    expect(ioctl(5, TIOCSPTLCK, 0)).toBe(0);
    expect(calls).toEqual(['number 9', 'lock 9 false']);
  });

  it('TIOCPKT reads the mode word', () => {
    const { heap, calls, ioctl } = setup(9);
    heap[4] = 1;
    expect(ioctl(5, TIOCPKT, 0)).toBe(0);
    heap[4] = 0;
    expect(ioctl(5, TIOCPKT, 0)).toBe(0);
    expect(calls).toEqual(['packet 9 true', 'packet 9 false']);
  });

  it('TIOCSWINSZ unpacks struct winsize', () => {
    const { heap, calls, ioctl } = setup(9);
    heap[4] = 40 | (132 << 16);
    expect(ioctl(5, TIOCSWINSZ, 0)).toBe(0);
    expect(calls).toEqual(['winsz 9 40x132']);
  });

  it("leaves termios, TIOCGWINSZ (the glue's terminal hooks) and non-kernel streams to the glue", () => {
    const { calls, ioctl } = setup(9, true);
    ioctl(5, 0x5401, 0); // TCGETS
    ioctl(5, 0x5413, 0); // TIOCGWINSZ
    expect(calls).toEqual(['glue 5 21505', 'glue 5 21523']);
    const plain = setup(undefined);
    plain.ioctl(5, TIOCGPTN | 0, 0);
    expect(plain.calls).toEqual([`glue 5 ${TIOCGPTN}`]);
  });

  it("a kernel error comes back as the glue's -errno", () => {
    const { ioctl } = setup(13);
    expect(ioctl(5, TIOCSCTTY, 0)).toBeLessThan(0);
  });
});
