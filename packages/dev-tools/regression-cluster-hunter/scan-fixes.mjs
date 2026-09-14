#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildPrompt,
  CONFIG,
  cooldownElapsed,
  discriminatingTokens,
  isCandidateFix,
  isProductSource,
  parseFirstParentLog,
  productSources,
  rankSiblings,
  reachedPackages,
  releasedVersion,
  selectCandidate,
  signatureTokens,
} from './lib.mjs';
import { matchShapes, probeShape, renderShapes } from './shapes.mjs';

const API = 'https://api.github.com';
const DEFAULT_DIGEST_FILE = 'regression-cluster-digest.md';

const MAX_FIXES_INSPECTED = 12;

const MAX_TOKENS = 12;

const SHAPE_HITS_CAP = 25;

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

function envInt(name, fallback, min = 1) {
  const n = Number.parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const v = String(value);
  if (v.includes('\n')) {
    const delim = `EOF_${randomUUID().replace(/-/g, '')}`;
    appendFileSync(file, `${key}<<${delim}\n${v}\n${delim}\n`);
  } else {
    appendFileSync(file, `${key}=${v}\n`);
  }
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function api(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'slicc-regression-cluster-hunter',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function lastDispatchAt(token, repo, artifactName) {
  const res = await api(
    token,
    `/repos/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`
  );
  const live = (res?.artifacts ?? []).filter((a) => a.expired !== true);
  if (live.length === 0) return null;
  return live
    .map((a) => a.created_at)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function loadTrackedSources() {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const wanted = files.filter(isProductSource);
  const contents = new Map();
  for (const f of wanted) {
    try {
      contents.set(f, readFileSync(f, 'utf8'));
    } catch {}
  }
  return contents;
}

function makeTokenSearch(sources) {
  return (token) => {
    const re = new RegExp(`\\b${token.replace(/[$]/g, '\\$')}\\b`);
    const hits = [];
    for (const [file, text] of sources) if (re.test(text)) hits.push(file);
    return hits;
  };
}

async function listPullFiles(token, repo, pr, maxPages = 10) {
  const files = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await api(token, `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    const batch = res ?? [];
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return files;
}

async function sweptFixes(token, repo) {
  const swept = new Set();
  const q = encodeURIComponent(`repo:${repo} "swept-fix:" in:body`);
  const res = await api(token, `/search/issues?q=${q}&per_page=100`);
  for (const item of res?.items ?? []) {
    for (const m of String(item.body ?? '').matchAll(/<!--\s*swept-fix:(\d+)\s*-->/g)) {
      swept.add(Number(m[1]));
    }
  }
  return swept;
}

async function scoreFix({ pr, token, repo, commits, sources, searchToken, version }) {
  const meta = await api(token, `/repos/${repo}/pulls/${pr}`);
  if (!meta) return null;
  const files = await listPullFiles(token, repo, pr);
  if (!isCandidateFix({ title: meta.title, files })) return null;

  const fixedFiles = productSources(files);
  const merge = commits.find((c) => c.pr === pr)?.sha ?? meta.merge_commit_sha;
  let diff = '';
  try {
    diff = git('show', '--first-parent', '--unified=3', '--format=', merge);
  } catch {
    return `#${pr}: merge commit ${merge} not readable in this checkout.`;
  }

  const tokens = discriminatingTokens(signatureTokens(diff).slice(0, 80), searchToken).slice(
    0,
    MAX_TOKENS
  );
  if (tokens.length === 0) {
    return `#${pr}: no discriminating tokens (everything it deleted is repo-generic).`;
  }

  const allSiblings = rankSiblings(tokens, fixedFiles, { maxSiblings: Number.MAX_SAFE_INTEGER });
  if (allSiblings.length < CONFIG.minSiblings) {
    return `#${pr}: construct survives in ${allSiblings.length} file(s) — below the ${CONFIG.minSiblings} needed to call it a cluster.`;
  }

  const shapes = matchShapes(diff);
  const hitsByShape = new Map();
  for (const shape of shapes) {
    hitsByShape.set(shape.id, probeShape(shape, sources, fixedFiles, { max: SHAPE_HITS_CAP }));
  }

  return {
    pr,
    title: meta.title,
    sha: merge,
    version: version ?? 'unreleased',
    tokens: tokens.map((t) => t.token),
    fixedFiles,
    siblings: allSiblings.slice(0, CONFIG.maxSiblings),
    totalSiblings: allSiblings.length,
    shapes: shapes.map((sh) => sh.id),
    shapeSection: renderShapes(shapes, hitsByShape),
  };
}

async function scoreWindow(ctx) {
  const scored = [];
  const rejected = [];
  let inspected = 0;
  for (const pr of ctx.prNumbers) {
    if (inspected >= MAX_FIXES_INSPECTED) break;
    if (ctx.swept.has(pr) && !ctx.forced) {
      rejected.push(`#${pr}: already swept (marker found on a filed issue).`);
      continue;
    }
    const outcome = await scoreFix({ ...ctx, pr });
    if (outcome === null) continue;
    inspected += 1;
    if (typeof outcome === 'string') rejected.push(outcome);
    else scored.push(outcome);
  }
  return { scored, rejected, inspected };
}

function renderTable(scored, rejected) {
  return [
    '',
    '| Fix | Surviving sites | Packages |',
    '| --- | --- | --- |',
    ...scored.map(
      (s) =>
        `| #${s.pr} ${s.title} | ${s.totalSiblings} | ${reachedPackages(s.siblings).join(', ')} |`
    ),
    '',
    ...(rejected.length ? ['**Not swept:**', '', ...rejected.map((r) => `- ${r}`)] : []),
  ].join('\n');
}

function makeFinish(notes, digestPath) {
  return (dispatched, extra = '') => {
    const digest = [
      '# Regression cluster hunt',
      '',
      ...notes.map((n) => `- ${n}`),
      extra ? `\n${extra}` : '',
    ].join('\n');
    writeFileSync(digestPath, `${digest}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${digest}\n`);
    }
    setOutput('has_candidate', dispatched ? 'true' : 'false');
    console.log(digest);
    process.exit(0);
  };
}

function loadWindow(since, now, windowHours, maxWindowHours) {
  const floor = new Date(now.getTime() - maxWindowHours * 3_600_000).toISOString();
  const start = since ?? new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const windowStart = start < floor ? floor : start;
  const log = git(
    'log',
    '--first-parent',
    `--since=${windowStart}`,
    '--pretty=%H|%s',
    'origin/main'
  );
  return { windowStart, commits: parseFirstParentLog(log) };
}

async function main() {
  const repo = requireEnv('REPO');
  const token = requireEnv('GH_TOKEN');
  const dispatchArtifact = (process.env.DISPATCH_ARTIFACT ?? 'regression-cluster-dispatch').trim();
  const minIntervalHours = envInt('MIN_INTERVAL_HOURS', CONFIG.minIntervalHours, 0);
  const prOverride = Number.parseInt((process.env.PR_OVERRIDE ?? '').trim(), 10);
  const forced = Number.isFinite(prOverride);
  const dryRun = (process.env.DRY_RUN ?? '').trim() === 'true';

  const notes = [];
  const finish = makeFinish(notes, (process.env.DIGEST_PATH ?? '').trim() || DEFAULT_DIGEST_FILE);

  const now = new Date();
  const since = await lastDispatchAt(token, repo, dispatchArtifact);
  if (!cooldownElapsed(since, now, minIntervalHours)) {
    notes.push(
      `Cooldown: the last hunt that actually dispatched was ${since}, under the ${minIntervalHours}h minimum. Releases land ~8×/day here; this is the gate that keeps the hunt from running with every one of them. Dispatch \`min_interval_hours: 0\` to override.`
    );
    return finish(false);
  }

  const { windowStart, commits } = loadWindow(
    since,
    now,
    envInt('WINDOW_HOURS', 24),
    envInt('MAX_WINDOW_HOURS', 72)
  );
  notes.push(`Window: ${windowStart} → now (${commits.length} first-parent commits).`);

  const version = releasedVersion(commits);
  if (!version && !forced) {
    notes.push(
      'No `chore(release):` commit in the window — the `Release` workflow ran but published nothing. `workflow_run` completing is not proof a release landed, so nothing is swept.'
    );
    return finish(false);
  }

  const sources = loadTrackedSources();
  notes.push(`Searched ${sources.size} tracked product-source files (tests excluded).`);

  const { scored, rejected, inspected } = await scoreWindow({
    token,
    repo,
    commits,
    sources,
    version,
    forced,
    searchToken: makeTokenSearch(sources),
    swept: await sweptFixes(token, repo),
    prNumbers: forced ? [prOverride] : commits.map((c) => c.pr).filter((n) => n !== null),
  });

  const table = renderTable(scored, rejected);
  const candidate = selectCandidate(scored);

  if (!candidate) {
    notes.push(
      `Release ${version ?? '(none)'}: inspected ${inspected} bug fix(es), none whose deleted construct survives in ${CONFIG.minSiblings}+ untouched files. Nothing dispatched.`
    );
    return finish(false, table);
  }

  if (dryRun) {
    notes.push(`Dry run: would sweep #${candidate.pr} (${candidate.totalSiblings} sites).`);
    return finish(false, table);
  }

  notes.push(
    `Release ${candidate.version}: sweeping **#${candidate.pr}** — ${candidate.title}. Its construct survives in ${candidate.totalSiblings} untouched file(s) across ${reachedPackages(candidate.siblings).join(', ')}.${
      candidate.shapes?.length ? ` Matched known shape(s): ${candidate.shapes.join(', ')}.` : ''
    }`
  );
  setOutput('pr', String(candidate.pr));
  setOutput('version', candidate.version);
  setOutput(
    'prompt',
    buildPrompt({ ...candidate, maxIssues: envInt('MAX_ISSUES', CONFIG.maxIssues) })
  );
  return finish(true, table);
}

main().catch((err) => {
  console.error(`❌ ${err?.stack ?? err}`);
  process.exit(1);
});
