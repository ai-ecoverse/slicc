import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { JshProcessConfig } from '../jsh-executor.js';

export interface WasmCommandOptions {
  buildProcessConfig?: (env?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
}

export function createWasmCommand(options: WasmCommandOptions = {}): Command {
  return defineCommand('wasm', async (args, ctx) => {
    const { runWasmCommand } = await import('./wasm/run.js');
    return runWasmCommand(args, ctx, options.buildProcessConfig?.(ctx.env));
  });
}
