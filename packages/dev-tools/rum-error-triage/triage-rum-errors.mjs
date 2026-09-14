#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { buildErrorQuery, DEFAULT_HOSTS, parseFingerprints, selectNewCandidates } from './lib.mjs';

const SINCE_DAYS = Number(process.env.SINCE_DAYS) || 1;

const envHosts = (process.env.SLICC_RUM_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const HOSTS = envHosts.length ? envHosts : DEFAULT_HOSTS;
const PROJECT = process.env.RUM_BQ_PROJECT || 'helix-225321';
const LABEL = process.env.TRIAGE_LABEL || 'rum-error';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'rum-error-candidates.json';

function queryErrors() {
  const sql = buildErrorQuery({ sinceDays: SINCE_DAYS, hosts: HOSTS });
  const out = execFileSync(
    'bq',
    [
      'query',
      `--project_id=${PROJECT}`,
      '--use_legacy_sql=false',
      '--format=json',
      '--max_rows=1000',
      sql,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out.trim() || '[]');

  return Array.isArray(parsed) ? parsed.flatMap((x) => (Array.isArray(x) ? x : [x])) : [];
}

function fetchExistingFingerprints() {
  try {
    const out = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--label',
        LABEL,
        '--state',
        'all',
        '--limit',
        '500',
        '--json',
        'number,body',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    return parseFingerprints(JSON.parse(out.trim() || '[]'));
  } catch (err) {
    console.warn(
      `⚠️  Could not list existing "${LABEL}" issues (treating as none): ${err.message?.split('\n')[0]}`
    );
    return new Set();
  }
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  console.log(
    `🔎 Querying RUM for SLICC errors over the last ${SINCE_DAYS} day(s) on [${HOSTS.join(', ')}]…`
  );
  const rows = queryErrors();
  console.log(`   ${rows.length} raw error row(s) returned.`);

  const existing = fetchExistingFingerprints();
  console.log(`   ${existing.size} error fingerprint(s) already have an issue.`);

  const candidates = selectNewCandidates(rows, existing);
  writeFileSync(OUTPUT_PATH, JSON.stringify(candidates, null, 2));

  setOutput('count', String(candidates.length));
  setOutput('has_candidates', candidates.length > 0 ? 'true' : 'false');

  if (candidates.length === 0) {
    console.log('✅ No new actionable errors. Nothing to triage.');
    return;
  }
  console.log(`\n🆕 ${candidates.length} new error candidate(s) → ${OUTPUT_PATH}:`);
  for (const c of candidates) {
    const detail = (c.exampleTarget || c.exampleSource || c.signature).slice(0, 90);
    console.log(`   • [${c.float}] ${c.fingerprint.slice(0, 8)}  ×${c.estimated} (est)  ${detail}`);
  }
}

main();
