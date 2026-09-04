#!/usr/bin/env node
/*
 * Regression Cluster Hunter — orchestrator (I/O).
 *
 * Runs after a release lands. Reads git history and the GitHub REST API, hands
 * everything to the pure logic in `lib.mjs`, and writes the dispatch decision
 * to `$GITHUB_OUTPUT` plus a digest to `$GITHUB_STEP_SUMMARY` and a file. This
 * file only does I/O. Mirrors `packages/dev-tools/flaky-ci-hunter/scan-flakes.mjs`.
 *
 * READ-ONLY against GitHub and the working tree, always: commits, pulls, issues,
 * workflow runs. No comments, no labels, no pushes. Only the workflow's
 * downstream claude-code-action step writes anything (its issues).
 *
 * Cross-run state is GitHub-native — there is no state file, branch, or cache:
 *   - the sweep window + cooldown ← previous successful runs of this workflow
 *     (the Actions API is the clock);
 *   - "this fix was already swept" ← the `<!-- swept-fix:N -->` marker on the
 *     issues a previous hunt filed, the same durable-dedup technique as
 *     `<!-- agentic-debt:… -->` in agentic-debt-triage.yml.
 *
 * Env:
 *   REPO                owner/repo                                    (required)
 *   GH_TOKEN            token with actions:read + pulls:read + issues:read
 *   WORKFLOW_FILE       this workflow's filename, for the cooldown lookup
 *                       (default regression-cluster-hunter.yml)
 *   MIN_INTERVAL_HOURS  minimum hours between dispatched hunts     (default 12)
 *   WINDOW_HOURS        fallback window when no prior run is found (default 24)
 *   PR_OVERRIDE         sweep this PR number, skipping selection      (optional)
 *   DRY_RUN             'true' → scan + digest, never emit a candidate
 *   DIGEST_PATH         where to write the digest for artifact upload
 *
 * Exit 0 on a clean scan, including a release with no cluster to chase;
 * non-zero only on missing env or an unexpected API failure.
 */
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
/** Cap on fixes inspected per run — each costs a PR fetch plus a diff read. */
const MAX_FIXES_INSPECTED = 12;
/** Cap on signature tokens searched per fix. */
const MAX_TOKENS = 12;
/** Cap on files listed per matched shape. Measured: 25 recovers 2 of #2818's 5. */
const SHAPE_HITS_CAP = 25;

function requireEnv(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    console.error(`❌ Missing required env var ${name}.`);
    process.exit(2);
  }
  return value;
}

function envInt(name, fallback) {
  const n = Number.parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Append `key=value` to $GITHUB_OUTPUT, heredoc form for multi-line values. */
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

/* ───────────────────────────────── the scan ──────────────────────────────── */

/**
 * When did this workflow last DISPATCH a hunt? Successful runs that went quiet
 * are not dispatches, so the cooldown keys on the runs that actually spent a
 * model call — recorded as the run's `display_title` suffix is unavailable, so
 * we approximate with successful completed runs and let the marker dedup catch
 * the rest.
 */
async function lastRunAt(token, repo, workflowFile) {
  const runs = await api(
    token,
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=success&per_page=5`
  );
  const list = runs?.workflow_runs ?? [];
  // Skip the in-progress run itself (it is not `success` yet), take the newest.
  return list[0]?.created_at ?? null;
}

/**
 * Every tracked PRODUCT source file, read once and shared by the token search
 * and the shape probes. Tests are excluded at load: they cannot carry the
 * production defect, and including them both proposes them as siblings and
 * inflates the token counts `discriminatingTokens` uses to reject over-common
 * tokens. See `isProductSource`.
 */
function loadTrackedSources() {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const wanted = files.filter(isProductSource);
  const contents = new Map();
  for (const f of wanted) {
    try {
      contents.set(f, readFileSync(f, 'utf8'));
    } catch {
      // Unreadable (submodule, symlink, binary mislabelled) — not a sibling.
    }
  }
  return contents;
}

/** Files containing a token as a whole word. */
function makeTokenSearch(sources) {
  return (token) => {
    const re = new RegExp(`\\b${token.replace(/[$]/g, '\\$')}\\b`);
    const hits = [];
    for (const [file, text] of sources) if (re.test(text)) hits.push(file);
    return hits;
  };
}

/** Fixes already swept, from the marker on previously filed issues. */
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

/**
 * Score one pull request: is it a bug fix whose deleted construct survives?
 * Returns the scored candidate, or a string explaining why it was not swept.
 * @returns {Promise<object|string|null>} null = not a bug fix at all
 */
async function scoreFix({ pr, token, repo, commits, sources, searchToken, version }) {
  const meta = await api(token, `/repos/${repo}/pulls/${pr}`);
  if (!meta) return null;
  const filesRes = await api(token, `/repos/${repo}/pulls/${pr}/files?per_page=100`);
  const files = (filesRes ?? []).map((f) => f.filename);
  if (!isCandidateFix({ title: meta.title, files })) return null;

  const fixedFiles = productSources(files);
  const merge = commits.find((c) => c.pr === pr)?.sha ?? meta.merge_commit_sha;
  let diff = '';
  try {
    // First-parent diff of the merge = exactly what the PR introduced.
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

  // Rank uncapped, then truncate: the cap is a brief-length limit, and ranking
  // candidates on a truncated list ties them all at the cap.
  const allSiblings = rankSiblings(tokens, fixedFiles, { maxSiblings: Number.MAX_SAFE_INTEGER });
  if (allSiblings.length < CONFIG.minSiblings) {
    return `#${pr}: construct survives in ${allSiblings.length} file(s) — below the ${CONFIG.minSiblings} needed to call it a cluster.`;
  }

  // Shape probes run only for fixes that clear the token bar, so a quiet
  // release never pays for 2,000 file scans it will not use.
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

/** Walk the window's pull requests, scoring at most `MAX_FIXES_INSPECTED`. */
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

/** The digest's evidence table: what was considered, and what was passed over. */
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

/** Write the digest + outputs and exit 0. Every path out of `main` ends here. */
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

/** The window of first-parent commits to sweep, and when it starts. */
function loadWindow(since, now, windowHours) {
  const windowStart = since ?? new Date(now.getTime() - windowHours * 3_600_000).toISOString();
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
  const workflowFile = (process.env.WORKFLOW_FILE ?? 'regression-cluster-hunter.yml').trim();
  const minIntervalHours = envInt('MIN_INTERVAL_HOURS', CONFIG.minIntervalHours);
  const prOverride = Number.parseInt((process.env.PR_OVERRIDE ?? '').trim(), 10);
  const forced = Number.isFinite(prOverride);
  const dryRun = (process.env.DRY_RUN ?? '').trim() === 'true';

  const notes = [];
  const finish = makeFinish(notes, (process.env.DIGEST_PATH ?? '').trim() || DEFAULT_DIGEST_FILE);

  const now = new Date();
  const since = await lastRunAt(token, repo, workflowFile);
  if (!cooldownElapsed(since, now, minIntervalHours)) {
    notes.push(
      `Cooldown: last hunt was ${since}, under the ${minIntervalHours}h minimum. Releases land ~8×/day here; this is the gate that keeps the hunt from running with every one of them.`
    );
    return finish(false);
  }

  const { windowStart, commits } = loadWindow(since, now, envInt('WINDOW_HOURS', 24));
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
