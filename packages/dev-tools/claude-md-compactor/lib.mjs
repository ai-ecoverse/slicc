/*
 * Weekend CLAUDE.md Compactor — pure logic.
 *
 * TWO DIFFERENT BUDGETS, do not confuse them:
 *
 *   1. The repo's committed SIZE GATE — `PACKAGE_CLAUDE_MAX_CHARS = 20000` in
 *      `packages/dev-tools/tools/check-doc-sizes-lib.mjs`, enforced by
 *      `packages/dev-tools/tools/check-doc-sizes.mjs` (`npm run lint:docs`).
 *      Scope: only `packages/*\/CLAUDE.md`. It is a hard CI failure line and
 *      this module never touches, reads around, or relaxes it.
 *
 *   2. This module's COMPACTION POLICY — a stricter, wider, advisory-only
 *      policy owned by the weekly compactor: a guide is "oversized" at
 *      COMPACTOR_MAX_CHARS (10,000) and gets rewritten down to at most
 *      COMPACTOR_TARGET_CHARS (9,500), leaving ~5% headroom before the policy
 *      line. Scope: EVERY tracked file named `CLAUDE.md` — the repo root,
 *      `docs/`, and every package. Nothing fails CI because of this policy on
 *      its own; it exists to keep guides small enough that the 20k gate is
 *      never approached and agents keep reading them in full.
 *
 * So policy (10k) is far below the gate (20k) and covers strictly more files.
 * A guide at 12,000 chars passes `npm run lint:docs` but is compaction work.
 *
 * The one guide with a STRICTER budget than either — the agent-facing runtime
 * guide at 3,000 BYTES — is excluded outright (see EXCLUDED_GUIDES).
 *
 * No I/O lives here so everything is unit-testable in isolation; the
 * `git ls-files` walk, file reads, GitHub API query, and `$GITHUB_OUTPUT`
 * writes live in `measure-claude-guides.mjs`. Mirrors the layout of
 * `packages/dev-tools/codebase-sins/sins.mjs`.
 */

/** A guide at or above this many characters is oversized under the policy. */
export const COMPACTOR_MAX_CHARS = 10000;

/** Oversized guides are rewritten to at most this many characters. */
export const COMPACTOR_TARGET_CHARS = 9500;

/**
 * Guides the compactor must never select, whatever their length.
 *
 * `packages/vfs-root/shared/CLAUDE.md` is the agent-facing runtime guide. It is
 * bundled into the VFS and budgeted at AGENT_CLAUDE_MAX_BYTES = 3,000 BYTES by
 * `packages/dev-tools/tools/check-doc-sizes.mjs` — an order of magnitude
 * stricter than this policy, measured in bytes rather than characters, and it
 * already sits close to its cap. It can therefore never be oversized at a
 * 10,000-char threshold, and rewriting it against the wrong unit would risk
 * breaking a tighter gate, so it is filtered out explicitly.
 * @type {ReadonlyArray<string>}
 */
export const EXCLUDED_GUIDES = ['packages/vfs-root/shared/CLAUDE.md'];

/** Head-branch prefix for the compaction branch (also the dedup key). */
export const COMPACTION_BRANCH_PREFIX = 'automation/weekend-claude-compaction-';

/** Title prefix every compaction PR shares (the second dedup key). */
export const COMPACTION_TITLE_PREFIX = 'chore(docs): compact CLAUDE.md guides';

/** The exact title the compaction PR must use. */
export const COMPACTION_PR_TITLE = 'chore(docs): compact CLAUDE.md guides for weekly headroom';

/**
 * True when `path` is a tracked file the compactor is allowed to rewrite.
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function isExcludedGuide(path) {
  return EXCLUDED_GUIDES.includes(String(path ?? '').replace(/^\.\//, ''));
}

/**
 * Normalise the accepted input shapes into `{ path, content }[]`: an array of
 * entries, a `Map<path, content>`, or a plain path→content object.
 * @param {Array<{path: string, content: string}>|Map<string, string>|Record<string, string>} entries
 * @returns {Array<{path: string, content: string}>}
 */
