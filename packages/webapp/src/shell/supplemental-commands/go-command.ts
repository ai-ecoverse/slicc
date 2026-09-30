/**
 * `go` — SLICC's Go driver over an installed Go toolchain (#3530 phase 5e):
 * `go build`, `go run`, `go env`, `go version`. The driver (planning, the
 * compile and link steps as realm processes) loads on first use: see
 * `go/go-driver.ts`.
 */
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
