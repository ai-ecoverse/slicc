import type { ComputerInputEvent } from '@slicc/shared-ts';
import type { Command, CommandContext } from 'just-bash';
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

  sudoBroker?: SudoBroker;
  listFollowers?: () => ConnectedFollowerInfo[];
  sshExec?: (
    runtimeId: string,
    command: string,
    timeoutMs?: number
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  nativeComputer?: (runtimeId: string) => {
    capture(opts: { fps?: number; maxWidth?: number; watch?: boolean }): Promise<{
      bytes: Uint8Array;
      mime: 'image/jpeg';
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
    }>;
    unwatch(): void;
    input(events: ComputerInputEvent[]): Promise<void> | void;
  };

  encodeRecordedFrames?: (args: {
    frames: Uint8Array[];
    fps: number;
    dest: string;
    width: number;
    height: number;
    durationMs: number;
    ctx: CommandContext;
    sourcePath?: string;
  }) => Promise<{ mime: string }>;

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
