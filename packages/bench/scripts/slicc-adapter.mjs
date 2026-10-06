import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cutBefore } from './judge.mjs';

export const SKILLS_DIR = '/workspace/skills';
export const SKILLS_STASH = '/workspace/.bench-skills-builtin';
export const EXTRA_SKILLS_ROOT = '/workspace/bench-skills';
export const MAX_SCREENSHOTS = 10;

export const PROMPT_ALL_SETTLED = '2m';

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

export const ARM_SKILL_SET = 'arm';

export const ARM_THINKING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export const ARM_TIME_MARGIN_S = 60;

export const ARM_FILES_MAX_BYTES = 32 * 1024 * 1024;

export function validateArm(name, arm) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(String(name))) errors.push(`arm name ${name} must be a-z0-9.-`);
  if (!arm || typeof arm !== 'object') return [...errors, `arm ${name} is not an object`];
  if (typeof arm.command !== 'string' || !/^[a-z][a-z0-9-]*( |$)/.test(arm.command))
    errors.push(`arm ${name}: command must start with a command name`);
  if (!Array.isArray(arm.skills) || !arm.skills.every((x) => /^[a-z0-9][a-z0-9-]*$/.test(x)))
    errors.push(`arm ${name}: skills must be skill directory names`);
  if (
    arm.setup != null &&
    !(Array.isArray(arm.setup) && arm.setup.every((x) => typeof x === 'string' && x))
  )
    errors.push(`arm ${name}: setup must be a list of commands`);
  for (const p of [arm.files, ...(arm.scratch ?? [])].filter((x) => x != null))
    if (!/^\/tmp\/[A-Za-z0-9._/-]+$/.test(String(p)) || String(p).includes('..'))
      errors.push(`arm ${name}: files and scratch must be plain paths under /tmp`);
  return errors;
}

export function armCommand(arm, { goalFile, model, timeoutSeconds }) {
  const { alias, thinking } = parseModelSpec(model);
  const limit = Math.max(60, timeoutSeconds - ARM_TIME_MARGIN_S);

  if (!ARM_THINKING_LEVELS.includes(thinking))
    throw new Error(
      `an arm's agent takes thinking ${ARM_THINKING_LEVELS.filter((l) => l !== 'default').join(', ')}, not ${thinking}`
    );
  const level = thinking === 'default' ? '' : ` --thinking ${quote(thinking)}`;
  return `${arm.command} --model ${quote(alias)}${level} --time-limit ${limit} --json --goal-file ${quote(goalFile)}`;
}

export function driverAnswer(files) {
  const text = (name) => {
    const f = (files ?? []).find((x) => x.path.endsWith(name));
    return f ? Buffer.from(f.base64, 'base64').toString('utf8') : null;
  };

  const full = text('/answer.txt');
  if (full?.trim()) return full.trim();
  const md = text('/transcript.md');
  const last = md
    ? driverSections(md)
        .filter((x) => x.role === 'assistant' && x.text)
        .at(-1)
    : null;
  return last?.text ?? '';
}

export function armAnswer(files) {
  const own = driverAnswer(files);
  if (own) return own;
  const f = (files ?? []).find((x) => x.path.endsWith('/result.json'));
  if (!f) return '';
  try {
    return String(JSON.parse(Buffer.from(f.base64, 'base64').toString('utf8'))?.answer ?? '');
  } catch {
    return '';
  }
}

export function driverSections(md) {
  const out = [];
  let cur = null;
  for (const line of String(md).split('\n')) {
    const m = /^## (user|assistant|tool result|tool|prompt)\b/i.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { role: m[1].toLowerCase(), lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out.map((x) => {
    const body = x.lines.join('\n');
    const text = (x.role === 'assistant' ? body.split(/\n### tool:/)[0] : body).trim();
    return { role: x.role, text, body: body.trim() };
  });
}

export function driverSteps(files) {
  const f = (files ?? []).find((x) => x.path.endsWith('/transcript.md'));
  if (!f) return [];
  return driverSections(Buffer.from(f.base64, 'base64').toString('utf8'))
    .filter((x) => x.role !== 'prompt')
    .map((x) => `## scoop · ${x.role}\n${clip(x.body)}`);
}

export function parseArmResult(stdout) {
  const lines = String(stdout ?? '')
    .trim()
    .split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines.slice(i).join('\n');
    if (!text.trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(text);
    } catch {}
  }
  return null;
}

