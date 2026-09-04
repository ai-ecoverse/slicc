/*
 * Regression Cluster Hunter — pure logic.
 *
 * When a release lands, this picks ONE bug fix that shipped in it and asks
 * whether the SAME DEFECT SHAPE survives elsewhere in the tree.
 *
 * The bar everything here is built around — the analogue of the flake hunter's
 * "same commit, two outcomes" — is a SURVIVING CONSTRUCT: the fix deleted some
 * code, and byte-identical-in-kind code is still present in files the fix did
 * not touch. If we cannot point at the buggy construct still living somewhere
 * else, nothing is dispatched. A quiet release is a good release.
 *
 * This module is intentionally free of I/O so it can be unit-tested in
 * isolation — `git`, the GitHub REST calls, and the `$GITHUB_OUTPUT` writes
 * live in `scan-fixes.mjs`. Mirrors `packages/dev-tools/codebase-sins/sins.mjs`
 * and `packages/dev-tools/flaky-ci-hunter/lib.mjs`.
 */

/** Tunables, overridable from the workflow via env (see `scan-fixes.mjs`). */
export const CONFIG = {
  /** Minimum hours between two dispatched hunts. Releases land ~8×/day here. */
  minIntervalHours: 12,
  /** A token in more than this many tracked files is too generic to be a signature. */
  maxTokenFiles: 60,
  /** A sibling file must carry at least this many of the fix's signature tokens. */
  minTokenHits: 2,
  /** Dispatch only when at least this many sibling files survive. */
  minSiblings: 2,
  /** Never hand Claude more than this many sibling files. */
  maxSiblings: 25,
  /** Cap on issues Claude may file in one run. */
  maxIssues: 5,
};

/**
 * Identifiers that appear in nearly every file and therefore carry no signal
 * about a specific defect shape. Kept deliberately small: the frequency cap
 * (`maxTokenFiles`) does most of the work, and an over-eager stoplist is how a
 * hunter goes quiet for the wrong reason.
 */
const STOPWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'await',
  'async',
  'import',
  'export',
  'from',
  'default',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'this',
  'self',
  'null',
  'undefined',
  'true',
  'false',
  'void',
  'never',
  'string',
  'number',
  'boolean',
  'object',
  'any',
  'unknown',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'typeof',
  'instanceof',
  'delete',
  'in',
  'of',
  'error',
  'err',
  'result',
  'value',
  'data',
  'options',
  'opts',
  'params',
  'args',
  'config',
  'context',
  'ctx',
  'name',
  'path',
  'key',
  'index',
  'item',
  'length',
  'push',
  'map',
  'filter',
  'forEach',
  'join',
  'slice',
  'test',
  'expect',
  'describe',
  'it',
  'console',
  'log',
  'guard',
  'func',
  'struct',
  'init',
  'Foundation',
  'Swift',
  'String',
  'Int',
  'Bool',
  'Data',
  'Array',
]);

/** Conventional-commit types whose fixes are worth sweeping for siblings. */
const FIX_TYPES = new Set(['fix', 'perf']);

/**
 * Scopes and subjects that never carry a product defect shape: dependency
 * bumps, generated output, CI plumbing, and docs. Sweeping these produces
 * noise, not clusters.
 */
const EXCLUDED_SUBJECT = /^(chore|docs|test|ci|build|style|refactor|revert)[(!:]/i;
const EXCLUDED_SCOPE = /^(deps|deps-dev|docs|ci|release|renovate)$/i;

/** Paths whose changes are not product code. */
const NON_PRODUCT_PATH =
  /(^|\/)(dist|node_modules|coverage|__snapshots__)\/|(^docs\/)|(\.(md|mdx|json|lock|snap|png|jpg|jpeg|svg|gif|webp|ya?ml)$)|(^|\/)tests?\//i;

/** Source files we are willing to call a sibling. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|go)$/i;

/**
 * Parse `git log --first-parent --pretty=%H|%s` output into merge records.
 * This repo links commits to PRs only through the merge-queue subject
 * (`Merge pull request #NNNN from ...`) — squash subjects carrying `(#N)` do
 * not exist here, so that is the only linkage worth parsing.
 * @param {string} log
 * @returns {Array<{sha: string, pr: number|null, subject: string}>}
 */
export function parseFirstParentLog(log) {
  return String(log ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf('|');
      const sha = sep === -1 ? line : line.slice(0, sep);
      const subject = sep === -1 ? '' : line.slice(sep + 1);
      const m = /^Merge pull request #(\d+)\s/.exec(subject);
      return { sha, subject, pr: m ? Number(m[1]) : null };
    });
}

