import { CHERRY_RUNTIME_TAG } from '@slicc/shared-ts';
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, type PanelRpcClient } from '../../kernel/panel-rpc.js';
import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from './host-command.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

export type CherryEmitResult = { delivered: true } | { delivered: false; reason: string };

export type CherryDirectEmitter = (
  runtimeId: string,
  name: string,
  detail: unknown
) => boolean | Promise<boolean>;

let directEmitter: CherryDirectEmitter | null = null;

export function setCherryEmitter(emitter: CherryDirectEmitter | null): void {
  directEmitter = emitter;
}

export interface CherryRuntimeRegistry {
  listRuntimeIds(): string[];
  emitSliccEvent(runtimeId: string, name: string, detail: unknown): Promise<CherryEmitResult>;
}

export interface CherryEmitCommandOptions {
  registry?: CherryRuntimeRegistry;
}

export interface DefaultCherryRegistryDeps {
  getFollowers?: () => ConnectedFollowerInfo[];
  getPanelRpc?: () => PanelRpcClient | null;
  getEmitter?: () => CherryDirectEmitter | null;
}

export function buildDefaultCherryRegistry(
  deps: DefaultCherryRegistryDeps = {}
): CherryRuntimeRegistry {
  const getFollowers = deps.getFollowers ?? getConnectedFollowersWithFallback;
  const getPanelRpc = deps.getPanelRpc ?? getPanelRpcClient;
  const getEmitter = deps.getEmitter ?? (() => directEmitter);
  return {
    listRuntimeIds(): string[] {
      return getFollowers()
        .filter((f) => f.runtime === CHERRY_RUNTIME_TAG)
        .map((f) => f.runtimeId);
    },
    async emitSliccEvent(
      runtimeId: string,
      name: string,
      detail: unknown
    ): Promise<CherryEmitResult> {
      const emitter = getEmitter();
      if (emitter) {
        try {
          const delivered = await emitter(runtimeId, name, detail);
          if (delivered) return { delivered: true };
          return {
            delivered: false,
            reason: 'the follower runtime is not connected to the leader',
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { delivered: false, reason: `direct emit failed: ${message}` };
        }
      }
      const client = getPanelRpc();
      if (!client) {
        return { delivered: false, reason: 'no page bridge to the leader tray (panel-RPC client)' };
      }
      try {
        const res = await client.call('cherry-emit', { runtimeId, name, detail });
        if (res?.delivered) return { delivered: true };
        return { delivered: false, reason: 'the follower runtime is not connected to the leader' };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { delivered: false, reason: `panel-RPC delivery failed: ${message}` };
      }
    },
  };
}

const HELP_TEXT = `cherry-emit - push a slicc.event to a cherry host page through a follower runtime

Usage: cherry-emit <name> [--detail <json>] [--runtime <id>]

  --detail <json>   JSON payload delivered as the event detail
  --runtime <id>    Target a specific follower runtime (canonical id, e.g. follower-abc).
                    Defaults to the sole connected runtime; required when more than one.
`;

type CommandResult = { stdout: string; stderr: string; exitCode: number };

const CHERRY_EMIT_VALUE_FLAGS = ['--detail', '--runtime'] as const;

function errResult(message: string): CommandResult {
  return { stdout: '', stderr: `cherry-emit: ${message}\n`, exitCode: 1 };
}

interface ParsedArgs {
  positionals: string[];
  detailJson?: string;
  runtime?: string;
}

function parseArgs(args: string[]): ParsedArgs | CommandResult {
  const parsed = parseKnownFlags(args, { value: CHERRY_EMIT_VALUE_FLAGS });
  if ('error' in parsed) return errResult(parsed.error);
  return {
    positionals: parsed.positionals,
    detailJson: parsed.values.get('--detail'),
    runtime: parsed.values.get('--runtime'),
  };
}

function resolveRuntime(ids: string[], requested: string | undefined): string | CommandResult {
  if (ids.length === 0) return errResult('no cherry follower runtime is connected');
  if (!requested) {
    if (ids.length > 1) {
      return errResult(
        `multiple runtimes connected, pass --runtime <id>. Available: ${ids.join(', ')}`
      );
    }
    return ids[0]!;
  }
  if (!ids.includes(requested)) {
    return errResult(`runtime '${requested}' not connected. Available: ${ids.join(', ')}`);
  }
  return requested;
}

function parseDetail(detailJson: string | undefined): { detail: unknown } | CommandResult {
  if (detailJson === undefined) return { detail: undefined };
  try {
    return { detail: JSON.parse(detailJson) };
  } catch {
    return errResult('--detail must be valid JSON');
  }
}

export function createCherryEmitCommand(options: CherryEmitCommandOptions = {}): Command {
  const registry = options.registry ?? buildDefaultCherryRegistry();
  return defineCommand('cherry-emit', async (args) => {
    if (isHelpRequest(args, { valueFlags: CHERRY_EMIT_VALUE_FLAGS })) {
      return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
    }

    const parsed = parseArgs(args);
    if ('exitCode' in parsed) return parsed;

    const name = parsed.positionals[0];
    if (!name) return errResult('event name is required');

    const runtime = resolveRuntime(registry.listRuntimeIds(), parsed.runtime);
    if (typeof runtime !== 'string') return runtime;

    const detail = parseDetail(parsed.detailJson);
    if ('exitCode' in detail) return detail;

    const result = await registry.emitSliccEvent(runtime, name, detail.detail);
    if (!result.delivered) {
      return errResult(`failed to deliver '${name}' to ${runtime}: ${result.reason}`);
    }
    return { stdout: `cherry-emit: sent '${name}' to ${runtime}\n`, stderr: '', exitCode: 0 };
  });
}
