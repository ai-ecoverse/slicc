# PR Fix Dispatcher — triage for failing automation PRs

Renovate bumps, coverage ratchets and `rum-fix/` branches fail CI for boring
reasons: a flaky artifact upload, a lint rule the bump tripped, a lockfile out of
sync. This scheduled dispatcher looks at those PRs every two hours and does one
of three things — **re-run**, **dispatch a fixer**, or **skip** — without ever
editing code, pushing, or merging.

Workflow: [`.github/workflows/pr-fix-dispatcher.yml`](../../../.github/workflows/pr-fix-dispatcher.yml).

## Flow

```
schedule (every 2h) ─▶ scan-failing-prs.mjs ─▶ queue (JSON) ─▶ fix job (matrix, 1 PR each)
                         │                                       └─ claude-code-action pushes the fix
                         ├─ GET /pulls?state=open&sort=updated    (candidates)
                         ├─ GET /commits/{sha}/check-runs, /status (CI verdict)
                         ├─ GET /issues/{n}/comments               (markers + human activity)
                         ├─ GET /pulls/{n}/reviews, /commits/{sha} (human activity)
                         ├─ GET /actions/runs?head_sha=            (run_attempt + rerun targets)
                         ├─ GET /actions/jobs/{id}/logs            (bounded excerpt)
                         ├─ POST /actions/runs/{id}/rerun-failed-jobs   ← re-run path
                         └─ label + one marker comment                  ← skip / dispatch paths
```

`lib.mjs` is pure and unit-tested (`lib.test.mjs`, `dev-tools` vitest project);
`scan-failing-prs.mjs` does all the I/O and the side effects.

## The three paths

| Path         | When                                                                                                                                     | Side effects                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **re-run**   | The failure never evaluated the code: artifact up/download, DNS/reset/timeout, registry 5xx, runner lost, a bare cancel. Once per SHA.   | `rerun-failed-jobs` only — no label, no comment.                   |
| **dispatch** | The failure is in the code and mechanically fixable: lint/format, types, a snapshot or coverage floor, lockfile drift, a merge conflict. | `ci-fix-dispatched` + one marker comment, then the `fix` job runs. |
| **skip**     | Everything else, and always for the hard overrides below.                                                                                | `ci-fix-skipped` + one short comment (never two for the same SHA). |

Hard overrides to skip: auth, billing, secrets/credentials, schema migrations,
release/publish/deploy jobs, an expired token or exhausted quota, an
infrastructure failure that **recurred after a re-run** (so it is not a flake), a
fix needing a new dependency / version change / CI-config change, and any failure
whose cause cannot be named. When in doubt between dispatch and skip, skip; when
in doubt between re-run and skip, re-run.

Silent drops (no label, no comment) happen before the rubric: the PR is not
machine-authored, CI is green or still running, the newest failing conclusion is
younger than the settling window, a human touched the PR in the last hour, the
attempt cap is spent, this SHA was already dispatched or already skipped, or the
PR carries `patched-dependency` / `formatter-bump` (the
`renovate-*-reconcile.yml` workflows self-heal those and acting would race them).

## Backpressure

| Knob                     | Value | Meaning                                                  |
| ------------------------ | ----: | -------------------------------------------------------- |
| `MAX_DISPATCHES_PER_RUN` |     3 | Fixers launched per tick.                                |
| `MAX_CANDIDATES`         |    50 | Open PRs read per tick.                                  |
| `MAX_OPEN_FIXES`         |     5 | Dispatcher-owned fixes in flight.                        |
| `MAX_ATTEMPTS_PER_PR`    |     2 | Dispatches per PR before it is left for a human.         |
| `MAX_RERUNS_PER_SHA`     |     1 | Re-runs per head SHA, ever.                              |
| `SETTLING_MINUTES`       |    20 | Minimum age of the failing conclusion.                   |
| `HUMAN_ACTIVITY_MINUTES` |    60 | A human comment/review/push this recent means hands off. |

Dispatch budget per tick is `min(MAX_DISPATCHES_PER_RUN, MAX_OPEN_FIXES - open fixes)`.
Over-budget dispatches are left completely untouched so the next tick sees them.

## State is GitHub-native

No state file, no state branch, no Actions cache.

