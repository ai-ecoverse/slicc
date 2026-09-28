import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { JshProcessConfig } from '../jsh-executor.js';
import type { TerminalPort } from '../terminal-port.js';
import type { InstalledCommandsLookup, NativeGate } from './wasm/launch.js';

export interface WasmCommandOptions {
  buildProcessConfig?: (env?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;

  terminal?: TerminalPort;

  gate?: NativeGate;

  commands?: InstalledCommandsLookup;
}

export function createWasmCommand(options: WasmCommandOptions = {}): Command {
  return defineCommand('wasm', async (args, ctx) => {
    const { runWasmCommand } = await import('./wasm/run.js');
    return runWasmCommand(args, ctx, {
      processConfig: options.buildProcessConfig?.(ctx.env),
      terminal: options.terminal,
      gate: options.gate,
      commands: options.commands,
    });
  });
}
