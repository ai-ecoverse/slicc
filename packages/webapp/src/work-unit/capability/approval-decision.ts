import type { ApprovalDecision } from './types.js';

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
