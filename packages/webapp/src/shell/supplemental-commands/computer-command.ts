/**
 * `computer` — registration only. Help, chaining, and adapters live in
 * `./computer/run.ts` so they stay out of the worker first-load graph.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ComputerRegistry } from '../../computers/registry.js';
import type { BrowserAPI } from '../../kernel/browser-api.js';
import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import type { ProcessManager } from '../../kernel/process-manager.js';

export interface ComputerCommandDeps {
  registry?: ComputerRegistry;
  processManager?: ProcessManager;
  browser?: BrowserAPI;
  panelRpc?: PanelRpcClient;
}

export function createComputerCommand(deps: ComputerCommandDeps = {}): Command {
  return defineCommand('computer', async (args, ctx) => {
    const { runComputer } = await import('./computer/run.js');
    return runComputer(args, ctx, deps);
  });
}
