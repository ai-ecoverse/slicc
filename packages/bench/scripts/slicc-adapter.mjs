import { createHash } from 'node:crypto';
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

export const TRANSCRIPT_PART_BYTES = 3 * 1024 * 1024;

export const TRANSCRIPT_EXPORT_TIMEOUT_MS = 600_000;
export const TRANSCRIPT_READ_TIMEOUT_MS = 120_000;
export const TRANSCRIPT_EXPORT_ATTEMPTS = 2;
export const TRANSCRIPT_READ_ATTEMPTS = 3;

export const TRANSCRIPT_BUDGET_MS = 15 * 60_000;

const MIN_CALL_MS = 5_000;

export function exportTranscriptCommand(dir, partBytes = TRANSCRIPT_PART_BYTES) {
  const t = `${dir}/transcript`;
  return [
    `session export --output ${dir}/transcript.zip >/dev/null`,
    `rm -rf ${t}`,
    `mkdir -p ${t}/parts`,
    `unzip ${dir}/transcript.zip -d ${t} >/dev/null`,
    `split -b ${partBytes} ${t}/transcript.json ${t}/parts/x`,
    `wc -c ${t}/transcript.json`,
    `sha256sum ${t}/transcript.json ${t}/parts/*`,
  ].join(' && ');
}

export function parseExportListing(text, partBytes = TRANSCRIPT_PART_BYTES) {
  const lines = String(text ?? '').split('\n');
  let bytes = null;
  let sha256 = null;
  const parts = [];
  for (const line of lines) {
    const size = /^\s*(\d{1,15})\s+\S*\/transcript\.json\s*$/.exec(line);
    if (size) bytes = Number(size[1]);
    const hash = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (!hash) continue;
    if (hash[2].endsWith('/transcript.json')) sha256 = hash[1];
    else if (/\/parts\/x[a-z]+$/.test(hash[2])) parts.push({ path: hash[2], sha256: hash[1] });
  }
  if (!bytes || !sha256) return null;
  parts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (parts.length !== Math.ceil(bytes / partBytes)) return null;
  for (const [i, p] of parts.entries()) {
    p.bytes = i < parts.length - 1 ? partBytes : bytes - partBytes * (parts.length - 1);
  }
  return { bytes, sha256, parts };
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

export function decodeTranscriptPart(stdout, part) {
  const text = String(stdout ?? '').replace(/\s+/g, '');
  if (!text) return { error: 'empty' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return { error: 'not base64' };
  const buf = Buffer.from(text, 'base64');
  if (buf.length !== part.bytes) return { error: `${buf.length} of ${part.bytes} bytes` };
  if (sha256Hex(buf) !== part.sha256) return { error: 'checksum mismatch' };
  return { buf };
}

const clipDetail = (r) =>
  String(r.stderr || r.stdout || '')
    .trim()
    .slice(-200);

function callFailure(r) {
  if (r.leaderDown) return 'leader-down';
  if (r.timedOut) return 'timeout';
  return `exit ${r.status}`;
}

const overBudget = (last) => ({
  stage: 'budget',
  reason: 'out of time',
  ...(last ? { detail: `${last.stage}: ${last.reason}` } : {}),
});

async function runExport(leader, command, info, { partBytes, timeoutMs, attempts, left }) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (left() < MIN_CALL_MS) return { failure: overBudget(failure) };
    info.exports = attempt;
    const r = await leader.exec(command, { timeoutMs: Math.min(timeoutMs, left()) });
    if (r.status !== 0) {
      failure = { stage: 'export', reason: callFailure(r), detail: clipDetail(r) };
      if (r.timedOut || (r.leaderDown && !r.connectionLost)) break;
      continue;
    }
    const listing = parseExportListing(r.stdout, partBytes);
    if (listing) return { listing };
    failure = { stage: 'export', reason: 'listing', detail: String(r.stdout).trim().slice(-200) };
  }
  return { failure };
}

