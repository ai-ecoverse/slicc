# SLICC benchmark runner

Measures what skills and models change in SLICC. It runs task sets on a SLICC leader, has a judge grade each run against the task's rubric, and reports pass / partial / fail with time and cost for every model × skills configuration.

## Run it in GitHub Actions

**Actions → Benchmark → Run workflow**. The inputs:

| Input         | Default                           | Meaning                                                                             |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `sets`        | `packages/bench/tasks/smoke.json` | `bu-v1`, `bu-v2`, or task-set JSON paths, space-separated                           |
| `models`      | `claude-sonnet-5,claude-opus-5-5` | Models for the agent under test                                                     |
| `skills`      | `builtin,none`                    | `none`, `builtin`, `builtin+ecoverse` (the leader's skills plus ai-ecoverse/skills) |
| `repeats`     | `1`                               | Runs per task and configuration                                                     |
| `tasks`       | all                               | Task ids, comma-separated                                                           |
| `limit`       | all                               | First N tasks of each set                                                           |
| `timeout`     | `900`                             | Seconds one agent run may take                                                      |
| `judge-model` | `global.openai.gpt-5.6-luna`      | Bedrock model that judges                                                           |

The job summary shows the report. The `bench-<run id>` artifact holds:

- `results/`: one file per configuration, in browser-use's result format plus rubric scores,
- `records/`: one file per run,
- `traces/`: transcripts and screenshots, encrypted for upstream sets.

A pull request that touches the runner runs one smoke task on both models.

## Run it locally

Against a local dev harness, over Chrome DevTools:

```bash
AWS_BEARER_TOKEN_BEDROCK=… node packages/bench/scripts/run.mjs \
  --set packages/bench/tasks/smoke.json --skills builtin,none \
  --executor cdp --cdp http://127.0.0.1:<cdp-port> --ui localhost:<ui-port> --out bench-out
```

Against any leader with a join URL: `SLICC_JOIN_URL=… SLICC_CLI=… node packages/bench/scripts/run.mjs --set …`. `--plan` prints the runs without starting any. A second invocation with the same `--out` skips the runs that finished and retries the ones that errored.

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

`bu-v1` is BU Bench V1's 40 tasks that have a reference answer. Each becomes a two-item rubric: the answer, and evidence it was read from a page. `bu-v2` is BU Bench V2 as published. Both come from the browser-use/benchmark commit pinned in `scripts/upstream.mjs`. Their task text is never committed or published: upstream asks for that, and the repo has no licence.

## Reading the report

For each set, the report has a row per configuration: runs, pass / partial / fail, errors, mean score, mean time and mean cost. After the rows come two lists:

- **What skills change:** for each model, how the score, time and cost of each skills condition differ from the first condition.
- **What models change:** the same comparison between models, for each skills condition.

Only runs that both configurations judged, for the same task and repeat, are compared. A run that errored (for example, the leader was unreachable) is listed but never counted as a fail.
