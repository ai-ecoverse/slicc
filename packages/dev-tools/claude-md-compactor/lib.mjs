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
 * Guides handed to one Claude *job*. Dispatch 33309651347 ended its turn with
 * "I'll wait for the agents to complete" after being given all 8 oversized
 * files at once and wrote nothing. The workflow fans out one Claude job per
 * oversized guide (this default 0 = all of them, largest first) and
 * consolidates the shards into one PR. A positive cap still means "largest N".
 */
export const DEFAULT_MAX_GUIDES = 0;

/**
 * Claude turns budgeted per worklist guide. Dispatch 33320764465 handed one
 * 19,998-char file a fixed 250 turns, hit the cap at 9,609 (109 over target),
 * and the compact step failed even though recover still opened #2678. 300 is
 * the floor for a just-over-10k rewrite; overflow below adds more.
 */
export const TURNS_PER_GUIDE = 300;

/** Extra turns per 2,500 characters a worklist guide is above the target. */
export const TURNS_PER_OVERFLOW_CHUNK = 50;

/** Ceiling so an 8-file dispatch cannot run for hours. */
export const MAX_TURNS_CAP = 600;

/** @param {number} chars @param {number} targetChars */
function overflowChunks(chars, targetChars) {
  const over = Math.max(0, Number(chars) - Number(targetChars));
  if (!Number.isFinite(over) || over <= 0) return 0;
  return Math.ceil(over / 2500);
}

/**
 * `--max-turns` for this run. Scales with how many guides Claude is actually
 * asked to rewrite, plus how far over the target they are. A fixed 250
 * starved a single 20k file (33320764465) and would starve an 8-file
 * worklist even harder.
 * @param {Array<{chars?: number}>} worklist
 * @param {{targetChars?: number}} [options]
 * @returns {number}
 */
export function computeMaxTurns(worklist, { targetChars = COMPACTOR_TARGET_CHARS } = {}) {
  const guides = Array.isArray(worklist) ? worklist : [];
  const n = Math.max(guides.length, 1);
  let turns = TURNS_PER_GUIDE * n;
  for (const g of guides) {
    turns += overflowChunks(g?.chars, targetChars) * TURNS_PER_OVERFLOW_CHUNK;
  }
  return Math.min(MAX_TURNS_CAP, turns);
}

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

/** The exact commands the agent must run, quoted verbatim into the PR body. */
export const VALIDATION_COMMANDS = [
  'npm run lint:docs',
  'node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check',
  'npx prettier --check <each changed markdown file>',
  'npx vitest run --project dev-tools',
];

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
 * The worklist for this run: the largest `maxGuides` oversized files.
 * `maxGuides <= 0` (the default) means every oversized guide — the workflow
 * then fans those out as one Claude job each.
 * @param {ReturnType<typeof measureGuides>} measurements
 * @param {{maxGuides?: number}} [options]
 * @returns {ReturnType<typeof measureGuides>}
 */
export function selectWorklist(measurements, { maxGuides = DEFAULT_MAX_GUIDES } = {}) {
  const all = selectOversized(measurements);
  const n = Number(maxGuides);
  if (!Number.isFinite(n) || n <= 0) return all;
  return all.slice(0, n);
}

/**
 * `MAX_GUIDES` env: empty → default (all); `0` → all; a positive integer →
 * largest N. Invalid strings fall back to the default rather than throwing,
 * matching the other optional numeric env vars.
 * @param {string|undefined} raw
 * @param {number} [fallback]
 * @returns {number}
 */
export function parseMaxGuides(raw, fallback = DEFAULT_MAX_GUIDES) {
  const s = String(raw ?? '').trim();
  if (s === '') return fallback;
  if (!/^[0-9]+$/.test(s)) return fallback;
  return Number(s);
}

/**
 * Artifact-safe id for a guide path (`packages/ios-app/CLAUDE.md` →
 * `packages-ios-app`). GitHub artifact names reject `/` and a few other
 * characters.
 * @param {string} path
 * @returns {string}
 */
