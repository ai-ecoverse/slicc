# SLICC benchmark runner

Measures what skills and models change in SLICC. It runs task sets on a SLICC leader, has a judge grade each run against the task's rubric, and reports pass / partial / fail with time and cost for every model × skills configuration.

## Run it in GitHub Actions

**Actions → Benchmark → Run workflow**. The inputs:

| Input                  | Default                           | Meaning                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sets`                 | `packages/bench/tasks/smoke.json` | `bu-v1`, `bu-v2`, or task-set JSON paths, space-separated                                                                                                                                                                                                                                                                             |
| `models`               | `claude-sonnet-5,claude-opus-5-5` | Models for the agent under test. A spec may be `alias@level` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `default`). A plain alias is `@default` and does not change the leader's thinking level. Each spec is its own configuration (`config.model`, `config.thinking`, `config.thinking_effective`).                |
| `skills`               | `builtin,none`                    | `none` (no bundled skills, via `no-default-skills`), `builtin`, `builtin+ecoverse` (the leader's skills plus ai-ecoverse/skills). A production webapp without `flags` still runs `builtin` and refuses `none` until `pin-webapp` or a release. `none` runs from before that flag still had the bundled library and are not comparable |
| `repeats`              | `1`                               | Runs per task and configuration                                                                                                                                                                                                                                                                                                       |
| `tasks`                | all                               | Task ids, comma-separated; `@name` adds a named subset from `tasks/subsets/` (for example `@bu-v2-explore-20`, see [Quick explorations](#quick-explorations))                                                                                                                                                                         |
| `limit`                | all                               | First N tasks of each set                                                                                                                                                                                                                                                                                                             |
| `timeout`              | `900`                             | Seconds one agent run may take (BU Bench V2.1: `3600`)                                                                                                                                                                                                                                                                                |
| `judge-model`          | `global.openai.gpt-5.6-luna`      | Bedrock model that judges                                                                                                                                                                                                                                                                                                             |
| `judge-fallback-model` | `global.openai.gpt-5.6-sol`       | Bedrock model that judges a run whose judgement is still invalid after the first judge's repairs; `none`: no fallback                                                                                                                                                                                                                 |
| `shards`               | `3`                               | Matrix jobs (1–20); shard K of N takes every Nth task, with all its models, skills and repeats                                                                                                                                                                                                                                        |
| `max-parallel`         | `3`                               | Shards running at once                                                                                                                                                                                                                                                                                                                |
| `leaders`              | `4`                               | Leaders per shard, side by side (1–8), sharing the shard's queue                                                                                                                                                                                                                                                                      |
| `runner`               | `cloud-run-bench`                 | Runner label the shards run on: `cloud-run-bench` (Cloud Run pool) or `gcp-bench-8core` (old GCE pool)                                                                                                                                                                                                                                |
| `resume-run`           | none                              | Continue an earlier run (its id): each shard starts from that run's shard artifact; use the same inputs                                                                                                                                                                                                                               |
| `deadline-minutes`     | `300`                             | Minutes a shard takes new runs for, at most 420; its job limit is this plus 45                                                                                                                                                                                                                                                        |
| `max-task-cost`        | `5`                               | Dollars one run may spend before it is stopped (`0`: no cap)                                                                                                                                                                                                                                                                          |
| `max-cost`             | `150`                             | Dollars one shard may spend before it stops taking runs (`0`: no cap)                                                                                                                                                                                                                                                                 |
| `fresh-leader-every`   | `1`                               | Restart a leader, with a wiped profile, every N tasks; `1` isolates every task, `0` never restarts                                                                                                                                                                                                                                    |
| `new-session`          | `erase`                           | `slicc new-session` action between tasks: `erase` (wipe memories), `save` (extract memories then fresh chat), `skip` (fresh chat without extracting). Memory accumulation needs `save` with `fresh-leader-every: 0`, `shards: 1`, `leaders: 1`                                                                                        |
| `pin-webapp`           | empty                             | Empty loads production. `true` serves the pinned npm webapp. A commit, tag, or branch builds that revision like the local node harness                                                                                                                                                                                                |
| `arm`                  | empty                             | Run each task through an arm from `arms/arms.json` (e.g. `intent-budget`) instead of prompting the cone. Its skills come from `skills-ref`, staged as the `arm` set: use `skills` `builtin+arm`. For the intent arms, use `runner` `cloud-run-gpu` and `leaders` `1` (kev-4b-vision needs about 20 GB of a 32 GiB machine)            |
| `publish`              | on                                | Publish to the Hugging Face dataset ai-ecoverse/slicc-bench                                                                                                                                                                                                                                                                           |

An always-on adaptive model reports `thinking_effective=adaptive` for `@default`: Bedrock Opus 5.5 still thinks when the request omits thinking fields, so that read is not `off`.

**Where it runs.** The shards run on `cloud-run-bench` (since 2026-10-01): a Cloud Run worker pool of ephemeral just-in-time runners, one per job, with 8 vCPU / 32 GiB, CPU always allocated, up to 30 machines and its own runner group limited to this repo. Its image (`runner-bench`, on the official runner image, Ubuntu 24.04) brings Chrome with Liberation, Noto CJK and emoji fonts, Node, Go, coreutils and an npm cache warmed from the lockfile, so the Chrome install and `/slicc` setup steps skip themselves and a pinned build takes under a minute. `plan` and `report` take seconds to minutes and run GitHub-hosted. Each leader is a Chrome plus a node-server, about 2 vCPU, so a shard runs 4. For BU Bench V2.1 (200 tasks, up to an hour each), plan `shards` × `leaders` × `deadline-minutes` / 80 ≥ runs (a run's hour plus 20 minutes of overhead). Cloud Run sets no time limit on a machine but may restart one for maintenance. The shard's artifact is uploaded only when the job ends, so a restart loses that shard's unsaved runs, and "Re-run failed jobs" runs them again (it resumes only from an earlier attempt's artifact). `deadline-minutes` stays at most 420, which keeps that loss bounded. The old GCE pool (`gcp-bench-8core`: VMs in `ai-ecoverse-493315` from [Cyclenerd/google-cloud-github-runner](https://github.com/Cyclenerd/google-cloud-github-runner), deleted after 8 hours) is retired; `runner` can still name it.

**Guardrails.** A shard stops taking runs once the next might not finish before its deadline (the run's `timeout` plus 20 minutes for the restart, collection and judge; collecting the transcript has 15 of them). It stops a run that has spent `max-task-cost` (the record says `cost_capped`, and the judge is told), including spend during post-prompt recovery, and stops taking runs at `max-cost`. If recovery reaches a task limit, the runner confirms an abort, waits for flat spend, then exports and judges the latest cone answer as a capped run. The run step's time limit sits 20 minutes past the deadline, below the job's, so the diagnostics and the upload always run. **Re-run failed jobs** resumes a shard from its artifact. `bench-reaper.yml` runs every 30 minutes. When a run's jobs have waited over an hour for a runner while none of its jobs run (a zone out of capacity, a full quota, a dropped webhook), it force-cancels the run and re-runs its failed jobs, up to twice, then only cancels. It force-cancels a run with a job running for over 9 hours.

The `Report` job merges the shards (`scripts/merge.mjs`) and shows the report in its summary. Artifacts:

- `bench-report-<run id>`: `report.md`, `report.json` (the same report as data), `report.html` (cards, a task × configuration matrix, time against cost), and `results/`, one file per configuration in browser-use's result format plus rubric scores.
- `bench-<run id>`: all of that, plus `records/` (one file per run), `traces/` (transcripts and screenshots, encrypted for upstream sets) and `shards/<name>/`, each shard's journal.
- `bench-<run id>-shard-<k>`: each shard's own out dir, as it left it.

With `publish` on (the default), the run is also published to the Hugging Face dataset [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench). The dataset card carries the combined report across every configuration published so far. SLICC's own task sets and traces are Fernet-encrypted there as browser-use encrypts theirs. For browser-use's own sets, only scores are published.

A pull request that touches the runner runs the smoke task twice on both models, on two leaders in one shard (`vars.BENCH_PR_RUNNER`, default `cloud-run-bench`).

## Run it locally

The runner drives any leader from outside with the Go `slicc` CLI: it needs the leader's join URL (run `host` in a SLICC terminal) and a CLI with the `new-session`, `model`, and `thinking` verbs, built from this checkout until a release ships them:

```bash
(cd packages/slicc-cli && go build -o /tmp/slicc-dev .)
SLICC_CLI=/tmp/slicc-dev SLICC_JOIN_URL=… AWS_BEARER_TOKEN_BEDROCK=… \
  node packages/bench/scripts/run.mjs --set packages/bench/tasks/smoke.json --skills builtin,none --out bench-out
