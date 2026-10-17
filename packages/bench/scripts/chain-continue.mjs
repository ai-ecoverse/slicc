import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function nextChainInputs(inputs, runId) {
  const out = {};
  for (const [k, v] of Object.entries(inputs ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  out['chain-from'] = String(runId);
  return out;
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

export async function chainContinue({
  repo,
  runId,
  ref,
  inputs,
  token,
  fetchImpl = fetch,
  workflow = 'bench-memory-chain.yml',
}) {
  if (String(inputs?.continue ?? 'true') === 'false')
    return { action: 'skipped', reason: 'continue=false' };
  const api = github(token, fetchImpl);
  const next = nextChainInputs(inputs, runId);
  await api('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    ref,
    inputs: next,
  });
  return {
    action: 'continued',
    reason: `dispatched ${workflow} with chain-from=${runId}`,
  };
}

export function summaryLines(result, runId) {
  if (result.action === 'continued') {
    return [
      '### Memory chain continue',
      `${result.reason} (this run \`${runId}\` holds records + \`memory/CLAUDE.md\` for the next job).`,
    ];
  }
  return ['### Memory chain continue', `Not continued: ${result.reason}.`];
}

/* v8 ignore next 18 */
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const runId = process.env.RUN_ID;
  const result = await chainContinue({
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
