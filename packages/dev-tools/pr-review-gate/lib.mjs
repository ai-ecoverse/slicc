export function countInlineReviewComments(comments) {
  return Array.isArray(comments) ? comments.length : 0;
}

export function decideReview({ state, isDraft, inlineReviewCommentCount } = {}) {
  if (state !== 'open') {
    return { shouldReview: false, reason: `PR is not open (state="${state ?? 'unknown'}").` };
  }
  if (isDraft) {
    return { shouldReview: false, reason: 'PR is a draft.' };
  }
  const count = Number(inlineReviewCommentCount) || 0;
  if (count > 0) {
    return {
      shouldReview: false,
      reason: `PR already has ${count} inline review comment(s); a reviewer has it covered.`,
    };
  }
  return {
    shouldReview: true,
    reason: 'PR is open, not a draft, and has no inline review comments — reviewing.',
  };
}
