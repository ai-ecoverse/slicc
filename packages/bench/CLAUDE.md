# CLAUDE.md

This file covers the benchmark runner in `packages/bench/`.

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges every run against the task's rubric, and writes result files and a report (issue #3180). Two questions drive it: what difference skills make, and what difference models make.

- **One task format**, shared with browser-use's BU Bench V2: an envelope `{ benchmark, tasks[] }`, and per task `{ id, task, rubric, weights }` with weights summing to 100. Public sets and our own skill evals use it. SLICC-only needs ride in an optional `slicc` object (`website`, `skills`, `files`, `timeoutSeconds`, `requires`) that upstream runners ignore.
- **Public sets by reference.** `bu-v1` and `bu-v2` come from browser-use/benchmark at the commit pinned in `scripts/upstream.mjs`, decrypted in memory. That repo has no licence and asks that the task text never be published, so nothing from it is committed, and traces holding its task text are Fernet-encrypted with the set's own key before they leave the runner.
- **Judge**: upstream's findings method. The judge reports met / violated / not_assessable per rubric item with evidence; code scores from the weights. The system prompt and truncation caps are read from upstream's `findings_judge.py` at the pinned commit. It runs over Bedrock Converse with forced tool use, default `global.openai.gpt-5.6-luna` (a non-Claude judge, as #3180 prefers).

**Not an npm workspace**, like `packages/github-workflow/`: `scripts/` is dependency-free (Node built-ins; it imports `github-workflow/scripts/gh-io.mjs` for the dial-retry rule). Tests run under the `bench` vitest project.

## Layout

| Path                        | Purpose                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/format.mjs`        | Task format: validation, `outcome()` (pass / partial / fail), BU V1 and skill-creator converters                    |
| `scripts/upstream.mjs`      | Pinned upstream: Fernet decrypt/encrypt, set loading, judge-spec extraction                                         |
| `scripts/judge.mjs`         | Findings judge over Converse: request, validation, `score()`, text-only retry                                       |
| `scripts/slicc-adapter.mjs` | Prompt, skills staging, `runTask` (setup, prompt, capture, teardown), transcript → trace                            |
| `scripts/executors.mjs`     | Leader access: the Go `slicc` CLI against a join URL, with dial retries and prompt interrupt                        |
| `scripts/results.mjs`       | Records → browser-use-style result files, paired skill/model deltas, markdown report                                |
| `scripts/html.mjs`          | Records → one self-contained `report.html`: cards, table, deltas, task matrix, time × cost                          |
| `scripts/publish.mjs`       | Stage a run for the Hugging Face dataset `ai-ecoverse/slicc-bench`: encrypted traces and task sets, combined report |
| `dataset/README.md`         | The dataset card template; `publish.mjs` puts the combined report in place of `<!-- report -->`                     |
| `scripts/run.mjs`           | CLI: plan, run, judge, resume, write `records/`, `traces/`, `results/`, `report.md`                                 |
| `tasks/smoke.json`          | Two short live tasks in the shared format; the PR smoke run uses the first                                          |

## How a run works

Everything is driven from outside, through the Go `slicc` CLI against the leader's join URL; nothing bench-specific runs on the leader. A task is what a person would do: open a fresh chat, pick a model, type the task into the cone.

1. `run.mjs` stages `/workspace/skills` for the skills condition with `slicc exec`. The cone and any scoop it spawns read that directory. The leader's own skills are stashed once in `/workspace/.bench-skills-builtin` and restored at the end. Conditions: `none`, `builtin`, and either joined with `+` to extra sets under `/workspace/bench-skills/<name>/`.
2. Per task, `runTask` puts the task's files in the VFS, closes open tabs, then runs `slicc new-session --erase` and `slicc model <m>`. `--erase` also drops the cone's memories, so no task sees what an earlier one learned. `model` resolves the alias against the leader's catalogue and prints the provider-qualified id, recorded as `model_id`. Then `slicc prompt -` sends the task text plus upstream's closing instruction (a `FINAL ANSWER:` line, no clarifying questions). How to drive the browser is left to SLICC and the installed skills, because that is what the skills axis measures. On timeout the runner sends the CLI SIGINT, which aborts the cone.
3. While the cone works, the runner polls `playwright-cli tab-list` and screenshots a tab whose address changed, or every 15 s, because agents close their tabs when done. Cost, tokens and turns are the delta of `cost --json --all` across the prompt: the cone plus every scoop it spawned, dropped ones included. The judge's trajectory comes from `session export`; its per-message model ids fill `modelsUsed`, which shows when scoops ran on another model.
4. Runs are ordered skills → repeat → task → model, so both models meet the live web at about the same moment.
5. Records store the task, rubric and weights digests and the judge model, and `resumeAction()` decides each run on resume:
   - `done`: nothing changed.
   - `rejudge`: another judge, a changed rubric or weights, or a failed judge call. The saved trace is re-judged; the agent does not run again.
   - `run`: the agent failed, or the task text changed.

   An errored run is reported, never counted as a fail: #3180's matrix is sparse. The invocation still exits 1, so a CI job does not go green on runs that never happened. Scores and outcomes use only judged runs; time and cost use every finished run. Summaries name the judge from the records, never from the command line.

## Publishing

`report.md`, `report.json` and `report.html` are written with every run; `reportData()` is the source of all three. `bench.yml` uploads them with `results/` as the `bench-report-<run>` artifact, and everything as `bench-<run>`. A dispatch run then publishes to [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench) with the repo's `HF_TOKEN` secret. It downloads the dataset's `records/`, stages this run over them with `publish.mjs`, and sends one `hf upload` commit.

- The encryption is browser-use's: a `.enc` file is the base64 of a Fernet token whose key is `sha256(<benchmark>)`.
- Our own task sets go to `tasks/<benchmark>.enc`, and their traces to `runs/<run>/traces/…`, encrypted.
- Upstream sets publish scores only: no traces, and their rubric item ids reduced to status counts.
- Published records never carry `metrics.tabs`, because open tabs can name the site or the search.

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml
```

Live check against a local dev harness (`packages/dev-tools/tools/dev-standalone-fresh.sh`): run `host` in its terminal for a join URL, and build the CLI from this checkout so it has `new-session` and `model`:

```bash
(cd packages/slicc-cli && go build -o /tmp/slicc-dev .)
SLICC_CLI=/tmp/slicc-dev SLICC_JOIN_URL=… AWS_BEARER_TOKEN_BEDROCK=… \
  node packages/bench/scripts/run.mjs --set packages/bench/tasks/smoke.json --out /tmp/bench-out
```

## Design Rules

- **Never commit or print upstream task text.** Load it with `loadUpstreamSet`, keep it in memory, and encrypt traces with `encryptJson`. `records/` and `results/` hold ids, scores and metrics only.
- **The judge never scores.** Weights stay out of its prompt; `score()` is upstream's arithmetic (met weight / total, worst-wins duplicates, canary leak or suspected reward hacking zeroes the run).
- **Executors never throw on a non-zero status**; callers decide. Dial failures retry, executions never do.
- **Drive the leader only through its public surface**: CLI verbs and shell commands a person could type. A leader-side helper script would benchmark a harness nobody uses.
- **Pure vs I/O split**, as in github-workflow: decisions live in exported functions with injected `leader`, `fetchImpl`, `judge`, `loadUpstream`, `now`.

## Related

- [`README.md`](./README.md) — usage, task format, adding skill evals
- `packages/github-workflow/CLAUDE.md` — the leader and CLI this runs on
- `.github/workflows/bench.yml` — dispatch runs and the PR smoke run
