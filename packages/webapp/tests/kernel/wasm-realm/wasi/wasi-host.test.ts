/**
 * The WASI preview1 host's imports, in-process, over a fake kernel and a fake
 * sync-fs bridge (`fakes.ts`): what each import asks of them and what it
 * leaves in the program's memory. Real programs: `../wasi-programs.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { SyncFsPosixBridge } from '../../../../src/kernel/realm/sync-fs-xhr-bridge.js';
import {
  CLOCK,
  E,
  EVENT_FD_READWRITE_HANGUP,
  EVENTTYPE,
  FDFLAGS,
  FILETYPE,
  FSTFLAGS,
  OFLAGS,
  RIFLAGS,
  RIGHTS,
  SDFLAGS,
  SIZE,
  WHENCE,
} from '../../../../src/kernel/wasm-realm/wasi/wasi-abi.js';
import { cachingBridge } from '../../../../src/kernel/wasm-realm/wasi/wasi-files.js';
import { WasiExit, WasiHost } from '../../../../src/kernel/wasm-realm/wasi/wasi-host.js';
import { FakeFs, FakeKernel, Guest, ListingFs } from './fakes.js';

type Call = (name: string, ...args: Array<number | bigint>) => number;

function setup(
  opts: {
    inherited?: number[];
    env?: Record<string, string>;
    fs?: FakeFs;
    bridge?: (fs: FakeFs) => SyncFsPosixBridge;
  } = {}
) {
  const kernel = new FakeKernel();
  for (const fd of opts.inherited ?? []) kernel.add(fd, 'stream', ['inherited\n']);
  const fs = (opts.fs ?? new FakeFs())
    .dir('/workspace')
    .dir('/workspace/p')
    .dir('/tmp')
    .file('/workspace/p/a.txt', 'hello\n')
    .file('/root-file', 'not a dir');
  const host = new WasiHost({
    args: ['prog', 'x'],
    env: opts.env ?? { HOME: '/h' },
    cwd: '/workspace/p',
    pid: 9,
    kernel,
    fs: opts.bridge ? opts.bridge(fs) : fs,
    ...(opts.inherited ? { inherited: opts.inherited.map((fd) => ({ fd })) } : {}),
  });
  const g = new Guest();
  host.mem.bind(g.memory);
  const imports = host.imports() as Record<string, (...a: Array<number | bigint>) => number>;
  const call: Call = (name, ...args) => imports[name](...args);
  /** path_open relative to `dirfd`; [errno, fd]. */
  const open = (
    path: string,
    oflags = 0,
    rights: bigint = RIGHTS.ALL,
    fdflags = 0,
    dirfd = 3
  ): [number, number] => {
    const [p, l] = g.str(path);
    const out = g.alloc(4);
    const errno = call('path_open', dirfd, 1, p, l, oflags, rights, RIGHTS.ALL, fdflags, out);
    return [errno, g.u32(out)];
  };
  const write = (fd: number, text: string): [number, number] => {
    const [iov, n] = g.iov(text);
    const out = g.alloc(4);
    return [call('fd_write', fd, iov, n, out), g.u32(out)];
  };
  const read = (fd: number, size: number): [number, string] => {
    const [iov, n, buf] = g.iov(size);
    const out = g.alloc(4);
    const errno = call('fd_read', fd, iov, n, out);
    return [errno, g.read(buf, g.u32(out))];
  };
  const path = (dirfd: number, name: string, fn: string, ...rest: Array<number | bigint>) => {
    const [p, l] = g.str(name);
    return call(fn, dirfd, p, l, ...rest);
  };
  return { kernel, fs, host, g, call, open, write, read, path };
}

describe('WasiHost: an inherited device', () => {
  it('is a character device on the side it was opened for (a write to O_RDONLY is EBADF)', () => {
    const kernel = new FakeKernel();
    kernel.add(40, 'stream'); // the kernel keeps the number
    const host = new WasiHost({
      args: ['prog'],
      env: {},
      cwd: '/workspace',
      pid: 9,
      kernel,
      fs: new FakeFs().dir('/workspace'),
      inherited: [{ fd: 40, kind: 'device', device: { device: 'urandom', access: 'read' } }],
    });
    const g = new Guest();
    host.mem.bind(g.memory);
    const imports = host.imports() as Record<string, (...a: Array<number | bigint>) => number>;
    const stat = g.alloc(SIZE.FILESTAT);
    expect(imports.fd_filestat_get(40, stat)).toBe(E.SUCCESS);
    expect(g.view.getUint8(stat + 16)).toBe(FILETYPE.CHARACTER_DEVICE);
    const fdstat = g.alloc(24);
    expect(imports.fd_fdstat_get(40, fdstat)).toBe(E.SUCCESS);
    expect(g.view.getUint8(fdstat)).toBe(FILETYPE.CHARACTER_DEVICE);
    const [iov, n] = g.iov(8);
    const out = g.alloc(4);
    expect(imports.fd_read(40, iov, n, out)).toBe(E.SUCCESS);
    expect(g.u32(out)).toBe(8);
    const [wiov, wn] = g.iov('x');
    expect(imports.fd_write(40, wiov, wn, g.alloc(4))).toBe(E.BADF);
    expect(kernel.calls.filter((c) => c.op === 'fd-read' || c.op === 'fd-write')).toEqual([]);
  });
});