/**
 * Did a release actually land in this window? `Release` runs on every push to
 * main and mostly plans nothing, so a `workflow_run` completion is NOT proof.
 * semantic-release's own commit is.
 * @param {Array<{subject: string}>} commits
 * @returns {string|null} the released version, or null
 */
export function releasedVersion(commits) {
  for (const c of commits ?? []) {
    const m = /^chore\(release\):\s*([0-9]+\.[0-9]+\.[0-9]+\S*)/.exec(c.subject ?? '');
    if (m) return m[1];
  }
  return null;
}

/**
 * Is this pull request a product bug fix worth sweeping?
 * @param {{title?: string, files?: string[]}} pr
 * @returns {boolean}
 */
export function isCandidateFix(pr) {
  const title = String(pr?.title ?? '');
  if (EXCLUDED_SUBJECT.test(title)) return false;
  const m = /^([a-z]+)(?:\(([^)]*)\))?!?:/i.exec(title);
  if (!m) return false;
  if (!FIX_TYPES.has(m[1].toLowerCase())) return false;
  if (m[2] && EXCLUDED_SCOPE.test(m[2].trim())) return false;
  const files = pr?.files ?? [];
  return files.some((f) => SOURCE_EXT.test(f) && !NON_PRODUCT_PATH.test(f));
}

/**
 * The product source files a fix touched — the sites already repaired, which
 * are excluded from the sibling sweep by definition.
 * @param {string[]} files
 * @returns {string[]}
 */
export function productSources(files) {
  return (files ?? []).filter((f) => SOURCE_EXT.test(f) && !NON_PRODUCT_PATH.test(f));
}

/** A removed line that is a comment or doc prose rather than code. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--|\||-\s|\d+\.\s|>\s)/;

/**
 * Distil the buggy construct from a unified diff into signature tokens.
 *
 * Three filters, each of which was earning its keep on the first live run:
 *
 *   1. Only REMOVED lines are read. Those are the code the fix decided was
 *      wrong; added lines describe the remedy, and grepping for the remedy
 *      finds the sites that are already correct — the exact inversion that
 *      would make this hunter file issues against healthy code.
 *   2. Only hunks belonging to PRODUCT SOURCE files. A fix's diff routinely
 *      includes `docs/shell-reference.md` and its own tests; harvesting those
 *      turns English into "signature tokens".
 *   3. Comment and prose lines are skipped. Replaying #2888 without this
 *      produced `avoids`, `clicking`, `targeting`, `Convert` and `Detect` as
 *      top signatures — all lifted from deleted comments, and all of which
 *      match half the repo.
 *
 * @param {string} diff unified diff text
 * @returns {string[]} candidate tokens, most-specific first
 */
