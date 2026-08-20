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
 * request settles fail-closed as `deny` and carries `reason: 'timeout'`, so the
 * enforcement layers (command guard, `SudoFS`, `sudo`/`secret` commands) can
 * tell the agent it was *not answered* rather than *refused*. That distinction
 * matters: a denial is a decision to respect, while a timeout means the human
 * was absent — retrying the same action just burns another five minutes.
 *
 * Known limitation: there is no cancel channel to the native surface, so a
 * dialog that is already on screen stays there. A gesture that lands after the
 * timeout is logged and discarded — including an "Always" grant, which is NOT
 * persisted because the enforcement layer that owns the persist sink has
 * already moved on. The human sees the prompt vanish only when they answer it.
 */

import { createLogger } from '../base/logger.js';
import type { SudoBroker, SudoDecision, SudoRequest } from './types.js';

const log = createLogger('sudo:timeout');

/**
 * How long a user-facing approval may block the requesting agent before it
 * settles fail-closed. Matches `CONE_SUDO_TIMEOUT_MS` (the scoop → cone leg)
 * so both hops in a delegated approval expire on the same budget.
 */
export const USER_SUDO_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Agent-facing explanation appended to every timed-out gate message. Written
 * for the model, not the human: it has to be unambiguous that no answer was
 * given AND that an immediate retry is the wrong next move.
 */
export const SUDO_TIMEOUT_NOTICE =
  'no response from the user within 5 minutes. This is a TIMEOUT, not a denial — ' +
  'the user was not there to answer. Do not retry this action; report that the ' +
  'approval request went unanswered and wait for the user before trying again.';

/** The canonical fail-closed decision produced when a prompt goes unanswered. */
export function timedOutDecision(): SudoDecision {
  return { decision: 'deny', reason: 'timeout' };
}

/** True when `decision` was settled by an unanswered prompt rather than a human. */
export function isTimedOut(decision: SudoDecision): boolean {
  return decision.decision === 'deny' && decision.reason === 'timeout';
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
 * Wrap `broker` so a prompt nobody answers settles as a timeout instead of
 * blocking forever. The wrapped broker is a drop-in {@link SudoBroker}: an
 * answered prompt passes through untouched (including its `always` pattern),
 * and a broker that already fails closed on its own keeps doing so.
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
    requestApproval(req: SudoRequest): Promise<SudoDecision> {
      return new Promise<SudoDecision>((resolve) => {
        let settled = false;
        const handle = setTimer(() => {
          if (settled) return;
          settled = true;
          log.warn('sudo approval timed out — failing closed', {
            kind: req.kind,
            detail: req.detail,
            timeoutMs,
          });
          resolve(timedOutDecision());
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
          settled = true;
          clearTimer(handle);
          resolve(decision);
        };

        broker.requestApproval(req).then(settle, (err: unknown) => {
          log.warn('sudo broker threw — denying', {
            error: err instanceof Error ? err.message : String(err),
          });
          settle({ decision: 'deny' });
        });
      });
    },
  };
}
