# Review Responder — answering the reviewers on our own agents' PRs

Our scheduled agents open `automation/*` pull requests. Codex, Copilot and this
repo's own `claude-pr-review.yml` then review them — and until this workflow
existed, nothing picked that feedback up. A human had to open a local session and
say "take over PR X and address the review comments". This package is the
deterministic half of the workflow that closes that loop: it decides whether a PR
has unanswered review feedback, and hands the feedback to one Claude turn that
fixes what is worth fixing, replies in every thread, and pushes to the PR's
existing head branch.

Workflow: [`.github/workflows/review-responder.yml`](../../../.github/workflows/review-responder.yml).

## Flow

```
pull_request_review (submitted) ─┐   trusted checkout    scan (default branch)     head checkout (BOT_PAT)
pull_request_review_comment ─────┼─▶ debounce 300s ─▶ scan-review-feedback.mjs ─▶ claude-code-action ─▶ marker comment
issue_comment (created, on a PR) ┘   (+ concurrency:      │                            └─ fixes, replies, pushes
workflow_dispatch ───────────────┘    queue, no cancel)   ├─ GET /pulls/{n}            (state, draft, head repo/ref/sha)
                                                          ├─ GET /pulls/{n}/reviews    (review summaries + state)
                                                          ├─ GET /pulls/{n}/comments   (inline comments, path + line)
                                                          └─ GET /issues/{n}/comments  (top-level — the house reviewer)
```

`lib.mjs` is pure and unit-tested (`lib.test.mjs`, `dev-tools` vitest project);
`scan-review-feedback.mjs` does all the I/O. The scanner performs **no GitHub
write at all** — not a label, not a comment. The marker comment is posted by a
separate deterministic workflow step, after Claude succeeds.

## The rule/judgement split

Everything expressible as a rule is in `lib.mjs`, where it is unit-tested. Only
genuine judgement reaches the model.

| Question                                                     | Decided by       |
| ------------------------------------------------------------ | ---------------- |
| Is this PR open, non-draft, same-repo, and `automation/*`?   | `decideResponse` |
| Is this item our own output rather than feedback?            | `isSelfOutput`   |
| Have we already answered at this head SHA, with nothing new? | `decideResponse` |
| Which items are unseen?                                      | `decideResponse` |
| **Does this comment have a point?**                          | the model        |
| **What is the right fix, and is it in scope?**               | the model        |

The gate deliberately does **not** classify a comment as actionable-vs-noise.
"Is this reviewer right?" is not a rule, and a regex that guessed at it would be
wrong in both directions.

## Skip reasons

| Reason                                              | Why                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Not open                                            | A comment on a merged or closed PR is not work.                        |
| Draft                                               | Its author is still working on it.                                     |
| Head repo ≠ this repo                               | Secrets are unavailable to fork PRs and the branch is unpushable here. |
| Head ref not `automation/*`                         | v1 does not respond on human PRs.                                      |
| No feedback from anyone but us                      | Nothing to answer.                                                     |
| Already responded at this SHA **and** nothing newer | Decide once per SHA.                                                   |
| All feedback predates our last response             | Already answered; the branch simply moved.                             |

Note the "already responded" skip needs **both** halves. The SHA marker alone is
not enough: a reviewer can leave a second round of comments without the branch
moving, and that round deserves an answer.

## All three endpoints, not one

This is the trap. `claude-pr-review.yml` posts its verdict as a **top-level issue
comment**, so `GET /pulls/{n}/reviews` alone sees nothing at all from the house
reviewer — the scan looks like it works while ignoring the reviewer whose
findings are most specific to this repo. `lib.test.mjs` carries a regression test
for exactly that case (the house reviewer's top-level comment as the _only_
feedback).

| Endpoint               | Carries                                             | Who uses it            |
| ---------------------- | --------------------------------------------------- | ---------------------- |
| `/pulls/{n}/reviews`   | review summaries + `APPROVED` / `CHANGES_REQUESTED` | Codex, Copilot         |
| `/pulls/{n}/comments`  | inline comments, with `path` + `line`               | all three              |
| `/issues/{n}/comments` | top-level comments (and our markers)                | `claude-pr-review.yml` |

A review row with an empty body is a bare `APPROVED` click and is dropped — it is
not feedback, and treating it as such would make every LGTM start a run.

## Loop safety

The responder posts comments. Comments are its trigger. Every path by which it
could trigger itself is closed, and most are closed twice, because any single
guard is one careless edit from being lost:

1. **Our thread reply → a `pull_request_review_comment` event.** This one _does_
   start a run, deliberately, and the selector stops it: `isSelfOutput` drops the
   reply because it is an inline comment authored by us with `in_reply_to_id` set,
   and the responder only ever replies in existing threads. The run then finds
   nothing unanswered and skips. Making the trigger itself reject this would mean
   either an author test (see below — it would blind the responder to the house
   reviewer) or requiring the model to mark its own replies, which puts loop safety
   at the mercy of the model remembering. One idle run, bounded by the concurrency
   group, is the cheaper guarantee.
