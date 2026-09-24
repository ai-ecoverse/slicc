# CLAUDE.md

This file covers the benchmark runner in `packages/bench/`.

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges every run against the task's rubric, and writes result files and a report (issue #3180). Two questions drive it: what difference skills make, and what difference models make.

- **One task format**, shared with browser-use's BU Bench V2: an envelope `{ benchmark, tasks[] }`, and per task `{ id, task, rubric, weights }` with weights summing to 100. Public sets and our own skill evals use it. SLICC-only needs ride in an optional `slicc` object (`website`, `skills`, `files`, `timeoutSeconds`, `requires`) that upstream runners ignore.
- **Public sets by reference.** `bu-v1` and `bu-v2` come from browser-use/benchmark at the commit pinned in `scripts/upstream.mjs`, decrypted in memory. That repo has no licence and asks that the task text never be published, so nothing from it is committed, and traces holding its task text are Fernet-encrypted with the set's own key before they leave the runner.
- **Judge**: upstream's findings method. The judge reports met / violated / not_assessable per rubric item with evidence; code scores from the weights. The system prompt and truncation caps are read from upstream's `findings_judge.py` at the pinned commit. It runs over Bedrock Converse with forced tool use, default `global.openai.gpt-5.6-luna` (a non-Claude judge, as #3180 prefers).

**Not an npm workspace**, like `packages/github-workflow/`: `scripts/` is dependency-free (Node built-ins; it imports `github-workflow/scripts/gh-io.mjs` for the dial-retry rule). Tests run under the `bench` vitest project.

## Layout

| Path                        | Purpose                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `scripts/format.mjs`        | Task format: validation, `outcome()` (pass / partial / fail), BU V1 and skill-creator converters    |
| `scripts/upstream.mjs`      | Pinned upstream: Fernet decrypt/encrypt, set loading, judge-spec extraction                         |
| `scripts/judge.mjs`         | Findings judge over Converse: request, validation, `score()`, text-only retry                       |
| `scripts/slicc-adapter.mjs` | Prompt, skills staging, `runTask`, result.json → trace                                              |
| `leader/run-task.jsh`       | Runs on the leader: one `agent` scoop per task, screenshots while it works, cost, transcript, files |
| `scripts/executors.mjs`     | Leader access: Go CLI + join URL (CI) or CDP to a local dev harness                                 |
| `scripts/results.mjs`       | Records → browser-use-style result files, paired skill/model deltas, markdown report                |
| `scripts/run.mjs`           | CLI: plan, run, judge, resume, write `records/`, `traces/`, `results/`, `report.md`                 |
| `tasks/smoke.json`          | Two short live tasks in the shared format; the PR smoke run uses the first                          |

## How a run works

1. `run.mjs` copies `leader/run-task.jsh` to `/tmp/bench/` and stages `/workspace/skills` for the skills condition. Scoops read that directory through the shared filesystem, so `--read-only` cannot hide skills. The leader's own skills are stashed once in `/workspace/.bench-skills-builtin` and restored at the end. Conditions: `none`, `builtin`, and either joined with `+` to extra sets under `/workspace/bench-skills/<name>/`.
2. Each task runs as a fresh `agent --model <m> --persist-session` scoop, not in the cone's chat, so no task sees another's context and one leader serves every model. The prompt is the task text plus upstream's closing instruction (a `FINAL ANSWER:` line, no clarifying questions); how to drive the browser is left to SLICC and the installed skills, because that is what the skills axis measures.
3. `run-task.jsh` captures screenshots while the agent works (a tab whose address changed, or every 15 s), because agents close their tabs when done. Cost is the scoops' delta in `cost --json`, never the cone's.
4. Runs are ordered skills → repeat → task → model, so both models meet the live web at about the same moment.
5. Records store the task, rubric and weights digests and the judge model, and `resumeAction()` decides each run on resume:
   - `done`: nothing changed.
   - `rejudge`: another judge, a changed rubric or weights, or a failed judge call. The saved trace is re-judged; the agent does not run again.
   - `run`: the agent failed, or the task text changed.

   An errored run is reported, never counted as a fail: #3180's matrix is sparse. The invocation still exits 1, so a CI job does not go green on runs that never happened. Scores and outcomes use only judged runs; time and cost use every finished run. Summaries name the judge from the records, never from the command line.

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml
```

Live check against a local dev harness (`packages/dev-tools/tools/dev-standalone-fresh.sh`; the CDP port is in its log):

```bash
AWS_BEARER_TOKEN_BEDROCK=… node packages/bench/scripts/run.mjs --set packages/bench/tasks/smoke.json \
  --executor cdp --cdp http://127.0.0.1:<cdp-port> --ui localhost:<ui-port> --out /tmp/bench-out
```

## Design Rules

- **Never commit or print upstream task text.** Load it with `loadUpstreamSet`, keep it in memory, and encrypt traces with `encryptJson`. `records/` and `results/` hold ids, scores and metrics only.
- **The judge never scores.** Weights stay out of its prompt; `score()` is upstream's arithmetic (met weight / total, worst-wins duplicates, canary leak or suspected reward hacking zeroes the run).
- **Executors never throw on a non-zero status**; callers decide. Dial failures retry, executions never do.
- **Pure vs I/O split**, as in github-workflow: decisions live in exported functions with injected `exec`, `fetchImpl`, `judge`, `loadUpstream`.

## Related

- [`README.md`](./README.md) — usage, task format, adding skill evals
- `packages/github-workflow/CLAUDE.md` — the leader and CLI this runs on
- `.github/workflows/bench.yml` — dispatch runs and the PR smoke run