describe('WasiHost: preopens and start-up', () => {
  it('fd 3 is `.` (the cwd), then /dev and each top-level directory; EBADF after them', () => {
    const { call, g } = setup();
    const names: string[] = [];
    for (let fd = 3; ; fd++) {
      const out = g.alloc(8);
      const errno = call('fd_prestat_get', fd, out);
      if (errno !== E.SUCCESS) {
        expect(errno).toBe(E.BADF);
        break;
      }
      const len = g.u32(out + 4);
      const buf = g.alloc(len);
      expect(call('fd_prestat_dir_name', fd, buf, len)).toBe(E.SUCCESS);
      names.push(g.read(buf, len));
    }
    // /root-file is no directory: no preopen.
    expect(names).toEqual(['.', '/dev', '/tmp', '/workspace']);
  });

  it("preopens the shell's synthetic /usr and /bin, which / does not list", () => {
    const fs = new FakeFs().dir('/usr').dir('/usr/bin').file('/usr/bin/cargo', '#!/bin/sh\n');
    const listing = fs.readdir.bind(fs);
    // The command registry: it stats as a directory but is not in the root's listing.
    fs.readdir = (p: string) => (p === '/' ? listing(p).filter((n) => n !== 'usr') : listing(p));
    const { call, g } = setup({ fs });
    const names: string[] = [];
    for (let fd = 3; ; fd++) {
      const out = g.alloc(8);
      if (call('fd_prestat_get', fd, out) !== E.SUCCESS) break;
      const len = g.u32(out + 4);
      const buf = g.alloc(len);
      call('fd_prestat_dir_name', fd, buf, len);
      names.push(g.read(buf, len));
    }
    expect(names).toEqual(['.', '/dev', '/tmp', '/usr', '/workspace']); // no /bin here: it does not stat
  });

  it('reserves the preopens’ numbers in the kernel, and moves an inherited fd out of their way', () => {
    const { kernel, read } = setup({ inherited: [3] });
    expect(kernel.table.get(3)?.kind).toBe('held');
    // fd 3 moved to the first free number above the preopens (3..6).
    expect(kernel.calls).toContainEqual({ op: 'fd-dup', fd: 3, min: 7 });
    expect(read(7, 64)).toEqual([E.SUCCESS, 'inherited\n']);
  });

  it('args and environ, with $PWD from the cwd unless set', () => {
    const { call, g } = setup();
    const count = g.alloc(4);
    const size = g.alloc(4);
    expect(call('args_sizes_get', count, size)).toBe(E.SUCCESS);
    expect([g.u32(count), g.u32(size)]).toEqual([2, 7]);
    const ptrs = g.alloc(8);
    const buf = g.alloc(7);
    call('args_get', ptrs, buf);
    expect(g.read(g.u32(ptrs + 4), 1)).toBe('x');
    call('environ_sizes_get', count, size);
    const env = g.alloc(g.u32(size));
    const envp = g.alloc(g.u32(count) * 4);
    call('environ_get', envp, env);
    expect(g.read(env, g.u32(size))).toBe('PWD=/workspace/p\0HOME=/h\0');
    const own = setup({ env: { PWD: '/elsewhere' } });
    own.call('environ_sizes_get', count, size);
    expect(own.g.u32(count)).toBe(1);
  });
});

describe('WasiHost: files', () => {
  it('creates, writes (buffered), and writes back on close', () => {
    const { open, write, call, fs, kernel } = setup();
    const [errno, fd] = open('new.txt', OFLAGS.CREAT | OFLAGS.TRUNC);
    expect(errno).toBe(E.SUCCESS);
    expect(kernel.table.get(fd)?.kind).toBe('held');
    // Created at once (a readdir sees it), empty until the write-back.
    expect(fs.text('/workspace/p/new.txt')).toBe('');
    expect(write(fd, 'abc')).toEqual([E.SUCCESS, 3]);
    expect(fs.text('/workspace/p/new.txt')).toBe('');
    expect(call('fd_close', fd)).toBe(E.SUCCESS);
    expect(fs.text('/workspace/p/new.txt')).toBe('abc');
    expect(kernel.table.has(fd)).toBe(false);
  });

  it('reads, seeks, tells, preads and pwrites', () => {
    const { open, read, call, g, fs } = setup();
    const [, fd] = open('a.txt');
    expect(read(fd, 3)).toEqual([E.SUCCESS, 'hel']);
    const out = g.alloc(8);
    call('fd_tell', fd, out);
    expect(g.u64(out)).toBe(3n);
    call('fd_seek', fd, -2n, WHENCE.END, out);
    expect(g.u64(out)).toBe(4n);
    expect(read(fd, 10)).toEqual([E.SUCCESS, 'o\n']);
    expect(call('fd_seek', fd, -100n, WHENCE.CUR, out)).toBe(E.INVAL);
    const [iov, n, buf] = g.iov(4);
    call('fd_pread', fd, iov, n, 1n, out);
    expect(g.read(buf, g.u32(out))).toBe('ello');
    const [wiov, wn] = g.iov('J');
    call('fd_pwrite', fd, wiov, wn, 0n, out);
    call('fd_sync', fd);
    expect(fs.text('/workspace/p/a.txt')).toBe('Jello\n');
  });

  it('appends with FDFLAGS.APPEND, and with fd_fdstat_set_flags', () => {
    const { open, write, call, fs } = setup();
    const [, fd] = open('a.txt', 0, RIGHTS.ALL, FDFLAGS.APPEND);
    write(fd, 'more\n');
    call('fd_close', fd);
    expect(fs.text('/workspace/p/a.txt')).toBe('hello\nmore\n');
    const [, fd2] = open('a.txt');
    call('fd_fdstat_set_flags', fd2, FDFLAGS.APPEND);
    write(fd2, 'end\n');
    call('fd_datasync', fd2);
    expect(fs.text('/workspace/p/a.txt')).toBe('hello\nmore\nend\n');
  });

  it('refuses what open(2) would: EEXIST, ENOENT, ENOTDIR, EISDIR on a read', () => {
    const { open, read } = setup();
    expect(open('a.txt', OFLAGS.CREAT | OFLAGS.EXCL)[0]).toBe(E.EXIST);
    expect(open('missing')[0]).toBe(E.NOENT);
    expect(open('a.txt', OFLAGS.DIRECTORY)[0]).toBe(E.NOTDIR);
    expect(open('missing', OFLAGS.DIRECTORY)[0]).toBe(E.NOENT);
    const [, dir] = open('/tmp');
    expect(read(dir, 4)[0]).toBe(E.ISDIR);
  });

  it('a read-only fd cannot write, a write-only one cannot read', () => {
    const { open, read, write } = setup();
    const [, ro] = open('a.txt', 0, RIGHTS.FD_READ);
    expect(write(ro, 'x')[0]).toBe(E.BADF);
    const [, wo] = open('a.txt', 0, RIGHTS.FD_WRITE);
    expect(read(wo, 4)[0]).toBe(E.BADF);
  });

  it('truncates, allocates and reports the buffered size before the write-back', () => {
    const { open, write, call, g } = setup();
    const [, fd] = open('a.txt');
    write(fd, 'HELLO WORLD');
    const st = g.alloc(SIZE.FILESTAT);
    call('fd_filestat_get', fd, st);
    expect(g.view.getUint8(st + 16)).toBe(FILETYPE.REGULAR_FILE);
    expect(g.u64(st + 32)).toBe(11n);
    call('fd_filestat_set_size', fd, 4n);
    call('fd_filestat_get', fd, st);
    expect(g.u64(st + 32)).toBe(4n);
    call('fd_allocate', fd, 0n, 20n);
    call('fd_filestat_get', fd, st);
    expect(g.u64(st + 32)).toBe(20n);
    expect(call('fd_advise', fd, 0n, 0n, 0)).toBe(E.SUCCESS);
    expect(call('fd_filestat_set_size', 1, 0n)).toBe(E.SPIPE);
  });

  it('a file unlinked while open keeps its bytes and never comes back', () => {
    const { open, call, g, path, fs, read } = setup();
    const [, fd] = open('a.txt');
    expect(path(3, 'a.txt', 'path_unlink_file')).toBe(E.SUCCESS);
    const st = g.alloc(SIZE.FILESTAT);
    expect(call('fd_filestat_get', fd, st)).toBe(E.SUCCESS);
    expect(g.u64(st + 32)).toBe(6n);
    // Its bytes live on for the fd, and closing it does not bring the path back.
    expect(read(fd, 10)[1]).toBe('hello\n');
    call('fd_close', fd);
    expect(fs.exists('/workspace/p/a.txt')).toBe(false);
  });

  it('a renamed open file is written back where it went', () => {
    const { open, call, g, path, fs, write } = setup();
    const [, fd] = open('a.txt');
    const [to, tl] = g.str('moved.txt');
    expect(path(3, 'a.txt', 'path_rename', 3, to, tl)).toBe(E.SUCCESS);
    write(fd, 'Y');
    call('fd_close', fd);
    expect(fs.text('/workspace/p/moved.txt')).toBe('Yello\n');
    expect(fs.exists('/workspace/p/a.txt')).toBe(false);
  });
});

