# Dev-Tools Deep Reference

Rationale, gotchas, and non-obvious behavior for tools listed in
[`packages/dev-tools/CLAUDE.md`](../packages/dev-tools/CLAUDE.md). The
guide keeps entry commands; this page keeps the "why".

## ai-comment-detection

`packages/dev-tools/ai-comment-detection/` classifies PR/issue thread
contributions and applies `ai-generated` or `human-in-the-loop` labels.
The classifier is a cost-ordered cascade:

1. Account check
2. AI-attribution signatures (product footers, commit trailers, bot-review banners)
3. Coding-agent prose markers (SHA-stamped follow-ups, harness-capture notes)
4. Markdown density, heading+list structure, or house-template headings when a filled template has diluted density
5. Similarity
6. Pangram API

The `human-in-the-loop` label is sticky — once applied it is never
removed. Pure logic lives in `lib.mjs` (vitest `dev-tools` project). See
its `README.md` for label semantics and workflow behavior.

## scheduled-agentic-workflows

Five scheduled agents that read repository or CI state, pick work, and hand it
to `claude-code-action`. Four of them pick at most one piece of work. The
CLAUDE.md compactor is the exception: it fans out one Claude job per oversized
guide and consolidates the shards into a single PR — one Claude given every
oversized file at once spawned-and-waited and wrote nothing (dispatch
33309651347). Each is otherwise the same two-part shape, which is the house
pattern for every agentic workflow here (see also `rum-error-triage.yml` and
`agentic-debt-triage.yml`): a **deterministic Node selector** that does all the
enumerating, filtering, and dedup and writes a composed prompt to
`$GITHUB_OUTPUT`, then **Claude** that does the work. Judgement that can be
expressed as a rule belongs in the selector, where it is unit-tested in the
`dev-tools` vitest project; only the judgement that genuinely needs a model is
left to Claude.

| Directory              | Workflow                        | Cadence     | Picks                                                      |
| ---------------------- | ------------------------------- | ----------- | ---------------------------------------------------------- |
| `boy-scout-debt/`      | `boy-scout-debt-dispatcher.yml` | daily 02:17 | one tractable file on a boy-scout debt list → cleanup PR   |
| `pr-fix-dispatcher/`   | `pr-fix-dispatcher.yml`         | every 2h    | failing automation PRs → re-run, fix, or skip              |
| `claude-md-compactor/` | `claude-md-compactor.yml`       | Sat 22:40   | every oversized `CLAUDE.md` (one Claude each) → one PR     |
| `flaky-ci-hunter/`     | `flaky-ci-hunter.yml`           | Mon 06:50   | one job with proven same-commit flips → determinism fix PR |
| `backlog-dispatcher/`  | `backlog-dispatcher.yml`        | daily 09:35 | open issues that look ready → authored PRs                 |

**State is GitHub-native.** None of the five keeps a state file, a state
branch, or an Actions cache entry. Cross-run memory is derived from GitHub
itself, which cannot drift from reality the way a committed ledger can:

- _"this file is already being cleaned"_ → the changed-file set of open PRs.
- _"this SHA was already re-run"_ → any workflow run for it has
  `run_attempt > 1`; re-running is what bumps the attempt counter, so the runs
  endpoint _is_ the ledger.
- _"this SHA was already skipped / dispatched"_ → `<!-- pr-fix-skip:<sha> -->`
  and `<!-- pr-fix-dispatch:<sha> -->` marker comments, the same durable-dedup
  technique as `<!-- rum-fp:… -->` in `rum-error-triage.yml`. The `ci-fix-*`
  labels are human-visible markers only and are deliberately **not** the dedup
  key, so relabelling a PR by hand cannot cause a double dispatch.
- _"a compaction PR is already open"_ → the `CLAUDE.md` files on that PR are
  claimed; other oversized guides still fan out.
- _"this flaky job is in cooldown"_ → the `automation/flaky-fix/<slug>` PRs;
  the branch name is the registry key and the PR dates are the clock.
- _"this issue was already decided"_ → a `backlog-*` (or legacy `cosmos-*`)
  label on the issue. The backlog dispatcher is the one member of the family
  whose labels **are** the dedup key; see its subsection below for why.

Two details that are easy to get wrong and are therefore pinned by tests:

- **The compactor enforces a stricter policy than the repo gate.** The
  committed gate is 20,000 chars for `packages/*/CLAUDE.md`
  (`PACKAGE_CLAUDE_MAX_CHARS`, via `lint:docs`); the compactor's policy is
  10,000 → 9,500 across _every_ tracked `CLAUDE.md`. A 12,000-char guide passes
  `lint:docs` and is still compaction work. `packages/vfs-root/shared/CLAUDE.md`
  (2,048 **bytes**, bundled into the VFS) is excluded by construction. Sizes are
  measured with `String.length`, never bytes. Every oversized guide fans out
  as its own Claude job (largest first; `max_guides` caps N, default all); a
  `--check` miss still publishes a **partial** shard when that guide actually
  got smaller (`--pack`); unchanged or grown files do not become a PR. Claude
  only edits the worklist — `--pack` artifacts those files and the consolidate
  job copies them onto a new branch from `origin/main` (so a dispatch from a
  workflow PR cannot leak YAML) and synthesises the PR body if Claude left it
  empty. `--max-turns` is computed per shard (300 plus overflow), not a fixed 250. Measure uses `origin/main`'s `CLAUDE.md` files so a dispatch from this
  workflow PR does not re-select a guide already compacted on main. An open
  compaction PR claims its `CLAUDE.md` files rather than skipping the run.
- **The flake hunter lists workflow runs one day at a time.**
  `GET /actions/runs` returns at most 1000 items however you page it, and this
  repo produces roughly 2,400 runs a week, so a window-wide query silently
  truncates to the most recent ~2.5 days and manufactures a quiet week. The
  scanner issues one `created=<day>..<day>` query per day and reconciles
  retrieved-vs-`total_count` per day, reporting truncation in the digest rather
  than reporting a clean scan. Its evidence bar is a **flip** — the same commit
  producing two different outcomes — never "this job fails a lot".

