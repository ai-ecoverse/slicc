/**
 * The WASIX host's imports (#3530 phase 5c), in-process over the fake kernel
 * and sync-fs bridge (`fakes.ts`): the preview1 calls a WASIX program means
 * differently, the exec generations, a forked child's descriptor table.
 * Real programs (fork, exec, bash, python): `../wasix-programs.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { E, OFLAGS, RIGHTS } from '../../../../src/kernel/wasm-realm/wasi/wasi-abi.js';
import { WasiExit, WasiHost } from '../../../../src/kernel/wasm-realm/wasi/wasi-host.js';
import { importedMemory } from '../../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { AsyncifyDriver } from '../../../../src/kernel/wasm-realm/wasi/wasix-fork.js';
import { COMPAT, WasixHost } from '../../../../src/kernel/wasm-realm/wasi/wasix-host.js';
import { FakeFs, FakeKernel, Guest } from './fakes.js';

type Imports = Record<string, (...a: Array<number | bigint>) => number>;

function setup(
  opts: { wasix?: boolean; forked?: ConstructorParameters<typeof WasiHost>[0]['forked'] } = {}
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
  const g = new Guest();
  host.mem.bind(g.memory);
  const wasix = new WasixHost(host, new AsyncifyDriver(host.mem));
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