describe('WasiHost: paths', () => {
  it('absolute paths resolve from the root whatever the dir fd (Zig sends them to fd 3)', () => {
    const { open, read } = setup();
    const [errno, fd] = open('/workspace/p/a.txt', 0, RIGHTS.ALL, 0, 3);
    expect(errno).toBe(E.SUCCESS);
    expect(read(fd, 10)[1]).toBe('hello\n');
    // `..` never climbs above the root.
    expect(open('../../../workspace/p/a.txt')[0]).toBe(E.SUCCESS);
  });

  it('mkdir, rmdir, unlink, rename, symlink, readlink', () => {
    const { path, fs, g, open, write, call } = setup();
    expect(path(3, 'd', 'path_create_directory')).toBe(E.SUCCESS);
    expect(path(3, 'd', 'path_create_directory')).toBe(E.EXIST);
    expect(path(3, 'd', 'path_unlink_file')).toBe(E.ISDIR);
    expect(path(3, 'd', 'path_remove_directory')).toBe(E.SUCCESS);
    // A rename writes back the source first.
    const [, fd] = open('a.txt');
    write(fd, 'X');
    const [to, tl] = g.str('b.txt');
    expect(path(3, 'a.txt', 'path_rename', 3, to, tl)).toBe(E.SUCCESS);
    expect(fs.text('/workspace/p/b.txt')).toBe('Xello\n');
    const [target, targetLen] = g.str('b.txt');
    const [lp, ll] = g.str('link');
    expect(call('path_symlink', target, targetLen, 3, lp, ll)).toBe(E.SUCCESS);
    const buf = g.alloc(16);
    const used = g.alloc(4);
    expect(path(3, 'link', 'path_readlink', buf, 16, used)).toBe(E.SUCCESS);
    expect(g.read(buf, g.u32(used))).toBe('b.txt');
    expect(path(3, 'a.txt', 'path_link', 3, 0, 0)).toBe(E.NOTSUP);
  });

  it('path_filestat_get follows symlinks or not; devices are character devices', () => {
    const { path, g, fs, call } = setup();
    fs.symlink('a.txt', '/workspace/p/ln');
    const st = g.alloc(SIZE.FILESTAT);
    const [p, l] = g.str('ln');
    expect(call('path_filestat_get', 3, 0, p, l, st)).toBe(E.SUCCESS);
    expect(g.view.getUint8(st + 16)).toBe(FILETYPE.SYMBOLIC_LINK);
    // With lookupflags SYMLINK_FOLLOW.
    expect(call('path_filestat_get', 3, 1, p, l, st)).toBe(E.SUCCESS);
    expect(g.view.getUint8(st + 16)).toBe(FILETYPE.REGULAR_FILE);
    expect(g.u64(st + 32)).toBe(6n);
    const [dp, dl] = g.str('/dev/null');
    call('path_filestat_get', 3, 1, dp, dl, st);
    expect(g.view.getUint8(st + 16)).toBe(FILETYPE.CHARACTER_DEVICE);
    const [np, nl] = g.str('nope');
    expect(call('path_filestat_get', 3, 1, np, nl, st)).toBe(E.NOENT);
    void path;
  });

  it('sets times: explicit, now, or kept', () => {
    const { fs, call, open, g } = setup();
    const [p, l] = g.str('a.txt');
    const both = FSTFLAGS.ATIM | FSTFLAGS.MTIM;
    expect(call('path_filestat_set_times', 3, 0, p, l, 5_000_000_000n, 7_000_000_000n, both)).toBe(
      E.SUCCESS
    );
    expect(fs.ops).toContain('utimes /workspace/p/a.txt 7000');
    call('path_filestat_set_times', 3, 0, p, l, 0n, 0n, FSTFLAGS.ATIM_NOW);
    expect(fs.ops).toContain('utimes /workspace/p/a.txt 7000'); // mtime kept
    const [, fd] = open('a.txt');
    call('fd_filestat_set_times', fd, 0n, 9_000_000_000n, FSTFLAGS.MTIM);
    expect(fs.ops).toContain('utimes /workspace/p/a.txt 9000');
    call('fd_filestat_set_times', 3, 0n, 0n, FSTFLAGS.MTIM_NOW);
    expect(fs.ops.some((op) => op.startsWith('utimes /workspace/p '))).toBe(true);
  });
});