async function readPart(leader, part, info, { timeoutMs, attempts, left }) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (left() < MIN_CALL_MS) return { failure: overBudget(failure) };
    info.reads += 1;
    const r = await leader.exec(`base64 ${quote(part.path)}`, {
      timeoutMs: Math.min(timeoutMs, left()),
    });
    if (r.status !== 0) {
      failure = { stage: 'read', reason: callFailure(r), detail: clipDetail(r) };

      if (r.leaderDown && !r.connectionLost) break;
      continue;
    }
    const decoded = decodeTranscriptPart(r.stdout, part);
    if (decoded.buf) return { buf: decoded.buf };
    failure = { stage: 'read', reason: decoded.error };
  }
  return { failure };
}

export async function exportTranscript(
  leader,
  dir,
  {
    partBytes = TRANSCRIPT_PART_BYTES,
    exportTimeoutMs = TRANSCRIPT_EXPORT_TIMEOUT_MS,
    readTimeoutMs = TRANSCRIPT_READ_TIMEOUT_MS,
    exportAttempts = TRANSCRIPT_EXPORT_ATTEMPTS,
    readAttempts = TRANSCRIPT_READ_ATTEMPTS,
    budgetMs = TRANSCRIPT_BUDGET_MS,
    now = Date.now,
  } = {}
) {
  const started = now();
  const left = () => started + budgetMs - now();
  const info = { ok: false, bytes: null, parts: 0, exports: 0, reads: 0, ms: 0 };
  const done = (doc, failure) => {
    info.ms = now() - started;
    if (failure) Object.assign(info, failure);
    else info.ok = true;
    return { doc, info };
  };

  const command = exportTranscriptCommand(dir, partBytes);
  const exported = await runExport(leader, command, info, {
    partBytes,
    timeoutMs: exportTimeoutMs,
    attempts: exportAttempts,
    left,
  });
  if (exported.failure) return done(null, exported.failure);
  const { listing } = exported;
  info.bytes = listing.bytes;
  info.parts = listing.parts.length;

  const bufs = [];
  for (const part of listing.parts) {
    const read = await readPart(leader, part, info, {
      timeoutMs: readTimeoutMs,
      attempts: readAttempts,
      left,
    });
    if (read.failure) return done(null, read.failure);
    bufs.push(read.buf);
  }

  const whole = Buffer.concat(bufs);
  if (whole.length !== listing.bytes || sha256Hex(whole) !== listing.sha256) {
    return done(null, { stage: 'verify', reason: 'checksum mismatch' });
  }
  let doc;
  try {
    doc = JSON.parse(whole.toString('utf8'));
  } catch {
    return done(null, { stage: 'parse', reason: 'not JSON' });
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.conversations)) {
    return done(null, { stage: 'parse', reason: 'not a transcript' });
  }
  return done(doc);
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

