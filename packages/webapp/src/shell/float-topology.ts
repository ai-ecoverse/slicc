/**
 * Canonical float-topology resolver.
 *
 * Topology is owned by the shell transport layer because extension-delegate
 * state is configured by `proxied-fetch.ts`. The compatibility modules in
 * `core/` re-export this API for existing higher-layer callers.
 */

import { isExtensionRealm } from '../base/runtime-env.js';
import { getExtensionDelegateId } from './proxied-fetch.js';

export type FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest';

type ConnectModeGlobal = {
  __slicc_connect_mode?: unknown;
};

/** Resolve the current realm's float topology. First match wins. */
export function resolveFloatTopology(): FloatTopology {
  if (isExtensionRealm()) {
    return 'extension-direct';
  }
  if (getExtensionDelegateId()) {
    return 'extension-delegate';
  }
  if ((globalThis as ConnectModeGlobal).__slicc_connect_mode) {
    return 'connect';
  }
  return 'node-rest';
}

/** True iff this float has a reachable local node-server REST surface. */
export function hasLocalNodeServer(): boolean {
  return resolveFloatTopology() === 'node-rest';
}
