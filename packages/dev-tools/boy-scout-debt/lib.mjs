/*
 * Boy Scout Debt Dispatcher — pure logic.
 *
 * A nightly job picks ONE tractable file off the repository's boy-scout debt
 * lists and hands a focused refactor brief to claude-code-action, which pays
 * that file's debt down and opens the PR itself.
 *
 * The six debt lists (authoritative procedure:
 * `.agents/skills/verifying-before-push/SKILL.md`, enforced by
 * `packages/dev-tools/tools/check-touched-exemptions.mjs`):
 *   - four single-rule `biome.json` exemption overrides, and
 *   - the two ratchet baselines (layer back-edges, `Record<string, unknown>`).
 *
 * This module is intentionally free of I/O so it can be unit-tested in
 * isolation — the `git`/REST calls and `$GITHUB_OUTPUT` writes live in
 * `select-debt-file.mjs`. Mirrors `packages/dev-tools/codebase-sins/sins.mjs`.
 */
import {
  COMPLEXITY_RULE_KEY,
  extractExemptionGlobsFor,
  FLOATING_PROMISE_RULE_KEY,
  globToRegex,
  MISUSED_PROMISE_RULE_KEY,
  SIZE_RULE_KEY,
} from '../tools/size-exemption-lib.mjs';

/** Branch prefix every dispatched cleanup PR is authored on. */
export const BRANCH_PREFIX = 'automation/boy-scout';

/** Label applied to every dispatched cleanup PR. */
export const PR_LABEL = 'boy-scout-debt';

/**
 * The six debt categories, in report order. `kind` selects how a category's
 * file list is derived: `biome` categories are parsed out of `biome.json`
 * `overrides` (via `extractExemptionGlobsFor`, which by construction ignores
 * the multi-rule test-file-wide block — that is policy, not debt), `baseline`
 * categories come from the two ratchet baseline JSON maps.
 *
 * `remediation` is the exact instruction handed to the fixer for that
 * category; it is the only place those commands are spelled out.
 * @type {ReadonlyArray<{id: string, label: string, source: string, kind: 'biome'|'baseline', ruleGroup?: string, ruleKey?: string, baseline?: 'layer'|'record', remediation: string}>}
 */