describe('WasiHost: directories', () => {
  it('lists `.`, `..` and the names with their types, resuming at a cookie', () => {
    const s = setup();
    s.fs.file('/tmp/f', 'x').dir('/tmp/d');
    const [, fd] = s.open('/tmp');
    const buf = s.g.alloc(1024);
    const used = s.g.alloc(4);
    expect(s.call('fd_readdir', fd, buf, 1024, 0n, used)).toBe(E.SUCCESS);
    const entries = parseDirents(s.g, buf, s.g.u32(used));
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['.', FILETYPE.DIRECTORY],
      ['..', FILETYPE.DIRECTORY],
      ['f', FILETYPE.REGULAR_FILE],
      ['d', FILETYPE.DIRECTORY],
    ]);
    s.call('fd_readdir', fd, buf, 1024, BigInt(entries[2].next), used);
    expect(parseDirents(s.g, buf, s.g.u32(used)).map((e) => e.name)).toEqual(['d']);
  });

  it('fills a small buffer to the brim: a cut-off entry tells libc to grow it', () => {
    const s = setup();
    const buf = s.g.alloc(64);
    const used = s.g.alloc(4);
    s.call('fd_readdir', 3, buf, 30, 0n, used);
    expect(s.g.u32(used)).toBe(30);
    expect(s.call('fd_readdir', 0, buf, 30, 0n, used)).toBe(E.NOTDIR);
  });

  it('an import storm is one round trip: listing 300 entries, then stat-ing each, asks the bridge once', () => {
    const fs = new ListingFs();
    const s = setup({ fs, bridge: (b) => cachingBridge(b) });
    fs.dir('/tmp/lib');
    for (let i = 0; i < 300; i++) fs.file(`/tmp/lib/m${i}.py`, `# ${i}`);
    fs.symlink('m0.py', '/tmp/lib/alias.py');
    fs.ops.length = 0;
    const [, fd] = s.open('/tmp/lib');
    const buf = s.g.alloc(16384);
    const used = s.g.alloc(4);
    const seen: Array<{ name: string; type: number }> = [];
    for (let cookie = 0n; ; ) {
      expect(s.call('fd_readdir', fd, buf, 16384, cookie, used)).toBe(E.SUCCESS);
      const batch = parseDirents(s.g, buf, s.g.u32(used)).filter((e) => e.name.length > 0);
      if (batch.length === 0) break;
      seen.push(...batch);
      cookie = BigInt(batch[batch.length - 1].next);
    }
    expect(seen).toHaveLength(303);
    expect(seen.find((e) => e.name === 'alias.py')?.type).toBe(FILETYPE.SYMBOLIC_LINK);
    const out = s.g.alloc(64);
    for (let i = 0; i < 300; i++) {
      const [p, l] = s.g.str(`lib/m${i}.py`);
      expect(s.call('path_filestat_get', 5, 1, p, l, out)).toBe(E.SUCCESS); // followed, as Python stats
    }
    expect(fs.ops.filter((op) => op.includes('/tmp/lib/') || op.startsWith('readdir'))).toEqual([
      'readdir-stat /tmp/lib',
    ]);
  });
});

function parseDirents(g: Guest, buf: number, used: number) {
  const out: Array<{ next: number; name: string; type: number }> = [];
  for (let at = buf; at + SIZE.DIRENT <= buf + used; ) {
    const len = g.u32(at + 16);
    out.push({
      next: Number(g.u64(at)),
      name: g.read(at + SIZE.DIRENT, len),
      type: g.view.getUint8(at + 20),
    });
    at += SIZE.DIRENT + len;
  }
  return out;
}

