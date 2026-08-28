/**
 * Resolving WHO settles a directed approval.
 *
 * Split out of the orchestrator and imported on first use: a directed approval
 * only ever happens for a biscotto guest seat, which most sessions never have,
 * and the orchestrator is in the kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 *
 * Pure over an injected view of the roster so it can be tested without an
 * orchestrator, and so the rules below sit in one readable place rather than
 * inside a method that also does the enqueueing.
 */

import { createLogger } from '../base/logger.js';
import type { SudoApproverDirective, SudoDecision, SudoRequest } from '../sudo/types.js';
import { derivePolicy } from '../work-unit/policy.js';
import { AGENT_BRIDGE_GLOBAL_KEY, type AgentBridge } from './agent-bridge.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('directed-approval');

/** Why a directive could not be routed. The caller turns this into a denial. */
export interface DirectedApprovalRefusal {
  ok: false;
  reason: string;
}

export interface DirectedApprovalTarget {
  ok: true;
  requesterJid: string;
  approver: RegisteredScoop;
}

export interface DirectedApprovalDeps {
  /** Workspace layout for a unit — injected so this module stays testable. */
  workspaceFor: (scoop: RegisteredScoop) => import('../work-unit/types.js').WorkUnitWorkspace;
  /** Every registered unit, by jid. */
  scoops: ReadonlyMap<string, RegisteredScoop>;
  /** The root that owns a unit — itself when it IS a root. */
  ownerRootOf: (jid: string) => RegisteredScoop | undefined;
}

/**
 * Resolve a directive to the unit that will settle it.
 *
 * Fails for every unroutable case rather than degrading to a different
 * approver: silently substituting a principal the owner did not choose is the
 * failure this whole surface exists to prevent.
 */
export function resolveDirectedApprover(
  directive: SudoApproverDirective,
  deps: DirectedApprovalDeps
): DirectedApprovalTarget | DirectedApprovalRefusal {
  if (directive.kind === 'user') return refuse('the user tier is not a directed approval');
  // `agent` is a different mechanism — a bounded run whose RESULT is the
  // verdict — and is routed before this point. Named explicitly so the union
  // stays exhaustive rather than falling into the scoop branch.
  if (directive.kind === 'agent') return refuse('agent approvals are not enqueued to a unit');

  const requesterJid = directive.unitJid;
  if (!deps.scoops.has(requesterJid)) return refuse('the requesting unit is not registered');
  const owner = deps.ownerRootOf(requesterJid);
  if (!owner) return refuse('no owning cone for the requesting unit');

  // A named approver is scoped to THIS cone's own children, and never to a
  // root. A bare name search over the whole roster can match a different cone's
  // scoop — names are not unique across cones — and would hand a guest's text
  // to an approval principal in someone else's thread.
  const approver =
    directive.kind === 'cone'
      ? owner
      : [...deps.scoops.values()].find(
          (scoop) =>
            scoop.parentJid === owner.jid &&
            (scoop.name === directive.scoopName || scoop.folder === directive.scoopName)
        );
  if (!approver) return refuse('delegated approver not found under this cone');

  // An approver that cannot settle would leave the request to time out five
  // minutes later and deny — indistinguishable, to the owner, from a reviewer
  // who ignored it. Only a scoop marked `approvesGuestRequests` can.
  if (!derivePolicy(approver).canResolveApprovals) {
    return refuse('the named approver cannot resolve approvals');
  }
  return { ok: true, requesterJid, approver };
}

function refuse(reason: string): DirectedApprovalRefusal {
  log.warn('Directed approval failing closed', { reason });
  return { ok: false, reason };
}

const DENY: SudoDecision = { decision: 'deny' };

export interface RunDirectedApprovalDeps extends DirectedApprovalDeps {
  /** File the request against a unit and wait for it to settle. */
  enqueue: (
    requesterJid: string,
    request: SudoRequest,
    opts: { approver: RegisteredScoop }
  ) => Promise<SudoDecision>;
  /** The owner's own broker, for the `user` tier. */
  approveAsUser: (request: SudoRequest) => Promise<SudoDecision>;
  /** Shared VFS, for reading the approver's instruction file. */
  getSharedFs: () => {
    readFile: (path: string, opts: { encoding: 'utf-8' }) => Promise<unknown>;
  } | null;
}

/**
 * The whole directed-approval flow: pick the mechanism the request names, and
 * fail closed if it cannot be reached.
 *
 * Lives here rather than on the orchestrator so none of it sits in the
 * boot-critical graph — a guest seat is the only thing that ever reaches it.
 */
export async function runDirectedApproval(
  request: SudoRequest,
  deps: RunDirectedApprovalDeps
): Promise<SudoDecision> {
  const directive = request.approver;

  // A bounded approver agent whose RESULT is the verdict. Nothing is enqueued
  // and no unit settles anything, so it needs no approver scoop to exist.
  if (directive?.kind === 'agent') {
    // The bridge is read off the global rather than injected at boot: wiring it
    // through `kernel/host.ts` put the registration and its closures into the
    // boot-critical graph for a decision most sessions never make. Same idiom
    // as the lick handler in `scoop-context/tools.ts`.
    const bridge = (globalThis as typeof globalThis & { [AGENT_BRIDGE_GLOBAL_KEY]?: AgentBridge })[
      AGENT_BRIDGE_GLOBAL_KEY
    ];
    if (!bridge) {
      log.warn('No agent bridge available for an approver agent — denying');
      return DENY;
    }
    const { approverRunnerFor } = await import('./approver-agent.js');
    const fs = deps.getSharedFs();
    const run = approverRunnerFor({
      spawn: (options) => bridge.spawn(options),
      readSharedFile: async (path) => {
        if (!fs) return null;
        try {
          const raw = await fs.readFile(path, { encoding: 'utf-8' });
          return typeof raw === 'string' ? raw : null;
        } catch {
          // Not seeded on this profile — the bundled default is used.
          return null;
        }
      },
      findUnit: (jid) => {
        const unit = deps.scoops.get(jid);
        return unit ? { workspace: deps.workspaceFor(unit), folder: unit.folder } : undefined;
      },
    });
    const verdict = await run(
      {
        kind: request.kind === 'guest-tool' ? 'guest-tool' : 'guest-message',
        // The system's identity for the asker, never their own claim. An
        // unnamed asker must not read as a trusted one.
        requester: request.requester ?? 'an unidentified requester',
        detail: request.detail,
      },
      directive.unitJid
    );
    log.info('Approver agent verdict', { decision: verdict.decision, reason: verdict.reason });
    // Never `always`: it decided ONE request, and a durable grant is not
    // something an automated approver was asked to give.
    return verdict.decision === 'allow' ? { decision: 'allow' } : DENY;
  }

  if (directive && directive.kind !== 'user') {
    const target = resolveDirectedApprover(directive, deps);
    if (!target.ok) return DENY;
    return deps.enqueue(target.requesterJid, request, { approver: target.approver });
  }

  return deps.approveAsUser(request);
}