| What                     | Where it lives                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| Already re-ran this SHA  | Any workflow run for the head SHA with `run_attempt > 1` — re-running bumps it.  |
| Already skipped this SHA | A `<!-- pr-fix-skip:<sha> -->` marker inside the skip comment.                   |
| Attempts so far          | Count of distinct `<!-- pr-fix-dispatch:<sha> -->` markers in the PR's comments. |
| Fixes in flight          | Open PRs carrying `ci-fix-dispatched` whose head SHA is currently failing.       |

The three `ci-fix-*` labels (`ci-fix-dispatched`, `ci-fix-skipped`,
`ci-fix-failed`) are human-visible markers **only**. They are deliberately not
the dedup key: relabelling a PR by hand must not change dispatcher behaviour.
Because a new head SHA has no markers, pushing a commit makes a skipped PR
eligible again — a skip is never permanent.

## Allowed GitHub writes

The scanner's only non-label, non-comment write is
`POST /actions/runs/{id}/rerun-failed-jobs` (403 = too old, 409 = already
re-running; both tolerated and ignored). It never re-runs a whole run, never
cancels, never merges or closes, never pushes, and never edits a PR's title,
body, base, draft state, assignees, or reviewers.

Label removal uses `DELETE /repos/{repo}/issues/{n}/labels/{name}` (404
tolerated) rather than PUTting the full label list back: a PUT would clobber a
label added concurrently by another workflow — this repo's reconcilers do relabel
PRs — while DELETE touches only the one label.

## The `fix` job

Each queued PR gets its own matrix leg: a checkout of its own head branch with
`fetch-depth: 0`, `npm ci`, then `claude-code-action` with
`--allowedTools "Bash,Read,Edit,Write,Grep,Glob"` and `--max-turns 150`. The
checkout uses `secrets.BOT_PAT`, not `GITHUB_TOKEN`: GitHub's anti-recursion
guard suppresses workflow runs for `GITHUB_TOKEN`-authored pushes, so the PR's
`synchronize` event would never fire and CI would never re-run on the fix (same
requirement as `renovate-patch-reconcile.yml`). A trailing `if: failure()` step
swaps `ci-fix-dispatched` for `ci-fix-failed` and posts one plain-language
comment.

The `failures` field passed through the matrix is flattened to a **single line**
with `${{` neutralised: a multi-line matrix value would break the prompt's YAML
block-scalar indentation, and an unescaped expression would be re-expanded by
Actions.

## Run it locally

```bash
# Read-only rehearsal: decides and prints, performs no write at all.
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) DRY_RUN=true \
  node packages/dev-tools/pr-fix-dispatcher/scan-failing-prs.mjs

# Unit tests
npx vitest run --project dev-tools packages/dev-tools/pr-fix-dispatcher/lib.test.mjs
```

### Environment variables

| Var              | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `REPO`           | `owner/repo` to scan (required)                          |
| `GH_TOKEN`       | Token for the GitHub REST API (required)                 |
| `DRY_RUN`        | `true` → decide and report; no re-run, label, or comment |
| `MAX_DISPATCHES` | Optional lower override of `MAX_DISPATCHES_PER_RUN`      |
| `PR_NUMBER`      | Scan only this PR; waives the two time-based waits       |

### Testing it on demand

The routine tick only acts on a failing automation PR that is at least
`SETTLING_MINUTES` stale with no human activity in the last hour, which is
impossible to arrange on demand. The `pr_number` dispatch input targets one PR
and waives exactly those two waits — there is nobody to yield to when an operator
names a PR — while automation authorship, the self-healing labels, the marker
dedup, the hard overrides, and the dispatch budget all still apply:

```bash
gh workflow run pr-fix-dispatcher.yml -f pr_number=1234 -f dry_run=true  # rehearse
gh workflow run pr-fix-dispatcher.yml -f pr_number=1234                  # for real
```

### Required secrets / variables (GitHub Actions)

No new secrets — these are shared with `renovate-patch-reconcile.yml`.

| Name                       | Kind     | Purpose                                                                                                           |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `AWS_BEARER_TOKEN_BEDROCK` | secret   | Amazon Bedrock API key (Adobe CAMP `ABSK...` bearer token) used by `claude-code-action` (`use_bedrock`).          |
| `BOT_PAT`                  | secret   | Fine-grained PAT (contents + pull-requests write); the fix push must not be `GITHUB_TOKEN`-authored.              |
| `RUM_AWS_REGION`           | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                                  |
| `PR_FIX_BEDROCK_MODEL`     | variable | Optional. Bedrock model for fixers; falls back to `RUM_BEDROCK_MODEL`, then `global.anthropic.claude-sonnet-4-6`. |
