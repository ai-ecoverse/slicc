/**
 * One fail-closed reading of an approval answer (#2276 slice B).
 *
 * Shared by both ops modules: anything that is not a recognized `allow` /
 * `always` shape is a `deny`, and an `always` with no pattern falls back to
 * the suggestion. `sudo/capability-gesture-broker.ts` (slice C) reuses this
 * result as-is — it never re-normalizes — so this is now the ONE copy of
 * the rule, not three chances for one of them to fail OPEN.
 *
 * This reads a DECISION. It does not read a transport error — a relay that
 * broke is a `CapabilityFailure`, not a human saying no, and the adapters
 * keep those apart before they get here.
 */

import type { ApprovalDecision, ApprovalDenialReason } from './types.js';

const DENIAL_REASONS: readonly ApprovalDenialReason[] = [
  'user-timeout',
  'cone-timeout',
  'unavailable',
];

/**
 * Coerce an untrusted decision body into an {@link ApprovalDecision}.
 *
 * Two kinds of deny come out of this, and they must stay apart:
 *
 *   - `{ decision: 'deny' }` exactly as sent — an approver said no. A known
 *     unanswered `reason` riding on it (a page-side prompt that could not be
 *     shown, a delegated phone that timed out) is preserved, not stripped.
 *   - anything that is not a decision at all — `null`, a string, an unknown
 *     verb, a hosted origin's route catalog answering 200 for an endpoint it
 *     does not have — denies with `reason: 'unavailable'`. Nobody refused;
 *     the hop that should have asked someone did not.
 */
export function normalizeApprovalDecision(body: unknown, suggested: string): ApprovalDecision {
  if (!body || typeof body !== 'object') return { decision: 'deny', reason: 'unavailable' };
  const decision = (body as { decision?: unknown }).decision;
  if (decision === 'allow') return { decision: 'allow' };
  if (decision === 'always') {
    const pattern = (body as { pattern?: unknown }).pattern;
    const resolved =
      typeof pattern === 'string' && pattern.trim().length > 0 ? pattern.trim() : suggested;
    return { decision: 'always', pattern: resolved };
  }
  if (decision !== 'deny') return { decision: 'deny', reason: 'unavailable' };
  const reason = DENIAL_REASONS.find((known) => known === (body as { reason?: unknown }).reason);
  return reason ? { decision: 'deny', reason } : { decision: 'deny' };
}
