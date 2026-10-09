import { appendFileSync } from 'node:fs';

export const KILLED_PATTERNS = [
  /Process completed with exit code 130\b/,
  /self-hosted runner lost communication with the server/i,
  /Termination requested/,
];

export function killedShards(jobs, annotations) {
  return jobs
    .filter((j) => /^Shard \d+$/.test(j.name ?? '') && j.conclusion === 'failure')
    .filter((j) =>
      (annotations.get(j.id) ?? []).some((m) => KILLED_PATTERNS.some((p) => p.test(m)))
    )
    .map((j) => j.name);
}

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

export function eligible(inputs) {
  return Boolean(inputs) && !String(inputs['auto-resumed-from'] ?? '').trim();
}

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
