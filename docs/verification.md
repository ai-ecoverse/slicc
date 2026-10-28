# Pre-push / PR validation

Most of this content lives in
[`.agents/skills/verifying-before-push/SKILL.md`](../.agents/skills/verifying-before-push/SKILL.md).
The stacked-PR CI contract is documented here so a search of `docs/` finds it.

## Stacked PRs

A stacked PR is one whose base is another topic branch, not `main`.
`ci.yml`'s `pull_request` trigger has no branch filter, so every base,
including topic-branch stacks, runs the workflow from the PR's merge commit.

### What runs

| Surface                                                        | On a stack              | On a `main`-based PR / merge queue             |
| -------------------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Path-filtered ubuntu jobs (lint, typecheck, coverage, builds)  | yes                     | yes                                            |
| Cheap macOS `swift-*` + `ios-app` (lint / format / coverage)   | yes                     | yes (queue leader only)                        |
| `ios-app-tests` (4-way simulator matrix)                       | no                      | yes (queue leader only, when iOS paths change) |
| Aggregate check name                                           | `ci-stack`              | `ci`                                           |
| `ci.yml` `cloudflare-worker` local gates (build/dry-run/tests) | yes                     | yes                                            |
| Staging mutation (R2 / deploy / secrets / smoke)               | no                      | yes (trusted PRs; queue leader only)           |
| `worker-staging.yml`                                           | no (`branches: [main]`) | yes, when its paths match                      |

Stacked runs never mutate staging. The deploy lives in `ci.yml`'s
`cloudflare-worker` job (`RUN_CLOUDFLARE_STAGING`), not only in
`worker-staging.yml`.

Staging mutations are serialized by turnstyle (`staging-mutation-queue`). If a
run is still waiting for its turn when only 15 minutes of the job's 45 are
left, usually behind a
merge-queue run stuck on hosted runners, it skips the staging deploy and smoke
tests with a `STAGING_SKIPPED` warning. It does not run into the job's
45-minute timeout and turn `ci` red. The local Worker gates still run.

CI measures a stacked PR's first-load delta against its own base
(`origin/<base>`). Locally on a stack, pass `--baseline=origin/<parent>` to
`check-first-load-size.mjs` — the workspace `size` script does not forward
extra args.

The aggregate must not be named `ci` on a stacked commit. Documented GitHub
behaviour is that a required check skipped by `if:` still satisfies branch
protection
([status checks](https://docs.github.com/en/pull-requests/reference/status-checks)).
This change does not rely on that: stacked runs never mint a check named `ci`.
The ruleset on `main` requires exactly one context, `ci`. A green or skipped
`ci` on a simulator-less stacked SHA would let a retargeted PR reach `main`
with the simulators never run anywhere — merge-queue non-leaders already skip
every macOS job and rely on the PR-level run.

### After you retarget to `main`

`edited` is not a `pull_request` type here. `concurrency.cancel-in-progress`
is `true`, so handling `edited` would cancel an in-flight run on a title/body
edit. `PATCH`ing the base to `main` therefore does not start CI.

Any later `synchronize` event (new commit, rebase, or force-push) starts the
full `main`-based run. Close + reopen is the recommended recipe when you have
no code change:

```bash
gh pr close <n> && gh pr reopen <n>
```

That run includes `ios-app-tests` (when iOS paths changed) and reports the
aggregate as `ci`.

### `delete_branch_on_merge`

The repo setting is `false` (owner decision; this change does not flip it).
GitHub will not auto-retarget a stacked child when its parent merges. Retarget
the child yourself, then close + reopen or push so the full `ci` set runs.

## Runners

ai-ecoverse is on GitHub's Free plan, so about 20 GitHub-hosted jobs run at
once across the whole org. Trusted `ci.yml` runs therefore send their
read-only, secret-free Linux jobs to the org's Cloud Run pools. Two YAML
anchors on `runs-on` do the routing:

| Anchor             | Variable          | Pool                                                                         | Jobs                                                                     |
| ------------------ | ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `*ci-heavy-runner` | `CI_HEAVY_RUNNER` | `cloud-run-job` (8 CPU / 32 GiB, one fresh Cloud Run Jobs execution per job) | the default: builds, tests, Chrome, e2e, Go, slicc-cli Linux leg         |
| `*ci-runner`       | `CI_RUNNER`       | `cloud-run` (4 vCPU / 8 GiB, shared)                                         | `runner`, `changes`, `lint`, `linear-history`, `dependency-review`, `ci` |

- **Trusted** means a same-repo pull request
  (`head.repo.full_name == github.repository`), a merge group, or a
  push/schedule/dispatch on `main`. A fork head always gets `ubuntu-latest`.
- **Merge groups:** a maintainer can enqueue a fork PR, and the group commit
  then carries its code. The `runner` job (no checkout, read scopes only) lists
  the merge queue. When any entry is cross-repository or unknown, or the
  lookup fails, it outputs `merge-group: hosted` and the whole group runs on
  `ubuntu-latest`. The job itself runs on `CI_RUNNER`, falling back to
  `CI_HEAVY_RUNNER`. This mirrors slicc-kernel's decider.
- **Stays hosted:** `cloudflare-worker`, because it reads Cloudflare and
  OAuth secrets, every macOS/iOS job, and the slicc-cli macOS and Windows
  legs. The workflow pins `permissions: contents: read`, so no job can get a
  write token.
- **Value:** one label (`cloud-run-job`) or a JSON label array
  (`["self-hosted","cloud-run-job"]`). `bench.yml` shards use
  `CI_HEAVY_RUNNER` too.
- **Rollback:** unset the variable (`gh variable delete CI_HEAVY_RUNNER`).
  Its jobs go back to `ubuntu-latest` on the next run, with no code change.
- **No sudo on the pools.** Root-only steps (`playwright install-deps`,
  `apt-get install xvfb`, the speech leg's disk cleanup) check
  `id -u` / `sudo -n true` first and skip. The bench image already ships
  Chrome's libraries, `xvfb-run`, `gh`, Go and gcc. Its `sans-serif` resolves
  to Liberation Mono, so `webcomponents` points `sans-serif` and `system-ui`
  at Liberation Sans through the user's fontconfig before its layout tests.
- `packages/dev-tools/tools/ci-critical-path.test.mjs` pins the job-to-pool
  map, the trust check, and the no-secrets/no-write rule for pool jobs.
  Adding a job means adding it to one of its lists.
