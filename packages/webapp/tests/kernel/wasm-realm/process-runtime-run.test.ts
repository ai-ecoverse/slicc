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
});
