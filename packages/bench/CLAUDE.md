# CLAUDE.md

This file covers the benchmark runner in `packages/bench/`.

## Scope

Runs task sets on a SLICC leader across **models** and **skills**, judges every run against the task's rubric, and writes result files and a report (issue #3180). Two questions drive it: what difference skills make, and what difference models make.

- **One task format**, shared with browser-use's BU Bench V2: an envelope `{ benchmark, tasks[] }`, and per task `{ id, task, rubric, weights }` with weights summing to 100. Public sets and our own skill evals use it. SLICC-only needs ride in an optional `slicc` object (`website`, `skills`, `files`, `timeoutSeconds`, `requires`) that upstream runners ignore.
- **Public sets by reference.** `bu-v1` and `bu-v2` come from browser-use/benchmark at the release pinned in `scripts/upstream.mjs` (v2.1.1; `bu-v2` is BU Bench V2.1, 200 tasks), decrypted in memory. Records carry `upstream` (tag, commit, file sha256). Upstream's per-task `task_sha`/`rubric_sha` are not kept in step with the text (V2.1 revised 139 task texts and stores short rubric digests), so upstream sets skip the supplied-digest check; the file checksum is their integrity check. That repo has no licence and asks that the task text never be published, so nothing from it is committed, and traces holding its task text are Fernet-encrypted with the set's own key before they leave the runner.
- **Judge**: upstream's findings method. The judge reports met / violated / not_assessable per rubric item with evidence; code scores from the weights. The system prompt and truncation caps are read from upstream's `findings_judge.py` at the pinned commit (V2.1 has no task or rubric cap). Since V2.1 every `not_assessable` finding carries `not_assessable_reason` (`missing_evidence` or `absent_scope`), and `met`/`violated` carry null; the trace never passes the agent's reasoning to the judge, as V2.1 requires. It runs over Bedrock Converse with forced tool use, default `global.openai.gpt-5.6-luna` (a non-Claude judge, as #3180 prefers).

**Not an npm workspace**, like `packages/github-workflow/`: `scripts/` is dependency-free (Node built-ins; it imports `github-workflow/scripts/gh-io.mjs` for the dial-retry rule). Tests run under the `bench` vitest project.

## Layout

