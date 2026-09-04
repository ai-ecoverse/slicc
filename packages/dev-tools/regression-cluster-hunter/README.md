# Regression Cluster Hunter

> Misery loves company.

When a bug fix ships, find out whether the **same defect shape** is still live
somewhere else, and file an issue for each place it is.

Workflow: [`.github/workflows/regression-cluster-hunter.yml`](../../../.github/workflows/regression-cluster-hunter.yml).

## Why

Fixing one instance of a bug and leaving its siblings in the tree is this
repository's most repeated failure mode. Four documented clusters:

| Seed fix                                            | Siblings                                                      | How they were found                        |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| #2818 — binary bodies UTF-8-corrupted               | #2878, #2883, #2884, #2885, #2886, #2887                      | by hand, the next day                      |
| #2071 — `readFile` swallow clobbers persisted state | #2154, #2400, #2703                                           | one per week, by the nightly debt rotation |
| #1996 — text/binary predicate triplicated           | #2821, #2822                                                  | while auditing a different PR              |
| #2166 — unknown flag ignored, exit 0                | #2255, #2404, #2405, #2816, #2819, #2863, #2864, #2865, #2880 | ten separate discoveries                   |

None of these were found by a sweep. The nightly
[`agentic-debt-triage.yml`](../../../.github/workflows/agentic-debt-triage.yml)
rotates seven static debt taxonomies and files **one** issue per run, which is
why the `readFile` family took four weeks to surface. This hunter is the
complement: it starts from a fix that actually shipped and looks for that one
bug's remaining homes.

## The bar

The analogue of the flake hunter's "same commit, two outcomes" is a **surviving
construct**: the fix deleted some code, and code of the same kind is still
present in files the fix did not touch. No survivors, no dispatch. A quiet
release is a good release.

## Shape

The house pattern — a deterministic Node selector, then Claude:

1. **`scan-fixes.mjs`** (I/O) + **`lib.mjs`** / **`shapes.mjs`** (pure) read git
   history and the REST API **read-only**, confirm a release actually landed,
   pick at most **one** shipped fix, and prove its construct survives elsewhere.
2. **claude-code-action** reads that fix's diff, states the defect as a rule,
   tests each candidate against it, and files an issue per confirmed sibling
   (capped, `regression-cluster` label).

Everything expressible as a rule lives in the selector, where it is unit-tested
in the `dev-tools` vitest project. Only the judgement that needs a model — _is
this lookalike actually the same bug?_ — is left to Claude.

## Two searches, because one is not enough

**`lib.mjs` — the token table.** Distils the fix's **deleted** lines into
signature tokens and finds files that still carry them. Three filters, each
earning its keep on the first live run:

- Removed lines only. Grepping for the _remedy_ finds the sites that are already
  correct — the inversion that would file issues against healthy code.
- Product source hunks only. A fix's diff routinely includes
  `docs/shell-reference.md` and its own tests.
- No comments. Replaying #2888 without this made `avoids`, `clicking`,
  `targeting`, `Convert` and `Detect` top signatures, all lifted from prose.

Tokens that survive into the fixed version are ranked **down**, not dropped:
they are structure, not defect (`PlaywrightHandler`, `requireTab`), but dropping
them outright left #2888 with no signature at all, because most fixes rewrite a
line in place.

**`shapes.mjs` — the shape catalog.** The token table finds files that share
_vocabulary_, which is not the same as sharing a _bug_. Replaying #2818 proves
the gap: its tokens were all about `latin1`, the convention the fix **removed**,
while its five real siblings were `TextEncoder` / `TextDecoder` /
`base64Encoded` sites sharing no vocabulary with it at all. Same bug, different
words.

So each catalogued shape carries `detect(diff)` (does the shipped fix belong to
this shape?) and `probe(text)` (where else does it live, in **its own**
vocabulary?). `probe` is a function rather than a regex list because the most
valuable signal is often an **absence** — `network-requests.ts` (#2887) reads
CDP's `base64Encoded` flag and never decodes it, so there is no wrong call to
grep for, only a missing right one.

Ranking puts _precise_ signals (an absence; a full read-default-write triad)
above bulk vocabulary, and _incidental_ byte-handling above dedicated codecs:
every real #2818 sibling was a file doing something else that happened to touch
bytes, while the unweighted top of the list was `base64.ts`,
`websocat-encoding.ts` and `apns.ts` — dedicated codecs, all correct.

**Every shape must carry a receipt.** The `evidence` field names the cluster
that actually happened, and a unit test enforces it. A speculative probe turns
the sweep into a grep dump.

### Measured recall

Replaying the selector over #2818 against the tree it shipped into recovers
**two of its five** known siblings inside a 25-file cap, and ranks
`har-recorder.ts` (#2887) first via the absence signal. Over #2888 it ranks
`mouse.ts` (the real #2883 sibling) first. The remaining misses share neither
vocabulary nor probe, which is exactly why the brief tells Claude the table is a
lead rather than a finding and instructs it to grep for the _concept_. Do not
raise the caps to chase the last siblings — that trades a reviewable shortlist
for a grep dump.

## Cost gates

Releases land ~8×/day here (~27 `fix` commits/day), so an ungated hunt-per-
release would be a dozen Claude runs a day. Three gates, all in the selector:

1. **Cooldown** — `MIN_INTERVAL_HOURS` (default 12) since the last run.
2. **A release actually landed** — a `chore(release):` commit in the window.
   The `Release` workflow runs on every push to main and usually publishes
   nothing, so `workflow_run` completing is not proof.
3. **The surviving-construct bar** — at least `minSiblings` untouched files.

## Trigger, and the trap in it

`on: release: [published]` **would never fire**. semantic-release publishes the
GitHub Release with `secrets.GITHUB_TOKEN` (see `release.yml`), and GitHub does
not start workflow runs from events created by `GITHUB_TOKEN`. The workflow
therefore listens for the **Release workflow** completing (`workflow_run`), and
the selector confirms the release separately.

## State

GitHub-native — no state file, branch, or Actions cache:

- _"when did we last hunt"_ → previous successful runs of this workflow (the
  Actions API is the clock).
- _"this fix was already swept"_ → the `<!-- swept-fix:N -->` marker on the
  issues a previous hunt filed, the same durable-dedup technique as
  `<!-- agentic-debt:… -->` and `<!-- rum-fp:… -->`.

## Running it

```bash
# Selector only — no Claude, no issues. Safe anywhere.
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) DRY_RUN=true \
  node packages/dev-tools/regression-cluster-hunter/scan-fixes.mjs

# Sweep one specific fix, ignoring selection and the cooldown.
REPO=ai-ecoverse/slicc GH_TOKEN=$(gh auth token) PR_OVERRIDE=2818 DRY_RUN=true \
  node packages/dev-tools/regression-cluster-hunter/scan-fixes.mjs
```

`workflow_dispatch` exposes `pr`, `min_interval_hours` and `dry_run`.

Unit tests: `npx vitest run --project dev-tools packages/dev-tools/regression-cluster-hunter/`