export function armConversation(doc, since = 0) {
  let best = null;
  for (const c of doc?.conversations ?? []) {
    if (c.kind === 'cone') continue;
    const last = (c.messages ?? []).filter((m) => m.role === 'assistant').at(-1);
    if (!last) continue;
    const at = Number(last.timestamp ?? 0);
    if (since && !(at >= since)) continue;
    if (!best || at >= best.at) best = { at, c };
  }
  return best?.c ?? null;
}

const textOf = (m) =>
  (m?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
    .trim();

export function lastScoopAssistantText(doc, since = 0) {
  const msgs = (armConversation(doc, since)?.messages ?? []).filter((m) => m.role === 'assistant');
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const text = textOf(msgs[i]);
    if (text) return text;
  }
  return '';
}

export async function collectArmFiles(leader, root, { maxBytes = ARM_FILES_MAX_BYTES } = {}) {
  const listing = await leader.exec(`find ${quote(root)} -type f 2>/dev/null | sort`);
  if (listing.status !== 0) return { files: [], truncated: false };
  const files = [];
  let total = 0;
  let truncated = false;
  for (const path of listing.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) continue;
    const r = await leader.exec(`base64 ${quote(path)}`);
    if (r.status !== 0) continue;
    const base64 = r.stdout.replace(/\s+/g, '');
    if (total + base64.length > maxBytes) {
      truncated = true;
      break;
    }
    total += base64.length;
    files.push({ path, base64 });
  }
  return { files, truncated };
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

const PROTECTED_DIRS = new Set(['/', '/workspace', '/shared', '/tmp', '/home', '/scoops', '/mnt']);

export async function planStagedCleanup(leader, files) {
  if (!files.length) return [];
  const probe = files
    .map(
      (f) =>
        `d=${quote(dirname(f.to))}; t=; while [ ! -d "$d" ]; do t="$d"; d=$(dirname "$d"); done; ` +
        `if [ -n "$t" ]; then echo "dir $t"; elif [ -e ${quote(f.to)} ]; then echo existing; else echo new; fi`
    )
    .join('; ');
  const lines = (await must(leader, probe)).stdout.split('\n');
  return files.map((f, i) => {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('dir ')) {
      const dir = line.slice(4);
      return PROTECTED_DIRS.has(dir) ? null : dir;
    }
    return line === 'new' ? f.to : null;
  });
}

export function stagedCleanupPaths(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  return unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(`${q}/`)));
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

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function lastTurnProviderError(result) {
  const agent = result?.arm
    ? armConversation(result?.transcript, result.arm.startedAt ?? 0)
    : (result?.transcript?.conversations ?? []).filter((c) => c.kind === 'cone').at(-1);
  const last = (agent?.messages ?? []).filter((m) => m.role === 'assistant').at(-1);
  if (last?.stopReason === 'error')
    return String(last.errorMessage ?? last.error ?? 'provider error').slice(0, 300);
  return result?.arm ? armAgentDied(result) : null;
}

function armAgentDied(result) {
  const code = result.arm.result?.exitCode;
  if (!code || String(result.finalText ?? '').trim()) return null;
  return `the arm's agent exited ${code} without an answer`;
}

export function parseModelSpec(spec) {
  const text = String(spec).trim();
  const at = text.lastIndexOf('@');
  if (at === -1) return { spec: text, alias: text, thinking: 'default' };
  const alias = text.slice(0, at);
  const thinking = text.slice(at + 1);
  if (!alias || (thinking !== 'default' && !THINKING_LEVELS.includes(thinking))) {
    throw new Error(
      `model spec ${JSON.stringify(text)} must be an alias or alias@level (${[...THINKING_LEVELS, 'default'].join(', ')})`
    );
  }
  return { spec: text, alias, thinking };
}

