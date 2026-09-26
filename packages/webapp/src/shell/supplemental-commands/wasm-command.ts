/**
 * `wasm` — run an Emscripten program in the wasm realm (#3530). The
 * implementation (worker, kernel descriptors, compile cache) loads on first
 * use: see `wasm/run.ts`.
 */
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createWasmCommand(): Command {
  return defineCommand('wasm', async (args, ctx) => {
    const { runWasmCommand } = await import('./wasm/run.js');
    return runWasmCommand(args, ctx);
  });
}
