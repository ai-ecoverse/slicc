/**
 * One fail-closed reading of an approval answer (#2276 slice B).
 *
 * Shared by both ops modules, and deliberately the same rule as
 * `sudo/http-broker.ts`: anything that is not a recognized `allow` / `always`
 * shape is a `deny`, and an `always` with no pattern falls back to the
 * suggestion. Three copies of this rule would be three chances for one of
 * them to fail OPEN.
 *
 * This reads a DECISION. It does not read a transport error — a relay that
 * broke is a `CapabilityFailure`, not a human saying no, and the adapters
 * keep those apart before they get here.
 */

import type { ApprovalDecision } from './types.js';

/** Coerce an untrusted decision body into an {@link ApprovalDecision}. */
export function normalizeApprovalDecision(body: unknown, suggested: string): ApprovalDecision {
  if (!body || typeof body !== 'object') return { decision: 'deny' };
  const decision = (body as { decision?: unknown }).decision;
  if (decision === 'allow') return { decision: 'allow' };
  if (decision === 'always') {
    const pattern = (body as { pattern?: unknown }).pattern;
    const resolved =
      typeof pattern === 'string' && pattern.trim().length > 0 ? pattern.trim() : suggested;
    return { decision: 'always', pattern: resolved };
  }
  return { decision: 'deny' };
}
