/**
 * `wasm` — run an Emscripten program in the wasm realm (#3530). The
 * implementation (worker, kernel descriptors, compile cache) loads on first
 * use: see `wasm/run.ts`.
 */
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { JshProcessConfig } from '../jsh-executor.js';
import type { TerminalPort } from '../terminal-port.js';
import type { NativeGate } from './wasm/launch.js';

export interface WasmCommandOptions {
  /** Registers each process in the process table (`ps`, `kill`), as `node` does. */
  buildProcessConfig?: (env?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
  /** The panel terminal, which `wasm -t` leases for an interactive program. */
  terminal?: TerminalPort;
  /** The shell's command policy, for the programs a wasm process spawns. */
  gate?: NativeGate;
}

export function createWasmCommand(options: WasmCommandOptions = {}): Command {
  return defineCommand('wasm', async (args, ctx) => {
    const { runWasmCommand } = await import('./wasm/run.js');
    return runWasmCommand(args, ctx, {
      processConfig: options.buildProcessConfig?.(ctx.env),
      terminal: options.terminal,
      gate: options.gate,
    });
  });
}
