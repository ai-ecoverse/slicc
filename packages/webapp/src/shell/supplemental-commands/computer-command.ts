/**
 * `computer` — registration only. Help, chaining, and adapters live in
 * `./computer/run.ts` so they stay out of the worker first-load graph.
 */

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
  isWatching?: (id: string) => boolean;
  /** Injected in tests; production waits 5s for a live push frame after input. */
  postActionTimeoutMs?: number;
  /** Same broker the rest of the shell uses — `--allow-input` rides it. */
  sudoBroker?: SudoBroker;
  listFollowers?: () => ConnectedFollowerInfo[];
  sshExec?: (
    runtimeId: string,
    command: string,
    timeoutMs?: number
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Injected native capture for a `capabilities.computer` follower. */
  nativeComputer?: (runtimeId: string) => {
    capture(opts: {
      fps?: number;
      maxWidth?: number;
      /** 1-based OS display index on the follower; omitted means its main display. */
      display?: number;
      watch?: boolean;
    }): Promise<{
      bytes: Uint8Array;
      mime: 'image/jpeg';
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
    }>;
    unwatch(): void;
    input(events: ComputerInputEvent[], opts?: { display?: number }): Promise<void> | void;
  };
  /**
   * Injected in tests so `computer record` does not boot `@ffmpeg/core`.
   * Production concatenates JPEG stills and runs `ffmpeg -f image2pipe`.
   */
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
