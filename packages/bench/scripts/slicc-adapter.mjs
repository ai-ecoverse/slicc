/**
 * The SLICC adapter: run one task on a leader and return what the judge needs.
 *
 * Each task runs as a fresh `agent` scoop (leader/run-task.jsh), not in the cone's chat, so no
 * task sees another's context and the model is chosen per task with `--model`. The prompt is
 * the task text plus upstream's closing instruction (a FINAL ANSWER line, no clarifying
 * questions); how to drive the browser is left to SLICC and whatever skills are installed,
 * because that is what the skills axis measures.
 *
 * Skills are staged per condition by rewriting /workspace/skills: scoops read that directory
 * through the shared filesystem, so `--read-only` cannot hide it. The leader's original skills
 * are stashed once and restored at the end.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEADER_SCRIPT = '/tmp/bench/run-task.jsh';
export const SKILLS_DIR = '/workspace/skills';
export const SKILLS_STASH = '/workspace/.bench-skills-builtin';
export const EXTRA_SKILLS_ROOT = '/workspace/bench-skills';

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

async function must(exec, command, options) {
  const r = await exec(command, options);
  if (r.status !== 0)
    throw new Error(
      `leader: \`${command.slice(0, 120)}\` exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`
    );
  return r;
}

export async function installLeaderScript(
  exec,
  source = readFileSync(join(HERE, '..', 'leader', 'run-task.jsh'), 'utf8')
) {
  await must(exec, `mkdir -p /tmp/bench && cat > ${LEADER_SCRIPT}`, { stdin: source });
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

export async function stageSkills(exec, condition) {
  const r = await must(exec, stageSkillsCommand(condition));
  return Number.parseInt(r.stdout.trim().split('\n').pop(), 10) || 0;
}

export async function restoreSkills(exec) {
  await must(exec, restoreSkillsCommand());
}

/** Split the persisted agent transcript (`## <role>` sections) into judge steps. */
export function parseArchive(markdown) {
  const text = String(markdown ?? '');
  const marker = text.indexOf('\n---');
  const body = marker >= 0 ? text.slice(marker + 4) : text;
  return body
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '---');
}

/** result.json → the trace shape `judge.mjs` reads. */
export function traceFromResult(result) {
  const steps = parseArchive(result.archive);
  const files = (result.outputFiles ?? [])
    .map((f) =>
      f.text == null
        ? `### ${f.path}\n(${f.size ?? '?'} bytes, not inlined)`
        : `### ${f.path}\n${f.text}`
    )
    .join('\n\n');
  const finalResult =
    result.finalText ||
    (result.timedOut ? 'The run was stopped at the time limit before the agent answered.' : '') ||
    (result.stderr ? `The agent failed: ${result.stderr}` : '');
  return {
    finalResult,
    steps: steps.length ? steps : [`(no transcript was saved; agent exit code ${result.exitCode})`],
    screenshots: result.screenshots ?? [],
    outputFilesText: files || null,
    metrics: {
      steps: steps.filter((s) => /^## assistant/i.test(s)).length || result.turns || 0,
      duration: result.durationMs / 1000,
      cost: result.costUsd,
      tokens: result.tokens,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      tabs: result.tabs ?? [],
    },
  };
}

/**
 * Run one task on the leader. Stages any files the task names, writes the prompt, runs
 * run-task.jsh, and reads result.json back. `timeoutSeconds` bounds the agent; the exec gets
 * two extra minutes for the evidence collection after it.
 */
export async function runTask({
  exec,
  task,
  runId,
  model,
  thinking,
  timeoutSeconds = 900,
  readFile = (p) => readFileSync(p),
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`bad run id ${runId}`);
  const dir = `/tmp/bench/${runId}`;
  await must(exec, `rm -rf ${dir} && mkdir -p ${dir}`);
  for (const f of task.slicc?.files ?? []) {
    const bytes = readFile(f.from);
    await must(exec, `mkdir -p ${quote(dirname(f.to))} && base64 -d > ${quote(f.to)}`, {
      stdin: Buffer.from(bytes).toString('base64'),
    });
  }
  await must(exec, `cat > ${dir}/prompt.txt`, { stdin: buildPrompt(task) });
  const words = [LEADER_SCRIPT, runId, model, String(task.slicc?.timeoutSeconds ?? timeoutSeconds)];
  if (thinking) words.push(thinking);
  const ran = await exec(`node ${words.map(quote).join(' ')}`, {
    timeoutMs: ((task.slicc?.timeoutSeconds ?? timeoutSeconds) + 120) * 1000,
  });
  const read = await exec(`cat ${dir}/result.json`, { timeoutMs: 120_000 });
  if (read.status !== 0) {
    throw new Error(
      `run-task.jsh left no result (exit ${ran.status}): ${(ran.stderr || ran.stdout).trim().slice(0, 400)}`
    );
  }
  return JSON.parse(read.stdout);
}
