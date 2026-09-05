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
 *   - the sweep window + cooldown ← the `regression-cluster-dispatch` artifact,
 *     uploaded only by runs that actually dispatched, so the artifacts API is
 *     the clock. NOT every successful run: `workflow_run` fires on every push
 *     to main and a quiet run succeeds too, so keying on that reset the clock
 *     several times a day and starved the hunter permanently;
 *   - "this fix was already swept" ← the `<!-- swept-fix:N -->` marker on the
 *     issues a previous hunt filed, the same durable-dedup technique as
 *     `<!-- agentic-debt:… -->` in agentic-debt-triage.yml.
 *
 * Env:
 *   REPO                owner/repo                                    (required)
 *   GH_TOKEN            token with actions:read + pulls:read + issues:read
 *   DISPATCH_ARTIFACT   artifact name marking a run that dispatched
 *                       (default regression-cluster-dispatch)
 *   MIN_INTERVAL_HOURS  minimum hours between dispatched hunts; 0 disables the
 *                       cooldown, as the workflow input advertises (default 12)
 *   WINDOW_HOURS        fallback window when nothing has dispatched (default 24)
 *   MAX_WINDOW_HOURS    hard cap on how far back to sweep           (default 72)
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

/**
 * Read a positive integer from env, else `fallback`.
 *
 * `min` exists for MIN_INTERVAL_HOURS, whose workflow input documents
 * `0 = ignore it`. A blanket `n > 0` guard silently turned that 0 back into 12,
 * so the advertised "force a run now" escape hatch did nothing. Blank still
 * falls back either way — `parseInt('')` is NaN, which is not finite. The other
 * knobs keep `min = 1`: MAX_ISSUES=0 or WINDOW_HOURS=0 are meaningless, not
 * useful overrides.
 */
function envInt(name, fallback, min = 1) {
  const n = Number.parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
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
 * When did this workflow last DISPATCH a hunt?
 *
 * NOT "when did it last run successfully". `workflow_run` fires this on every
 * push to main (~8×/day here) and a quiet run — no release, or no cluster —
 * also succeeds. Keying the clock on any successful run therefore reset it
 * several times a day, and with a 12h cooldown the hunter would never dispatch
 * again after its first run. The recommended `dry_run: true` smoke test would
 * have blocked the next real release too.
 *
 * The dispatching run uploads a `regression-cluster-dispatch` artifact, so the
 * artifacts API is the ledger — GitHub-native, like the rest of the family, and
 * it cannot drift from what actually happened. Expired artifacts are ignored:
 * a 90-day retention comfortably outlives a 12h cooldown, and an expired one
 * failing open only costs one extra hunt.
 */
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

/**
 * Every file a pull request changed, following pagination.
 *
 * The first page is not enough: a fix touching more than 100 files would have
 * its later-page repairs missing from `fixedFiles`, so the sweep could offer a
 * file this very fix already repaired as a live sibling. Capped so one
 * enormous PR cannot stall the scan — a fix that large is not a crisp defect
 * shape anyway, and `isCandidateFix` will usually have rejected it.
 */
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
  const files = await listPullFiles(token, repo, pr);
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

/**
 * The window of first-parent commits to sweep, and when it starts.
 *
 * Clamped: now that the clock keys on DISPATCHES rather than on every run, a
 * long quiet spell (no release, or no cluster worth chasing) would otherwise
 * widen the window without bound and make the scan slower the less it finds.
 */
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
