/**
 * The WASI host's smaller parts: errno mapping, paths, the buffered file,
 * the stat cache, and which modules the preview1 runtime refuses.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E, wasiErrnoOf } from '../../../../src/kernel/wasm-realm/wasi/wasi-abi.js';
import { WasiFds } from '../../../../src/kernel/wasm-realm/wasi/wasi-fds.js';
import {
  cachingBridge,
  FileBuffer,
  LocalFile,
  normalize,
  pathInode,
  resolveUnder,
} from '../../../../src/kernel/wasm-realm/wasi/wasi-files.js';
import { importedMemory } from '../../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import {
  captureBacktraces,
  createImportedMemory,
  FALLBACK_MAXIMUM_PAGES,
  trapMessage,
  unsupportedImport,
} from '../../../../src/kernel/wasm-realm/wasi/wasi-runtime.js';
import { WasiThreads } from '../../../../src/kernel/wasm-realm/wasi/wasi-threads.js';
import { FakeFs, FakeKernel } from './fakes.js';

describe('wasiErrnoOf', () => {
  it('maps POSIX names to WASI numbers, with the aliases and EIO for the unknown', () => {
    expect(wasiErrnoOf('ENOENT')).toBe(E.NOENT);
    expect(wasiErrnoOf('EPIPE')).toBe(E.PIPE);
    expect(wasiErrnoOf('EOPNOTSUPP')).toBe(E.NOTSUP);
    expect(wasiErrnoOf('EWOULDBLOCK')).toBe(E.AGAIN);
    expect(wasiErrnoOf('ETXTBSY')).toBe(E.IO);
    expect(wasiErrnoOf(undefined)).toBe(E.IO);
  });
});

describe('paths', () => {
  it('normalize drops `.`, `..` and empty segments and never climbs above /', () => {
    expect(normalize('/a/./b//c/../d')).toBe('/a/b/d');
    expect(normalize('/../..')).toBe('/');
    expect(resolveUnder('/w/p', 'x/../y')).toBe('/w/p/y');
    expect(resolveUnder('/w/p', '/abs')).toBe('/abs');
  });

  it('pathInode is stable per path and differs between paths', () => {
    expect(pathInode('/a')).toBe(pathInode('/a'));
    expect(pathInode('/a')).not.toBe(pathInode('/b'));
  });
});

describe('LocalFile', () => {
  it('loads on first use, zero-fills a gap, and writes back only what changed', () => {
    const fs = new FakeFs().file('/f', 'abc');
    const f = new LocalFile(new FileBuffer(fs, '/f', false), true, true, false);
    expect(fs.ops).toEqual([]);
    f.flush(); // nothing loaded, nothing to write
    expect(fs.ops).toEqual([]);
    f.pwrite(new TextEncoder().encode('Z'), 5);
    expect(f.size()).toBe(6);
    f.flush();
    expect(fs.text('/f')).toBe('abc\0\0Z');
    const writes = fs.ops.filter((op) => op.startsWith('write')).length;
    f.flush();
    expect(fs.ops.filter((op) => op.startsWith('write')).length).toBe(writes);
  });

  it('a new (or truncated) file starts empty without reading the old bytes', () => {
    const fs = new FakeFs().file('/f', 'old');
    const f = new LocalFile(new FileBuffer(fs, '/f', true), true, true, false);
    expect(f.read(10)).toEqual(new Uint8Array(0));
    f.flush();
    expect(fs.text('/f')).toBe('');
    expect(fs.ops.some((op) => op.startsWith('read'))).toBe(false);
  });
});

describe('cachingBridge', () => {
  it('answers stat, lstat and exists from its cache, errors included', () => {
    const fs = new FakeFs().file('/f', 'x');
    const cached = cachingBridge(fs);
    cached.stat('/f');
    cached.stat('/f');
    cached.lstat('/f');
    expect(cached.exists('/f')).toBe(true);
    expect(fs.ops.filter((op) => op === 'stat /f')).toHaveLength(1);
    expect(() => cached.stat('/missing')).toThrow('ENOENT');
    expect(cached.exists('/missing')).toBe(false);
    expect(fs.ops.filter((op) => op === 'stat /missing')).toHaveLength(1);
  });

  it('forgets everything after any mutation, even a failed one, and on invalidate()', () => {
    const fs = new FakeFs().file('/f', 'x');
    const cached = cachingBridge(fs);
    cached.stat('/f');
    cached.writeFile('/g', new Uint8Array(1));
    cached.stat('/f');
    expect(fs.ops.filter((op) => op === 'stat /f')).toHaveLength(2);
    expect(() => cached.rename('/missing', '/x')).toThrow('ENOENT');
    cached.stat('/f');
    cached.invalidate();
    cached.stat('/f');
    expect(fs.ops.filter((op) => op === 'stat /f')).toHaveLength(4);
    for (const op of ['unlink', 'mkdir', 'rmdir', 'rm'] as const) cached[op]('/g');
    cached.symlink('/f', '/l');
    cached.chmod('/f', 0o644);
    cached.utimes('/f', 1, 2);
    expect(cached.readFile('/f')).toEqual(new TextEncoder().encode('x'));
  });
});

/** A module with the given imports (func `() -> ()` or a memory) and exports (funcs). */
function module(
  imports: Array<[string, string, 'func' | 'memory']>,
  exports: string[]
): WebAssembly.Module {
  const enc = new TextEncoder();
  const str = (s: string) => [s.length, ...enc.encode(s)];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  const types = section(1, [1, 0x60, 0, 0]);
  const imp = section(2, [
    imports.length,
    ...imports.flatMap(([m, n, kind]) =>
      kind === 'func' ? [...str(m), ...str(n), 0, 0] : [...str(m), ...str(n), 2, 0, 1]
    ),
  ]);
  const funcs = section(3, [exports.length, ...exports.map(() => 0)]);
  const nImportedFuncs = imports.filter(([, , k]) => k === 'func').length;
  const exp = section(7, [
    exports.length,
    ...exports.flatMap((name, i) => [...str(name), 0, nImportedFuncs + i]),
  ]);
  const code = section(10, [exports.length, ...exports.flatMap(() => [2, 0, 0x0b])]);
  return new WebAssembly.Module(
    new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...imp, ...funcs, ...exp, ...code])
  );
}

