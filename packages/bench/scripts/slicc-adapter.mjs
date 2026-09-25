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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SKILLS_DIR = '/workspace/skills';
export const SKILLS_STASH = '/workspace/.bench-skills-builtin';
export const EXTRA_SKILLS_ROOT = '/workspace/bench-skills';
export const MAX_SCREENSHOTS = 10;
// Each poll is a fresh follower connection, so capture stays sparse: every 10 s, and an unchanged
// tab again after 30 s.
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

/** Shell-quote one word for the leader's bash. */
export function quote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/** A failed leader call as an Error; `leaderDown` marks one that never reached the leader. */
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

/**
 * Sum every unit's spend in `cost --json --all` — the cone and all scoops. Null when the output
 * is not the cost report, so a failed reading is never mistaken for zero spend.
 */
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

/**
 * Spend across the prompt. Unknown (null fields) when either reading failed, or when the
 * counters went backwards: the leader reset them, so the difference measures nothing.
 */
export function spendDelta(before, after) {
  const unknown = { costUsd: null, tokens: null, turns: null };
  if (!before || !after || after.cost < before.cost - 1e-9) return unknown;
  return {
    costUsd: after.cost - before.cost,
    tokens: after.tokens - before.tokens,
    turns: after.turns - before.turns,
  };
}

/** What the leader says about itself: page age and load, memory, and its process count. */
export const HEALTH_COMMAND = 'uptime; meminfo 2>&1 | head -4; echo "processes: $(ps | wc -l)"';

/** A health reading, never throwing: `{ at, ok, ms, text }`, text clipped. */
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

/**
 * Transcript transfer bounds. One `slicc exec` delivers its whole stdout as one tray message, and
 * the tray drops a message over 8 MiB without an error: the CLI exits 0 with empty stdout, which
 * a 6.3 MB `cat` already hits. So the file is split on the leader and read back in parts whose
 * base64 stays far below that ceiling.
 */
export const TRANSCRIPT_PART_BYTES = 3 * 1024 * 1024;
/** `session export` of a long run's session can take minutes (120 s was not enough). */
export const TRANSCRIPT_EXPORT_TIMEOUT_MS = 600_000;
export const TRANSCRIPT_READ_TIMEOUT_MS = 120_000;
export const TRANSCRIPT_EXPORT_ATTEMPTS = 2;
export const TRANSCRIPT_READ_ATTEMPTS = 3;
/**
 * All of a transcript's collection, export and reads with their retries: without a cap, slow
 * reads of a large transcript kept one BU V1 run collecting for 113 minutes (2026-09-25).
 */
export const TRANSCRIPT_BUDGET_MS = 15 * 60_000;
/** A call with less time left than this is not started. */
const MIN_CALL_MS = 5_000;

/**
 * The shell command that exports the session and splits transcript.json into parts, then prints
 * the file's size and the sha256 of the file and of every part.
 */
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

/**
 * The export listing → `{ bytes, sha256, parts: [{ path, sha256, bytes }] }`, or null when it is
 * incomplete: no size or file hash, or fewer or more parts than the size calls for.
 */