| Path                         | Purpose                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/format.mjs`         | Task format: validation, `outcome()` (pass / partial / fail), BU V1 and skill-creator converters                    |
| `scripts/upstream.mjs`       | Pinned upstream: Fernet decrypt/encrypt, set loading, judge-spec extraction                                         |
| `scripts/judge.mjs`          | Findings judge over Converse: request, validation, `score()`, text-only retry                                       |
| `scripts/slicc-adapter.mjs`  | Prompt, skills staging, `runTask` (setup, prompt, capture, teardown), transcript → trace                            |
| `scripts/lifecycle.mjs`      | Restart the CI leader with the start/stop-leader scripts; the diagnostic journal; redaction                         |
| `scripts/executors.mjs`      | Leader access: the Go `slicc` CLI against a join URL, with dial retries and prompt interrupt                        |
| `scripts/results.mjs`        | Records → browser-use-style result files, paired skill/model deltas, markdown report                                |
| `scripts/charts.mjs`         | report.html's charts: ranking, score vs. cost per task (quadrant, Pareto line), tool use                            |
| `scripts/backfill-tools.mjs` | Add tool-use metrics to records from saved traces (runs recorded before they existed)                               |
| `scripts/html.mjs`           | Records → one self-contained `report.html`: cards, table, deltas, task matrix, time × cost                          |
| `scripts/merge.mjs`          | Merge the shards' out dirs into one: records (the judged copy wins), traces, journals under `shards/`, report       |
| `scripts/publish.mjs`        | Stage a run for the Hugging Face dataset `ai-ecoverse/slicc-bench`: encrypted traces and task sets, combined report |
| `dataset/README.md`          | The dataset card template; `publish.mjs` puts the combined report in place of `<!-- report -->`                     |
| `scripts/run.mjs`            | CLI: plan, run, judge, resume, write `records/`, `traces/`, `results/`, `report.md`                                 |
| `tasks/smoke.json`           | Two short live tasks in the shared format; the PR smoke run uses the first                                          |

## How a run works

Everything is driven from outside, through the Go `slicc` CLI against the leader's join URL; nothing bench-specific runs on the leader. A task is what a person would do: open a fresh chat, pick a model, type the task into the cone.

1. `run.mjs` stages `/workspace/skills` for the skills condition with `slicc exec`. The cone and any scoop it spawns read that directory. The leader's own skills are stashed once in `/workspace/.bench-skills-builtin` and restored at the end. Conditions: `none`, `builtin`, and either joined with `+` to extra sets under `/workspace/bench-skills/<name>/`.
2. Per task, `runTask` puts the task's files in the VFS, closes open tabs, then runs `slicc new-session --erase` and `slicc model <m>`. `--erase` also drops the cone's memories, so no task sees what an earlier one learned. `model` resolves the alias against the leader's catalogue and prints the provider-qualified id, recorded as `model_id`. Then `slicc prompt -` sends the task text plus upstream's closing instruction (a `FINAL ANSWER:` line, no clarifying questions). How to drive the browser is left to SLICC and the installed skills, because that is what the skills axis measures. On timeout the runner sends the CLI SIGINT, which aborts the cone.
3. While the cone works, the runner polls `playwright-cli tab-list` and screenshots a tab whose address changed, or every 15 s, because agents close their tabs when done. Cost, tokens and turns are the delta of `cost --json --all` across the prompt: the cone plus every scoop it spawned, dropped ones included. The judge's trajectory comes from `session export`; its per-message model ids fill `modelsUsed`, which shows when scoops ran on another model.
   - **Never `cat` a large file over one `exec`.** The leader sends an exec's whole stdout as one tray message, and a message over 8 MiB (about 6.3 MB of output once base64-encoded) is dropped without an error. The CLI then exits 0 with empty stdout. So `exportTranscript` exports, unzips and `split`s transcript.json on the leader in one call (10 min timeout, retried once unless it timed out). It then reads the parts back with `base64`, 3 MiB at a time. Each part is checked against the `sha256sum` listing and read again, up to 3 times, when it arrives short, corrupted or not at all. The whole file is checked too. All of it shares `TRANSCRIPT_BUDGET_MS` (15 min): each call gets at most what is left, and a run out of time is recorded without a transcript (`stage: 'budget'`). Before this, one run spent 113 minutes collecting.
   - The outcome (`ok`, `bytes`, `parts`, `exports`, `reads`, `ms`, and on failure `stage` and `reason`) goes into the task event as `transcript` and into the record as `metrics.transcript`; only the event keeps the leader's stderr tail (`detail`). A run without a transcript says why in its log line and its judge trace.
4. Runs are ordered skills → repeat → task → model, so both models meet the live web at about the same moment.
5. Records store the task, rubric and weights digests and the judge model, and `resumeAction()` decides each run on resume:
   - `done`: nothing changed.
   - `rejudge`: another judge, a changed rubric or weights, or a failed judge call. The saved trace is re-judged; the agent does not run again.
   - `run`: the agent failed, or the task text changed.

   An errored run is reported, never counted as a fail: #3180's matrix is sparse. The invocation still exits 1, so a CI job does not go green on runs that never happened. Scores and outcomes use only judged runs; time and cost use every finished run. Summaries name the judge from the records, never from the command line.

## Leader lifecycle and diagnostics

The first BU V1 dispatch lost 4 of 5 leaders about 70 minutes into their jobs. Each lost leader stopped accepting `slicc` connections (`tray connect timed out`), while its Chrome kept running. The cause is not known yet, so the runner defends against it and records what the next occurrence needs:

- Every call has a timeout (`DEFAULT_CALL_TIMEOUT_MS`), dial retries run with `SLICC_DEBUG=1`, and a result that never dialed carries `leaderDown`. `runTask` throws such runs; they are errors, never fails.
- `--fresh-leader-every N` (CI: `BENCH_LEADER_SCRIPTS`) restarts the leader every N tasks with the github-workflow scripts; an unreachable leader is restarted once and the run retried (also when it fails while skills are staged, and when a call's connection closes mid-call: `io: read/write on closed pipe` or `connection closed`, seen on 6.190.0 and on 6.191.0 with #3479). A run whose transcript was lost to an unreachable leader is retried the same way, never judged from its final answer alone; `--leader-down-limit` consecutive leader-down runs stop the job for a resume. Skills are staged again on every new leader.
- **Task isolation needs a fresh profile.** The webapp keeps its VFS, sessions and scoops in Chrome's profile, which start-leader reuses (`<home>/profile`), and `new-session --erase` resets only the cone's conversation. In the first full BU V1 run, GPT-5.6 Sol's scoops carried over from task to task and across restarts: they kept working, billed later tasks (7.7M tokens in a 92 s run), filled the judge's transcript with other tasks' work, and wedged the leader (`terminal-open timed out`). The recycler therefore wipes the old profile between stop and start, and `bench.yml` restarts before every task by default (`fresh-leader-every: 1`, about 15–40 s each). A terminal-open timeout counts as the leader being down.
- Journal in the out dir: `calls.jsonl`, `events.jsonl` (per task: phases, leader generation and age, `uptime`/`meminfo`/`ps` before and after), `diagnostics/`; with `BENCH_LEADER_LOG`, events are also marked in the leader's log, and `bench.yml` keeps its infrastructure lines as `leader-infra.log`. All redacted of join tokens; none holds task text.
- **Lanes** (`--leaders N`, `bootLane` in lifecycle.mjs): one home and port per leader, one shared queue. Every leader writes the same `/slicc/cone-config.json` (stop-leader deletes it) and node-server posts its join URL to the fixed `/tmp/slicc-join.json`, so boots, restarts and stops share one lock (`createLock`), and `claims` rejects a join URL another lane holds. A lane stops after `--leader-down-limit`; the others go on.
- **Guardrails** (`guardrails()` in run.mjs): no new run once `now + effectiveTimeout + RUN_OVERHEAD_MS` passes the deadline (effective timeout is the next task's `slicc.timeoutSeconds`, else `--timeout`), none once the invocation has spent `--max-cost`; `watchSpend` polls `cost --json --all` every 30 s and aborts a prompt past `--max-task-cost` (the record carries `metrics.cost_capped`). The wave-1 jobs of 2026-09-25 ran into the 355-minute job limit mid-run and lost their publish step; bench.yml now gives the run step a limit below the job's, and bench-reaper.yml cancels stale runs.
- Cost is null when a `cost` reading fails or the counters went backwards; means, totals and pairs skip unknown values, and result files count them (`cost_unknown`).

## Publishing

`report.md`, `report.json` and `report.html` are written with every run; `reportData()` is the source of all three. In `bench.yml`, each shard (a matrix job on a GCP self-hosted runner, `--shard K/N`) uploads its out dir as `bench-<run>-shard-<k>`; the `Report` job merges them with `merge.mjs`, uploads the report with `results/` as `bench-report-<run>` and everything as `bench-<run>`. A dispatch run then publishes to [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench) with the repo's `HF_TOKEN` secret. It downloads the dataset's `records/`, stages this run over them with `publish.mjs`, and sends one `hf upload` commit.

- The encryption is browser-use's: a `.enc` file is the base64 of a Fernet token whose key is `sha256(<benchmark>)`.
- Our own task sets go to `tasks/<benchmark>.enc`, and their traces to `runs/<run>/traces/…`, encrypted.
- Upstream sets publish scores only: no traces, and their rubric item ids reduced to status counts.
- Published records never carry `metrics.tabs`, because open tabs can name the site or the search.
- Advancing the upstream pin (`UPSTREAM` in `upstream.mjs`) drops the previous pin's records for that benchmark from the staged `records/` tree so a partial shard does not mix revised tasks with old scores in the combined report. `bench.yml` uploads with `--delete 'records/**'` so the Hub matches.

## Build and Test

```bash
npx vitest run --project bench
npm run test:coverage:bench
actionlint .github/workflows/bench.yml .github/workflows/bench-reaper.yml
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
- `.github/workflows/bench.yml` — dispatch runs (plan → shard matrix → report) and the PR smoke run
- `.github/workflows/bench-reaper.yml` — cancels benchmark runs stuck waiting for a runner or past any job limit
