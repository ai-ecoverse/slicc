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
import type { SudoBroker } from '../../sudo/types.js';
import type { ConnectedFollowerInfo } from './host-command.js';

export interface ComputerCommandDeps {
  registry?: ComputerRegistry;
  processManager?: ProcessManager;
  browser?: BrowserAPI;
  panelRpc?: PanelRpcClient;
  watch?: (id: string, fps: number, maxWidth: number) => void;
  unwatch?: (id: string) => void;
  /** Same broker the rest of the shell uses — `--allow-input` rides it. */
  sudoBroker?: SudoBroker;
  listFollowers?: () => ConnectedFollowerInfo[];
  sshExec?: (
    runtimeId: string,
    command: string,
    timeoutMs?: number
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Injected in tests; production lazy-wraps `createProxiedFetch`. */
  urlFetch?: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ) => Promise<{
    status: number;
    headers: Headers | Record<string, string>;
    body: Uint8Array;
  }>;
}

export function createComputerCommand(deps: ComputerCommandDeps = {}): Command {
  return defineCommand('computer', async (args, ctx) => {
    const { runComputer } = await import('./computer/run.js');
    return runComputer(args, ctx, deps);
  });
}
