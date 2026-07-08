/**
 * Sudo approval broker — public surface.
 *
 * The broker is the trusted-realm channel that turns a sensitive-action
 * request into a genuine native human gesture (OS dialog in CLI/Electron,
 * `window.confirm`/`window.prompt` in the extension). The agent's code-exec
 * sandboxes can call `requestApproval` but can never fabricate the result.
 *
 * Enforcement (SudoFS, command guard, secret gates) is intentionally NOT wired
 * here yet — see the sibling tasks in the spec. This module ships the broker
 * plumbing and a manual test hook only.
 */

import { createLogger } from '../core/logger.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import { getExtensionDelegateId } from '../shell/proxied-fetch.js';
import { createExtensionSudoBroker } from './extension-broker.js';
import { createHttpSudoBroker } from './http-broker.js';
import { createPanelRpcSudoBroker } from './panel-rpc-broker.js';
import type { SudoBroker, SudoRequest } from './types.js';

export {
  CONE_SUDO_TIMEOUT_MS,
  type ConeApprovalRouter,
  ConeRequestRegistry,
  type ConeRequestRegistryOptions,
  createConeApprovalBroker,
  type PendingSudoRequest,
} from './cone-broker.js';
export { createExtensionSudoBroker } from './extension-broker.js';
export { createHttpSudoBroker } from './http-broker.js';
export {
  installPanelSudoResponder,
  type PanelResponderDeps,
  resolveSudoRequest,
} from './panel-responder.js';
export { createPanelRpcSudoBroker } from './panel-rpc-broker.js';
export { suggestPattern } from './suggest-pattern.js';
export type { SudoBroker, SudoDecision, SudoKind, SudoRequest } from './types.js';
export { SUDO_APPROVE_PATH, SUDO_REQUEST_TYPE } from './types.js';

const log = createLogger('sudo');

/** Global hook name used by {@link installSudoTestHook}. */
export const SUDO_BRIDGE_GLOBAL_KEY = '__slicc_sudo';

/** True when running inside the Chrome extension runtime. */
function isExtensionRuntime(): boolean {
  return isExtensionRealm();
}

/**
 * True in the thin-bridge extension leader's kernel-worker realm: no `chrome`
 * at all, but an `ext=` extension delegate id was forwarded at boot (the same
 * signal `createProxiedFetch` keys its worker→page bridge on). Standalone /
 * Electron / hosted-leader workers reach a local node-server `/api/sudo-approve`
 * directly, so they keep the HTTP broker.
 */
function isThinBridgeWorker(): boolean {
  return typeof chrome === 'undefined' && getExtensionDelegateId() !== null;
}

/**
 * Construct the {@link SudoBroker} for the current float. Extension mode relays
 * offscreen → side-panel; the thin-bridge extension leader's kernel worker
 * relays to its page realm over panel-RPC (where the native modal lives); every
 * other float (standalone CLI, Electron) talks to the node-server
 * `/api/sudo-approve` endpoint.
 */
export function createSudoBroker(): SudoBroker {
  if (isExtensionRuntime()) {
    return createExtensionSudoBroker();
  }
  if (isThinBridgeWorker()) {
    return createPanelRpcSudoBroker();
  }
  return createHttpSudoBroker();
}

/** Public contract exposed on `globalThis.__slicc_sudo`. */
export interface SudoBridge {
  requestApproval(req: SudoRequest): Promise<import('./types.js').SudoDecision>;
}

/**
 * Publish a manual test hook on `globalThis.__slicc_sudo` so a developer can
 * exercise the live broker from the agent shell or a console, e.g.:
 *
 *   await globalThis.__slicc_sudo.requestApproval({
 *     kind: 'command', detail: 'git push origin main',
 *   });
 *
 * This is the ONLY wiring of the broker into the running app for now; no FS,
 * shell, or secret enforcement consumes it yet.
 */
export function installSudoTestHook(broker: SudoBroker = createSudoBroker()): SudoBridge {
  const bridge: SudoBridge = {
    requestApproval: (req: SudoRequest) => broker.requestApproval(req),
  };
  (globalThis as Record<string, unknown>)[SUDO_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('sudo broker test hook published on globalThis.__slicc_sudo');
  return bridge;
}
