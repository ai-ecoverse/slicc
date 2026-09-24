#!/usr/bin/env node
/**
 * bench — run task sets on a SLICC leader across models and skills, judge every run, and
 * write result files and a report.
 *
 *   node packages/bench/scripts/run.mjs --set bu-v1 --models claude-sonnet-5,claude-opus-5-5 \
 *     --skills builtin,none --repeats 3 --out bench-out
 *
 * Sets: `bu-v1` (BU Bench V1, answered tasks only), `bu-v2`, or a path to a task-set JSON
 * (the shared V2 format, or skill-creator `evals.json`). Upstream sets are fetched from the
 * pinned browser-use/benchmark commit and never written in plaintext: run traces for them are
 * Fernet-encrypted with the set's own key, as upstream publishes its tasks.
 *
 * Leader: driven from outside with the Go `slicc` CLI (SLICC_CLI) against its join URL
 * (SLICC_JOIN_URL): each task is a prompt to the cone after `new-session --erase` and
 * `model <m>` — see slicc-adapter.mjs.
 * Judge: Bedrock Converse with AWS_BEARER_TOKEN_BEDROCK (or BEDROCK_API_KEY) and BEDROCK_REGION.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLeader } from './executors.mjs';
import {
  fromBuV1,
  fromSkillCreatorEvals,
  outcome,
  pathSegment,
  taskDigests,
  validateEnvelope,
} from './format.mjs';
import { DEFAULT_JUDGE_MODEL, judgeRun } from './judge.mjs';
import { reportMarkdown, summarize } from './results.mjs';
import {
  parseSkillsCondition,
  restoreSkills,
  runTask,
  stageSkills,
  traceFromResult,
} from './slicc-adapter.mjs';
import { decryptSetFile, encryptJson, loadFindingsSpec, loadUpstreamSet } from './upstream.mjs';

export const DEFAULT_MODELS = ['claude-sonnet-5', 'claude-opus-5-5'];

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: 'string', multiple: true },
      models: { type: 'string', default: DEFAULT_MODELS.join(',') },
      skills: { type: 'string', default: 'builtin' },
      repeats: { type: 'string', default: '1' },
      tasks: { type: 'string' },
      limit: { type: 'string' },
      timeout: { type: 'string', default: '900' },
      'judge-model': { type: 'string', default: DEFAULT_JUDGE_MODEL },
      'no-judge': { type: 'boolean', default: false },
      out: { type: 'string', default: 'bench-out' },
      harness: { type: 'string', default: 'dev' },
      plan: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const list = (s) =>
    String(s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const repeats = Number.parseInt(values.repeats, 10);
  const timeout = Number.parseInt(values.timeout, 10);
  if (!values.help && !values.set?.length)
    throw new Error('give at least one --set (bu-v1, bu-v2, or a task-set JSON path)');
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('--repeats must be a positive integer');
  if (!Number.isInteger(timeout) || timeout < 30)
    throw new Error('--timeout must be at least 30 seconds');
  return {
    help: values.help,
    sets: values.set ?? [],
    models: list(values.models),
    skills: list(values.skills).map(parseSkillsCondition),
    repeats,
    taskIds: values.tasks ? list(values.tasks) : null,
    limit: values.limit ? Number.parseInt(values.limit, 10) : null,
    timeout,
    judgeModel: values['judge-model'],
    judge: !values['no-judge'],
    out: resolve(values.out),
    harness: values.harness,
    plan: values.plan,
  };
}

/** A set spec → `{ benchmark, tasks, encrypted }`, validated. */
export async function loadSet(
  spec,
  { loadUpstream = loadUpstreamSet, readFile = readFileSync } = {}
) {
  let envelope;
  let encrypted = false;
  if (spec === 'bu-v1') {
    const v1 = await loadUpstream('BU_Bench_V1');
    const tasks = v1.map((t) => fromBuV1(t)).filter(Boolean);
    envelope = { benchmark: 'BU_Bench_V1', tasks };
    encrypted = true;
  } else if (spec === 'bu-v2') {
    envelope = await loadUpstream('BU_Bench_V2');
    encrypted = true;
  } else {
    const doc = JSON.parse(readFile(spec, 'utf8'));
    envelope = Array.isArray(doc.evals) ? fromSkillCreatorEvals(doc) : doc;
    const base = dirname(resolve(spec));
    envelope = {
      ...envelope,
      tasks: envelope.tasks.map((t) =>
        t.slicc?.files
          ? {
              ...t,
              slicc: {
                ...t.slicc,
                files: t.slicc.files.map((f) => ({ ...f, from: resolve(base, f.from) })),
              },
            }
          : t
      ),
    };
  }
  const errors = validateEnvelope(envelope);
  if (errors.length)
    throw new Error(
      `${spec}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`
    );
  return { benchmark: envelope.benchmark, tasks: envelope.tasks, encrypted };
}

