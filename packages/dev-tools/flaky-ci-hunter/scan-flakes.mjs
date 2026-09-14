#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptsFromPulls,
  buildDigest,
  buildPrompt,
  CONFIG,
  createdRangeParam,
  dayWindows,
  extractFailureLines,
  FIX_BRANCH_PREFIX,
  filterCandidates,
  findAttemptFlips,
  findMainRegressionFlips,
  isDefaultBranchRef,
  jobKey,
  localizeFlake,
  matchMitigatedInfra,
  scoreCandidates,
  windowStart,
  withinWindow,
} from './lib.mjs';

const API = 'https://api.github.com';
const DEFAULT_DIGEST_FILE = 'flaky-ci-digest.md';
const PER_PAGE = 100;

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

function envInt(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createRestApi(repo, token) {
  let calls = 0;
  const get = async (path, { text = false } = {}) => {
    calls += 1;
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'slicc-flaky-ci-hunter',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${path} → ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return text ? res.text() : res.json();
  };

  return {
    calls: () => calls,
    listRunsPage: (day, page) =>
      get(
        `/repos/${repo}/actions/runs?${createdRangeParam(day)}&per_page=${PER_PAGE}&page=${page}`
      ),
    listAttemptJobs: async (runId, attempt) =>
      (
        await get(
          `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PER_PAGE}`
        )
      )?.jobs ?? [],
    listRunJobs: async (runId) =>
      (await get(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=${PER_PAGE}`))?.jobs ?? [],

    fetchJobLog: (jobId) => get(`/repos/${repo}/actions/jobs/${jobId}/logs`, { text: true }),
    listFixPulls: async () => {
      const all = [];
      for (let page = 1; ; page += 1) {
        const batch = await get(
          `/repos/${repo}/pulls?state=all&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch.filter((pr) => pr?.head?.ref?.startsWith(FIX_BRANCH_PREFIX)));
        if (batch.length < PER_PAGE) break;

        if (page >= 5) break;
      }
      return all;
    },
  };
}

function createFixtureApi(dir) {
  let calls = 0;
  const read = (relPath, fallback) => {
    calls += 1;
    try {
      return readFileSync(join(dir, relPath), 'utf8');
    } catch {
      return fallback;
    }
  };
  const readJson = (relPath, fallback) => {
    const raw = read(relPath, null);
    return raw === null ? fallback : JSON.parse(raw);
  };
  return {
    calls: () => calls,
    listRunsPage: async (day, page) =>
      readJson(`runs/${day}/${page}.json`, { total_count: 0, workflow_runs: [] }),
    listAttemptJobs: async (runId, attempt) =>
      readJson(`attempts/${runId}/${attempt}.json`, { jobs: [] }).jobs ?? [],
    listRunJobs: async (runId) => readJson(`jobs/${runId}.json`, { jobs: [] }).jobs ?? [],
    fetchJobLog: async (jobId) => read(`logs/${jobId}.txt`, ''),
    listFixPulls: async () => readJson('pulls.json', []),
  };
}

async function listRunsForWindow(api, days) {
  const runs = [];
  const coverageDays = [];
  for (const day of days) {
    let totalCount = 0;
    let retrieved = 0;
    for (let page = 1; ; page += 1) {
      const body = await api.listRunsPage(day, page);
      totalCount = Number(body?.total_count ?? 0);
      const batch = body?.workflow_runs ?? [];
      if (batch.length === 0) break;
      retrieved += batch.length;
      runs.push(...batch);
      if (batch.length < PER_PAGE) break;

      if (retrieved >= 1000) break;
    }
    coverageDays.push({ day, retrieved, totalCount });
    const flag = retrieved < totalCount ? ' ⚠️ TRUNCATED' : '';
    console.log(`   ${day}: ${retrieved}/${totalCount} runs${flag}`);
  }
  return { runs, coverageDays };
}

