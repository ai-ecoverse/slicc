/**
 * The WASIX host's imports (#3530 phase 5c), in-process over the fake kernel
 * and sync-fs bridge (`fakes.ts`): the preview1 calls a WASIX program means
 * differently, the exec generations, a forked child's descriptor table.
 * Real programs (fork, exec, bash, python): `../wasix-programs.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { E, OFLAGS, RIGHTS } from '../../../../src/kernel/wasm-realm/wasi/wasi-abi.js';
import { WasiExit, WasiHost } from '../../../../src/kernel/wasm-realm/wasi/wasi-host.js';
import { importedMemory } from '../../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { AsyncifyDriver } from '../../../../src/kernel/wasm-realm/wasi/wasix-fork.js';
import { COMPAT, WasixHost } from '../../../../src/kernel/wasm-realm/wasi/wasix-host.js';
import { FakeFs, FakeKernel, Guest } from './fakes.js';

type Imports = Record<string, (...a: Array<number | bigint>) => number>;

function setup(
  opts: {
    wasix?: boolean;
    forked?: ConstructorParameters<typeof WasiHost>[0]['forked'];
    module?: WebAssembly.Module;
    sharedMemory?: boolean;
  } = {}
) {
  const kernel = new FakeKernel();
  const fs = new FakeFs().dir('/workspace').dir('/tmp').file('/workspace/a.txt', 'one\n');
  const host = new WasiHost({
    args: ['prog'],
    env: { HOME: '/h' },
    cwd: '/workspace',
    pid: 9,
    kernel,
    fs,
    ...(opts.forked ? { forked: opts.forked } : {}),
  });
  const g = new Guest(opts.sharedMemory);
  host.mem.bind(g.memory);
  const wasix = new WasixHost(host, new AsyncifyDriver(host.mem), opts.module);
  const preview1 = {
    ...host.imports(),
    ...(opts.wasix === false ? {} : wasix.preview1()),
  } as Imports;
  const x = wasix.imports() as Imports;
  const open = (path: string, oflags = 0): number => {
    const [p, l] = g.str(path);
    const out = g.alloc(4);
    expect(preview1.path_open(3, 1, p, l, oflags, RIGHTS.ALL, RIGHTS.ALL, 0, out)).toBe(E.SUCCESS);
    return g.u32(out);
  };
  const read = (fd: number): string => {
    const [iov, n, buf] = g.iov(64);
    const out = g.alloc(4);
    expect(preview1.fd_read(fd, iov, n, out)).toBe(E.SUCCESS);
    return g.read(buf, g.u32(out));
  };
  const write = (fd: number, text: string): number => {
    const [iov, n] = g.iov(text);
    return preview1.fd_write(fd, iov, n, g.alloc(4));
  };
  return { kernel, fs, host, g, preview1, x, open, read, write };
}

describe('WASIX: preview1 calls it means differently', () => {
  it('fd_renumber is dup2: `from` stays open (wasix-libc dup2 calls it, then closes `from`)', () => {
    const t = setup();
    const fd = t.open('/workspace/out.txt', OFLAGS.CREAT);
    const saved = t.host.fds.dup(1, 10, false);
    expect(t.preview1.fd_renumber(fd, 1)).toBe(E.SUCCESS);
    expect(t.kernel.calls).toContainEqual({ op: 'fd-renumber', from: fd, to: 1, keep: true });
    expect(t.preview1.fd_close(fd)).toBe(E.SUCCESS);
    expect(t.write(1, 'redirected\n')).toBe(E.SUCCESS);
    // bash's restore: dup2(saved, 1), close(saved); stdout is the kernel's again.
    expect(t.preview1.fd_renumber(saved, 1)).toBe(E.SUCCESS);
    expect(t.preview1.fd_close(saved)).toBe(E.SUCCESS);
    expect(t.write(1, 'back\n')).toBe(E.SUCCESS);
    expect(t.fs.text('/workspace/out.txt')).toBe('redirected\n');
    expect(t.kernel.out(1)).toBe('back\n');
  });

  it('a preview1 program keeps preview1 fd_renumber: `from` closes', () => {
    const t = setup({ wasix: false });
    const fd = t.open('/workspace/out.txt', OFLAGS.CREAT);
    expect(t.preview1.fd_renumber(fd, 1)).toBe(E.SUCCESS);
    expect(t.preview1.fd_close(fd)).toBe(E.BADF);
  });

  it('a preopen does not close (close_fds before exec keeps the paths), anything else does', () => {
    const t = setup();
    for (let fd = 3; fd <= 6; fd++) expect(t.preview1.fd_close(fd)).toBe(E.SUCCESS);
    expect(t.read(t.open('a.txt'))).toBe('one\n');
    const fd = t.open('a.txt');
    expect(t.preview1.fd_close(fd)).toBe(E.SUCCESS);
    expect(t.preview1.fd_close(fd)).toBe(E.BADF);
    expect(setup({ wasix: false }).preview1.fd_close(3)).toBe(E.SUCCESS);
  });
});

describe('WASIX: descriptors', () => {
  it('a dup shares one description; closing both drops the buffer (a reopen sees the file anew)', () => {
    const t = setup();
    const fd = t.open('a.txt');
    const out = t.g.alloc(4);
    expect(t.x.fd_dup(fd, out)).toBe(E.SUCCESS);
    const dup = t.g.u32(out);
    expect(t.read(fd)).toBe('one\n');
    expect(t.read(dup)).toBe(''); // one offset
    t.preview1.fd_close(fd);
    t.preview1.fd_close(dup);
    t.fs.file('/workspace/a.txt', 'two\n'); // another process wrote it
    expect(t.read(t.open('a.txt'))).toBe('two\n');
  });

  it('a forked child takes its parent table as is: nothing reserved, preopens and cloexec kept', () => {
    const t = setup({
      forked: {
        fds: [
          { fd: 3, type: 'dir', path: '/workspace/sub', preopen: '.' },
          { fd: 4, type: 'dir', path: '/tmp', preopen: '/tmp' },
          { fd: 7, type: 'kernel', nonblock: false, append: false },
        ],
        cloexec: [7],
      },
    });
    expect(t.kernel.calls.filter((c) => c.op === 'fd-reserve')).toEqual([]);
    expect(t.host.fds.dir(3).path).toBe('/workspace/sub');
    expect([...t.host.fds.cloexec]).toEqual([7]);
    expect(t.host.fds.inheritable().has(7)).toBe(false);
  });
});

/** A module importing `wasix_32v1` functions `names` (each `() -> ()`). */
function importing(names: string[]): WebAssembly.Module {
  const enc = new TextEncoder();
  const str = (s: string) => [s.length, ...enc.encode(s)];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  return new WebAssembly.Module(
    new Uint8Array([
      ...[0, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
      ...section(1, [1, 0x60, 0, 0]),
      ...section(2, [
        names.length,
        ...names.flatMap((n) => [...str('wasix_32v1'), ...str(n), 0, 0]),
      ]),
    ])
  );
}

describe("WASIX: what an exec'd program inherits", () => {
  /** exec `prog` (it is missing: the spawn request is what counts); what it was handed beyond stdio. */
  function execInherits(t: ReturnType<typeof setup>): unknown {
    const [n, nl] = t.g.str('/usr/bin/prog');
    const [a, al] = t.g.str('prog');
    expect(() => t.x.proc_exec(n, nl, a, al)).toThrow(WasiExit);
    return t.kernel.calls.find((c) => c.op === 'proc-spawn');
  }

  it('a libc with fd_fdflags_set marks close-on-exec itself: other fds are inherited', () => {
    const t = setup({ module: importing(['proc_fork', 'fd_fdflags_set']) });
    const [r, w] = t.host.fds.pipe();
    t.host.fds.cloexec.add(w);
    expect(execInherits(t)).toMatchObject({ inherit: [{ fd: r, kernel: r }] });
  });

  it("one without it takes every fd for close-on-exec: only stdio (Python's error pipe reaches EOF)", () => {
    const t = setup({ module: importing(['proc_fork', 'proc_exec']) });
    t.host.fds.pipe();
    expect(execInherits(t)).toMatchObject({
      inherit: [],
      stdio: [{ fd: 0 }, { fd: 1 }, { fd: 2 }],
    });
  });

  it('a spawn dup2 from a close-on-exec fd still hands the copy over', () => {
    const t = setup({ module: importing(['proc_fork']) });
    const [r] = t.host.fds.pipe();
    t.host.fds.cloexec.add(r);
    const [n, nl] = t.g.str('prog');
    const ops = t.g.alloc(56);
    const v = t.g.view;
    v.setUint8(ops, 1); // dup2
    v.setUint32(ops + 4, 0, true); // fd
    v.setUint32(ops + 8, r, true); // src_fd
    const out = t.g.alloc(4);
    t.x.proc_spawn2(n, nl, 0, 0, 0, 0, ops, 1, 0, 0, 1, ...t.g.str('/usr/bin'), out);
    expect(t.kernel.calls.find((c) => c.op === 'proc-spawn')).toMatchObject({
      stdio: [{ fd: r }, { fd: 1 }, { fd: 2 }],
    });
  });
});

describe('WASIX: spawn fd operations', () => {
  /** A `__wasi_proc_spawn_fd_op_t` array: [cmd, fd, srcFd, path?, oflags?] per op. */
  function ops(
    t: ReturnType<typeof setup>,
    list: Array<[number, number, number, string?, number?]>
  ): number {
    const at = t.g.alloc(56 * list.length);
    const v = t.g.view;
    list.forEach(([cmd, fd, src, path, oflags], i) => {
      const p = at + i * 56;
      v.setUint8(p, cmd);
      v.setUint32(p + 4, fd, true);
      v.setUint32(p + 8, src, true);
      if (path !== undefined) {
        const [s, l] = t.g.str(path);
        v.setUint32(p + 12, s, true);
        v.setUint32(p + 16, l, true);
      }
      v.setUint16(p + 24, oflags ?? 0, true);
    });
    return at;
  }
  const CLOSE = 0;
  const DUP2 = 1;
  const OPEN = 2;
  const CHDIR = 3;
  function spawn(t: ReturnType<typeof setup>, at: number, count: number): number {
    const [n, nl] = t.g.str('prog');
    const [p, pl] = t.g.str('/usr/bin');
    return t.x.proc_spawn2(n, nl, 0, 0, 0, 0, at, count, 0, 0, 1, p, pl, t.g.alloc(4));
  }

  it('an open after a chdir resolves from the new directory', () => {
    const t = setup();
    t.fs.dir('/workspace/sub').file('/workspace/sub/in.txt', 'x');
    spawn(
      t,
      ops(t, [
        [CHDIR, 0, 0, 'sub'],
        [OPEN, 0, 0, 'in.txt'],
      ]),
      2
    );
    expect([...t.kernel.table.values()].map((f) => f.path).filter(Boolean)).toEqual([]);
    expect(t.kernel.calls.find((c) => c.op === 'proc-spawn')).toMatchObject({
      cwd: '/workspace/sub',
    });
    expect(t.kernel.opened).toEqual(['/workspace/sub/in.txt']);
  });

  it('an O_CREAT open has the kernel make the file (never clobbering it); only O_TRUNC empties', () => {
    const t = setup();
    const CREAT = 1;
    const TRUNC = 8;
    spawn(t, ops(t, [[OPEN, 2, 0, '/tmp/err.txt', CREAT]]), 1);
    // The kernel creates it if missing, by its own live look: no write from this worker's cache.
    expect(t.kernel.opened).toEqual(['/tmp/err.txt']);
    expect(t.kernel.openedOpts.at(-1)).toEqual({ create: true });
    expect(t.fs.exists('/tmp/err.txt')).toBe(false);
    spawn(t, ops(t, [[OPEN, 1, 0, '/workspace/a.txt', CREAT | TRUNC]]), 1);
    expect(t.kernel.openedOpts.at(-1)).toEqual({ create: true, truncate: true });
    // Without O_CREAT a missing path is ENOENT, and nothing is opened.
    expect(spawn(t, ops(t, [[OPEN, 2, 0, '/tmp/none.txt']]), 1)).toBe(E.NOENT);
    expect(t.kernel.opened).toHaveLength(2);
  });

  it('an open of /dev/null (no VFS file) gives the slot a null descriptor; a dup2 of it too', () => {
    const t = setup();
    spawn(
      t,
      ops(t, [
        [OPEN, 0, 0, '/dev/null'],
        [OPEN, 1, 0, '/dev/null', 1],
        [DUP2, 2, 1],
      ]),
      3
    );
    expect(t.kernel.opened).toEqual([]);
    expect(t.kernel.calls.find((c) => c.op === 'proc-spawn')).toMatchObject({
      stdio: [{ none: true }, { none: true }, { none: true }],
    });
  });

  it('a /dev/null open beyond stdio is inherited as a null slot, not dropped', () => {
    const t = setup();
    spawn(t, ops(t, [[OPEN, 5, 0, '/dev/null']]), 1);
    expect(t.kernel.opened).toEqual([]);
    expect(t.kernel.calls.find((c) => c.op === 'proc-spawn')).toMatchObject({
      inherit: [{ fd: 5, null: true }],
    });
  });

  it("drops its metadata cache after a spawn and a child's end (the child changes the VFS)", () => {
    const t = setup();
    const invalidate = vi.fn();
    (t.fs as unknown as { invalidate: () => void }).invalidate = invalidate;
    spawn(t, ops(t, []), 0);
    expect(invalidate).toHaveBeenCalledTimes(1);
    t.kernel.waitResult = [77, 0];
    const pid = t.g.alloc(8);
    t.x.proc_join(pid, 0, t.g.alloc(8));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('a failing action closes what earlier opens took (no leaked kernel fds)', () => {
    const t = setup();
    const before = t.kernel.table.size;
    expect(
      spawn(
        t,
        ops(t, [
          [OPEN, 0, 0, 'a.txt'],
          [DUP2, 1, 77],
        ]),
        2
      )
    ).toBe(E.BADF);
    expect(t.kernel.table.size).toBe(before);
    expect(t.kernel.calls.some((c) => c.op === 'proc-spawn')).toBe(false);
    void CLOSE;
  });
});

describe('WASIX: dup2 onto a free number', () => {
  it('fd_renumber (dup2) may target an unused descriptor', () => {
    const t = setup();
    expect(t.preview1.fd_renumber(1, 10)).toBe(E.SUCCESS);
    expect(t.write(10, 'via ten\n')).toBe(E.SUCCESS);
    expect(t.kernel.out(1)).toBe('via ten\n');
    expect(t.preview1.fd_close(1)).toBe(E.SUCCESS);
    expect(t.write(10, 'still\n')).toBe(E.SUCCESS);
  });
});

describe('WASIX: tty_get / tty_set', () => {
  it("without a terminal on 0-2, they mean one the program opened (gpg's /dev/tty under git)", () => {
    const t = setup();
    t.kernel.tty = true;
    const ECHO = 0o10;
    const ICANON = 0o2;
    let termios = { c_iflag: 0, c_oflag: 0, c_cflag: 0, c_lflag: ECHO | ICANON, c_cc: [] };
    const set: Array<[number, number]> = [];
    Object.assign(t.kernel.sys, {
      tcgets: () => termios,
      tcsets: (fd: number, next: typeof termios) => {
        set.push([fd, next.c_lflag]);
        termios = next;
      },
      winsize: () => [24, 80],
    });
    const tty = t.open('/dev/tty');
    const at = t.g.alloc(24);
    expect(t.x.tty_get(at)).toBe(E.SUCCESS);
    expect(t.g.view.getUint8(at + 19)).toBe(1); // echo
    t.g.view.setUint8(at + 19, 0);
    expect(t.x.tty_set(at)).toBe(E.SUCCESS);
    expect(set).toEqual([[tty, ICANON]]);
  });
});

describe('WASIX: futexes, as Wasmer answers them', () => {
  it('a wake reports woken with nobody waiting; a wait on a changed value returns woken at once', () => {
    const t = setup({ sharedMemory: true });
    const word = t.g.alloc(4);
    const woken = t.g.alloc(1);
    t.g.view.setUint32(word, 5, true);
    // wasix-libc retries a wake that woke nobody: it must not spin.
    expect(t.x.futex_wake(word, woken)).toBe(E.SUCCESS);
    expect(t.g.view.getUint8(woken)).toBe(1);
    expect(t.x.futex_wake_all(word, woken)).toBe(E.SUCCESS);
    expect(t.g.view.getUint8(woken)).toBe(1);
    // Not 5 any more: no wait, woken.
    t.g.view.setUint8(woken, 0);
    expect(t.x.futex_wait(word, 4, 0, woken)).toBe(E.SUCCESS);
    expect(t.g.view.getUint8(woken)).toBe(1);
  });

  it('a wait that times out reports not woken', () => {
    const t = setup({ sharedMemory: true });
    const word = t.g.alloc(4);
    const woken = t.g.alloc(1);
    const timeout = t.g.alloc(16);
    t.g.view.setUint8(timeout, 1); // Some
    t.g.view.setBigUint64(timeout + 8, 1_000_000n, true); // 1 ms
    t.g.view.setUint8(woken, 1);
    expect(t.x.futex_wait(word, 0, timeout, woken)).toBe(E.SUCCESS);
    expect(t.g.view.getUint8(woken)).toBe(0);
  });
});

describe('WASIX: exec generations', () => {
  it('proc_exec / proc_exec2 never return: a missing program ends the process with its errno', () => {
    const t = setup();
    const [n, nl] = t.g.str('/usr/bin/nope');
    const [a, al] = t.g.str('nope\nx');
    expect(() => t.x.proc_exec(n, nl, a, al)).toThrow(expect.objectContaining({ code: E.NOENT }));
    expect(() => t.x.proc_exec2(n, nl, a, al, 0, 0)).toThrow(WasiExit);
    expect(t.kernel.calls.filter((c) => c.op === 'proc-spawn')).toMatchObject([
      { file: '/usr/bin/nope', argv: ['nope', 'x'], env: { HOME: '/h', PWD: '/workspace' } },
      { file: '/usr/bin/nope' },
    ]);
  });

  it('proc_exec3 returns the errno instead', () => {
    const t = setup();
    const [n, nl] = t.g.str('nope');
    const [a, al] = t.g.str('nope');
    const [p, pl] = t.g.str('/usr/bin');
    expect(t.x.proc_exec3(n, nl, a, al, 0, 0, 1, p, pl)).toBe(E.NOENT);
  });

  it('every name in the compatibility table is served', () => {
    const t = setup();
    for (const name of Object.values(COMPAT).flat())
      expect(typeof t.x[name], name).toBe('function');
  });
});

describe('WasixHost: interval timers', () => {
  const MS = 1_000_000n; // WASI timestamps are ns
  const alarms = (t: ReturnType<typeof setup>) =>
    t.kernel.calls.filter((c) => c.op === 'proc-alarm');

  it('proc_raise_interval (every wasix-libc): it_interval in ns, repeating; 0 cancels', () => {
    const t = setup();
    expect(t.x.proc_raise_interval(14, 250n * MS, 1)).toBe(E.SUCCESS);
    expect(t.x.proc_raise_interval(14, 0n, 1)).toBe(E.SUCCESS);
    expect(alarms(t)).toEqual([
      { op: 'proc-alarm', sig: 14, ms: 250, repeat: true },
      { op: 'proc-alarm', sig: 14, ms: 0, repeat: true },
    ]);
  });

  it('proc_raise_interval2 (patched libc): cancel, a one-shot alarm(), first then every', () => {
    const t = setup();
    expect(t.x.proc_raise_interval2(14, 0n, 0n, 0)).toBe(E.SUCCESS);
    expect(t.x.proc_raise_interval2(14, 5000n * MS, 0n, 0)).toBe(E.SUCCESS);
    expect(t.x.proc_raise_interval2(14, 100n * MS, 20n * MS, 1)).toBe(E.SUCCESS);
    expect(t.x.proc_raise_interval2(99, 1n, 0n, 0)).toBe(E.INVAL);
    expect(alarms(t)).toEqual([
      { op: 'proc-alarm', sig: 14, ms: 0, firstMs: 0, repeat: false },
      { op: 'proc-alarm', sig: 14, ms: 0, firstMs: 5000, repeat: false },
      { op: 'proc-alarm', sig: 14, ms: 20, firstMs: 100, repeat: true },
    ]);
  });
});

describe('importedMemory', () => {
  it('reads a memory import (limits, shared) from the import section, else undefined', () => {
    const enc = new TextEncoder();
    const str = (s: string) => [s.length, ...enc.encode(s)];
    const body = [1, ...str('env'), ...str('memory'), 2, 0x03, 17, 0x80, 0x80, 0x04];
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, body.length, ...body]);
    expect(importedMemory(bytes)).toEqual({
      module: 'env',
      name: 'memory',
      initial: 17,
      maximum: 65536,
      shared: true,
    });
    expect(importedMemory(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBeUndefined();
  });
});