function toEntries(entries) {
  if (Array.isArray(entries)) return entries.map((e) => ({ path: e.path, content: e.content }));
  if (entries instanceof Map) {
    return [...entries].map(([path, content]) => ({ path, content }));
  }
  if (entries && typeof entries === 'object') {
    return Object.entries(entries).map(([path, content]) => ({ path, content }));
  }
  return [];
}

/**
 * Measure already-read guides.
 *
 * Length is JavaScript `text.length` — UTF-16 code units, the same unit the
 * repo's own size gate uses. Byte counts (`Buffer.byteLength`, `wc -c`) are NOT
 * authoritative and differ from this for any non-ASCII guide.
 *
 * Excluded guides are measured and reported but can never be `oversized`.
 *
 * @param {Array<{path: string, content: string}>|Map<string, string>|Record<string, string>} entries
 * @param {{maxChars?: number}} [options]
 * @returns {Array<{path: string, chars: number, oversized: boolean, excluded: boolean}>} sorted by path
 */
export function measureGuides(entries, { maxChars = COMPACTOR_MAX_CHARS } = {}) {
  return toEntries(entries)
    .map(({ path, content }) => {
      const chars = String(content ?? '').length;
      const excluded = isExcludedGuide(path);
      return { path, chars, oversized: !excluded && chars >= maxChars, excluded };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The oversized subset, largest first — the compaction worklist.
 * @param {ReturnType<typeof measureGuides>} measurements
 * @returns {ReturnType<typeof measureGuides>}
 */
export function selectOversized(measurements) {
  return measurements.filter((m) => m.oversized).sort((a, b) => b.chars - a.chars);
}

/**
 * The guides that were handed to Claude but came back above the compaction
 * TARGET. Checking survivors against the max only proves they left the
 * oversized band; the brief promises a rewrite to at most `targetChars`, and a
 * guide parked just under the max would be re-selected next week for nothing.
 * The worklist has to be carried from the measuring run, because after a
 * successful rewrite the paths no longer look oversized.
 * @param {Array<{path: string, chars: number}>} measurements
 * @param {{worklist?: Array<string>, targetChars: number}} opts
 * @returns {Array<{path: string, chars: number}>} above target, biggest first
 */
export function selectAboveTarget(measurements = [], opts = {}) {
  const { worklist = [], targetChars } = opts;
  const wanted = new Set(worklist.filter(Boolean));
  if (wanted.size === 0) return [];
  return measurements
    .filter((m) => wanted.has(m.path) && m.chars > targetChars)
    .sort((a, b) => b.chars - a.chars);
}

/**
 * Parse the worklist an earlier step emitted. Tolerates commas, newlines, and
 * stray whitespace so the workflow can pass it through a step output.
 * @param {string|undefined} raw
 * @returns {Array<string>}
 */
export function parseWorklist(raw) {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Group-separator formatting for readability in the table (10012 → 10,012). */
function withSeparators(n) {
  return n.toLocaleString('en-US');
}

/**
 * The measurement table for the PR body and the step summary. Rows carry the
 * BEFORE count plus an `After` column the compaction agent fills in, so the
 * same table serves the pre-run summary and the final PR body.
 * @param {ReturnType<typeof measureGuides>} measurements
 * @param {{maxChars?: number}} [options]
 * @returns {string} markdown
 */
export function formatReport(measurements, { maxChars = COMPACTOR_MAX_CHARS } = {}) {
  const rows = [...measurements].sort((a, b) => b.chars - a.chars);
  const lines = [
    `| Guide | Before | After | Status |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((m) => {
      const status = m.excluded ? 'excluded' : m.oversized ? 'oversized' : 'ok';
      const after = m.oversized ? '_pending_' : 'unchanged';
      return `| \`${m.path}\` | ${withSeparators(m.chars)} | ${after} | ${status} |`;
    }),
  ];
  const oversized = selectOversized(measurements);
  const verdict =
    oversized.length === 0
      ? `All ${measurements.length} tracked guides are under ${withSeparators(maxChars)} chars — nothing to compact.`
      : `${oversized.length} of ${measurements.length} tracked guides are at or above ${withSeparators(maxChars)} chars.`;
  return `${verdict}\n\n${lines.join('\n')}`;
}

/**
 * `automation/weekend-claude-compaction-YYYY-MM-DD` from the UTC date parts of
 * `date`. The date is a required argument rather than a `new Date()` default so
 * callers cannot accidentally depend on the wall clock.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function buildBranchName(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`buildBranchName: invalid date ${date}`);
  const stamp = d.toISOString().slice(0, 10);
  return `${COMPACTION_BRANCH_PREFIX}${stamp}`;
}

/**
 * Cross-run deduplication: the first open PR that looks like a compaction PR,
 * matched on EITHER the head-branch prefix or the title prefix (a human may
 * have renamed the branch, or the agent may have retitled the PR). Returns
 * `null` when no compaction PR is open.
 * @param {Array<{html_url?: string, url?: string, title?: string, head?: {ref?: string}}>} openPrs
 * @returns {{url: string, title: string, branch: string}|null}
 */
export function findExistingCompactionPr(openPrs) {
  const list = Array.isArray(openPrs) ? openPrs : [];
  for (const pr of list) {
    const branch = pr?.head?.ref ?? '';
    const title = pr?.title ?? '';
    if (branch.startsWith(COMPACTION_BRANCH_PREFIX) || title.startsWith(COMPACTION_TITLE_PREFIX)) {
      return { url: pr.html_url ?? pr.url ?? '', title, branch };
    }
  }
  return null;
}

/** The exact commands the agent must run, quoted verbatim into the PR body. */
const VALIDATION_COMMANDS = [
  'npm run lint:docs',
  'node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check',
  'npx prettier --check <each changed markdown file>',
  'npx vitest run --project dev-tools',
];

/**
 * Compose the compaction brief handed to claude-code-action. Pure: the caller
 * supplies the measured worklist.
 * @param {{
 *   oversized: ReturnType<typeof measureGuides>,
 *   maxChars?: number,
 *   targetChars?: number,
 *   branch?: string,
 *   report?: string,
 * }} args
 * @returns {string}
 */
export function buildPrompt({
  oversized,
  maxChars = COMPACTOR_MAX_CHARS,
  targetChars = COMPACTOR_TARGET_CHARS,
  branch = '',
  report = '',
} = {}) {
  const worklist = (oversized ?? [])
    .map(
      (m) =>
        `- \`${m.path}\` — ${withSeparators(m.chars)} chars → target ≤ ${withSeparators(targetChars)}`
    )
    .join('\n');

  return `# Weekend CLAUDE.md compaction

${(oversized ?? []).length} tracked instruction guide(s) are at or above ${withSeparators(maxChars)}
characters. Rewrite each one to **at most ${withSeparators(targetChars)} characters**, then open
exactly ONE pull request. The measurement step already ran; the worklist is
authoritative — do not go looking for other guides to shrink.

## Worklist

${worklist || '_(empty — stop and report; you should not have been invoked.)_'}

## Two budgets — do not confuse them

- The repo's committed gate is **20,000 chars** for \`packages/*/CLAUDE.md\`
  (\`PACKAGE_CLAUDE_MAX_CHARS\` in
  \`packages/dev-tools/tools/check-doc-sizes-lib.mjs\`, enforced by
  \`npm run lint:docs\`).
- The **${withSeparators(maxChars)} → ${withSeparators(targetChars)}** budget you are working to is a stricter,
  wider policy owned by this workflow: it covers every tracked file named
  \`CLAUDE.md\`, including the repo root and \`docs/\`.

**Never change a size gate, a limit constant, or an exemption to make your work
pass.** Not \`check-doc-sizes-lib.mjs\`, not \`check-doc-sizes.mjs\`, not
\`coverage-thresholds.json\`, not \`biome.json\` overrides. If a guide cannot be
compacted honestly, leave it and say so.

\`packages/vfs-root/shared/CLAUDE.md\` (the agent-facing runtime guide) is
budgeted at **3,000 bytes** — stricter than this policy and measured in bytes,
not characters. It is excluded from the worklist by construction; do not touch it.

## How to compact

1. Read the guide in full, plus enough nearby source and \`docs/\` to know what
   is load-bearing before you delete anything.
2. **Never mechanically truncate.** Do not chop trailing sections, do not
   summarise a section into nothing. Preserve: exact commands, architecture and
   layer boundaries, safety rules, non-obvious gotchas, and every link the root
   router (\`CLAUDE.md\`) depends on.
3. Cut in this order: repeated prose, stale narration of past work, restatements
   of what the code obviously does, and duplicated content that already lives in
   \`docs/\`.
4. Prefer concise tables, bullets, and links to a canonical reference over prose
   duplication.
5. When substantive detail genuinely does not fit, **move it into an appropriate
   existing document under \`docs/\`** and leave a one-line link behind. Every
   link you write must resolve — \`check-doc-refs.mjs\` fails on dead relative
   links and on dead backticked repo paths.
6. **No PR-number breadcrumbs.** No "(see #1234)", no "as of PR …", no dated
   changelog asides.
7. Do not touch guides already under ${withSeparators(maxChars)} chars purely for style. The only
   allowed edit to a small guide is a tiny navigation fix required by a document
   you moved.
8. Do not add or update dependencies. Do not change product behaviour, code, or
   configuration.

## Then

1. Create the branch \`${branch || `${COMPACTION_BRANCH_PREFIX}<YYYY-MM-DD UTC>`}\` off the current checkout.
2. Re-measure: run \`node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check\`.
   **Do not proceed unless it passes** — every tracked guide must be below
   ${withSeparators(maxChars)} chars and every stricter repo budget must still pass.
3. Run \`npm run lint:docs\`, \`npx prettier --check\` on each changed markdown
   file, and \`npx vitest run --project dev-tools\`. Fix real failures; never
   weaken a gate to make one green. Skip the full test suite — these are
   documentation-only changes.
4. Review \`git diff\` and confirm there is nothing behavioural, generated, or
   unrelated in it.
5. Commit with a conventional-commit message and push the branch:
   \`\`\`bash
   git push -u origin ${branch || `${COMPACTION_BRANCH_PREFIX}<YYYY-MM-DD UTC>`}
   \`\`\`
6. Write the pull-request body to the file named by the \`PR_BODY_FILE\`
   environment variable — e.g.
   \`cat > "$PR_BODY_FILE" <<'EOF' … EOF\`. **Do NOT run \`gh pr create\`.** A
   later, deterministic workflow step opens the PR from your pushed branch and
   that body file, because the PR must be authored by a token whose events
   trigger CI: a PR opened by your \`gh\` is authored by \`github-actions[bot]\`,
   and GitHub then queues every check on it as \`action_required\` until a human
   clicks "Approve and run". The title is fixed by that step and is exactly:
   \`${COMPACTION_PR_TITLE}\`
   The body must contain: a before/after character-count table, a link for every
   document you moved detail into, and these exact validation commands:
${VALIDATION_COMMANDS.map((c) => `   - \`${c}\``).join('\n')}
7. **Never merge the PR.** Do not enable auto-merge. Do not poll CI afterwards —
   existing automation handles follow-up failures.
8. Report a one-paragraph summary. If you are blocked, push NOTHING and write no
   body file, then report the exact blocker — the deterministic step treats an
   unpushed branch as a clean no-op, and an empty PR is worse than no PR.

${report ? `## Pre-run measurement\n\n${report}\n` : ''}`;
}
