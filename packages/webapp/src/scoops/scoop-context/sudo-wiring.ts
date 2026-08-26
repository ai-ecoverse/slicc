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
  /**
   * `SudoFS` grant sink for `always` decisions. `undefined` for a cone (the
   * gate's default persists to the global `/etc/sudoers.d/granted`); a no-op
   * for non-cone scoops — their `always` decision is already persisted SCOPED
   * to `/scoops/<folder>/etc/sudoers` by the approval router
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
}

/**
 * Assemble the sudo enforcement surface for this scoop: the `SudoFS` broker
 * + policy getter + default disposition, plus a matching `ShellSudoConfig`.
 * Cones keep the user broker, the global policy, and `'allow'` default
 * (unchanged behavior — only explicit `/etc/sudoers` rules gate). Non-cone
 * scoops use the cone-mediated broker wired via `ScoopContextCallbacks.onSudoRequest`,
 * the per-scoop policy from {@link SudoManager.getPolicyForScoop}, and
 * `'require-approval'` default so unmatched writes / commands escalate.
 * Returns `null` only when no `SudoManager` is available (tests, ad-hoc
 * sub-shells) — the agent is fully ungated in that path, same as before.
 */
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
