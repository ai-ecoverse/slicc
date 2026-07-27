/*
 * Flake ledger — pure logic.
 *
 * CI retries `node-server` and `chrome-extension` once (see `vitest.config.ts`).
 * A test that fails attempt 1 and passes attempt 2 leaves the build green and
 * says nothing, so this module reconstructs those retries from the test-timing
 * artifacts and turns them into a deduplicated list of flaky tests.
 *
 * Two input shapes are supported:
 *
 *  1. `vitest.json` — vitest's built-in `json` reporter. It has NO retry field.
 *     The retry evidence survives indirectly: vitest accumulates every
 *     attempt's errors on `task.result.errors` and only the FINAL state is
 *     reported, so a test that passed on retry appears as
 *     `status: "passed"` with a non-empty `failureMessages` array. Verified
 *     empirically against vitest 4.1.10 (`it.fails` does not produce this
 *     shape, so expected failures are not false positives).
 *  2. `flakes.json` — the ledger's own reporter (`flake-reporter.mjs`), which
 *     reads `TestCase.diagnostic().retryCount` and is exact.
 *
 * It is intentionally free of I/O so it can be unit-tested in isolation; the
 * `gh` calls live in `sweep-flakes.mjs`.
 */
import { createHash } from 'node:crypto';

/** `kind` marker written by `flake-reporter.mjs`. */
export const LEDGER_KIND = 'slicc-flake-ledger';

/** Label used for filing and deduplicating flake issues. */
export const FLAKE_LABEL = 'debt:flake';

/** Marker embedded in issue bodies so later sweeps recognise a filed flake. */
const FP_MARKER = /flake-fp:\s*([0-9a-f]{6,64})/gi;

/**
 * Normalize an absolute test path to a repo-relative one. Artifacts are
 * produced on a CI runner, so the absolute prefix differs from any local
 * checkout and must not leak into fingerprints.
 * @param {string|null|undefined} file
 * @returns {string}
 */
export function toRepoRelativePath(file) {
  const p = String(file ?? '').replace(/\\/g, '/');
  const idx = p.lastIndexOf('/packages/');
  if (idx !== -1) return p.slice(idx + 1);
  if (p.startsWith('packages/')) return p;
  return p.replace(/^\/+/, '');
}

/**
 * Best-effort vitest project name for a test file. Mirrors the project names
 * in `vitest.config.ts`, where `packages/shared-ts` is the `shared` project.
 * @param {string} file repo-relative or absolute test path
 * @returns {string}
 */
export function inferProject(file) {
  const rel = toRepoRelativePath(file);
  const m = /^packages\/([^/]+)\//.exec(rel);
  if (!m) return 'unknown';
  return m[1] === 'shared-ts' ? 'shared' : m[1];
}

/**
 * Canonical form of a full test name. The two input shapes spell the same test
 * differently — `flake-reporter.mjs` joins suites with ` > ` while vitest's
 * `json` reporter joins them with a plain space — so both must collapse to one
 * key or the same flake would be filed twice.
 * @param {string|null|undefined} testName
 * @returns {string}
 */
export function normalizeTestName(testName) {
  return String(testName ?? '')
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable fingerprint for a flaky test. Keyed on project + repo-relative file +
 * canonical test name, so the same flake groups across runs and CI jobs.
 * @param {{project?: string, file?: string, testName?: string}} flake
 * @returns {string} 12-hex-char fingerprint
 */
export function fingerprint(flake) {
  const key = [
    flake?.project ?? 'unknown',
    toRepoRelativePath(flake?.file),
    normalizeTestName(flake?.testName),
  ].join('\u0000');
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** First meaningful line of a failure message, trimmed to a readable length. */
function firstLine(message, max = 300) {
  const line = String(message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, max) : '';
}

function normalizeRecord(raw) {
  const file = toRepoRelativePath(raw.file);
  const record = {
    project: raw.project || inferProject(file),
    file,
    testName: String(raw.testName ?? '').trim(),
    attempts: Math.max(2, Number(raw.attempts) || 0),
    failureMessage: firstLine(raw.failureMessage),
    source: raw.source,
  };
  return { ...record, fingerprint: fingerprint(record) };
}

/**
 * Extract flakes from vitest's built-in `json` reporter output.
 *
 * A flake is a test whose FINAL status is `passed` but which still carries
 * failure messages from an earlier attempt. A test that failed every attempt
 * has status `failed` and is a genuine failure, not a flake — it is skipped.
 * @param {any} report parsed `vitest.json`
 * @param {{project?: string}} [opts] project override (e.g. from the artifact name)
 * @returns {Array<object>} normalized flake records
 */
export function extractFlakesFromVitestJson(report, opts = {}) {
  const out = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status !== 'passed') continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      if (messages.length === 0) continue;
      out.push(
        normalizeRecord({
          project: opts.project,
          file: file?.name,
          testName: assertion.fullName || assertion.title,
          // Each failed attempt contributes at least one error, so this is a
          // lower bound on the real attempt count, never an over-count.
          attempts: messages.length + 1,
          failureMessage: messages[0],
          source: 'vitest-json',
        })
      );
    }
  }
  return out;
}

