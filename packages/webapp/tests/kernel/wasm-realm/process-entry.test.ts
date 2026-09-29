/**
 * What a process worker does with its init message (`process-entry.ts`): run
 * the program, or one thread of it, and report every end — a rejected start
 * included, which would otherwise leave the kernel waiting on the worker.
 */
import { describe, expect, it } from 'vitest';
import { processEntry } from '../../../src/kernel/wasm-realm/process-entry.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_THREAD_INIT,
} from '../../../src/kernel/wasm-realm/protocol.js';

function worker(runtime: Parameters<typeof processEntry>[1]) {
  const said: Array<{ type: string; code?: number; message?: string }> = [];
  const onMessage = processEntry({ postMessage: (m) => said.push(m as never) }, runtime);
  const settled = () => new Promise((r) => setTimeout(r, 0));
  return { said, onMessage, settled };
}

const wasiInit = { type: WASM_PROCESS_INIT, program: { abi: 'wasi' } };

describe('processEntry', () => {
  it("reports a thread whose start rejects as the process's error", async () => {
    const w = worker({
      wasi: async () => ({
        runWasiProcess: async () => 0,
        runWasiThread: async () => {
          throw new Error('instantiate failed');
        },
      }),
    });
    w.onMessage({ type: WASM_THREAD_INIT });
    await w.settled();
    expect(w.said).toEqual([
      { type: WASM_PROCESS_ERROR, message: expect.stringContaining('instantiate failed') },
    ]);
  });

  it('reports a thread runtime that fails to load, and a process exit or error', async () => {
    const fails = worker({ wasi: () => Promise.reject(new Error('chunk load')) });
    fails.onMessage({ type: WASM_THREAD_INIT });
    await fails.settled();
    expect(fails.said).toEqual([
      { type: WASM_PROCESS_ERROR, message: expect.stringContaining('chunk load') },
    ]);

    const runs = worker({
      wasi: async () => ({ runWasiProcess: async () => 3, runWasiThread: async () => {} }),
    });
    runs.onMessage(wasiInit);
    runs.onMessage({ type: WASM_THREAD_INIT });
    runs.onMessage({ type: 'something else' });
    await runs.settled();
    expect(runs.said).toEqual([{ type: WASM_PROCESS_EXIT, code: 3 }]);
  });
});