describe('WasiHost: kernel descriptors', () => {
  it('stdout writes go to the kernel; EPIPE ends the program with 141', () => {
    const { write, kernel, call } = setup();
    expect(write(1, 'out')).toEqual([E.SUCCESS, 3]);
    expect(kernel.out(1)).toBe('out');
    (kernel.table.get(1) as { broken?: boolean }).broken = true;
    const [iov, n] = new Guest().iov('x');
    expect(() => call('fd_write', 1, iov, n, 0)).toThrow(WasiExit);
    try {
      write(1, 'x');
    } catch (e) {
      expect((e as WasiExit).code).toBe(141);
    }
  });

  it('reads stdin, non-blocking once asked (EAGAIN)', () => {
    const { kernel, read, call } = setup();
    kernel.table.get(0)?.input.push(new TextEncoder().encode('line\n'));
    expect(read(0, 64)).toEqual([E.SUCCESS, 'line\n']);
    call('fd_fdstat_set_flags', 0, FDFLAGS.NONBLOCK);
    (kernel.table.get(0) as { ready?: boolean }).ready = false;
    expect(read(0, 64)[0]).toBe(E.AGAIN);
  });

  it('fdstat: a terminal has no seek rights (isatty), a pipe neither, a kernel file seeks', () => {
    const { kernel, call, g } = setup();
    kernel.add(1, 'tty');
    kernel.add(20, 'file');
    kernel.add(21, 'socket');
    const out = g.alloc(SIZE.FDSTAT);
    const stat = (fd: number) => {
      expect(call('fd_fdstat_get', fd, out)).toBe(E.SUCCESS);
      return { type: g.view.getUint8(out), seek: (g.u64(out + 8) & RIGHTS.FD_SEEK) !== 0n };
    };
    expect(stat(1)).toEqual({ type: FILETYPE.CHARACTER_DEVICE, seek: false });
    expect(stat(0)).toEqual({ type: FILETYPE.UNKNOWN, seek: false });
    expect(stat(3)).toEqual({ type: FILETYPE.DIRECTORY, seek: true });
    expect(call('fd_seek', 0, 0n, WHENCE.CUR, out)).toBe(E.SPIPE);
  });

  it('seeks a kernel-held VFS file and flushes it on fd_sync', () => {
    const s = setup({ inherited: [20] });
    s.kernel.table.set(20, { kind: 'file', input: [], output: [] });
    const out = s.g.alloc(8);
    expect(s.call('fd_seek', 20, 5n, WHENCE.SET, out)).toBe(E.SUCCESS);
    expect(s.g.u64(out)).toBe(5n);
    expect(s.call('fd_sync', 20)).toBe(E.SUCCESS);
    const st = s.g.alloc(SIZE.FILESTAT);
    s.call('fd_filestat_get', 20, st);
    expect(s.g.view.getUint8(st + 16)).toBe(FILETYPE.REGULAR_FILE);
  });

  it('renumbers through the kernel; closing what was at the target', () => {
    const { open, call, kernel, fs, write } = setup();
    const [, a] = open('a.txt');
    write(a, 'Z');
    const [, b] = open('/tmp', OFLAGS.DIRECTORY);
    expect(call('fd_renumber', a, b)).toBe(E.SUCCESS);
    expect(kernel.calls).toContainEqual({ op: 'fd-renumber', from: a, to: b });
    expect(call('fd_close', a)).toBe(E.BADF);
    call('fd_close', b);
    expect(fs.text('/workspace/p/a.txt')).toBe('Zello\n');
    expect(call('fd_renumber', 1, 1)).toBe(E.SUCCESS);
  });
});

describe('WasiHost: devices and /dev/fd', () => {
  it('/dev/null swallows, /dev/zero and /dev/urandom fill', () => {
    const { open, read, write, call, g } = setup();
    const [, nul] = open('/dev/null');
    expect(write(nul, 'gone')).toEqual([E.SUCCESS, 4]);
    expect(read(nul, 8)).toEqual([E.SUCCESS, '']);
    const [, zero] = open('/dev/zero');
    expect(read(zero, 3)).toEqual([E.SUCCESS, '\0\0\0']);
    const [, rnd] = open('/dev/urandom');
    const [iov, n] = g.iov(16);
    const got = g.alloc(4);
    expect(call('fd_read', rnd, iov, n, got)).toBe(E.SUCCESS);
    expect(g.u32(got)).toBe(16);
  });

  it('/dev/fd/N dups a kernel fd, and shares a buffered file (one offset)', () => {
    const { open, read, kernel } = setup();
    const [, out] = open('/dev/stdout');
    expect(kernel.calls).toContainEqual({ op: 'fd-dup', fd: 1 });
    expect(kernel.table.get(out)).toBe(kernel.table.get(1));
    const [, f] = open('a.txt');
    read(f, 2);
    const [, again] = open(`/dev/fd/${f}`);
    expect(read(again, 10)[1]).toBe('llo\n');
    expect(open('/dev/fd/99')[0]).toBe(E.BADF);
    const [, dir] = open('/dev/fd/3');
    expect(dir).toBeGreaterThan(3);
  });

  it('/dev/tty is the controlling terminal, ENXIO without one', () => {
    const s = setup();
    expect(s.open('/dev/tty')[0]).toBe(E.NXIO);
    s.kernel.tty = true;
    const [errno, fd] = s.open('/dev/tty');
    expect(errno).toBe(E.SUCCESS);
    expect(s.kernel.table.get(fd)?.kind).toBe('tty');
  });
});

