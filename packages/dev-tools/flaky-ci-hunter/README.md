# Flaky CI Hunter — the "same commit, two outcomes" scanner

Weekly hunt for CI jobs that fail **nondeterministically on unchanged code**,
plus one dispatched fixer for the worst offender.

A flake is not "a job that failed often". A flake is **the same commit producing
two different outcomes**. Everything here is built around finding that flip and
proving it before spending a fixer on it: no flip, no flake. Dispatching nothing
is always better than dispatching a fixer onto a job that is simply broken, so a
quiet week is a valid outcome that needs no justification beyond the digest.

## Flow

```
cron (Mon 06:50 UTC) ─▶ scan-flakes.mjs ─▶ has_candidate? ─▶ claude-code-action (branch + ONE PR)
                          │                     │
                          │                     └─ always: digest ─▶ step summary + `flaky-ci-digest` artifact
                          ├─ runs, ONE DAY AT A TIME (1000-item cap workaround)
                          ├─ source 1: attempts/{n}/jobs   → failure → success flips (definitive)
                          ├─ source 3: green-then-red on `main` (needs source-1 corroboration)
                          ├─ ≤ MAX_LOG_READS job logs      → common failure signature
                          └─ `automation/flaky-fix/*` PRs  → attempts + cooldown
```

The workflow lives in
[`.github/workflows/flaky-ci-hunter.yml`](../../../.github/workflows/flaky-ci-hunter.yml).

## Config

| Key                      | Value | Meaning                                                                      |
| ------------------------ | ----- | ---------------------------------------------------------------------------- |
| `WINDOW_DAYS`            | 7     | Trailing evidence window                                                     |
| `MAX_LOG_READS`          | 6     | Cap on runs whose job logs are fetched — listing runs is cheap, logs are not |
| `FLAKE_THRESHOLD`        | 2     | Distinct commits a job must have flipped on; one flip is noise               |
| `MAX_DISPATCHES_PER_RUN` | 1     | Deliberately tiny — a wrong flaky-test fix is worse than none                |
| `COOLDOWN_DAYS`          | 21    | After a dispatch, wait this long unless the fix PR merges                    |
| `MAX_ATTEMPTS_PER_JOB`   | 2     | After this many dispatches for one job, leave it for a human                 |

## Why one query per day

`GET /repos/{owner}/{repo}/actions/runs` returns **at most 1000 items no matter
how you page**, while `total_count` reports the true size. This repo produces
roughly 2400 runs a week, so one window-wide query silently truncates to the most
recent ~2.5 days and hides the rest of the evidence — and a truncated scan looks
exactly like a quiet week. So the scanner issues one `created=<day>..<day>` query
per day of the window (`dayWindows` + `createdRangeParam` in `lib.mjs`), pages
each day to exhaustion, and reconciles the runs it retrieved against that day's
`total_count`. Any shortfall is printed and flagged **loudly** in the digest.

Slicing per workflow instead is not equivalent: a single high-volume workflow can
exceed 1000 runs on its own, reintroducing the same blind spot.

Note that the day list covers every UTC day the trailing window **touches**,
which is `WINDOW_DAYS + 1` dates unless the run starts exactly at midnight.
Counting calendar dates alone under-covers: at the Monday 06:50 UTC cron, seven
dates would span Tuesday 00:00 → Monday 06:50 (about 6d 7h) and silently drop
the previous Monday morning, which is enough to push a job under the flake
threshold. The extra boundary day is queried whole, then trimmed to the exact
`now - WINDOW_DAYS` cutoff (`windowStart` + `withinWindow`).

## Evidence sources

1. **Attempt flips (definitive).** For every run with `run_attempt > 1`, read
   `attempts/{n}/jobs`; a job that concluded `failure`/`timed_out` on an earlier
   attempt and `success` on a later one flipped on identical code. No
   corroboration needed.
2. **There is no source 2.** The original expert read a sibling "PR Fix
   Dispatcher" agent's state directory to learn which runs it had re-run on flake
   suspicion. Under GitHub-native state that collapses into source 1: a
   dispatcher re-run is precisely what _creates_ attempt 2, so `run_attempt > 1`
   already carries that evidence — definitively, and without reading another
   workflow's private state.
3. **Green-then-red on `main`.** A job green on a PR head and red post-merge
   (`push`/`merge_group` on `main`) for the same `head_sha`. Weak — a `main` run
   carries other people's work — so it only counts toward the threshold when the
   same job also appears in source 1.

Flips are deduplicated by `(workflow, job, head_sha)` and `flake_score` counts
**distinct commits**, so one flake observed twice cannot inflate a score.

## Filters and the banned-fix policy

A candidate is dropped (to the digest, never to a fixer) when it is a
release/publish/deploy job, is below `FLAKE_THRESHOLD`, has hit
`MAX_ATTEMPTS_PER_JOB`, is inside `COOLDOWN_DAYS`, already has an open fix PR, is
fully explained by known-mitigated infrastructure (npm-registry IPv6 — already
mitigated by `NODE_OPTIONS: --dns-result-order=ipv4first` in `ci.yml`, which
removed ~79% of observed flakes — artifact transport, runner outage), or has no
failure signature common to two of its flips.

The dispatch brief bans the fixes this repo has already ruled out in
[`.agents/skills/writing-slicc-tests/SKILL.md`](../../../.agents/skills/writing-slicc-tests/SKILL.md)
§"Retry Flaky Tests" (mirrored in
[`docs/development.md`](../../../docs/development.md) §"Test Timing and Flaky
Retries"): **a retry hides nondeterminism.** Raising `CI_RETRIES` or a
per-project `retry`, adding `test.retry(...)`, adding a bare `sleep`, loosening
an assertion, `.skip`/`.todo`, or widening a timeout are all rejected outcomes.
If the honest fix is one of those, the fixer must report back instead of pushing.

## GitHub-native state (there is no state file)

| Cross-run fact       | Where it lives now                                                              |
| -------------------- | ------------------------------------------------------------------------------- |
| dispatch count       | number of `automation/flaky-fix/<slug>` pull requests (`state=all`)             |
| last dispatch date   | that branch's newest PR `created_at` → drives `COOLDOWN_DAYS`                   |
| cooldown lifted      | any such PR with a `merged_at`                                                  |
| fix already in fligh | an `open` PR on that branch                                                     |
| digest               | `$GITHUB_STEP_SUMMARY` + the `flaky-ci-digest` artifact (uploaded on every run) |

`jobSlug(workflow, job)` → `automation/flaky-fix/<slug>` is therefore the durable
registry key, which is why the dispatch brief insists on that exact branch name
and the `flaky-fix` label. Nothing is committed to the repo, no state branch is
created, and the Actions cache is not used.

## Run it locally

The scanner is read-only, so a plain read token is enough:

```bash
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) \
  node packages/dev-tools/flaky-ci-hunter/scan-flakes.mjs

# Unit tests (pure logic + a fixture-driven end-to-end scan)
npx vitest run --project dev-tools packages/dev-tools/flaky-ci-hunter/lib.test.mjs
```

### Environment variables

| Var               | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `REPO`            | `owner/repo` to scan (required unless `FIXTURE_DIR` is set)             |
| `GH_TOKEN`        | Token with `actions:read` + `pulls:read` (same)                         |
| `WINDOW_DAYS`     | Trailing window; default 7                                              |
| `MAX_LOG_READS`   | Cap on job logs fetched; default 6                                      |
| `FLAKE_THRESHOLD` | Distinct-commit flips needed to qualify; default 2                      |
| `JOB_OVERRIDE`    | Only consider jobs matching this substring                              |
| `DRY_RUN`         | `true` → scan and write the digest, but never emit `has_candidate=true` |
| `DIGEST_PATH`     | Where to write the digest; default `./flaky-ci-digest.md`               |
| `FIXTURE_DIR`     | Serve the API from a local fixture tree — no network at all             |

Outputs written to `$GITHUB_OUTPUT`: `has_candidate`, `job`, `slug`,
`flake_score`, and the multi-line `prompt` (heredoc form).

### Offline reproduction (`FIXTURE_DIR`)

The API layer is injectable, so the whole scan can be driven without network
access. `lib.test.mjs` does that in-process (`scan (offline, fixture-driven)`);
for a real CLI run, point `FIXTURE_DIR` at a tree shaped like this — any missing
file simply means "empty", so a fixture only spells out what matters:

```
runs/<YYYY-MM-DD>/<page>.json   → { total_count, workflow_runs: [ run, … ] }
attempts/<runId>/<attempt>.json → { jobs: [ { name, conclusion, id }, … ] }
jobs/<runId>.json               → { jobs: [ … ] }        (source 3 only)
logs/<jobId>.txt                → raw job log
pulls.json                      → [ pull, … ]            (the flaky-fix registry)
```

Build a two-flip fixture and run the scanner over it:

```bash
FIX=/tmp/flaky-fixture
DAY=$(date -u +%F)
mkdir -p "$FIX/runs/$DAY" "$FIX/attempts/1" "$FIX/attempts/2" "$FIX/logs"
cat > "$FIX/runs/$DAY/1.json" <<'JSON'
{ "total_count": 2, "workflow_runs": [
  { "id": 1, "name": "CI", "head_sha": "aaaaaaaa1111", "head_branch": "feature",
    "event": "pull_request", "conclusion": "success", "run_attempt": 2,
    "html_url": "https://github.com/ai-ecoverse/slicc/actions/runs/1" },
  { "id": 2, "name": "CI", "head_sha": "bbbbbbbb2222", "head_branch": "feature",
    "event": "pull_request", "conclusion": "success", "run_attempt": 2,
    "html_url": "https://github.com/ai-ecoverse/slicc/actions/runs/2" } ] }
JSON
echo '{ "jobs": [ { "name": "node-server", "conclusion": "failure", "id": 101 } ] }' > "$FIX/attempts/1/1.json"
echo '{ "jobs": [ { "name": "node-server", "conclusion": "success", "id": 102 } ] }' > "$FIX/attempts/1/2.json"
echo '{ "jobs": [ { "name": "node-server", "conclusion": "failure", "id": 201 } ] }' > "$FIX/attempts/2/1.json"
echo '{ "jobs": [ { "name": "node-server", "conclusion": "success", "id": 202 } ] }' > "$FIX/attempts/2/2.json"
echo '[]' > "$FIX/pulls.json"
printf 'FAIL packages/node-server/tests/spawn.test.ts > binds the bridge port\nError: listen EADDRINUSE :::5710\ntook 1200 ms\n' > "$FIX/logs/101.txt"
printf 'FAIL packages/node-server/tests/spawn.test.ts > binds the bridge port\nError: listen EADDRINUSE :::5710\ntook 87 ms\n' > "$FIX/logs/201.txt"

FIXTURE_DIR=$FIX DIGEST_PATH=/tmp/flaky-ci-digest.md \
  GITHUB_OUTPUT=/tmp/flaky-out.txt \
  node packages/dev-tools/flaky-ci-hunter/scan-flakes.mjs
cat /tmp/flaky-ci-digest.md
```

Expected: seven per-day queries, two attempt flips on distinct commits, one
candidate `CI / node-server` with score 2, a common `EADDRINUSE` signature, and
`has_candidate=true` plus the dispatch brief in `/tmp/flaky-out.txt`.

## Required secrets / variables (GitHub Actions)

Shared with `rum-error-triage` and `coverage-ratchet` — no new secrets.

| Name                         | Kind     | Purpose                                                                                                  |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `AWS_BEARER_TOKEN_BEDROCK`   | secret   | Amazon Bedrock API key (Adobe CAMP `ABSK...` bearer token) used by `claude-code-action` (`use_bedrock`). |
| `BOT_PAT`                    | secret   | Checkout/push token — a PR pushed with `GITHUB_TOKEN` does not trigger CI.                               |
| `RUM_AWS_REGION`             | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                         |
| `FLAKY_HUNTER_BEDROCK_MODEL` | variable | Optional. Bedrock model; falls back to `RUM_BEDROCK_MODEL`, then `global.anthropic.claude-sonnet-4-6`.   |

## Design notes

- **Pure logic is isolated and tested.** `lib.mjs` holds the config, the day
  windowing, flip detection, dedup, scoring, filters, slug/registry helpers, the
  digest, and the dispatch brief — no I/O. `scan-flakes.mjs` does the REST calls
  and the `$GITHUB_OUTPUT` / step-summary writes.
- **Two filter passes.** The cheap gates (threshold, exclusions, cooldown,
  attempts) run first so log reads are only ever spent on the ONE candidate whose
  sole open question is "is this actually a single flake?".
- **Read-only scanner.** No comments, no labels, no re-runs, no pushes. Only the
  Claude step writes, and only a branch and one PR. No GitHub comment is ever
  posted: a flaky job has no natural PR or issue to comment on, and the fix PR
  speaks for itself.
- **Not automated on purpose.** The brief asks Claude for the one-sentence root
  cause rather than guessing it from a pattern table here; the scanner supplies
  the proven flips and the common signature, and judgement stays with the fixer.