The `flaky-fix` brief also carries the repo's standing anti-retry policy from
[writing-slicc-tests](../.agents/skills/writing-slicc-tests/SKILL.md): raising
a retry count, adding a bare sleep, loosening an assertion, or skipping a test
are rejected fixes, and "this nondeterminism is irreducible" is an acceptable
answer.

The boy-scout, flake-fix, and backlog PRs are pushed with `BOT_PAT`, not
`GITHUB_TOKEN` — GitHub's anti-recursion guard suppresses workflow runs for
`GITHUB_TOKEN`-authored pushes, so CI would never run on them. Same constraint
as `coverage-ratchet.yml` and `renovate-patch-reconcile.yml`.

**Claude never opens the pull request.** In `boy-scout-debt-dispatcher.yml`,
`claude-md-compactor.yml`, `flaky-ci-hunter.yml`, and the backlog dispatcher's
author phase, Claude writes the PR body (and, for the flake hunter and the
backlog author, the title) to a file named by a `PR_BODY_FILE` /
`PR_TITLE_FILE` env var; the compactor's consolidate job also synthesises that
body and pushes a docs-only branch from `origin/main`. A deterministic shell
step then runs `gh pr create` with
`GH_TOKEN: secrets.BOT_PAT`, exactly as `coverage-ratchet.yml` does. The reason is
that `claude-code-action` overrides `GH_TOKEN` for its Bash tool with its own
`github_token:` input (deliberately `${{ github.token }}` here, because the
OIDC → GitHub App exchange fails on this repo), so a PR Claude opens is authored by
`github-actions[bot]` — and GitHub queues every workflow run for such a PR as
`action_required`, leaving it at **zero checks** until a human clicks "Approve and
run". `BOT_PAT` carries contents + pull-requests only, so labelling is a separate
`gh pr edit --add-label` call under `GITHUB_TOKEN` (labels are an Issues API
write); `gh pr create --label` under `BOT_PAT` would 403. Each of these steps is a
clean no-op when Claude pushed nothing, which is what the "report instead of
forcing a fix" escape hatches produce.

### The backlog dispatcher's recovered rubric

`backlog-dispatcher/` migrates an Augment Code ("Cosmos") expert whose prompt
body was a `kb://` include that did not survive that platform's retirement. What
survived is roughly fifty of its **decisions**, left on this repo as
`cosmos-dispatched` / `cosmos-skipped` labels plus its own verbatim skip
comments. The hard-override catalog (security/authorization surfaces; upstream or
platform bugs and design calls; cross-cutting redesigns, which includes the
god-class "Bloat" splits; unconfirmed root causes; concurrency and
data-integrity bugs spanning layers; native work CI cannot verify; unspecified
UX) and the ready classes (a named agentic-debt sin in a named file, a small
localised bug with a concrete symptom, a missing shell command with a clear spec,
one named flaky test, doc drift naming the stale file, a narrow test addition)
were reconstructed from that record and live in `lib.mjs`, unit-tested. The
selector only orders and caps the pool; the go/no-go call is Claude's in phase 1,
with each candidate's detected smells named for it.

Three things set it apart from its four siblings:

- **The labels ARE the dedup key**, not just human-visible markers. An issue
  carrying `backlog-ready` / `backlog-dispatched` / `backlog-skipped` — or the
  legacy `cosmos-dispatched` / `cosmos-skipped` / `cosmos-dispatch-failed`,
  which are treated as equivalent so the first run cannot re-propose work Cosmos
  already rejected — is not a candidate at all. The original re-posted its skip
  comment on the same issue on every tick (#2072 got one on 2026-08-12 and
  another on 2026-08-17); deciding **once** is the fix, and a human removing the
  label is the documented way to re-queue an issue.
- **The stale sweep never closes a pull request.** `sweep-stale-prs.mjs` labels
  `backlog-stale` and comments once on a dispatcher PR idle for a week, then
  leaves it alone. The Cosmos original closed those, which threw away work whose
  only sin was waiting for review.
- **Branch naming is load-bearing.** PRs land on
  `automation/backlog/issue-<n>`; the `automation/` prefix is what makes
  `isAutomationPr()` in `pr-fix-dispatcher/lib.mjs` return true, so a backlog PR
  with failing CI gets a fixer. `lib.test.mjs` imports both libs and asserts the
  agreement rather than trusting the convention.

Scope is `ai-ecoverse/slicc` only, because `BOT_PAT` is a fine-grained PAT scoped
to this repo. The repository is read from `GITHUB_REPOSITORY` / `REPO` and never
hardcoded, so promoting this to `ai-ecoverse/.github` for the org is a packaging
change (`workflow_call` plus a repo input), not a rewrite. Linear support is
deliberately absent — Cosmos's `LINEAR_TEAM_KEYS` was empty.

### What the PR fixer recognises, and the failure it sees most

