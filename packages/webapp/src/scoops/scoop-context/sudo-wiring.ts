import {
  type DefaultDisposition,
  mergePolicies,
  type PathOp,
  type SudoersPolicy,
} from '../../base/sudoers.js';
import type { ShellSudoConfig } from '../../shell/almost-bash-shell-headless.js';
import type { SudoManager } from '../../sudo/sudo-manager.js';
import type { EscalationCounts, SudoBroker, SudoDecision, SudoRequest } from '../../sudo/types.js';
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

  escalate?: boolean;

  escalations?: EscalationCounts;
}

export const NO_ESCALATE_NOTE =
  'not permitted for this agent call: it was started with --no-escalate, so nothing outside its allowed commands and writable paths can be approved. Do not retry; finish with what you are allowed to do.';

const noEscalateBroker: SudoBroker = {
  requestApproval: async () => ({ decision: 'deny', note: NO_ESCALATE_NOTE }),
};

function noEscalatePolicy(manager: SudoManager, folder: string): SudoersPolicy {
  const effective = manager.getPolicyForScoop(folder);
  const demote = (rules: SudoersPolicy['cmnd']) => rules.map((r) => ({ ...r, nopasswd: false }));
  return mergePolicies(manager.getConfiguredPolicyForScoop(folder), {
    cmnd: demote(effective.cmnd),
    read: demote(effective.read),
    write: demote(effective.write),
    export: demote(effective.export ?? []),
  });
}

function countingBroker(broker: SudoBroker, counts: EscalationCounts): SudoBroker {
  return {
    async requestApproval(request, opts) {
      counts.asked++;
      try {
        const decision = await broker.requestApproval(request, opts);
        if (decision.decision === 'deny') counts.denied++;
        else counts.allowed++;
        return decision;
      } catch (err) {
        counts.denied++;
        throw err;
      }
    },
  };
}

export function buildSudoWiring({
  sudoManager,
  unit,
  folder,
  onSudoRequest,
  escalate = true,
  escalations = { asked: 0, allowed: 0, denied: 0 },
}: SudoWiringDeps): SudoWiring | null {
  if (!sudoManager) return null;
  const manager = sudoManager;
  const { policy } = unit;
  const userIsAuthority = policy.approvalAuthority === 'user';
  const parentBrokerFn = onSudoRequest;

  const routed: SudoBroker = !escalate
    ? noEscalateBroker
    : userIsAuthority || !parentBrokerFn
      ? manager.getBroker()
      : { requestApproval: (request) => parentBrokerFn(request) };
  const broker = countingBroker(routed, escalations);
  const getPolicy = userIsAuthority
    ? () => manager.getPolicy()
    : escalate
      ? () => manager.getPolicyForScoop(folder)
      : () => noEscalatePolicy(manager, folder);
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
