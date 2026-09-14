import type { DefaultDisposition, PathOp, SudoersPolicy } from '../../base/sudoers.js';
import type { ShellSudoConfig } from '../../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../../sudo/sudo-manager.js';
import type { SudoBroker, SudoDecision, SudoRequest } from '../../sudo/types.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';

export interface SudoWiring {
  broker: SudoBroker;
  getPolicy: () => SudoersPolicy;
  defaultDisposition: DefaultDisposition;
  shellConfig: ShellSudoConfig;

  onGrant?: (op: PathOp, pattern: string) => void | Promise<void>;
}

export interface SudoWiringDeps {
  sudoManager: SudoManager | null;
  unit: WorkUnitDescriptor;
  folder: string;

  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
}

export function buildSudoWiring({
  sudoManager,
  unit,
  folder,
  onSudoRequest,
}: SudoWiringDeps): SudoWiring | null {
  if (!sudoManager) return null;
  const manager = sudoManager;
  const { policy } = unit;
  const userIsAuthority = policy.approvalAuthority === 'user';
  const parentBrokerFn = onSudoRequest;

  const broker: SudoBroker =
    userIsAuthority || !parentBrokerFn
      ? manager.getBroker()
      : { requestApproval: (request) => parentBrokerFn(request) };
  const getPolicy = userIsAuthority
    ? () => manager.getPolicy()
    : () => manager.getPolicyForScoop(folder);
  const defaultDisposition: DefaultDisposition = policy.sudoDefaultDisposition;

  const baseShell = manager.getShellConfig();

  const persistCommandGrant = policy.persistCommandGrants
    ? baseShell.persistCommandGrant
    : async () => {};
  const shellConfig: ShellSudoConfig = {
    ...baseShell,
    broker,
    getPolicy,
    defaultDisposition,
    persistCommandGrant,
  };

  const wiring: SudoWiring = { broker, getPolicy, defaultDisposition, shellConfig };
  if (!policy.persistCommandGrants) wiring.onGrant = async () => {};
  return wiring;
}