`pr-fix-dispatcher/lib.mjs` names a failing job's cause from its name plus a
bounded log excerpt, and the `debt-gate` signature is deliberately first in
`CODE_SIGNATURES`. The Debt boy-scout gate
(`tools/check-touched-exemptions.mjs`, the `lint` job's last step) fails any PR
that touches a file still on a debt list — function size, cognitive complexity,
floating or misused promises, layer back-edges, untyped string-keyed bags — and
the boy-scout and backlog dispatchers are built to edit precisely those files.
That makes it the most probable way an automation PR in this repo fails, and one
of the most mechanically fixable: the gate prints both the offending file and the
change it wants.

Two properties of that output are what the dispatcher has to accommodate:

- **It never uses linter vocabulary.** No "biome", no "eslint", no "lint error"
  — it prints `check-touched-exemptions: FAIL`, `still on the <rule> debt list`,
  and, for the frozen-list check, `debt list is frozen and must not grow`. A
  signature table written for ordinary linters classifies it as `unknown`, and
  `unknown` is a skip, so the PR strands waiting for a human.
- **The actionable part reads as calm prose.** The filename line and the `Fix:`
  paragraph contain no failure-ish word, so a per-line "keep the error lines"
  filter keeps the announcement and discards the diagnosis.
  `extractLogExcerpt()` therefore keeps a few lines _after_ each failure line
  (trailing only — the detail always follows the announcement, and leading
  context would just re-add the passing output) within the same size cap, since
  the excerpt is what the fixer's prompt is built from.

The `CI / ci` aggregator (`if: always()` over `needs: [everything]`) fails
alongside whichever job actually broke, and its own log says only "One or more
jobs failed" (plus the job env dump). It is forced to `unknown` and cannot
outrank a sibling: verdicts fold in `blocked` → `code` → `infra` order, with
`unknown` used only when nothing else matched. A bare `dns` substring must never
appear in the network infra signature — every Actions job dumps
`NODE_OPTIONS: --dns-result-order=ipv4first`, and matching that classified PR
#2320's real SPM pin conflict as a network flake. The flake hunter's
`PLUMBING_LINE` guard solves the same problem for signatures rather than
verdicts.

SPM version conflicts (`Could not resolve package dependencies` /
`depends on 'webrtc' 151… and root depends on 'webrtc' 150`) are a
`pin-sync` code signature: Renovate's swift manager updates `Package.swift` but
historically missed the sibling xcodegen `project.yml` `exactVersion` pins.
Syncing those pins is mechanical; inventing a new dependency is still a hard
skip. `renovate.json`'s regex `customManagers` entry covers `project.yml`, and
each dual-pinned GitHub identity is grouped + labelled `swift-pin` so one PR
moves both manifests. That still split (PRs #2320 / #2348: one PR on 151, the
other on 150), so `renovate-swift-pin-reconcile.yml` raises the stale side the
same way `renovate-format-reconcile.yml` reflows a formatter bump. `npm run
lint:swift-pins` is the deterministic backstop. The dispatcher skips
`swift-pin` PRs so it does not race the reconciler; `pin-sync` remains the
backup for an unlabeled leftover.

### Running one on demand

Every one takes `workflow_dispatch`, and each has an input that forces work to
exist so you never have to wait for the cron or for the right conditions to
occur. `dry_run: true` stops after the selector, which is the read-only way to
see what a run _would_ do:

```bash
# Selector only, no Claude, no PR — safe on any of the five.
gh workflow run boy-scout-debt-dispatcher.yml -f dry_run=true
gh workflow run pr-fix-dispatcher.yml         -f dry_run=true
gh workflow run claude-md-compactor.yml       -f dry_run=true
gh workflow run flaky-ci-hunter.yml           -f dry_run=true
gh workflow run backlog-dispatcher.yml        -f dry_run=true

# Force real work without waiting for the natural trigger:
gh workflow run boy-scout-debt-dispatcher.yml -f file=packages/webapp/src/fs/sudo-fs.ts
gh workflow run pr-fix-dispatcher.yml         -f pr_number=1234
gh workflow run claude-md-compactor.yml       -f max_chars=9000 -f target_chars=8500
gh workflow run flaky-ci-hunter.yml           -f window_days=14 -f job=node-server
gh workflow run backlog-dispatcher.yml        -f issue=2101 -f max_dispatches=1

gh run list --workflow=pr-fix-dispatcher.yml --limit 3   # then `gh run view <id> --log`
```

`pr_number` is the one that needed building: the dispatcher otherwise only acts
on a failing automation PR that is at least 20 minutes stale with no recent
human activity, which is untestable on demand. Naming a PR waives those two
waits — there is nobody to yield to when an operator points at a specific PR —
and nothing else. Automation authorship, the self-healing labels, the marker
dedup, the hard-override categories, and the dispatch budget all still apply, so
a targeted run cannot be used to aim a fixer at a human's PR.

`backlog-dispatcher.yml`'s `issue` input works the same way: it waives only the
one-hour settling wait, leaving the decided-label dedup, the denylist, the
in-flight-PR check, and the dispatch budget in force.

## regression-cluster-hunter

`packages/dev-tools/regression-cluster-hunter/` + `.github/workflows/regression-cluster-hunter.yml`.
Full notes: [its README](../packages/dev-tools/regression-cluster-hunter/README.md).

**"Misery loves company."** When a release lands, sweep for the surviving
siblings of one bug fix that shipped in it. This is the complement to
`agentic-debt-triage.yml`, which rotates seven _static_ debt taxonomies and
files ONE issue per night: fixing one instance and leaving the rest is the
repo's most repeated failure mode, and a one-per-night rotation drip-feeds a
cluster instead of sweeping it.

Four recorded clusters motivate it. #2818 (binary bodies UTF-8-corrupted) →
#2878, #2883, #2884, #2885, #2886, #2887, all found by hand the next day.
#2071 → #2154 → #2400 → #2703, four copies of one `readFile`-swallow-then-
clobber bug, surfaced one _per week_ by the nightly rotation. #1996 → #2821,
#2822, one predicate across three runtimes. #2166 → #2255 → seven more
"unknown flag accepted, exit 0" issues.

Same two-part shape as the scheduled family: a deterministic Node selector
(unit-tested in the `dev-tools` project) writes a composed prompt to
`$GITHUB_OUTPUT`, then Claude does the judgement work. It is read-only on code —
`Edit`/`Write`/`gh pr create` are in `--disallowedTools`; the only writes are
`gh issue create`.

Four things here are easy to get wrong and are therefore pinned by tests:

- **`on: release` would never fire.** semantic-release publishes the GitHub
  Release with `secrets.GITHUB_TOKEN` (`release.yml`), and GitHub does not start
  workflow runs from events created by `GITHUB_TOKEN`. The trigger is
  `workflow_run` on **Release** completing. But `Release` runs on every push to
  main and usually publishes nothing, so the selector confirms a
  `chore(release):` commit in the window before spending anything —
  `releasedVersion()`.
- **The evidence bar is a surviving construct**, never "this file looks
  similar": the fix deleted some code, and code of the same kind is still
  present in files the fix did not touch. No survivors, no dispatch.
- **Signature tokens come from REMOVED lines, in product-source hunks, skipping
  comments.** Grepping the _remedy_ finds the sites that are already correct.
  Harvesting the diff's `docs/` and test hunks turns English into signatures —
  replaying #2888 without those filters produced `avoids`, `clicking` and
  `targeting` as top signatures. Tokens that also appear on added lines survived
  the fix and are ranked _down_, not dropped: dropping them left #2888 with no
  signature at all.
- **A lexical signature cannot find every sibling, and the brief says so.**
  #2818's tokens were all `latin1` — the convention it _removed_ — while its
  five real siblings were `TextEncoder` / `base64Encoded` sites sharing no
  vocabulary with it. `shapes.mjs` is the second search: a catalog of shapes
  that have provably clustered here, each with its own `detect(diff)` and
  `probe(text)`. `probe` is a function because the strongest signal is often an
  _absence_ (#2887 reads `base64Encoded` and never decodes it). Every shape
  carries an `evidence` field naming its real cluster, enforced by a test — a
  speculative probe turns the sweep into a grep dump.

Cost: releases land ~8×/day (~27 `fix` commits/day), so three gates keep the
model spend bounded — a `MIN_INTERVAL_HOURS` cooldown (default 12), the
release-actually-landed check, and the surviving-construct bar. Cross-run state
is GitHub-native like the rest of the family: previous successful runs are the
cooldown clock, and `<!-- swept-fix:N -->` on the filed issues is the dedup key.

Measured recall is documented in the README and deliberately not chased: over
#2818 the selector recovers two of five known siblings within a 25-file cap
(ranking #2887's `har-recorder.ts` first); over #2888 it ranks #2883's
`mouse.ts` first. Raising the caps trades a reviewable shortlist for a grep dump.

## review-responder

`review-responder/` is the family's one **event-driven** member: where the five
above go looking for work on a schedule, this one is woken by a reviewer. It
answers the review feedback left on the `automation/*` PRs the other five open —
Codex, Copilot, and this repo's own `claude-pr-review.yml`. Before it existed
that feedback simply sat there; a human had to open a local session and say "take
over PR X and address the review comments".

Same two-part shape as its siblings: `scan-review-feedback.mjs` decides, one
Claude step does the work. Several things about it are non-obvious:

- **Only trusted authors reach the prompt, and the filter fails closed.** This repo
  is public, so anyone with a GitHub account can comment on a PR — and every
  comment body that survives the scan becomes prompt text for a step with
  unrestricted `Bash` and a checkout carrying `BOT_PAT`. `dropReason` therefore
  keeps feedback only from the three named reviewer bots
  (`TRUSTED_REVIEWER_BOTS` — the same identities as the workflow's `allowed_bots`,
  pinned equal by a test) or from an author whose `author_association` is `OWNER`,
  `MEMBER` or `COLLABORATOR`, the three that imply write access. `CONTRIBUTOR` is
  the trap: it only means an account has had a commit merged. That, the
  `FIRST_*`/`NONE`/`MANNEQUIN` values, and a missing or unrecognised association
  are dropped as `untrusted-author` and reported by `formatDrops`, because a
  swallowed comment must not look like an empty PR. `allowed_bots` cannot cover
  this — it gates the triggering **actor**, not the feedback a run collects — and
  the trigger is left ungated on purpose: a stranger's comment may start a run,
  which then finds nothing trusted and skips.
- **The marker records the feedback it processed, not when it finished.**
  `<!-- review-response:<sha>:<iso8601> -->`, where the timestamp is the newest
  `createdAt` in the snapshot that run answered (`feedback_watermark` from the
  scan, `none` for an empty snapshot). Comparing against the marker comment's own
  `created_at` loses a comment left after the snapshot but before the marker: it
  predates the marker, so the next run counted it as already answered and nothing
  ever re-raised it. `decideResponse` takes `respondedWatermark` from
  `lastResponseWatermark`; `lastResponseAt` survives for reporting only. Markers
  without a watermark still parse and fall back to the comment's `created_at`, so a
  PR mid-flight when this shipped does not re-answer everything. The marker is
  written in two places — `buildResponseMarker` and the workflow's `printf` — and a
  test asserts they are byte-equal.

- **It must read all THREE feedback endpoints.** `claude-pr-review.yml` posts its
  verdict as a top-level ISSUE comment, so `GET /pulls/{n}/reviews` alone sees
  nothing at all from the house reviewer — the scan looks like it works while
  ignoring the reviewer whose findings are most specific to this repo. Reviews,
  inline comments (`/pulls/{n}/comments`) and top-level comments
  (`/issues/{n}/comments`) are all required; `lib.test.mjs` pins the
  house-reviewer-only case as a regression test.
- **A reviewer can be wrong, and the prompt says so explicitly.** The right
  response to a bad finding is a reply explaining why, not a change; changing code
  to satisfy a finding the model believes is mistaken makes the code worse _and_
  hides the disagreement. The brief cites the real precedent from #2170, where the
  house reviewer LGTM'd a `Record<string, unknown>` rename that Codex correctly
  identified as defeating the spelling-based debt gate. Reviewers disagreeing is
  normal; the model is told to reason about the code rather than count votes.
- **A three-reviewer burst must produce one run.** `concurrency:
review-responder-<pr>` **queues** the runs (`cancel-in-progress: false`) behind a
  leading `sleep 300` debounce: the first answers a complete feedback set, and the
  rest wake to find its marker at an unmoved head SHA and skip. Two responders on
  one branch would race each other's pushes. `cancel-in-progress: true` is the
  trap: concurrency is evaluated _before_ the job `if:`, so a run the `if:` would
  skip still cancels the run in progress — and every inline reply the responder
  posts is such an event. The first reply would kill the responder that wrote it
  before it recorded its marker, and the replacement would start over: unbounded
  ping-pong presenting as cancelled runs rather than failures.
- **The gate must not be run by the branch it is judging.** The scanner executes
  from a checkout pinned to the default branch with `persist-credentials: false`.
  On `pull_request_review*` the default ref is the PR's merge ref, so omitting
  `ref:` would run the PR's own copy of the script that decides whether the
  privileged step happens. `BOT_PAT` and the branch's code enter the workspace
  only in a second checkout, after the gate has approved the head.
- **Loop safety is doubled everywhere, and the self-filter is NOT author-based.**
  The responder posts comments and comments are its trigger, so the job `if:`
  refuses any run whose triggering comment/review author is
  `github-actions[bot]`, AND `isSelfOutput` drops our own output from the
  feedback. It cannot drop it by author: `claude-pr-review.yml` posts its verdict
  under that same login (`claude-code-action` runs its Bash `gh` under
  GITHUB_TOKEN), so an author filter would discard the house reviewer entirely —
  the same blindness as the endpoint trap above, arrived at from the other side.
  The test is structural instead: either marker in the body at any authorship, or
  an inline comment authored by us with `in_reply_to_id` set (we only ever reply;
  the reviewer's inline comments open new threads). That is also why the workflow
  — not Claude — posts the summary, as one comment carrying the SHA marker.
  `allowed_bots` is not in tension with that `if:` — `allowed_bots` gates the
  _action_ for a triggering **actor**, the `if:` gates which **trigger** is worth a
  run. Claude's push fires `synchronize`, which this workflow does not subscribe
  to.
- **The reviewer bots are named actors** (`github-actions[bot]`,
  `chatgpt-codex-connector[bot]`, `copilot-pull-request-reviewer[bot]`), never
  `'*'`. Admitting third-party Apps as actors grants them no content control they
  lack anyway — their findings are this workflow's input by design, whichever event
  starts the run — while excluding them breaks the feature silently: Codex ignores
  bot-authored PRs and the house reviewer stands down once inline comments exist,
  so Copilot's review is sometimes the only event an `automation/*` PR gets.

Merging, opening a PR, and closing anything are removed from the tool surface
(`--disallowedTools "Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh issue close:*)"`)
rather than merely discouraged in the prompt: a model that ignores an instruction
regresses silently in a way that looks like success. Force-pushing is forbidden
because the branch may carry a human's commits, and the job holds `contents: read`
— the push goes through the `BOT_PAT` credential the checkout persisted, for the
same anti-recursion reason as its siblings.

The session is **not** resumed, deliberately. GitHub already is the durable state:
the diff is on the branch, the reasoning is in the threads, the verdict is the
check suite. A resumed session would be a second, private copy of that state that
can disagree with the public one — and would not survive a human pushing to the
branch, a rebase, or a week's delay anyway. The only memory the run needs is "did
we already answer at this SHA?", which is one HTML comment. Full rationale:
[`packages/dev-tools/review-responder/README.md`](../packages/dev-tools/review-responder/README.md).

```bash
gh workflow run review-responder.yml -f pr_number=2179 -f dry_run=true  # rehearse
gh workflow run review-responder.yml -f pr_number=2179                  # for real
```

## model-scout

`model-scout/` is the family's one **non-agentic** member: no selector prompt, no
Claude step, and it files an issue rather than a PR. It watches the input every
other workflow here depends on — the Bedrock model ID each one resolves through
`vars.<NAME>_BEDROCK_MODEL || vars.RUM_BEDROCK_MODEL ||
'global.anthropic.claude-sonnet-4-6'`. Bedrock model IDs are mutable
infrastructure, and a variable holding a retired one takes down every scheduled
agent on every run with nothing watching: `us.anthropic.claude-opus-4-9`, an ID
that does not exist, did exactly that until someone read the run logs by hand.
`.github/workflows/model-scout.yml` probes each reachable ID with one 1-token
`InvokeModel` every Monday at 05:13 UTC.

Four things about it are non-obvious:

- **The model surface is derived, never listed.** `extractModelReferences` reads
  `.github/workflows/*.yml` and returns every `vars.*_BEDROCK_MODEL` name (with
  the workflows that read it) plus every hardcoded Anthropic model-ID literal in
  those `||` chains — today ten variables and one literal. A committed list would
  go stale exactly like the thing it monitors. The scout's own workflow is
  excluded from the scan, because its env block names every variable and would
  otherwise appear as a consumer of all of them.
- **`invalid` vs `inconclusive` is the entire design.** Only a
  `ResourceNotFoundException`, a `ValidationException` that names the model, or an
  `AccessDeniedException` saying the model is not accessible counts as a dead ID.
  A 403 IAM/quota denial, a 429, a 5xx, a timeout, and a transport error are all
  `inconclusive`, retried with backoff, and never reported as a dead model —
  a throttled Monday that filed an issue telling someone to change a _working_
  variable is how a monitor loses its reader. Note that an IAM denial quotes the
  model ARN, so "the body mentions the model ID" is deliberately not the rule for
  `AccessDeniedException`.
- **Silence is the success output, blindness is loud.** A healthy week files
  nothing (no weekly "all good" issue). A week where _every_ probe was
  inconclusive also files nothing, but logs `BLIND RUN` plus an Actions warning
  annotation and blocks the auto-close step — a canary that cannot tell you it is
  blind is worse than none.
- **The env block is hand-maintained on purpose.** An Actions token cannot read
  repository variables through the API (hard 403), so `${{ vars.X }}`
  interpolation is the only channel for a variable's current value. Because the
  variable list is derived from the workflows and the values are not,
  `scan-models.mjs` exits 3 when a workflow references a variable the workflow did
  not pass in, so a new variable cannot silently escape the canary. A variable
  that is present but empty is just unset in the repo — the chain falls through,
  which is expected and logged, not an error.

No replacement ID is ever guessed: `suggestReplacement` names only an ID probed
`ok` in the same run from the same model family, and the issue otherwise says
plainly that no verified replacement was found. Rationale and the full env table:
[`packages/dev-tools/model-scout/README.md`](../packages/dev-tools/model-scout/README.md).

```bash
gh workflow run model-scout.yml -f dry_run=true  # probe + report, no issue writes
```

## doc-dead-reference-gate

`check-doc-refs.mjs` (+ `check-doc-refs-lib.mjs`) skips globs,
angle-bracket templates, illustrative `my-*` paths, absolute VFS
runtime paths, and a small built-in allowlist for build artifacts,
external-repo refs, and spec/plan future files. TypeScript ESM
`.js`→`.ts` resolution is handled automatically. Chained after
`check-doc-sizes.mjs` in `lint:docs`.

## layer-back-edge-ratchet

`check-layer-back-edges.mjs` fails on any NEW import in
`packages/webapp/src/` that points up the stack
`fs → shell/git → cdp → tools → core → scoops → ui`
(e.g. `cdp/` → `scoops/`, or any layer → `ui/`).

Unranked directories (`kernel/`, `providers/`, `speech/`, …) rank just
below `ui/`: they may import ranked layers but not `ui/`, and are never
a back-edge target. Pre-existing back-edges are grandfathered per file
in `layer-back-edge-baseline.json` (one-way ratchet; regenerate after
paying debt down with `--update`). The baseline doubles as a debt list
for the boy-scout gate. Chained into `npm run lint`, `lint:ci`,
pre-commit (webapp-source commits), and the pre-push gate.

The same pass also fails on any relative import that climbs OUT of
`packages/webapp/src` into a sibling package
(`../../../node-server/src/tray-url-shared.js`, #2798). Ranked layers are
webapp-internal directories, so such a specifier lands in no layer and the
ratchet above cannot see it. Zero tolerance, no baseline — the tree is clean.
Exempt: the inert asset queries `?raw` and `?url`, which hand back bytes or a
URL string rather than creating a module edge. That is an allowlist, not "any
query" — `?worker` / `?sharedworker` bundle and EXECUTE the target, so waving
them through would reopen the same wrong-direction dependency. A new asset mode
is a conscious decision; the gate fails closed. Shared code belongs in
`@slicc/shared-ts`, imported by package name.

## float-probe-ratchet

`check-no-float-probes.mjs` (#2276 slice D) fails on any NEW read of one of
ten float/topology identifiers (`FLOAT_PROBE_NAMES`: `isExtensionRealm`,
`isChromeExtensionRealm`, `hasLocalNodeServer`, `resolveFloatTopology`,
`getChromeExtensionRealm`, `setChromeExtensionRealm`, `hasChromeRuntimeConnect`,
`canConnectToChromeRuntime`, `getExtensionDelegateId`,
`setExtensionDelegateId`), plus the raw `__slicc_connect_mode` global-bag key
`resolveFloatTopology` reads directly, under `scoops/`, `tools/`, or
`kernel/` — except three composition roots: `kernel/host.ts` and
`kernel/kernel-worker.ts` (each resolves the float's topology once, into a
`CapabilityBroker` or an extension-delegate id — `docs/work-unit.md` Phase
6), and `kernel/port-bridge-client.ts` (the extension-delegate Port/panel-RPC
transport factory every kernel-side bridge client shares — conceptually
`shell/`-owned, but moving it there would add a `shell/` → `kernel/`
`PanelRpcOp` type dependency against the stack's direction, so it is a named
exemption instead). Privileged float detection belongs on the injected
broker or, for a genuine transport decision, in `shell/` (which owns
topology).

Round-1 review (Grok + human) planted a batch of evasions against the first
cut of this gate and every one passed silently — a gate that passes on a
planted violation is worse than no gate. The design is now two layers:

- A **module-path ban**: `shell/float-topology.ts`, `core/float-topology.ts`,
  `base/runtime-env.ts`, `core/runtime-env.ts` exist for nothing but float
  detection, so importing from one, in ANY form (named, default, namespace
  `import * as`, dynamic `import(…)`, `export * from`, type-only), is banned
  regardless of what name the importer binds it to — `import * as topo from
'…/float-topology.js'` names the MODULE, not a banned identifier, and a
  pure name scan cannot see it.
- A **named-clause scan**, line-anchored to the statement's own start (so a
  string literal containing import-shaped text elsewhere on the line can
  never match — `export const x = "import { hasLocalNodeServer } from
'…'"` used to trip the unanchored version), for everything else: the
  mixed-surface `base/api-endpoint.ts` / `shell/proxied-fetch.ts` (which
  also export plenty of non-probe bindings) and `@slicc/shared-ts`'s two
  probe exports specifically (never the whole package). Every domain #2276
  migrated reuses a probe's OWN name for a local composition-time-answer
  const/parameter/property (`const hasLocalNodeServer = () =>
localNode.ok`), so this stays clause-based rather than a whole-file scan —
  a whole-file scan cannot tell that reuse apart from an actual import.

A discovery pass folds three alias shapes, found anywhere in
`packages/webapp/src`, into the named-clause scan: a bare value re-export
(`export const isTrayExtension = getChromeExtensionRealm`), a renamed
`export { … as … }`, and a THIN wrapper whose entire body is `return
PROBE(...)` (`export function inExtension() { return isExtensionRealm();
}`) — narrow enough on purpose that `shell/tray-fetch.ts`'s
`createTrayFetch` (a substantive function that merely reads topology as one
of several statements, already reviewed in the network-domain slice) is not
mistaken for a probe-identity wrapper. A pre-existing, legitimate,
out-of-zone rename (`core/secret-topology.ts`'s `resolveFloatTopology as
resolveSecretTopology`) is not itself flagged — the alias name is folded
into the banned-zone scan instead, so the violation would surface at a
banned-zone IMPORT site if one ever appeared, not at the file that defined
the alias.

Baseline `float-probe-baseline.json` starts EMPTY (one-way ratchet;
regenerate after paying debt down with `--update`) — slices A–C's migration
work made that the honest starting point — and `--update` refuses to WRITE a
larger baseline than the one already on disk unless `--allow-growth` is also
passed, so a careless local `--update` cannot silently grandfather a new
violation before it is even committed. The baseline doubles as a debt list
for the boy-scout gate (`check-touched-exemptions.mjs`, whose own
"list must not grow" check used to skip entirely whenever a debt list's
base-ref state was empty — indistinguishable from the list not existing yet
— fixed for all three ratcheted debt lists, not just this one). Chained into
`npm run lint` and `lint:ci`.

## record-string-unknown-ratchet

`check-record-string-unknown.mjs` fails on any NEW `Record<string, unknown>`
in non-test source. Detection is a Biome analyzer plugin
(`.biome-plugins/no-record-string-unknown.grit`), not a regex, so it matches
the real type node: line-wrapped occurrences count, `Record<string, string>`
does not, and `// biome-ignore lint/plugin: <reason>` suppresses a line the
same way it would any other Biome diagnostic.

The plugin cannot live in the root `biome.json`: at `severity = "error"` it
would fail `lint:ci` on all 604 pre-existing occurrences, and Biome's
`--skip=plugin` and `overrides[].plugins` are both group-level — there is no
per-plugin file exemption (`overrides[].plugins: []` is additive, not a
kill-switch). So `biome.record-gate.json` extends the root config, inheriting
`files.includes` verbatim (zero drift), and swaps in that one plugin; the
script runs it with `--only=plugin --reporter=json` and enforces the baseline.

Pre-existing occurrences are grandfathered per file in
`record-string-unknown-baseline.json` (one-way ratchet; regenerate after
paying debt down with `--update`). The baseline doubles as a debt list for
the boy-scout gate. Tests are out of scope — `(globalThis as Record<string,
unknown>).chrome = …` is idiomatic scaffolding, and `biome.json` already
exempts tests from `noExplicitAny` and the complexity rules for the same
reason. Chained into `npm run lint` and `lint:ci`.

## storybook-screenshots-upload

`storybook-screenshots-upload.mjs` (+ `storybook-screenshots-upload-lib.mjs`)
uploads the affected-story manifest to the `slicc-pr-screenshots` R2
bucket, content-hash deduplicated, with bounded concurrency
(`--concurrency`, default 4) via an injectable `r2` client so
`mapWithConcurrency`/dedup logic is testable without a real `wrangler`
process.

Sequential per-file `wrangler` subprocess spawns previously took ~4s per
file — timing out the CI job on large PRs (many affected stories). Each
shot retries up to 5 times with jittered exponential backoff, since R2
rate-limits upload bursts with `429` / code 971. Driven by the "Upload
screenshots to Cloudflare R2" step in
`.github/workflows/storybook-screenshots.yml`.

## knip-production-suffix-discipline

`npm run deadcode:production-files` runs `knip --production --include files`
to surface test-only dead files the default knip gate misses.

**Production-suffix discipline**: every workspace `entry`/`project`
glob in the production graph MUST be `!`-suffixed;
`knip --production` keeps only suffixed patterns. Test-only fixtures
are excluded via negated `project` patterns in `knip.json`, **not**
`ignoreFiles`. See the
[verifying-before-push skill](../.agents/skills/verifying-before-push/SKILL.md)
§ "Knip fixture exclusion" for why `ignoreFiles` is wrong and the
correct approach.

## swift-unused-dependency-gate

`npm run lint:swift-deps`
(`packages/dev-tools/tools/check-swift-unused-deps.mjs` + `-lib.mjs`)
gives the Swift/SPM packages the unused-dependency signal knip provides
for the TS workspaces (`npm run deadcode`) and `go mod tidy -diff` for
the Go modules (`make tidy-check` in `packages/{go-optel,slicc-cli}`).
SPM has no built-in equivalent: `swift build` links a declared
dependency whether or not any source imports it, so a dropped `import`
leaves a dead package pinned in `Package.resolved` and paid for on every
resolve.

The gate parses every `packages/*/Package.swift`, resolves each target's
sources (explicit `path:`/`sources:`/`exclude:`, else the **first**
matching conventional root — `Sources/<name>` before the enclosing
`Sources`, so a target never scans a sibling target's files), collects
the modules those sources import, and reports three findings:

| Code                        | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `unused-package-dependency` | a `.package(...)` clause no target consumes a product from |
| `unused-target-dependency`  | a target dependency no source of that target imports       |
| `unlisted-dependency`       | a module a target imports but only reaches transitively    |

Matching mirrors SPM's own rules: package identities compare
case-insensitively and come from the last URL/path component, target
names are normalised to module names (`slicc-server` → `slicc_server`),
local `path:` dependencies are resolved through their own manifests so a
product vending a differently-named module still matches — scoped to the
product the target actually declared, so a sibling product of the same
local package never satisfies it — and modules named in
`#if canImport(...)` count as used. Comments **and string literals** are
blanked before the import scan, so a generated-source fixture such as
`let src = """\nimport Logging\n"""` cannot make a dead dependency look
alive. `.product(…, condition:)`
entries are skipped — the importing sources sit behind `#if os(...)`,
which the gate does not evaluate. The `unlisted-dependency` check only
fires for modules whose origin is knowable from the manifest (a sibling
target, a local package, or a product another target in the same
manifest declares), so a transitive module of an external package is
never guessed at.

Parsing is string-level on purpose: the gate is chained into `lint` /
`lint:ci` and therefore runs in the Linux `lint` CI job, which has no
Swift toolchain and cannot evaluate `Package.swift` as code.

A legitimate exception (a product linked for its resources or plugin
rather than imported) is annotated at the declaration site:

```swift
.product(name: "SomeThing", package: "some-package"),  // unused-dep-ok: linked for its resource bundle
```

The marker applies to the entry's own line, any line a multi-line entry
spans, and the line directly above it. Behaviour is covered by
`check-swift-unused-deps.test.mjs`, including an end-to-end run against
the checked-in manifests.

## swift-coverage-retry

`swift-coverage-check.sh` sources `swift-coverage-runner-retry.sh` in
`--xcodebuild` mode to retry once when the UI-test runner dies at
initialization. This is an infrastructure failure
`-retry-tests-on-failure` cannot see (the runner never gets far enough
to report per-test results); tested by
`swift-coverage-runner-retry.test.mjs`. Set `SLICC_IOS_SIM_UDID` to a
worktree-owned simulator UDID to override automatic selection locally;
when unset or empty, existing SDK-runtime selection remains unchanged.

## fresh-dev-harnesses

Five harness scripts bring up isolated dev environments on distinct
ports so they can run concurrently. Port-selection, reaping, and
LaunchServices lifecycle are covered in
[`docs/development.md`](development.md) § "Fresh Dev Harness Details".

Reaping semantics (also enforced in the harness scripts):

- The standalone harness fails if its selected bridge port is occupied
  by default.
- `SLICC_FRESH_REAP=1` opts into reaping a confirmed stale harness on
  that port.
- Forced reaping of the documented production bridge `:5710` is always
  refused.
- The harness never reaps Chrome CDP (`:9222` production, per-harness
  `:9224`/`:9225`/`:9226`/`:9333` dev).
- Other harness cleanup remains strictly port-scoped, never by process
  name.

Labeled Chrome bundle clones (`clone-labeled-chrome.sh`) provide
distinct ⌘-Tab entries.

## ios-ui-test-exclusion-registry

`npm run lint:ios-ui-tests`
(`packages/dev-tools/tools/ios-ui-test-exclusions.mjs` +
`packages/ios-app/ui-test-exclusions.json`) exists because the
`ios-app-tests` CI job runs the WHOLE `SliccFollowerUITests` bundle on
the GA cells and then subtracts this registry, so a newly added test
class is gated the day it lands rather than needing to be opted in. The
gate rejects a registry entry that has no reason, or one naming a
class/method that no longer exists in the bundle.

## swiftpm-lockfile-drift-gate

`packages/dev-tools/tools/check-swift-resolved-drift.mjs` runs AFTER a
resolve step (the `ios-app` CI job).
`xcodebuild -resolvePackageDependencies` rewrites `Package.resolved` in
place and then builds against what it wrote, so a floated **transitive**
pin lands with no diff; `lint:swift-pins` only inspects direct pins. The
gate compares identity/version/revision while ignoring `originHash` and
key order (both move with the toolchain), catching the transitive drift
`lint:swift-pins` cannot see.

## source-guards

Source-shape guards under `packages/dev-tools/tools/`, each wired to its
own lint script:

- `check-no-innerhtml.mjs` (`npm run lint:no-innerhtml`) bans
  `.innerHTML =`, `.outerHTML =`, and `insertAdjacentHTML()` in
  `@slicc/webcomponents` (stories/tests exempt).
- `check-no-ui-imports-in-providers.mjs`
  (`npm run lint:no-ui-in-providers`) bans `from '…ui/…'` imports in
  `providers/built-in/`.
- `check-hosted-origin-literal.mjs` — TS must import
  `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts` rather than hardcoding
  the origin.
- `check-no-raw-chrome-runtime-id.mjs` — use `isChromeExtensionRealm()`
  from `@slicc/shared-ts` instead of a raw `chrome.runtime.id` check
  (tests exempt).
- `check-agents-symlinks.mjs` — every `packages/*/CLAUDE.md` needs an
  `AGENTS.md` sibling symlink.

## first-load-size-gate

`packages/dev-tools/tools/check-first-load-size.mjs` (+
`first-load-size-lib.mjs`, `first-load-baseline.mjs`), part of
`npm run size -w @slicc/webapp`, measures the eager import closures of
the page entry (via `.vite/manifest.json`) and the kernel-worker entry
(parsed from emitted chunks). It guards cold-boot payload, not per-file
size.

It is **relative**: it builds the merge-base in a throwaway worktree
(workspace packages re-pointed at the worktree's own source, then the
root `postinstall` prerequisite builds — borrowing the caller's build
would mask a webcomponents-side regression) and fails on a change's own
growth past `maxDeltaKb`, so it never fires on inherited state and
cancels the ~1 kB Linux-vs-macOS build difference. Flags:
`--baseline=<ref>` (default `origin/main`), `--baseline=none` to skip,
`--json` to just measure.

**Dependency changes** are realigned before the baseline is measured. The
worktree borrows the caller's `node_modules` (npm workspaces hoist, so the
base build only needs them to resolve), which used to mean a version bump
built the NEW version on both sides and reported +0.0 kB for exactly the
change under test — `@imagemagick/magick-wasm` 0.0.42 -> 0.0.43 (PR #2744)
added 103 kB to the worker eager graph and the delta gate saw nothing, with
only ceiling headroom catching it. `dependencyDrift` now diffs the two
lockfiles and `realignDriftedDependencies` puts the base tree back via
`npm pack` (a symlinked `@scope` is split into per-child links first, so the
caller's real install is never written through). Aliases are fetched under
the lock entry's `name`, not its install directory — this repo has
`node_modules/undici8` for `undici`, and asking the registry for `undici8`
would fetch a different package.

The two corrections are not symmetric. A **version bump** is required: not
fixing it is the silently-wrong +0.0 kB, so a failed fetch aborts. A package
the change **removes** is best effort: HEAD's mirror has no copy, and if the
base source imports it the build fails on its own, so a failed fetch is not
fatal — aborting would newly fail PRs that merely drop an unused dependency.
Packages the change **adds** are ignored; the base never had them.

Drift it cannot realign — an un-hoisted nested copy whose ancestor package
did not also change, or more than 25 changed packages — makes the baseline
unmeasurable rather than quietly wrong, which a CI `pull_request` run fails.
A nested copy under a parent that is itself being realigned is covered by
that parent swap (knip 6.33.0 nesting `@oxc-project/types` under `oxc-parser`
is the specimen). Transitive dependencies of a realigned package stay
borrowed from HEAD: a deliberate approximation, since the alternative is a
full `npm ci` per gate run.

On `merge_group` the delta is skipped — a queue branch is cumulative, so
its delta is the batch sum and a per-change allowance would fail on
queue depth; only the ceilings run, with no baseline build. That split
is only safe because a CI `pull_request` run treats an unmeasurable
baseline as a hard failure rather than degrading, so a PR can never
clear both stages unmeasured. Local runs still degrade to ceilings with
a note. The absolute `*EagerCeilingKb` values in
`packages/webapp/first-load-budget.json` are the backstop against many
small under-threshold changes creeping upward — human-owned, not
numbers to nudge when a build goes red.