```

Each task starts a fresh chat (`new-session`, default `--erase` so memories do not carry), selects the model, reads or sets the thinking level, and sends the task to the cone, as a person would. `--new-session save` extracts memories before clearing the chat so a curator can accumulate across tasks on one leader (`fresh-leader-every: 0`, one shard, one leader). After each `--save`, the runner seeds a widened `/etc/MEMORY.md` (curator `visiblePaths` include `/tmp/` and `/etc/`, restored after the run), then polls `/workspace/CLAUDE.md` and `/sessions/index.json` until memory lands — or is retained from a prior plant when a short follow-up skips freeze — so the next prompt cannot start on an empty store. Prove the chain with `packages/bench/tasks/memory-smoke.json` (plant → retrieve). A plain alias only reads the level (`slicc thinking` with no argument). `alias@level` sets it and waits for the leader to confirm. On a fresh leader (`fresh-leader-every: 1`) the read is `unset`, which the agent treats as off.

**Opus 5.5 on Bedrock `bedrock-camp` (probed 2026-09-27, `global.anthropic.claude-opus-5-5`).** Thinking cannot be turned off. `thinking.type.disabled` and `thinking.type.enabled` both 400 ("use thinking.type.adaptive and output_config.effort"). Effort `minimal` 400s. `low`, `medium`, `high`, `xhigh`, and `max` are accepted. Omitting the thinking fields (what this webapp sends for level `off`, and for a cone whose level was never set) is accepted and still thinks: on a riddle prompt it returned a reasoning block and 228 output tokens, between `low` (99 tokens, no reasoning block) and `high` (283). `max` thought the most (928 tokens). The lowest effort that works is `low`, not `off`. The composer `max` is `thinking` level `xhigh` plus effort override `max`. This branch's webapp sends that override as `output_config.effort: max`, and `model.state` reports the level the next prompt will run (`resolvedThinkingLevel`). `slicc thinking` exits 1 when that resolved level is not the one requested, and the runner records the failure as a run error instead of scoring the request under the wrong name. A production webapp from before this change does not send the resolved fields, so a variant smoke has to set `pin-webapp` to this revision. `@off` and `@default` on a fresh leader both resolve to `off` and send the same request. The lowest effort that changes the request is `@low`. Time and cost cover the cone and every scoop it spawns. `--plan` prints the runs without starting any. A second invocation with the same `--out` resumes, run by run:

- **Kept:** runs whose task, rubric, weights and judge are unchanged.
- **Re-judged from the saved trace, without running the agent again:** runs whose judgement no longer stands. That means another `--judge-model`, a changed rubric or weights, or a judge call that failed.
- **Run again:** runs that errored, and runs whose task text changed.

For BU Bench V2.1 Stage 2, dispatch `bench.yml` **after this fix reaches `main`**
with `resume-run: 36397375699` and the same task set, models, skills, repeats,
and shard count. The workflow downloads each source shard artifact into its
`bench-out`; `resumeAction()` retains scored erase records (`done`) and selects
error records (`run`). Save/skip resumes replay done tasks unless
`BENCH_MEMORY_RESTORED=1` (the Chrome profile holding accumulated memories is
not in the artifact yet). A local replay of the first 14 shard artifacts found
38 error records selected as `run` and 480 scored records selected as `done`,
with no misclassifications. Those shards also had 42 planned runs with no
record yet; they are selected as `run` too. Leave the source run and its active
shards alone.
The [sanitized live frame timeline and resume audit](../../docs/bench-opus-max-recovery.md)
records the evidence behind this change.

**When the leader stops answering.** A run that cannot reach the leader is recorded with `leader_down`, never judged as a fail. In CI the runner then restarts the leader and retries the run once — with the Chrome profile kept when `--new-session` is `save` or `skip`, so the memory chain is not wiped. After `--leader-down-limit` (default 2) such runs in a row it stops, so a resume can pick up the rest. Every record notes which leader ran it (`leader.generation`, `leader.age_s`). A cost the leader could not report is recorded as unknown (null), never as a difference from zero. The out dir keeps a journal for diagnosing the leader:

- `events.jsonl`: each task with its phases and the leader's `uptime`, memory and process count before and after, plus restarts and stops.
- `calls.jsonl`: every leader call, with how long it took and how it ended.
- `diagnostics/`: the CLI's `SLICC_DEBUG` output from dials that failed.
- `leader-infra-slicc-gw-lane<i>.log` (CI): each leader's tray, signaling and WebRTC log lines, interleaved with `[bench-event]` markers from the runner.

**Several leaders.** `--leaders N` (up to 8) boots N leaders, each with its own home (`$SLICC_GW_HOME-lane<i>`), port (`BENCH_LEADER_BASE_PORT` + i, default 5710), and join file (`<home>/join.json`), and runs the queue on all of them. Boots, restarts and stops take turns, because every leader shares `/slicc/cone-config.json`. A published node-server still shares `/tmp/slicc-join.json`; a lane handed another lane's join URL is refused and retried. A lane that keeps failing to reach its leader stops, and the others carry on. `--shard K/N` runs only shard K's tasks. `--deadline-minutes`, `--max-task-cost` and `--max-cost` are the guardrails above.

The command exits 1 when any run ended in an error, so a CI job cannot pass on runs that never happened. The report is written either way. Result files and the report name the judge that actually produced each score, taken from the records.

## Quick explorations

For a first look at a new model or setting, run a frozen subset instead of all 200 BU Bench V2.1 tasks: `tasks: @bu-v2-explore-20`, or `@bu-v2-explore-40`, which contains the 20. The list stays the same from run to run, so a new configuration pairs task by task with every configuration already run on it. Start with 20; if the gap you care about is under about 0.05, extend to 40, and only the 20 new tasks run.

How the lists were picked (`tasks/subsets/*.json` records the method and the source runs):

- **Tasks with no signal are out:** 16 tasks where every configuration scored within 0.05 of the others, or where all of them failed.
- **Random within difficulty bands, not the "most discriminating" tasks:** the other tasks are split into four bands by mean score. explore-20 draws 5 per band at random from each band's cheaper half. explore-40 is those 20 followed by a second draw of 5 per band from what's left, 10 per band in all. `--tasks` runs tasks in the order listed, and order decides shards, so extending a resumed run from 20 to 40 keeps the first 20 on their shards and runs only the new 20. With one run per task, a task's apparent discrimination is mostly noise: the same configuration scores a task with test-retest r = 0.78, about 0.17 per run. Cross-validated on held-out configurations, top-discrimination subsets called clear differences (≥ 0.03) the wrong way round 7–9% of the time. Random subsets did so 1.6% of the time at 20 tasks and 0.1% at 40.
- **Cheaper:** the tasks average $0.80 per run, against $1.41 across all tasks.

The lists were derived from BU Bench V2.1 runs of Opus 5.5 (`@low`, default, `@max`), Sonnet 5.5 (default, `@low`) and GPT-6 Luna on 2026-09-29. They hold task ids only, never task text.

## The task format

It is browser-use's BU Bench V2 format, so public sets and our own evals share one schema:

```json
{
  "benchmark": "My_Skill_Evals",
  "tasks": [
    {
      "id": "my-001",
      "title": "…",
      "task": "What the user asks, verbatim.",
      "rubric": "# Rubric\n## Source facts (verified 2026-09-23)\n…\n## Items\nA1_answer — …\nA2_grounded — …",
      "weights": { "A1_answer": 70, "A2_grounded": 30 },
      "slicc": { "website": "https://…", "skills": ["my-skill"], "timeoutSeconds": 600 }
    }
  ]
}
```

- The rubric names every item in `weights`, and the weights sum to 100. Write items the judge can check from the transcript and screenshots. Date the source facts, because the live web drifts.
- The judge reports each item as met, violated or not assessable. The score is the weight of the met items. A score of 1 is a pass, above 0 is partial, 0 is a fail.
- `slicc` is optional and ignored by upstream runners. It can name the site, the skills a task is about, files to put in the VFS (`files: [{ from, to }]`, relative to the JSON file), a time limit, and required credentials.
- Anthropic skill-creator `evals.json` files load directly: each expectation becomes an equally weighted item.

`bu-v1` is BU Bench V1's 40 tasks that have a reference answer. Each becomes a two-item rubric: the answer, and evidence it was read from a page. `bu-v2` is BU Bench V2.1: 200 tasks with weighted findings rubrics, from upstream's `BU_Bench_V2.enc`, which holds V2.1 since release v2.1.1. Upstream gives each V2.1 task up to 60 minutes, so pass `--timeout 3600` and shard runs to fit a job's 6 hours. Both sets come from the browser-use/benchmark release pinned in `scripts/upstream.mjs` (v2.1.1). Records and result files carry `upstream`: the repo, tag, commit, file and the file's sha256, as upstream asks results to record. Their task text is never committed or published: upstream asks for that, and the repo has no licence.

## Reading the report

**Which SLICC ran.** Hosted leaders load SLICC's webapp from production, so a run tests whatever release is live when its leader boots. A release during a benchmark changes the harness partway through: the report lists the versions behind each benchmark and marks a mix. Each record's `leader.slicc_version` names its own; `config.harness` is only the `sliccy` package the job installed for node-server.

For each set, the report has a row per configuration: runs, pass / partial / fail, errors, mean score, mean time and mean cost. After the rows come two lists:

- **What skills add:** for each model, the lift each skills condition gives over `none` (over the first condition when `none` did not run), as percentages of the baseline: score, time and cost, with the absolute change beside each. `report.html` shows it as the paired mean score without and with the skills, the lift, and the time and cost it saves. A lift from fewer than 10 paired tasks is flagged as a small sample.
- **What models change:** the same paired comparison between models, for each skills condition, in four lists (`models.mjs`):
  - **against the older version** of the same family (`claude-sonnet-5` → `claude-sonnet-5-5`);
  - **against the sibling at the other provider**, by tier: haiku ↔ luna, sonnet ↔ terra, opus ↔ sol, fable ↔ astra;
  - **one tier up at the same provider** (sonnet → opus → fable, luna → terra → sol → astra);
  - **thinking effort:** an `@low`/`@max` variant against the same model at its default.

  A plain alias and `@default` are one configuration: the report pools their runs (renumbering clashing repeats), so `claude-opus-5-5` and `claude-opus-5-5@default` count as one model with a larger N. Charts color by provider (one hue each), give every model its own shade, and draw older generations less saturated than newer ones.

- **Answered without tools:** per configuration, how many runs made no tool call at all, and so answered from what the model already knew, with their mean score against the runs that used tools. It's a cheap check for an agent winging it. Records carry `tool_calls`, `tool_kinds` (browser, fetch, code, shell, file, skill, other: categories only, never commands), `web_calls` and `answered_without_tools`. A run whose transcript could not be exported counts as unknown, never as "no tools". For runs recorded before these metrics existed, `node packages/bench/scripts/backfill-tools.mjs --out <run dir>` fills them in from the saved traces.

Only runs that both configurations judged, for the same task and repeat, are compared. A run that errored (for example, the leader was unreachable) is listed but never counted as a fail.

`report.html` opens with two charts after Artificial Analysis' Intelligence Index:

- **Ranking:** every configuration by score (mean rubric score × 100, over judged runs), best first.
- **Score vs. cost per task:** score against the mean cost of the runs that finished, on a log scale, with the most attractive quadrant (cheaper and better than the median configuration) and the Pareto line of configurations no cheaper one beats.

Color follows the model. The skills condition is the fill: `none` is outlined, and any skills solid. The page then shows the skills lift, the configurations, the model comparison, a task × configuration score matrix, and time against cost per run. To see every published configuration side by side, render it from the dataset:

```bash
hf download ai-ecoverse/slicc-bench --repo-type dataset --include 'records/**' --local-dir slicc-bench
node packages/bench/scripts/html.mjs --records slicc-bench --out report.html
```
