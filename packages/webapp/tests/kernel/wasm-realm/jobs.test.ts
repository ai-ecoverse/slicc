import { describe, expect, it, vi } from 'vitest';
import {
  type ChildStateListener,
  ChildTable,
  CONTINUED_STATUS,
  stoppedStatus,
} from '../../../src/kernel/wasm-realm/children.js';
import { FdTable, openPipe } from '../../../src/kernel/wasm-realm/fd-table.js';
import { JobTable } from '../../../src/kernel/wasm-realm/jobs.js';
import { type StateListener, WasmProcess } from '../../../src/kernel/wasm-realm/process.js';
import { SIG, sigbit } from '../../../src/kernel/wasm-realm/signals.js';
import { KernelTty } from '../../../src/kernel/wasm-realm/tty.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('JobTable', () => {
  function table() {
    const jobs = new JobTable();
    const got: Array<[number, number]> = [];
    const add = (pid: number, parent?: number) =>
      jobs.add(pid, parent, (sig) => got.push([pid, sig]));
    return { jobs, got, add };
  }

  it('starts a process in its parent’s group and session, or leading its own', () => {
    const { jobs, add } = table();
    add(10);
    add(11, 10);
    add(12, 99); // a parent outside the table: its own session
    expect([jobs.getpgid(11, 0), jobs.getsid(11, 0)]).toEqual([10, 10]);
    expect([jobs.getpgid(10, 12), jobs.getsid(10, 12)]).toEqual([12, 12]);
    expect(() => jobs.getpgid(10, 55)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('setpgid: a new group, joining one of the same session; never a session leader', () => {
    const { jobs, add } = table();
    add(10);
    add(11, 10);
    add(12, 10);
    jobs.setpgid(11, 0, 0);
    expect(jobs.getpgid(10, 11)).toBe(11);
    jobs.setpgid(10, 12, 11); // the parent puts its child into the job
    expect(jobs.getpgid(10, 12)).toBe(11);
    expect(() => jobs.setpgid(10, 0, 0)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(() => jobs.setpgid(11, 0, 77)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(() => jobs.setpgid(11, 0, -1)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
    add(20);
    add(21, 20);
    expect(() => jobs.setpgid(10, 21, 10)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('setpgid moves only the caller or a child of it that has not exec’d', () => {
    const { jobs, add } = table();
    add(10);
    add(11, 10);
    add(12, 10);
    // A sibling is out of reach.
    expect(() => jobs.setpgid(11, 12, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    add(13, 11);
    jobs.exec(11, 13); // 11 exec'd a program: its parent may no longer move it
    expect(() => jobs.setpgid(10, 11, 0)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    jobs.setpgid(11, 0, 0); // it may still move itself
    expect(jobs.pgidOf(11)).toBe(11);
    expect(jobs.pgidOf(99)).toBeUndefined();
  });

  it('a session controls the terminal its leader started on; setsid leaves it behind', () => {
    const jobs = new JobTable();
    const tty = new KernelTty({ write: () => {} }, () => {});
    const other = new KernelTty({ write: () => {} }, () => {});
    jobs.add(10, undefined, () => {}, tty);
    jobs.add(11, 10, () => {}, other); // a child takes its session's, whatever it runs on
    jobs.add(12, 11, () => {});
    jobs.add(20, undefined, () => {}); // a session without one
    expect(jobs.controllingTerminal(11)).toBe(tty);
    expect(jobs.controllingTerminal(12)).toBe(tty);
    expect(jobs.controllingTerminal(20)).toBeNull();
    expect(jobs.controllingTerminal(99)).toBeUndefined(); // no process of the table
    jobs.setsid(12);
    expect(jobs.controllingTerminal(12)).toBeNull();
    expect(jobs.controllingTerminal(11)).toBe(tty);
  });

  it('setsid: a new session, not for a group leader', () => {
    const { jobs, add } = table();
    add(10);
    add(11, 10);
    expect(() => jobs.setsid(10)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(jobs.setsid(11)).toBe(11);
    expect([jobs.getpgid(11, 0), jobs.getsid(11, 0)]).toEqual([11, 11]);
  });

  it('signals a group once per process: an exec’d program hears it through its exec parent', () => {
    const { jobs, got, add } = table();
    add(10);
    add(11, 10);
    add(12, 11);
    jobs.exec(11, 12);
    expect(jobs.killGroup(10, SIG.INT)).toBe(true);
    expect(got).toEqual([
      [10, SIG.INT],
      [11, SIG.INT],
    ]);
    expect(jobs.killGroup(10, 0)).toBe(true); // an existence probe signals nobody
    expect(got).toHaveLength(2);
    expect(jobs.killGroup(55, SIG.INT)).toBe(false);
    jobs.remove(11);
    jobs.killGroup(10, SIG.TERM); // its exec parent gone: the program hears it itself
    expect(got.slice(2)).toEqual([
      [10, SIG.TERM],
      [12, SIG.TERM],
    ]);
  });

  it('the terminal’s foreground group gets its signals; only a group of the session may take it', () => {
    const { jobs, got, add } = table();
    const tty = new KernelTty({ write: () => {} }, () => {});
    add(10);
    add(11, 10);
    jobs.setpgid(11, 0, 0);
    expect(jobs.tcgetpgrp(tty, 10)).toBe(10);
    jobs.signalForeground(tty, 10, SIG.INT);
    expect(got).toEqual([[10, SIG.INT]]); // 11 left for its own group
    jobs.tcsetpgrp(10, tty, 11);
    jobs.signalForeground(tty, 10, SIG.TSTP);
    expect(got.at(-1)).toEqual([11, SIG.TSTP]);
    expect(() => jobs.tcsetpgrp(10, tty, 99)).toThrow(expect.objectContaining({ code: 'EPERM' }));
  });
});

describe('ChildTable stop reports', () => {
  function withChild() {
    let listener!: ChildStateListener;
    let end!: (code: number) => void;
    const spawner = async () => ({
      pid: 7,
      exited: new Promise<number>((resolve) => (end = resolve)),
      onState: (l: ChildStateListener) => (listener = l),
    });
    const children = new ChildTable(new FdTable(), spawner);
    const onChildState = vi.fn();
    children.onChildState = onChildState;
    return { children, onChildState, state: () => listener, end: (c: number) => end(c) };
  }

  it('WUNTRACED reports a stop once; WCONTINUED a continue; the child stays waitable', async () => {
    const c = withChild();
    await c.children.spawn({ file: 'x', argv: ['x'], env: {}, cwd: '/' }, []);
    const waiting = c.children.wait(-1, false, undefined, { untraced: true });
    c.state()('stopped', SIG.TSTP);
    expect(await waiting).toEqual([7, stoppedStatus(SIG.TSTP)]);
    expect(c.onChildState).toHaveBeenCalledTimes(1); // the parent's SIGCHLD
    expect(await c.children.wait(-1, true, undefined, { untraced: true })).toEqual([0, 0]);
    c.state()('continued', SIG.CONT);
    expect(await c.children.wait(7, true)).toEqual([0, 0]); // not asked for
    expect(await c.children.wait(7, true, undefined, { continued: true })).toEqual([
      7,
      CONTINUED_STATUS,
    ]);
    c.end(3);
    expect(await c.children.wait(7, false, undefined, { untraced: true })).toEqual([7, 3 << 8]);
  });

  it('a plain wait ignores stops', async () => {
    const c = withChild();
    await c.children.spawn({ file: 'x', argv: ['x'], env: {}, cwd: '/' }, []);
    const waiting = c.children.wait(-1, false);
    c.state()('stopped', SIG.STOP);
    await tick();
    c.end(0);
    expect(await waiting).toEqual([7, 0]);
  });

  it('watch() follows one child until it exits', async () => {
    const c = withChild();
    await c.children.spawn({ file: 'x', argv: ['x'], env: {}, cwd: '/' }, []);
    const seen = vi.fn();
    c.children.watch(7, seen);
    c.children.watch(99, seen); // no such child: nothing to follow
    c.state()('stopped', SIG.TTIN);
    expect(seen).toHaveBeenCalledWith('stopped', SIG.TTIN);
    c.end(0);
    await tick();
    c.state()('continued', SIG.CONT);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('WasmProcess stop and continue', () => {
  it('SIGTSTP stops it: its syscalls wait for SIGCONT; the parent hears both', async () => {
    const p = new WasmProcess(5, new FdTable());
    const states: Array<[string, number]> = [];
    const listener: StateListener = (state, sig) => states.push([state, sig]);
    p.onState(listener);
    expect(p.signal(SIG.TSTP)).toBe('stop');
    expect(p.signal(SIG.TSTP)).toBe('stop'); // already stopped: no second report
    let done = false;
    const call = p.syscall({ op: 'proc-getpgid', pid: 0 }).then((r) => {
      done = true;
      return r;
    });
    await tick();
    expect(done).toBe(false);
    expect(p.signal(SIG.CONT)).toBe('continue');
    expect(await call).toEqual({ ok: true, kind: 'json', json: 5 });
    expect(states).toEqual([
      ['stopped', SIG.TSTP],
      ['continued', SIG.CONT],
    ]);
    expect(p.signal(SIG.CONT)).toBe('continue'); // running: nothing to report
    expect(states).toHaveLength(2);
  });

  it('SIGSTOP cannot be caught or ignored; a caught SIGTSTP runs its handler instead', async () => {
    const p = new WasmProcess(5, new FdTable(), { onPending: () => {} });
    await p.syscall({ op: 'sig-mask', caught: sigbit(SIG.STOP) | sigbit(SIG.TSTP), ignored: 0 });
    expect(p.signal(SIG.TSTP)).toBe('deliver');
    expect(p.signal(SIG.STOP)).toBe('stop');
    expect(p.signal(SIG.CONT)).toBe('continue');
  });

  it('a stop interrupts a blocked read, which runs again once continued', async () => {
    const fds = new FdTable();
    const pipe = openPipe();
    fds.installAt(0, pipe.read);
    fds.installAt(1, pipe.write);
    const p = new WasmProcess(5, fds);
    const reading = p.syscall({ op: 'fd-read', fd: 0, max: 8 });
    await tick();
    p.signal(SIG.TSTP);
    await tick();
    // Written while it is stopped: the read, restarted after SIGCONT, takes it.
    await pipe.write.file.write?.(bytes('hi'));
    p.signal(SIG.CONT);
    expect(await reading).toEqual({ ok: true, kind: 'bytes', bytes: bytes('hi') });
  });

  it('mirrors the stops of the program it exec’d', async () => {
    let listener!: ChildStateListener;
    let end!: (code: number) => void;
    const spawner = async () => ({
      pid: 40,
      exited: new Promise<number>((resolve) => (end = resolve)),
      onState: (l: ChildStateListener) => (listener = l),
    });
    const jobs = new JobTable();
    jobs.add(5, undefined, () => {});
    jobs.add(40, 5, () => {});
    const p = new WasmProcess(5, new FdTable(), { spawner, kill: () => true, jobs });
    const states: string[] = [];
    p.onState((state) => states.push(state));
    await p.syscall({ op: 'proc-spawn', file: 'x', argv: ['x'], env: {}, cwd: '/', stdio: [] });
    const execing = p.syscall({ op: 'proc-exec', pid: 40 });
    await tick();
    listener('stopped', SIG.TSTP);
    listener('continued', SIG.CONT);
    end(0);
    expect(await execing).toMatchObject({ ok: true });
    expect(states).toEqual(['stopped', 'continued']);
  });
});

describe('WasmProcess /dev/tty and exec', () => {
  it("opens its session's controlling terminal, off its stdio too; ENXIO without one", async () => {
    const jobs = new JobTable();
    const out: string[] = [];
    const tty = new KernelTty({ write: (b) => out.push(new TextDecoder().decode(b)) }, () => {});
    jobs.add(5, undefined, () => {}, tty);
    jobs.add(6, 5, () => {});
    const p = new WasmProcess(6, new FdTable(), { jobs });
    const opened = await p.syscall({ op: 'fd-open-tty' });
    expect(opened).toEqual({ ok: true, kind: 'json', json: 3 });
    expect(await p.syscall({ op: 'fd-info', fd: 3 })).toMatchObject({ json: { tty: true } });
    await p.syscall({ op: 'fd-write', fd: 3, body: bytes('hi') });
    expect(out.join('')).toBe('hi');
    jobs.setsid(6);
    expect(await p.syscall({ op: 'fd-open-tty' })).toMatchObject({ ok: false, errno: 'ENXIO' });
  });

  it('without a job table, /dev/tty is the terminal its stdio is on, if any', async () => {
    const tty = new KernelTty({ write: () => {} }, () => {});
    const onTty = new FdTable();
    onTty.installAt(2, tty.file());
    const p = new WasmProcess(7, onTty);
    expect(await p.syscall({ op: 'fd-open-tty' })).toMatchObject({ ok: true, json: 3 });
    const none = new WasmProcess(8, new FdTable());
    expect(await none.syscall({ op: 'fd-open-tty' })).toMatchObject({ ok: false, errno: 'ENXIO' });
  });

  it('an exec releases the old image’s descriptors while the program runs', async () => {
    let end!: (code: number) => void;
    const spawner = async (_req: unknown, fds: FdTable) => {
      await fds.closeAll(); // the program took what it inherited
      return { pid: 40, exited: new Promise<number>((resolve) => (end = resolve)) };
    };
    const { read, write } = openPipe();
    const fds = new FdTable();
    fds.installAt(3, write); // a close-on-exec pipe to its parent
    const p = new WasmProcess(5, fds, { spawner });
    await p.syscall({ op: 'proc-spawn', file: 'x', argv: ['x'], env: {}, cwd: '/', stdio: [] });
    const execing = p.syscall({ op: 'proc-exec', pid: 40 });
    // The parent sees EOF now, not when the program ends.
    expect(await read.file.read?.(8)).toHaveLength(0);
    end(0);
    expect(await execing).toMatchObject({ ok: true, json: [40, 0] });
  });
});

describe('waitpid by process group', () => {
  it('waits for the caller’s group (0), a named group (-pgid), or any child (-1)', async () => {
    const jobs = new JobTable();
    const ends = new Map<number, (code: number) => void>();
    let next = 20;
    const spawner = async () => {
      const pid = next++;
      jobs.add(pid, 10, () => {});
      return { pid, exited: new Promise<number>((resolve) => ends.set(pid, resolve)) };
    };
    jobs.add(10, undefined, () => {});
    const p = new WasmProcess(10, new FdTable(), { spawner, jobs });
    const spawn = () =>
      p.syscall({ op: 'proc-spawn', file: 'x', argv: ['x'], env: {}, cwd: '/', stdio: [] });
    await spawn(); // 20, in 10's group
    await spawn(); // 21, moved into a job of its own
    jobs.setpgid(10, 21, 0);
    ends.get(21)!(4);
    await tick();
    // The background job's exit is not the caller's group's business.
    expect(await p.syscall({ op: 'proc-wait', pid: 0, nohang: true })).toMatchObject({
      json: [0, 0],
    });
    expect(await p.syscall({ op: 'proc-wait', pid: -21, nohang: true })).toMatchObject({
      json: [21, 4 << 8],
    });
    expect(await p.syscall({ op: 'proc-wait', pid: -21, nohang: true })).toMatchObject({
      errno: 'ECHILD',
    });
    ends.get(20)!(0);
    await tick();
    expect(await p.syscall({ op: 'proc-wait', pid: -1, nohang: true })).toMatchObject({
      json: [20, 0],
    });
  });
});

describe('WasmProcess job syscalls', () => {
  function session() {
    const jobs = new JobTable();
    const signals: Array<[number, number]> = [];
    const kill = vi.fn((pid: number, sig: number) => (pid < 0 ? jobs.killGroup(-pid, sig) : true));
    const tty = new KernelTty({ write: () => {} }, () => {});
    const make = (pid: number, parent?: number) => {
      const fds = new FdTable();
      const file = tty.file();
      fds.installAt(0, file);
      fds.installAt(1, openPipe().read);
      const p = new WasmProcess(pid, fds, { jobs, kill, onPending: () => {} });
      // A leader started on the terminal makes it its session's (launch.ts).
      const terminal = parent === undefined ? tty : undefined;
      jobs.add(
        pid,
        parent,
        (sig) => {
          signals.push([pid, sig]);
          p.signal(sig);
        },
        terminal
      );
      return p;
    };
    return { jobs, signals, kill, tty, make };
  }

  it('setpgid / getpgid / getsid / setsid and the terminal’s foreground group', async () => {
    const { make } = session();
    const shell = make(10);
    const job = make(11, 10);
    expect(await job.syscall({ op: 'proc-setpgid', pid: 0, pgid: 0 })).toEqual({
      ok: true,
      kind: 'void',
    });
    expect(await shell.syscall({ op: 'proc-getpgid', pid: 11 })).toMatchObject({ json: 11 });
    expect(await shell.syscall({ op: 'proc-getsid', pid: 11 })).toMatchObject({ json: 10 });
    expect(await shell.syscall({ op: 'proc-setsid' })).toMatchObject({ errno: 'EPERM' });
    expect(await shell.syscall({ op: 'tty-pgrp-get', fd: 0 })).toMatchObject({ json: 10 });
    await shell.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 11 });
    expect(await job.syscall({ op: 'tty-pgrp-get', fd: 0 })).toMatchObject({ json: 11 });
    expect(await shell.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 99 })).toMatchObject({
      errno: 'EPERM',
    });
    expect(await shell.syscall({ op: 'tty-pgrp-get', fd: 1 })).toMatchObject({
      errno: 'ENOTTY',
    });
  });

  it('kill(0) and kill(-pgid) signal a group', async () => {
    const { make, kill, signals } = session();
    const shell = make(10);
    make(11, 10);
    await shell.syscall({ op: 'sig-mask', caught: sigbit(SIG.USR1), ignored: 0 });
    await shell.syscall({ op: 'proc-kill', pid: 0, sig: SIG.USR1 });
    expect(kill).toHaveBeenCalledWith(-10, SIG.USR1);
    expect(signals.map(([pid]) => pid)).toEqual([10, 11]);
  });

  it('a background group reading the terminal gets SIGTTIN (EIO when it ignores it)', async () => {
    const { make, signals } = session();
    const shell = make(10);
    const job = make(11, 10);
    await job.syscall({ op: 'proc-setpgid', pid: 0, pgid: 0 });
    let done = false;
    const reading = job.syscall({ op: 'fd-read', fd: 0, max: 8 }).then((r) => {
      done = true;
      return r;
    });
    await tick();
    expect(signals).toEqual([[11, SIG.TTIN]]);
    expect(done).toBe(false); // stopped, to read once in the foreground
    await shell.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 11 });
    job.signal(SIG.CONT);
    await tick();
    expect(done).toBe(false); // now reading the terminal, in the foreground
    const ignoring = make(12, 10);
    await ignoring.syscall({ op: 'sig-mask', caught: 0, ignored: sigbit(SIG.TTIN) });
    expect(await ignoring.syscall({ op: 'fd-read', fd: 0, max: 8 })).toMatchObject({
      errno: 'EIO',
    });
    void reading;
  });

  it("reading a terminal that is not its session's is no background read (screen's backend)", async () => {
    const { make, signals, tty } = session();
    const shell = make(10);
    await shell.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 10 }); // the shell's in the foreground
    const backend = make(11, 10);
    expect(await backend.syscall({ op: 'proc-setsid' })).toMatchObject({ json: 11 });
    let got: unknown;
    void backend.syscall({ op: 'fd-read', fd: 0, max: 8 }).then((r) => {
      got = r;
    });
    await tick();
    tty.receive(new TextEncoder().encode('k\n'));
    await tick();
    expect(signals).toEqual([]);
    expect(got).toMatchObject({ ok: true });
  });

  it('without a job table each process is its own group and session', async () => {
    const tty = new KernelTty({ write: () => {} }, () => {});
    const fds = new FdTable();
    fds.installAt(0, tty.file());
    const kill = vi.fn(() => true);
    const p = new WasmProcess(5, fds, { kill });
    expect(await p.syscall({ op: 'proc-getpgid', pid: 0 })).toMatchObject({ json: 5 });
    expect(await p.syscall({ op: 'proc-getsid', pid: 5 })).toMatchObject({ json: 5 });
    expect(await p.syscall({ op: 'proc-getpgid', pid: 6 })).toMatchObject({ errno: 'ESRCH' });
    expect(await p.syscall({ op: 'proc-setpgid', pid: 0, pgid: 5 })).toMatchObject({ ok: true });
    expect(await p.syscall({ op: 'proc-setpgid', pid: 0, pgid: 9 })).toMatchObject({
      errno: 'EPERM',
    });
    expect(await p.syscall({ op: 'proc-setsid' })).toMatchObject({ errno: 'EPERM' });
    expect(await p.syscall({ op: 'tty-pgrp-get', fd: 0 })).toMatchObject({ json: 5 });
    expect(await p.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 5 })).toMatchObject({ ok: true });
    expect(await p.syscall({ op: 'tty-pgrp-set', fd: 0, pgrp: 6 })).toMatchObject({
      errno: 'EPERM',
    });
    await p.syscall({ op: 'proc-kill', pid: 0, sig: SIG.TERM });
    expect(kill).toHaveBeenCalledWith(-5, SIG.TERM);
  });
});