export const DEBT_CATEGORIES = [
  {
    id: 'function-size',
    label: 'over-long functions',
    source: 'biome.json `overrides` → complexity.noExcessiveLinesPerFunction = off',
    kind: 'biome',
    ruleGroup: 'complexity',
    ruleKey: SIZE_RULE_KEY,
    remediation:
      'Split the over-long functions until every function in the file is under the ' +
      'configured biome cap (complexity.noExcessiveLinesPerFunction.maxLines, currently ' +
      '150 lines), then DELETE the file from the `includes` array of the ' +
      'single-rule `complexity.noExcessiveLinesPerFunction: "off"` override in biome.json.',
  },
  {
    id: 'cognitive-complexity',
    label: 'excessive cognitive complexity',
    source: 'biome.json `overrides` → complexity.noExcessiveCognitiveComplexity = off',
    kind: 'biome',
    ruleGroup: 'complexity',
    ruleKey: COMPLEXITY_RULE_KEY,
    remediation:
      "Reduce every function's cognitive complexity under the configured biome cap " +
      '(complexity.noExcessiveCognitiveComplexity.maxAllowedComplexity, currently 25) by ' +
      'extracting helpers and flattening nesting, then DELETE the file from the `includes` ' +
      'array of the single-rule `complexity.noExcessiveCognitiveComplexity: "off"` override ' +
      'in biome.json.',
  },
  {
    id: 'floating-promise',
    label: 'floating promises',
    source: 'biome.json `overrides` → nursery.noFloatingPromises = off',
    kind: 'biome',
    ruleGroup: 'nursery',
    ruleKey: FLOATING_PROMISE_RULE_KEY,
    remediation:
      'Await, return, or explicitly handle every promise in the file (an intentional ' +
      'fire-and-forget gets a real `.catch()`, never a bare `void`-and-forget that drops ' +
      'the error), then DELETE the file from the `includes` array of the single-rule ' +
      '`nursery.noFloatingPromises: "off"` override in biome.json.',
  },
  {
    id: 'misused-promise',
    label: 'misused promises',
    source: 'biome.json `overrides` → nursery.noMisusedPromises = off',
    kind: 'biome',
    ruleGroup: 'nursery',
    ruleKey: MISUSED_PROMISE_RULE_KEY,
    remediation:
      'Keep promises out of synchronous callback and conditional positions — adapt the ' +
      'callback or the condition so the async work is awaited where it belongs — then ' +
      'DELETE the file from the `includes` array of the single-rule ' +
      '`nursery.noMisusedPromises: "off"` override in biome.json.',
  },
  {
    id: 'layer-back-edge',
    label: 'layer-stack back-edges',
    source: 'packages/dev-tools/tools/layer-back-edge-baseline.json',
    kind: 'baseline',
    baseline: 'layer',
    remediation:
      'Remove every up-the-stack import from the file (the stack is ' +
      'fs → shell/git → cdp → tools → core → scoops → ui; move the pure helper DOWN into ' +
      'the lower layer rather than importing upward — see docs/review-patterns.md § ' +
      'Layer-stack import direction), then ratchet the baseline with the supported ' +
      'command: `node packages/dev-tools/tools/check-layer-back-edges.mjs --update`. ' +
      'Never hand-edit layer-back-edge-baseline.json.',
  },
  {
    id: 'record-string-unknown',
    label: 'untyped string-keyed bags',
    source: 'packages/dev-tools/tools/record-string-unknown-baseline.json',
    kind: 'baseline',
    baseline: 'record',
    remediation:
      'Replace every `Record<string, unknown>` in the file with a named type for the shape ' +
      'you actually accept (see docs/review-patterns.md § Untyped string-keyed bags); only ' +
      'a genuinely untyped external payload may take a ' +
      '`// biome-ignore lint/plugin: <reason>` line. Then ratchet the baseline with the ' +
      'supported command: ' +
      '`node packages/dev-tools/tools/check-record-string-unknown.mjs --update`. ' +
      'Never hand-edit record-string-unknown-baseline.json.',
  },
];

/**
 * Look a debt category up by id.
 * @param {string} id
 * @returns {(typeof DEBT_CATEGORIES)[number]|undefined}
 */
export function categoryById(id) {
  return DEBT_CATEGORIES.find((c) => c.id === id);
}

/**
 * Paths that are never tractable boy-scout candidates: build output, vendored
 * or minified code, generated cross-implementation vectors, and lockfiles. A
 * refactor of any of these belongs in its generator, not in a focused PR.
 * @type {ReadonlyArray<RegExp>}
 */
const EXCLUDED_PATH_PATTERNS = [
  /(?:^|\/)dist\//,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)vendor(?:ed)?\//,
  /(?:^|\/)third[-_]party\//,
  /\.min\.(?:js|css|mjs)$/,
  /(?:^|\/)[^/]*-vectors\.json$/,
  /(?:^|\/)(?:package-lock|npm-shrinkwrap|yarn)\.(?:json|lock)$/,
  /\.generated\.[^/]+$/,
  /\.(?:snap|lock|wasm|map)$/,
];

/**
 * True when a path is generated, vendored, or otherwise untractable for a
 * focused hand-written refactor.
 * @param {string} filePath repo-relative path
 * @returns {boolean}
 */
export function isExcludedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return true;
  return EXCLUDED_PATH_PATTERNS.some((re) => re.test(filePath));
}

/**
 * Resolve one debt-list glob to the single concrete repo file it designates.
 *
 * A glob that matches many files (e.g. `**\/*.test.ts`) is blanket policy, not
 * a per-file debt item, so it is dropped — as is a glob that matches nothing
 * (a stale entry: no file left to refactor).
 * @param {string} glob
 * @param {ReadonlySet<string>|ReadonlyArray<string>} repoFiles tracked repo-relative paths
 * @returns {string|null} the single matching path, or null
 */