/**
 * Extract flakes from `flake-reporter.mjs` output, which carries the exact
 * `retryCount` from vitest's reporter API.
 * @param {any} report parsed `flakes.json`
 * @returns {Array<object>} normalized flake records
 */
export function extractFlakesFromLedger(report) {
  return (report?.flakes ?? []).map((f) =>
    normalizeRecord({
      project: f?.project,
      file: f?.file,
      testName: f?.testName,
      attempts: (Number(f?.retryCount) || 0) + 1,
      failureMessage: f?.failureMessage,
      source: 'flake-reporter',
    })
  );
}

/**
 * Parse one artifact payload into flake records, dispatching on its shape.
 * Returns `[]` for missing, empty, or unparseable input rather than throwing —
 * a sweep over dozens of CI artifacts must survive a truncated upload.
 * @param {string|null|undefined} text raw file contents
 * @param {{project?: string}} [opts]
 * @returns {Array<object>}
 */
export function parseReport(text, opts = {}) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed?.kind === LEDGER_KIND) return extractFlakesFromLedger(parsed);
  if (Array.isArray(parsed?.testResults)) return extractFlakesFromVitestJson(parsed, opts);
  return [];
}

/** Fold one further sighting of a known flake into its aggregate entry. */
function mergeFlake(existing, record, runId) {
  // One CI run can emit both artifact shapes for the same retry; count the
  // event once so `occurrences` stays a count of retried runs.
  const sameRun = runId !== null && existing.runIds.includes(runId);
  if (!sameRun) {
    existing.occurrences += 1;
    if (runId) existing.runIds.push(runId);
  }
  existing.maxAttempts = Math.max(existing.maxAttempts, record.attempts);
  if (!existing.failureMessage && record.failureMessage) {
    existing.failureMessage = record.failureMessage;
  }
  // A reporter-sourced record is exact; prefer its provenance and its richer
  // ` > `-separated test name.
  if (record.source === 'flake-reporter') {
    existing.source = record.source;
    existing.testName = record.testName;
  }
}

/**
 * Aggregate flake records across many artifacts into one entry per test.
 *
 * Each input describes one artifact: `{ text, project, runId }`. `runId`
 * identifies the CI run so a flake seen in three different runs reports
 * `runs: 3` — frequency is what makes one flake worth fixing before another.
 * @param {Array<{text?: string|null, project?: string, runId?: string|number}>} inputs
 * @returns {Array<object>} aggregated flakes, most frequent first
 */
export function aggregateFlakes(inputs) {
  /** @type {Map<string, any>} */
  const byFp = new Map();
  for (const input of inputs ?? []) {
    const records = parseReport(input?.text, { project: input?.project });
    const runId = input?.runId == null ? null : String(input.runId);
    for (const record of records) {
      const existing = byFp.get(record.fingerprint);
      if (existing) mergeFlake(existing, record, runId);
      else
        byFp.set(record.fingerprint, {
          ...record,
          occurrences: 1,
          maxAttempts: record.attempts,
          runIds: runId ? [runId] : [],
        });
    }
  }
  return [...byFp.values()]
    .map((f) => ({ ...f, runs: f.runIds.length }))
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences || b.runs - a.runs || a.testName.localeCompare(b.testName)
    );
}

/**
 * Map `flake-fp:<fingerprint>` markers found in existing issues to their issue
 * number, so a recurring flake updates its issue instead of opening a new one.
 * @param {Array<{number?: number, body?: string, state?: string}>} issues as returned by `gh issue list --json number,body,state`
 * @returns {Map<string, {number: number, state: string}>}
 */
