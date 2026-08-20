/**
 * Fail-closed timeout wrapper for the user-facing sudo brokers.
 *
 * A sudo prompt waits on a human gesture, and until that gesture arrives the
 * requesting agent turn is blocked — the cone sits on an unresolved
 * `requestApproval` promise with no way to make progress. When nobody is at
 * the machine that wait is unbounded: the OS dialog stays up, the HTTP request
 * never returns, and the agent hangs indefinitely.
 *
 * This wrapper bounds it. After {@link USER_SUDO_TIMEOUT_MS} with no answer the
 * request settles fail-closed as `deny` carrying `reason: 'user-timeout'`, so
 * the enforcement layers (command guard, `SudoFS`, `sudo`/`secret` commands)
 * can tell the agent it was *not answered* rather than *refused*. That
 * distinction matters: a denial is a decision to respect, while a timeout means
 * the approver was absent — retrying the same action just burns another five
 * minutes.
 *
 * Settling the caller is not enough on its own: each broker does pre-prompt
 * work (an LLM `suggest` call for the "Always" pattern, transport setup) BEFORE
 * it raises the native surface. If that work outlives the budget and then
 * recovers, an un-cancelled broker would pop a brand-new dialog for an action
 * the agent abandoned minutes ago. So the wrapper also aborts a signal the
 * brokers honour — see {@link SudoRequestOptions.signal}.
 *
 * Known limitation: a dialog ALREADY on screen when the budget expires stays
 * there; there is no cancel channel to `window.confirm` or an OS dialog. A
 * gesture that lands after the timeout is logged and discarded, including an
 * "Always" grant, which is NOT persisted because the enforcement layer that
 * owns the persist sink has already moved on.
 */

import { createLogger } from '../base/logger.js';
import type {
  SudoBroker,
  SudoDecision,
  SudoRequest,
  SudoRequestOptions,
  SudoTimeoutReason,
} from './types.js';

const log = createLogger('sudo:timeout');

/**
 * How long a user-facing approval may block the requesting agent before it
 * settles fail-closed. Matches `CONE_SUDO_TIMEOUT_MS` (the scoop → cone leg)
 * so both hops in a delegated approval expire on the same budget.
 */
export const USER_SUDO_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Agent-facing explanation for each timed-out leg. Written for the model, not
 * the human: each has to be unambiguous that no answer was given, WHO failed to
 * answer (the two legs have different approvers and so different recovery), and
 * that an immediate retry is the wrong next move.
 */
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

/** Agent-facing notice for a timed-out approval leg. */
export function timeoutNotice(reason: SudoTimeoutReason): string {
  return TIMEOUT_NOTICE[reason];
}

/** The canonical fail-closed decision produced when a prompt goes unanswered. */
export function timedOutDecision(reason: SudoTimeoutReason = 'user-timeout'): SudoDecision {
  return { decision: 'deny', reason };
}

/** True when `decision` was settled by an unanswered request rather than a refusal. */
export function isTimedOut(decision: SudoDecision): boolean {
  return decision.decision === 'deny' && decision.reason !== undefined;
}

/**
 * The message a gate reports for a blocked action. `prefix` is the surface name
 * (`sudo`, `secret`) so every layer phrases denial and timeout identically —
 * only the subject changes. Kept here, next to the notices, so the two can
 * never drift apart.
 */
export function sudoRefusalMessage(prefix: string, decision: SudoDecision): string {
  const reason = decision.decision === 'deny' ? decision.reason : undefined;
  if (!reason) return `${prefix}: approval denied`;
  return `${prefix}: approval request timed out — ${timeoutNotice(reason)}`;
}

/** Injection seams for {@link withApprovalTimeout}. Defaults use real timers. */
export interface ApprovalTimeoutOptions {
  /** Budget in ms. Defaults to {@link USER_SUDO_TIMEOUT_MS}. Non-finite / `<= 0` disables. */
  timeoutMs?: number;
  /** Timer factory. Defaults to `setTimeout`. Override in tests. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Timer canceller. Defaults to `clearTimeout`. Override in tests. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * Wrap `broker` so a request nobody answers settles as a timeout instead of
 * blocking forever. The wrapped broker is a drop-in {@link SudoBroker}: an
 * answered prompt passes through untouched (including its `always` pattern),
 * and a broker that already fails closed on its own keeps doing so.
 *
 * A caller-supplied `signal` still cancels the call; the wrapper's own timeout
 * aborts in addition to it, never instead of it.
 */
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
          // Abort BEFORE resolving: a broker still doing pre-prompt work must
          // not raise a native prompt for an action we have already abandoned.
          controller.abort();
          finish(timedOutDecision('user-timeout'));
        }, timeoutMs);

        const settle = (decision: SudoDecision): void => {
          if (settled) {
            // The human answered after we gave up. Nothing to apply — the
            // caller already took the fail-closed path — but log it so a
            // "I clicked Allow and nothing happened" report is diagnosable.
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
