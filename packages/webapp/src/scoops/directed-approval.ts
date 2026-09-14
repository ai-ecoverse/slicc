import { createLogger } from '../base/logger.js';
import type { SudoApproverDirective, SudoDecision, SudoRequest } from '../sudo/types.js';
import { derivePolicy } from '../work-unit/policy.js';
import { AGENT_BRIDGE_GLOBAL_KEY, type AgentBridge } from './agent-bridge.js';
import type { RegisteredScoop } from './types.js';

const log = createLogger('directed-approval');

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
  workspaceFor: (scoop: RegisteredScoop) => import('../work-unit/types.js').WorkUnitWorkspace;

  scoops: ReadonlyMap<string, RegisteredScoop>;

  ownerRootOf: (jid: string) => RegisteredScoop | undefined;
}

export function resolveDirectedApprover(
  directive: SudoApproverDirective,
  deps: DirectedApprovalDeps
): DirectedApprovalTarget | DirectedApprovalRefusal {
  if (directive.kind === 'user') return refuse('the user tier is not a directed approval');

  if (directive.kind === 'agent') return refuse('agent approvals are not enqueued to a unit');

  const requesterJid = directive.unitJid;
  if (!deps.scoops.has(requesterJid)) return refuse('the requesting unit is not registered');
  const owner = deps.ownerRootOf(requesterJid);
  if (!owner) return refuse('no owning cone for the requesting unit');

  const approver =
    directive.kind === 'cone'
      ? owner
      : [...deps.scoops.values()].find(
          (scoop) =>
            scoop.parentJid === owner.jid &&
            (scoop.name === directive.scoopName || scoop.folder === directive.scoopName)
        );
  if (!approver) return refuse('delegated approver not found under this cone');

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
  enqueue: (
    requesterJid: string,
    request: SudoRequest,
    opts: { approver: RegisteredScoop }
  ) => Promise<SudoDecision>;

  approveAsUser: (request: SudoRequest) => Promise<SudoDecision>;

  getSharedFs: () => {
    readFile: (path: string, opts: { encoding: 'utf-8' }) => Promise<unknown>;
  } | null;
}

export async function runDirectedApproval(
  request: SudoRequest,
  deps: RunDirectedApprovalDeps
): Promise<SudoDecision> {
  const directive = request.approver;

  if (directive?.kind === 'agent') {
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

        requester: request.requester ?? 'an unidentified requester',
        detail: request.detail,
      },
      directive.unitJid
    );
    log.info('Approver agent verdict', { decision: verdict.decision, reason: verdict.reason });

    return verdict.decision === 'allow' ? { decision: 'allow' } : DENY;
  }

  if (directive && directive.kind !== 'user') {
    const target = resolveDirectedApprover(directive, deps);
    if (!target.ok) return DENY;
    return deps.enqueue(target.requesterJid, request, { approver: target.approver });
  }

  return deps.approveAsUser(request);
}
