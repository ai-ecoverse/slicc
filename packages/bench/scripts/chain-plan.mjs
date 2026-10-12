/**
 * Pick the next planned run for a one-task-per-job memory chain, and emit GitHub Actions
 * outputs (`next_task`, `action`, `done`, `left`, `total`, `complete`).
 *
 *   node packages/bench/scripts/chain-plan.mjs --set bu-v2 --tasks @bu-v2-explore-40 \
 *     --models claude-sonnet-5 --skills builtin --new-session save --out bench-out
 *
 * Uses the same plan and `resumeAction` rules as `run.mjs`. A non-empty
 * `<out>/memory/CLAUDE.md` (or `BENCH_MEMORY_RESTORED=1`) lets save/skip skip scored tasks.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasMemoryCheckpoint } from './memory-checkpoint.mjs';
import { loadAndPlan, parseCli, previous, resumeAction } from './run.mjs';

/** Whether this out dir (or env) has a restored memory chain for save/skip skips. */
export function memoryRestoredForOut(outDir, env = process.env) {
  return env.BENCH_MEMORY_RESTORED === '1' || hasMemoryCheckpoint(outDir);
}

/**
 * Resume context shared by pick/progress: judge flags and memory restore.
 * @param {object} opts parseCli result
 * @param {{ memoryRestored?: boolean }} [over]
 */
export function chainResumeCtx(opts, over = {}) {
  return {
    judge: Boolean(opts.judge),
    judgeModel: opts.judgeModel,
    defaultSkills: undefined, // filled per run
    arm: opts.arm?.name ?? null,
    newSession: opts.newSession,
    memoryRestored: over.memoryRestored ?? memoryRestoredForOut(opts.out),
  };
}

/**
 * First planned run that is not `done` under resumeAction, or null when the chain is complete.
 */
export function pickNextChainRun(runs, opts, { memoryRestored } = {}) {
  const base = chainResumeCtx(opts, { memoryRestored });
  for (const r of runs) {
    const before = previous(opts, r);
    const action = resumeAction(before.record, r.task, {
      ...base,
      defaultSkills: Boolean(r.condition.builtin),
      traceExists: before.traceExists,
    });
    if (action !== 'done') {
      return {
        complete: false,
        taskId: r.task.id,
        action,
        model: r.model,
        skills: r.condition.name,
        repeat: r.repeat,
      };
    }
  }
  return {
    complete: true,
    taskId: '',
    action: 'done',
    model: '',
    skills: '',
    repeat: 0,
  };
}

/** Counts of done vs left under the same resume rules. */
export function chainProgress(runs, opts, { memoryRestored } = {}) {
  const base = chainResumeCtx(opts, { memoryRestored });
  let done = 0;
  for (const r of runs) {
    const before = previous(opts, r);
    const action = resumeAction(before.record, r.task, {
      ...base,
      defaultSkills: Boolean(r.condition.builtin),
      traceExists: before.traceExists,
    });
    if (action === 'done') done += 1;
  }
  return { done, left: runs.length - done, total: runs.length };
}

/** `$GITHUB_OUTPUT` / stdout lines for a pick + progress snapshot. */
export function githubOutputLines(pick, progress, memoryRestored) {
  return [
    `complete=${pick.complete}`,
    `next_task=${pick.taskId}`,
    `action=${pick.action}`,
    `model=${pick.model}`,
    `skills=${pick.skills}`,
    `repeat=${pick.repeat}`,
    `done=${progress.done}`,
    `left=${progress.left}`,
    `total=${progress.total}`,
    `memory_restored=${memoryRestored}`,
  ];
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseCli(argv);
  const log =
    deps.log ??
    ((line) => console.error(`[chain-plan ${new Date().toISOString().slice(11, 19)}] ${line}`));
  const runs = await loadAndPlan(opts, deps, log);
  const memoryRestored = memoryRestoredForOut(opts.out);
  const pick = pickNextChainRun(runs, opts, { memoryRestored });
  const progress = chainProgress(runs, opts, { memoryRestored });
  const lines = githubOutputLines(pick, progress, memoryRestored);
  log(
    pick.complete
      ? `chain complete: ${progress.done}/${progress.total} done`
      : `next ${pick.taskId} (${pick.action}); ${progress.done}/${progress.total} done, memory_restored=${memoryRestored}`
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      pick.complete
        ? `### Memory chain\nComplete: ${progress.done}/${progress.total} runs done.\n`
        : `### Memory chain\nNext: \`${pick.taskId}\` (${pick.action}). Progress: ${progress.done}/${progress.total}. Memory checkpoint: ${memoryRestored ? 'yes' : 'no'}.\n`
    );
  }
  return 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 7 */
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`chain-plan: ${err.message}`);
      process.exit(1);
    }
  );
}