describe('unsupportedImport', () => {
  const P1 = 'wasi_snapshot_preview1';
  it('accepts a preview1 command', () => {
    expect(unsupportedImport(module([[P1, 'fd_write', 'func']], ['_start']))).toBeUndefined();
  });

  it('accepts functions from a namespace it does not provide in a WASI program (they answer ENOSYS)', () => {
    const probe: [string, string, 'func'] = ['acme_host', 'probe', 'func'];
    expect(
      unsupportedImport(module([[P1, 'fd_write', 'func'], probe], ['_start']))
    ).toBeUndefined();
    expect(
      unsupportedImport(module([['wasix_32v1', 'proc_fork', 'func'], probe], ['_start']))
    ).toBeUndefined();
    expect(unsupportedImport(module([probe], ['_start']))).toContain(
      'imports acme_host.probe: no WASI preview1 program'
    );
  });

  it('accepts WASIX, with the memory the kernel recorded and its thread-spawn', () => {
    const memory = { module: 'env', name: 'memory', initial: 2, shared: true };
    const wasix = module(
      [
        ['wasix_32v1', 'proc_fork', 'func'],
        ['env', 'memory', 'memory'],
        ['wasi', 'thread-spawn', 'func'],
      ],
      ['_start']
    );
    expect(unsupportedImport(wasix, memory)).toBeUndefined();
    // A memory nobody recorded is still refused.
    expect(unsupportedImport(wasix)).toContain('imports env.memory');
  });

  it('a PIE main module may import env functions (undefined symbols a side module or nobody defines)', () => {
    const bytes = readFileSync(
      new URL('../../../fixtures/wasm-wasi/dylink/weakmain.wasm', import.meta.url)
    );
    const module = new WebAssembly.Module(bytes);
    expect(unsupportedImport(module, importedMemory(bytes))).toBeUndefined();
  });

  it('accepts wasm32-wasip1-threads on the shared memory the kernel recorded (5d)', () => {
    const memory = { module: 'env', name: 'memory', initial: 17, shared: true };
    const threaded = module(
      [
        [P1, 'fd_write', 'func'],
        ['env', 'memory', 'memory'],
        ['wasi', 'thread-spawn', 'func'],
      ],
      ['_start']
    );
    expect(unsupportedImport(threaded, memory)).toBeUndefined();
    expect(unsupportedImport(threaded, { ...memory, shared: false })).toContain(
      'imports wasi.thread-spawn'
    );
  });

  it('refuses an unrecorded memory, a thread spawn without one, glue imports and reactors, saying which', () => {
    expect(unsupportedImport(module([['env', 'memory', 'memory']], ['_start']))).toContain(
      'imports env.memory'
    );
    expect(unsupportedImport(module([['wasi', 'thread-spawn', 'func']], ['_start']))).toContain(
      'imports wasi.thread-spawn'
    );
    expect(unsupportedImport(module([['a', 'a', 'func']], ['_start']))).toContain(
      'imports a.a: no WASI preview1 program'
    );
    expect(
      unsupportedImport(
        module(
          [
            [P1, 'fd_write', 'func'],
            ['env', 'abort', 'func'],
          ],
          ['_start']
        )
      )
    ).toContain('imports env.abort: no WASI preview1 program');
    expect(unsupportedImport(module([[P1, 'fd_write', 'func']], ['_initialize']))).toContain(
      'no _start'
    );
  });
});

