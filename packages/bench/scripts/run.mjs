#!/usr/bin/env node

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
import { reportHtml } from './html.mjs';
import { DEFAULT_JUDGE_MODEL, judgeRun } from './judge.mjs';
import {
  bootLane,
  createJournal,
  createLock,
  createRecycler,
  currentLeader,
} from './lifecycle.mjs';
import { reportData, reportMarkdown, summarize } from './results.mjs';
import {
  parseSkillsCondition,
  restoreSkills,
  runTask,
  stageSkills,
  traceFromResult,
} from './slicc-adapter.mjs';
import { decryptSetFile, encryptJson, loadFindingsSpec, loadUpstreamSet } from './upstream.mjs';

export const DEFAULT_MODELS = ['claude-sonnet-5', 'claude-opus-5-5'];

export const MAX_LEADERS = 8;

export const RUN_OVERHEAD_MS = 20 * 60_000;

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
      shard: { type: 'string' },
      timeout: { type: 'string', default: '900' },
      'fresh-leader-every': { type: 'string', default: '0' },
      'leader-down-limit': { type: 'string', default: '2' },
      leaders: { type: 'string', default: '1' },
      'boot-leaders': { type: 'boolean', default: false },
      'deadline-minutes': { type: 'string', default: '0' },
      'max-task-cost': { type: 'string', default: '0' },
      'max-cost': { type: 'string', default: '0' },
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
  const freshLeaderEvery = Number.parseInt(values['fresh-leader-every'], 10);
  const leaderDownLimit = Number.parseInt(values['leader-down-limit'], 10);
  if (!Number.isInteger(freshLeaderEvery) || freshLeaderEvery < 0)
    throw new Error('--fresh-leader-every must be 0 (never) or a positive number of tasks');
  if (!Number.isInteger(leaderDownLimit) || leaderDownLimit < 1)
    throw new Error('--leader-down-limit must be a positive integer');
  const leaders = Number.parseInt(values.leaders, 10);
  if (!Number.isInteger(leaders) || leaders < 1 || leaders > MAX_LEADERS)
    throw new Error(`--leaders must be 1 to ${MAX_LEADERS}`);
  const deadlineMinutes = Number.parseInt(values['deadline-minutes'], 10);
  if (!Number.isInteger(deadlineMinutes) || deadlineMinutes < 0)
    throw new Error('--deadline-minutes must be 0 (none) or a positive number of minutes');
  const runMinutes = Math.ceil((timeout * 1000 + RUN_OVERHEAD_MS) / 60_000);
  if (deadlineMinutes && deadlineMinutes <= runMinutes)
    throw new Error(
      `--deadline-minutes ${deadlineMinutes} leaves no time for a run: one takes up to ${runMinutes} (the timeout plus ${RUN_OVERHEAD_MS / 60_000} for the restart, collection and judge)`
    );
  const shard = parseShard(values.shard);
  const money = (flag) => {
    const v = Number(values[flag]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`--${flag} must be 0 (none) or dollars`);
    return v;
  };
  return {
    help: values.help,
    sets: values.set ?? [],
    models: list(values.models),
    skills: list(values.skills).map(parseSkillsCondition),
    repeats,
    taskIds: values.tasks ? list(values.tasks) : null,
    limit: values.limit ? Number.parseInt(values.limit, 10) : null,
    shard,
    timeout,
    judgeModel: values['judge-model'],
    judge: !values['no-judge'],
    out: resolve(values.out),
    harness: values.harness,
    plan: values.plan,
    freshLeaderEvery,
    leaderDownLimit,
    leaders,
    bootLeaders: values['boot-leaders'] || leaders > 1,
    deadlineMinutes,
    maxTaskCost: money('max-task-cost'),
    maxCost: money('max-cost'),
  };
}

