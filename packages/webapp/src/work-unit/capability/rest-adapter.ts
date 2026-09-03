/**
 * `node-rest` CapabilityBroker adapter (#2276 slice B).
 *
 * One adapter serves BOTH privileged servers: `packages/node-server` and
 * `packages/swift-server` expose the same `/api/*` route set, so "the Swift
 * adapter" is this adapter pointed at a different process. The wire it speaks
 * is pinned by `packages/shared-ts/fixtures/capability-rest-contract.json`,
 * which both servers' test suites replay. That fixture also records the one
 * route that is NOT universal today — `POST /api/secrets` (persisted secret
 * creation) is node-server-only, so a `secrets.set` with the default
 * `persisted` scope fails on a Swift float until #2806 lands.
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

import { createLazyOps, guardCapability } from './boundary.js';
import { composeCapabilityBroker } from './compose.js';
import type { RestOps } from './rest-ops.js';
import { REST_CONTROL_CALL_TIMEOUT_MS } from './rest-paths.js';
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
  /**
   * Deadline on the small control-plane calls (secrets, sign-and-forward,
   * approvals). Defaults to 10s — see `rest-ops.ts`. Not a per-request knob;
   * `network.crossOriginFetch` takes its caller's `signal` instead.
   */
  controlTimeoutMs?: number;
  pageGestures?: PageGestureChannel;
}

/** Create the `node-rest` broker. */
export function createRestCapabilityBroker(
  options: RestCapabilityBrokerOptions = {}
): CapabilityBroker {
  // Bounded so a stalled chunk fetch (evicted asset, dead network) cannot
  // block the FIRST privileged call forever — for `shell-and-skills.ts`,
  // that's `initShellAndSkills` and therefore kernel-ready (#2276 slice C).
  // Same budget as the control-plane calls this chunk makes once loaded.
  const load = createLazyOps<RestOps>(
    () => import('./rest-ops.js').then((module) => module.createRestOps(options)),
    options.controlTimeoutMs ?? REST_CONTROL_CALL_TIMEOUT_MS
  );

  return composeCapabilityBroker({
    adapter: 'node-rest',
    pageGestures: options.pageGestures,
    network: {
      // A composition-time fact: this adapter is only built for a float that
      // HAS a local privileged server, so the answer needs no round trip —
      // and no transport module load either.
      localNodeServer: (): Promise<CapabilityResult<LocalNodeServerStatus>> =>
        Promise.resolve({ ok: true, value: { available: true } }),
      crossOriginFetch: (request) =>
        guardCapability('network', 'crossOriginFetch', async () =>
          (await load()).crossOriginFetch(request)
        ),
    },
    secrets: {
      listMaskedEnv: () =>
        guardCapability('secrets', 'listMaskedEnv', async () =>
          (await load()).secrets.listMaskedEnv()
        ),
      getMasked: (request) =>
        guardCapability('secrets', 'getMasked', async () =>
          (await load()).secrets.getMasked(request)
        ),
      set: (request) =>
        guardCapability('secrets', 'set', async () => (await load()).secrets.set(request)),
      delete: (request) =>
        guardCapability('secrets', 'delete', async () => (await load()).secrets.delete(request)),
    },
    mounts: {
      signRequest: (request) =>
        guardCapability('mounts', 'signRequest', async () => (await load()).signRequest(request)),
    },
    approvals: {
      request: (request) =>
        guardCapability('approvals', 'request', async () =>
          (await load()).requestApproval(request)
        ),
    },
  });
}