export async function prepareModel(leader, model) {
  const spec = parseModelSpec(model);
  const modelId = (await mustCli(leader, ['model', spec.alias])).stdout.trim();
  const args = spec.thinking === 'default' ? ['thinking'] : ['thinking', spec.thinking];
  const thinkingEffective = (await mustCli(leader, args)).stdout.trim();
  if (spec.thinking !== 'default' && thinkingEffective !== spec.thinking) {
    throw new Error(
      `slicc thinking resolved ${spec.thinking} to ${thinkingEffective || 'unknown'}`
    );
  }
  return { spec, modelId, thinkingEffective };
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

export const FLAGS_PROBE = 'command -v flags';
export const NO_DEFAULT_SKILLS_MISSING =
  "this SLICC build can't run the none condition (no no-default-skills flag); pin a webapp that has it with pin-webapp, or wait for a release";

export function skillsFlagCommand(condition) {
  return `flags set no-default-skills ${condition.builtin ? 'off' : 'on'}`;
}

export function listSkillNamesCommand(dir) {
  return `ls ${quote(dir)} || true`;
}

export function parseSkillNames(text) {
  return [
    ...new Set(
      String(text ?? '')
        .split(/\s+/)
        .filter(Boolean)
    ),
  ].sort();
}

export function expectedSkillNames(condition, { builtin = [], extras = [] } = {}) {
  const names = new Set(condition.builtin ? builtin : []);
  for (const list of extras) for (const name of list) names.add(name);
  return [...names].sort();
}

function showNames(names) {
  if (names.length === 0) return '(empty)';
  if (names.length > 40) return `${names.slice(0, 40).join(', ')}, … (${names.length})`;
  return names.join(', ');
}

export function skillsMismatch(condition, actual, expected) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length === e.length && a.every((name, i) => name === e[i])) return null;
  return (
    `skills condition ${condition.name}: /workspace/skills has ${showNames(a)} after new-session; ` +
    `expected ${showNames(e)}. Bundled skills were re-seeded, or the staged set did not stick.`
  );
}

export function stageSkillsCommand(condition) {
  const steps = [
    `if [ ! -d ${SKILLS_STASH} ]; then mkdir -p ${SKILLS_STASH} && cp -r ${SKILLS_DIR}/. ${SKILLS_STASH}/; fi`,
    `rm -rf ${SKILLS_DIR}`,
    `mkdir -p ${SKILLS_DIR}`,
  ];
  if (condition.builtin) steps.push(`cp -r ${SKILLS_STASH}/. ${SKILLS_DIR}/`);

  for (const extra of condition.extras)
    steps.push(
      `for s in ${EXTRA_SKILLS_ROOT}/${extra}/*; do [ -e "$s" ] || continue; n=$(basename "$s"); rm -rf "${SKILLS_DIR}/$n" && cp -r "$s" "${SKILLS_DIR}/$n" || exit 1; done`
    );
  steps.push(`ls ${SKILLS_DIR} | wc -l`);
  return steps.join(' && ');
}

export function restoreSkillsCommand() {
  return `if [ -d ${SKILLS_STASH} ]; then rm -rf ${SKILLS_DIR} && mkdir -p ${SKILLS_DIR} && cp -r ${SKILLS_STASH}/. ${SKILLS_DIR}/; fi`;
}

async function leaderHasFlags(leader) {
  const probe = await leader.exec(FLAGS_PROBE);
  if (probe.leaderDown) throw failure(`leader: \`${FLAGS_PROBE}\``, probe);
  return probe.status === 0;
}

async function applySkillsFlag(leader, condition) {
  if (!(await leaderHasFlags(leader))) {
    if (!condition.builtin) throw new Error(NO_DEFAULT_SKILLS_MISSING);
    return;
  }
  await must(leader, skillsFlagCommand(condition));
}

export async function stageSkills(leader, condition) {
  await applySkillsFlag(leader, condition);
  const r = await must(leader, stageSkillsCommand(condition));
  return Number.parseInt(r.stdout.trim().split('\n').pop(), 10) || 0;
}

