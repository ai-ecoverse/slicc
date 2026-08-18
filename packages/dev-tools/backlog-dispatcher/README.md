# Backlog Dispatcher — issues in, pull requests out

🎫 A daily scheduled agent that reads this repository's open issues, decides
which of them a competent engineer could implement today **without asking
anybody a question**, and opens a pull request for a handful of them. It never
closes an issue, never closes a pull request, and never merges.

Workflow: [`.github/workflows/backlog-dispatcher.yml`](../../../.github/workflows/backlog-dispatcher.yml).

## Flow

```
schedule (daily 09:35 UTC)
  └─ select-backlog-issues.mjs            (deterministic; NO writes)
       ├─ GET /issues?state=open           (candidates; PRs screened out by `pull_request`)
       ├─ GET /pulls?state=open            (in-flight dedup + the open-PR ceiling)
       ├─ backlog-candidates.json          (phase 1 reads this)
       └─ $GITHUB_OUTPUT: has_candidates, candidate_count, dispatch_budget, prompt
  └─ phase 1 TRIAGE   claude-code-action → labels `backlog-ready` / `backlog-skipped` (+1 comment)
  └─ phase 2 AUTHOR   claude-code-action → branch, minimal change, PR with `Closes #<n>`,
                                            label swapped to `backlog-dispatched`
  └─ sweep-stale-prs.mjs                  (deterministic; label + one comment, NEVER closes)
```

`lib.mjs` is pure and unit-tested (`lib.test.mjs`, `dev-tools` vitest project);
the two `.mjs` CLIs do all the I/O. Both prompts are built in `lib.mjs`
(`buildTriagePrompt`, `buildAuthorPrompt`) so the rubric has exactly one source
of truth and the tests can assert that the hard overrides survive.

## Where the rubric came from

This replaces an Augment Code ("Cosmos") expert of the same name. Its prompt body
was a `kb://` include that did not survive the platform's retirement — but ~50 of
its **decisions** did, left on this repo as `cosmos-dispatched` /
`cosmos-skipped` labels plus its own verbatim skip comments. The catalogs in
`lib.mjs` are reconstructed from that record, so this dispatcher applies the
rubric the previous one demonstrably applied.

### Hard overrides — never dispatched

| Class                                  | Evidence                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Security / authorization surface       | #2062 "sudo over tray": _"touches sudo authorization/security and requires human review"_                       |
| Upstream/platform bug or a design call | #2072 iOS transcript jump: _"needs on-device experimentation and a design call, not a localised fix"_           |
| Cross-cutting redesign / architectural | #2043 Atomics/SAB fast path: _"architectural scope, not a small contained PR"_; also the "Bloat" god-class asks |
| Unconfirmed root cause                 | #2034 concurrent VFS reads: _"root cause is unconfirmed … needs a human to pick the approach"_                  |
| Concurrency / data integrity           | #2034 again: _"spans service, caching, and protocol behavior"_                                                  |
| Native work CI cannot verify           | several `feat(ios-app)` asks needing a device                                                                   |
| New UX / product surface, unspecified  | "Shell: make PATH and HOME real concepts" (a redesign, not a task)                                              |

### Ready classes — what it did dispatch