2. **The summary/marker comment → an `issue_comment` event.** The job `if:` refuses
   any triggering comment whose body contains `<!-- review-response` — a prefix of
   both markers we write, so it covers the summary and the crash notice in one
   clause. `isSelfOutput` drops them again at the selector, regardless of author,
   so a relay bot mirroring our comment cannot smuggle one back in.
3. **Claude's push → a `synchronize` event.** This workflow does not subscribe
   to `pull_request` at all. The push exists to re-run **CI**, not the responder.
4. **A reviewer answering our reply → a real event, and a real run.** This one is
   allowed on purpose: a reviewer who pushes back deserves an answer. It is
   bounded by the head-SHA marker — if the branch has not moved and nothing newer
   than our last response exists, the run skips.
5. **A burst of three reviewers → three runs.** `concurrency: review-responder-<pr>`
   **queues** them (`cancel-in-progress: false`) behind a leading `sleep 300`
   debounce, so the first one answers a feedback set that is by then complete and
   the rest wake to find its marker at an unmoved head SHA and skip in seconds.

   `cancel-in-progress: true` is the trap here, and it was this workflow's first
   design until Codex caught it on #2198. Concurrency is evaluated **before** the
   job `if:`, so a run the `if:` would have skipped still cancels the run in
   progress — and every inline reply the responder posts is a
   `pull_request_review_comment` event on the same PR. The first reply would
   cancel the responder that wrote it, mid-run, before it could record the SHA
   marker; the replacement would see the original feedback still unanswered and
   start over. Unbounded ping-pong, presenting as cancelled runs rather than as a
   failure, billed the whole way. Queueing trades a few idle runs for
   idempotence that lives in a tested pure function instead of in a YAML
   expression.

### Neither guard can be author-based

The obvious loop guard — "ignore every comment by `github-actions[bot]`" — is
wrong on this repo, and wrong in the most damaging possible direction. It is
wrong twice over: once in the selector, and once in the workflow's `if:`, where
it is easier to miss because the workflow still looks like it works.
`claude-pr-review.yml` posts its verdict under **that same login**, because
`claude-code-action` runs its Bash `gh` under `GITHUB_TOKEN`. An author-based
filter would therefore discard the house reviewer entirely — the same
class of blindness as reading only `/pulls/{n}/reviews`, arrived at from the other
side. Confirmed on the real data: on #2179 and #2170 the house reviewer's
top-level comments are authored by `github-actions[bot]`.

In the trigger it is worse than lost coverage, because the house review is often
the **only** review an `automation/*` PR gets: Codex ignores bot-authored PRs
entirely, and Copilot degrades to a "Copilot was unable to review this pull
request" notice once its quota is spent (observed on #2179 the same day this was
written). An author-based `if:` would leave the responder unreachable in exactly
the situation it was built for, and it would look healthy while doing it — no
failed runs, just silence. So the `if:` tests for our **marker**, not our login.

The cost of admitting that login is that our other dispatchers' bookkeeping notes
(`<!-- pr-fix-skip:<sha> -->`, `<!-- backlog-skip:<n> -->`) also reach the
selector, along with unmarked machine notices like semantic-release's publication
comment and Copilot's quota notice. `dropReason` filters those by marker (and, for
the two unmarked ones, by a deliberately short body-pattern list), and
`partitionFeedback` returns **everything it dropped with the reason why**, which
the CLI prints. That reporting is not decoration: a filter that removes everything
is indistinguishable from "no feedback arrived", and this repo has already shipped
one filter that silently disabled a whole dispatcher.

So `isSelfOutput` is structural, and every clause names something only the
responder produces:

| Our output               | How it is recognised                             |
| ------------------------ | ------------------------------------------------ |
| Summary + marker comment | carries `<!-- review-response:<sha> -->`         |
| Crash notice             | carries `<!-- review-response-summary -->`       |
| Thread reply             | inline, authored by us, `in_reply_to_id` present |
| A review                 | n/a — the responder never submits a review       |

That covers all three shapes by construction, which is **why the workflow posts
the summary itself** rather than letting Claude run `gh pr comment`: a bare
model-authored top-level comment would have no marker, would share the house
reviewer's login, and would be genuinely indistinguishable from feedback. The
timestamp watermark (`lastResponseAt`, read from the marker comments only) is the
backstop if the model posts one anyway.

The house reviewer's _inline_ comments come from the `create_inline_comment` MCP
tool, which opens **new** threads — no `in_reply_to_id` — so they are never
mistaken for our replies. Both directions are pinned by tests.

