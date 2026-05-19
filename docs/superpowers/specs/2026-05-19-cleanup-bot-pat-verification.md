# Planning Artifact Cleanup — BOT_PAT verification

**Status:** Verification artifact
**Date:** 2026-05-19
**Branch:** `verify/cleanup-bot-pat-e2e`

## Purpose

Final end-to-end test after #695 switched the cleanup workflow's
`gh pr create` and `gh pr merge --auto` calls to authenticate with
`BOT_PAT` instead of `GITHUB_TOKEN`. Two prior runs (#691 → #692 and
#693 → #694) showed the cleanup PR reproducibly hanging in
`AWAITING_CHECKS` because `merge_group` workflow runs are suppressed
when the enqueue call originates from `GITHUB_TOKEN`.

## Success criteria

- This PR merges via the merge queue.
- The cleanup workflow opens a follow-up PR removing this file.
- The follow-up PR lands automatically with **zero manual intervention**
  — no dequeue, no re-enqueue, no extra commits.

If success criteria are not met, more investigation is required.
