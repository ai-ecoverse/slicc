/*
 * Codebase "seven sins" rotation — pure logic.
 *
 * A nightly job hunts for ONE concrete instance of the "sin of the day",
 * rotating through seven agentic-codebase failure modes (ordered by severity).
 * This module is intentionally free of I/O so it can be unit-tested in
 * isolation — the `gh` calls and `$GITHUB_OUTPUT` writes live in
 * `select-sin.mjs`. Mirrors `packages/dev-tools/rum-error-triage/lib.mjs`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(HERE, 'prompts');

/** Build one sin record. `n` is the 1-based rank used in the prompt filename. */
function sin(n, id, name, summary) {
  return {
    id,
    name,
    label: `debt:${id}`,
    promptFile: join(PROMPTS_DIR, `${n}-${id}.md`),
    summary,
  };
}

/**
 * The seven sins, ordered by the severity ranking. The rotation maps
 * `dayOfYearUTC % 7` onto this array, so the sin drifts by one each day and
 * cycles through the full set independently of the weekday.
 * @type {ReadonlyArray<{id: string, name: string, label: string, promptFile: string, summary: string}>}
 */
export const SINS = [
  sin(
    1,
    'complicatification',
    'Complicatification',
    'Easy things done the hard way: needless abstraction, clever one-liners, reinvented stdlib, over-engineered patterns.'
  ),
  sin(
    2,
    'entanglement',
    'Entanglement',
    'Muddy module boundaries and wrong call directions: layering violations, circular deps, god objects.'
  ),
  sin(
    3,
    'drift',
    'Drift',
    'Code vs. comments/docs/names out of sync: contradicting comments, stale docs, lying TODOs.'
  ),
  sin(
    4,
    'duplication',
    'Duplication',
    'Multiple implementations of the same thing: copy-paste, parallel implementations, repeated constants.'
  ),
  sin(
    5,
    'bloat',
    'Bloat',
    'Gigantic files/functions/classes, deep nesting, modules doing too much.'
  ),
  sin(
    6,
    'necrophilia',
    'Necrophilia',
    'Dead code: unused functions, unreferenced files, commented-out code, exports nobody imports.'
  ),
  sin(
    7,
    'paranoia',
    'Paranoia',
    'Overly defensive programming: redundant null checks, catch-all try/catch, validation of impossible states.'
  ),
];

/**
 * The 1-based UTC day-of-year for a date (Jan 1 → 1).
 * @param {Date} d
 * @returns {number}
 */
function dayOfYearUTC(d) {
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - startOfYear) / 86_400_000) + 1;
}

/**
 * The sin of the given day via day-of-year (UTC) mod 7. Deterministic for a
 * given `date` argument (defaults to the current date). Drifts by one each day,
 * independent of weekday, and cycles through all seven.
 * @param {Date} [date]
 * @returns {(typeof SINS)[number]}
 */
export function selectSinOfDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return SINS[dayOfYearUTC(d) % SINS.length];
}

/**
 * Resolve a workflow_dispatch override that may be a 1-7 rank or a sin
 * name/id. Falls back to `selectSinOfDay()` when empty or invalid. Pure.
 * @param {string|number|null|undefined} override
 * @returns {(typeof SINS)[number]}
 */
export function resolveSin(override) {
  if (override === null || override === undefined) return selectSinOfDay();
  const raw = String(override).trim();
  if (raw === '') return selectSinOfDay();
  if (/^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= SINS.length) return SINS[n - 1];
    return selectSinOfDay();
  }
  const key = raw.toLowerCase();
  const match = SINS.find((s) => s.id === key || s.name.toLowerCase() === key);
  return match ?? selectSinOfDay();
}

/**
 * The shared filing/dedup/header boilerplate, written ONCE here so the seven
 * prompt files only carry their per-sin body. Interpolates the day's sin id,
 * name, and label into the instructions Claude follows.
 * @param {(typeof SINS)[number]} s
 * @returns {string}
 */
function filingInstructions(s) {
  return `## How to investigate and file

You are auditing THIS repository for a single, concrete instance of the sin
above. Work **read-only**: use Read, Grep, Glob, and \`git\` to gather evidence;
do not edit code.

1. Find the **single most impactful** instance of this sin. One issue per run —
   pick the worst offender, not a list. A noisy or wrong issue is worse than
   none, so be conservative.
2. **Before filing, steer clear of work already in flight.** Run:
   - \`gh issue list --state open\`
   - \`gh pr list --state open\`
   - \`gh issue list --search "agentic-debt:${s.id} in:body" --state all\`
   If the file or area is already covered by an open issue or open PR, or a
   prior issue already documents this exact instance, **skip and file nothing**.
3. If — and only if — you found a solid, un-covered instance, file **exactly
   one** issue with \`gh issue create\`:
   - a concise, specific title;
   - a body containing: the \`file:line\` evidence, why it exemplifies
     **${s.name}**, the occurrence/scope, and a concrete suggested remediation;
   - the exact marker line on its own: \`<!-- agentic-debt:${s.id} -->\`;
   - \`--label agentic-debt --label ${s.label}\`.
4. If nothing solid is found, **file nothing** and print a one-line reason why.`;
}

/**
 * Compose the final prompt = shared filing/dedup/header boilerplate + the
 * per-sin body. Pure; `promptBody` is the file content read by the CLI.
 * @param {(typeof SINS)[number]} s the day's sin
 * @param {string} promptBody the per-sin body loaded from `s.promptFile`
 * @returns {string}
 */
export function buildPrompt(s, promptBody) {
  return `# Agentic-debt triage — Sin of the day: ${s.name}

> ${s.summary}

## What to hunt for

${String(promptBody ?? '').trim()}

${filingInstructions(s)}
`;
}
