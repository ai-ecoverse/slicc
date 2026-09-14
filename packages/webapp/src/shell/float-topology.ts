import { isExtensionRealm } from '../base/runtime-env.js';
import { getExtensionDelegateId } from './proxied-fetch.js';

export type FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest';

type ConnectModeGlobal = {
  __slicc_connect_mode?: unknown;
};

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

export function hasLocalNodeServer(): boolean {
  return resolveFloatTopology() === 'node-rest';
}
