# Planning Artifact Cleanup — GraphQL merge-queue probe

**Status:** Proposed
**Date:** 2026-05-19
**Branch:** `fix/planning-artifact-cleanup-graphql`

## 1. Why

The `planning-artifact-cleanup` workflow opens a follow-up PR after each
landing on `main` and is supposed to enqueue that PR into the merge queue
without human intervention. In practice the `Add cleanup PR to merge
queue` step has been failing on every push that actually produces a
cleanup branch — leaving the bot PR to be added to the queue by hand.

The failure is reproducible in CI logs (e.g. run `26102979698` for PR
#684): the very first probe `gh pr view "$PR_URL" --json isInMergeQueue`
exits non-zero with

```
Unknown JSON field: "isInMergeQueue"
```

The `gh` CLI shipped on `ubuntu-latest` does not expose
`isInMergeQueue` as a `--json` field on `pr view`. With
`set -euo pipefail`, the step terminates before the polling loop or the
`enqueuePullRequest` GraphQL mutation can run.

## 2. Fix

Replace both `gh pr view --json ...,isInMergeQueue ...` invocations with
a direct GraphQL query that selects the same three fields. The GraphQL
schema has always exposed `isInMergeQueue`, so this side-steps CLI
version drift entirely.

```bash
pr_state() {
  gh api graphql \
    -f query='query($id:ID!){ node(id:$id){ ... on PullRequest { mergeable mergeStateStatus isInMergeQueue } } }' \
    -F id="$PR_ID" \
    --jq '"\(.data.node.mergeable)|\(.data.node.mergeStateStatus)|\(.data.node.isInMergeQueue)"'
}
```

The composite `mergeable|mergeStateStatus|isInMergeQueue` string format
is preserved so the surrounding shell parsing stays identical.

## 3. Why a planning artifact

This document exists solely so that landing this PR demonstrably exercises
the cleanup workflow end-to-end: after merge, the bot must detect this
file under `docs/superpowers/`, open a follow-up cleanup PR removing it,
poll the GraphQL query introduced by this fix, and enqueue itself into
the merge queue without a human pressing "Merge when ready". If the
follow-up PR lands automatically, the fix is verified in production.

## 4. Out of scope

- Changes to the `Remove tracked planning artifacts` step itself.
- Restructuring of `docs/superpowers/` or `.superpowers/` layout.
- Any change to the merge-queue configuration or branch protection rules.
