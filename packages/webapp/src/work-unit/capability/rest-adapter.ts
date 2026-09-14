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
  fetchImpl?: typeof fetch;

  resolveUrl?: (path: string) => string;

  headers?: (extra?: Record<string, string>) => Record<string, string>;

  controlTimeoutMs?: number;
  pageGestures?: PageGestureChannel;
}

export function createRestCapabilityBroker(
  options: RestCapabilityBrokerOptions = {}
): CapabilityBroker {
  const load = createLazyOps<RestOps>(
    () => import('./rest-ops.js').then((module) => module.createRestOps(options)),
    options.controlTimeoutMs ?? REST_CONTROL_CALL_TIMEOUT_MS
  );

  return composeCapabilityBroker({
    adapter: 'node-rest',
    pageGestures: options.pageGestures,
    network: {
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