export function toolKind(part) {
  const target = String(part.input?.command ?? part.input?.path ?? part.input?.file ?? '');
  if (/SKILL\.md|\/skills\//.test(target)) return 'skill';
  if (part.name !== 'bash') return /file|edit|write|read/i.test(part.name) ? 'file' : 'other';
  if (/playwright-cli|\bbrowser\b|screenshot|tab-(list|new|close)/.test(target)) return 'browser';
  if (/\b(curl|wget|http|fetch)\b/.test(target)) return 'fetch';
  if (/\b(python3?|node|jq|awk|sed|grep)\b/.test(target)) return 'code';
  return 'shell';
}

const TOOL_KINDS = ['browser', 'fetch', 'code', 'shell', 'file', 'skill', 'other'];

export function toolUsage(doc) {
  const conversations = doc?.conversations ?? [];
  const turns = conversations.reduce(
    (n, c) => n + (c.messages ?? []).filter((m) => m.role === 'assistant').length,
    0
  );
  if (!turns) return null;
  const kinds = Object.fromEntries(TOOL_KINDS.map((k) => [k, 0]));
  for (const c of conversations)
    for (const m of c.messages ?? [])
      for (const p of m.content ?? []) if (p.type === 'tool-call') kinds[toolKind(p)] += 1;
  const calls = Object.values(kinds).reduce((a, b) => a + b, 0);
  return {
    toolCalls: calls,
    toolKinds: kinds,
    webCalls: kinds.browser + kinds.fetch,
    answeredWithoutTools: calls === 0,
  };
}

export function toolMetrics(transcript) {
  const u = toolUsage(transcript);
  return {
    tool_calls: u?.toolCalls ?? null,
    tool_kinds: u?.toolKinds ?? null,
    web_calls: u?.webCalls ?? null,
    answered_without_tools: u ? u.answeredWithoutTools : null,
  };
}

export function transcriptSummary(info) {
  const { detail: _detail, ...summary } = info;
  return summary;
}

export function traceFromResult(result) {
  const t = transcriptSteps(result.transcript);
  const finalResult =
    result.finalText?.trim() ||
    (result.timedOut ? 'The run was stopped at the time limit before the cone answered.' : '') ||
    (result.costCapped ? 'The run was stopped at its cost cap before the cone answered.' : '') ||
    (result.stderr ? `The run failed: ${result.stderr}` : '');
  const ex = result.transcriptExport;
  const why = ex && !ex.ok ? `: ${ex.stage} ${ex.reason}` : '';
  return {
    finalResult,
    steps: t.steps.length
      ? t.steps
      : [`(no transcript could be exported${why}; prompt exit code ${result.exitCode})`],
    screenshots: result.screenshots ?? [],
    outputFilesText: null,
    metrics: {
      steps: t.assistantTurns || result.turns || 0,
      duration: result.durationMs / 1000,
      cost: result.costUsd,
      tokens: result.tokens,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      ...(result.costCapped ? { cost_capped: true } : {}),
      tabs: result.tabs ?? [],
      model: result.modelId ?? null,
      modelsUsed: t.models,
      ...toolMetrics(result.transcript),
      ...(result.phases ? { phases: result.phases } : {}),
      ...(ex ? { transcript: transcriptSummary(ex) } : {}),
    },
  };
}

export const COST_POLL_MS = 30_000;

export function watchSpend(leader, before, maxCost, abort, pollMs = COST_POLL_MS) {
  let running = true;
  let wake = null;
  const loop = (async () => {
    while (running && !abort.signal.aborted) {
      await new Promise((r) => {
        wake = r;
        setTimeout(r, pollMs);
      });
      if (!running) break;
      const now = await spend(leader);
      if (before && now && now.cost - before.cost > maxCost) abort.abort();
    }
  })();
  return {
    async stop() {
      running = false;
      wake?.();
      await loop;
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
  maxCost = 0,
  costPollMs = COST_POLL_MS,
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
    const abort = new AbortController();
    const watcher = maxCost > 0 ? watchSpend(leader, before, maxCost, abort, costPollMs) : null;
    const reply = await leader.cli(['prompt', '-'], {
      stdin: buildPrompt(task),
      timeoutMs: timeout * 1000,
      interrupt: true,
      signal: abort.signal,
    });
    const durationMs = now() - started;
    await watcher?.stop();
    const shots = await shooter.stop();
    if (reply.leaderDown) throw failure('slicc prompt', reply);
    const openTabs = (await tabs(leader)).map((t) => t.url);

    await closeTabs(leader).catch(() => {});

    const after = await spend(leader);
    const { doc: transcript, info: transcriptExport } = await exportTranscript(leader, dir, {
      now,
    });
    const { taken, images } = await readShots(leader, shots);
    health.after = await leaderHealth(leader, now);
    const done = now();
    return {
      runId,
      model,
      modelId,
      exitCode: reply.status,
      timedOut: Boolean(reply.timedOut),
      costCapped: Boolean(reply.aborted),
      finalText: reply.stdout,
      stderr: reply.stderr.slice(-4000),
      durationMs,
      ...spendDelta(before, after),
      transcript,
      transcriptExport,
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