export async function restoreSkills(leader) {
  await must(leader, restoreSkillsCommand());
  if (await leaderHasFlags(leader)) await must(leader, skillsFlagCommand({ builtin: true }));
}

async function skillNames(leader, dir) {
  const r = await must(leader, listSkillNamesCommand(dir));
  return parseSkillNames(r.stdout);
}

export async function assertStagedSkills(leader, condition) {
  const actual = await skillNames(leader, SKILLS_DIR);
  const builtin = condition.builtin ? await skillNames(leader, SKILLS_STASH) : [];
  const extras = [];
  for (const extra of condition.extras) {
    extras.push(await skillNames(leader, `${EXTRA_SKILLS_ROOT}/${extra}`));
  }
  const mismatch = skillsMismatch(
    condition,
    actual,
    expectedSkillNames(condition, { builtin, extras })
  );
  if (mismatch) throw new Error(mismatch);
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

async function spend(leader, timeoutMs) {
  const r = await leader.exec('cost --json --all', timeoutMs ? { timeoutMs } : undefined);
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
  if (r.aborted) return 'aborted';
  return `exit ${r.status}`;
}

const overBudget = (last) => ({
  stage: 'budget',
  reason: 'out of time',
  ...(last ? { detail: `${last.stage}: ${last.reason}` } : {}),
});

async function runExport(leader, command, info, { partBytes, timeoutMs, attempts, left, signal }) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) return { failure: { stage: 'export', reason: 'aborted' } };
    if (left() < MIN_CALL_MS) return { failure: overBudget(failure) };
    info.exports = attempt;
    const r = await leader.exec(command, { timeoutMs: Math.min(timeoutMs, left()), signal });
    if (r.status !== 0) {
      failure = { stage: 'export', reason: callFailure(r), detail: clipDetail(r) };
      if (r.timedOut || r.aborted || signal?.aborted || (r.leaderDown && !r.connectionLost)) break;
      continue;
    }
    const listing = parseExportListing(r.stdout, partBytes);
    if (listing) return { listing };
    failure = { stage: 'export', reason: 'listing', detail: String(r.stdout).trim().slice(-200) };
  }
  return { failure };
}

