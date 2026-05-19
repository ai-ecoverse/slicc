# Planning Artifact Cleanup — Second end-to-end verification

**Status:** Verification artifact
**Date:** 2026-05-19
**Branch:** `verify/planning-artifact-cleanup-e2e-2`

## Purpose

Second deliberate planning artifact, placed under `docs/superpowers/`
to verify that the cleanup workflow is now reliably hands-off after
#688 (GraphQL probe) and #690 (kick `pull_request: synchronize`). The
first end-to-end test (#691 → #692) confirmed that both fixes work,
but the auto-generated cleanup PR still hung in the merge queue with
`AWAITING_CHECKS` for ~22 minutes until a dequeue/re-enqueue unstuck
it. This run is intended to determine whether that hang was a one-off
merge-queue dispatch flake or a reproducible problem that needs a
watchdog.

## What success looks like

1. This PR lands via the merge queue.
2. The cleanup workflow opens a follow-up PR removing this file.
3. The follow-up PR enters the merge queue and lands **without any
   manual dequeue/re-enqueue**.

If step 3 hangs again, the workflow needs a built-in watchdog to
recover.

## Out of scope

Same as the previous verification artifact — no product behaviour
depends on this file. It exists solely to exercise the cleanup
workflow.
