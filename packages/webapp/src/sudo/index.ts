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
 * Enforcement consumes the SAME `createSudoBroker` output: `SudoManager`
 * (`sudo-manager.ts`) is the one composed broker per float, gating `SudoFS`
 * writes and the transparent command guard; `secret-command.ts`'s own
 * `persist` / `scope` / value-change gates reuse that same instance rather
 * than constructing an independent one (#2276). `installSudoTestHook`
 * remains a manual, ungated console surface — no separate wiring of its own.
 */

import { createLogger } from '../base/logger.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { withApprovalTimeout } from './approval-timeout.js';
import { createCapabilityGestureSudoBroker } from './capability-gesture-broker.js';
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
  type CapabilityGestureSudoBrokerDeps,
  createCapabilityGestureSudoBroker,
} from './capability-gesture-broker.js';
export {
  CONE_SUDO_TIMEOUT_MS,
  type ConeApprovalRouter,
  ConeRequestRegistry,
  type ConeRequestRegistryOptions,
  createConeApprovalBroker,
  type PendingSudoRequest,
  type SudoSettleReason,
} from './cone-broker.js';
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
export { suggestPattern } from './suggest-pattern.js';
export { createTrayFirstSudoBroker } from './tray-first-broker.js';
export type {
  SudoApproverDirective,
  SudoBroker,
  SudoDecision,
  SudoKind,
  SudoRequest,
  TurnGuestGate,
} from './types.js';
export { SUDO_APPROVE_PATH, SUDO_REQUEST_TYPE } from './types.js';

const log = createLogger('sudo');

/** Global hook name used by {@link installSudoTestHook}. */
export const SUDO_BRIDGE_GLOBAL_KEY = '__slicc_sudo';

/**
 * Construct the {@link SudoBroker} for the current float, given the ONE
 * `CapabilityBroker` the caller already composed (#2276) — never re-resolved
 * here. `null` means no broker was ever injected (a composition bug, or a
 * caller with no float to speak of); the gesture leg then fails closed to
 * `deny` rather than guessing a transport (see
 * `capability-gesture-broker.ts`).
 *
 * `approvals.request` is ONLY the native-gesture hop (`ApprovalCapability`'s
 * own doc comment) — everything routing-shaped stays POLICY here:
 * tray-first delegation to a follower's human (issue #2062, wraps every
 * adapter except the two extension ones, which already relay to the panel
 * where the modal lives — wrapping them again would double-relay for no
 * benefit) and the 5-minute {@link withApprovalTimeout} budget so an
 * unanswered prompt releases the blocked agent turn instead of hanging on it
 * forever. `broker.adapter` is a fact already resolved once at composition
 * time in `kernel/host.ts`, not a probe read here.
 */
export function createSudoBroker(broker: CapabilityBroker | null): SudoBroker {
  return withApprovalTimeout(createFloatSudoBroker(broker));
}

/** The raw-gesture broker, tray-first-wrapped where that policy applies, before the timeout wrap. */
function createFloatSudoBroker(broker: CapabilityBroker | null): SudoBroker {
  const raw = createCapabilityGestureSudoBroker(broker);
  if (broker?.adapter === 'extension-direct' || broker?.adapter === 'extension-delegate') {
    return raw;
  }
  return createTrayFirstSudoBroker(raw);
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
export function installSudoTestHook(broker: SudoBroker): SudoBridge {
  const bridge: SudoBridge = {
    requestApproval: (req: SudoRequest) => broker.requestApproval(req),
  };
  (globalThis as unknown as SudoBridgeGlobal)[SUDO_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('sudo broker test hook published on globalThis.__slicc_sudo');
  return bridge;
}
