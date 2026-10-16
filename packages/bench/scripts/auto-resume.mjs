import { appendFileSync } from 'node:fs';

export const KILLED_PATTERNS = [
  /Process completed with exit code 130\b/,
  /self-hosted runner lost communication with the server/i,
  /Termination requested/,
];

export const DEADLINE_PATTERNS = [
  /past the deadline for another run; \d+ run\(s\) left for a resume/,
];

export function shardsMatching(jobs, annotations, patterns) {
  return jobs
    .filter((j) => /^Shard \d+$/.test(j.name ?? '') && j.conclusion === 'failure')
    .filter((j) => (annotations.get(j.id) ?? []).some((m) => patterns.some((p) => p.test(m))))
    .map((j) => j.name);
}

export function killedShards(jobs, annotations) {
  return shardsMatching(jobs, annotations, KILLED_PATTERNS);
}

export function deadlineShards(jobs, annotations) {
  return shardsMatching(jobs, annotations, DEADLINE_PATTERNS);
}

export const ANNOTATION_NOISE_PATTERNS = [/^Process completed with exit code \d+\.?$/];

function isResumeSignal(message) {
  return [...KILLED_PATTERNS, ...DEADLINE_PATTERNS].some((p) => p.test(message));
}

function isAnnotationNoise(message) {
  const text = String(message ?? '').trim();

  if (!text) return true;
  return ANNOTATION_NOISE_PATTERNS.some((p) => p.test(text));
}

export function ownFailureShards(jobs, annotations) {
  return jobs
    .filter((j) => /^Shard \d+$/.test(j.name ?? '') && j.conclusion === 'failure')
    .filter((j) => {
      const messages = annotations.get(j.id) ?? [];
      const hasResumeSignal = messages.some((m) => isResumeSignal(m));
      const hasOtherError = messages.some((m) => !isResumeSignal(m) && !isAnnotationNoise(m));

      const failedPostStep = (j.steps ?? []).some(
        (step) => step.conclusion === 'failure' && step.name !== 'Run and judge'
      );
      return !hasResumeSignal || hasOtherError || failedPostStep;
    })
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

export function eligible(inputs, { allowDeadlineChain = false } = {}) {
  if (!inputs) return false;
  if (!String(inputs['auto-resumed-from'] ?? '').trim()) return true;
  return allowDeadlineChain;
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
    const messages = [];
    for (let page = 1; ; page += 1) {
      const list = await api(
        'GET',
        `/repos/${repo}/check-runs/${j.id}/annotations?per_page=100&page=${page}`
      );
      messages.push(...list.map((a) => a.message ?? ''));
      if (list.length < 100) break;
    }
    annotations.set(j.id, messages);
  }
  const killed = killedShards(jobs, annotations);
  const deadline = deadlineShards(jobs, annotations);
  const resumable = [...new Set([...killed, ...deadline])];
  if (!resumable.length)
    return {
      action: 'none',
      killed,
      deadline,
      reason: 'no shard was killed or stopped on the deadline; failures were the bench’s own',
    };
  if (!eligible(inputs, { allowDeadlineChain: deadline.length > 0 }))
    return {
      action: 'skipped',
      killed,
      deadline,
      reason: `this run is already an auto-resume of ${inputs?.['auto-resumed-from'] || 'nothing'} (kill resumes once; deadline leftovers may chain)`,
    };
  const own = ownFailureShards(jobs, annotations);
  if (own.length)
    return {
      action: 'none',
      killed,
      deadline,
      reason:
        `${resumable.join(', ')} can resume, but ${own.join(', ')} failed on their own, ` +
        `and a resume would retry those runs too; resume by hand with resume-run=${runId}`,
    };
  await api('POST', `/repos/${repo}/actions/workflows/bench.yml/dispatches`, {
    ref,
    inputs: resumeInputs(inputs, runId),
  });
  const parts = [];
  if (killed.length) parts.push(`${killed.join(', ')} lost their runner`);
  if (deadline.length) parts.push(`${deadline.join(', ')} stopped on the deadline with runs left`);
  return { action: 'resumed', killed, deadline, reason: parts.join('; ') };
}

export function summaryLines(result, runId) {
  if (result.action === 'resumed') {
    const chain =
      (result.deadline?.length ?? 0) > 0
        ? 'deadline leftovers may chain on later windows'
        : 'once; kill resumes do not chain';
    return [
      '### Auto-resume',
      `${result.reason}: dispatched this run again with \`resume-run=${runId}\` and its own inputs (${chain}; marked \`auto-resumed-from=${runId}\`).`,
    ];
  }
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
