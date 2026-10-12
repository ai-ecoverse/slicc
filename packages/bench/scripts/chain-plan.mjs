import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasMemoryCheckpoint } from './memory-checkpoint.mjs';
import { loadAndPlan, parseCli, previous, resumeAction } from './run.mjs';

export function memoryRestoredForOut(outDir, env = process.env) {
  return env.BENCH_MEMORY_RESTORED === '1' || hasMemoryCheckpoint(outDir);
}

export function chainResumeCtx(opts, over = {}) {
  return {
    judge: Boolean(opts.judge),
    judgeModel: opts.judgeModel,
    defaultSkills: undefined,
    arm: opts.arm?.name ?? null,
    newSession: opts.newSession,
    memoryRestored: over.memoryRestored ?? memoryRestoredForOut(opts.out),
  };
}

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

export function assertSingleChainConfig(opts) {
  if ((opts.models?.length ?? 0) > 1)
    throw new Error(
      `memory chain allows one --models entry (got ${opts.models.length}: ${opts.models.join(',')})`
    );
  if ((opts.skills?.length ?? 0) > 1)
    throw new Error(
      `memory chain allows one --skills entry (got ${opts.skills.length}: ${opts.skills.map((s) => s.name).join(',')})`
    );
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseCli(argv);
  const log =
    deps.log ??
    ((line) => console.error(`[chain-plan ${new Date().toISOString().slice(11, 19)}] ${line}`));
  assertSingleChainConfig(opts);
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
