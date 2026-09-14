import { createLogger } from '../base/logger.js';
import { type CapabilityBroker, normalizeApprovalDecision } from '../work-unit/capability/index.js';
import { suggestPattern } from './suggest-pattern.js';
import type { SudoBroker, SudoDecision, SudoRequest, SudoRequestOptions } from './types.js';

const log = createLogger('sudo:capability-gesture');

export interface CapabilityGestureSudoBrokerDeps {
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
}

export function createCapabilityGestureSudoBroker(
  broker: CapabilityBroker | null,
  deps: CapabilityGestureSudoBrokerDeps = {}
): SudoBroker {
  const suggest = deps.suggest ?? suggestPattern;

  return {
    async requestApproval(req: SudoRequest, opts?: SudoRequestOptions): Promise<SudoDecision> {
      const signal = opts?.signal;
      let suggestedPattern: string;
      if (req.suggestedPattern) {
        suggestedPattern = req.suggestedPattern;
      } else {
        try {
          suggestedPattern = await suggest(req, signal);
        } catch {
          suggestedPattern = req.detail;
        }
      }

      if (signal?.aborted) {
        log.warn('sudo approval aborted before prompting — denying', { detail: req.detail });
        return { decision: 'deny' };
      }

      if (!broker) {
        log.warn(
          'no CapabilityBroker injected for the sudo gesture hop — denying (composition bug, never a guessed transport)',
          { detail: req.detail }
        );
        return { decision: 'deny' };
      }

      const result = await broker.approvals.request({
        kind: req.kind,
        detail: req.detail,
        suggestedPattern,
        ...(req.requester ? { requester: req.requester } : {}),
        ...(req.approver ? { approver: req.approver } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        log.warn('capability broker approvals.request failed — denying', {
          message: result.message,
        });
        return { decision: 'deny' };
      }

      return normalizeApprovalDecision(result.value, suggestedPattern);
    },
  };
}
