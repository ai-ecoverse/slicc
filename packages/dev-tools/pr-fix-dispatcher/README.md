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

| Path         | When                                                                                                                                                                                                                                              | Side effects                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **re-run**   | The failure never evaluated the code: artifact up/download, DNS/reset/timeout, registry 5xx, runner lost, a bare cancel. Once per SHA.                                                                                                            | `rerun-failed-jobs` only — no label, no comment.                   |
| **dispatch** | The failure is in the code and mechanically fixable: the debt boy-scout gate, lint/format, types, a snapshot or coverage floor, lockfile drift, a merge conflict, or an SPM/xcodegen pin Renovate bumped in one manifest but missed in a sibling. | `ci-fix-dispatched` + one marker comment, then the `fix` job runs. |
| **skip**     | Everything else, and always for the hard overrides below.                                                                                                                                                                                         | `ci-fix-skipped` + one short comment (never two for the same SHA). |

Hard overrides to skip: auth, billing, secrets/credentials, schema migrations,
release/publish/deploy jobs, an expired token or exhausted quota, an
infrastructure failure that **recurred after a re-run** (so it is not a flake), a
failure needing a _new_ dependency / version change / CI-config change (syncing a
pin Renovate already bumped in a sibling manifest is dispatch, not this), and any
failure whose cause cannot be named. When in doubt between dispatch and skip, skip;
when in doubt between re-run and skip, re-run.

### Network infra must not match Actions `NODE_OPTIONS`

