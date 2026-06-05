/*
 * PR-review gate — pure logic.
 *
 * Decides whether the automated Claude Code review should run on a pull
 * request. The rule: review only when the PR is still open, not a draft, and
 * carries zero inline review comments (so PRs that personal reviewers like
 * Codex/Copilot already covered are skipped). This module is intentionally
 * free of I/O so it can be unit-tested in isolation — the GitHub API calls
 * live in `check-pr-review-gate.mjs`.
 */

/**
 * Count the inline review comments returned by
 * `GET /repos/{owner}/{repo}/pulls/{n}/comments`. Tolerates null/undefined
 * and non-array input by treating them as zero comments.
 * @param {Array<unknown>|null|undefined} comments
 * @returns {number}
 */
export function countInlineReviewComments(comments) {
  return Array.isArray(comments) ? comments.length : 0;
}

/**
 * Decide whether Claude should review the PR. Each branch returns a clear,
 * human-readable `reason` so the workflow log and `$GITHUB_OUTPUT` explain
 * the decision.
 * @param {{state?: string, isDraft?: boolean, inlineReviewCommentCount?: number}} input
 * @returns {{shouldReview: boolean, reason: string}}
 */
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