async function readPart(leader, part, info, { timeoutMs, attempts, left, signal }) {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) return { failure: { stage: 'read', reason: 'aborted' } };
    if (left() < MIN_CALL_MS) return { failure: overBudget(failure) };
    info.reads += 1;
    const r = await leader.exec(`base64 ${quote(part.path)}`, {
      timeoutMs: Math.min(timeoutMs, left()),
      signal,
    });
    if (r.status !== 0) {
      failure = { stage: 'read', reason: callFailure(r), detail: clipDetail(r) };

      if (r.aborted || signal?.aborted || (r.leaderDown && !r.connectionLost)) break;
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
    signal,
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
    signal,
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
      signal,
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
  if (s.length <= STEP_CHARS) return s;
  const end = cutBefore(s, STEP_CHARS);
  return `${s.slice(0, end)} … [${s.length - end} more characters]`;
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

export function lastConeAssistantText(doc) {
  const conversations = (doc?.conversations ?? []).filter((c) => c.kind === 'cone');
  for (const conversation of conversations.reverse()) {
    for (const message of [...(conversation.messages ?? [])].reverse()) {
      if (message.role !== 'assistant') continue;
      return (message.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
        .trim();
    }
  }
  return '';
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

export const armTurns = (doc, files, since = 0) =>
  driverSteps(files).filter((x) => x.startsWith('## scoop · assistant')).length ||
  (armConversation(doc, since)?.messages ?? []).filter((m) => m.role === 'assistant').length;

export function traceFromResult(result) {
  const t = transcriptSteps(result.transcript);

  if (result.arm) {
    const steps = driverSteps(result.arm.files);
    if (steps.length) t.steps = steps;
  }
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
      steps:
        (result.arm
          ? armTurns(result.transcript, result.arm.files, result.arm.startedAt ?? 0)
          : t.assistantTurns) ||
        result.turns ||
        0,
      duration: result.durationMs / 1000,
      cost: result.costUsd,
      tokens: result.tokens,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      ...(result.costCapped ? { cost_capped: true } : {}),
      ...(result.resumedAfterSettle ? { resumed_after_settle: true } : {}),
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

export const BUSY_PROBE_MS = 20_000;

export const STOP_PROBE_INTERVALS = 6;

export const STOP_PROBE_BUDGET_MS = 3 * 60 * 1000;

export const STOP_PROBE_READ_TIMEOUT_MS = 15_000;

export async function stillWorking(leader, reply, { probeMs = BUSY_PROBE_MS, sleep }) {
  if (reply.status !== 0 || reply.timedOut || reply.aborted) return false;
  if (String(reply.stdout ?? '').trim()) return false;
  const first = await spend(leader);
  await sleep(probeMs);
  const second = await spend(leader);
  if (!first || !second) return false;

  return spendRising(first, second);
}

function spendRising(before, after) {
  return (
    after.cost > before.cost + 1e-9 || after.tokens > before.tokens || after.turns > before.turns
  );
}

export async function awaitQuiescent(
  leader,
  {
    probeMs = BUSY_PROBE_MS,
    sleep,
    maxIntervals = STOP_PROBE_INTERVALS,
    budgetMs = STOP_PROBE_BUDGET_MS,
    readTimeoutMs = STOP_PROBE_READ_TIMEOUT_MS,
    now = Date.now,
  } = {}
) {
  const deadline = now() + budgetMs;
  let previous = null;
  let latest = null;
  let failures = 0;

  for (let attempt = 0; attempt <= maxIntervals && now() < deadline; attempt += 1) {
    const remaining = deadline - now();
    const reading = await spend(leader, Math.min(readTimeoutMs, Math.max(1, remaining)));
    if (!reading) failures += 1;
    else {
      latest = reading;
      if (previous && !spendRising(previous, reading)) {
        return { stopped: true, spend: reading, failures };
      }
      previous = reading;
    }
    if (attempt === maxIntervals) break;
    const gap = deadline - now();
    if (gap <= 0) break;
    await sleep(Math.min(probeMs, gap));
  }
  return { stopped: false, spend: latest, failures };
}

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
      const now = await spend(leader, STOP_PROBE_READ_TIMEOUT_MS);
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

async function waitForResumedAgent(leader, deadline, now, signal) {
  const remaining = deadline - now();
  if (signal?.aborted) return { limit: 'cost', at: now() };
  if (remaining <= 0) return { limit: 'timeout', at: deadline };
  const settled = await leader.cli(['wait', '--allsettled', PROMPT_ALL_SETTLED], {
    timeoutMs: remaining,
    signal,
  });
  if (signal?.aborted) return { limit: 'cost', at: now() };
  if (settled.timedOut || now() >= deadline) return { limit: 'timeout', at: deadline };
  if (settled.status !== 0) {
    const err = new Error('agent resumed after settle and did not settle before the task timeout');
    err.stillWorking = true;
    err.leaderDown = Boolean(settled.leaderDown);
    throw err;
  }
  return { after: await spend(leader), at: now() };
}

async function abortResumedAgent(
  leader,
  { busyProbeMs, stopProbeIntervals, stopProbeBudgetMs, sleep, now }
) {
  const stopped = await leader.cli(['abort'], { timeoutMs: 30_000 });
  if (stopped.status !== 0 || stopped.leaderDown) {
    const err = new Error('agent resumed after settle and the leader did not confirm abort');
    err.stillWorking = true;
    err.leaderDown = Boolean(stopped.leaderDown);
    throw err;
  }
  const quiet = await awaitQuiescent(leader, {
    probeMs: busyProbeMs,
    maxIntervals: stopProbeIntervals,
    budgetMs: stopProbeBudgetMs,
    sleep,
    now,
  });
  if (!quiet.stopped) {
    const err = new Error('agent resumed after settle and kept working after abort');
    err.stillWorking = true;
    err.leaderDown = true;
    throw err;
  }
  return quiet.spend;
}

function markRecoveryLimit(state, reason, at) {
  state.stopReason = reason;
  state.stoppedAt = at;
}

function applyRecoveryWait(state, waited) {
  if (waited.limit) {
    markRecoveryLimit(state, waited.limit, waited.at);
    return;
  }
  state.after = waited.after;
  state.settledAt = waited.at;
  state.resumedAfterSettle = true;
}

async function needsRecoveryWait(ctx, state, signal) {
  const unseenFinal = lastConeAssistantText(state.transcript);
  const absentFromPrompt = Boolean(
    ctx.checkPrompt && unseenFinal && !String(ctx.reply.stdout ?? '').includes(unseenFinal)
  );
  const observedAfterExport = state.transcriptExport.ok ? await spend(ctx.leader) : null;
  const stillWorkingAfterExport = Boolean(
    (state.after && observedAfterExport && spendRising(state.after, observedAfterExport)) ||
      ((absentFromPrompt || state.resumedAfterSettle) && (!state.after || !observedAfterExport))
  );
  if (observedAfterExport) state.after = observedAfterExport;
  if (signal.aborted) {
    markRecoveryLimit(state, 'cost', ctx.now());
    return false;
  }
  const exportTimedOut = !state.transcriptExport.ok && state.transcriptExport.reason === 'timeout';
  if (exportTimedOut && ++state.exportTimeouts > 1) {
    const err = new Error('session export timed out again after the agent settled');
    err.stillWorking = true;
    throw err;
  }
  if (!stillWorkingAfterExport && absentFromPrompt) state.resumedAfterSettle = true;
  return exportTimedOut || stillWorkingAfterExport;
}

async function collectRecoveryExport(ctx, state, signal) {
  if (signal.aborted) {
    markRecoveryLimit(state, 'cost', ctx.now());
    return false;
  }
  if (!state.after) state.after = await spend(ctx.leader);
  if (
    ctx.checkPrompt &&
    ctx.before &&
    state.after &&
    ctx.maxCost > 0 &&
    state.after.cost - ctx.before.cost > ctx.maxCost
  ) {
    markRecoveryLimit(state, 'cost', ctx.now());
    return false;
  }
  const budgetMs = ctx.checkPrompt
    ? Math.min(TRANSCRIPT_BUDGET_MS, Math.max(0, ctx.deadline - ctx.now()))
    : TRANSCRIPT_BUDGET_MS;
  if (ctx.checkPrompt && budgetMs < MIN_CALL_MS) {
    markRecoveryLimit(state, 'timeout', ctx.deadline);
    return false;
  }
  ({ doc: state.transcript, info: state.transcriptExport } = await exportTranscript(
    ctx.leader,
    ctx.dir,
    { now: ctx.now, budgetMs, signal }
  ));
  if (signal.aborted) {
    markRecoveryLimit(state, 'cost', ctx.now());
    return false;
  }
  if (ctx.checkPrompt && ctx.now() >= ctx.deadline && !state.transcript) {
    markRecoveryLimit(state, 'timeout', ctx.deadline);
    return false;
  }
  return needsRecoveryWait(ctx, state, signal);
}

async function collectAfterPrompt({
  leader,
  dir,
  reply,
  after,
  checkPrompt,
  busyProbeMs,
  sleep,
  deadline,
  now,
  before,
  maxCost,
  costPollMs,
  stopProbeIntervals,
  stopProbeBudgetMs,
}) {
  const ctx = { leader, dir, reply, checkPrompt, deadline, now, before, maxCost };
  const state = {
    after,
    resumedAfterSettle: false,
    stopReason: null,
    stoppedAt: null,
    settledAt: null,
    transcript: null,
    transcriptExport: null,
    exportTimeouts: 0,
  };
  const recoveryAbort = new AbortController();
  const watcher =
    maxCost > 0 ? watchSpend(leader, before, maxCost, recoveryAbort, costPollMs) : null;
  try {
    if (checkPrompt && (await stillWorking(leader, reply, { probeMs: busyProbeMs, sleep }))) {
      applyRecoveryWait(
        state,
        await waitForResumedAgent(leader, deadline, now, recoveryAbort.signal)
      );
    }
    while (!state.stopReason) {
      const needsWait = await collectRecoveryExport(ctx, state, recoveryAbort.signal);
      if (!needsWait) break;
      applyRecoveryWait(
        state,
        await waitForResumedAgent(leader, deadline, now, recoveryAbort.signal)
      );
    }
    if (state.stopReason) {
      await watcher?.stop();
      state.after = await abortResumedAgent(leader, {
        busyProbeMs,
        stopProbeIntervals,
        stopProbeBudgetMs,
        sleep,
        now,
      });
      state.resumedAfterSettle = true;
      ({ doc: state.transcript, info: state.transcriptExport } = await exportTranscript(
        leader,
        dir,
        {
          now,
        }
      ));
    }
  } finally {
    await watcher?.stop();
  }
  if (state.resumedAfterSettle && !state.transcript) {
    const err = new Error(
      `agent settled but its final transcript could not be exported: ${state.transcriptExport.stage ?? 'unknown'} ${state.transcriptExport.reason ?? 'unknown'}`
    );
    err.stillWorking = true;
    throw err;
  }
  return {
    after: state.after,
    transcript: state.transcript,
    transcriptExport: state.transcriptExport,
    resumedAfterSettle: state.resumedAfterSettle,
    timedOut: state.stopReason === 'timeout',
    costCapped: state.stopReason === 'cost',
    stoppedAt: state.stoppedAt,
    settledAt: state.settledAt,
  };
}

async function prepareArmRun(leader, arm, dir, task) {
  if (!arm) return null;
  for (const p of [arm.files, ...(arm.scratch ?? [])].filter(Boolean))
    await must(leader, `rm -rf ${quote(p)}`);
  const goalFile = `${dir}/goal.txt`;
  await must(leader, `base64 -d > ${quote(goalFile)}`, {
    stdin: Buffer.from(buildPrompt(task)).toString('base64'),
  });
  return goalFile;
}

function startAgent(leader, { arm, goalFile, task, model, timeout, signal }) {
  const opts = { timeoutMs: timeout * 1000, interrupt: true, signal };
  return arm
    ? leader.exec(armCommand(arm, { goalFile, model, timeoutSeconds: timeout }), opts)
    : leader.cli(['prompt', '--allsettled', PROMPT_ALL_SETTLED, '-'], {
        stdin: buildPrompt(task),
        ...opts,
      });
}

async function collectArmRun(leader, arm, reply, transcript, started) {
  if (!arm) return null;
  const files = arm.files ? await collectArmFiles(leader, arm.files) : null;
  return {
    finalText:
      driverAnswer(files?.files) ||
      lastScoopAssistantText(transcript, started) ||
      armAnswer(files?.files),
    record: {
      arm: {
        name: arm.name ?? null,
        startedAt: started,
        result: parseArmResult(reply.stdout),
        files: files?.files ?? [],
        filesTruncated: Boolean(files?.truncated),
      },
    },
  };
}

const agentLabel = (arm) => (arm ? `arm ${arm.name ?? ''}`.trim() : 'slicc prompt');

const waitsForCone = (arm, interrupted) => !interrupted && !arm;

function finalTextOf(armOut, { resumedAfterSettle, transcript, reply }) {
  if (armOut) return armOut.finalText;
  return resumedAfterSettle ? lastConeAssistantText(transcript) : reply.stdout;
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
  busyProbeMs = BUSY_PROBE_MS,
  stopProbeIntervals = STOP_PROBE_INTERVALS,
  stopProbeBudgetMs = STOP_PROBE_BUDGET_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  condition = null,
  arm = null,
}) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`bad run id ${runId}`);
  const dir = `/tmp/bench/${runId}`;
  const timeout = task.slicc?.timeoutSeconds ?? timeoutSeconds;
  const t0 = now();
  const health = { before: await leaderHealth(leader, now) };
  const staged = [];
  try {
    await must(leader, `rm -rf ${dir} && mkdir -p ${dir}`);
    const goalFile = await prepareArmRun(leader, arm, dir, task);
    const files = task.slicc?.files ?? [];
    const leaves = await planStagedCleanup(leader, files);
    for (const [i, f] of files.entries()) {
      await must(leader, `mkdir -p ${quote(dirname(f.to))} && base64 -d > ${quote(f.to)}`, {
        stdin: Buffer.from(readFile(f.from)).toString('base64'),
      });

      staged.push(leaves[i]);
    }
    await closeTabs(leader);
    await mustCli(leader, ['new-session', '--erase']);
    if (condition) await assertStagedSkills(leader, condition);
    const prepared = await prepareModel(leader, model);
    const before = await spend(leader);

    const started = now();
    const shooter = startCapture(leader, dir, { now, ...capture });
    const abort = new AbortController();
    const watcher = maxCost > 0 ? watchSpend(leader, before, maxCost, abort, costPollMs) : null;
    const reply = await startAgent(leader, {
      arm,
      goalFile,
      task,
      model,
      timeout,
      signal: abort.signal,
    });
    const durationMs = now() - started;
    await watcher?.stop();
    const shots = await shooter.stop();
    if (reply.leaderDown) throw failure(agentLabel(arm), reply);
    const interrupted = Boolean(reply.timedOut || reply.aborted || reply.status === 130);

    let after = null;
    if (interrupted) {
      const quiet = await awaitQuiescent(leader, {
        probeMs: busyProbeMs,
        sleep,
        maxIntervals: stopProbeIntervals,
        budgetMs: stopProbeBudgetMs,
        now,
      });
      if (!quiet.stopped) {
        const err = new Error(
          quiet.failures > 0 && !quiet.spend
            ? `slicc prompt was interrupted after ${Math.round(durationMs / 1000)} s and the leader stopped answering cost`
            : `slicc prompt was interrupted after ${Math.round(durationMs / 1000)} s but the agent kept working (its spend kept rising)`
        );
        err.stillWorking = true;

        err.leaderDown = true;
        throw err;
      }
      after = quiet.spend;
    }
    const openTabs = (await tabs(leader)).map((t) => t.url);
    const collected = await collectAfterPrompt({
      leader,
      dir,
      reply,
      after,

      checkPrompt: waitsForCone(arm, interrupted),
      busyProbeMs,
      sleep,
      deadline: started + timeout * 1000,
      now,
      before,
      maxCost,
      costPollMs,
      stopProbeIntervals,
      stopProbeBudgetMs,
    });
    after = collected.after;
    const { transcript, transcriptExport, resumedAfterSettle } = collected;
    await closeTabs(leader).catch(() => {});
    const { taken, images } = await readShots(leader, shots);
    const armOut = await collectArmRun(leader, arm, reply, transcript, started);
    health.after = await leaderHealth(leader, now);
    const done = now();
    return {
      runId,
      model: prepared.spec.spec,
      modelId: prepared.modelId,
      thinking: prepared.spec.thinking,
      thinkingEffective: prepared.thinkingEffective,
      exitCode: collected.timedOut || collected.costCapped ? 130 : reply.status,
      timedOut: Boolean(reply.timedOut || collected.timedOut),
      costCapped: Boolean(reply.aborted || collected.costCapped),
      finalText: finalTextOf(armOut, { resumedAfterSettle, transcript, reply }),
      ...armOut?.record,
      stderr: reply.stderr.slice(-4000),
      durationMs: resumedAfterSettle
        ? (collected.stoppedAt ?? collected.settledAt ?? done) - started
        : durationMs,
      ...spendDelta(before, after),
      transcript,
      transcriptExport,
      resumedAfterSettle,
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
    const leftovers = stagedCleanupPaths(staged);
    if (leftovers.length)
      await leader.exec(`rm -rf ${leftovers.map(quote).join(' ')}`).catch(() => {});
    await leader.exec(`rm -rf ${dir}`).catch(() => {});
  }
}