describe('WasiHost: clocks, randomness, poll, exit', () => {
  it('clocks: realtime from the epoch, monotonic from the time origin (never under 1 s); 1 µs resolution', () => {
    const { call, g } = setup();
    const out = g.alloc(8);
    call('clock_time_get', CLOCK.REALTIME, 0n, out);
    expect(Number(g.u64(out) / 1_000_000n)).toBeGreaterThan(Date.now() - 1000);
    call('clock_time_get', CLOCK.MONOTONIC, 0n, out);
    const first = g.u64(out);
    // A deadline in the first second breaks wasix-libc's absolute sleeps (Wasmer's Python).
    expect(first).toBeGreaterThan(1_000_000_000n);
    call('clock_time_get', CLOCK.MONOTONIC, 0n, out);
    expect(g.u64(out)).toBeGreaterThanOrEqual(first);
    call('clock_res_get', CLOCK.MONOTONIC, out);
    expect(g.u64(out)).toBe(1000n);
    const buf = g.alloc(70000);
    expect(call('random_get', buf, 70000)).toBe(E.SUCCESS);
    expect(call('sched_yield')).toBe(E.SUCCESS);
  });

  it('proc_exit unwinds with the code; proc_raise signals the process itself', () => {
    const { call, kernel } = setup();
    expect(() => call('proc_exit', 3)).toThrow(new WasiExit(3));
    expect(call('proc_raise', 16)).toBe(E.SUCCESS); // WASI's SIGCHLD
    expect(kernel.killed).toEqual([[9, 17]]);
  });

  it('poll_oneoff: a clock sleeps through fd-select; files are ready at once; kernel fds as select says', () => {
    const s = setup();
    const subs = s.g.alloc(SIZE.SUBSCRIPTION * 3);
    const events = s.g.alloc(SIZE.EVENT * 3);
    const n = s.g.alloc(4);
    const v = s.g.view;
    const sub = (i: number, userdata: bigint, type: number, fdOrTimeout: number | bigint) => {
      const p = subs + i * SIZE.SUBSCRIPTION;
      v.setBigUint64(p, userdata, true);
      v.setUint8(p + 8, type);
      if (type === EVENTTYPE.CLOCK) {
        v.setUint32(p + 16, CLOCK.MONOTONIC, true);
        v.setBigUint64(p + 24, BigInt(fdOrTimeout), true);
        v.setUint16(p + 40, 0, true);
      } else v.setUint32(p + 16, Number(fdOrTimeout), true);
    };
    sub(0, 7n, EVENTTYPE.CLOCK, 0n);
    expect(s.call('poll_oneoff', subs, events, 1, n)).toBe(E.SUCCESS);
    expect(s.kernel.calls.at(-1)).toMatchObject({
      op: 'fd-select',
      read: [],
      write: [],
      timeoutMs: 0,
    });
    expect(s.g.u32(n)).toBe(1);
    expect(s.g.u64(events)).toBe(7n);
    // A file (always ready), stdin (select says ready), and a bad fd.
    const [, f] = s.open('a.txt');
    sub(0, 1n, EVENTTYPE.FD_READ, f);
    sub(1, 2n, EVENTTYPE.FD_READ, 0);
    sub(2, 3n, EVENTTYPE.FD_WRITE, 99);
    s.call('poll_oneoff', subs, events, 3, n);
    const got = Array.from({ length: s.g.u32(n) }, (_, i) => [
      s.g.u64(events + i * SIZE.EVENT),
      v.getUint16(events + i * SIZE.EVENT + 8, true),
    ]);
    expect(got).toEqual([
      [1n, E.SUCCESS],
      [3n, E.BADF],
      [2n, E.SUCCESS],
    ]);
    expect(s.call('poll_oneoff', subs, events, 0, n)).toBe(E.INVAL);
  });

  it('an address outside memory is EFAULT; an error without a code propagates', () => {
    const { call, fs } = setup();
    expect(call('fd_write', 1, 0x7fffffff, 1, 0)).toBe(E.FAULT);
    (fs as unknown as { readdir: () => never }).readdir = () => {
      throw new TypeError('boom');
    };
    expect(() => call('fd_readdir', 3, 0, 10, 0n, 0)).toThrow('boom');
  });

  it('flushAll writes back every open file', () => {
    const { open, write, host, fs } = setup();
    const [, fd] = open('a.txt');
    write(fd, 'Q');
    host.flushAll();
    expect(fs.text('/workspace/p/a.txt')).toBe('Qello\n');
  });
});

describe('WasiHost: review round (#3638)', () => {
  it('two opens of one file share its buffer: two O_APPEND writers both land', () => {
    const { open, write, call, fs } = setup();
    const [, a] = open('a.txt', 0, RIGHTS.ALL, FDFLAGS.APPEND);
    const [, b] = open('a.txt', 0, RIGHTS.ALL, FDFLAGS.APPEND);
    write(a, 'one\n');
    write(b, 'two\n');
    call('fd_close', a);
    call('fd_close', b);
    expect(fs.text('/workspace/p/a.txt')).toBe('hello\none\ntwo\n');
  });

  it('a second open sees what the first wrote before any write-back; each keeps its own offset', () => {
    const { open, write, read, call } = setup();
    const [, a] = open('a.txt');
    write(a, 'HE');
    const [, b] = open('a.txt');
    expect(read(b, 3)).toEqual([E.SUCCESS, 'HEl']);
    expect(read(a, 2)).toEqual([E.SUCCESS, 'll']);
    // O_TRUNC through one truncates what the other sees.
    const [, c] = open('a.txt', OFLAGS.TRUNC, RIGHTS.ALL);
    call('fd_close', c);
    expect(read(b, 10)).toEqual([E.SUCCESS, '']);
  });

  it('renaming a directory retargets the files open beneath it', () => {
    const { open, write, call, fs, path, g } = setup();
    fs.dir('/workspace/p/d').file('/workspace/p/d/f.txt', 'x');
    const [, f] = open('d/f.txt');
    const [to, tl] = g.str('e');
    expect(path(3, 'd', 'path_rename', 3, to, tl)).toBe(E.SUCCESS);
    // Written after the move: the write-back must go where the file is now.
    write(f, 'Y');
    call('fd_close', f);
    expect(fs.text('/workspace/p/e/f.txt')).toBe('Y');
    expect(fs.exists('/workspace/p/d/f.txt')).toBe(false);
  });

  it('renaming over a file that is open detaches that handle: its close does not overwrite', () => {
    const { open, write, call, fs, path, g } = setup();
    fs.file('/workspace/p/b.txt', 'bbb');
    const [, old] = open('b.txt');
    write(old, 'OLD');
    const [to, tl] = g.str('b.txt');
    expect(path(3, 'a.txt', 'path_rename', 3, to, tl)).toBe(E.SUCCESS);
    call('fd_close', old);
    expect(fs.text('/workspace/p/b.txt')).toBe('hello\n');
  });

  it('a failed unlink leaves open handles writing back', () => {
    const { open, write, call, fs, path } = setup();
    const [, fd] = open('a.txt');
    (fs as unknown as { unlink: () => never }).unlink = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(path(3, 'a.txt', 'path_unlink_file')).toBe(E.ACCES);
    write(fd, 'K');
    call('fd_close', fd);
    expect(fs.text('/workspace/p/a.txt')).toBe('Kello\n');
  });

  it('fd_pread / fd_pwrite honor the access mode (EBADF)', () => {
    const { open, call, g } = setup();
    const out = g.alloc(4);
    const [, wo] = open('a.txt', 0, RIGHTS.FD_WRITE);
    const [iov, n] = g.iov(4);
    expect(call('fd_pread', wo, iov, n, 0n, out)).toBe(E.BADF);
    const [, ro] = open('a.txt', 0, RIGHTS.FD_READ);
    const [wiov, wn] = g.iov('Z');
    expect(call('fd_pwrite', ro, wiov, wn, 0n, out)).toBe(E.BADF);
  });

  it('proc_raise maps every WASI signal to its POSIX number; an unknown one is EINVAL', () => {
    const { call, kernel } = setup();
    call('proc_raise', 27); // WASI SIGWINCH
    call('proc_raise', 20); // WASI SIGTTIN
    call('proc_raise', 30); // WASI SIGSYS
    expect(kernel.killed).toEqual([
      [9, 28],
      [9, 21],
      [9, 31],
    ]);
    expect(call('proc_raise', 31)).toBe(E.INVAL);
    expect(call('proc_raise', 0)).toBe(E.INVAL);
  });
});