export function resolveGlobToSingleFile(glob, repoFiles) {
  if (typeof glob !== 'string' || glob.length === 0) return null;
  const files = repoFiles instanceof Set ? repoFiles : new Set(repoFiles ?? []);
  // Fast path: a literal path (no glob metacharacters) that is tracked.
  if (!/[*?]/.test(glob)) return files.has(glob) ? glob : null;
  const re = globToRegex(glob);
  let found = null;
  for (const file of files) {
    if (!re.test(file)) continue;
    if (found !== null) return null; // matches more than one file → policy, not debt
    found = file;
  }
  return found;
}

/**
 * The raw file list for one debt category, already resolved to concrete
 * tracked files.
 * @param {(typeof DEBT_CATEGORIES)[number]} category
 * @param {{biomeConfig: unknown, layerBaseline: unknown, recordBaseline: unknown, repoFiles: ReadonlySet<string>}} sources
 * @returns {string[]}
 */
function filesForCategory(category, sources) {
  const { biomeConfig, layerBaseline, recordBaseline, repoFiles } = sources;
  if (category.kind === 'biome') {
    const globs = extractExemptionGlobsFor(biomeConfig, category.ruleKey, category.ruleGroup);
    return globs.map((g) => resolveGlobToSingleFile(g, repoFiles)).filter((f) => f !== null);
  }
  const baseline = category.baseline === 'layer' ? layerBaseline : recordBaseline;
  const keys = baseline && typeof baseline === 'object' ? Object.keys(baseline) : [];
  // Baseline keys are already concrete repo-relative paths; keep only the ones
  // that still exist, so a stale key never becomes a candidate.
  return keys.filter((k) => repoFiles.has(k));
}

/**
 * Build the debt index: every concrete file currently on at least one debt
 * list, mapped to the ids of the categories it appears on (in
 * `DEBT_CATEGORIES` order). Pure — all four data sources arrive pre-parsed.
 * @param {{biomeConfig: unknown, layerBaseline: unknown, recordBaseline: unknown, repoFiles: Iterable<string>}} input
 * @returns {Map<string, string[]>}
 */
export function buildDebtMap({ biomeConfig, layerBaseline, recordBaseline, repoFiles }) {
  const files = repoFiles instanceof Set ? repoFiles : new Set(repoFiles ?? []);
  const sources = { biomeConfig, layerBaseline, recordBaseline, repoFiles: files };
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const category of DEBT_CATEGORIES) {
    for (const file of filesForCategory(category, sources)) {
      const ids = out.get(file);
      if (ids) {
        if (!ids.includes(category.id)) ids.push(category.id);
      } else {
        out.set(file, [category.id]);
      }
    }
  }
  return out;
}

/**
 * Rank a candidate: lower is better. Size dominates (the brief must fit in one
 * focused PR), scaled by how many debt lists the file is on — every applicable
 * category has to be paid off in the SAME PR, so a multi-category file is more
 * work than its byte count suggests.
 * @param {{bytes: number, categories: ReadonlyArray<string>}} candidate
 * @returns {number}
 */
export function scoreCandidate({ bytes, categories }) {
  const kb = Number.isFinite(bytes) && bytes >= 0 ? bytes / 1024 : Number.POSITIVE_INFINITY;
  const breadth = 1 + 0.5 * Math.max(0, (categories?.length ?? 1) - 1);
  return kb * breadth;
}

/**
 * A branch-safe slug for a file path: `packages/webapp/src/net/link-header.ts`
 * → `webapp-src-net-link-header-ts`. Truncated so the composed branch name
 * stays comfortably short.
 * @param {string} filePath
 * @returns {string}
 */