export function selectTasks(tasks, { taskIds, limit }) {
  let picked = taskIds ? tasks.filter((t) => taskIds.includes(t.id)) : tasks;
  if (limit && limit > 0) picked = picked.slice(0, limit);
  return picked;
}

/**
 * The run order: skills condition outermost (staging /workspace/skills is the costly switch),
 * then repeat, task, model. Models alternate per task so both meet the live web at about the
 * same moment.
 */
export function planRuns(sets, { models, skills, repeats }) {
  const runs = [];
  for (const condition of skills) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const set of sets) {
        for (const task of set.tasks) {
          for (const model of models) runs.push({ set, task, model, condition, repeat });
        }
      }
    }
  }
  return runs;
}

const safe = pathSegment;

export function recordPath(out, benchmark, condition, model, taskId, repeat) {
  return join(
    out,
    'records',
    safe(benchmark),
    safe(condition),
    safe(model),
    `${safe(taskId)}-r${repeat}.json`
  );
}

export function tracePath(out, benchmark, condition, model, taskId, repeat, encrypted) {
  return join(
    out,
    'traces',
    safe(benchmark),
    safe(condition),
    safe(model),
    `${safe(taskId)}-r${repeat}.json${encrypted ? '.enc' : ''}`
  );
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readRecords(out) {
  const root = join(out, 'records');
  if (!existsSync(root)) return [];
  const records = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) records.push(JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  walk(root);
  return records;
}

/** Decrypt a trace written for an upstream set (for local inspection only; never publish it). */
export function readTrace(path, benchmark) {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.enc') ? decryptSetFile(text, benchmark) : JSON.parse(text);
}

async function loadAndPlan(opts, deps, log) {
  const sets = [];
  for (const spec of opts.sets) {
    const set = await loadSet(spec, deps);
    sets.push({ ...set, tasks: selectTasks(set.tasks, opts) });
    log(`${set.benchmark}: ${sets.at(-1).tasks.length} of ${set.tasks.length} tasks`);
  }
  const runs = planRuns(sets, opts);
  log(
    `${runs.length} runs: ${opts.models.join(', ')} × skills ${opts.skills.map((s) => s.name).join(', ')} × ${opts.repeats} repeat(s)`
  );
  return runs;
}

function makeJudge(opts, deps) {
  if (!opts.judge) return null;
  if (deps.judge) return deps.judge;
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY;
  const region = process.env.BEDROCK_REGION || 'us-west-2';
  if (!apiKey) throw new Error('the judge needs AWS_BEARER_TOKEN_BEDROCK (or pass --no-judge)');
  return (a) => judgeRun({ ...a, model: opts.judgeModel, apiKey, region });
}

/** Judge a finished run into its record. Clears an earlier judge error on success. */
async function judgeInto(record, result, task, { judge, spec, opts }) {
  const j = await judge({ spec, task, trace: traceFromResult(result) });
  Object.assign(record, {
    score: j.result.score,
    verdict: j.result.verdict,
    outcome: outcome(j.result.score),
    statuses: j.result.statuses,
    flags: {
      infra_error: j.judgement.infra_error,
      reward_hacking_suspected: j.judgement.reward_hacking_suspected,
      canary_leak: j.result.canary_leak,
    },
    judge: { model: opts.judgeModel, images: j.imagesSent, usage: j.usage },
  });
  record.digests = taskDigests(task);
  delete record.error;
  delete record.error_stage;
  result.judgement = j.judgement;
}

function failInto(record, stage, err) {
  record.error = String(err?.message ?? err).slice(0, 500);
  record.error_stage = stage;
}

/**
 * Run one task on the leader and judge it. Returns `{ record, result }`; never throws. A judge
 * failure keeps the result, so the next invocation re-judges it instead of re-running the agent.
 */
async function runOne(r, ctx) {
  const { leader, opts, judge } = ctx;
  const config = { harness: opts.harness, model: r.model, skills: r.condition.name };
  const runId = `${safe(r.task.id).slice(0, 40)}-${safe(r.model)}-${safe(config.skills)}-r${r.repeat}-${Date.now().toString(36)}`;
  const record = {
    benchmark: r.set.benchmark,
    task_id: r.task.id,
    repeat: r.repeat,
    config,
    run_id: runId,
    digests: taskDigests(r.task),
  };
  let result;
  try {
    result = await runTask({
      leader,
      task: r.task,
      runId,
      model: r.model,
      timeoutSeconds: opts.timeout,
      ...(ctx.capture ? { capture: ctx.capture } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
  } catch (err) {
    failInto(record, 'run', err);
    return { record, result: null };
  }
  record.metrics = traceFromResult(result).metrics;
  record.model_id = result.modelId ?? null;
  if (judge) {
    try {
      await judgeInto(record, result, r.task, ctx);
    } catch (err) {
      failInto(record, 'judge', err);
    }
  }
  return { record, result };
}

/**
 * What a resume does with a planned run, given its earlier record:
 * - `run`: no record, the agent failed, or the task text changed since (the old trace answers a
 *   different question);
 * - `rejudge`: the agent's run still stands but its judgement does not — judging failed or was
 *   skipped, another judge model is asked for, or the rubric or weights changed;
 * - `done`: nothing changed.
 * A rejudge needs the saved trace; without it the run starts over.
 */
export function resumeAction(record, task, { judge, judgeModel, traceExists }) {
  if (!record) return 'run';
  const d = taskDigests(task);
  if (!record.digests || record.digests.task_sha !== d.task_sha) return 'run';
  if (record.error && record.error_stage !== 'judge') return 'run';
  if (!judge) return 'done';
  const stale =
    record.error_stage === 'judge' ||
    typeof record.score !== 'number' ||
    record.judge?.model !== judgeModel ||
    record.digests.rubric_sha !== d.rubric_sha ||
    record.digests.weights_sha !== d.weights_sha;
  if (!stale) return 'done';
  return traceExists ? 'rejudge' : 'run';
}

/** Re-judge a saved trace without running the agent again. */
async function rejudgeOne(r, ctx, record) {
  const where = [ctx.opts.out, r.set.benchmark, r.condition.name, r.model, r.task.id, r.repeat];
  const saved = readTrace(tracePath(...where, r.set.encrypted), r.set.benchmark);
  try {
    await judgeInto(record, saved.result, r.task, ctx);
  } catch (err) {
    failInto(record, 'judge', err);
  }
  return { record, result: saved.result };
}

function describeRun(i, total, r, record) {
  const head = `[${i + 1}/${total}] ${r.task.id} ${r.model} ${r.condition.name} r${r.repeat}:`;
  if (record.error) return `${head} ERROR ${record.error}`;
  const score = record.score == null ? '' : ` ${record.score.toFixed(2)}`;
  return `${head} ${record.outcome ?? 'ran'}${score} ${record.metrics.duration.toFixed(0)} s $${(record.metrics.cost ?? 0).toFixed(3)}`;
}

function writeRun(opts, r, { record, result }) {
  const where = [opts.out, r.set.benchmark, r.condition.name, r.model, r.task.id, r.repeat];
  writeJson(recordPath(...where), record);
  if (!result) return;
  const tp = tracePath(...where, r.set.encrypted);
  const trace = { record, task: r.task, result };
  mkdirSync(dirname(tp), { recursive: true });
  writeFileSync(tp, r.set.encrypted ? encryptJson(trace, r.set.benchmark) : JSON.stringify(trace));
}

function previous(opts, r) {
  const where = [opts.out, r.set.benchmark, r.condition.name, r.model, r.task.id, r.repeat];
  const rp = recordPath(...where);
  return {
    record: existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null,
    traceExists: existsSync(tracePath(...where, r.set.encrypted)),
  };
}

/** Run every planned run; returns how many ended in an error (running or judging). */
async function runAll(runs, ctx, log) {
  const { leader, opts } = ctx;
  let staged = null;
  let errors = 0;
  try {
    for (const [i, r] of runs.entries()) {
      const before = previous(opts, r);
      const action = resumeAction(before.record, r.task, {
        judge: Boolean(ctx.judge),
        judgeModel: opts.judgeModel,
        traceExists: before.traceExists,
      });
      if (action === 'done') {
        log(
          `[${i + 1}/${runs.length}] ${r.task.id} ${r.model} ${r.condition.name} r${r.repeat}: done before, skipped`
        );
        continue;
      }
      if (action === 'rejudge') {
        const rejudged = await rejudgeOne(r, ctx, before.record);
        if (rejudged.record.error) errors += 1;
        log(`${describeRun(i, runs.length, r, rejudged.record)} (re-judged)`);
        writeRun(opts, r, rejudged);
        continue;
      }
      if (staged !== r.condition.name) {
        const count = await stageSkills(leader, r.condition);
        staged = r.condition.name;
        log(`skills ${staged}: ${count} entries in /workspace/skills`);
      }
      const outcomeOfRun = await runOne(r, ctx);
      if (outcomeOfRun.record.error) errors += 1;
      log(describeRun(i, runs.length, r, outcomeOfRun.record));
      writeRun(opts, r, outcomeOfRun);
    }
  } finally {
    if (staged)
      await restoreSkills(leader).catch((err) =>
        log(`could not restore /workspace/skills: ${err.message}`)
      );
  }
  return errors;
}

function writeOutputs(opts, runStart) {
  const records = readRecords(opts.out);
  for (const s of summarize(records, { runStart })) {
    writeJson(join(opts.out, 'results', s.file), s.body);
  }
  const report = reportMarkdown(records);
  writeFileSync(join(opts.out, 'report.md'), `${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, { flag: 'a' });
  return report;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseCli(argv);
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  const log =
    deps.log ??
    ((line) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${line}`));
  const runs = await loadAndPlan(opts, deps, log);
  if (opts.plan) {
    for (const r of runs)
      console.log(
        `${r.set.benchmark}\t${r.condition.name}\t${r.model}\tr${r.repeat}\t${r.task.id}`
      );
    return 0;
  }
  const leader = deps.leader ?? createLeader({ url: process.env.SLICC_JOIN_URL });
  const judge = makeJudge(opts, deps);
  const spec = judge ? (deps.spec ?? (await loadFindingsSpec())) : null;
  const runStart = new Date().toISOString();
  const errors = await runAll(
    runs,
    { leader, opts, judge, spec, capture: deps.capture, now: deps.now },
    log
  );
  console.log(writeOutputs(opts, runStart));
  // The report is written either way; a non-zero exit keeps a CI job from passing on runs
  // that never reached the judge. Rerunning with the same --out retries only those.
  if (errors)
    log(`${errors} run(s) errored before the judge; rerun with the same --out to retry them`);
  return errors ? 1 : 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 7 */
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`bench: ${err.message}`);
      process.exit(1);
    }
  );
}