describe('WasiFds shared by threads (5d)', () => {
  /** Two threads' tables over one kernel: A the main thread (sharing once it spawns), B a new thread. */
  function twoThreads() {
    const kernel = new FakeKernel();
    const fs = new FakeFs().dir('/workspace').dir('/tmp').file('/workspace/a.txt', 'a');
    const a = new WasiFds(kernel, fs);
    a.setup('/workspace', []);
    const ids = new Int32Array(new SharedArrayBuffer(16));
    a.share(ids, false);
    const b = new WasiFds(kernel, fs);
    b.share(ids, true);
    return { kernel, a, b };
  }

  it("a terminal one thread opened is the other's too (tty_get / tty_set find it)", () => {
    const { kernel, a, b } = twoThreads();
    kernel.tty = true;
    const fd = a.open('/dev/tty', 0, 0n, 0);
    expect(b.terminals()).toEqual([fd]);
  });

  it('a new thread finds the preopens, and `.`, through the kernel', () => {
    const { b } = twoThreads();
    expect(b.cwd()).toBe('/workspace');
    expect(b.preopen(5)).toMatchObject({ path: '/tmp', preopen: '/tmp' });
  });

  it("one thread's chdir, close and reopen are the other's: nothing stale is kept", () => {
    const { a, b } = twoThreads();
    const fd = a.open('/tmp', 0, 0n, 0);
    expect(b.dir(fd).path).toBe('/tmp'); // B caches it now
    a.chdir('/tmp');
    expect(b.cwd()).toBe('/tmp');
    a.close(fd);
    expect(a.open('/dev/null', 0, 0n, 0)).toBe(fd); // the same number, another kind
    expect(b.find(fd)).toEqual({ type: 'device', device: 'null' });
  });

  it("a file is a kernel description once shared (every thread reaches it), and FD_CLOEXEC is the kernel's", () => {
    const { kernel, a, b } = twoThreads();
    const fd = b.open('/workspace/a.txt', 0, 0n, 0);
    expect(kernel.opened).toEqual(['/workspace/a.txt']);
    expect(a.find(fd)).toMatchObject({ type: 'kernel', kind: 'file' });
    b.setCloexec(fd, true);
    expect(a.inheritable().has(fd)).toBe(false);
    expect(a.inheritable().has(1)).toBe(true);
  });
});