export function slugForFile(filePath) {
  const slug = String(filePath ?? '')
    .replace(/^packages\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 60 ? slug.slice(0, 60).replace(/-+$/, '') : slug;
}

/**
 * Turn the debt index into scored, tractable candidates, best first.
 * Generated/vendored paths are dropped here; files whose size is unknown sort
 * last rather than being discarded.
 * @param {{debtMap: Map<string, string[]>|ReadonlyArray<[string, string[]]>, fileSizes?: Record<string, number>|Map<string, number>}} input
 * @returns {Array<{file: string, categories: string[], bytes: number, score: number, slug: string}>}
 */
export function buildCandidates({ debtMap, fileSizes }) {
  const sizes = fileSizes instanceof Map ? fileSizes : new Map(Object.entries(fileSizes ?? {}));
  const entries = debtMap instanceof Map ? [...debtMap.entries()] : [...(debtMap ?? [])];
  const candidates = [];
  for (const [file, categories] of entries) {
    if (isExcludedPath(file)) continue;
    const bytes = sizes.has(file) ? Number(sizes.get(file)) : Number.POSITIVE_INFINITY;
    candidates.push({
      file,
      categories: [...categories],
      bytes,
      score: scoreCandidate({ bytes, categories }),
      slug: slugForFile(file),
    });
  }
  candidates.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  return candidates;
}

/**
 * Pick the one file to dispatch this run.
 *
 * Cross-run dedup is GitHub-native: `claimedFiles` is the set of files touched
 * by currently-open pull requests, so a still-open PR from a previous run
 * never blocks the routine — it just takes its file out of the pool.
 *
 * A manual override wins outright (that is the point of the dispatch input),
 * but it must still be a tractable candidate.
 * @param {{candidates: ReadonlyArray<{file: string}>, claimedFiles?: Iterable<string>, override?: string|null}} input
 * @returns {{candidate: object|null, reason: string|null, claimedSkipped: number, overridden: boolean}}
 */
export function selectDebtFile({ candidates, claimedFiles, override } = {}) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const claimed = claimedFiles instanceof Set ? claimedFiles : new Set(claimedFiles ?? []);
  const wanted = String(override ?? '').trim();

  if (wanted !== '') {
    const match = pool.find((c) => c.file === wanted);
    if (match) return { candidate: match, reason: null, claimedSkipped: 0, overridden: true };
    return {
      candidate: null,
      reason:
        `override "${wanted}" is not a tractable debt candidate — it is not on any debt ` +
        'list, resolves to more than one file, or is a generated/vendored path',
      claimedSkipped: 0,
      overridden: true,
    };
  }

  if (pool.length === 0) {
    return {
      candidate: null,
      reason: 'no tractable per-file debt entries remain on any of the six debt lists',
      claimedSkipped: 0,
      overridden: false,
    };
  }

  const unclaimed = pool.filter((c) => !claimed.has(c.file));
  const claimedSkipped = pool.length - unclaimed.length;
  if (unclaimed.length === 0) {
    return {
      candidate: null,
      reason:
        `all ${pool.length} tractable debt candidate(s) are already claimed by an open ` +
        'pull request — nothing unclaimed to dispatch today',
      claimedSkipped,
      overridden: false,
    };
  }
  return { candidate: unclaimed[0], reason: null, claimedSkipped, overridden: false };
}

/**
 * The per-category checklist the fixer must clear, numbered.
 * @param {ReadonlyArray<string>} categoryIds
 * @returns {string}
 */
function remediationChecklist(categoryIds) {
  return categoryIds
    .map((id, i) => {
      const c = categoryById(id);
      if (!c) return `${i + 1}. **${id}** — unknown debt category; investigate before editing.`;
      return `${i + 1}. **${c.label}** (\`${c.id}\`)\n   - List: ${c.source}\n   - ${c.remediation}`;
    })
    .join('\n');
}

/**
 * Compose the fixer brief for the selected candidate. Pure; the workflow hands
 * this straight to claude-code-action as its prompt.
 * @param {{file: string, categories: ReadonlyArray<string>, slug?: string, bytes?: number}} candidate
 * @returns {string}
 */
