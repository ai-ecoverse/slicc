import type { SudoDecision, SudoTimeoutReason } from '../sudo/types.js';

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

export function timeoutNotice(reason: SudoTimeoutReason): string {
  return TIMEOUT_NOTICE[reason];
}

export function sudoRefusalMessage(prefix: string, decision: SudoDecision): string {
  const reason = decision.decision === 'deny' ? decision.reason : undefined;
  const base = !reason
    ? `${prefix}: approval denied`
    : reason === 'unavailable'
      ? `${prefix}: approval could not be requested — ${timeoutNotice(reason)}`
      : `${prefix}: approval request timed out — ${timeoutNotice(reason)}`;

  const note = decision.note?.trim();
  return note ? `${base} — approver's reason: ${note}` : base;
}
