/**
 * Single source of truth for the follower runtime id used to address a
 * specific follower (e.g. from the cherry-emit shell command).
 *
 * Contract: callers MUST pass a non-empty `bootstrapId`. An empty value
 * throws — this is a fail-fast invariant, not a silently-defaulted id.
 */
export function canonicalRuntimeId(bootstrapId: string): string {
  if (!bootstrapId) throw new Error('canonicalRuntimeId: bootstrapId is required');
  return bootstrapId.startsWith('follower-') ? bootstrapId : `follower-${bootstrapId}`;
}
