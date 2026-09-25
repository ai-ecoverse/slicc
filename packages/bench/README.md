# SLICC benchmark runner

Measures what skills and models change in SLICC. It runs task sets on a SLICC leader, has a judge grade each run against the task's rubric, and reports pass / partial / fail with time and cost for every model × skills configuration.

## Run it in GitHub Actions

**Actions → Benchmark → Run workflow**. The inputs:

| Input                | Default                           | Meaning                                                                                                            |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sets`               | `packages/bench/tasks/smoke.json` | `bu-v1`, `bu-v2`, or task-set JSON paths, space-separated                                                          |
| `models`             | `claude-sonnet-5,claude-opus-5-5` | Models for the agent under test                                                                                    |
| `skills`             | `builtin,none`                    | `none`, `builtin`, `builtin+ecoverse` (the leader's skills plus ai-ecoverse/skills)                                |
| `repeats`            | `1`                               | Runs per task and configuration                                                                                    |
| `tasks`              | all                               | Task ids, comma-separated                                                                                          |
| `limit`              | all                               | First N tasks of each set                                                                                          |
| `timeout`            | `900`                             | Seconds one agent run may take                                                                                     |
| `judge-model`        | `global.openai.gpt-5.6-luna`      | Bedrock model that judges                                                                                          |
| `publish`            | on                                | Publish to the Hugging Face dataset ai-ecoverse/slicc-bench                                                        |
| `fresh-leader-every` | `1`                               | Restart the leader, with a wiped profile, every N tasks; `1` isolates every task, `0` keeps one leader for the job |

The job summary shows the report. Two artifacts:

- `bench-report-<run id>`: `report.md`, `report.json` (the same report as data), `report.html` (cards, a task × configuration matrix, time against cost), and `results/`, one file per configuration in browser-use's result format plus rubric scores.
- `bench-<run id>`: all of that, plus `records/` (one file per run) and `traces/` (transcripts and screenshots, encrypted for upstream sets).

With `publish` on (the default), the run is also published to the Hugging Face dataset [ai-ecoverse/slicc-bench](https://huggingface.co/datasets/ai-ecoverse/slicc-bench). The dataset card carries the combined report across every configuration published so far. SLICC's own task sets and traces are Fernet-encrypted there as browser-use encrypts theirs. For browser-use's own sets, only scores are published.

A pull request that touches the runner runs one smoke task on both models.

## Run it locally

The runner drives any leader from outside with the Go `slicc` CLI: it needs the leader's join URL (run `host` in a SLICC terminal) and a CLI with the `new-session` and `model` verbs, built from this checkout until a release ships them:

```bash
(cd packages/slicc-cli && go build -o /tmp/slicc-dev .)
SLICC_CLI=/tmp/slicc-dev SLICC_JOIN_URL=… AWS_BEARER_TOKEN_BEDROCK=… \
  node packages/bench/scripts/run.mjs --set packages/bench/tasks/smoke.json --skills builtin,none --out bench-out
```

Each task starts a fresh chat with erased memories, selects the model and sends the task to the cone, as a person would. Time and cost cover the cone and every scoop it spawns. `--plan` prints the runs without starting any. A second invocation with the same `--out` resumes, run by run:

- **Kept:** runs whose task, rubric, weights and judge are unchanged.
- **Re-judged from the saved trace, without running the agent again:** runs whose judgement no longer stands. That means another `--judge-model`, a changed rubric or weights, or a judge call that failed.
- **Run again:** runs that errored, and runs whose task text changed.

**When the leader stops answering.** A run that cannot reach the leader is recorded with `leader_down`, never judged as a fail. In CI the runner then restarts the leader and retries the run once. After `--leader-down-limit` (default 2) such runs in a row it stops, so a resume can pick up the rest. Every record notes which leader ran it (`leader.generation`, `leader.age_s`). A cost the leader could not report is recorded as unknown (null), never as a difference from zero. The out dir keeps a journal for diagnosing the leader:

- `events.jsonl`: each task with its phases and the leader's `uptime`, memory and process count before and after, plus restarts and stops.
- `calls.jsonl`: every leader call, with how long it took and how it ended.
- `diagnostics/`: the CLI's `SLICC_DEBUG` output from dials that failed.
- `leader-infra.log` (CI): the leader's tray, signaling and WebRTC log lines, interleaved with `[bench-event]` markers from the runner.

The command exits 1 when any run ended in an error, so a CI job cannot pass on runs that never happened. The report is written either way. Result files and the report name the judge that actually produced each score, taken from the records.

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

For each set, the report has a row per configuration: runs, pass / partial / fail, errors, mean score, mean time and mean cost. After the rows come two lists:

- **What skills add:** for each model, the lift each skills condition gives over `none` (over the first condition when `none` did not run), as percentages of the baseline: score, time and cost, with the absolute change beside each. `report.html` shows it as the paired mean score without and with the skills, the lift, and the time and cost it saves. A lift from fewer than 10 paired tasks is flagged as a small sample.
- **What models change:** the same comparison between models, for each skills condition.
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