export function guideSafeName(path) {
  const trimmed = String(path ?? '').replace(/^\.\//, '');
  const stem =
    trimmed === 'CLAUDE.md' || trimmed === '' ? 'root' : trimmed.replace(/\/CLAUDE\.md$/, '');
  const safe = stem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'root';
}

/**
 * Dynamic Actions matrix: one include row per worklist guide. `max_turns` is
 * per shard (one file), not the whole worklist — fan-out is what makes an
 * 8-file Saturday finish in one wall-clock budget instead of 8 sequential
 * 550-turn jobs.
 * @param {ReturnType<typeof measureGuides>} worklist
 * @param {{targetChars?: number}} [options]
 * @returns {{include: Array<{guide: string, safe_name: string, max_turns: string, chars: string}>}}
 */
export function buildCompactMatrix(worklist, { targetChars = COMPACTOR_TARGET_CHARS } = {}) {
  return {
    include: (Array.isArray(worklist) ? worklist : []).map((m) => ({
      guide: m.path,
      safe_name: guideSafeName(m.path),
      max_turns: String(computeMaxTurns([m], { targetChars })),
      chars: String(m.chars),
    })),
  };
}

/**
 * `CLAUDE.md` paths already in an open compaction PR — the next run must not
 * re-select them (boy-scout "claimed file set"), but it *should* still compact
 * every other oversized guide.
 * @param {Array<{filename?: string}|string>} prFiles
 * @returns {string[]}
 */
export function blockedGuidePaths(prFiles = []) {
  const out = [];
  const seen = new Set();
  for (const f of prFiles ?? []) {
    const path = String(typeof f === 'string' ? f : (f?.filename ?? '')).replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    if (path !== 'CLAUDE.md' && !path.endsWith('/CLAUDE.md')) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Drop worklist entries whose path is already in an open compaction PR.
 * @param {ReturnType<typeof measureGuides>} worklist
 * @param {Iterable<string>} blocked
 * @returns {ReturnType<typeof measureGuides>}
 */
export function excludeBlockedGuides(worklist, blocked = []) {
  const set = new Set(
    [...blocked].map((p) => String(p ?? '').replace(/^\.\//, '')).filter(Boolean)
  );
  return (worklist ?? []).filter((m) => !set.has(m.path));
}

/**
 * Reassemble per-shard `--pack` progress into one assessment so the
 * consolidate job can write a single PR body.
 * @param {Array<{
 *   worklist?: Array<string>,
 *   before?: Record<string, number>,
 *   after?: Array<{path: string, chars: number, oversized?: boolean}>,
 * }>} shards
 * @param {{maxChars?: number, targetChars?: number}} [options]
 * @returns {ReturnType<typeof assessCompactionProgress>}
 */
function shardWorklist(shards) {
  const worklist = [];
  const seen = new Set();
  for (const s of shards ?? []) {
    for (const p of s?.worklist ?? []) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      worklist.push(p);
    }
  }
  return worklist;
}

function shardBefore(shards) {
  /** @type {Record<string, number>} */
  const before = {};
  for (const s of shards ?? []) {
    const b = s?.before;
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    for (const [path, chars] of Object.entries(b)) {
      const n = Number(chars);
      if (path && Number.isFinite(n)) before[path] = n;
    }
  }
  return before;
}

function shardAfter(shards, maxChars) {
  const afterByPath = new Map();
  for (const s of shards ?? []) {
    for (const m of s?.after ?? []) {
      if (!m?.path) continue;
      const chars = Number(m.chars);
      if (!Number.isFinite(chars)) continue;
      afterByPath.set(m.path, {
        path: m.path,
        chars,
        oversized: typeof m.oversized === 'boolean' ? m.oversized : chars >= maxChars,
      });
    }
  }
  return [...afterByPath.values()];
}

export function mergeShardProgress(
  shards = [],
  { maxChars = COMPACTOR_MAX_CHARS, targetChars = COMPACTOR_TARGET_CHARS } = {}
) {
  return assessCompactionProgress({
    before: shardBefore(shards),
    after: shardAfter(shards, maxChars),
    worklist: shardWorklist(shards),
    maxChars,
    targetChars,
  });
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

/**
 * Encode the worklist's pre-Claude sizes so a later `--progress` step can
 * compare them. Compact JSON object, path → char count, keys sorted.
 * @param {Array<{path: string, chars: number}>} measurements
 * @returns {string}
 */
export function formatBeforeSizes(measurements = []) {
  const obj = {};
  for (const m of [...measurements].sort((a, b) => a.path.localeCompare(b.path))) {
    if (m?.path) obj[m.path] = m.chars;
  }
  return JSON.stringify(obj);
}

/**
 * Parse the measure step's `before_sizes` payload. Accepts a JSON object,
 * a JSON array of `{path, chars}`, or `path:chars` pairs split on commas /
 * newlines (last colon wins so a Windows path cannot be a problem here —
 * these paths are repo-relative).
 * @param {string|undefined} raw
 * @returns {Map<string, number>}
 */
export function parseBeforeSizes(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return new Map();
  if (s.startsWith('{') || s.startsWith('[')) {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      return new Map(parsed.filter((e) => e?.path).map((e) => [e.path, Number(e.chars)]));
    }
    return new Map(Object.entries(parsed).map(([path, chars]) => [path, Number(chars)]));
  }
  const map = new Map();
  for (const part of s.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0) continue;
    const n = Number(trimmed.slice(idx + 1));
    if (Number.isFinite(n)) map.set(trimmed.slice(0, idx), n);
  }
  return map;
}

/** @param {Map<string, number>|Record<string, number>|Array<{path: string, chars: number}>|string|undefined} before */
function toCharMap(before) {
  if (before instanceof Map) return before;
  if (typeof before === 'string') return parseBeforeSizes(before);
  if (Array.isArray(before)) {
    return new Map(before.filter((e) => e?.path).map((e) => [e.path, Number(e.chars)]));
  }
  if (before && typeof before === 'object') {
    return new Map(Object.entries(before).map(([path, chars]) => [path, Number(chars)]));
  }
  return new Map();
}

function progressStatus(row, { maxChars, targetChars }) {
  if (row.beforeChars == null || row.afterChars == null) return 'missing';
  if (row.delta > 0) return 'grew';
  if (row.afterChars <= targetChars) return row.delta < 0 ? 'compacted' : 'at target';
  if (row.afterChars >= maxChars) return row.delta < 0 ? 'still oversized' : 'unchanged';
  return row.delta < 0 ? 'above target' : 'unchanged';
}

function formatDelta(n) {
  if (n === 0) return '0';
  const abs = withSeparators(Math.abs(n));
  return n < 0 ? `-${abs}` : `+${abs}`;
}

/**
 * Compare the worklist's pre-Claude sizes to the working tree. Recoverable
 * when at least one selected guide strictly shrank, none grew, none went
 * missing, and no *new* guide (off the worklist) became oversized. Hitting
 * the policy target is still `policyOk`; falling short with real shrinkage
 * is `recovered` — the workflow opens a partial PR either way.
 * @param {{
 *   before?: Map<string, number>|Record<string, number>|Array<{path: string, chars: number}>|string,
 *   after?: Array<{path: string, chars: number, oversized?: boolean}>,
 *   worklist?: Array<string>,
 *   maxChars?: number,
 *   targetChars?: number,
 * }} [opts]
 * @returns {{
 *   policyOk: boolean,
 *   recovered: boolean,
 *   openPr: boolean,
 *   shrunk: Array<{path: string, beforeChars: number, afterChars: number, delta: number}>,
 *   grew: Array<{path: string, beforeChars: number, afterChars: number, delta: number}>,
 *   unchanged: Array<{path: string, beforeChars: number, afterChars: number, delta: number}>,
 *   missing: Array<{path: string, beforeChars: number|null, afterChars: number|null, delta: number|null}>,
 *   newOversized: Array<{path: string, chars: number}>,
 *   missedTarget: Array<{path: string, chars: number}>,
 *   stillOversized: Array<{path: string, chars: number}>,
 *   rows: Array<{path: string, beforeChars: number|null, afterChars: number|null, delta: number|null}>,
 * }}
 */
export function assessCompactionProgress({
  before,
  after = [],
  worklist = [],
  maxChars = COMPACTOR_MAX_CHARS,
  targetChars = COMPACTOR_TARGET_CHARS,
} = {}) {
  const beforeMap = toCharMap(before);
  const afterByPath = new Map((after ?? []).map((m) => [m.path, m]));
  const wanted = [...new Set((worklist ?? []).filter(Boolean))];

  const rows = wanted.map((path) => {
    const beforeChars = beforeMap.has(path) ? beforeMap.get(path) : null;
    const afterChars = afterByPath.has(path) ? afterByPath.get(path).chars : null;
    const delta = beforeChars == null || afterChars == null ? null : afterChars - beforeChars;
    return { path, beforeChars, afterChars, delta };
  });

  const shrunk = rows.filter((r) => r.delta != null && r.delta < 0);
  const grew = rows.filter((r) => r.delta != null && r.delta > 0);
  const unchanged = rows.filter((r) => r.delta === 0);
  const missing = rows.filter((r) => r.beforeChars == null || r.afterChars == null);

  const oversized = (after ?? []).filter((m) => m.oversized);
  const wantedSet = new Set(wanted);
  // A guide that was already oversized at measure time (in `before`) but not
  // on this run's worklist is deferred, not a regression. "New" means it was
  // not oversized going in.
  const newOversized = oversized.filter((m) => !beforeMap.has(m.path));
  const missedTarget = selectAboveTarget(after, { worklist: wanted, targetChars });
  const stillOversized = oversized.filter((m) => wantedSet.has(m.path));

  const policyOk = oversized.length === 0 && missedTarget.length === 0;
  const recovered =
    !policyOk &&
    shrunk.length > 0 &&
    grew.length === 0 &&
    missing.length === 0 &&
    newOversized.length === 0;

  return {
    policyOk,
    recovered,
    openPr: policyOk || recovered,
    shrunk,
    grew,
    unchanged,
    missing,
    newOversized,
    missedTarget,
    stillOversized,
    rows,
  };
}

/**
 * Markdown table of before → after for the worklist, used in the step summary
 * and the synthesised partial-PR body.
 * @param {ReturnType<typeof assessCompactionProgress>} assessment
 * @param {{maxChars?: number, targetChars?: number}} [options]
 * @returns {string}
 */
export function formatProgressReport(
  assessment,
  { maxChars = COMPACTOR_MAX_CHARS, targetChars = COMPACTOR_TARGET_CHARS } = {}
) {
  const rows = assessment?.rows ?? [];
  const lines = [
    `| Guide | Before | After | Δ | Status |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows.map((r) => {
      const status = progressStatus(r, { maxChars, targetChars });
      const before = r.beforeChars == null ? '—' : withSeparators(r.beforeChars);
      const after = r.afterChars == null ? '—' : withSeparators(r.afterChars);
      const delta = r.delta == null ? '—' : formatDelta(r.delta);
      return `| \`${r.path}\` | ${before} | ${after} | ${delta} | ${status} |`;
    }),
  ];
  const n = assessment?.shrunk?.length ?? 0;
  const verdict = assessment?.policyOk
    ? `All selected guides are at or below ${withSeparators(targetChars)} chars.`
    : assessment?.recovered
      ? `${n} selected guide(s) got smaller; the policy target was not met.`
      : 'No recoverable progress — selected guides did not get smaller (or some grew).';
  return `${verdict}\n\n${lines.join('\n')}`;
}

/**
 * PR body written when Claude shrank guides but did not hit the target (and
 * therefore may not have written `$PR_BODY_FILE`). The workflow opens this
 * rather than discarding the shrinkage.
 * @param {ReturnType<typeof assessCompactionProgress>} assessment
 * @param {{maxChars?: number, targetChars?: number}} [options]
 * @returns {string}
 */
export function buildPartialPrBody(
  assessment,
  { maxChars = COMPACTOR_MAX_CHARS, targetChars = COMPACTOR_TARGET_CHARS } = {}
) {
  const table = formatProgressReport(assessment, { maxChars, targetChars });
  return `Partial CLAUDE.md compaction. The weekly policy target (≤ ${withSeparators(targetChars)} chars per selected guide; oversized at ${withSeparators(maxChars)}) was not met, but the selected guides did get smaller, so this PR lands the progress rather than discarding it.

A later Saturday run will skip the guides this PR already touches (the claimed-file dedup rule) and compact any others that are still oversized. Merge it so those files leave the claimed set.

${table}

## Validation

${VALIDATION_COMMANDS.map((c) => `- \`${c}\``).join('\n')}
`;
}

/**
 * PR body for either a full hit (`policyOk`) or a recovered partial. The
 * workflow synthesises this whenever Claude left `$PR_BODY_FILE` empty —
 * hitting the target and then max-turns before writing the body used to
 * skip `gh pr create`.
 * @param {ReturnType<typeof assessCompactionProgress>} assessment
 * @param {{maxChars?: number, targetChars?: number}} [options]
 * @returns {string}
 */
export function buildCompactionPrBody(
  assessment,
  { maxChars = COMPACTOR_MAX_CHARS, targetChars = COMPACTOR_TARGET_CHARS } = {}
) {
  if (!assessment?.policyOk) return buildPartialPrBody(assessment, { maxChars, targetChars });
  const table = formatProgressReport(assessment, { maxChars, targetChars });
  return `CLAUDE.md compaction. Selected guides are at or below ${withSeparators(targetChars)} chars (oversized at ${withSeparators(maxChars)}).