`allowed_bots: 'github-actions[bot]'` in the Claude step is **not** in tension
with the job `if:` excluding that same login. `allowed_bots` gates whether the
_action_ will run for a given triggering **actor** (the actor of an
`automation/*` PR's events is our bot, so it must be allowed); the `if:` gates
which **trigger** is worth a run. Different questions, opposite answers, both
correct. It is never `'*'` — this repo is public, and the action's own docs warn
that `'*'` lets external Apps invoke it with prompts they control, which is
acutely relevant here because the prompt contains reviewer-authored text and the
step can push code.

## Why sessions are not resumed

The obvious design is to resume the Claude session that opened the PR, so it
"remembers" its reasoning. This workflow deliberately does not, and the decision
is not a limitation to work around:

- **GitHub already is the durable state.** The proposed change is the diff on the
  branch. The reasoning is in the PR body and the review threads. The verdict is
  the check suite. All three are readable, reviewable, and current.
- **A resumed session is a second, private copy of that state** — one that can
  disagree with the public one and that no reviewer can see. When they diverge,
  the private copy is the one that is wrong, because humans and other agents have
  been editing the public one.
- **Session state does not survive the things that actually happen**: a human
  pushing to the branch, a rebase onto `main`, a week between the review and the
  response, a different model version. A stateless responder handles all four by
  construction.
- **Statelessness is what makes the run idempotent.** The only memory it needs is
  "did we already answer at this SHA?", which is one HTML comment.

## Never merges, never opens, never closes

Enforced by the tool surface, not by the prompt:

```
--disallowedTools "Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh issue close:*)"
```

An instruction in the prompt is not enough. A model that ignores "do not merge"
regresses silently, in a way that looks exactly like success. Force-pushing is
forbidden too (the branch may carry a human's commits), and the job holds
`contents: read` — the push happens through the `BOT_PAT` credential the checkout
persisted, so a bug in the Claude step cannot push with the job token.

## The push must use `BOT_PAT`

GitHub's anti-recursion guard suppresses workflow runs for `GITHUB_TOKEN`-authored
pushes. A response commit pushed with `GITHUB_TOKEN` would never fire the PR's
`synchronize` event, so CI would never re-run and the PR would sit on stale green
checks that never saw the fix. This repo has already been bitten by that exact
class of bug (`checks: 0` on automation PRs #2168/#2169); the same requirement is
documented in `pr-fix-dispatcher.yml`, `boy-scout-debt-dispatcher.yml`, and
`coverage-ratchet.yml`.

## Run it locally

```bash
# Read-only rehearsal against a real PR. Performs no write of any kind, and
# DRY_RUN forces should_respond=false so it can never start a Claude run.
REPO=ai-ecoverse/slicc PR_NUMBER=2179 DRY_RUN=true GH_TOKEN=$(gh auth token) \
  node packages/dev-tools/review-responder/scan-review-feedback.mjs

# Unit tests
node node_modules/vitest/vitest.mjs run --project dev-tools \
  packages/dev-tools/review-responder/lib.test.mjs
```

### Environment variables

| Var          | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `REPO`       | `owner/repo` (required)                                                 |
| `PR_NUMBER`  | PR to scan (required)                                                   |
| `GH_TOKEN`   | Token for the GitHub REST API (required)                                |
| `SELF_LOGIN` | Login whose comments are our own output (default `github-actions[bot]`) |
| `DRY_RUN`    | `true` → decide and print, force `should_respond=false`                 |

### Outputs (`$GITHUB_OUTPUT`)

| Key              | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `should_respond` | `true` when the Claude step should run                 |
| `reason`         | Human-readable decision (multi-line-safe)              |
| `feedback_file`  | JSON file in `$RUNNER_TEMP` with the normalized items  |
| `feedback_count` | Number of unanswered items                             |
| `head_sha`       | PR head SHA — the marker's dedup key                   |
| `head_ref`       | PR head branch to check out and push to                |
| `pr_title`       | One-line PR title, safe to interpolate into the prompt |

The feedback file is written on **every** run, including skips: it is the fastest
way to tell "there was no feedback" apart from "an endpoint stopped being wired
up".

### Testing it on demand

```bash
gh workflow run review-responder.yml -f pr_number=2179 -f dry_run=true  # rehearse
gh workflow run review-responder.yml -f pr_number=2179                  # for real
```

`workflow_dispatch` waives only the 300s debounce — there is no burst to coalesce
when an operator names a PR. Scope, the fork guard, the draft/state checks and the
SHA dedup all still apply, so a manual run cannot be used to aim the responder at
a human's PR.

### Required secrets / variables (GitHub Actions)

No new secrets — all shared with `pr-fix-dispatcher.yml`.

| Name                             | Kind     | Purpose                                                                                          |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `AWS_BEARER_TOKEN_BEDROCK`       | secret   | Amazon Bedrock API key (Adobe CAMP `ABSK...` bearer token) used by `claude-code-action`.         |
| `BOT_PAT`                        | secret   | Fine-grained PAT (contents + pull-requests write); the response push must not be `GITHUB_TOKEN`. |
| `RUM_AWS_REGION`                 | variable | Optional. Bedrock region for the CAMP key (default `us-east-1`).                                 |
| `REVIEW_RESPONDER_BEDROCK_MODEL` | variable | Optional. Falls back to `RUM_BEDROCK_MODEL`, then `global.anthropic.claude-sonnet-4-6`.          |