export function parseFingerprints(issues) {
  /** @type {Map<string, {number: number, state: string}>} */
  const map = new Map();
  for (const issue of issues ?? []) {
    for (const m of String(issue?.body ?? '').matchAll(FP_MARKER)) {
      const fp = m[1].toLowerCase();
      // Prefer an open issue over a closed one for the same flake.
      const state = String(issue?.state ?? 'OPEN').toUpperCase();
      const prior = map.get(fp);
      if (prior && prior.state === 'OPEN' && state !== 'OPEN') continue;
      map.set(fp, { number: Number(issue?.number), state });
    }
  }
  return map;
}

/**
 * Split aggregated flakes into ones needing a new issue and ones whose issue
 * already exists (and so should be commented on / reopened).
 * @param {Array<object>} flakes aggregated flakes
 * @param {Map<string, {number: number, state: string}>} filed see parseFingerprints
 * @returns {{fresh: Array<object>, recurring: Array<object>}}
 */
export function partitionFlakes(flakes, filed) {
  const known = filed ?? new Map();
  const fresh = [];
  const recurring = [];
  for (const flake of flakes ?? []) {
    const issue = known.get(flake.fingerprint);
    if (issue) recurring.push({ ...flake, issue: issue.number, issueState: issue.state });
    else fresh.push(flake);
  }
  return { fresh, recurring };
}

/**
 * Issue title for a flake. Kept stable across sweeps (no counts) so a human
 * scanning the issue list sees the test, not the churn.
 * @param {{project?: string, testName?: string, file?: string}} flake
 * @returns {string}
 */
export function renderIssueTitle(flake) {
  const name = flake?.testName || toRepoRelativePath(flake?.file) || 'unknown test';
  return `flake: [${flake?.project ?? 'unknown'}] ${name}`.slice(0, 240);
}

/**
 * Issue body for a flake, including the `flake-fp:` dedup marker.
 * @param {object} flake aggregated flake
 * @param {{window?: string, runsScanned?: number, repoUrl?: string}} [meta]
 * @returns {string}
 */
export function renderIssueBody(flake, meta = {}) {
  const lines = [
    'A test in this repo **failed and then passed on retry** in CI. The build went green, so',
    'nothing else would have reported it. A retry is a debt marker, not a fix.',
    '',
    `- **Project**: \`${flake.project}\` (retries enabled in \`vitest.config.ts\`)`,
    `- **File**: \`${flake.file}\``,
    `- **Test**: \`${flake.testName}\``,
    `- **Attempts before passing**: ${flake.maxAttempts ?? flake.attempts}`,
    `- **Retried runs observed**: ${flake.occurrences} (in ${flake.runs ?? 0} CI run(s)${meta.window ? `, ${meta.window}` : ''})`,
    `- **Signal source**: \`${flake.source}\``,
  ];
  if (flake.failureMessage) {
    lines.push('', 'Failure from the losing attempt:', '', '```', flake.failureMessage, '```');
  }
  if (flake.runIds?.length && meta.repoUrl) {
    const links = flake.runIds.slice(0, 5).map((id) => `${meta.repoUrl}/actions/runs/${id}`);
    lines.push('', 'Runs:', ...links.map((l) => `- ${l}`));
  }
  lines.push(
    '',
    'Reproduce the parallel conditions rather than the test in isolation:',
    '',
    '```bash',
    `npx vitest run --project ${flake.project} --retry=0`,
    '```',
    '',
    'See `docs/operational-telemetry.md` for the flake policy.',
    '',
    `<!-- flake-fp:${flake.fingerprint} -->`
  );
  return lines.join('\n');
}

/**
 * Comment body posted when an already-filed flake fires again.
 * @param {object} flake aggregated flake
 * @param {{window?: string}} [meta]
 * @returns {string}
 */
export function renderRecurrenceComment(flake, meta = {}) {
  const lines = [
    `Still flaking: ${flake.occurrences} retried run(s)${meta.window ? ` ${meta.window}` : ''}, ` +
      `up to ${flake.maxAttempts ?? flake.attempts} attempt(s) before passing.`,
  ];
  if (flake.failureMessage) lines.push('', '```', flake.failureMessage, '```');
  lines.push('', `<!-- flake-fp:${flake.fingerprint} -->`);
  return lines.join('\n');
}