describe('WasiHost: sockets (5b)', () => {
  /** A host whose fd 3 was a non-blocking listening socket (it moves above the preopens). */
  function listening(conns: string[][] = []) {
    const kernel = new FakeKernel();
    const l = kernel.add(3, 'socket');
    l.pending = conns;
    const fs = new FakeFs().dir('/w');
    const host = new WasiHost({
      args: ['p'],
      env: { SLICC_LISTEN_FDS: 'stale' },
      cwd: '/w',
      pid: 9,
      kernel,
      fs,
      inherited: [{ fd: 3, kind: 'socket', flags: 0o4000 }],
    });
    const g = new Guest();
    host.mem.bind(g.memory);
    const imports = host.imports() as Record<string, (...a: Array<number | bigint>) => number>;
    const call: Call = (name, ...args) => imports[name](...args);
    // Where the listener went: the fd whose kernel entry it is.
    const fd = [...kernel.table].find(([, e]) => e === l)?.[0] as number;
    return { kernel, host, g, call, fd };
  }

  it('names the inherited listener’s new number in $SLICC_LISTEN_FDS, over a stale one', () => {
    const { call, g, fd } = listening();
    const count = g.alloc(4);
    const size = g.alloc(4);
    call('environ_sizes_get', count, size);
    const env = g.alloc(g.u32(size));
    call('environ_get', g.alloc(g.u32(count) * 4), env);
    expect(g.read(env, g.u32(size))).toContain(`SLICC_LISTEN_FDS=${fd}\0`);
  });

  it('accepts (EAGAIN while none waits, the listener being non-blocking), receives, peeks, sends, shuts down', () => {
    const { call, g, kernel, fd } = listening();
    const out = g.alloc(4);
    expect(call('sock_accept', fd, 0, out)).toBe(E.AGAIN);
    (kernel.table.get(fd) as { pending?: string[][] }).pending = [['GET / HTTP/1.0\r\n']];
    expect(call('sock_accept', fd, FDFLAGS.NONBLOCK, out)).toBe(E.SUCCESS);
    const conn = g.u32(out);
    const [iov, n, buf] = g.iov(4);
    const len = g.alloc(4);
    const flags = g.alloc(2);
    expect(call('sock_recv', conn, iov, n, RIFLAGS.PEEK, len, flags)).toBe(E.SUCCESS);
    expect(g.read(buf, g.u32(len))).toBe('GET ');
    const [wiov, wn] = g.iov('HTTP/1.0 200 OK\r\n');
    expect(call('sock_send', conn, wiov, wn, 0, len)).toBe(E.SUCCESS);
    expect(g.u32(len)).toBe(17);
    expect(kernel.out(conn)).toBe('HTTP/1.0 200 OK\r\n');
    expect(call('sock_shutdown', conn, SDFLAGS.WR)).toBe(E.SUCCESS);
    expect(call('sock_shutdown', conn, SDFLAGS.RD | SDFLAGS.WR)).toBe(E.SUCCESS);
    expect(call('sock_shutdown', conn, SDFLAGS.RD)).toBe(E.SUCCESS);
    expect(kernel.table.get(conn)?.shut).toEqual([1, 2, 0]);
    expect(call('sock_shutdown', conn, 0)).toBe(E.INVAL);
    expect(call('sock_shutdown', conn, 4)).toBe(E.INVAL);
    // The accepted socket is a kernel socket (fdstat) and non-blocking as asked.
    const st = g.alloc(SIZE.FDSTAT);
    call('fd_fdstat_get', conn, st);
    expect(g.view.getUint8(st)).toBe(FILETYPE.SOCKET_STREAM);
    expect(g.view.getUint16(st + 2, true) & FDFLAGS.NONBLOCK).toBe(FDFLAGS.NONBLOCK);
  });

  it('MSG_WAITALL reads until the buffer is full or the peer is done', () => {
    const { call, g, kernel, fd } = listening([['ab', 'cd', 'e']]);
    const out = g.alloc(4);
    call('sock_accept', fd, 0, out);
    const conn = g.u32(out);
    const [iov, n, buf] = g.iov(4);
    const len = g.alloc(4);
    call('sock_recv', conn, iov, n, RIFLAGS.WAITALL, len, g.alloc(2));
    expect(g.read(buf, g.u32(len))).toBe('abcd');
    call('sock_recv', conn, iov, n, RIFLAGS.WAITALL, len, g.alloc(2));
    expect(g.read(buf, g.u32(len))).toBe('e');
    void kernel;
  });

  it('MSG_WAITALL keeps what it read when a later read fails (EAGAIN, EINTR): a short count, no error', () => {
    for (const drained of ['EAGAIN', 'EINTR']) {
      const { call, g, kernel, fd } = listening([['ab']]);
      const out = g.alloc(4);
      call('sock_accept', fd, 0, out);
      const conn = g.u32(out);
      (kernel.table.get(conn) as { drained?: string }).drained = drained;
      const [iov, n, buf] = g.iov(4);
      const len = g.alloc(4);
      expect(call('sock_recv', conn, iov, n, RIFLAGS.WAITALL, len, g.alloc(2))).toBe(E.SUCCESS);
      expect(g.read(buf, g.u32(len))).toBe('ab');
    }
  });

  it('MSG_WAITALL fills a buffer larger than one read (1 MiB), each kernel read within that cap', () => {
    const MiB = 1024 * 1024;
    const { call, g, kernel, fd } = listening([['a'.repeat(MiB), 'b'.repeat(MiB / 2)]]);
    const out = g.alloc(4);
    call('sock_accept', fd, 0, out);
    const conn = g.u32(out);
    const [iov, n, buf] = g.iov(MiB + MiB / 2);
    const len = g.alloc(4);
    expect(call('sock_recv', conn, iov, n, RIFLAGS.WAITALL, len, g.alloc(2))).toBe(E.SUCCESS);
    expect(g.u32(len)).toBe(MiB + MiB / 2);
    expect(g.read(buf + MiB, 1)).toBe('b');
    expect(Math.max(...(kernel.table.get(conn)?.reads ?? []))).toBeLessThanOrEqual(MiB);
  });

  it('a peer gone is EPIPE for sock_send (no SIGPIPE); a socket call on a non-socket is ENOTSOCK', () => {
    const { call, g, kernel, fd } = listening([['x']]);
    const out = g.alloc(4);
    call('sock_accept', fd, 0, out);
    const conn = g.u32(out);
    (kernel.table.get(conn) as { broken?: boolean }).broken = true;
    const [iov, n] = g.iov('y');
    expect(call('sock_send', conn, iov, n, 0, out)).toBe(E.PIPE);
    expect(call('sock_recv', 1, iov, n, 0, out, out)).toBe(E.NOTSOCK);
    expect(call('sock_accept', 3, 0, out)).toBe(E.NOTSOCK); // fd 3 is `.`
  });

  it('poll_oneoff flags a hangup on an fd event', () => {
    const { call, g, kernel } = setup();
    (kernel.table.get(0) as { hangup?: boolean }).hangup = true;
    const subs = g.alloc(SIZE.SUBSCRIPTION);
    const events = g.alloc(SIZE.EVENT);
    const n = g.alloc(4);
    g.view.setBigUint64(subs, 5n, true);
    g.view.setUint8(subs + 8, EVENTTYPE.FD_READ);
    g.view.setUint32(subs + 16, 0, true);
    expect(call('poll_oneoff', subs, events, 1, n)).toBe(E.SUCCESS);
    expect(g.u32(n)).toBe(1);
    expect(g.view.getUint16(events + 24, true)).toBe(EVENT_FD_READWRITE_HANGUP);
  });
});

