import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, type PanelRpcClient } from '../../kernel/panel-rpc.js';
import { CHERRY_RUNTIME_TAG } from '../../scoops/tray-sync-protocol.js';
import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from './host-command.js';

/**
 * Outcome of an `emitSliccEvent` attempt. `delivered` is true once the event
 * was handed off to the leader tray over an open channel — that is queue-level
 * confirmation, not an end-to-end ack that the cherry host page's
 * `onSliccEvent` fired. On any failure `reason` carries a single-line,
 * agent-readable explanation (no page bridge, owning follower not connected, or
 * transport fault) that `cherry-emit` surfaces on stderr. The discriminated
 * union makes the invariant compiler-enforced: a non-delivery always has a
 * reason.
 */
export type CherryEmitResult = { delivered: true } | { delivered: false; reason: string };

/**
 * A direct, in-realm emitter for floats where the leader tray lives in
 * the SAME realm as the `cherry-emit` command (no kernel-worker → page
 * bridge hop). Returns whether the event was handed to the owning
 * follower's channel. When unset (e.g. the standalone kernel worker,
 * where the leader tray lives on the page), `emitSliccEvent` falls back
 * to the worker→page panel-RPC bridge.
 */
export type CherryDirectEmitter = (
  runtimeId: string,
  name: string,
  detail: unknown
) => boolean | Promise<boolean>;

let directEmitter: CherryDirectEmitter | null = null;

/**
 * Register (or clear with `null`) the in-realm direct emitter. Set on leader
 * start and cleared on stop by the in-realm leader, mirroring
 * `setConnectedFollowersGetter`. Only the extension offscreen leader uses this;
 * the standalone leader lives on the page and is reached over panel-RPC instead.
 */
export function setCherryEmitter(emitter: CherryDirectEmitter | null): void {
  directEmitter = emitter;
}

/**
 * Leader-side registry the `cherry-emit` command drives to push a `slicc.event`
 * out to a cherry host page through a connected follower runtime.
 * `listRuntimeIds()` returns canonical ids (`follower-<bootstrapId>`);
 * `emitSliccEvent` forwards the named event over that runtime's tray channel
 * and resolves with whether it was actually delivered.
 *
 * Tests inject a fake registry; production uses `buildDefaultCherryRegistry()`,
 * which reads the leader's connected followers and bridges the emit to the
 * page-side LeaderSyncManager via panel-RPC. Non-delivery never collapses to a
 * silent log: it resolves `delivered:false` with a reason so `cherry-emit`
 * exits non-zero rather than reporting a phantom success.
 */
export interface CherryRuntimeRegistry {
  listRuntimeIds(): string[];
  emitSliccEvent(runtimeId: string, name: string, detail: unknown): Promise<CherryEmitResult>;
}

export interface CherryEmitCommandOptions {
  /** Registry override for tests. Production defaults to `buildDefaultCherryRegistry()`. */
  registry?: CherryRuntimeRegistry;
}

/** Injectable seams for `buildDefaultCherryRegistry` (production defaults read live state). */
export interface DefaultCherryRegistryDeps {
  getFollowers?: () => ConnectedFollowerInfo[];
  getPanelRpc?: () => PanelRpcClient | null;
  getEmitter?: () => CherryDirectEmitter | null;
}

/**
 * The production `CherryRuntimeRegistry`. `listRuntimeIds()` returns the
 * canonical ids of connected followers whose runtime tag is `slicc-cherry`
 * (only those can receive a `slicc.event`). `emitSliccEvent` reaches the leader
 * by whichever path the float provides: a same-realm direct emitter when one is
 * registered (extension offscreen — see `setCherryEmitter`), otherwise the
 * worker→page panel-RPC bridge (standalone, where the leader tray's WebRTC
 * channels live on the page).
 */
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
      // Preferred path when the leader tray is in this realm (extension
      // offscreen): call `LeaderSyncManager.emitCherrySliccEvent` directly, no
      // bridge hop — mirrors the inbound `handleCherryHostEvent` direct call.
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
        // No in-realm leader and no page bridge — there's no way to reach the
        // leader tray (the standalone worker needs the panel-RPC client).
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

    const result = await registry.emitSliccEvent(runtime!, name, detail);
    if (!result.delivered) {
      return {
        stdout: '',
        stderr: `cherry-emit: failed to deliver '${name}' to ${runtime}: ${result.reason}\n`,
        exitCode: 1,
      };
    }
    return { stdout: `cherry-emit: sent '${name}' to ${runtime}\n`, stderr: '', exitCode: 0 };
  });
}
