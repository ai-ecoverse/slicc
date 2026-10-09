/**
 * Auto-resume a bench run once when Cloud Run took shards away mid-run.
 *
 * Cloud Run replaces worker-pool instances under running jobs (host maintenance): the runner
 * container gets SIGTERM ("Termination requested, stopping runner"), the bench step exits 130,
 * the post-steps still upload the shard's out dir, and GitHub marks the job failed about ten
 * minutes later with "The self-hosted runner lost communication with the server"
 * (2026-10-08 19:23 and 2026-10-09 00:46, three and five shards). The tasks those shards had
 * not finished are part of an approved run, so the `auto-resume` job in bench.yml dispatches
 * the run again with `resume-run` and the run's own inputs: finished runs are skipped, only the
 * lost ones are paid for. It happens once per run: the new run carries `auto-resumed-from`,
 * and a run that has it is never auto-resumed again. Any other failure (a bench error exits 1)
 * is left for a person, and so is a run where one shard was killed and another failed on its
 * own: a resume re-runs every errored run in every shard, so it would retry those too.
 *
 * CLI (bench.yml): GH_TOKEN, GITHUB_REPOSITORY, RUN_ID, REF, INPUTS_JSON (toJSON(inputs)).
 */

import { appendFileSync } from 'node:fs';

/** Annotation texts that mean the shard's runner was taken away, not that the bench failed. */
export const KILLED_PATTERNS = [
  /Process completed with exit code 130\b/,
  /self-hosted runner lost communication with the server/i,
  /Termination requested/,
];

/**
 * The shard jobs that were killed: failed, with an annotation matching {@link KILLED_PATTERNS}.
 * `jobs` are the run's jobs (`name`, `conclusion`, `id`); `annotations` maps a job id to its
 * annotation messages.
 */
export function killedShards(jobs, annotations) {
  return jobs
    .filter((j) => /^Shard \d+$/.test(j.name ?? '') && j.conclusion === 'failure')
    .filter((j) =>
      (annotations.get(j.id) ?? []).some((m) => KILLED_PATTERNS.some((p) => p.test(m)))
    )
    .map((j) => j.name);
}

/**
 * The dispatch inputs for the resume: the run's own inputs as strings (a dispatch takes strings,
 * `toJSON(inputs)` has booleans), `resume-run` set to this run, and `auto-resumed-from` marking it.
 */
export function resumeInputs(inputs, runId) {
  const out = {};
  for (const [k, v] of Object.entries(inputs ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  out['resume-run'] = String(runId);
  out['auto-resumed-from'] = String(runId);
  return out;
}

/** Whether this run may be auto-resumed at all: dispatched, and not itself an auto-resume. */
export function eligible(inputs) {
  return Boolean(inputs) && !String(inputs['auto-resumed-from'] ?? '').trim();
}

/** GitHub REST with the job's token. */
function github(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok)
      throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };
}

/**
 * Decide and, when shards were killed, dispatch the resume. Returns what it did, for the summary:
 * `{ action: 'skipped' | 'none' | 'resumed', killed, reason }`.
 */
export async function autoResume({ repo, runId, ref, inputs, token, fetchImpl = fetch }) {
  if (!eligible(inputs))
    return {
      action: 'skipped',
      killed: [],
      reason: `this run is already an auto-resume of ${inputs?.['auto-resumed-from'] || 'nothing'}`,
    };
  const api = github(token, fetchImpl);
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const r = await api(
      'GET',
      `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`
    );
    jobs.push(...r.jobs);
    if (r.jobs.length < 100) break;
  }
  const annotations = new Map();
  for (const j of jobs) {
    if (!/^Shard \d+$/.test(j.name ?? '') || j.conclusion !== 'failure') continue;
    const list = await api('GET', `/repos/${repo}/check-runs/${j.id}/annotations?per_page=50`);
    annotations.set(
      j.id,
      list.map((a) => a.message ?? '')
    );
  }
  const killed = killedShards(jobs, annotations);
  if (!killed.length)
    return { action: 'none', killed, reason: 'no shard was killed; failures were the bench’s own' };
  const failed = jobs
    .filter((j) => /^Shard \d+$/.test(j.name ?? '') && j.conclusion === 'failure')
    .map((j) => j.name);
  const own = failed.filter((n) => !killed.includes(n));
  if (own.length)
    return {
      action: 'none',
      killed,
      reason: `${killed.join(', ')} lost their runner, but ${own.join(', ')} failed on their own, and a resume would retry those runs too; resume by hand with resume-run=${runId}`,
    };
  await api('POST', `/repos/${repo}/actions/workflows/bench.yml/dispatches`, {
    ref,
    inputs: resumeInputs(inputs, runId),
  });
  return { action: 'resumed', killed, reason: `${killed.join(', ')} lost their runner` };
}

/** The run-summary lines for what happened. */
export function summaryLines(result, runId) {
  if (result.action === 'resumed')
    return [
      '### Auto-resume',
      `${result.reason}: dispatched this run again with \`resume-run=${runId}\` and its own inputs (once; the new run is marked \`auto-resumed-from=${runId}\`).`,
    ];
  return ['### Auto-resume', `Not resumed: ${result.reason}.`];
}

/* v8 ignore next 14 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const runId = process.env.RUN_ID;
  const result = await autoResume({
    repo: process.env.GITHUB_REPOSITORY,
    runId,
    ref: process.env.REF,
    inputs: JSON.parse(process.env.INPUTS_JSON || '{}'),
    token: process.env.GH_TOKEN,
  });
  const lines = summaryLines(result, runId);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
