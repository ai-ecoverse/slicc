import { describe, expect, it, vi } from 'vitest';

const flush = vi.hoisted(() => vi.fn());
vi.mock('../../../src/kernel/realm/emscripten-vfs-hook.js', () => ({
  mountVfsIntoEmscripten: () => ({ mounted: [], flush, invalidate: vi.fn() }),
}));

import { runWasmProcess } from '../../../src/kernel/wasm-realm/process-runtime.js';
import type { WasmProcessInitMsg } from '../../../src/kernel/wasm-realm/protocol.js';

const NEEDS_IMPORT = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x09,
  0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
]);

function init(module: WebAssembly.Module): WasmProcessInitMsg {
  return {
    type: 'wasm-process-init',
    pid: 1,
    program: { glue: '', module },
    argv0: 'p',
    args: [],
    env: {},
    cwd: '/',
    sab: new SharedArrayBuffer(8192),
  };
}

const port = { postMessage: () => {} };

type FakeModule = {
  instantiateWasm: (imports: object, done: () => void) => object;
  onRuntimeInitialized: () => void;
  FS?: object;
  callMain?: () => number;
  sliccRunMain?: (args: string[]) => number;
  sliccForkChild?: (state: object) => number;
  sliccPid?: number;
};

describe('runWasmProcess', () => {
  it('fails when the module cannot be instantiated, instead of waiting forever', async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const run = runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        (m as FakeModule).instantiateWasm({ env: {} }, () => {});
      },
    });
    await expect(run).rejects.toBeInstanceOf(WebAssembly.LinkError);
  });

  it('flushes the live VFS even when the program traps', async () => {
    flush.mockClear();
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const run = runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule;
        fake.FS = { getStream: () => null };
        fake.callMain = () => {
          throw new WebAssembly.RuntimeError('unreachable');
        };
        fake.onRuntimeInitialized();
      },
    });
    await expect(run).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('returns the status of an exit() (ExitStatus) and flushes', async () => {
    flush.mockClear();
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const code = await runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule;
        fake.FS = { getStream: () => null };
        fake.callMain = () => {
          throw Object.assign(new Error('exit'), { status: 3 });
        };
        fake.onRuntimeInitialized();
      },
    });
    expect(code).toBe(3);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('runs main through sliccRunMain when the program has the fork emulation', async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    let pid: number | undefined;
    const code = await runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule;
        pid = fake.sliccPid;
        fake.FS = { getStream: () => null };
        fake.callMain = () => 1;
        fake.sliccRunMain = (args) => 40 + args.length;
        fake.onRuntimeInitialized();
      },
    });
    expect(code).toBe(40);
    expect(pid).toBe(1);
  });

  it("resumes a forked child from the parent's state on its rebuilt fd table", async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const fork = {
      memory: new Uint8Array(4),
      currData: 8,
      forkSp: 16,
      callStackNames: [[0, 'main']] as Array<[number, string]>,
      ppid: 7,
      cwd: '/w',
      streams: [],
    };
    const resumed: object[] = [];
    const closed: number[] = [];
    const code = await runWasmProcess({ ...init(module), pid: 9, fork }, port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule;
        fake.FS = {
          streams: [{ fd: 0 }, { fd: 1 }],
          getStream: () => null,
          closeStream: (fd: number) => closed.push(fd),
        };
        fake.callMain = () => {
          throw new Error('a forked child never runs main');
        };
        fake.sliccForkChild = (state) => {
          resumed.push(state);
          return 5;
        };
        fake.onRuntimeInitialized();
      },
    });
    expect(code).toBe(5);
    expect(resumed).toEqual([{ ...fork, pid: 9 }]);
    expect(closed).toEqual([0, 1]);
  });

  it("wraps the glue's syscalls in the imports before instantiating, though the glue asks first", async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const fcntl = () => 0;
    const imports = { env: { f: fcntl } };
    let seen: unknown;
    const run = runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule & { sliccSyscalls?: object };

        fake.instantiateWasm(imports, () => {
          seen = imports.env.f;
          fake.FS = { getStream: () => null };
          fake.callMain = () => 0;
          fake.onRuntimeInitialized();
        });
        fake.sliccSyscalls = { fcntl };
      },
    });
    expect(await run).toBe(0);
    expect(seen).toBeTypeOf('function');
    expect(seen).not.toBe(fcntl);
  });

  it('tracks FD_CLOEXEC from before static constructors (preRun)', async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    type S = { fd: number; flags: number; sliccCloexec?: boolean };
    let opened: S | undefined;
    const code = await runWasmProcess(init(module), port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule & { preRun?: Array<(m: object) => void> };
        let next = 3;
        fake.FS = {
          getStream: () => null,
          mkdirTree: () => {},
          chdir: () => {},
          open: (_path: string, flags: number): S => ({ fd: next++, flags }),
          dupStream: (s: S) => ({ ...s, fd: next++ }),
        };
        for (const run of fake.preRun ?? []) run(fake);

        opened = (fake.FS as { open: (p: string, f: number) => S }).open('/etc/x', 0o2000000);
        fake.callMain = () => 0;
        fake.onRuntimeInitialized();
      },
    });
    expect(code).toBe(0);
    expect(opened?.sliccCloexec).toBe(true);
    expect(opened?.flags).toBe(0);
  });

  it('opens the descriptors it starts with by kind, FD_CLOEXEC included', async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    type S = { fd: number; stream_ops: object; sliccKernelFile?: boolean; sliccCloexec?: boolean };
    const streams: Record<number, S> = {};
    let next = 10;
    const code = await runWasmProcess(
      {
        ...init(module),
        fds: [
          { fd: 5, kind: 'file' },
          { fd: 97, kind: 'stream', cloexec: true },
        ],
      },
      port,
      {
        evaluate: (_glue, m) => {
          const fake = m as FakeModule;
          fake.FS = {
            streams: [],
            getStream: (fd: number) => streams[fd] ?? null,
            mkdirTree: () => {},
            cwd: () => '/',
            open: (path: string) =>
              (streams[next] = { fd: next++, path, stream_ops: {}, node: { mode: 0 } } as S),
            dupStream: (s: S, fd: number) => (streams[fd] = { ...s, fd }),
            closeStream: (fd: number) => delete streams[fd],
          };
          fake.callMain = () => 0;
          fake.onRuntimeInitialized();
        },
      }
    );
    expect(code).toBe(0);
    expect(streams[5]?.sliccKernelFile).toBe(true);
    expect([streams[5]?.sliccCloexec, streams[97]?.sliccCloexec]).toEqual([undefined, true]);
  });

  it('fails a fork into a program that cannot resume one', async () => {
    const module = await WebAssembly.compile(NEEDS_IMPORT);
    const fork = { memory: new Uint8Array(0), currData: 0, forkSp: 0, callStackNames: [], ppid: 1 };
    const run = runWasmProcess({ ...init(module), fork }, port, {
      evaluate: (_glue, m) => {
        const fake = m as FakeModule;
        fake.FS = { streams: [], getStream: () => null, closeStream: () => {} };
        fake.callMain = () => 0;
        fake.onRuntimeInitialized();
      },
    });
    await expect(run).rejects.toThrow(/cannot resume a fork/);
  });
});