describe('WasiThreads.spawn', () => {
  it("hands the new thread the process's memory, ids and compiled side modules", () => {
    const posted: Array<{ type: string; thread?: Record<string, unknown> }> = [];
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const threads = new WasiThreads({ postMessage: (m) => posted.push(m as never) }, memory, 4, 1);
    const plain = threads.spawn(7);
    const lib = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    threads.modules = () => ({ '/lib/libm.so': lib });
    const linked = threads.spawn(8);
    expect([plain, linked]).toEqual([2, 3]);
    expect(posted[0]?.thread).not.toHaveProperty('modules');
    expect(posted[1]?.thread).toMatchObject({
      tid: 3,
      arg: 8,
      memory,
      modules: { '/lib/libm.so': lib },
    });
  });
});

describe('trapMessage', () => {
  const trap = () => {
    const e = new WebAssembly.RuntimeError('unreachable');
    e.stack = [
      'RuntimeError: unreachable',
      '    at debug.defaultPanic (wasm://wasm/00ce402e:wasm-function[2560]:0x24b977)',
      '    at Build.Step.zigProcessUpdate (wasm://wasm/00ce402e:wasm-function[1674]:0x196785)',
    ].join('\n');
    return e;
  };

  it('is the message alone by default', () => {
    expect(trapMessage(trap(), {})).toBe('wasm trap: unreachable');
  });

  it('names the frames of a module shipped without its name section from its sidecar', () => {
    const e = new WebAssembly.RuntimeError('unreachable');
    e.stack = [
      'RuntimeError: unreachable',
      '    at wasm://wasm/0a1b2c3d:wasm-function[12]:0x40',
      '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[12]:0x10',
      '    at wasm://wasm/0a1b2c3d:wasm-function[7]:0x80',
      '    at runWasiProcess (worker.js:1:2)',
    ].join('\n');
    const name = (i: number) => (i === 12 ? 'rustc_driver::run' : undefined);
    expect(trapMessage(e, { SLICC_WASM_BACKTRACE: '1' }, '', name).split('\n').slice(1)).toEqual([
      '    at rustc_driver::run (wasm://wasm/0a1b2c3d:wasm-function[12]:0x40)',
      // A side module's function 12 is not the main module's.
      '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[12]:0x10',
      '    at wasm://wasm/0a1b2c3d:wasm-function[7]:0x80',
    ]);
    // Without SLICC_WASM_BACKTRACE nothing is named (nor read).
    expect(trapMessage(e, {}, '', name)).toBe('wasm trap: unreachable');
  });

  it('names nothing when the stack is cut short above the main module’s entry', () => {
    const e = new WebAssembly.RuntimeError('unreachable');
    e.stack = [
      'RuntimeError: unreachable',
      '    at wasm://wasm/0a1b2c3d:wasm-function[12]:0x40',
      '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[12]:0x10',
    ].join('\n');
    const name = vi.fn((i: number) => (i === 12 ? 'rustc_driver::run' : undefined));
    expect(trapMessage(e, { SLICC_WASM_BACKTRACE: '1' }, '', name).split('\n').slice(1)).toEqual([
      '    at wasm://wasm/0a1b2c3d:wasm-function[12]:0x40',
      '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[12]:0x10',
    ]);
    expect(name).not.toHaveBeenCalled();
  });

  it("shows the program's wasm frames, not the runtime's JS ones under them", () => {
    const e = trap();
    e.stack += [
      '',
      '    at runWasiProcess (http://localhost/assets/wasi-runtime-X.js:1:2000)',
      '    at async http://localhost/assets/process-worker-Y.js:1:300',
    ].join('\n');
    const lines = trapMessage(e, { SLICC_WASM_BACKTRACE: '1' }).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((line) => line.includes('wasm://wasm/'))).toBe(true);
  });

  it('captureBacktraces raises the stack limit only when asked', () => {
    const before = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 10;
      captureBacktraces({});
      expect(Error.stackTraceLimit).toBe(10);
      captureBacktraces({ SLICC_WASM_BACKTRACE: '1' });
      expect(Error.stackTraceLimit).toBeGreaterThanOrEqual(40);
    } finally {
      Error.stackTraceLimit = before;
    }
  });

  it('adds the wasm frames with SLICC_WASM_BACKTRACE=1, naming a thread', () => {
    expect(trapMessage(trap(), { SLICC_WASM_BACKTRACE: '1' }, ' in thread 2')).toBe(
      [
        'wasm trap in thread 2: unreachable',
        '    at debug.defaultPanic (wasm://wasm/00ce402e:wasm-function[2560]:0x24b977)',
        '    at Build.Step.zigProcessUpdate (wasm://wasm/00ce402e:wasm-function[1674]:0x196785)',
      ].join('\n')
    );
  });
});

