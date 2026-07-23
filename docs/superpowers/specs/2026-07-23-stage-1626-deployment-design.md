# Stage PR #1626 Deployment Design

## Summary

Redeploy PR #1626's full cloud path to the shared staging environment and test
removal of SLICC's running and paused cone-count limits against real E2B
sandboxes.

Use the existing serialized `Worker Staging Deploy` workflow rather than a
manual deployment. Treat staging as a forward-only shared integration target:
recover from failures by retrying the current SHA or deploying a newer fix,
never by replaying an older deployment as rollback.

## Scope

Deploy and validate:

- Cloudflare Worker `slicc-tray-hub-staging`.
- Static webapp assets used by the staging `/cloud` dashboard.
- Staging Worker secrets.
- E2B template alias `adobe-experience-manager/slicc-staging`.
- Authenticated cloud start, pause, resume, list, and kill behavior.

The preview Worker is excluded. PR #1626 does not change preview behavior, and
cloud-cone lifecycle testing uses the hub Worker and E2B template.

## Current State

PR #1626 points to SHA `7e7361560cedefe45ab384825069f8a4fc33fd88`.
Its original staging run `29953267621` completed successfully, including Worker
and E2B template deployment. A later Renovate staging run `29973254053`
overwrote the two shared staging singletons, so #1626 is no longer guaranteed to
be live.

The local E2B CLI is authenticated as `catalan@adobe.com` and targets the
`Adobe Experience Manager` team (`c5b04852-7176-48d8-8d37-cd103a7c7545`).

## Staging Lease

Staging deployment and testing require a coordinated 30–45 minute window.
Before rerunning #1626:

1. Announce the test window.
2. Confirm no `worker-staging.yml` run is queued or in progress.
3. Record the current active staging deployment SHA, deployment ID, URL, and
   E2B `slicc-staging` build ID/timestamp for provenance and diagnosis.
4. Confirm PR #1626 still points to the expected SHA and the E2B CLI targets the
   Adobe Experience Manager team.

The workflow's global concurrency group serializes deployments, but it does not
reserve staging after a run finishes. Recheck active provenance before each
major test phase. If another run deploys, the lease is lost and subsequent
results cannot be attributed to #1626.

## Deployment

Rerun the existing PR workflow:

```bash
gh run rerun 29953267621
gh run watch 29953267621 --exit-status
```

Require success for:

- webapp build
- Worker unit test
- shared-ts, cloud-core, and node-server builds
- `slicc-staging` E2B template publish
- staging R2 asset archive upload
- staging Worker deploy
- staging secret upload
- deployed Worker/R2 smoke test
- GitHub deployment success status

After the run:

1. Verify the newest successful GitHub `staging` deployment SHA is #1626's SHA.
2. Capture the deployment `environment_url`.
3. Verify `slicc-staging` has a new E2B build ID and an `updatedAt` later than
   the rerun start.
4. Confirm no later staging run is queued or active.

## Validation

Use cone names prefixed with `stage-1626-<timestamp>-` so all test resources are
identifiable and removable.

### Provenance and unauthenticated checks

- Active GitHub staging deployment matches #1626.
- E2B `slicc-staging` build was produced during the rerun window.
- `GET /cloud` returns `200` HTML with CSP.
- `GET /api/cloud/config` returns `200` with neither `capRunning` nor
  `capPaused`.
- Unauthenticated `GET /api/cloud/list` returns `401`.

### Authenticated dashboard checks

Sign in through the staging Adobe browser flow. Do not copy bearer tokens into
scripts, shell history, screenshots, or PR comments.

Verify:

- The dashboard summary is `N running · M paused` with no cap suffix.
- Create is not disabled by running or paused counts.
- Adobe's default account/model is available.

### Running-limit and portal fan-out check

Open two authenticated staging dashboard tabs:

1. Configure unique names ending in `-a` and `-b`.
2. Start both within a few seconds.
3. Require both to reach `running` with usable Open links.
4. Confirm at least `2 running` in the summary.
5. Reload both tabs and confirm consistent state.

This validates the centralized portal case and would fail under the former
one-running-cone limit.

### Former paused-limit boundary

1. Pause `a` and `b`.
2. Create and pause `c`, `d`, and `e`.
3. Confirm `0 running · 5 paused`.
4. Create `f` while five cones remain paused.
5. Require `f` to reach `running`.

The previous paused cap would reject the final start.

### Resume above the former running limit

With `f` running:

1. Resume `a` and `b` within a few seconds.
2. Require all three cones to reach `running`.
3. Confirm no cap error or count-based disabled control appears.
4. Reload and reconcile states.
5. Attempt a duplicate name while the original exists and require
   `NAME_TAKEN` behavior.

### Diagnostics

Record each test cone's name, E2B sandbox ID, Worker state, E2B state, and
start/resume latency. On failure, inspect:

```bash
e2b sandbox info <sandbox-id>
e2b sandbox logs <sandbox-id>
e2b sandbox metrics <sandbox-id>
```

The first successful portal-created cone also verifies the new E2B template
boots, produces a join URL, and connects to the staging Worker. This closes the
coverage gap left by the workflow's currently disabled template-boot step.

## Cleanup

Cleanup is mandatory on both success and failure:

1. Kill every `stage-1626-*` cone through the dashboard.
2. Confirm none remain in the authenticated Worker list.
3. Confirm none remain in E2B running or paused listings.
4. Save deployment provenance, E2B build ID, screenshots, timings, and the
   pass/fail matrix in a PR #1626 comment.

## Forward-Only Recovery

There is no staging rollback. The workflow publishes the E2B template before
the Worker, so a failed run can leave mixed provenance. Treat that state as
invalid and fix forward:

- Transient workflow failure: rerun the current #1626 SHA.
- Code or configuration failure: push a fix and deploy the newer PR SHA.
- Another PR supersedes staging: stop testing, clean up, and acquire a new test
  window later.
- Lifecycle test failure: capture evidence, clean up cones, and fix forward.

Previous deployment and build IDs are diagnostic evidence only, not rollback
targets.

## Security

- Use GitHub environment secrets for deployment.
- Authenticate through the staging browser flow.
- Do not expose IMS, E2B, GitHub, TURN, or Cloudflare credentials.
- Verify the E2B CLI team before diagnostics.
- Do not run manual component deploys or production-targeted commands.

## Success Criteria

Testing is complete when:

- GitHub staging deployment matches the tested #1626 SHA.
- `slicc-staging` was built during the deployment window.
- Worker/R2 smoke passes.
- Two near-concurrent starts succeed.
- A start succeeds with five paused cones.
- Resumes succeed above the former running limit.
- Duplicate-name protection remains intact.
- The dashboard shows counts without cap text or gating.
- Every test cone is killed.
- Evidence is posted to PR #1626.
- No superseding deployment invalidated the test window.
