import type { ApprovalDecision, ApprovalDenialReason } from './types.js';

const DENIAL_REASONS: readonly ApprovalDenialReason[] = [
  'user-timeout',
  'cone-timeout',
  'unavailable',
];

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
