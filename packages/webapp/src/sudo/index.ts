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
import { createExtensionSudoBroker } from './extension-broker.js';
import { createHttpSudoBroker } from './http-broker.js';
import type { SudoBroker, SudoRequest } from './types.js';

export { createExtensionSudoBroker } from './extension-broker.js';
export { createHttpSudoBroker } from './http-broker.js';
export {
  installPanelSudoResponder,
  type PanelResponderDeps,
  resolveSudoRequest,
} from './panel-responder.js';
export { suggestPattern } from './suggest-pattern.js';
export type { SudoBroker, SudoDecision, SudoKind, SudoRequest } from './types.js';
export { SUDO_APPROVE_PATH, SUDO_REQUEST_TYPE } from './types.js';

const log = createLogger('sudo');

/** Global hook name used by {@link installSudoTestHook}. */
export const SUDO_BRIDGE_GLOBAL_KEY = '__slicc_sudo';

/** True when running inside the Chrome extension runtime. */
function isExtensionRuntime(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!(chrome as unknown as { runtime?: { id?: string } })?.runtime?.id
  );
}

/**
 * Construct the {@link SudoBroker} for the current float. Extension mode relays
 * offscreen → side-panel; every other float (standalone CLI, Electron) talks to
 * the node-server `/api/sudo-approve` endpoint.
 */
export function createSudoBroker(): SudoBroker {
  if (isExtensionRuntime()) {
    return createExtensionSudoBroker();
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