export function signatureTokens(diff) {
  const removed = new Map();
  const kept = new Set();
  let inSourceFile = false;

  const harvest = (line, sink) => {
    if (COMMENT_LINE.test(line)) return;
    for (const tok of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
      const t = tok[0];
      if (STOPWORDS.has(t)) continue;
      // A token that is all-lowercase and short is usually a local variable;
      // require either a case boundary (camelCase / PascalCase) or length.
      if (!/[A-Z_$]/.test(t.slice(1)) && t.length < 6) continue;
      if (sink instanceof Set) sink.add(t);
      else sink.set(t, (sink.get(t) ?? 0) + 1);
    }
  };

  for (const rawLine of String(diff ?? '').split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(rawLine);
    if (header) {
      const file = header[2];
      inSourceFile = SOURCE_EXT.test(file) && !NON_PRODUCT_PATH.test(file);
      continue;
    }
    if (!inSourceFile) continue;
    // `---` / `+++` are file headers, not content.
    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) continue;
    if (rawLine.startsWith('-')) harvest(rawLine.slice(1), removed);
    else if (rawLine.startsWith('+')) harvest(rawLine.slice(1), kept);
  }

  // A token that survives into the fixed version is structure, not defect:
  // #2888 rewrote a playwright handler, so `PlaywrightHandler` and `requireTab`
  // sat on both sides and matched all ~18 sibling handlers for no reason.
  //
  // Survivors are RANKED DOWN rather than dropped. Excluding them outright was
  // tried and is too sharp — most fixes rewrite a line in place, so nearly
  // every token appears on both sides and #2888 came back with no signature at
  // all. Callers take the head of this list, so purely-deleted tokens win
  // whenever they exist and survivors still backstop a fix that has none.
  const rank = (entries) =>
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const entries = [...removed.entries()];
  return [
    ...rank(entries.filter(([t]) => !kept.has(t))),
    ...rank(entries.filter(([t]) => kept.has(t))),
  ];
}

/**
 * Keep only tokens specific enough to name a defect shape. A token found in
 * hundreds of files describes the language, not the bug.
 * @param {string[]} tokens
 * @param {(token: string) => string[]} filesForToken tracked files containing the token
 * @param {number} [maxFiles]
 * @returns {Array<{token: string, files: string[]}>}
 */
export function discriminatingTokens(tokens, filesForToken, maxFiles = CONFIG.maxTokenFiles) {
  const kept = [];
  for (const token of tokens ?? []) {
    const files = filesForToken(token) ?? [];
    if (files.length === 0 || files.length > maxFiles) continue;
    kept.push({ token, files });
  }
  return kept;
}

/**
 * Rank the files where the fix's construct SURVIVES.
 *
 * A file scores by how many distinct signature tokens it carries: one shared
 * token is a coincidence, several co-occurring is the same construct. Files the
 * fix already repaired are excluded — they are the cure, not the disease.
 *
 * @param {Array<{token: string, files: string[]}>} tokenFiles
 * @param {string[]} fixedFiles paths the fix touched
 * @param {{minTokenHits?: number, maxSiblings?: number}} [opts]
 * @returns {Array<{file: string, tokens: string[], score: number}>}
 */
export function rankSiblings(tokenFiles, fixedFiles, opts = {}) {
  const minHits = opts.minTokenHits ?? CONFIG.minTokenHits;
  const max = opts.maxSiblings ?? CONFIG.maxSiblings;
  const fixed = new Set(fixedFiles ?? []);
  const byFile = new Map();
  for (const { token, files } of tokenFiles ?? []) {
    for (const file of files) {
      if (fixed.has(file)) continue;
      if (!SOURCE_EXT.test(file) || NON_PRODUCT_PATH.test(file)) continue;
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(token);
    }
  }
  return [...byFile.entries()]
    .map(([file, tokens]) => ({ file, tokens: [...tokens].sort(), score: tokens.size }))
    .filter((s) => s.score >= minHits)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, max);
}

/**
 * Cross-runtime reach: SLICC ships the same contract in TypeScript, Swift, and
 * Go, and half the recorded clusters (#2821, #2822, #1996, #2305) were one
 * runtime drifting from another. A sibling set that spans packages is worth
 * more than one clustered in a single directory.
 * @param {Array<{file: string}>} siblings
 * @returns {string[]} sorted package names
 */
export function reachedPackages(siblings) {
  const pkgs = new Set();
  for (const { file } of siblings ?? []) {
    const m = /^packages\/([^/]+)\//.exec(file);
    pkgs.add(m ? m[1] : '(root)');
  }
  return [...pkgs].sort();
}