${table}

## Validation

${VALIDATION_COMMANDS.map((c) => `- \`${c}\``).join('\n')}
`;
}

/**
 * Files a shard may copy onto `origin/main`. Worklist `CLAUDE.md` files and
 * `docs/` overflow Claude actually edited. YAML/scripts cannot leak because
 * they are neither guides nor `docs/`.
 *
 * Dispatch 33368791853 / #2682: Claude wrote four new sections into
 * `docs/dev-tools-details.md`, then `--pack` dropped them because #2676 also
 * touches that path (`workflowTouched`). Compact jobs now check out
 * `origin/main`'s `docs/` before Claude runs, so the working-tree copy is
 * main + overflow — publish Claude-touched docs even when the workflow PR
 * listed the same path.
 * @param {{
 *   claudeTouched?: Array<string>,
 *   workflowTouched?: Array<string>,
 *   shrunk?: Array<string>,
 * }} [opts]
 * @returns {string[]}
 */
export function selectPublishPaths({ claudeTouched = [], shrunk = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const p of [...(shrunk ?? []), ...(claudeTouched ?? [])]) {
    const path = String(p ?? '').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    const isGuide = path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md');
    const isDocs = path === 'docs' || path.startsWith('docs/');
    if (!isGuide && !isDocs) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
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
 * `date`. Optional `runId` (Actions `GITHUB_RUN_ID`) is appended so a
 * same-day re-dispatch cannot reopen a closed PR that already used the
 * date-only name (observed: #2677). The date is a required argument rather
 * than a `new Date()` default so callers cannot accidentally depend on the
 * wall clock.
 * @param {Date|string|number} date
 * @param {string|number} [runId]
 * @returns {string}
 */
export function buildBranchName(date, runId = '') {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`buildBranchName: invalid date ${date}`);
  const stamp = d.toISOString().slice(0, 10);
  const id = String(runId ?? '').trim();
  return id ? `${COMPACTION_BRANCH_PREFIX}${stamp}-${id}` : `${COMPACTION_BRANCH_PREFIX}${stamp}`;
}

/**
 * Open PRs that look like compaction PRs, matched on EITHER the head-branch
 * prefix or the title prefix (a human may have renamed the branch, or the
 * agent may have retitled the PR). Used to claim files, not to skip the run.
 * @param {Array<{html_url?: string, url?: string, title?: string, number?: number, head?: {ref?: string}}>} openPrs
 * @returns {Array<{url: string, title: string, branch: string, number: number|null}>}
 */
export function listCompactionPrs(openPrs) {
  const list = Array.isArray(openPrs) ? openPrs : [];
  const out = [];
  for (const pr of list) {
    const branch = pr?.head?.ref ?? '';
    const title = pr?.title ?? '';
    if (branch.startsWith(COMPACTION_BRANCH_PREFIX) || title.startsWith(COMPACTION_TITLE_PREFIX)) {
      out.push({
        url: pr.html_url ?? pr.url ?? '',
        title,
        branch,
        number: typeof pr.number === 'number' ? pr.number : null,
      });
    }
  }
  return out;
}

/**
 * First open compaction PR, or `null`. Kept for summaries; file-level
 * exclusion uses `listCompactionPrs` plus each PR's changed files.
 * @param {Array<{html_url?: string, url?: string, title?: string, number?: number, head?: {ref?: string}}>} openPrs
 * @returns {{url: string, title: string, branch: string, number: number|null}|null}
 */
export function findExistingCompactionPr(openPrs) {
  return listCompactionPrs(openPrs)[0] ?? null;
}

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

${(oversized ?? []).length} tracked instruction guide(s) on this run's worklist
are at or above ${withSeparators(maxChars)} characters. Rewrite **each worklist
file** to **at most ${withSeparators(targetChars)} characters**. The measurement
step already ran; the worklist is authoritative — do not go looking for other
guides to shrink, and do not compact rows that are not on the worklist.

**This job has no subagents and does not resume after you stop.** Do not spawn
agents, do not background work, do not say you will wait. If you end the turn
before using Edit/Write on every worklist path, the runner discards the session
and the files stay unchanged (observed: dispatch 33309651347, result "I'll wait
for the agents to complete"). Compact the worklist **yourself**, sequentially,
in this process.

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

0. Use **Edit** or **Write** (or a Bash rewrite of the worklist path) on each
   worklist file **in this session**. Do not delegate. Do not end the turn
   until those writes have landed.
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

Stop once every worklist file (and any overflow you moved under \`docs/\`) is
saved on disk. **Do not create a branch, do not commit, do not push, do not
run tests or prettier.** A later workflow step measures the working tree,
commits only those files onto \`${branch || `${COMPACTION_BRANCH_PREFIX}<YYYY-MM-DD UTC>`}\` branched from \`origin/main\`, and opens the PR. Spending turns
on git or \`npm\` is how earlier dispatches hit max-turns with the rewrite
still above target (33312644577: 19,998 → ~10,286 then cap).

Optionally write the pull-request body to the file named by \`PR_BODY_FILE\`
— e.g. \`cat > "$PR_BODY_FILE" <<'EOF' … EOF\`. If you skip it, the workflow
synthesises one from the before/after sizes. **Do NOT run \`gh pr create\`.**
The title is fixed by that step and is exactly: \`${COMPACTION_PR_TITLE}\`

If a body is written it must contain a before/after character-count table, a
link for every document you moved detail into, and these exact validation
commands:
${VALIDATION_COMMANDS.map((c) => `- \`${c}\``).join('\n')}

**Never merge the PR.** Do not enable auto-merge. Do not poll CI afterwards.
Report a one-paragraph summary of what you cut and where overflow went.

${report ? `## Pre-run measurement\n\n${report}\n` : ''}`;
}
