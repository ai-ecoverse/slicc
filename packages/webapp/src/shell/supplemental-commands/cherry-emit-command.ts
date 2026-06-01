import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getConnectedFollowersWithFallback, type ConnectedFollowerInfo } from './host-command.js';
import { getPanelRpcClient, type PanelRpcClient } from '../../kernel/panel-rpc.js';
import { CHERRY_RUNTIME_TAG } from '../../scoops/tray-sync-protocol.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('cherry-emit');

/**
 * Leader-side registry the `cherry-emit` command drives to push a `slicc.event`
 * out to a cherry host page through a connected follower runtime.
 * `listRuntimeIds()` returns canonical ids (`follower-<bootstrapId>`);
 * `emitSliccEvent` forwards the named event over that runtime's tray channel.
 *
 * Tests inject a fake registry; production uses `buildDefaultCherryRegistry()`,
 * which reads the leader's connected followers and bridges the emit to the
 * page-side LeaderSyncManager via panel-RPC. When no cherry runtime is
 * connected `cherry-emit` reports that and exits non-zero rather than silently
 * succeeding.
 */
export interface CherryRuntimeRegistry {
  listRuntimeIds(): string[];
  emitSliccEvent(runtimeId: string, name: string, detail: unknown): void;
}

export interface CherryEmitCommandOptions {
  /** Registry override for tests. Production defaults to `buildDefaultCherryRegistry()`. */
  registry?: CherryRuntimeRegistry;
}

/** Injectable seams for `buildDefaultCherryRegistry` (production defaults read live state). */
export interface DefaultCherryRegistryDeps {
  getFollowers?: () => ConnectedFollowerInfo[];
  getPanelRpc?: () => PanelRpcClient | null;
}

/**
 * The production `CherryRuntimeRegistry`. `listRuntimeIds()` returns the
 * canonical ids of connected followers whose runtime tag is `slicc-cherry`
 * (only those can receive a `slicc.event`); `emitSliccEvent` bridges to the
 * page-side `LeaderSyncManager.emitCherrySliccEvent` over panel-RPC, since the
 * `cherry-emit` command runs in the kernel worker but the leader tray's WebRTC
 * channels live on the page.
 */
export function buildDefaultCherryRegistry(
  deps: DefaultCherryRegistryDeps = {}
): CherryRuntimeRegistry {
  const getFollowers = deps.getFollowers ?? getConnectedFollowersWithFallback;
  const getPanelRpc = deps.getPanelRpc ?? getPanelRpcClient;
  return {
    listRuntimeIds(): string[] {
      return getFollowers()
        .filter((f) => f.runtime === CHERRY_RUNTIME_TAG)
        .map((f) => f.runtimeId);
    },
    emitSliccEvent(runtimeId: string, name: string, detail: unknown): void {
      const client = getPanelRpc();
      if (!client) {
        // No page bridge — the leader tray lives on the page, so without a
        // panel-RPC client there's no way to reach it. Surface it loudly
        // rather than dropping the event silently.
        log.warn('no panel-RPC client; cannot reach the page-side leader tray', {
          runtimeId,
          name,
        });
        return;
      }
      void client
        .call('cherry-emit', { runtimeId, name, detail })
        .then((res) => {
          if (!res?.delivered) {
            log.warn('leader reported the follower runtime was not connected', {
              runtimeId,
              name,
            });
          }
        })
        .catch((err: unknown) => {
          log.warn('panel-RPC delivery failed', {
            runtimeId,
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}

export function createCherryEmitCommand(options: CherryEmitCommandOptions = {}): Command {
  const registry = options.registry ?? buildDefaultCherryRegistry();
  return defineCommand('cherry-emit', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `cherry-emit - push a slicc.event to a cherry host page through a follower runtime

Usage: cherry-emit <name> [--detail <json>] [--runtime <id>]

  --detail <json>   JSON payload delivered as the event detail
  --runtime <id>    Target a specific follower runtime (canonical id, e.g. follower-abc).
                    Defaults to the sole connected runtime; required when more than one.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const positionals: string[] = [];
    let detailJson: string | undefined;
    let runtime: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--detail' || arg === '--runtime') {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('--')) {
          return { stdout: '', stderr: `cherry-emit: ${arg} requires a value\n`, exitCode: 1 };
        }
        if (arg === '--detail') detailJson = next;
        else runtime = next;
        i++;
      } else {
        positionals.push(arg!);
      }
    }

    const name = positionals[0];
    if (!name) {
      return { stdout: '', stderr: 'cherry-emit: event name is required\n', exitCode: 1 };
    }

    const ids = registry.listRuntimeIds();
    if (ids.length === 0) {
      return {
        stdout: '',
        stderr: 'cherry-emit: no cherry follower runtime is connected\n',
        exitCode: 1,
      };
    }
    if (!runtime) {
      if (ids.length > 1) {
        return {
          stdout: '',
          stderr: `cherry-emit: multiple runtimes connected, pass --runtime <id>. Available: ${ids.join(', ')}\n`,
          exitCode: 1,
        };
      }
      runtime = ids[0];
    } else if (!ids.includes(runtime)) {
      return {
        stdout: '',
        stderr: `cherry-emit: runtime '${runtime}' not connected. Available: ${ids.join(', ')}\n`,
        exitCode: 1,
      };
    }

    let detail: unknown;
    if (detailJson !== undefined) {
      try {
        detail = JSON.parse(detailJson);
      } catch {
        return { stdout: '', stderr: 'cherry-emit: --detail must be valid JSON\n', exitCode: 1 };
      }
    }

    registry.emitSliccEvent(runtime!, name, detail);
    return { stdout: `cherry-emit: sent '${name}' to ${runtime}\n`, stderr: '', exitCode: 0 };
  });
}