/**
 * Has this fix already been swept? Dedup is GitHub-native: the marker line the
 * filed issues carry, matching the `<!-- agentic-debt:… -->` /
 * `<!-- rum-fp:… -->` technique the other hunters use.
 * @param {number} pr
 * @returns {string}
 */
export function sweptMarker(pr) {
  return `<!-- swept-fix:${pr} -->`;
}

/**
 * Enough time since the last dispatched hunt? Releases land ~8×/day, so
 * without this every release day would spend a dozen Claude runs.
 * @param {string|number|Date|null} lastDispatchAt
 * @param {Date} now
 * @param {number} [hours]
 * @returns {boolean}
 */
export function cooldownElapsed(lastDispatchAt, now, hours = CONFIG.minIntervalHours) {
  if (!lastDispatchAt) return true;
  const last = new Date(lastDispatchAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 3_600_000;
}

/**
 * Pick at most ONE fix to sweep: the one whose construct survives in the most
 * places, tie-broken by cross-package reach and then by recency.
 * `totalSiblings` (the UNCAPPED count) is what ranks them. `siblings` is
 * already truncated to `maxSiblings` for the brief, so several candidates
 * routinely tie at exactly the cap — ranking on the truncated list would make
 * the choice arbitrary among them.
 *
 * @param {Array<{pr: number, title: string, totalSiblings?: number,
 *          siblings: Array<{file: string, score: number}>}>} scored
 * @param {{minSiblings?: number}} [opts]
 * @returns {object|null}
 */
export function selectCandidate(scored, opts = {}) {
  const min = opts.minSiblings ?? CONFIG.minSiblings;
  const total = (c) => c.totalSiblings ?? c.siblings?.length ?? 0;
  const eligible = (scored ?? []).filter((c) => total(c) >= min);
  if (eligible.length === 0) return null;
  return eligible.sort((a, b) => {
    const bySiblings = total(b) - total(a);
    if (bySiblings !== 0) return bySiblings;
    const byReach = reachedPackages(b.siblings).length - reachedPackages(a.siblings).length;
    if (byReach !== 0) return byReach;
    return b.pr - a.pr;
  })[0];
}

/**
 * Compose the brief. Everything mechanical is already decided; what is left
 * for the model is the judgement a grep cannot make — whether a surviving
 * construct is actually the same defect, or a lookalike that is fine.
 * @param {{pr: number, title: string, sha: string, version: string,
 *          siblings: Array<{file: string, tokens: string[], score: number}>,
 *          tokens: string[], fixedFiles: string[], maxIssues?: number,
 *          shapeSection?: string}} c
 * @returns {string}
 */
export function buildPrompt(c) {
  const maxIssues = c.maxIssues ?? CONFIG.maxIssues;
  const siblingRows = c.siblings
    .map((s) => `| \`${s.file}\` | ${s.score} | ${s.tokens.map((t) => `\`${t}\``).join(', ')} |`)
    .join('\n');
  const packages = reachedPackages(c.siblings);

  return `# Regression cluster hunt — release ${c.version}

A bug fix just shipped. Your job is to find out whether the **same defect
shape** is still live somewhere else in this repository, and to file an issue
for each place it is.

This repo has a documented history of exactly this failure mode: a fix lands at
one call site, and the identical bug sits unnoticed at five more. #2818 fixed a
UTF-8 hop that corrupted binary request bodies; #2883, #2884, #2885, #2886 and
#2887 were the same hop, elsewhere, found a day later by hand. #2071 → #2154 →
#2400 → #2703 were four copies of one \`readFile\`-swallow-then-clobber bug,
found one per week because nothing swept for the rest. You are the sweep.

## The fix that shipped

- **PR #${c.pr}** — ${c.title}
- Merge commit \`${c.sha}\`, released as \`${c.version}\`
- Files it repaired:
${c.fixedFiles.map((f) => `  - \`${f}\``).join('\n')}