async function collectAttemptFlips(api, runs, maxRuns) {
  const reruns = runs
    .filter((r) => Number(r?.run_attempt ?? 1) > 1)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, maxRuns);
  const flips = [];
  for (const run of reruns) {
    const jobsByAttempt = {};
    for (let attempt = 1; attempt <= Number(run.run_attempt); attempt += 1) {
      jobsByAttempt[attempt] = await api.listAttemptJobs(run.id, attempt);
    }
    flips.push(
      ...findAttemptFlips(jobsByAttempt, {
        workflow: run.name ?? 'unknown',
        headSha: run.head_sha ?? '',
        runUrl: run.html_url ?? '',
        runId: run.id,
      })
    );
  }
  console.log(
    `   source 1: ${reruns.length} re-run(s) inspected → ${flips.length} attempt flip(s)`
  );
  return flips;
}

async function collectMainRegressionFlips(api, runs, corroboratedJobs, maxRuns) {
  const successfulPrShas = new Map();
  for (const run of runs) {
    if (run?.event !== 'pull_request' && run?.event !== 'pull_request_target') continue;
    if (run?.conclusion !== 'success') continue;
    successfulPrShas.set(`${run.name}${run.head_sha}`, run);
  }

  const mainFailures = runs
    .filter(
      (r) =>
        (r?.event === 'push' || r?.event === 'merge_group') &&
        isDefaultBranchRef(r?.head_branch) &&
        (r?.conclusion === 'failure' || r?.conclusion === 'timed_out') &&
        successfulPrShas.has(`${r.name}${r.head_sha}`)
    )
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, maxRuns);

  const observations = [];
  for (const run of mainFailures) {
    const prRun = successfulPrShas.get(`${run.name}${run.head_sha}`);
    for (const job of await api.listRunJobs(run.id)) {
      if (job?.conclusion !== 'failure' && job?.conclusion !== 'timed_out') continue;
      const shared = {
        workflow: run.name ?? 'unknown',
        job: job.name,
        headSha: run.head_sha ?? '',
      };
      observations.push({
        ...shared,
        conclusion: job.conclusion,
        event: run.event,
        branch: run.head_branch,
        runUrl: run.html_url ?? '',
      });
      observations.push({
        ...shared,
        conclusion: 'success',
        event: prRun.event,
        branch: prRun.head_branch,
        runUrl: prRun.html_url ?? '',
      });
    }
  }
  const flips = findMainRegressionFlips({ observations, corroboratedJobs });
  console.log(
    `   source 3: ${mainFailures.length} main failure(s) inspected → ${flips.length} corroborated flip(s)`
  );
  return flips;
}

async function localizeCandidate(api, candidate, maxLogReads) {
  const excerpts = [];
  let raw = '';
  for (const flip of candidate.flips) {
    if (excerpts.length >= maxLogReads) break;
    if (!flip.jobId) continue;
    const log = await api.fetchJobLog(flip.jobId).catch((err) => {
      console.log(`   ⚠️ log read failed for job ${flip.jobId}: ${err.message?.split('\n')[0]}`);
      return '';
    });
    if (!log) continue;
    raw += `\n${log}`;
    excerpts.push({ runUrl: flip.runUrl, lines: extractFailureLines(log) });
  }
  const localization = localizeFlake(excerpts);
  return {
    logReads: excerpts.length,
    mitigatedInfra: matchMitigatedInfra(raw),
    localized: localization.localized,
    localizationReason: localization.reason,
    signature: localization.signature,
  };
}

