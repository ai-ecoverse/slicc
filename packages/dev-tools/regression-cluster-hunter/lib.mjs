export const CONFIG = {
  minIntervalHours: 12,

  maxTokenFiles: 60,

  minTokenHits: 2,

  minSiblings: 2,

  maxSiblings: 25,

  maxIssues: 5,
};

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

const FIX_TYPES = new Set(['fix', 'perf']);

const EXCLUDED_SUBJECT = /^(chore|docs|test|ci|build|style|refactor|revert)[(!:]/i;
const EXCLUDED_SCOPE = /^(deps|deps-dev|docs|ci|release|renovate)$/i;

const NON_PRODUCT_PATH =
  /(^|\/)(dist|node_modules|coverage|__snapshots__)\/|(^docs\/)|(\.(md|mdx|json|lock|snap|png|jpg|jpeg|svg|gif|webp|ya?ml)$)|(^|\/)tests?\/|\.(test|spec)\.[a-z]+$/i;

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|go)$/i;

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

export function releasedVersion(commits) {
  for (const c of commits ?? []) {
    const m = /^chore\(release\):\s*([0-9]+\.[0-9]+\.[0-9]+\S*)/.exec(c.subject ?? '');
    if (m) return m[1];
  }
  return null;
}

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

export function isProductSource(file) {
  return SOURCE_EXT.test(file) && !NON_PRODUCT_PATH.test(file);
}

export function productSources(files) {
  return (files ?? []).filter(isProductSource);
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--|\||-\s|\d+\.\s|>\s)/;

export function signatureTokens(diff) {
  const removed = new Map();
  const kept = new Set();
  let inSourceFile = false;

  const harvest = (line, sink) => {
    if (COMMENT_LINE.test(line)) return;
    for (const tok of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
      const t = tok[0];
      if (STOPWORDS.has(t)) continue;

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

    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) continue;
    if (rawLine.startsWith('-')) harvest(rawLine.slice(1), removed);
    else if (rawLine.startsWith('+')) harvest(rawLine.slice(1), kept);
  }

  const rank = (entries) =>
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  const entries = [...removed.entries()];
  return [
    ...rank(entries.filter(([t]) => !kept.has(t))),
    ...rank(entries.filter(([t]) => kept.has(t))),
  ];
}

export function discriminatingTokens(tokens, filesForToken, maxFiles = CONFIG.maxTokenFiles) {
  const kept = [];
  for (const token of tokens ?? []) {
    const files = filesForToken(token) ?? [];
    if (files.length === 0 || files.length > maxFiles) continue;
    kept.push({ token, files });
  }
  return kept;
}

export function rankSiblings(tokenFiles, fixedFiles, opts = {}) {
  const minHits = opts.minTokenHits ?? CONFIG.minTokenHits;
  const max = opts.maxSiblings ?? CONFIG.maxSiblings;
  const fixed = new Set(fixedFiles ?? []);
  const byFile = new Map();
  for (const { token, files } of tokenFiles ?? []) {
    for (const file of files) {
      if (fixed.has(file)) continue;
      if (!isProductSource(file)) continue;
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

export function reachedPackages(siblings) {
  const pkgs = new Set();
  for (const { file } of siblings ?? []) {
    const m = /^packages\/([^/]+)\//.exec(file);
    pkgs.add(m ? m[1] : '(root)');
  }
  return [...pkgs].sort();
}

export function sweptMarker(pr) {
  return `<!-- swept-fix:${pr} -->`;
}

export function cooldownElapsed(lastDispatchAt, now, hours = CONFIG.minIntervalHours) {
  if (!lastDispatchAt) return true;
  const last = new Date(lastDispatchAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= hours * 3_600_000;
}

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

## How to work — read this before you start

**One session, no delegation.** Do not spawn sub-agents or fan the sweep out by
package. The first live run of this workflow did exactly that, then ended its
turn with *"I'll wait for their final reports"* — but nothing waits. The session
terminated, the run went green, and it filed **zero issues** after spending
$7.27. There is no background to wait for: if you did not do it in this
session, it did not happen.

**File as you confirm, never at the end.** The moment a candidate passes the
rule, run \`gh issue create\` for it and move on. Do not accumulate verdicts to
batch later — a session that ends mid-batch loses everything it found.

**Budget your turns.** Work the candidates in the order given, best-first. If
you sense you are running low, stop investigating, file what you have already
confirmed, and print a one-line summary of what you did not get to. A partial
sweep that files two real issues beats a thorough one that files none.

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
