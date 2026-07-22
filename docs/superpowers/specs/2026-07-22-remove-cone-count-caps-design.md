# Remove SLICC Cone-Count Caps

## Summary

Remove SLICC's per-user running and paused cone-count limits from the web cloud
flow. E2B becomes the sole authority for sandbox capacity. Keep the existing
per-user request-rate limits unchanged.

The local `slicc --cloud` CLI is already uncapped. This change removes the
separate 1-running/5-paused policy enforced by the Cloudflare Worker and shown
in the cloud dashboard.

## Goals

- Allow a user to start or resume any number of cones that E2B permits.
- Support concurrent launches of different PLG labs from the centralized web
  portal.
- Remove obsolete cap configuration, errors, UI states, and tests.
- Preserve concurrency controls for duplicate names and duplicate operations.
- Preserve the existing request-rate limits.

## Non-goals

- Change E2B account, project, quota, timeout, CPU, or memory settings.
- Change request-rate limits.
- Add E2B-specific quota error classification.
- Change the local `slicc --cloud` CLI's behavior.

## Architecture

### Cloud core

Remove cap parsing and enforcement from the start reservation path. Retain the
atomic reservation placeholder because it prevents duplicate names and records
in-flight operations while slow E2B work runs outside the Durable Object lock.

Rename `reserveSlot` to `reserveConeStart` so the API describes its remaining
purpose. Remove the old export rather than retaining a compatibility alias.
Remove `CAP_EXCEEDED` from the cloud error union after all usages are deleted.

The `reserved` cone state remains part of the registry contract. It represents
an in-flight start or resume, not consumption of a capacity slot.

### Cloudflare Worker

Delete `src/cloud/caps.ts` and remove cap checks from start and resume. Start
will still reserve a unique name under `blockConcurrencyWhile`; resume will
still mark its target `reserved` under the same lock. Slow E2B calls remain
outside the lock, allowing operations on different cones to proceed in
parallel.

Remove `CONE_CAP_RUNNING` and `CONE_CAP_PAUSED` from Worker and Durable Object
environment interfaces and from both Wrangler environments.

### Cloud dashboard

Remove cap parsing and validation from `/api/cloud/config`, and stop returning
`capRunning` and `capPaused`.

Continue showing the current counts as `N running · M paused`. Remove the cap
suffix, cap-based Start-button disabling, and cap-related tooltips. Start and
Resume remain subject to normal busy state, authentication, request-rate, and
operation error handling.

## Data Flow

### Start

1. Authenticate the request.
2. Consume one token from the existing per-user Start bucket.
3. Reconcile the user's registry with E2B.
4. Under the Durable Object lock, reject duplicate names and create an atomic
   reservation.
5. Release the lock before creating the E2B sandbox.
6. Promote the reservation to a running cone after successful boot.
7. Remove the reservation and kill any created sandbox on failure through the
   existing cleanup path.

Different named labs can start concurrently. A duplicate live or reserved name
continues to return `NAME_TAKEN`.

### Resume

1. Authenticate the request.
2. Consume one token from the existing per-user Resume bucket.
3. Reconcile the user's registry with E2B.
4. Under the Durable Object lock, validate the target and mark it `reserved`.
5. Release the lock before reconnecting to E2B.
6. Restore the original state if resume fails.

Different paused cones can resume concurrently. A duplicate operation on the
same cone remains blocked because the first operation changes its state to
`reserved`.

## Error Handling

E2B quota and capacity failures continue through the existing cloud operation
error envelope and reservation cleanup. This change does not introduce
speculative classification of E2B SDK errors. A separate change may add stable,
actionable quota mapping after observing the SDK's live error shape.

Remove the SLICC-specific `CAP_EXCEEDED` response because no SLICC capacity cap
remains. Keep `NAME_TAKEN`, `ALREADY_RUNNING`, `NOT_FOUND`, readiness failures,
and existing internal-error handling.

## Request-Rate Limits

Keep the current independent per-user token buckets unchanged:

| Operation | Burst capacity | Refill rate |
| --------- | -------------: | ----------: |
| Start     |             30 |     30/hour |
| Resume    |             30 |     30/hour |
| List      |             60 |   60/minute |
| Pause     |             60 |   60/minute |
| Kill      |             60 |   60/minute |

A full Start or Resume bucket permits 30 immediate requests. The refill rate
applies after tokens are consumed; it does not serialize valid parallel lab
launches.

## Tests

### Cloud core

- Replace cap-rejection tests with coverage that permits multiple reservations.
- Preserve duplicate-name rejection, stale-reservation cleanup, and failed-start
  cleanup coverage.
- Update imports and descriptions for `reserveConeStart`.

### Cloudflare Worker

- Delete `caps.test.ts`.
- Verify existing running and paused cones do not block another start.
- Verify two distinct concurrent starts both succeed.
- Verify two different paused cones can resume concurrently.
- Verify duplicate operations on the same cone remain rejected.
- Update cloud-config tests to verify cap fields are absent.
- Leave request-rate tests unchanged.

### Dashboard

Verify that the dashboard reports only running and paused counts and contains no
cap-based disabling or tooltips.

## Documentation

Update:

- `packages/cloud-core/CLAUDE.md` for the renamed reservation operation and the
  removal of cap enforcement.
- `packages/cloudflare-worker/CLAUDE.md` to remove cap configuration and state
  that E2B owns sandbox capacity.

Do not add compatibility or migration documentation for removed cap variables.

## Verification

Run focused cloud-core and Cloudflare Worker tests first. Then run repository
lint, typecheck, relevant coverage checks, the worker build, and touched-file
complexity checks according to `docs/verification.md`.