Read it first: \`git show ${c.sha}\`, and \`gh pr view ${c.pr}\` for the author's
own account of the root cause. The PR body is usually explicit about the
mechanism — trust it over your own reconstruction.

## Where the construct survives

The selector took the code this fix **deleted**, distilled it to the signature
tokens below, and searched every tracked source file the fix did *not* touch.
These files still carry that construct:

| File | Tokens matched | Which |
| --- | --- | --- |
${siblingRows}

Signature tokens: ${c.tokens.map((t) => `\`${t}\``).join(', ')}
Packages reached: ${packages.map((p) => `\`${p}\``).join(', ')}

**This table is a lead, not a finding.** It is a text search. A file can match
every token and be perfectly correct.
${
  c.shapeSection
    ? `
## Known recurring shapes this fix belongs to

The token table above can only find files that share *words* with the fix. That
is a real limitation, and it is measured: replaying this selector over #2818
recovered two of its five known siblings, because the other three said the same
thing in different words. The sections below come from a catalog of shapes that
have provably clustered in this repo before, and they search each shape's own
vocabulary instead of the fix's.

${c.shapeSection}
`
    : ''
}
## What to do

1. **Name the shape.** From the diff, write down in one sentence the defect as
   a rule — the precondition, the wrong behaviour, the observable damage. For
   #2818 that was: *"bytes crossing this hop are put through a UTF-8 string, so
   every byte ≥ 0x80 expands and binary payloads corrupt."* If you cannot state
   the rule crisply, stop and file nothing; a vague rule produces vague issues.
2. **Test each candidate against the rule.** Read the file. For each one decide:
   does the precondition actually hold here, and does the damage actually
   follow? Reject anything where the construct is present but harmless (already
   guarded upstream, only ever handed text, dead code, a test fixture).
3. **Look past the table.** It only finds files sharing *lexical* tokens with
   the fix. The same shape often reappears with different names — especially in
   the other runtimes. SLICC ships the same contracts in
   \`packages/webapp/\` (TS), \`packages/node-server/\` (Node),
   \`packages/swift-server/\` + \`packages/ios-app/\` (Swift),
   \`packages/cloudflare-worker/\` (worker) and \`packages/go-optel/\` (Go);
   #2821 and #2822 were both Node-vs-Swift drift on the same predicate. Grep for
   the *concept*, not just the tokens.
4. **Do not report the fix itself, and do not report anything the fix already
   repaired.** Those files are listed above; they are the cure.

## Filing

Work **read-only** on the code: Read, Grep, Glob and \`git\` for evidence, no
edits, no branches, no PRs. The only writes are \`gh issue create\`.

Before filing anything, dedup:

- \`gh issue list --state open --limit 100\`
- \`gh issue list --search "<distinctive phrase from the shape>" --state all\`
- \`gh issue list --search "regression-cluster in:body" --state all\`

Skip any candidate already covered by an open issue or an open PR.

File **one issue per confirmed sibling**, at most **${maxIssues}**, worst first.
Each issue body must contain:

- **Summary** — what breaks, at which \`file.ts:line\`, and the observable
  damage. Follow the house bug-report shape (see other \`bug:\` issues): Summary,
  Float (runtime), Surface, Area, Reproduction, Suspected root cause / location.
- A **Reproduction** a human can run, or an honest statement that you could only
  verify it by reading the code — say which, never dress up the second as the
  first.
- The sentence **"Spotted sweeping for siblings of #${c.pr}"** and a link to it.
- The exact marker line on its own: \`${sweptMarker(c.pr)}\`
- Labels: \`--label bug --label regression-cluster\` plus the matching
  \`area/*\` label(s) where you are confident.

Title them in the house style: \`bug: <specific thing> (#${c.pr} sibling)\`.

**Filing nothing is a good outcome.** If every candidate is a lookalike, file
nothing and print one line per rejected candidate saying why. A wrong issue
costs a human more than a missed one — this sweep runs again on the next
release.
`;
}
