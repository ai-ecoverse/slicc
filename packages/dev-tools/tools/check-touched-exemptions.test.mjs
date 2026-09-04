import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_PATH as FLOAT_PROBE_BASELINE_PATH } from './check-no-float-probes.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-touched-exemptions.mjs');
const FLOAT_PROBE_BASELINE_REL = 'packages/dev-tools/tools/float-probe-baseline.json';

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
//
// `baseRef` defaults to `origin/main`, but is itself a hidden environment
// dependency: `node-matrix-tests`' CI checkout (unlike `lint`'s) has no
// `fetch-depth: 0`, so `origin/main` is NOT a resolvable ref there (only the
// one commit under test is fetched). That silently degrades the base-ref
// reads to `null` (see `readBaseJson`), which skips the added-entry check
// entirely — see the dedicated describe block below, which pins that
// production behavior on purpose instead of leaving it accidental.
function run(env, baseRef = 'origin/main') {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath, baseRef], {
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

/**
 * Explicit git identity for every scratch git invocation below.
 * `commit-tree`/`commit` need an author/committer identity, which a
 * developer's machine has (global `user.name`/`user.email`, or at worst a
 * GECOS/hostname fallback) but a CI runner may not — `node-matrix-tests` has
 * none of those, so an earlier version of this fixture failed there with
 * `fatal: empty ident name` despite passing on every machine it was tested
 * on before pushing (#2899). Set explicitly so the fixture never depends on
 * config/GECOS/hostname being present anywhere; GIT_CONFIG_GLOBAL=/dev/null
 * also keeps a developer's global git config (hooks, aliases, unrelated
 * settings) from leaking in.
 */
const SCRATCH_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'check-touched-exemptions test',
  GIT_AUTHOR_EMAIL: 'noreply@slicc.test',
  GIT_COMMITTER_NAME: 'check-touched-exemptions test',
  GIT_COMMITTER_EMAIL: 'noreply@slicc.test',
};

/**
 * Build a throwaway git repo under `os.tmpdir()` containing exactly one
 * file, at `fileRelPath`, holding `content`, committed at its root. Returns
 * the commit SHA and that repo's own object directory.
 *
 * `readBaseJson`'s `git show <ref>:<path>` (run against THIS repo, in
 * `check-touched-exemptions.mjs`) can still resolve that SHA — pass
 * `objectsDir` as `GIT_ALTERNATE_OBJECT_DIRECTORIES` to the `run()` call
 * that exercises it, and git will search the alternate directory to
 * resolve objects without ever copying them in. This repo is commonly a git
 * *worktree* sharing ONE object store with every sibling worktree/session;
 * an earlier version of this fixture built the scratch commit directly
 * there (`commit-tree`/`hash-object -w` against `repoRoot`), leaving
 * dangling blob/tree/commit objects in that SHARED store permanently
 * (#2899 round-2 review). A fully separate throwaway repo, resolved only
 * via the alternates mechanism, writes nothing there at all — the same
 * pattern `check-swift-resolved-drift.test.mjs` uses for its end-to-end
 * fixture, minus the object-database isolation this one additionally needs
 * (that guard's throwaway repo is also the CWD the guard runs against, so
 * it never touches the real repo's objects to begin with).
 *
 * Call `cleanup()` when done.
 */