describe("WasiHost: a threaded process's files are kernel descriptions (5d)", () => {
  function threaded() {
    const s = setup();
    s.host.fds.share(new Int32Array(new SharedArrayBuffer(16)), false);
    return s;
  }

  it('pread, pwrite, allocate, set_size and filestat reach the description', () => {
    const { call, g, open, kernel } = threaded();
    const [errno, fd] = open('a.txt');
    expect(errno).toBe(E.SUCCESS);
    expect(kernel.opened).toEqual(['/workspace/p/a.txt']);
    const [iov, n] = g.iov('hello');
    const out = g.alloc(8);
    expect(call('fd_pwrite', fd, iov, n, 2n, out)).toBe(E.SUCCESS);
    expect(g.u32(out)).toBe(5);
    const [riov, rn, buf] = g.iov(3);
    expect(call('fd_pread', fd, riov, rn, 3n, out)).toBe(E.SUCCESS);
    expect(g.read(buf, g.u32(out))).toBe('ell');
    expect(call('fd_allocate', fd, 0n, 9n)).toBe(E.SUCCESS);
    const st = g.alloc(SIZE.FILESTAT);
    expect(call('fd_filestat_get', fd, st)).toBe(E.SUCCESS);
    expect(g.view.getUint8(st + 16)).toBe(FILETYPE.REGULAR_FILE);
    expect(g.u64(st + 32)).toBe(9n);
    expect(call('fd_filestat_set_size', fd, 4n)).toBe(E.SUCCESS);
    call('fd_filestat_get', fd, st);
    expect(g.u64(st + 32)).toBe(4n);
  });

  it("an unlink, a rename and a path's stat tell the kernel, whose descriptions hold the bytes", () => {
    const { kernel, open, path, g, call } = threaded();
    open('a.txt');
    const [p, l] = g.str('a.txt');
    expect(call('path_filestat_get', 3, 1, p, l, g.alloc(SIZE.FILESTAT))).toBe(E.SUCCESS);
    const [to, tl] = g.str('b.txt');
    expect(path(3, 'a.txt', 'path_rename', 3, to, tl)).toBe(E.SUCCESS);
    expect(path(3, 'b.txt', 'path_unlink_file')).toBe(E.SUCCESS);
    expect(kernel.calls.filter((c) => c.op.startsWith('fd-path-'))).toEqual([
      { op: 'fd-path-flush', path: '/workspace/p/a.txt' },
      { op: 'fd-path-flush', path: '/workspace/p/a.txt' },
      { op: 'fd-path-renamed', from: '/workspace/p/a.txt', to: '/workspace/p/b.txt' },
      { op: 'fd-path-unlinking', path: '/workspace/p/b.txt' },
      { op: 'fd-path-unlinked', path: '/workspace/p/b.txt' },
    ]);
  });
});
