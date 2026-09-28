# CLAUDE.md

Benchmark runner. Developer/architecture map; usage, task format, report guide: [`README.md`](./README.md).

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges each run against the task's rubric, writes result files and a report. Two questions: what skills change, what models change.

- **One task format**, shared with browser-use's BU Bench V2: `{ benchmark, tasks[] }`, per task `{ id, task, rubric, weights }` (weights sum to 100). Optional `slicc` object (`website`, `skills`, `files`, `timeoutSeconds`, `requires`) for SLICC-only needs. Schema: [`README.md`](./README.md).
- **Public sets by reference.** `bu-v1`/`bu-v2` from browser-use/benchmark at the pin in `scripts/upstream.mjs` (`bu-v2` = BU Bench V2.1, 200 tasks), decrypted in memory. Records carry `upstream` (tag, commit, file sha256). **No licence; task text must never be published** — not committed; traces holding it are Fernet-encrypted before leaving the runner.
- **Judge**: upstream findings (met / violated / not_assessable + evidence); `score()` from weights. Bedrock Converse, forced tool use, default `global.openai.gpt-5.6-luna`; up to `JUDGE_ATTEMPTS` (3) repair turns, then fallback (`--judge-fallback-model`, default `global.openai.gpt-5.6-sol`; `none` off). [Internals](../../docs/bench-runner.md#judge).

**Not an npm workspace** (like `packages/github-workflow/`): `scripts/` is dependency-free (Node built-ins + `github-workflow/scripts/gh-io.mjs`). Tests: `bench` project.

## Layout

| Path                         | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `scripts/format.mjs`         | Task format: validation, `outcome()` (pass/partial/fail), BU V1 + skill-creator converters  |
| `scripts/upstream.mjs`       | Pinned upstream: Fernet decrypt/encrypt, set loading, judge-spec extraction                 |
| `scripts/judge.mjs`          | Findings judge over Converse: request, validation, `score()`, text-only retry               |
| `scripts/slicc-adapter.mjs`  | Prompt, skills staging, `runTask` (setup → prompt → capture → teardown), transcript → trace |
| `scripts/lifecycle.mjs`      | Restart the CI leader via start/stop-leader scripts; diagnostic journal; redaction          |
| `scripts/executors.mjs`      | Leader access: Go `slicc` CLI against a join URL, dial retries, prompt interrupt            |
| `scripts/results.mjs`        | Records → result files, paired skill/model deltas, markdown report                          |
| `scripts/charts.mjs`         | report.html charts: ranking, score vs. cost (quadrant, Pareto), tool use                    |
| `scripts/backfill-tools.mjs` | Add tool-use metrics to records from traces                                                 |
| `scripts/html.mjs`           | Records → self-contained `report.html`: cards, table, deltas, matrix, time × cost           |
| `scripts/merge.mjs`          | Merge shards' out dirs: records (judged wins), traces, journals, report                     |
| `scripts/publish.mjs`        | Stage a run for HF `ai-ecoverse/slicc-bench`: encrypted traces/sets, combined report        |
| `dataset/README.md`          | Dataset card template; `publish.mjs` fills `<!-- report -->`                                |
| `scripts/run.mjs`            | CLI: plan, run, judge, resume; writes `records/`, `traces/`, `results/`, `report.md`        |
| `tasks/smoke.json`           | Two short live tasks; PR smoke run uses the first                                           |

## How a run works

Everything is driven from outside through the Go `slicc` CLI against the leader's join URL; nothing bench-specific runs on the leader. A task mimics a person: new chat, pick a model, type.

1. `run.mjs` stages `/workspace/skills` for the condition with `slicc exec`; builtin skills stash in `/workspace/.bench-skills-builtin`. Conditions: `none`, `builtin`, or either `+` extras under `/workspace/bench-skills/<name>/`. **`none` means no bundled skills** via `flags set no-default-skills` — [details](../../docs/bench-runner.md#none-skills-condition).
2. Per task, `runTask` stages files, closes tabs, runs `slicc new-session --erase` (drops conversation **and** memories), `slicc model <alias>`, and for `alias@level` `slicc thinking <level>` (`config.thinking` = request, `config.thinking_effective` = what the prompt runs; a mismatch is a run error), then `slicc prompt --allsettled 2m -` (waits until no scoop is processing, no tool is pending, and nothing happened for 2 min; [details](../../docs/slicc-cli-details.md#prompt---allsettled)) with the task plus upstream's closing instruction (`FINAL ANSWER:`). Skills check after `new-session`. Timeout → SIGINT; CLI exits 130 only after `abort_ack` (exit 1 if no confirm in 12s; SIGKILL at 20s). [Interrupt](../../docs/bench-runner.md#interrupt-and-spend).
3. While the cone works: poll `playwright-cli tab-list`, screenshot on tab change (or every 15 s). Spend = `cost --json --all` delta (authoritative vs `session export`). Judge trajectory from `session export` (chunked past 8 MiB — [transcript collection](../../docs/bench-runner.md#transcript-collection)). After interrupt, read spend until flat or 3 min; giving up → `leader_down` + lane restart. Order: skills → repeat → task → model.
4. `resumeAction()` from stored digests/judge — `done`; `rejudge` (changed judge/rubric/weights); `run` (agent failed, task text changed, or `config.default_skills` missing/mismatched — pre-flag `none` artifacts). Errored runs are reported, never fails, but exit 1 so CI can't green on missing runs. Scores: judged only; time/cost: every finished run.

## Leader lifecycle and diagnostics

Leaders can stop accepting `slicc` connections (`tray connect timed out`) with Chrome still up. Mechanics: [`docs/bench-runner.md`](../../docs/bench-runner.md#leader-lifecycle-and-diagnostics). Load-bearing rules:

- **Leader-down is an error, never a fail.** Dial retries use `SLICC_DEBUG=1`; never-dialed → `leaderDown`. `--fresh-leader-every N` (CI: `BENCH_LEADER_SCRIPTS`) restarts; unreachable → restart once + retry; `--leader-down-limit` consecutive stops the job for a resume.
- **Task isolation needs a fresh profile.** `new-session --erase` resets only the cone conversation; scoops in Chrome's profile (`<home>/profile`) carry over unless wiped. Recycler wipes between stop/start; `bench.yml` defaults `fresh-leader-every: 1`.
- **A prompt returning while the agent still works waits again.** On `slicc prompt` exit 0 with empty answer, `runTask` reads spend twice `BUSY_PROBE_MS` (20 s) apart. Rising spend, export timing out, or a successful export whose final cone message was absent from prompt stdout invokes passive `slicc wait --allsettled 2m` within the task's remaining timeout. It then exports the final transcript and scores the cone's last assistant text, marking `metrics.resumed_after_settle`. If the agent never settles or its final transcript cannot be collected, the run remains an unscored error.
- **Lanes** (`--leaders N`): one home/port/`<home>/join.json` per leader, shared queue; still share `/slicc/cone-config.json` (locked boots). Published node-server still shares `/tmp/slicc-join.json`.
- **Harness drift** is recorded, not prevented: hosted leaders load the webapp from production; `leader.slicc_version` / `slicc_versions` flag a mix; `pin-webapp` overrides.
- **Guardrails** (`guardrails()`): no new run past deadline or `--max-cost`; `watchSpend` aborts past `--max-task-cost`. Cost null on failed/backward counters (`cost_unknown`). Journal redacts join tokens; no task text.

## Publishing

`report.md`, `report.json` and `report.html` are written every run (from `reportData()`). `bench.yml` shards upload out dirs, the `Report` job merges them (`merge.mjs`), and a dispatch run publishes to [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench) via `publish.mjs`. Artifacts and pin-rollover: [`README.md`](./README.md), [`docs/bench-runner.md`](../../docs/bench-runner.md#publishing-pipeline).

**Safety-critical:** encryption is browser-use's — a `.enc` file is base64 of a Fernet token keyed by `sha256(<benchmark>)`; our own sets → `tasks/<benchmark>.enc`, traces → `runs/<run>/traces/…`. **Upstream sets publish scores only** (no traces; rubric ids reduced to status counts). Published records never carry `metrics.tabs` (tabs can name the site or query).

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml .github/workflows/bench-reaper.yml
```

Live check against a local dev harness (build the CLI from this checkout for `new-session`/`model`/`thinking`; run `run.mjs` with `SLICC_CLI`, `SLICC_JOIN_URL`, `AWS_BEARER_TOKEN_BEDROCK`): [`README.md`](./README.md#run-it-locally).

## Design Rules

- **Never commit or print upstream task text.** Load with `loadUpstreamSet`, keep in memory, encrypt traces with `encryptJson`. `records/`/`results/` hold ids, scores and metrics only.
- **The judge never scores.** Weights stay out of its prompt; `score()` is upstream's arithmetic (met weight / total, worst-wins duplicates; a canary leak or suspected reward hacking zeroes it).
- **Executors never throw on a non-zero status** (callers decide; dials retry, executions don't). **Drive the leader only through its public surface** — CLI verbs and shell a person could type. **Pure vs I/O split**: decisions live in exported functions with injected `leader`, `fetchImpl`, `judge`, `loadUpstream`, `now`.

## Related

- [`README.md`](./README.md) — usage, inputs, task format, report guide, adding skill evals
- [`docs/bench-runner.md`](../../docs/bench-runner.md) — judge, none-skills, interrupt/spend, transcript, lifecycle, publishing
- `packages/github-workflow/CLAUDE.md` — the leader and CLI this runs on
- `.github/workflows/bench.yml` (plan → shard matrix → report, + PR smoke) · `.github/workflows/bench-reaper.yml` (cancels stuck runs)
