/**
 * Agent-facing text for a refused or unanswered sudo approval. Pure string
 * formatting over the `SudoDecision` shape, kept in `base/` so `fs/sudo-fs.ts`
 * (rank 0) can phrase its EACCES without value-importing `sudo/` (#3742).
 * `sudo/approval-timeout.ts` re-exports both helpers.
 */

import type { SudoDecision, SudoTimeoutReason } from '../sudo/types.js';

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
  unavailable:
    'no approval prompt could be shown to anyone — the approval surface failed before a human ' +
    'or approver saw the request. This is NOT a denial; nobody refused. Do not retry this ' +
    'action in a loop; report that the approval could not be requested.',
};

/** Agent-facing notice for a timed-out approval leg. */
export function timeoutNotice(reason: SudoTimeoutReason): string {
  return TIMEOUT_NOTICE[reason];
}

/**
 * The message a gate reports for a blocked action. `prefix` is the surface name
 * (`sudo`, `secret`) so every layer phrases denial and timeout identically —
 * only the subject changes. Kept here, next to the notices, so the two can
 * never drift apart.
 *
 * An approver's {@link SudoDecision.note} is appended verbatim when present.
 * That is the whole point of the field: a denied agent that is told WHY can
 * fix the request or stop, where a bare "approval denied" invites a retry or a
 * workaround. The note is untrusted prose and is never parsed — it is quoted
 * into the message and nothing else.
 */
export function sudoRefusalMessage(prefix: string, decision: SudoDecision): string {
  const reason = decision.decision === 'deny' ? decision.reason : undefined;
  const base = !reason
    ? `${prefix}: approval denied`
    : reason === 'unavailable'
      ? `${prefix}: approval could not be requested — ${timeoutNotice(reason)}`
      : `${prefix}: approval request timed out — ${timeoutNotice(reason)}`;
  // A timeout's note (if any) is appended too: the approver leg that DID answer
  // may still have said something useful before the other leg ran out.
  const note = decision.note?.trim();
  return note ? `${base} — approver's reason: ${note}` : base;
}
