import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_PATH as FLOAT_PROBE_BASELINE_PATH } from './check-no-float-probes.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-touched-exemptions.mjs');

// `check-touched-exemptions.mjs` calls `process.exit(main())` unconditionally
// at module load (no `import.meta.url === …` entry guard), so it cannot be
// imported for unit testing — every test here runs it as a real subprocess,
// mirroring `check-layer-back-edges.test.mjs`'s `runGuard()`.
//
// Round-1 review, #2843 CI failure: the FIRST version of this test relied on
// `process.env`'s ambient CI-event vars (or their absence) to reach the
// script's normal PR-diff path — passing under `pull_request` (or no CI env
// at all, locally) but silently hitting the script's `skipped (not a
// pull_request event)` early-return under `merge_group`, where
// `GITHUB_ACTIONS=true` and `GITHUB_EVENT_NAME=merge_group` are real and
// `GITHUB_BASE_REF` is unset. `run()` now PINS the worst case — exactly
// `merge_group`'s env shape — on every call, so the test can never again
// pass locally by accident while failing under a CI event it didn't
// exercise. CHANGED_FILES is what makes this legitimate rather than a hack:
// the script's skip check now exempts an explicit CHANGED_FILES (see
// `check-touched-exemptions.mjs`'s `main()`), so a caller that already knows
// its changed-file set — this test, but also plausibly a future non-PR
// caller — gets a hermetic, event-independent run.
function run(env) {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath, 'origin/main'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: 'merge_group',
          GITHUB_BASE_REF: '',
          ...env,
        },
      }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const FAKE_PATH = 'packages/webapp/src/scoops/__fake_float_probe_test_file__.ts';

/**
 * Round-1 review on #2843: the float-probe debt list starts EMPTY, and the
 * added-entry ("list must not grow") check used to skip entirely whenever
 * `baseGlobs.length === 0` — indistinguishable from "the debt-list file
 * doesn't exist yet at the base ref" (genuine bootstrapping). These tests
 * write a FAKE key into the real on-disk `float-probe-baseline.json` (the
 * gate has no injection seam — see the module-load note above) so the
 * touched-file half of the gate has something concrete to catch, and
 * restore the real `{}` content afterward either way.
 */
describe('check-touched-exemptions: float-probe debt list wiring', () => {
  const originalBaseline = readFileSync(FLOAT_PROBE_BASELINE_PATH, 'utf8');

  afterEach(() => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, originalBaseline);
  });

  it('fails when a changed file is still on the float-probe debt list', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(1);
    expect(out).toContain('float-probe debt list');
    expect(out).toContain(FAKE_PATH);
  });

  it('passes when the changed file is NOT on the float-probe debt list', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run({ CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts' });
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });

  it('passes with the real, empty baseline untouched (sanity: no debt lists at all today)', () => {
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(0);
    expect(out).toContain('no debt lists found');
  });
});

describe('check-touched-exemptions: merge_group skip branch (round-1 review #2843 CI failure)', () => {
  it('still skips under merge_group when CHANGED_FILES is NOT given (the legitimate case)', () => {
    const { code, out } = run({ CHANGED_FILES: '' });
    expect(code).toBe(0);
    expect(out).toContain('skipped (not a pull_request event)');
  });

  it('does NOT skip under merge_group when CHANGED_FILES IS given — the fix', () => {
    // No baseline mutation needed: CHANGED_FILES alone is enough to prove the
    // skip branch was bypassed — a real skip would print "skipped", not
    // "no debt lists found" / "OK".
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(0);
    expect(out).not.toContain('skipped');
  });
});
