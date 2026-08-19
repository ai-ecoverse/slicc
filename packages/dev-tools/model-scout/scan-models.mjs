#!/usr/bin/env node
/*
 * Bedrock model scout — orchestrator (I/O).
 *
 * Reads `.github/workflows/`, derives every Bedrock model ID those workflows can
 * reach, invokes each distinct ID once with a minimal 1-token request, and writes
 * the verdict to $GITHUB_OUTPUT plus a Markdown report the workflow files as an
 * issue. All rules live in `lib.mjs`; this file only does I/O.
 *
 * Deliberately not an agent: no Claude, no PR, no writes to any variable or
 * workflow. It is a canary, and a canary must be boring.
 *
 * Env:
 *   AWS_BEARER_TOKEN_BEDROCK   Bedrock API key (bearer token)        (required)
 *   AWS_REGION                 Bedrock region                        (default us-east-1)
 *   <NAME>_BEDROCK_MODEL       current value of each workflow model variable.
 *                              Actions tokens cannot read repository variables
 *                              through the API (hard 403), so the workflow
 *                              interpolates `${{ vars.X }}` into env. A variable
 *                              found in a workflow but absent here is a hard
 *                              error: it means the canary is not watching it.
 *   WORKFLOWS_DIR              default .github/workflows
 *   REPORT_FILE                default model-scout-report.md
 *   PROBE_ATTEMPTS             attempts per inconclusive ID          (default 3)
 *   PROBE_BACKOFF_MS           first backoff, doubling               (default 2000)
 *
 * Exit 0 on a clean verdict (including "everything is fine"); non-zero on missing
 * env, an un-probed variable, or an unreadable workflow directory.
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReport,
  classifyProbeResult,
  extractModelReferences,
  INCONCLUSIVE,
  resolveProbeTargets,
  summarizeResults,
} from './lib.mjs';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2000;

// The cheapest request that still proves the model answers: one token out.
const PROBE_PAYLOAD = {
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'ping' }],
};

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// This scout's own workflow names every variable in its env block, so counting it
// as a consumer would list it beside the agent that actually calls the model and
// make the "consumed by" line in the issue useless.
const SELF_WORKFLOW = 'model-scout.yml';

/** @param {string} dir @returns {Array<{name: string, text: string}>} */
function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .filter((name) => name !== SELF_WORKFLOW)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** All `*_BEDROCK_MODEL` keys the workflow passed in, however many are set. */
function modelEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.endsWith('_BEDROCK_MODEL'))
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One `InvokeModel` attempt. A transport failure is returned, not thrown, so the
 * classifier can call it inconclusive rather than the run dying on one bad DNS
 * lookup.
 */
async function probeOnce({ modelId, region, token }) {
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(PROBE_PAYLOAD),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    return classifyProbeResult({ modelId, status: res.status, body, headers: res.headers });
  } catch (err) {
    return classifyProbeResult({ modelId, networkError: err });
  }
}

/**
 * Probe with retries, because throttling is transient and a false `invalid` is
 * the expensive error: it tells a human to change a working variable. Only
 * `inconclusive` is retried; `ok` and `invalid` are already definite.
 */
async function probeWithRetry({ modelId, region, token, attempts, backoffMs }) {
  let verdict;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = await probeOnce({ modelId, region, token });
    if (verdict.classification !== INCONCLUSIVE) {
      return { ...verdict, attempts: attempt };
    }
    if (attempt < attempts) {
      const wait = backoffMs * 2 ** (attempt - 1);
      console.log(`   ↻ inconclusive (${verdict.evidence}) — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  return { ...verdict, attempts };
}

function logReferences(references, resolved) {
  console.log(`Variables referenced by workflows (${references.variables.length}):`);
  for (const variable of references.variables) {
    console.log(`  ${variable.name} ← ${variable.workflows.join(', ')}`);
  }
  console.log(`Hardcoded model-ID defaults (${references.literals.length}):`);
  for (const literal of references.literals) {
    console.log(`  ${literal.value} ← ${literal.workflows.join(', ')}`);
  }
  if (resolved.unsetVariables.length) {
    console.log(
      `Unset in this repo (chain falls through, expected): ${resolved.unsetVariables.join(', ')}`
    );
  }
}

function failOnUnwatchedVariables(missingEnv) {
  if (!missingEnv.length) {
    return;
  }
  console.error(
    `❌ ${missingEnv.length} model variable(s) are referenced by a workflow but were not passed to the scout: ${missingEnv.join(', ')}.`
  );
  console.error(
    '   Add them to the env block of .github/workflows/model-scout.yml as `NAME: ${{ vars.NAME }}`.'
  );
  console.error(
    '   Failing loudly on purpose: an unwatched variable is exactly the blind spot this check exists to close.'
  );
  process.exit(3);
}

async function main() {
  const token = requireEnv('AWS_BEARER_TOKEN_BEDROCK');
  const region = (process.env.AWS_REGION ?? '').trim() || DEFAULT_REGION;
  const workflowsDir = (process.env.WORKFLOWS_DIR ?? '').trim() || '.github/workflows';
  const reportFile = (process.env.REPORT_FILE ?? '').trim() || 'model-scout-report.md';
  const attempts = Number(process.env.PROBE_ATTEMPTS) || DEFAULT_ATTEMPTS;
  const backoffMs = Number(process.env.PROBE_BACKOFF_MS) || DEFAULT_BACKOFF_MS;

  const references = extractModelReferences(readWorkflows(workflowsDir));
  const resolved = resolveProbeTargets({ references, env: modelEnv() });
  logReferences(references, resolved);
  failOnUnwatchedVariables(resolved.missingEnv);

  console.log(`\nProbing ${resolved.targets.length} distinct model ID(s) in ${region}:`);
  const results = [];
  for (const target of resolved.targets) {
    const verdict = await probeWithRetry({
      modelId: target.modelId,
      region,
      token,
      attempts,
      backoffMs,
    });
    results.push({ ...target, ...verdict });
    const icon = { ok: '✅', invalid: '❌', inconclusive: '⚠️' }[verdict.classification];
    console.log(`  ${icon} ${target.modelId} → ${verdict.classification} (${verdict.evidence})`);
  }

  const report = buildReport({ results, region });
  const summary = summarizeResults(results);
  if (report.shouldFile) {
    writeFileSync(reportFile, `${report.body}\n`);
  }

  setOutput('has_invalid', summary.anyInvalid ? 'true' : 'false');
  setOutput('ok_count', String(summary.ok));
  setOutput('invalid_count', String(summary.invalid));
  setOutput('inconclusive_count', String(summary.inconclusive));
  setOutput('all_inconclusive', summary.allInconclusive ? 'true' : 'false');
  setOutput('issue_title', report.title);
  setOutput('report_file', reportFile);

  console.log(
    `\n${summary.ok} ok, ${summary.invalid} unusable, ${summary.inconclusive} inconclusive.`
  );
  if (summary.allInconclusive) {
    console.log(
      '⚠️  BLIND RUN: every probe was inconclusive (throttling, quota, IAM, or 5xx). Nothing is filed — no model was proven dead — but this run verified nothing. Check the Bedrock API key and its quota; a canary that cannot see is worse than none.'
    );
  } else if (summary.anyInvalid) {
    console.log(`❌ Unusable model IDs found — issue will be raised. Report: ${reportFile}`);
  } else {
    console.log('✅ Every reachable model ID answered. Nothing to file.');
  }
}

main().catch((err) => {
  console.error(`❌ Bedrock model scout failed: ${err.message?.split('\n')[0] ?? err}`);
  process.exit(1);
});
