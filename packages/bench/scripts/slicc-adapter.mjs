/**
 * The SLICC adapter: run one task on a leader and return what the judge needs.
 *
 * The cone does the task, exactly as it would for a person, and everything around it is driven
 * from outside with the `slicc` CLI (see executors.mjs); nothing is installed on the leader:
 *
 * 1. setup (`exec`): a scratch dir, the task's files, no open tabs, a `cost` snapshot;
 *    `new-session --erase` so no earlier task — or memory extracted from one — is in context;
 *    `model <m>` so the cone runs the model under test;
 * 2. the task: `prompt -` with the task on stdin, while a host-side loop screenshots the tabs
 *    (agents close their tabs when they finish, so the end state is gone by the time the reply is);
 * 3. capture (`exec`): the conversation via `session export`, the screenshots, the spend (every
 *    unit's delta in `cost --json`: the cone plus any scoop it delegated to);
 * 4. teardown: tabs closed, `new-session --erase`, scratch dir removed — also when the run failed.
 *
 * The prompt is the task text plus upstream's closing instruction (a FINAL ANSWER line, no
 * clarifying questions); how to drive the browser is left to SLICC and its installed skills,
 * because that is what the skills axis measures.
 *
 * Skills are staged per condition by rewriting /workspace/skills over `exec`; the leader's own
 * skills are stashed once and restored at the end.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SKILLS_DIR = '/workspace/skills';
export const SKILLS_STASH = '/workspace/.bench-skills-builtin';
export const EXTRA_SKILLS_ROOT = '/workspace/bench-skills';
export const MAX_SCREENSHOTS = 10;
const POLL_MS = 5000;
const RECAPTURE_MS = 15000;
const STEP_CHARS = 4000;

export const FINAL_INSTRUCTION = [
  "Don't ask clarifying questions: if the task is ambiguous, pick the most reasonable reading and go on.",
  'When the task is done, end your last message with exactly one line:',
  'FINAL ANSWER: <your concise answer, on one line>',
  'If the task has no textual answer, write `FINAL ANSWER: done` and say what you did before that line.',
].join('\n');

export function buildPrompt(task) {
  return `${task.task.trim()}\n\n${FINAL_INSTRUCTION}\n`;
}

/** Shell-quote one word for the leader's bash. */
export function quote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

function failure(what, r) {
  return new Error(`${what} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
}

async function must(leader, command, options) {
  const r = await leader.exec(command, options);
  if (r.status !== 0) throw failure(`leader: \`${command.slice(0, 120)}\``, r);
  return r;
}

async function mustCli(leader, args, options) {
  const r = await leader.cli(args, options);
  if (r.status !== 0) throw failure(`slicc ${args[0]}`, r);
  return r;
}

/**
 * A skills condition: `none` or `builtin` (whatever the leader ships), optionally joined with
 * `+` to extra skill sets injected under /workspace/bench-skills/<name>/ (`builtin+ecoverse`,
 * `none+ecoverse`).
 */
export function parseSkillsCondition(text) {
  const parts = String(text)
    .split('+')
    .map((s) => s.trim());
  const base = parts.shift();
  if (base !== 'none' && base !== 'builtin') {
    throw new Error(`skills condition must start with none or builtin: ${JSON.stringify(text)}`);
  }
  for (const p of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(p)) throw new Error(`bad skill set name ${JSON.stringify(p)}`);
  }
  return { name: String(text).trim(), builtin: base === 'builtin', extras: parts };
}

/** The shell command that makes /workspace/skills match a condition. */
export function stageSkillsCommand(condition) {
  const steps = [
    `if [ ! -d ${SKILLS_STASH} ]; then mkdir -p ${SKILLS_STASH} && cp -r ${SKILLS_DIR}/. ${SKILLS_STASH}/; fi`,
    `rm -rf ${SKILLS_DIR}`,
    `mkdir -p ${SKILLS_DIR}`,
  ];
  if (condition.builtin) steps.push(`cp -r ${SKILLS_STASH}/. ${SKILLS_DIR}/`);
  for (const extra of condition.extras)
    steps.push(`cp -r ${EXTRA_SKILLS_ROOT}/${extra}/. ${SKILLS_DIR}/`);
  steps.push(`ls ${SKILLS_DIR} | wc -l`);
  return steps.join(' && ');
}

export function restoreSkillsCommand() {
  return `if [ -d ${SKILLS_STASH} ]; then rm -rf ${SKILLS_DIR} && mkdir -p ${SKILLS_DIR} && cp -r ${SKILLS_STASH}/. ${SKILLS_DIR}/; fi`;
}

