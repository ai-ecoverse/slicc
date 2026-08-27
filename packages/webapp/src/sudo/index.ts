/**
 * Sudo approval broker — public surface.
 *
 * The broker is the trusted-realm channel that turns a sensitive-action
 * request into a genuine native human gesture (OS dialog in CLI/Electron,
 * native `confirm`/`prompt` in the extension's panel realm). The agent's
 * code-exec sandboxes can call `requestApproval` but can never fabricate the
 * result.
 *
 * Scope of that guarantee: it holds against the AGENT's realms (kernel worker,
 * offscreen document, JS realms) — not against arbitrary code running in the
 * page/panel realm itself, which can reassign `globalThis.confirm`. The
 * standalone/Electron path is stronger by construction (the dialog is raised by
 * the node-server process, out of reach of page JS); the extension panel path
 * mitigates by capturing the native modals at module init — see the
 * `NATIVE_CONFIRM` note in `panel-responder.ts`.
 *
 * Enforcement (SudoFS, command guard, secret gates) is intentionally NOT wired
 * here yet — see the sibling tasks in the spec. This module ships the broker
 * plumbing and a manual test hook only.
 */

import { createLogger } from '../base/logger.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import { getExtensionDelegateId } from '../shell/proxied-fetch.js';
import { withApprovalTimeout } from './approval-timeout.js';
import { createExtensionSudoBroker } from './extension-broker.js';
import { createHttpSudoBroker } from './http-broker.js';
import { createPanelRpcSudoBroker } from './panel-rpc-broker.js';
import { createTrayFirstSudoBroker } from './tray-first-broker.js';
import type { SudoBroker, SudoRequest } from './types.js';

export {
  type ApprovalTimeoutOptions,
  isTimedOut,
  sudoRefusalMessage,
  timedOutDecision,
  timeoutNotice,
  USER_SUDO_TIMEOUT_MS,
  withApprovalTimeout,
} from './approval-timeout.js';
export {
  CONE_SUDO_TIMEOUT_MS,
  type ConeApprovalRouter,
  ConeRequestRegistry,
  type ConeRequestRegistryOptions,
  createConeApprovalBroker,
  type PendingSudoRequest,
  type SudoSettleReason,
} from './cone-broker.js';
export { createExtensionSudoBroker } from './extension-broker.js';
export { createHttpSudoBroker } from './http-broker.js';
export {
  resetSudoPageServiceForTests,
  resolveSudoApprovalInPage,
  type SudoPagePrompt,
  type SudoTrayDelegate,
  setSudoPagePrompt,
  setSudoTrayDelegate,
} from './page-approval-service.js';
export {
  installPanelSudoResponder,
  type PanelResponderDeps,
  resolveSudoRequest,
} from './panel-responder.js';
export { createPanelRpcSudoBroker } from './panel-rpc-broker.js';
export { suggestPattern } from './suggest-pattern.js';
export { createTrayFirstSudoBroker } from './tray-first-broker.js';
export type {
  SudoApproverDirective,
  SudoBroker,
  SudoDecision,
  SudoKind,
  SudoRequest,
} from './types.js';
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
 * other float (standalone CLI, Electron, hosted leader) talks to the
 * node-server `/api/sudo-approve` endpoint — wrapped tray-first (issue #2062)
 * so the page realm can hand the prompt to a tray follower's human (or its own
 * in-page dialog when there is no node-server) before the OS dialog fires.
 * The panel-RPC broker already settles in the page, so it needs no wrapper.
 *
 * Every float is wrapped in {@link withApprovalTimeout} so a prompt nobody
 * answers releases the blocked agent turn fail-closed instead of hanging on it
 * forever. The wrap lives here rather than in each broker so all three floats
 * share one budget and one `reason: 'timeout'` contract.
 */
export function createSudoBroker(): SudoBroker {
  return withApprovalTimeout(createFloatSudoBroker());
}

/** The raw, float-appropriate broker before the timeout wrap. */
function createFloatSudoBroker(): SudoBroker {
  if (isExtensionRuntime()) {
    return createExtensionSudoBroker();
  }
  if (isThinBridgeWorker()) {
    return createPanelRpcSudoBroker();
  }
  return createTrayFirstSudoBroker(createHttpSudoBroker());
}

/** The single property {@link installSudoTestHook} grafts onto `globalThis`. */
interface SudoBridgeGlobal {
  [SUDO_BRIDGE_GLOBAL_KEY]: SudoBridge;
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
  (globalThis as unknown as SudoBridgeGlobal)[SUDO_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('sudo broker test hook published on globalThis.__slicc_sudo');
  return bridge;
}
