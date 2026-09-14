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

export const SUDO_BRIDGE_GLOBAL_KEY = '__slicc_sudo';

export function createSudoBroker(broker: CapabilityBroker | null): SudoBroker {
  return withApprovalTimeout(createFloatSudoBroker(broker));
}

function createFloatSudoBroker(broker: CapabilityBroker | null): SudoBroker {
  const raw = createCapabilityGestureSudoBroker(broker);
  if (broker?.adapter === 'extension-direct' || broker?.adapter === 'extension-delegate') {
    return raw;
  }
  return createTrayFirstSudoBroker(raw);
}

interface SudoBridgeGlobal {
  [SUDO_BRIDGE_GLOBAL_KEY]: SudoBridge;
}

export interface SudoBridge {
  requestApproval(req: SudoRequest): Promise<import('./types.js').SudoDecision>;
}

export function installSudoTestHook(broker: SudoBroker): SudoBridge {
  const bridge: SudoBridge = {
    requestApproval: (req: SudoRequest) => broker.requestApproval(req),
  };
  (globalThis as unknown as SudoBridgeGlobal)[SUDO_BRIDGE_GLOBAL_KEY] = bridge;
  log.info('sudo broker test hook published on globalThis.__slicc_sudo');
  return bridge;
}