export async function stageSkills(leader, condition) {
  const r = await must(leader, stageSkillsCommand(condition));
  return Number.parseInt(r.stdout.trim().split('\n').pop(), 10) || 0;
}

export async function restoreSkills(leader) {
  await must(leader, restoreSkillsCommand());
}

/** `playwright-cli tab-list` → `[{ id, url }]` (`[<targetId>] <url> "<title>"` lines). */
export function parseTabList(text) {
  return [...String(text ?? '').matchAll(/^\[([^\]]+)\]\s+(\S+)/gm)].map((m) => ({
    id: m[1],
    url: m[2],
  }));
}

async function tabs(leader) {
  const r = await leader.exec('playwright-cli tab-list');
  return r.status === 0 ? parseTabList(r.stdout) : [];
}

async function closeTabs(leader) {
  for (const t of await tabs(leader)) {
    await leader.exec(`playwright-cli tab-close --tab=${quote(t.id)}`);
  }
}

/** Sum every unit's spend in `cost --json --all` — the cone and all scoops. */
export function costTotals(costJson) {
  const totals = { cost: 0, tokens: 0, turns: 0 };
  let data;
  try {
    data = JSON.parse(costJson);
  } catch {
    return totals;
  }
  for (const s of data.scoops ?? []) {
    totals.cost += s.usage?.cost?.total || 0;
    totals.tokens += s.usage?.totalTokens || 0;
    totals.turns += s.turns || 0;
  }
  return totals;
}

async function spend(leader) {
  const r = await leader.exec('cost --json --all');
  return costTotals(r.status === 0 ? r.stdout : '');
}

/**
 * Screenshot the leader's tabs while the cone works: a tab whose address changed, or whose last
 * capture is older than RECAPTURE_MS. Files stay on the leader until `readShots`.
 */
export function startCapture(
  leader,
  dir,
  { pollMs = POLL_MS, recaptureMs = RECAPTURE_MS, now = Date.now } = {}
) {
  const started = now();
  const shots = [];
  const lastUrl = new Map();
  const lastAt = new Map();
  let seq = 0;
  let running = true;
  let wake = null;
  async function capture(final) {
    for (const t of await tabs(leader)) {
      const at = now();
      if (!final && lastUrl.get(t.id) === t.url && at - (lastAt.get(t.id) ?? 0) < recaptureMs)
        continue;
      seq += 1;
      const path = `${dir}/shot-${String(seq).padStart(3, '0')}.png`;
      const r = await leader.exec(
        `playwright-cli screenshot --tab=${quote(t.id)} --filename=${path} --max-width=1280`
      );
      if (r.status !== 0) continue;
      shots.push({ path, label: `${Math.round((at - started) / 1000)} s into the run, ${t.url}` });
      lastUrl.set(t.id, t.url);
      lastAt.set(t.id, at);
    }
  }
  const loop = (async () => {
    while (running) {
      await capture(false).catch(() => {});
      if (!running) break;
      await new Promise((r) => {
        wake = r;
        setTimeout(r, pollMs);
      });
    }
  })();
  return {
    async stop() {
      running = false;
      wake?.();
      await loop;
      await capture(true).catch(() => {});
      return shots;
    },
  };
}

/** Read captured screenshots back as base64, dropping identical consecutive frames. */
export async function readShots(leader, shots, max = MAX_SCREENSHOTS) {
  const images = [];
  let previous = null;
  for (const s of shots) {
    const r = await leader.exec(`base64 ${quote(s.path)}`);
    if (r.status !== 0) continue;
    const base64 = r.stdout.replace(/\s+/g, '');
    if (!base64 || base64 === previous) continue;
    previous = base64;
    images.push({ label: s.label, format: 'png', base64 });
  }
  return { taken: images.length, images: images.slice(-max) };
}