export function parseExportListing(text, partBytes = TRANSCRIPT_PART_BYTES) {
  const lines = String(text ?? '').split('\n');
  let bytes = null;
  let sha256 = null;
  const parts = [];
  for (const line of lines) {
    // At most 15 digits, so an all-digit sha256 line is never read as the size.
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

/**
 * One part's `base64` output → its bytes, or the reason it is not the part the listing named:
 * not base64, the wrong length (a truncated transfer), or the wrong hash.
 */
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

/** Why a leader call failed, as a short code for the journal. */
function callFailure(r) {
  if (r.leaderDown) return 'leader-down';
  if (r.timedOut) return 'timeout';
  return `exit ${r.status}`;
}

/** The budget ran out; keeps the last call's failure as the detail. */
const overBudget = (last) => ({
  stage: 'budget',
  reason: 'out of time',
  ...(last ? { detail: `${last.stage}: ${last.reason}` } : {}),
});

/**
 * Run the export until it prints a complete listing: `{ listing }` or `{ failure }`. A timed-out
 * export is not repeated (it would only time out again), nor one that never reached the leader.
 */
async function runExport(leader, command, info, { partBytes, timeoutMs, attempts, left }) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (left() < MIN_CALL_MS) return { failure: overBudget(failure) };
    info.exports = attempt;
    const r = await leader.exec(command, { timeoutMs: Math.min(timeoutMs, left()) });
    if (r.status !== 0) {
      failure = { stage: 'export', reason: callFailure(r), detail: clipDetail(r) };
      if (r.timedOut || r.leaderDown) break;
      continue;
    }
    const listing = parseExportListing(r.stdout, partBytes);
    if (listing) return { listing };
    failure = { stage: 'export', reason: 'listing', detail: String(r.stdout).trim().slice(-200) };
  }
  return { failure };
}

/** Read one part until it arrives intact: `{ buf }` or `{ failure }`. */
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
      // The CLI already retried the dial; a leader that stays unreachable will not send the rest.
      if (r.leaderDown) break;
      continue;
    }
    const decoded = decodeTranscriptPart(r.stdout, part);
    if (decoded.buf) return { buf: decoded.buf };
    failure = { stage: 'read', reason: decoded.error };
  }
  return { failure };
}

/**
 * The cone's conversation, as `session export` writes it (TranscriptDocumentV1), read back in
 * verified parts. Returns `{ doc, info }`; `doc` is null when no intact transcript arrived, and
 * `info` says why: `{ ok, bytes, parts, exports, reads, ms, stage?, reason?, detail? }`. Never
 * throws for a leader failure.
 *
 * A failed export is tried again, unless it timed out or never reached the leader; a part that
 * fails to arrive intact (a dropped connection, a short or corrupted read) is read again. All
 * of it shares `budgetMs`: each call gets at most what is left, and none starts on less than 5 s.
 */
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
    // No detail: JSON.parse quotes the text it choked on, and that can be task text.
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

/** What a tool call did, as a coarse category: the command or path itself is never kept. */
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

/**
 * How a run used tools, from its exported transcript: every conversation, cone and scoops.
 * Counts only; no command text. Null when there is no transcript to count from (a failed export
 * is unknown, never "no tools"). `answeredWithoutTools` marks a run that answered without a
 * single tool call: the agent answered from what it already knew.
 */
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

/** The record fields for a run's tool use: nulls when there is no transcript. */
export function toolMetrics(transcript) {
  const u = toolUsage(transcript);
  return {
    tool_calls: u?.toolCalls ?? null,
    tool_kinds: u?.toolKinds ?? null,
    web_calls: u?.webCalls ?? null,
    answered_without_tools: u ? u.answeredWithoutTools : null,
  };
}

/** The export's outcome for a record: codes and counts, never the leader's stderr. */
export function transcriptSummary(info) {
  const { detail: _detail, ...summary } = info;
  return summary;
}

/** A run's result → the trace shape `judge.mjs` reads. */
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

/** How often the cost cap reads the leader's spend while a prompt runs. */
export const COST_POLL_MS = 30_000;

/**
 * Stop a prompt that spends more than `maxCost` dollars: poll `cost --json --all` against the
 * reading taken before it, and abort once the difference passes the cap. A reading that fails is
 * skipped, never taken as zero. `stop()` ends the polling.
 */
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

/**
 * Run one task on the leader through the `slicc` CLI. Setup failures throw (the run never
 * happened), and so does a prompt that never reached the leader: both carry `leaderDown` when
 * the leader was unreachable. A failed or timed-out prompt that did reach the leader still
 * returns a result the judge can score. `phases` times setup, prompt and collection, and
 * `health` holds the leader's own readings before and after, for diagnosing a failing leader.
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
    // Close what the cone left open before the slower collection: a live page left running
    // keeps the leader busy.
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