export async function scan({
  api,
  now = new Date(),
  windowDays = CONFIG.WINDOW_DAYS,
  maxLogReads = CONFIG.MAX_LOG_READS,
  threshold = CONFIG.FLAKE_THRESHOLD,
  jobOverride = '',
}) {
  const days = dayWindows(now, windowDays);
  const cutoff = windowStart(now, windowDays);
  console.log(
    `🔎 Scanning ${days.length} day(s) covering ${cutoff.toISOString()} → now, one query per day: ${days.join(', ')}`
  );
  const { runs: queriedRuns, coverageDays } = await listRunsForWindow(api, days);

  const runs = withinWindow(queriedRuns, cutoff);
  const trimmed = queriedRuns.length - runs.length;
  if (trimmed > 0) console.log(`   trimmed ${trimmed} run(s) older than the window start`);

  const attemptFlips = await collectAttemptFlips(api, runs, CONFIG.MAX_ATTEMPT_RUN_READS);
  const corroboratedJobs = new Set(attemptFlips.map((f) => jobKey(f.workflow, f.job)));
  const mainFlips = await collectMainRegressionFlips(
    api,
    runs,
    corroboratedJobs,
    CONFIG.MAX_MAIN_RUN_READS
  );

  let candidates = scoreCandidates([...attemptFlips, ...mainFlips]);
  if (jobOverride) {
    const needle = jobOverride.toLowerCase();
    candidates = candidates.filter(
      (c) => c.slug.includes(needle) || `${c.workflow} / ${c.job}`.toLowerCase().includes(needle)
    );
    console.log(`   job override "${jobOverride}" → ${candidates.length} candidate(s)`);
  }

  const attemptsByJob = attemptsFromPulls(await api.listFixPulls());

  const gateArgs = { candidates, threshold, attemptsByJob, now };
  const preliminary = filterCandidates(gateArgs);
  const target = preliminary.decisions.find((d) => d.action === 'unlocalized');
  let logReads = 0;
  if (target) {
    const candidate = candidates.find((c) => c.slug === target.slug);
    const localization = await localizeCandidate(api, candidate, maxLogReads);
    logReads = localization.logReads;
    Object.assign(candidate, localization);
  }

  const { dispatch, decisions } = filterCandidates(gateArgs);
  const digest = buildDigest({
    candidates,
    decisions,
    dispatched: dispatch,
    windowDays,
    now,
    coverage: {
      days: coverageDays,
      logReads,
      maxLogReads,
      apiCalls: api.calls(),
    },
  });

  return { candidates, decisions, dispatch, digest, coverageDays, apiCalls: api.calls() };
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const text = String(value);
  if (text.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${text}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${text}\n`);
  }
}

async function main() {
  const fixtureDir = (process.env.FIXTURE_DIR ?? '').trim();
  const dryRun = (process.env.DRY_RUN ?? '').trim() === 'true';
  const windowDays = envInt('WINDOW_DAYS', CONFIG.WINDOW_DAYS);
  const maxLogReads = envInt('MAX_LOG_READS', CONFIG.MAX_LOG_READS);
  const threshold = envInt('FLAKE_THRESHOLD', CONFIG.FLAKE_THRESHOLD);

  const api = fixtureDir
    ? createFixtureApi(fixtureDir)
    : createRestApi(requireEnv('REPO'), requireEnv('GH_TOKEN'));
  if (fixtureDir) console.log(`🧪 FIXTURE_DIR=${fixtureDir} — no network calls.`);

  const result = await scan({
    api,
    windowDays,
    maxLogReads,
    threshold,
    jobOverride: (process.env.JOB_OVERRIDE ?? '').trim(),
  });

  const digestPath = (process.env.DIGEST_PATH ?? '').trim() || DEFAULT_DIGEST_FILE;
  writeFileSync(digestPath, result.digest);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.digest);
  }

  const chosen = result.dispatch[0];
  const emit = Boolean(chosen) && !dryRun;
  setOutput('has_candidate', emit ? 'true' : 'false');
  if (chosen) {
    setOutput('job', `${chosen.workflow} / ${chosen.job}`);
    setOutput('slug', chosen.slug);
    setOutput('flake_score', String(chosen.flakeScore));
    setOutput('prompt', buildPrompt(chosen, { windowDays }));
  }

  console.log(`💰 GitHub API calls: ${result.apiCalls}`);
  console.log(`📝 Digest written to ${digestPath}`);
  if (!chosen) {
    console.log('😌 No dispatch this week — an empty week is a valid outcome.');
  } else if (dryRun) {
    console.log(`🧪 DRY_RUN — would have dispatched for ${chosen.workflow} / ${chosen.job}.`);
  } else {
    console.log(
      `🚀 Dispatching for ${chosen.workflow} / ${chosen.job} (score ${chosen.flakeScore}).`
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ Flaky CI Hunter scan failed: ${err.message?.split('\n')[0] ?? err}`);
    process.exit(1);
  });
}