function makeScratchBaseRef(fileRelPath, content) {
  const repoDir = mkdtempSync(resolve(tmpdir(), 'touched-exemptions-scratch-'));
  const env = { ...process.env, ...SCRATCH_GIT_ENV };
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoDir, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  const filePath = resolve(repoDir, fileRelPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  git('add', fileRelPath);
  git('commit', '-q', '-m', 'scratch: check-touched-exemptions test fixture');
  return {
    sha: git('rev-parse', 'HEAD'),
    objectsDir: resolve(repoDir, '.git', 'objects'),
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
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
    // The added-entry check (`findAddedExemptions`) is NOT scoped to
    // CHANGED_FILES — it diffs the whole debt-list file against the base
    // ref, repo-wide, by design (a PR may not grow the list even via an
    // untouched-file edit). So the on-disk fake entry must ALREADY be
    // present at the base ref too, or this test would trip that check
    // regardless of which file is "changed" — exactly the bug that let it
    // silently pass in CI (see the module-load note: `origin/main` isn't
    // resolvable there, which degrades the added-entry check to a no-op
    // instead of genuinely exercising this scenario).
    const fakeContent = `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`;
    const scratch = makeScratchBaseRef(FLOAT_PROBE_BASELINE_REL, fakeContent);
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, fakeContent);
    try {
      const { code, out } = run(
        {
          CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.objectsDir,
        },
        scratch.sha
      );
      expect(code).toBe(0);
      expect(out).toContain('OK');
      // A skip (base ref unresolvable — see the describe block below) must
      // never be mistaken for a genuine "nothing added" pass; the very next
      // test proves this same mechanism genuinely gates growth rather than
      // always skipping.
      expect(out).not.toContain('could not read the float-probe debt list');
    } finally {
      scratch.cleanup();
    }
  });

  it('FAILS — does not silently skip — when an untouched file made the debt list grow', () => {
    // Companion to the pass above, round-2 review (#2899, Grok): none of
    // the pre-existing cases actually required the added-entry check to
    // RUN to pass — a script that always skipped it (or the original #2843
    // empty-baseline bug) would have passed every one of them too. This is
    // the base ref genuinely containing FEWER entries than the working
    // tree, so a correct run must fail even though CHANGED_FILES names an
    // unrelated file.
    const scratch = makeScratchBaseRef(FLOAT_PROBE_BASELINE_REL, '{}\n');
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    try {
      const { code, out } = run(
        {
          CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: scratch.objectsDir,
        },
        scratch.sha
      );
      expect(code).toBe(1);
      expect(out).toContain('must not grow');
      expect(out).not.toContain('could not read the float-probe debt list');
    } finally {
      scratch.cleanup();
    }
  });

  it('passes with the real, empty baseline untouched (sanity: no debt lists at all today)', () => {
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH });
    expect(code).toBe(0);
    expect(out).toContain('no debt lists found');
  });
});

/**
 * `node-matrix-tests`' CI checkout has no `fetch-depth: 0` (unlike `lint`'s),
 * so `origin/main` is not a resolvable ref there — only the single commit
 * under test is fetched. `readBaseJson`'s `git show <ref>:<path>` then fails
 * for every rule, which is caught and returns `null`, which makes
 * `baseReadable` false, which SKIPS the added-entry check entirely (see
 * `main()`'s `ruleStates.filter((rule) => rule.baseReadable)`). That's a
 * real, currently-relied-upon behavior — not a hypothetical — verified by
 * replaying the exact depth-1 `git fetch` of PR #2843's own merge commit
 * (`3b5b77594157ca69f67980ff62cc3f541a4c2e57`) locally: `origin/main`
 * doesn't resolve, and the suite passes. Pin it explicitly here instead of
 * leaving it an accident of checkout depth.
 */
describe('check-touched-exemptions: unresolvable base ref (shallow-checkout parity)', () => {
  const originalBaseline = readFileSync(FLOAT_PROBE_BASELINE_PATH, 'utf8');

  afterEach(() => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, originalBaseline);
  });

  it('skips the added-entry check (not just "no entries added") when the base ref cannot be read', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run(
      { CHANGED_FILES: 'packages/webapp/src/scoops/unrelated-file.ts' },
      'this-ref-does-not-exist-anywhere'
    );
    expect(code).toBe(0);
    expect(out).toContain('notice — could not read the float-probe debt list');
    expect(out).toContain('OK');
  });

  it('still runs the touched-file check when the base ref cannot be read', () => {
    writeFileSync(FLOAT_PROBE_BASELINE_PATH, `${JSON.stringify({ [FAKE_PATH]: 1 }, null, 2)}\n`);
    const { code, out } = run({ CHANGED_FILES: FAKE_PATH }, 'this-ref-does-not-exist-anywhere');
    expect(code).toBe(1);
    expect(out).toContain('float-probe debt list');
    expect(out).toContain(FAKE_PATH);
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