export function buildPrompt(candidate) {
  const file = candidate.file;
  const categories = [...(candidate.categories ?? [])];
  const slug = candidate.slug ?? slugForFile(file);
  const branch = `${BRANCH_PREFIX}/${slug}`;
  const listWord = categories.length === 1 ? 'list' : 'lists';

  return `# Boy Scout debt cleanup — \`${file}\`

You are paying down the boy-scout debt on exactly ONE file in the SLICC repo and
opening a focused pull request for it. Do not refactor anything else.

**Target file:** \`${file}\`
**Debt ${listWord} it is on (${categories.length}):** ${categories.join(', ')}
**Branch to work on:** \`${branch}\`

The authoritative repository procedure is
\`.agents/skills/verifying-before-push/SKILL.md\` — read it first, along with the
root \`CLAUDE.md\` and the nearest package \`CLAUDE.md\`. The gate you must satisfy
is \`packages/dev-tools/tools/check-touched-exemptions.mjs\`.

## What to fix

Refactor \`${file}\` **behaviour-preservingly** until it is clean from EVERY debt
rule below, all in this one PR. The gate fails if the file remains on any list.

${remediationChecklist(categories)}

## Hard prohibitions

Never do any of the following to make a check pass:

- Never ADD an exemption, a \`biome.json\` \`overrides\` entry, a \`biome-ignore\` /
  \`eslint-disable\` suppression, or a new baseline entry.
- Never relax a threshold or a coverage floor (\`biome.json\` caps,
  \`coverage-thresholds.json\`, \`jscpd.json\`) — those are one-way ratchets.
- Never introduce an unsafe cast (\`as any\`, \`as unknown as\`, \`@ts-expect-error\`,
  non-null \`!\` to dodge a type) to silence the type checker.
- Never hand-edit \`layer-back-edge-baseline.json\` or
  \`record-string-unknown-baseline.json\`; use the \`--update\` commands above.
- Never bundle unrelated cleanup, reformatting, or drive-by fixes. Remove ONLY
  the now-stale debt entries for \`${file}\`; leave every other entry alone.
- Never change observable behaviour. If a clean refactor is not achievable
  without behaviour change, stop and say so instead of forcing it.

## Tests

Add or update focused tests where the refactor introduces new units or where the
existing tests do not pin the behaviour you are preserving. Tests live in
\`packages/*/tests/\` mirroring \`src/\`; see
\`.agents/skills/writing-slicc-tests/SKILL.md\`. Never lower a coverage floor.

## Verify (all of these must pass before you push)

\`\`\`bash
npx biome check --write <the files you touched>
npm run typecheck
npx vitest run <the focused test files for your change>
node packages/dev-tools/tools/check-touched-exemptions.mjs origin/main
\`\`\`

\`check-touched-exemptions.mjs origin/main\` is the decisive gate: it must report
OK with \`${file}\` in the diff. If time allows, also run \`npm run verify\`.

## Open the PR

1. \`git switch -c ${branch}\`
2. Commit with a focused conventional-commit message, e.g.
   \`refactor(<scope>): pay down boy-scout debt in ${file}\`
3. Push and create the PR. The \`${PR_LABEL}\` label already exists — an earlier
   workflow step created it with a token that carries Issues write, which your
   \`GH_TOKEN\` does not. Do NOT run \`gh label create\`; it would fail:
   \`\`\`bash
   git push -u origin ${branch}
   gh pr create --base main --label ${PR_LABEL} \\
     --title "refactor: pay down boy-scout debt in ${file}" \\
     --body "<what changed, which debt lists were cleared, how you verified>"
   \`\`\`
4. The PR body must state, per debt list, what was fixed and which entry was
   removed, and must confirm that no exemption, suppression, baseline entry, or
   threshold relaxation was added.
5. Print the PR URL as the last line of your final message.

If — and only if — the file cannot be cleaned without a behaviour change or a
prohibited escape hatch, open NO pull request, leave the repository untouched
(\`git checkout -- .\`), and report the specific blocker instead.
`;
}
