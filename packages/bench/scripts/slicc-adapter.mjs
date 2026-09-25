import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SKILLS_DIR = '/workspace/skills';
export const SKILLS_STASH = '/workspace/.bench-skills-builtin';
export const EXTRA_SKILLS_ROOT = '/workspace/bench-skills';
export const MAX_SCREENSHOTS = 10;

const POLL_MS = 10_000;
const RECAPTURE_MS = 30_000;
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

export function quote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

function failure(what, r) {
  const err = new Error(
    `${what} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`
  );
  err.leaderDown = Boolean(r.leaderDown);
  return err;
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

export function costTotals(costJson) {
  let data;
  try {
    data = JSON.parse(costJson);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const totals = { cost: 0, tokens: 0, turns: 0 };
  for (const s of data.scoops ?? []) {
    totals.cost += s.usage?.cost?.total || 0;
    totals.tokens += s.usage?.totalTokens || 0;
    totals.turns += s.turns || 0;
  }
  return totals;
}

async function spend(leader) {
  const r = await leader.exec('cost --json --all');
  return r.status === 0 ? costTotals(r.stdout) : null;
}

export function spendDelta(before, after) {
  const unknown = { costUsd: null, tokens: null, turns: null };
  if (!before || !after || after.cost < before.cost - 1e-9) return unknown;
  return {
    costUsd: after.cost - before.cost,
    tokens: after.tokens - before.tokens,
    turns: after.turns - before.turns,
  };
}

export const HEALTH_COMMAND = 'uptime; meminfo 2>&1 | head -4; echo "processes: $(ps | wc -l)"';

export async function leaderHealth(leader, now = Date.now) {
  const started = now();
  const r = await leader.exec(HEALTH_COMMAND, { timeoutMs: 60_000 });
  return {
    at: new Date(started).toISOString(),
    ok: r.status === 0,
    ms: now() - started,
    leaderDown: Boolean(r.leaderDown),
    text: String(r.status === 0 ? r.stdout : r.stderr)
      .trim()
      .slice(0, 600),
  };
}

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
      ...(result.phases ? { phases: result.phases } : {}),
    },
  };
}

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
  const t0 = now();
  const health = { before: await leaderHealth(leader, now) };
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
    if (reply.leaderDown) throw failure('slicc prompt', reply);
    const openTabs = (await tabs(leader)).map((t) => t.url);

    await closeTabs(leader).catch(() => {});

    const after = await spend(leader);
    const transcript = await exportTranscript(leader, dir);
    const { taken, images } = await readShots(leader, shots);
    health.after = await leaderHealth(leader, now);
    const done = now();
    return {
      runId,
      model,
      modelId,
      exitCode: reply.status,
      timedOut: Boolean(reply.timedOut),
      finalText: reply.stdout,
      stderr: reply.stderr.slice(-4000),
      durationMs,
      ...spendDelta(before, after),
      transcript,
      tabs: openTabs,
      screenshots: images,
      screenshotsTaken: taken,
      phases: {
        setupMs: started - t0,
        promptMs: durationMs,
        collectMs: done - started - durationMs,
      },
      health,
    };
  } finally {
    await closeTabs(leader).catch(() => {});
    await leader.cli(['new-session', '--erase']).catch(() => {});
    await leader.exec(`rm -rf ${dir}`).catch(() => {});
  }
}
