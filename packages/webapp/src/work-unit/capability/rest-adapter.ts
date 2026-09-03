/**
 * `node-rest` CapabilityBroker adapter (#2276 slice B).
 *
 * One adapter serves BOTH privileged servers: `packages/node-server` and
 * `packages/swift-server` expose the same `/api/*` route set, so "the Swift
 * adapter" is this adapter pointed at a different process. The wire it speaks
 * is pinned by `packages/shared-ts/fixtures/capability-rest-contract.json`,
 * which both servers' test suites replay.
 *
 * This module is BOOT-CRITICAL — `kernel/host.ts` composes a broker before
 * the orchestrator restores scoops — so it holds only the broker's shape.
 * The HTTP implementation lives in `rest-ops.ts` behind a first-use dynamic
 * import; a static import of it would hoist the whole wire into the kernel
 * worker's eager closure for a float that may never call a privileged op.
 *
 * `browser.*` and `network.websocket` are deliberately absent — they ride the
 * `/cdp` bridge, which is not on this transport (see `docs/work-unit.md`
 * phase 6b).
 */

import { composeCapabilityBroker } from './compose.js';
import type { RestOps } from './rest-ops.js';
import type {
  CapabilityBroker,
  CapabilityResult,
  LocalNodeServerStatus,
  PageGestureChannel,
} from './types.js';

export { REST_CAPABILITY_PATHS } from './rest-paths.js';

export interface RestCapabilityBrokerOptions {
  /** `fetch` implementation. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /**
   * Absolute-URL resolver for an `/api/*` path. Defaults to `resolveApiUrl`,
   * which honours the thin-bridge base URL.
   */
  resolveUrl?: (path: string) => string;
  /**
   * Header decorator. Defaults to `apiHeaders`, which attaches the bridge
   * token only when a cross-origin bridge base is configured.
   */
  headers?: (extra?: Record<string, string>) => Record<string, string>;
  pageGestures?: PageGestureChannel;
}

/** Create the `node-rest` broker. */
export function createRestCapabilityBroker(
  options: RestCapabilityBrokerOptions = {}
): CapabilityBroker {
  let ops: Promise<RestOps> | null = null;
  const load = (): Promise<RestOps> => {
    ops ??= import('./rest-ops.js').then((module) => module.createRestOps(options));
    return ops;
  };

  return composeCapabilityBroker({
    adapter: 'node-rest',
    pageGestures: options.pageGestures,
    network: {
      // A composition-time fact: this adapter is only built for a float that
      // HAS a local privileged server, so the answer needs no round trip —
      // and no transport module load either.
      localNodeServer: (): Promise<CapabilityResult<LocalNodeServerStatus>> =>
        Promise.resolve({ ok: true, value: { available: true } }),
      crossOriginFetch: async (request) => (await load()).crossOriginFetch(request),
    },
    secrets: {
      listMaskedEnv: async () => (await load()).secrets.listMaskedEnv(),
      get: async (request) => (await load()).secrets.get(request),
      set: async (request) => (await load()).secrets.set(request),
      delete: async (request) => (await load()).secrets.delete(request),
    },
    mounts: { signRequest: async (request) => (await load()).signRequest(request) },
    approvals: { request: async (request) => (await load()).requestApproval(request) },
  });
}
