export function canonicalRuntimeId(bootstrapId: string): string {
  if (!bootstrapId) throw new Error('canonicalRuntimeId: bootstrapId is required');
  return bootstrapId.startsWith('follower-') ? bootstrapId : `follower-${bootstrapId}`;
}