export async function loadSet(
  spec,
  { loadUpstream = loadUpstreamSet, readFile = readFileSync } = {}
) {
  let envelope;
  let encrypted = false;
  let upstream = null;

  const fetchUpstream = async (name) => {
    const got = await loadUpstream(name, { withProvenance: true });
    return got?.provenance ? got : { data: got, provenance: null };
  };
  if (spec === 'bu-v1') {
    const { data: v1, provenance } = await fetchUpstream('BU_Bench_V1');
    const tasks = v1.map((t) => fromBuV1(t)).filter(Boolean);
    envelope = { benchmark: 'BU_Bench_V1', tasks };
    encrypted = true;
    upstream = provenance;
  } else if (spec === 'bu-v2') {
    const { data, provenance } = await fetchUpstream('BU_Bench_V2');
    envelope = data;
    encrypted = true;
    upstream = provenance;
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
  const errors = validateEnvelope(envelope, { checkDigests: !upstream && !encrypted });
  if (errors.length)
    throw new Error(
      `${spec}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`
    );
  return { benchmark: envelope.benchmark, tasks: envelope.tasks, encrypted, upstream };
}

export function parseShard(value) {
  if (!value) return null;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const index = m ? Number(m[1]) : 0;
  const count = m ? Number(m[2]) : 0;
  if (!m || count < 1 || index < 1 || index > count)
    throw new Error('--shard must be K/N with 1 <= K <= N, e.g. 2/5');
  return { index, count };
}

export function shardRuns(runs, shard) {
  if (!shard) return runs;
  const order = new Map();
  for (const r of runs) {
    const key = `${r.set.benchmark}\u0000${r.task.id}`;
    if (!order.has(key)) order.set(key, order.size);
  }
  return runs.filter(
    (r) => order.get(`${r.set.benchmark}\u0000${r.task.id}`) % shard.count === shard.index - 1
  );
}

export function selectTasks(tasks, { taskIds, limit }) {
  let picked = taskIds ? tasks.filter((t) => taskIds.includes(t.id)) : tasks;
  if (limit && limit > 0) picked = picked.slice(0, limit);
  return picked;
}

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

export function readRecords(out) {
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
  const runs = shardRuns(planRuns(sets, opts), opts.shard);
  const shard = opts.shard ? ` (shard ${opts.shard.index}/${opts.shard.count})` : '';
  log(
    `${runs.length} runs${shard}: ${opts.models.join(', ')} × skills ${opts.skills.map((s) => s.name).join(', ')} × ${opts.repeats} repeat(s)`
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
    ...(r.set.upstream ? { upstream: r.set.upstream } : {}),
    leader: leaderStamp(ctx.lane, ctx.id),
  };
  let result;
  try {
    result = await runTask({
      leader,
      task: r.task,
      runId,
      model: r.model,
      timeoutSeconds: opts.timeout,
      ...(opts.maxTaskCost ? { maxCost: opts.maxTaskCost } : {}),
      ...(ctx.capture ? { capture: ctx.capture } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
  } catch (err) {
    failInto(record, 'run', err);
    if (err?.leaderDown) record.leader_down = true;
    return { record, result: null };
  }
  record.metrics = traceFromResult(result).metrics;
  record.model_id = result.modelId ?? null;

  const tx = result.transcriptExport;
  if (tx && !tx.ok && [tx.reason, tx.detail].some((s) => /leader-down/.test(s ?? ''))) {
    failInto(record, 'collect', new Error(`transcript lost: the leader went down (${tx.stage})`));
    record.leader_down = true;
    return { record, result };
  }
  if (judge) {
    try {
      await judgeInto(record, result, r.task, ctx);
    } catch (err) {
      failInto(record, 'judge', err);
    }
  }
  return { record, result };
}

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
  const t = record.metrics.transcript;
  const missing = t && !t.ok ? ` (no transcript: ${t.stage} ${t.reason})` : '';
  return `${head} ${record.outcome ?? 'ran'}${score} ${record.metrics.duration.toFixed(0)} s ${typeof record.metrics.cost === 'number' ? `$${record.metrics.cost.toFixed(3)}` : 'cost unknown'}${missing}`;
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

export function ageSeconds(startedAt, now = Date.now()) {
  const t = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt ?? '');
  return Number.isFinite(t) ? Math.round((now - t) / 1000) : null;
}

function leaderStamp(lane, id = 0) {
  return {
    lane: id,
    generation: lane.generation,
    age_s: ageSeconds(lane.startedAt),
    task: lane.tasks + 1,
  };
}

async function restartLeader(ctx, reason, log) {
  const { lane, journal } = ctx;
  const t0 = Date.now();
  journal.event('leader-restart', {
    lane: ctx.id,
    reason,
    generation: lane.generation,
    tasks: lane.tasks,
  });
  log(`restarting the leader (${reason})`);
  const next = await ctx.recycle();
  ctx.leader.setUrl(next.url);
  Object.assign(lane, {
    generation: lane.generation + 1,
    startedAt: next.startedAt ?? new Date().toISOString(),
    tasks: 0,
    staged: null,
  });
  journal.event('leader-ready', {
    lane: ctx.id,
    generation: lane.generation,
    slicc_version: next.sliccVersion,
    boot_ms: Date.now() - t0,
  });
}

async function prepareLeader(r, ctx, log) {
  const { lane, opts } = ctx;
  if (opts.freshLeaderEvery && lane.tasks >= opts.freshLeaderEvery)
    await restartLeader(ctx, `fresh leader every ${opts.freshLeaderEvery} tasks`, log);
  if (lane.staged !== r.condition.name) {
    const count = await stageSkills(ctx.leader, r.condition);
    lane.staged = r.condition.name;
    log(`skills ${lane.staged}: ${count} entries in /workspace/skills`);
  }
}

async function prepareOrRestart(r, ctx, log) {
  try {
    await prepareLeader(r, ctx, log);
  } catch (err) {
    if (!err?.leaderDown || !ctx.recycle) throw err;
    ctx.journal.event('leader-down', {
      stage: 'prepare',
      task_id: r.task.id,
      leader: leaderStamp(ctx.lane, ctx.id),
    });
    await restartLeader(ctx, 'leader unreachable while preparing', log);
    await prepareLeader(r, ctx, log);
  }
}

async function runFresh(r, ctx, log) {
  await prepareOrRestart(r, ctx, log);
  let outcome = await runOne(r, ctx);
  if (outcome.record.leader_down && ctx.recycle) {
    ctx.journal.event('leader-down', { task_id: r.task.id, leader: outcome.record.leader });
    await restartLeader(ctx, 'leader unreachable', log);
    await prepareLeader(r, ctx, log);
    outcome = await runOne(r, ctx);
  }
  ctx.lane.tasks += 1;
  return outcome;
}

function taskEvent(r, { record, result }, lane = 0) {
  return {
    lane,
    task_id: r.task.id,
    model: r.model,
    skills: r.condition.name,
    outcome: record.error ? 'error' : (record.outcome ?? 'ran'),
    error: record.error,
    leader_down: record.leader_down,
    leader: record.leader,
    phases: result?.phases,
    health: result?.health,
    transcript: result?.transcriptExport,
  };
}

async function setupLanes(opts, deps, journal, log, runStart) {
  const scriptsDir = process.env.BENCH_LEADER_SCRIPTS;
  const canBoot = Boolean(deps.bootLane || scriptsDir);
  if (opts.bootLeaders && !canBoot)
    throw new Error('--leaders and --boot-leaders need BENCH_LEADER_SCRIPTS (set in CI)');
  const recycle = deps.recycle ?? (scriptsDir ? createRecycler({ scriptsDir }) : null);
  if (opts.freshLeaderEvery && !opts.bootLeaders && !recycle)
    throw new Error(
      '--fresh-leader-every needs a leader it can restart (BENCH_LEADER_SCRIPTS, set in CI)'
    );
  if (opts.bootLeaders) return bootLanes(opts, deps, journal, log);
  const first = deps.firstLeader ?? (scriptsDir ? currentLeader() : null);
  return [
    {
      id: 0,
      leader:
        deps.leader ?? createLeader({ url: process.env.SLICC_JOIN_URL, onCall: journal.call }),
      recycle,
      lane: { generation: 0, startedAt: first?.startedAt ?? runStart, tasks: 0, staged: null },
      leaderLog: process.env.BENCH_LEADER_LOG || null,
      sliccVersion: first?.sliccVersion ?? null,
    },
  ];
}

async function bootLanes(opts, deps, journal, log) {
  const lock = createLock();
  const claims = new Map();
  const lanes = [];
  for (let i = 0; i < opts.leaders; i += 1) {
    const t0 = Date.now();
    try {
      const l = deps.bootLane
        ? await deps.bootLane(i, { lock, claims })
        : await bootLane(i, {
            scriptsDir: process.env.BENCH_LEADER_SCRIPTS,
            lock,
            claims,
            makeLeader: createLeader,
            onCall: journal.call,
          });
      lanes.push({
        id: i,
        ...l,
        lane: {
          generation: 0,
          startedAt: l.startedAt ?? new Date().toISOString(),
          tasks: 0,
          staged: null,
        },
      });
      journal.event('leader-ready', {
        lane: i,
        generation: 0,
        slicc_version: l.sliccVersion ?? null,
        boot_ms: Date.now() - t0,
      });
      log(`lane ${i}: leader up`);
    } catch (err) {
      journal.event('lane-failed', { lane: i, reason: String(err?.message ?? err).slice(0, 400) });
      log(`lane ${i}: its leader did not come up: ${err.message}`);
    }
  }
  if (!lanes.length) throw new Error('no leader came up');
  return lanes;
}

async function processRun(i, r, runs, ctx, say) {
  const { opts, journal } = ctx;
  const before = previous(opts, r);
  const action = resumeAction(before.record, r.task, {
    judge: Boolean(ctx.judge),
    judgeModel: opts.judgeModel,
    traceExists: before.traceExists,
  });
  if (action === 'done') {
    say(
      `[${i + 1}/${runs.length}] ${r.task.id} ${r.model} ${r.condition.name} r${r.repeat}: done before, skipped`
    );
    return null;
  }
  if (action === 'rejudge') {
    const rejudged = await rejudgeOne(r, ctx, before.record);
    say(`${describeRun(i, runs.length, r, rejudged.record)} (re-judged)`);
    writeRun(opts, r, rejudged);
    return { ...rejudged, rejudged: true };
  }
  const outcome = await runFresh(r, ctx, say);
  say(describeRun(i, runs.length, r, outcome.record));
  writeRun(opts, r, outcome);
  journal.event('task', taskEvent(r, outcome, ctx.id));
  return outcome;
}

async function laneLoop(runs, lc, queue, state, shared, log) {
  const ctx = { ...shared, ...lc };
  const say = shared.laneCount > 1 ? (line) => log(`[L${lc.id}] ${line}`) : log;
  let downStreak = 0;
  try {
    while (queue.next < runs.length && !shared.stopWhy(state, queue)) {
      const i = queue.next++;
      const outcome = await processRun(i, runs[i], runs, ctx, say);
      if (!outcome) continue;
      if (outcome.record.error) state.errors += 1;

      if (!outcome.rejudged && typeof outcome.record.metrics?.cost === 'number')
        state.spent += outcome.record.metrics.cost;
      downStreak = outcome.record.leader_down ? downStreak + 1 : 0;
      if (downStreak >= shared.opts.leaderDownLimit) {
        state.stopped = true;
        const left = runs.length - queue.next;
        shared.journal.event('stopped', {
          lane: lc.id,
          reason: 'leader unreachable',
          runs_left: left,
        });
        say(
          `stopping: the leader was unreachable for ${downStreak} run(s) in a row; ${left} run(s) left for a resume`
        );
        break;
      }
    }
  } catch (err) {
    state.stopped = true;
    state.errors += 1;
    shared.journal.event('stopped', {
      lane: lc.id,
      reason: String(err?.message ?? err).slice(0, 400),
    });
    say(`stopping this lane: ${err.message}`);
  } finally {
    if (lc.lane.staged)
      await restoreSkills(lc.leader).catch((err) =>
        say(`could not restore /workspace/skills: ${err.message}`)
      );
  }
}

export function runTimeoutSeconds(run, timeout) {
  return run?.task?.slicc?.timeoutSeconds ?? timeout;
}

export function guardrails(opts, { startedMs, now = Date.now, journal, log, runs = [] }) {
  const deadline = opts.deadlineMinutes ? startedMs + opts.deadlineMinutes * 60_000 : null;
  return (state, queue) => {
    let why = null;
    if (deadline) {
      const perRunMs = runTimeoutSeconds(runs[queue.next], opts.timeout) * 1000 + RUN_OVERHEAD_MS;
      if (now() + perRunMs > deadline) why = 'deadline';
    }
    if (!why && opts.maxCost && state.spent >= opts.maxCost) why = 'budget';
    if (why && !state.reasons.includes(why)) {
      state.reasons.push(why);
      state.stopped = true;
      const left = queue.total - queue.next;
      journal.event('stopped', { reason: why, runs_left: left, spent: state.spent });
      log(
        why === 'deadline'
          ? `stopping: past the deadline for another run; ${left} run(s) left for a resume`
          : `stopping: spent $${state.spent.toFixed(2)} of the $${opts.maxCost} budget; ${left} run(s) left for a resume`
      );
    }
    return why;
  };
}

async function runAll(runs, lanes, shared, log) {
  const queue = { next: 0, total: runs.length };
  const state = { errors: 0, stopped: false, spent: 0, reasons: [] };
  await Promise.all(lanes.map((lc) => laneLoop(runs, lc, queue, state, shared, log)));
  if (queue.next < runs.length && !state.stopped) state.stopped = true;
  return state;
}

export function writeOutputs(opts, runStart) {
  const records = readRecords(opts.out);
  for (const s of summarize(records, { runStart })) {
    writeJson(join(opts.out, 'results', s.file), s.body);
  }
  const report = reportMarkdown(records);
  writeFileSync(join(opts.out, 'report.md'), `${report}\n`);
  writeJson(join(opts.out, 'report.json'), { run_start: runStart, ...reportData(records) });
  writeFileSync(join(opts.out, 'report.html'), reportHtml(records));
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
  const runStart = new Date().toISOString();
  const lanes = [];
  const journal = createJournal(opts.out, {
    urls: () => lanes.map((l) => l.leader?.url),
    leaderLog: (data) => lanes.find((l) => l.id === (data.lane ?? 0))?.leaderLog ?? null,
  });
  const judge = makeJudge(opts, deps);
  const spec = judge ? (deps.spec ?? (await loadFindingsSpec())) : null;
  let outcome;
  try {
    lanes.push(...(await setupLanes(opts, deps, journal, log, runStart)));
    journal.event('start', {
      runs: runs.length,
      lanes: lanes.length,
      fresh_leader_every: opts.freshLeaderEvery,
      deadline_minutes: opts.deadlineMinutes || null,
      max_task_cost: opts.maxTaskCost || null,
      max_cost: opts.maxCost || null,
      leader_started_at: lanes[0].lane.startedAt,
      slicc_version: lanes[0].sliccVersion ?? null,
    });
    const shared = {
      opts,
      judge,
      spec,
      capture: deps.capture,
      now: deps.now,
      journal,
      laneCount: lanes.length,
      stopWhy: guardrails(opts, { startedMs: Date.parse(runStart), journal, log, runs }),
    };
    outcome = await runAll(runs, lanes, shared, log);
  } finally {
    for (const l of lanes)
      await l.stop?.().catch((err) => log(`could not stop lane ${l.id}: ${err.message}`));
  }
  const { errors, stopped } = outcome;
  journal.event('end', {
    errors,
    stopped,
    generations: lanes.reduce((n, l) => n + l.lane.generation + 1, 0),
  });
  console.log(writeOutputs(opts, runStart));

  if (errors)
    log(`${errors} run(s) errored before the judge; rerun with the same --out to retry them`);
  return errors || stopped ? 1 : 0;
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
