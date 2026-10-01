/**
 * The sudo enforcement surface for one work unit.
 *
 * Owns: choosing the approval broker, the policy source, and the default
 * disposition a unit's `SudoFS` and shell run under — user-brokered and
 * `'allow'` for a cone, cone-mediated and `'require-approval'` for a scoop.
 *
 * Changes when the approval model changes (a new broker route, a new grant
 * sink). Keeping it out of the context makes the "who approves what" decision
 * readable in one screen instead of woven through shell construction.
 */

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
  /**
   * `SudoFS` grant sink for `always` decisions. `undefined` for a cone (the
   * gate's default persists to the global `/etc/sudoers.d/granted`); a no-op
   * for non-cone scoops — their `always` decision is already persisted SCOPED
   * to `/etc/sudoers.d/scoop-<folder>` by the approval router
   * (`SudoManager.appendScoopRule`), so the default sink would leak the grant
   * into every unit's policy and accumulate duplicate rules (#2416).
   */
  onGrant?: (op: PathOp, pattern: string) => void | Promise<void>;
}

export interface SudoWiringDeps {
  sudoManager: SudoManager | null;
  unit: WorkUnitDescriptor;
  folder: string;
  /** Scoop-only: the cone-mediated escalation route. */
  onSudoRequest?: (request: SudoRequest) => Promise<SudoDecision>;
  /**
   * `false` (`agent --no-escalate`) refuses every request on the spot instead
   * of asking anyone: the unit is held to its grant, and nothing reaches the
   * cone or the user. Absent means escalate as usual.
   */
  escalate?: boolean;
  /** Tallied for every request that reaches the broker (`cost --json`). */
  escalations?: EscalationCounts;
}

/**
 * Told to the model with the refusal, so it stops asking instead of retrying
 * the same action through another command.
 */
export const NO_ESCALATE_NOTE =
  'not permitted for this agent call: it was started with --no-escalate, so nothing outside its allowed commands and writable paths can be approved. Do not retry; finish with what you are allowed to do.';

const noEscalateBroker: SudoBroker = {
  requestApproval: async () => ({ decision: 'deny', note: NO_ESCALATE_NOTE }),
};

/**
 * The policy a no-escalate unit runs under. Its own configured grants still
 * skip the gate; every other `NOPASSWD` rule — a stored "Always" in
 * `/etc/sudoers.d/granted` or a reused folder's `scoop-<folder>` — is demoted
 * to a plain rule, so it reaches the refusing broker instead of quietly
 * widening the agent call's grant.
 */
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

/** Wrap `broker` so every request it answers (or throws on) is tallied. */
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

/**
 * Assemble the sudo enforcement surface for this scoop: the `SudoFS` broker
 * + policy getter + default disposition, plus a matching `ShellSudoConfig`.
 * Cones keep the user broker, the global policy, and `'allow'` default
 * (unchanged behavior — only explicit `/etc/sudoers` rules gate). Non-cone
 * scoops use the cone-mediated broker wired via `ScoopContextCallbacks.onSudoRequest`,
 * the per-scoop policy from {@link SudoManager.getPolicyForScoop}, and
 * `'require-approval'` default so unmatched writes / commands escalate —
 * unless the unit was spawned with `escalate: false`, whose broker refuses
 * without asking. Every route is wrapped in the `escalations` tally.
 * Returns `null` only when no `SudoManager` is available (tests, ad-hoc
 * sub-shells) — the agent is fully ungated in that path, same as before.
 */
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
  // Cones inherit the global `persistCommandGrant` sink (writes to
  // `/etc/sudoers.d/granted` — visible to every scoop). Non-cone scoops
  // MUST NOT use that sink: a scoop-A "Always" approval would land as a
  // NOPASSWD rule for every scoop. The cone-mediated `always` decision
  // already persists scoped via `Orchestrator.resolveSudoRequestAndPersist`
  // → `SudoManager.appendScoopRule`, so the shell-side sink is a no-op
  // for non-cone scoops here.
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
  // Same isolation for FS-level path grants (#2416): non-cone scoops must not
  // write `always` grants to the global granted file — the router already
  // persisted them scoped to the scoop's own sudoers.
  const wiring: SudoWiring = { broker, getPolicy, defaultDisposition, shellConfig };
  if (!policy.persistCommandGrants) wiring.onGrant = async () => {};
  return wiring;
}
