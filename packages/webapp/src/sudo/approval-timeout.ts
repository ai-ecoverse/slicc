import { createLogger } from '../base/logger.js';
import type {
  SudoBroker,
  SudoDecision,
  SudoRequest,
  SudoRequestOptions,
  SudoTimeoutReason,
} from './types.js';

const log = createLogger('sudo:timeout');

export const USER_SUDO_TIMEOUT_MS = 5 * 60 * 1000;

const TIMEOUT_NOTICE: Record<SudoTimeoutReason, string> = {
  'user-timeout':
    'no response from the user within 5 minutes. This is a TIMEOUT, not a denial — ' +
    'the user was not there to answer. Do not retry this action; report that the ' +
    'approval request went unanswered and wait for the user before trying again.',
  'cone-timeout':
    'no response from the cone agent within 5 minutes. This is a TIMEOUT, not a denial — ' +
    'no human was ever prompted, the cone simply never resolved the request. Do not retry ' +
    'this action; report that the escalation went unanswered and continue with work that ' +
    'does not need it.',
};

export function timeoutNotice(reason: SudoTimeoutReason): string {
  return TIMEOUT_NOTICE[reason];
}

export function timedOutDecision(reason: SudoTimeoutReason = 'user-timeout'): SudoDecision {
  return { decision: 'deny', reason };
}

export function isTimedOut(decision: SudoDecision): boolean {
  return decision.decision === 'deny' && decision.reason !== undefined;
}

export function sudoRefusalMessage(prefix: string, decision: SudoDecision): string {
  const reason = decision.decision === 'deny' ? decision.reason : undefined;
  if (!reason) return `${prefix}: approval denied`;
  return `${prefix}: approval request timed out — ${timeoutNotice(reason)}`;
}

export interface ApprovalTimeoutOptions {
  timeoutMs?: number;

  setTimer?: (cb: () => void, ms: number) => unknown;

  clearTimer?: (handle: unknown) => void;
}

export function withApprovalTimeout(
  broker: SudoBroker,
  opts: ApprovalTimeoutOptions = {}
): SudoBroker {
  const timeoutMs = opts.timeoutMs ?? USER_SUDO_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return broker;

  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return {
    requestApproval(req: SudoRequest, callOpts?: SudoRequestOptions): Promise<SudoDecision> {
      return new Promise<SudoDecision>((resolve) => {
        const controller = new AbortController();
        const abortOuter = () => controller.abort();
        callOpts?.signal?.addEventListener('abort', abortOuter, { once: true });

        let settled = false;
        const finish = (decision: SudoDecision): void => {
          settled = true;
          callOpts?.signal?.removeEventListener('abort', abortOuter);
          resolve(decision);
        };

        const handle = setTimer(() => {
          if (settled) return;
          log.warn('sudo approval timed out — failing closed', {
            kind: req.kind,
            detail: req.detail,
            timeoutMs,
          });

          controller.abort();
          finish(timedOutDecision('user-timeout'));
        }, timeoutMs);

        const settle = (decision: SudoDecision): void => {
          if (settled) {
            log.warn('sudo decision arrived after timeout — discarded', {
              kind: req.kind,
              detail: req.detail,
              decision: decision.decision,
            });
            return;
          }
          clearTimer(handle);
          finish(decision);
        };

        broker.requestApproval(req, { signal: controller.signal }).then(settle, (err: unknown) => {
          log.warn('sudo broker threw — denying', {
            error: err instanceof Error ? err.message : String(err),
          });
          settle({ decision: 'deny' });
        });
      });
    },
  };
}
