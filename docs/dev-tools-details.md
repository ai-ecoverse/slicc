# Dev-Tools Deep Reference

Rationale, gotchas, and non-obvious behavior for tools listed in
[`packages/dev-tools/CLAUDE.md`](../packages/dev-tools/CLAUDE.md). The
guide keeps entry commands; this page keeps the "why".

## ai-comment-detection

`packages/dev-tools/ai-comment-detection/` classifies PR/issue thread
contributions and applies `ai-generated` or `human-in-the-loop` labels.
The classifier is a cost-ordered cascade:

1. Account check
2. Markdown density
3. Similarity
4. Pangram API

The `human-in-the-loop` label is sticky — once applied it is never
removed. Pure logic lives in `lib.mjs` (vitest `dev-tools` project). See
its `README.md` for label semantics and workflow behavior.

## scheduled-agentic-workflows

Five scheduled agents that read repository or CI state, pick at most one piece
of work, and hand it to `claude-code-action`. Each is the same two-part shape,
which is the house pattern for every agentic workflow here (see also
`rum-error-triage.yml` and `agentic-debt-triage.yml`): a **deterministic Node
selector** that does all the enumerating, filtering, and dedup and writes a
composed prompt to `$GITHUB_OUTPUT`, then **one Claude step** that does the
work. Judgement that can be expressed as a rule belongs in the selector, where
it is unit-tested in the `dev-tools` vitest project; only the judgement that
genuinely needs a model is left to Claude.

| Directory              | Workflow                        | Cadence     | Picks                                                      |
| ---------------------- | ------------------------------- | ----------- | ---------------------------------------------------------- |
| `boy-scout-debt/`      | `boy-scout-debt-dispatcher.yml` | daily 02:17 | one tractable file on a boy-scout debt list → cleanup PR   |
| `pr-fix-dispatcher/`   | `pr-fix-dispatcher.yml`         | every 2h    | failing automation PRs → re-run, fix, or skip              |
| `claude-md-compactor/` | `claude-md-compactor.yml`       | Sat 22:40   | oversized `CLAUDE.md` guides → one compaction PR           |
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
- _"a compaction PR is already open"_ → an open PR whose head branch or title
  carries the compaction prefix.
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
  (3,000 **bytes**, bundled into the VFS) is excluded by construction. Sizes are
  measured with `String.length`, never bytes.
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