describe('createImportedMemory', () => {
  const RealMemory = WebAssembly.Memory;
  const asked: WebAssembly.MemoryDescriptor[] = [];
  /** An engine that cannot reserve more than `limit` pages, as WebKit on iOS with 4 GiB. */
  const engineCapping = (limit: number, error: Error = new RangeError('Out of memory')) => {
    asked.length = 0;
    const Capped = function (descriptor: WebAssembly.MemoryDescriptor) {
      asked.push(descriptor);
      if ((descriptor.maximum ?? 0) > limit) throw error;
      return new RealMemory(descriptor);
    } as unknown as typeof WebAssembly.Memory;
    WebAssembly.Memory = Capped;
  };
  afterEach(() => {
    WebAssembly.Memory = RealMemory;
  });
  const spec = { module: 'env', name: 'memory', initial: 2, maximum: 65536, shared: true };

  it('reserves the declared maximum when the engine can', () => {
    engineCapping(65536);
    createImportedMemory(spec);
    expect(asked.map((d) => d.maximum)).toEqual([65536]);
  });

  it('falls back to 2 GiB when the declared 4 GiB maximum throws RangeError', () => {
    engineCapping(FALLBACK_MAXIMUM_PAGES);
    const memory = createImportedMemory(spec);
    expect(asked.map((d) => d.maximum)).toEqual([65536, FALLBACK_MAXIMUM_PAGES]);
    expect(asked[1]).toMatchObject({ initial: 2, shared: true });
    expect(memory?.buffer.byteLength).toBe(2 * 65536);
  });

  it('treats a missing maximum as 4 GiB and falls back the same way', () => {
    engineCapping(FALLBACK_MAXIMUM_PAGES);
    createImportedMemory({ ...spec, maximum: undefined });
    expect(asked.map((d) => d.maximum)).toEqual([65536, FALLBACK_MAXIMUM_PAGES]);
  });

  it('rethrows when the maximum is already 2 GiB or less, or the error is not a RangeError', () => {
    engineCapping(1024);
    expect(() => createImportedMemory({ ...spec, maximum: FALLBACK_MAXIMUM_PAGES })).toThrow(
      RangeError
    );
    engineCapping(FALLBACK_MAXIMUM_PAGES, new TypeError('bad descriptor'));
    expect(() => createImportedMemory(spec)).toThrow(TypeError);
  });

  it('copies a forked parent into the fallback memory', () => {
    engineCapping(FALLBACK_MAXIMUM_PAGES);
    const copy = new Uint8Array(3 * 65536).fill(7);
    const memory = createImportedMemory(spec, copy);
    expect(memory?.buffer.byteLength).toBe(3 * 65536);
    expect(new Uint8Array(memory!.buffer)[3 * 65536 - 1]).toBe(7);
  });

  it('has no memory for a module that imports none', () => {
    expect(createImportedMemory(undefined)).toBeUndefined();
  });
});
