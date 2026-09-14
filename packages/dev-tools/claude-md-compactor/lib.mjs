export const COMPACTOR_MAX_CHARS = 10000;

export const COMPACTOR_TARGET_CHARS = 9500;

export const DEFAULT_MAX_GUIDES = 0;

export const TURNS_PER_GUIDE = 300;

export const TURNS_PER_OVERFLOW_CHUNK = 50;

export const MAX_TURNS_CAP = 600;

function overflowChunks(chars, targetChars) {
  const over = Math.max(0, Number(chars) - Number(targetChars));
  if (!Number.isFinite(over) || over <= 0) return 0;
  return Math.ceil(over / 2500);
}

export function computeMaxTurns(worklist, { targetChars = COMPACTOR_TARGET_CHARS } = {}) {
  const guides = Array.isArray(worklist) ? worklist : [];
  const n = Math.max(guides.length, 1);
  let turns = TURNS_PER_GUIDE * n;
  for (const g of guides) {
    turns += overflowChunks(g?.chars, targetChars) * TURNS_PER_OVERFLOW_CHUNK;
  }
  return Math.min(MAX_TURNS_CAP, turns);
}

export const EXCLUDED_GUIDES = ['packages/vfs-root/shared/CLAUDE.md'];

export const COMPACTION_BRANCH_PREFIX = 'automation/weekend-claude-compaction-';

export const COMPACTION_TITLE_PREFIX = 'chore(docs): compact CLAUDE.md guides';

export const COMPACTION_PR_TITLE = 'chore(docs): compact CLAUDE.md guides for weekly headroom';

export const VALIDATION_COMMANDS = [
  'npm run lint:docs',
  'node packages/dev-tools/claude-md-compactor/measure-claude-guides.mjs --check',
  'npx prettier --check <each changed markdown file>',
  'npx vitest run --project dev-tools',
];

export function isExcludedGuide(path) {
  return EXCLUDED_GUIDES.includes(String(path ?? '').replace(/^\.\//, ''));
}

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

export function measureGuides(entries, { maxChars = COMPACTOR_MAX_CHARS } = {}) {
  return toEntries(entries)
    .map(({ path, content }) => {
      const chars = String(content ?? '').length;
      const excluded = isExcludedGuide(path);
      return { path, chars, oversized: !excluded && chars >= maxChars, excluded };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function selectOversized(measurements) {
  return measurements.filter((m) => m.oversized).sort((a, b) => b.chars - a.chars);
}

export function selectWorklist(measurements, { maxGuides = DEFAULT_MAX_GUIDES } = {}) {
  const all = selectOversized(measurements);
  const n = Number(maxGuides);
  if (!Number.isFinite(n) || n <= 0) return all;
  return all.slice(0, n);
}

export function parseMaxGuides(raw, fallback = DEFAULT_MAX_GUIDES) {
  const s = String(raw ?? '').trim();
  if (s === '') return fallback;
  if (!/^[0-9]+$/.test(s)) return fallback;
  return Number(s);
}

export function guideSafeName(path) {
  const trimmed = String(path ?? '').replace(/^\.\//, '');
  const stem =
    trimmed === 'CLAUDE.md' || trimmed === '' ? 'root' : trimmed.replace(/\/CLAUDE\.md$/, '');
  const safe = stem.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'root';
}

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

export function excludeBlockedGuides(worklist, blocked = []) {
  const set = new Set(
    [...blocked].map((p) => String(p ?? '').replace(/^\.\//, '')).filter(Boolean)
  );
  return (worklist ?? []).filter((m) => !set.has(m.path));
}

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

export function selectAboveTarget(measurements = [], opts = {}) {
  const { worklist = [], targetChars } = opts;
  const wanted = new Set(worklist.filter(Boolean));
  if (wanted.size === 0) return [];
  return measurements
    .filter((m) => wanted.has(m.path) && m.chars > targetChars)
    .sort((a, b) => b.chars - a.chars);
}

export function parseWorklist(raw) {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatBeforeSizes(measurements = []) {
  const obj = {};
  for (const m of [...measurements].sort((a, b) => a.path.localeCompare(b.path))) {
    if (m?.path) obj[m.path] = m.chars;
  }
  return JSON.stringify(obj);
}

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

export function selectPublishPaths({ claudeTouched = [], workflowTouched = [], shrunk = [] } = {}) {
  const blocked = new Set((workflowTouched ?? []).filter(Boolean));
  const mustPublish = new Set(
    (shrunk ?? []).map((p) => String(p ?? '').replace(/^\.\//, '')).filter(Boolean)
  );
  const out = [];
  const seen = new Set();
  for (const p of [...(shrunk ?? []), ...(claudeTouched ?? [])]) {
    const path = String(p ?? '').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    const isGuide = path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md');
    const isDocs = path === 'docs' || path.startsWith('docs/');
    if (!isGuide && !isDocs) continue;

    if (blocked.has(path) && !isGuide && !mustPublish.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function withSeparators(n) {
  return n.toLocaleString('en-US');
}

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

export function buildBranchName(date, runId = '') {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`buildBranchName: invalid date ${date}`);
  const stamp = d.toISOString().slice(0, 10);
  const id = String(runId ?? '').trim();
  return id ? `${COMPACTION_BRANCH_PREFIX}${stamp}-${id}` : `${COMPACTION_BRANCH_PREFIX}${stamp}`;
}

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

export function findExistingCompactionPr(openPrs) {
  return listCompactionPrs(openPrs)[0] ?? null;
}

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