/** The cone's conversation, as `session export` writes it (TranscriptDocumentV1). */
export async function exportTranscript(leader, dir) {
  const r = await leader.exec(
    `session export --output ${dir}/transcript.zip >/dev/null && mkdir -p ${dir}/transcript && unzip ${dir}/transcript.zip -d ${dir}/transcript >/dev/null && cat ${dir}/transcript/transcript.json`,
    { timeoutMs: 120_000 }
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function clip(text) {
  const s = String(text ?? '');
  return s.length > STEP_CHARS
    ? `${s.slice(0, STEP_CHARS)} … [${s.length - STEP_CHARS} more characters]`
    : s;
}

function describePart(part) {
  if (part?.type === 'text') return part.text;
  if (part?.type === 'tool-call')
    return `→ tool ${part.name}: ${clip(JSON.stringify(part.input ?? {}))}`;
  if (part?.type === 'attachment-ref') return `[attachment ${part.attachmentId}]`;
  return '';
}

/**
 * A transcript's conversations → judge steps (one per message, cone first, then each scoop it
 * delegated to), plus the models that actually answered, for the record.
 */
export function transcriptSteps(doc) {
  const steps = [];
  const models = new Set();
  let assistantTurns = 0;
  const conversations = [...(doc?.conversations ?? [])].sort(
    (a, b) => (a.kind === 'cone' ? 0 : 1) - (b.kind === 'cone' ? 0 : 1)
  );
  for (const c of conversations) {
    const who = c.kind === 'cone' ? 'cone' : `scoop ${c.name ?? c.id}`;
    for (const m of c.messages ?? []) {
      if (m.model?.id) models.add(m.model.id);
      if (m.role === 'assistant' && c.kind === 'cone') assistantTurns += 1;
      const body = (m.content ?? []).map(describePart).filter(Boolean).join('\n');
      const role = m.role === 'tool-result' ? 'tool result' : m.role;
      steps.push(`## ${who} · ${role}\n${clip(body)}`);
    }
  }
  return { steps, models: [...models].sort(), assistantTurns };
}

/** A run's result → the trace shape `judge.mjs` reads. */
export function traceFromResult(result) {
  const t = transcriptSteps(result.transcript);
  const finalResult =
    result.finalText?.trim() ||
    (result.timedOut ? 'The run was stopped at the time limit before the cone answered.' : '') ||
    (result.stderr ? `The run failed: ${result.stderr}` : '');
  return {
    finalResult,
    steps: t.steps.length
      ? t.steps
      : [`(no transcript could be exported; prompt exit code ${result.exitCode})`],
    screenshots: result.screenshots ?? [],
    outputFilesText: null,
    metrics: {
      steps: t.assistantTurns || result.turns || 0,
      duration: result.durationMs / 1000,
      cost: result.costUsd,
      tokens: result.tokens,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      tabs: result.tabs ?? [],
      model: result.modelId ?? null,
      modelsUsed: t.models,
    },
  };
}

/**
 * Run one task on the leader through the `slicc` CLI. Setup failures throw (the run never
 * happened); a failed or timed-out prompt still returns a result the judge can score.
 */
export async function runTask({
  leader,
  task,
  runId,
  model,
  timeoutSeconds = 900,
  readFile = (p) => readFileSync(p),
  capture = {},
  now = Date.now,
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`bad run id ${runId}`);
  const dir = `/tmp/bench/${runId}`;
  const timeout = task.slicc?.timeoutSeconds ?? timeoutSeconds;
  try {
    await must(leader, `rm -rf ${dir} && mkdir -p ${dir}`);
    for (const f of task.slicc?.files ?? []) {
      await must(leader, `mkdir -p ${quote(dirname(f.to))} && base64 -d > ${quote(f.to)}`, {
        stdin: Buffer.from(readFile(f.from)).toString('base64'),
      });
    }
    await closeTabs(leader);
    await mustCli(leader, ['new-session', '--erase']);
    const modelId = (await mustCli(leader, ['model', model])).stdout.trim();
    const before = await spend(leader);

    const started = now();
    const shooter = startCapture(leader, dir, { now, ...capture });
    const reply = await leader.cli(['prompt', '-'], {
      stdin: buildPrompt(task),
      timeoutMs: timeout * 1000,
      interrupt: true,
    });
    const durationMs = now() - started;
    const shots = await shooter.stop();
    const openTabs = (await tabs(leader)).map((t) => t.url);

    const after = await spend(leader);
    const transcript = await exportTranscript(leader, dir);
    const { taken, images } = await readShots(leader, shots);
    return {
      runId,
      model,
      modelId,
      exitCode: reply.status,
      timedOut: Boolean(reply.timedOut),
      finalText: reply.stdout,
      stderr: reply.stderr.slice(-4000),
      durationMs,
      costUsd: after.cost - before.cost,
      tokens: after.tokens - before.tokens,
      turns: after.turns - before.turns,
      transcript,
      tabs: openTabs,
      screenshots: images,
      screenshotsTaken: taken,
    };
  } finally {
    await closeTabs(leader).catch(() => {});
    await leader.cli(['new-session', '--erase']).catch(() => {});
    await leader.exec(`rm -rf ${dir}`).catch(() => {});
  }
}