An agentic-debt item naming both the sin and the file (`Paranoia:`,
`Necrophilia:`, `Entanglement:`, `Duplication:`, `Complicatification:`, `Drift:`);
a small localised bug with a concrete symptom ("output without trailing newline
is invisible"); a missing shell command or flag with a clear spec (`feat(git):
implement git clean`); one named flaky test; doc drift naming the stale file; a
narrow test addition. `Bloat:` is deliberately **not** a ready class — a
god-class split is architectural.

`lib.mjs` only **orders and caps** the pool; the actual go/no-go call is Claude's
in phase 1. The scorer ranks the ready classes first, rewards a named file and a
concrete symptom, and pushes long bodies and hard-override smells down — but a
smelly issue is still shown to Claude with its smells named, rather than being
silently dropped.

## State model — the labels are the work queue

No state file, no state branch, no Actions cache.

| Label                    | Meaning                                                        | Set by          |
| ------------------------ | -------------------------------------------------------------- | --------------- |
| `backlog-ready`          | Triage said yes; phase 2's queue                               | phase 1         |
| `backlog-dispatched`     | A PR exists (also on the PR itself)                            | phase 2         |
| `backlog-skipped`        | Decided against, once                                          | phase 1         |
| `backlog-stale`          | A dispatcher-owned PR has gone idle                            | the stale sweep |
| `cosmos-dispatch-failed` | The author phase died (legacy name reused — it already exists) | `if: failure()` |

Unlike the [PR Fix Dispatcher](../pr-fix-dispatcher/README.md), the labels here
**are** the dedup key: an issue carrying any of them is not a candidate at all.
That is deliberate and fixes a bug in the original, which re-posted its skip
comment on the same issue on every tick (#2072 got one on 2026-08-12 and another
on 2026-08-17). **A decision is made once.**

### Legacy label equivalence

~50 issues already carry the Cosmos-era labels, so `LABELS.legacyDispatched` /
`LABELS.legacySkipped` / `LABELS.legacyFailed` are treated as equivalent to the
new names when excluding candidates (see `DECIDED_LABELS`, unit-tested). Without
this the first run would re-propose work Cosmos already rejected — starting with
the sudo-over-tray issue.

### Re-queueing a skipped issue

Removing the label is the intended, documented escape hatch:

```bash
gh issue edit 2072 --remove-label backlog-skipped   # or cosmos-skipped
```

The next tick sees the issue as undecided and reconsiders it from scratch.

## Backpressure

| Knob                        | Value | Meaning                                                    |
| --------------------------- | ----: | ---------------------------------------------------------- |
| `MAX_DISPATCHES_PER_RUN`    |     5 | PRs authored per tick.                                     |
| `MAX_CANDIDATES_PER_SOURCE` |    25 | Issues kept per tick after screening and ranking.          |
| `MAX_OPEN_PRS`              |    10 | Dispatcher-owned open PRs allowed in flight.               |
| `SETTLING_AGE_HOURS`        |     1 | Minimum issue age — lets the author edit and triage first. |
| `STALE_PR_DAYS`             |     7 | A dispatcher PR idle this long is swept.                   |

Budget per tick is `min(MAX_DISPATCHES_PER_RUN, MAX_OPEN_PRS - open dispatcher PRs)`.
At exactly 10 open the budget is **0**: the dispatcher stops adding review load
instead of closing something to make room.

Silent screen-outs (no label, no comment) happen before Claude ever sees an
issue: it is a pull request, not open, assigned, younger than the settling
window, already decided (new or legacy label), on the denylist (`question`,
`wontfix`, `invalid`, `duplicate`, `skill issue`, `help wanted`), or already has
an open PR referencing it (`Closes #n` / `Fixes #n` / `#n` in a PR body or the
dispatcher's own `automation/backlog/issue-<n>` branch — the #2155 case).

## The stale sweep never closes

`sweep-stale-prs.mjs` is deterministic and runs no Claude. It labels
`backlog-stale` and posts one comment asking a human to merge, take over, or
close. The Cosmos original **closed** those PRs, which threw away work whose only
sin was waiting for review; the replacement policy is "make it visible, let a
human decide". Idempotent via the label, so the comment lands exactly once.

## Branch naming is load-bearing

PRs are opened on `automation/backlog/issue-<n>`. The `automation/` prefix is
what makes
[`isAutomationPr()`](../pr-fix-dispatcher/lib.mjs) in the PR Fix Dispatcher
return true, so a backlog PR whose CI fails gets a fixer instead of rotting.
`lib.test.mjs` imports **both** libs and asserts they agree — if the prefix ever
changes, that test fails rather than the coupling silently breaking.

## Run it locally

```bash
# Read-only rehearsal against the live repo (no writes at all — the selector
# never writes; labelling is phase 1's job).
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) DRY_RUN=true \
  node packages/dev-tools/backlog-dispatcher/select-backlog-issues.mjs

# Fully offline: canned `{ "issues": [...], "prs": [...] }` API payloads.
BACKLOG_FIXTURE=/tmp/fixture.json OUTPUT_PATH=/tmp/candidates.json \
  node packages/dev-tools/backlog-dispatcher/select-backlog-issues.mjs

# Stale sweep rehearsal (a fixture run is a dry run by construction).
BACKLOG_FIXTURE=/tmp/fixture.json \
  node packages/dev-tools/backlog-dispatcher/sweep-stale-prs.mjs

# Unit tests
node node_modules/vitest/vitest.mjs run --project dev-tools packages/dev-tools/backlog-dispatcher/
```

### Environment variables

| Var               | Used by  | Meaning                                                                     |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `REPO`            | both     | `owner/repo` to scan; falls back to `GITHUB_REPOSITORY`. Never hardcoded.   |
| `GH_TOKEN`        | both     | Token for the GitHub REST calls (required unless `BACKLOG_FIXTURE` is set). |
| `ISSUE_NUMBER`    | selector | Consider only this issue; waives the settling-age wait and nothing else.    |
| `DRY_RUN`         | both     | `true` → report only; the sweep writes nothing.                             |
| `MAX_DISPATCHES`  | selector | Lower override of `MAX_DISPATCHES_PER_RUN`.                                 |
| `SKIP_PR_CHECK`   | selector | `1` → skip the open-PR reads (offline-ish run; in-flight dedup disabled).   |
| `BACKLOG_FIXTURE` | both     | Path to canned `{ issues, prs }` payloads — fully offline.                  |
| `OUTPUT_PATH`     | selector | Candidates JSON path (default `./backlog-candidates.json`).                 |
| `RUN_URL`         | both     | Actions run URL used in the comment attribution line.                       |

### Running it on demand

```bash
gh workflow run backlog-dispatcher.yml -f dry_run=true                 # selector only
gh workflow run backlog-dispatcher.yml -f issue=2101                   # one named issue
gh workflow run backlog-dispatcher.yml -f max_dispatches=1             # author at most one PR
gh run list --workflow=backlog-dispatcher.yml --limit 3                # then `gh run view <id> --log`
```

`issue` is the input that needed building: the routine tick only considers issues
at least an hour old, which is awkward to arrange on demand. Naming an issue
waives exactly that wait — there is nobody to yield to when an operator points at
an issue — and nothing else: the decided-label dedup, the denylist, the
in-flight-PR check, and the dispatch budget all still apply.

## Scope: this repo only, for now

`BOT_PAT` is a fine-grained PAT scoped to `ai-ecoverse/slicc`, and the Cosmos
original's 21-repo sweep has no equivalent here. So the repository comes from
`GITHUB_REPOSITORY` / `REPO` and is **never hardcoded** in the lib or the CLIs:
promoting this to `ai-ecoverse/.github` for the whole org is a packaging change
(add `workflow_call` plus a repo input) rather than a rewrite. Linear support is
deliberately absent — Cosmos's `LINEAR_TEAM_KEYS` was empty.

### Required secrets / variables (GitHub Actions)

No new secrets — both are shared with `boy-scout-debt-dispatcher.yml`.

| Name                       | Kind     | Purpose                                                                                                          |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `AWS_BEARER_TOKEN_BEDROCK` | secret   | Amazon Bedrock API key (Adobe CAMP `ABSK...` bearer token) used by `claude-code-action` (`use_bedrock`).         |
| `BOT_PAT`                  | secret   | Fine-grained PAT (contents + issues + pull-requests write); the branch push must not be `GITHUB_TOKEN`-authored. |
| `RUM_AWS_REGION`           | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                                 |
| `BACKLOG_BEDROCK_MODEL`    | variable | Optional. Bedrock model; falls back to `RUM_BEDROCK_MODEL`, then `global.anthropic.claude-sonnet-4-6`.           |

The workflow needs `issues: write` **as well as** `pull-requests: write`:
repo-level label creation (`gh label create`) goes through
`POST /repos/{repo}/labels`, which is gated on `issues`.
