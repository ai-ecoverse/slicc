import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { WasmCommandOptions } from './wasm-command.js';

export function createGoCommand(options: WasmCommandOptions = {}): Command {
  return defineCommand('go', async (args, ctx) => {
    const { runGoCommand } = await import('./go/go-driver.js');
    return runGoCommand(args, ctx, {
      processConfig: options.buildProcessConfig?.(ctx.env),
      terminal: options.terminal,
      gate: options.gate,
      commands: options.commands,
      gitIdentity: options.gitIdentity,
    });
  });
}