Every job in this repo dumps `NODE_OPTIONS: --dns-result-order=ipv4first`. The
`CI / ci` aggregator's script-echo puts that line inside the failure excerpt of
`One or more jobs failed…`. A bare `dns` substring used to classify that as
network plumbing (PR #2320), burn the one re-run, then skip forever. The network
signature now requires an explicit DNS-failure phrase (`getaddrinfo`,
`ENOTFOUND`, `dns resolution`, …), and the aggregator job is forced to
`unknown` so a sibling that named a real cause can win.

### The aggregator must not own the skip reason

Forcing the aggregator to `unknown` is not enough if the unknown _fallback_
then picks it. GitHub's check-runs API lists `ci` before the child that
actually failed (PR #3008: `lint` FAILURE + `ci` FAILURE). `classifyFailures`
walks blocked → code → infra, and when nothing matches it used to return
`classified[0]`. That made the skip comment `"ci" is the CI aggregator and
does not name a failure cause` even though `lint` had also failed.

Two compounding traps:

- **`CODE_SIGNATURES.lint` does not match the job name `lint`.** The pattern
  wants `biome (found|check)|eslint|prettier|lint(ing)? (error|failed)`. An
  empty or truncated log excerpt (log fetch 403/410, or `MAX_LOGS_PER_PR`
  spent on the aggregator first) classified the real job as unknown too
  (`no plausible cause`).
- **Log fetches followed `checks.failing` order.** With `ci` first, the
  bounded log budget could starve the sibling.

The unknown fallback never picks an aggregator-unknown. A failing job that
evaluates this repo's code is `code` even with an empty excerpt, so the PR
dispatches. `lint` / `typecheck` are also job-name signatures on the
single-failure path (after infra, so a network flake on the lint job is still a
re-run). Log fetches prefer non-`ci` jobs.

Same class as the #2215 debt-gate + aggregator miss and the #2320
NODE_OPTIONS false positive: aggregator noise dominating a named child.

### "Is this a code job?" is a deny-list, and names lose their matrix leg

That test used to be an allow-list of seven names. `ci.yml` runs thirty jobs, so
`slicc-cli`, `go-optel`, `cloudflare-worker`, `node-server`, `cherry`, `spoon`,
`webcomponents`, `cloud-core` and `global-install` were all absent — each one
falling through to the `unknown` skip the fallback exists to prevent — and any
job added later would have joined them in silence. It is now a deny-list of the
jobs that genuinely evaluate no code: the `ci` aggregator and the `changes`
paths-filter job. (`release-gate` is not listed because `HARD_SKIP_JOB_PATTERN`
already blocks it by name, earlier and more strongly.)

`bareCheckName()` also strips the trailing matrix leg. GitHub reports these as
`node-matrix-tests (26)` and `slicc-cli (ubuntu-latest)`, and every name-keyed
lookup is an exact match, so before the strip the old allow-list's
`node-matrix-tests` entry **could never fire** — that job is only ever reported
with a leg.

Allow-by-default only works because promotion-by-name is scoped to one workflow.
`GET /commits/{sha}/check-runs` returns every check on the SHA, so a Renovate PR
also carries `AI Comment Detection`, `Renovate Lockfile Reconcile`,
`Claude PR Review` and `Storybook Screenshots`. Without the scope, a failure in
any of those would promote on its name and send a fixer to edit branch code
because a _labelling_ job broke — and the lockfile reconciler is one of the
workflows the dispatcher explicitly refuses to race. `attachWorkflowNames()`
stamps each failing check with its workflow, resolved against the
`GET /actions/runs?head_sha=…` response the scanner already holds for
`hasRerunForSha` (so it costs no extra request), and only `CI` is promotable.

The **log** is not scoped, only the name: a `reconcile` job whose log genuinely
says `biome found 2 errors` still classifies as `code`, because there the
evidence is the log. A commit status never promotes on its context — that name
belongs to an external app — and `workflow: null` (stamped when a check traces to
no Actions run, e.g. a GitHub App's check-run) is a refusal, distinct from
`workflow` being absent, which means "never stated" and stays permissive for
hand-built input.

### A dependency conflict is not a hard skip on a Renovate branch

`ERESOLVE` / `unable to resolve dependency tree` / `requires a peer of` is the
one conditional entry in the hard-skip table. On a hand-written branch it is a
decision somebody has to make. On a `renovate/` branch it is the PR's entire
content, and the fix is regenerating the lockfile or widening a sibling range —
so blocking it made the dispatcher structurally blind on its most common
candidate (PR #2964, `fix(deps): update codemirror`).

`isDependencyUpdatePr()` keys on the head branch, **not** the author: every bot
in this repo is a `Bot`, and a backlog-dispatcher PR must not inherit the waiver.
When it holds, that one entry is filtered out of `HARD_SKIP_SIGNATURES` and the
identical pattern matches as a `dependency-resolution` code signature. Filtering
the table rather than unblocking the verdict matters — `blocked` is
first-match-wins, so a log naming both `ERESOLVE` and an invalid workflow file
still hard-skips on `ci-config-change`. `engine-mismatch` (`EBADENGINE`,
`Unsupported engine`) stays hard for everyone: satisfying it means editing the
Node version in `.github/workflows/`, which the prompt forbids.

Dispatching those PRs is only useful if the fixer survives long enough to fix
them. The `fix` job's bootstrap `npm ci` is the _first_ casualty of both an
`ERESOLVE` and a drifted lockfile (`npm ci can only install...`) — the two
categories most likely to reach it — so a hard `npm ci` would fail the job before
Claude's turn and step 7 would mark the PR as needing a human. The step therefore
falls back to `npm install` (which re-resolves the tree and regenerates the
lockfile: that _is_ the fix for both), and on total failure continues anyway so
the fixer can diagnose it with tools. `steps.install.outputs.state` is
`clean` / `re-resolved` / `failed`, and the prompt is told which — `re-resolved`
means the lockfile is already dirty in the worktree, to be read and committed
deliberately rather than swept up by accident.

### The debt boy-scout gate is the likeliest dispatch of all

`check-touched-exemptions.mjs` (the `lint` job's "Debt boy-scout gate" step) fails
any PR that touches a file still on a debt list — function size, cognitive
complexity, floating or misused promises, layer back-edges, untyped string-keyed
bags. The boy-scout and backlog dispatchers exist to edit exactly those files, so
this is the failure an automation PR is most likely to hit, and it is mechanically
fixable: the gate prints the offending file and the fix it wants.

It is also invisible to a keyword list built for ordinary linters, because its
output never says "biome", "eslint", or "lint error" — it says
`check-touched-exemptions: FAIL` and `still on the <rule> debt list`. Both
phrasings, plus the "debt list is frozen and must not grow" variant, are matched
by the `debt-gate` code signature, which is checked before the broader `lint` one.
The log excerpt keeps a window _around_ each failure line for the same reason:
the filename and the `Fix:` instruction contain no failure-ish word of their own,
and without them the fixer's prompt names a failure it cannot act on.

The window is eight lines after and three before. The leading half exists because
`make` inverts the usual order — the recipe prints its summary first and only
then does `make` echo `*** [Makefile:48: tidy-check] Error 1`. On PR #3045
(`renovate/github.com-pion-webrtc-v4-4.x`) that left the one actionable line,
`go.mod/go.sum are not tidy — run 'go mod tidy'`, above every failure-ish line:
trailing-only context dropped it, `slicc-cli` classified as `unknown`, and a
human pushed the `go mod tidy` commit by hand. Keep it short — leading context
pads the excerpt with the passing output that preceded the failure, and the
excerpt is what the fixer's prompt is built from.

Silent drops (no label, no comment) happen before the rubric: the PR is not
machine-authored, CI is green or still running, the newest failing conclusion is
younger than the settling window, a human touched the PR in the last hour, the
attempt cap is spent, this SHA was already dispatched or already skipped, or the
PR carries `patched-dependency` / `formatter-bump` / `swift-pin` (the
`renovate-*-reconcile.yml` workflows self-heal those and acting would race them).

A PR whose head branch lives in a **fork** (or whose fork has since been
deleted) is refused here too. The fix job checks out the bare `head.ref` in this
repository, so a fork PR either fails on a missing branch or — if a branch of
the same name happens to exist here — edits and pushes the wrong one. The refusal
has to happen at this gate, before the dispatch label and SHA marker are written,
since those would block any later attempt.

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
