/**
 * The WASIX dynamic linker's parts (#3530 phase 5g), in-process: `dylink.0`
 * parsing, side-module loading against a stand-in main module, dlsym, the
 * failures dlopen reports, and replaying another instance's records. The
 * whole thing over the kernel: `../wasix-dylink.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dylinkInfo } from '../../../../src/kernel/wasm-realm/wasi/dylink.js';
import {
  DlError,
  type LinkRecord,
  WasixLinker,
} from '../../../../src/kernel/wasm-realm/wasi/wasix-linker.js';

const FIXTURES = new URL('../../../fixtures/wasm-wasi/dylink/', import.meta.url).pathname;
const bytes = (name: string) => new Uint8Array(readFileSync(`${FIXTURES}${name}`));

/** A linker over `files`, with a stand-in main module exporting the libc symbols libb imports. */
function setup(files: Record<string, Uint8Array>, shared?: WebAssembly.Memory) {
  const thread = shared !== undefined;
  const memory = shared ?? new WebAssembly.Memory({ initial: 2, maximum: 1024, shared: true });
  const records: LinkRecord[] = [];
  const linker = new WasixLinker(
    memory,
    { memorySize: 1024, memoryAlign: 4, tableSize: 0, tableAlign: 0, needed: [] },
    {
      read: (path) => files[path] as Uint8Array<ArrayBuffer> | undefined,
      hostImports: () => ({}),
    },
    thread
  );
  linker.publisher = (r) => void records.push(r);
  let heap = 1 << 20;
  const main = {
    exports: {
      malloc: (n: number) => {
        const at = heap;
        heap += n;
        return at;
      },
      snprintf: () => 0,
    },
  } as unknown as WebAssembly.Instance;
  linker.bindMain(main, false);
  return { linker, memory, records };
}

describe('dylink.0', () => {
  it('reads a side module’s memory and table needs and what it needs loaded first', () => {
    const b = dylinkInfo(new WebAssembly.Module(bytes('libb.so')));
    expect(b?.needed).toEqual(['liba.so']);
    expect(b?.memorySize).toBeGreaterThan(0);
    expect(dylinkInfo(new WebAssembly.Module(bytes('liba.so')))?.needed).toEqual([]);
    // A module that is not position-independent has none.
    expect(
      dylinkInfo(new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])))
    ).toBeUndefined();
  });
});

describe('WasixLinker', () => {
  it('loads a library after what it needs, constructed; dlsym answers slots and addresses', () => {
    const { linker, memory, records } = setup({
      '/l/libb.so': bytes('libb.so'),
      '/l/liba.so': bytes('liba.so'),
    });
    const handle = linker.open('/l/libb.so', '/', []);
    // liba first (found beside libb), then libb.
    expect(
      records.filter((r) => r.kind === 'load').map((r) => (r as { path: string }).path)
    ).toEqual(['/l/liba.so', '/l/libb.so']);
    const bump = linker.table.get(linker.symbol(handle, 'a_bump')) as (n: number) => number;
    // liba's constructor ran (a_bump answers -1 before it).
    expect(bump(2)).toBe(42);
    const counter = linker.symbol(handle, 'a_counter');
    expect(new DataView(memory.buffer).getInt32(counter, true)).toBe(42);
    // The same function, the same slot.
    expect(linker.symbol(0, 'a_bump')).toBe(linker.symbol(handle, 'a_bump'));
    expect(linker.open('/l/libb.so', '/', [])).toBe(handle);
  });

  it('reports what went wrong: no file, no wasm, no dylink.0, a needed library missing, an unknown symbol', () => {
    const plain = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const { linker } = setup({
      '/x.so': new Uint8Array([1, 2, 3]),
      '/plain.so': plain,
      '/l/libb.so': bytes('libb.so'),
    });
    expect(() => linker.open('/nope.so', '/', [])).toThrow(DlError);
    expect(() => linker.open('/x.so', '/', [])).toThrow(/not a wasm module/);
    expect(() => linker.open('/plain.so', '/', [])).toThrow(/not a side module/);
    expect(() => linker.open('/l/libb.so', '/', [])).toThrow(/liba\.so: not found/);
    expect(() => linker.open('libz.so', '/', ['/l'])).toThrow(/libz\.so: not found/);
    const ok = setup({ '/usr/lib/liba.so': bytes('liba.so') }).linker;
    const h = ok.open('liba.so', '/', []);
    expect(() => ok.symbol(h, 'no_such')).toThrow(/undefined symbol: no_such/);
    expect(ok.invalid(h)).toBe(false);
    expect(ok.invalid(99)).toBe(true);
  });

  it('another instance (a thread) replays the loads and slots: the same table, slot for slot', () => {
    const files = { '/l/libb.so': bytes('libb.so'), '/l/liba.so': bytes('liba.so') };
    const first = setup(files);
    const handle = first.linker.open('/l/libb.so', '/', []);
    const slot = first.linker.symbol(handle, 'b_twice');
    // A thread shares the process's memory; its table and instances are its own.
    const second = setup(files, first.memory);
    for (const r of first.records) second.linker.replay(r);
    expect(second.linker.table.length).toBe(first.linker.table.length);
    expect(typeof second.linker.table.get(slot)).toBe('function');
    expect(second.linker.invalid(handle)).toBe(false);
  });

  it('a thread links the modules the process compiled: no VFS read, no recompile', () => {
    const files = { '/l/libb.so': bytes('libb.so'), '/l/liba.so': bytes('liba.so') };
    const first = setup(files);
    const handle = first.linker.open('/l/libb.so', '/', []);
    const slot = first.linker.symbol(handle, 'b_twice');
    const compiled = first.linker.compiled();
    expect(Object.keys(compiled).sort()).toEqual(['/l/liba.so', '/l/libb.so']);
    expect(compiled['/l/libb.so']).toBeInstanceOf(WebAssembly.Module);
    // The files are gone for the thread: it links what it was handed.
    const second = setup({}, first.memory);
    second.linker.cache = compiled;
    for (const r of first.records) second.linker.replay(r);
    expect(typeof second.linker.table.get(slot)).toBe('function');
    expect(second.linker.invalid(handle)).toBe(false);
  });
});
